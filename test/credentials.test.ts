import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, readFile, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAuthStorage, z } from "@oh-my-pi/pi-coding-agent";
import { OptionalCredentials, type CredentialStore } from "../src/credentials.ts";
import type { AuthStorage, StoredAuthCredential } from "@oh-my-pi/pi-ai";
import { getConfigPath, loadConfig, resolveEnvironmentBinding, setAgentDirResolverForTests, updateConfig } from "../src/config.ts";
import register from "../src/index.ts";

let directory: string | undefined;
let cleanupIntegration: (() => void) | undefined;
afterEach(async () => {
  cleanupIntegration?.();
  setAgentDirResolverForTests(undefined);
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = undefined;
});
async function isolated() {
  directory = await mkdtemp(join(tmpdir(), "cruxomni-credentials-"));
  setAgentDirResolverForTests(() => directory!);
}
function storage() {
  let id = 0;
  const rows: StoredAuthCredential[] = [];
  const credentials: CredentialStore["credentials"] = {
    async set(provider, credential) {
      for (let index = rows.length - 1; index >= 0; index--) {
        if (rows[index]!.provider === provider) rows.splice(index, 1);
      }
      for (const value of Array.isArray(credential) ? credential : [credential]) {
        rows.push({ id: ++id, provider, credential: value, disabledCause: null });
      }
    },
    list(provider) {
      const filtered = rows.filter(row => !provider || row.provider === provider);
      return filtered;
    },
    async removeById(provider, id) { const index = rows.findIndex(row => row.provider === provider && row.id === id); if (index < 0) return false; rows.splice(index, 1); return true; },
  };
  const store: CredentialStore = { credentials };
  return { rows, store };
}
const binding = { endpoint: "https://gateway.example", generation: 1 };
const key = { kind: "apiKey" as const, value: "fixture-optional-secret" };
const RUNTIME_KEY = "fixture-runtime-key";
const METADATA_KEY = "fixture-metadata-key";

interface IntegrationFixture {
  server: { stop(closeActiveConnections?: boolean): void };
  requests: Array<{ path: string; authorization: string | null }>;
  metadataRequest: Promise<{ path: string; authorization: string | null }>;
  endpoint: string;
}

function integrationFixture(): IntegrationFixture {
  const requests: Array<{ path: string; authorization: string | null }> = [];
  const metadataRequest = Promise.withResolvers<{ path: string; authorization: string | null }>();
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const observed = { path: url.pathname, authorization: request.headers.get("authorization") };
      requests.push(observed);
      if (url.pathname === "/v1/models") return Response.json({ data: [{ id: "fixture-model", owned_by: "fixture-owner" }] });
      if (url.pathname === "/api/models/catalog") {
        metadataRequest.resolve(observed);
        return Response.json({ catalog: { "fixture-owner": { models: [{ id: "fixture-model", context_length: 64000 }] } } });
      }
      return new Response("not found", { status: 404 });
    },
  });
  return {
    server,
    requests,
    metadataRequest: metadataRequest.promise,
    endpoint: `http://127.0.0.1:${server.port}`,
  };
}


function extensionHost(storage: AuthStorage) {
  const commands = new Map<string, { handler: (args: string, context: never) => Promise<void> }>();
  const events = new Map<string, (...args: never[]) => unknown>();
  const api = {
    zod: z,
    pi: { discoverAuthStorage: () => discoverAuthStorage(directory!, { cwd: directory! }) },
    registerCommand(name: string, command: { handler: (args: string, context: never) => Promise<void> }) { commands.set(name, command); },
    registerTool() {},
    registerProvider() {},
    unregisterProvider() {},
    on(name: string, callback: (...args: never[]) => unknown) { events.set(name, callback); },
  };
  const context = (ui: Record<string, unknown> = {}) => ({
    mode: "tui",
    hasUI: true,
    cwd: directory,
    ui: { notify() {}, ...ui },
    modelRegistry: { authStorage: storage },
  }) as never;
  return { api, commands, events, context };
}

test("session-only secrets vanish on restart and never enter profile files", async () => {
  await isolated(); const { store, rows } = storage(); const credentials = new OptionalCredentials();
  await credentials.save("metadata", key, binding, false, store);
  expect(await credentials.resolve("metadata", binding, store)).toEqual(key);
  expect(await new OptionalCredentials().resolve("metadata", binding, store)).toBeUndefined();
  expect(rows).toHaveLength(0);
  expect(JSON.stringify(await loadConfig())).not.toContain(key.value);
});

test("remembered credentials survive restart but reject endpoint or generation drift", async () => {
  await isolated(); const { store } = storage();
  await new OptionalCredentials().save("metadata", key, binding, true, store);
  expect(await new OptionalCredentials().resolve("metadata", binding, store)).toEqual(key);
  expect(await new OptionalCredentials().resolve("metadata", { ...binding, generation: 2 }, store)).toBeUndefined();
  expect(await new OptionalCredentials().resolve("metadata", { ...binding, endpoint: "https://other.example" }, store)).toBeUndefined();
  expect(await readFile(getConfigPath(), "utf8")).not.toContain(key.value);
});

