import { afterEach, expect, test } from "bun:test";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearPendingConfig,
  commitPendingConfig,
  allowsEnvironmentOptionalCredentials,
  getConfigPath,
  loadConfig,
  resolveEnvironmentBinding,
  resolveEnvironmentEndpointPrefill,
  savePendingConfig,
  setAdminEnabledConfig,
  setAgentDirResolverForTests,
  updateConfig,
  validateEndpoint,
} from "../src/config.ts";
import type { ConfigError } from "../src/config.ts";

const originalAgentDir = process.env.OMP_AGENT_DIR;
const originalApiKey = process.env.OMP_OMNIROUTE_API_KEY;
const originalBaseUrl = process.env.OMP_OMNIROUTE_BASE_URL;
const originalMetadataKey = process.env.OMP_OMNIROUTE_METADATA_API_KEY;
const originalAdminKey = process.env.OMP_OMNIROUTE_ADMIN_API_KEY;
const originalAdminCookie = process.env.OMP_OMNIROUTE_ADMIN_COOKIE;
let tempDir: string;

afterEach(async () => {
  setAgentDirResolverForTests(undefined);
  if (originalAgentDir === undefined) delete process.env.OMP_AGENT_DIR;
  else process.env.OMP_AGENT_DIR = originalAgentDir;
  if (originalApiKey === undefined) delete process.env.OMP_OMNIROUTE_API_KEY;
  else process.env.OMP_OMNIROUTE_API_KEY = originalApiKey;
  if (originalBaseUrl === undefined) delete process.env.OMP_OMNIROUTE_BASE_URL;
  else process.env.OMP_OMNIROUTE_BASE_URL = originalBaseUrl;
  if (originalMetadataKey === undefined) delete process.env.OMP_OMNIROUTE_METADATA_API_KEY;
  else process.env.OMP_OMNIROUTE_METADATA_API_KEY = originalMetadataKey;
  if (originalAdminKey === undefined) delete process.env.OMP_OMNIROUTE_ADMIN_API_KEY;
  else process.env.OMP_OMNIROUTE_ADMIN_API_KEY = originalAdminKey;
  if (originalAdminCookie === undefined) delete process.env.OMP_OMNIROUTE_ADMIN_COOKIE;
  else process.env.OMP_OMNIROUTE_ADMIN_COOKIE = originalAdminCookie;
  if (tempDir) await rm(tempDir, { recursive: true, force: true });
});

async function isolated(): Promise<void> {
  tempDir = await mkdtemp(join(tmpdir(), "cruxomni-omp-client-config-"));
  process.env.OMP_AGENT_DIR = tempDir;
  setAgentDirResolverForTests(() => process.env.OMP_AGENT_DIR ?? tempDir);
  delete process.env.OMP_OMNIROUTE_API_KEY;
  delete process.env.OMP_OMNIROUTE_BASE_URL;
}

async function expectCode(promise: Promise<unknown>, code: ConfigError["code"]): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code });
}

test("normalizes root and /v1 endpoints while rejecting URL authority escapes", () => {
  expect(validateEndpoint("https://gateway.example/prefix")).toBe("https://gateway.example/prefix");
  expect(validateEndpoint("https://gateway.example/prefix/v1")).toBe("https://gateway.example/prefix");
  expect(validateEndpoint("http://127.0.0.1:20128/v1")).toBe("http://127.0.0.1:20128");
  expect(() => validateEndpoint("https://user:pass@gateway.example")).toThrow();
  expect(() => validateEndpoint("https://gateway.example?api_key=secret")).toThrow();
  expect(() => validateEndpoint("ftp://gateway.example")).toThrow();
  expect(() => validateEndpoint("http://gateway.example")).toThrow();
  expect(validateEndpoint("http://gateway.example", true)).toBe("http://gateway.example");
});

test("environment bindings require the branded URL and key pair before profile access", async () => {
  await isolated();
  process.env.OMP_OMNIROUTE_API_KEY = "key";
  await expectCode(Promise.resolve().then(() => resolveEnvironmentBinding()), "environment-partial");
  process.env.OMP_OMNIROUTE_BASE_URL = "https://one.example";
  expect(resolveEnvironmentBinding()?.endpoint).toBe("https://one.example");
});

test("persisted native selection ignores stale or partial runtime environment overrides", async () => {
  await isolated();
  process.env.OMP_OMNIROUTE_API_KEY = "old-environment-key";
  process.env.OMP_OMNIROUTE_BASE_URL = "not-a-valid-url";
  const selected = await updateConfig(current => ({ ...current, runtimeSource: "native", active: { endpoint: "https://native.example", generation: 1 } }));
  expect(resolveEnvironmentBinding(selected)).toBeUndefined();
  expect(await loadConfig()).toMatchObject({ runtimeSource: "native", active: { endpoint: "https://native.example", generation: 1 } });
  const persisted = JSON.parse(await readFile(getConfigPath(), "utf8")) as Record<string, unknown>;
  expect(persisted.runtimeSource).toBe("native");
  expect(JSON.stringify(persisted)).not.toContain("old-environment-key");
});