test("forget removes only the selected owned record", async () => {
  await isolated(); const { store, rows } = storage(); const credentials = new OptionalCredentials();
  await store.credentials.set("unrelated", { type: "api_key", key: "fixture-unrelated" });
  await credentials.save("admin", key, binding, true, store);
  await credentials.forget("admin", store);
  expect(rows.map(row => row.provider)).toEqual(["unrelated"]);
  expect(await credentials.resolve("admin", binding, store)).toBeUndefined();
});

test("failed remembered persistence never silently downgrades to a session credential", async () => {
  await isolated(); const { store } = storage(); store.credentials.set = async () => { throw new Error("broker unavailable"); };
  const credentials = new OptionalCredentials();
  await expect(credentials.save("admin", key, binding, true, store)).rejects.toThrow("not activated");
  expect(await credentials.resolve("admin", binding, store)).toBeUndefined();
});

test("configuration conflict after secret persistence leaves no usable credential", async () => {
  await isolated(); const { store, rows } = storage(); const set = store.credentials.set;
  store.credentials.set = async (provider, credential) => { await set(provider, credential); await updateConfig(config => ({ ...config, invitationDismissed: true })); };
  const credentials = new OptionalCredentials();
  await expect(credentials.save("metadata", key, binding, true, store)).rejects.toThrow("not activated");
  expect(rows).toHaveLength(0);
  expect((await loadConfig()).optionalCredentials?.metadata?.state).toBe("pending");
  expect(await credentials.resolve("metadata", binding, store)).toBeUndefined();
  await credentials.forget("metadata", store);
  expect((await loadConfig()).optionalCredentials?.metadata).toBeUndefined();
});

test("an unreleased older config version is unsupported and remains untouched", async () => {
  await isolated(); await updateConfig(config => config);
  const original = (await readFile(getConfigPath(), "utf8")).replace('"version": 2', '"version": 1');
  await writeFile(getConfigPath(), original);
  await expect(loadConfig()).rejects.toMatchObject({ code: "corrupt-config" });
  expect(await readFile(getConfigPath(), "utf8")).toBe(original);
});

test("corrupt, unsupported and insecure configuration registers diagnostics only", async () => {
  await isolated(); await updateConfig(config => config);
  const baseline = await readFile(getConfigPath(), "utf8");
  for (const candidate of ["{invalid", baseline.replace('"version": 2', '"version": 99'), baseline]) {
    await writeFile(getConfigPath(), candidate); await chmod(getConfigPath(), candidate === baseline ? 0o644 : 0o600);
    let providers = 0; const commands: string[] = [];
    await register({ registerCommand(name: string) { commands.push(name); }, registerProvider() { providers++; } } as never);
    expect(providers).toBe(0); expect(commands).toContain("cruxomni");
    expect(await readFile(getConfigPath(), "utf8")).toBe(candidate);
  }
});

test("an interrupted transaction lock blocks reads and provider registration", async () => {
  await isolated();
  await updateConfig(config => ({ ...config, invitationDismissed: true }));
  const configDirectory = join(directory!, "omniroute");
  await writeFile(join(configDirectory, ".config.lock"), "interrupted\n", { mode: 0o600 });
  await expect(loadConfig()).rejects.toMatchObject({ code: "config-conflict" });
  let providers = 0;
  const commands: string[] = [];
  await register({ registerCommand(name: string) { commands.push(name); }, registerProvider() { providers++; } } as never,
    );
  expect(providers).toBe(0);
  expect(commands).toContain("cruxomni");
});

test("explicit absent-file expectation rejects a concurrent first writer", async () => {
  await isolated();
  const stale = await loadConfig();
  expect(stale.revision).toBeUndefined();
  await updateConfig(current => ({ ...current, invitationDismissed: true }), { expectedRevision: null });
  await expect(updateConfig(current => ({ ...current, adminEnabled: true }), { expectedRevision: null }))
    .rejects.toMatchObject({ code: "config-conflict" });
  const current = await loadConfig();
  expect(current.invitationDismissed).toBe(true);
  expect(current.adminEnabled).toBe(false);
});