test("environment URL prefills omit invalid values that could expose userinfo", async () => {
  await isolated();
  process.env.OMP_OMNIROUTE_BASE_URL = "https://user:embedded-secret@gateway.example";
  expect(resolveEnvironmentEndpointPrefill({})).toBeUndefined();
  process.env.OMP_OMNIROUTE_BASE_URL = "https://gateway.example/prefix/v1/";
  expect(resolveEnvironmentEndpointPrefill({})).toBe("https://gateway.example/prefix");
  expect(resolveEnvironmentEndpointPrefill({ runtimeSource: "native" })).toBeUndefined();
});

test("optional environment credentials follow a native endpoint only with matching runtime URL evidence", async () => {
  await isolated();
  const native = { runtimeSource: "native" as const };
  process.env.OMP_OMNIROUTE_METADATA_API_KEY = "optional-metadata-key";
  process.env.OMP_OMNIROUTE_BASE_URL = "https://old.example/v1/";
  expect(allowsEnvironmentOptionalCredentials(native, "https://old.example")).toBe(true);
  expect(allowsEnvironmentOptionalCredentials(native, "https://new.example")).toBe(false);
  process.env.OMP_OMNIROUTE_BASE_URL = "not-a-valid-url";
  expect(allowsEnvironmentOptionalCredentials(native, "https://native.example")).toBe(false);
  delete process.env.OMP_OMNIROUTE_BASE_URL;
  delete process.env.OMP_OMNIROUTE_API_KEY;
  expect(allowsEnvironmentOptionalCredentials(native, "https://native.example")).toBe(true);
});

test("profile writes use a private directory and atomic private file", async () => {
  await isolated();
  const staged = await savePendingConfig("http://127.0.0.1:20128");
  expect(staged.pending?.endpoint).toBe("http://127.0.0.1:20128");
  const directory = await stat(join(tempDir, "omniroute"));
  const file = await stat(getConfigPath());
  expect(directory.mode & 0o777).toBe(0o700);
  expect(file.mode & 0o777).toBe(0o600);
  expect(JSON.parse(await readFile(getConfigPath(), "utf8"))).not.toHaveProperty("apiKey");
  await commitPendingConfig(staged.pending, staged.revision === undefined ? undefined : { expectedRevision: staged.revision });
  expect((await loadConfig()).active?.generation).toBe(1);
});

test("corrupt files and stale revisions fail closed without replacement", async () => {
  await isolated();
  await savePendingConfig("https://gateway.example");
  const path = getConfigPath();
  await chmod(path, 0o600);
  const original = await readFile(path, "utf8");
  await writeFile(path, "{not-json", { mode: 0o600 });
  await expectCode(loadConfig(), "corrupt-config");
  await writeFile(path, original, { mode: 0o600 });
  const loaded = await loadConfig();
  await writeFile(path, original.replace("gateway.example", "other.example"), { mode: 0o600 });
  await expectCode(savePendingConfig("https://new.example", loaded.revision === undefined ? undefined : { expectedRevision: loaded.revision }), "config-conflict");
  await clearPendingConfig();
});

test("administration enablement does not alter runtime binding transactions", async () => {
  await isolated();
  const staged = await savePendingConfig("http://127.0.0.1:20128");
  const enabled = await setAdminEnabledConfig(true, staged.revision === undefined ? undefined : { expectedRevision: staged.revision });
  expect(enabled.adminEnabled).toBe(true);
  expect(enabled.active).toBeUndefined();
  expect(enabled.pending).toEqual(staged.pending);
  const disabled = await setAdminEnabledConfig(false, enabled.revision === undefined ? undefined : { expectedRevision: enabled.revision });
  expect(disabled.adminEnabled).toBe(false);
  expect(disabled.pending).toEqual(staged.pending);
});

test("catalog source configuration defaults empty, deduplicates, and rejects unknown IDs", async () => {
  await isolated();
  expect((await loadConfig()).catalogSources ?? []).toEqual([]);
  await updateConfig(current => ({ ...current, adminEnabled: true }));
  expect((await loadConfig()).catalogSources ?? []).toEqual([]);
  await updateConfig(current => ({ ...current, catalogSources: ["openrouter", "models.dev", "openrouter"] }));
  const path = getConfigPath();
  const persisted: unknown = JSON.parse(await readFile(path, "utf8"));
  if (persisted === null || typeof persisted !== "object" || !("catalogSources" in persisted)) throw new Error("persisted config has no catalogSources");
  expect(persisted.catalogSources).toEqual(["openrouter", "models.dev"]);
  await writeFile(path, JSON.stringify({ version: 2, allowInsecureHttp: false, adminEnabled: false, catalogSources: ["unknown"] }), { mode: 0o600 });
  await expectCode(loadConfig(), "corrupt-config");
});