test("remembered metadata enrichment uses the persisted source binding through the registered provider", async () => {
  await isolated();
  const originalEnvironment = { ...process.env };
  const fixture = integrationFixture();
  let nativeStorage: AuthStorage | undefined;
  let shutdown: (() => unknown) | undefined;
  cleanupIntegration = () => {
    shutdown?.();
    nativeStorage?.close();
    fixture.server.stop(true);
    process.env = originalEnvironment;
    cleanupIntegration = undefined;
  };
  try {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("OMP_OMNIROUTE_") || name.startsWith("OMP_AUTH_BROKER_")) delete process.env[name];
    }
    nativeStorage = await discoverAuthStorage(directory!, { cwd: directory! });
    await updateConfig(current => ({ ...current, allowInsecureHttp: true, invitationDismissed: true }));
    process.env.OMP_OMNIROUTE_BASE_URL = fixture.endpoint;
    process.env.OMP_OMNIROUTE_API_KEY = RUNTIME_KEY;
    const sourceBinding = resolveEnvironmentBinding(await loadConfig());
    expect(sourceBinding).toBeDefined();
    await new OptionalCredentials().save("metadata", { kind: "apiKey", value: METADATA_KEY },
      { endpoint: sourceBinding!.endpoint, generation: sourceBinding!.generation }, true, nativeStorage);
    expect((await loadConfig()).optionalCredentials?.metadata?.generation).toBe(sourceBinding!.generation);
    expect(nativeStorage.credentials.list().some(row => row.credential.type === "api_key" && row.credential.key === METADATA_KEY)).toBe(true);

    const host = extensionHost(nativeStorage);
    await register(host.api as never);
    expect(fixture.requests).toContainEqual({ path: "/v1/models", authorization: `Bearer ${RUNTIME_KEY}` });
    shutdown = host.events.get("session_shutdown");
    await host.commands.get("cruxomni")!.handler("status", host.context() as never);

    const metadata = await fixture.metadataRequest;
    expect(metadata).toEqual({ path: "/api/models/catalog", authorization: `Bearer ${METADATA_KEY}` });
    expect(fixture.requests).toContainEqual({ path: "/v1/models", authorization: `Bearer ${RUNTIME_KEY}` });
    expect(fixture.requests.filter(request => request.path === "/api/models/catalog")).toHaveLength(1);
    expect(fixture.requests.some(request => request.authorization === `Bearer ${RUNTIME_KEY}` && request.path === "/api/models/catalog")).toBe(false);
    expect(fixture.requests.some(request => request.authorization === `Bearer ${METADATA_KEY}` && request.path === "/v1/models")).toBe(false);
  } finally {
    cleanupIntegration?.();
  }
});

test("session-only metadata saved through the registered wizard authorizes explicit refresh without persistence", async () => {
  await isolated();
  const originalEnvironment = { ...process.env };
  const fixture = integrationFixture();
  let nativeStorage: AuthStorage | undefined;
  let shutdown: (() => unknown) | undefined;
  cleanupIntegration = () => {
    shutdown?.();
    nativeStorage?.close();
    fixture.server.stop(true);
    process.env = originalEnvironment;
    cleanupIntegration = undefined;
  };
  try {
    for (const name of Object.keys(process.env)) {
      if (name.startsWith("OMP_OMNIROUTE_") || name.startsWith("OMP_AUTH_BROKER_")) delete process.env[name];
    }
    nativeStorage = await discoverAuthStorage(directory!, { cwd: directory! });
    await updateConfig(current => ({ ...current, allowInsecureHttp: true, invitationDismissed: true }));
    process.env.OMP_OMNIROUTE_BASE_URL = fixture.endpoint;
    process.env.OMP_OMNIROUTE_API_KEY = RUNTIME_KEY;

    const host = extensionHost(nativeStorage);
    await register(host.api as never);
    shutdown = host.events.get("session_shutdown");
    const choices = ["Metadata (optional)", "Set credential", "This session only", "Finish"];
    expect(fixture.requests).toContainEqual({ path: "/v1/models", authorization: `Bearer ${RUNTIME_KEY}` });
    const ui = {
      async select() { return choices.shift(); },
      async confirm() { return true; },
      async custom(factory: (...args: never[]) => { onSubmit(value: string): void }) {
        const { promise, resolve } = Promise.withResolvers<string | undefined>();
        const input = factory(undefined as never, undefined as never, undefined as never, resolve as never);
        input.onSubmit(METADATA_KEY);
        return promise;
      },
    };
    await host.commands.get("cruxomni")!.handler("setup", host.context(ui) as never);

    const metadata = await fixture.metadataRequest;
    expect(metadata).toEqual({ path: "/api/models/catalog", authorization: `Bearer ${METADATA_KEY}` });
    expect(fixture.requests).toContainEqual({ path: "/v1/models", authorization: `Bearer ${RUNTIME_KEY}` });
    expect(fixture.requests.filter(request => request.path === "/api/models/catalog")).toHaveLength(1);
    expect(fixture.requests.some(request => request.authorization === `Bearer ${RUNTIME_KEY}` && request.path === "/api/models/catalog")).toBe(false);
    expect(fixture.requests.some(request => request.authorization === `Bearer ${METADATA_KEY}` && request.path === "/v1/models")).toBe(false);

    const current = await loadConfig();
    expect(current.optionalCredentials?.metadata).toBeUndefined();
    expect(await readFile(getConfigPath(), "utf8")).not.toContain(METADATA_KEY);
    expect(nativeStorage.credentials.list().some(row =>
      row.credential.type === "api_key" && row.credential.key === METADATA_KEY,
    )).toBe(false);
  } finally {
    cleanupIntegration?.();
  }
});
