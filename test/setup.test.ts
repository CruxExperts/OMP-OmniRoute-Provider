import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { clearPendingCandidate, recoverPendingAfterPersistence, registerNativeLogin, resolveRuntimeCredential, resolveStartupRuntimeCredential } from "../src/auth.ts";
import { commitPendingConfig, getConfigPath, loadConfig, setAgentDirResolverForTests, updateConfig, validateEndpoint } from "../src/config.ts";
import { OptionalCredentials } from "../src/credentials.ts";
import { createSetupWizard, setupConnection, type SetupServices } from "../src/setup.ts";
import { TransportError } from "../src/transport.ts";

let root: string | undefined;
const savedEnvironment = { ...process.env };
afterEach(async () => {
  process.env = { ...savedEnvironment };
  clearPendingCandidate();
  setAgentDirResolverForTests(undefined);
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function isolated(): Promise<void> {
  root = await mkdtemp(join(tmpdir(), "cruxomni-setup-"));
  setAgentDirResolverForTests(() => root!);
  for (const name of Object.keys(process.env)) if (name.startsWith("OMP_OMNIROUTE_")) delete process.env[name];
}

function context<TLogin>(
  values: string[],
  confirmations: boolean[],
  notices: string[],
  login: TLogin,
  selections: string[] = [],
  promptObservations?: Array<{ initial: string; masked: boolean }>,
  confirmedMessages?: string[],
  promptRenders?: string[][],
) {
  return {
    mode: "tui", hasUI: true, cwd: "/fixture/project",
    ui: {
      custom(factory: (
        tui: unknown,
        theme: unknown,
        keys: unknown,
        done: (value: string | undefined) => void,
      ) => { setValue(value: string): void; onSubmit(value: string): void }) {
        const deferred = Promise.withResolvers<string | undefined>();
        const component = factory(undefined, undefined, undefined, deferred.resolve) as {
          setValue(value: string): void;
          onSubmit(value: string): void;
          getValue?: () => string;
          mask?: boolean;
          render?(width: number): readonly string[];
        };
        promptObservations?.push({ initial: component.getValue?.() ?? "", masked: component.mask === true });
        promptRenders?.push([...(component.render?.(80) ?? [])]);
        const value = values.shift() ?? "";
        component.setValue(value);
        component.onSubmit(value);
        return deferred.promise;
      },
      async confirm(title: string, detail: string) { confirmedMessages?.push(`${title}\n${detail}`); return confirmations.shift() ?? false; },
      async select() { return selections.shift(); },
      notify(message: string) { notices.push(message); },
    },
    modelRegistry: { authStorage: { oauth: { login } } },
  } as never;
}

function nativeLoginHandler() {
  return registerNativeLogin({
    load: loadConfig,
    request: async (target, credential) => {
      if (typeof target === "string") throw new Error("unexpected request target");
      expect(credential).toBe("fixture-native-runtime-key");
      if (target.path === "/api/cloud/auth") {
        expect(target.method).toBe("POST");
        expect(target.body).toBeUndefined();
        return { connections: [], modelAliases: {} };
      }
      expect(target.path).toBe("/v1/models");
      return { data: [{ id: "fixture-model" }] };
    },
  });
}

function nativeCallbacks(callbacks: { onPrompt(prompt: { message: string; secret?: boolean; placeholder?: string }): Promise<string> }) {
  return {
    onPrompt: callbacks.onPrompt,
    async onConfirm(options: { message: string; detail?: string }) {
      const answer = await callbacks.onPrompt({
        message: `${options.message}${options.detail ? `\n${options.detail}` : ""}`,
        placeholder: "yes/no",
      });
      return /^(?:y|yes)$/i.test(answer.trim());
    },
  };
}

function services(): SetupServices {
  return {
    credentials: new OptionalCredentials(),
    async refresh() {}, async synchronizeAdmin() {},
    status: () => "connected; models=1; metadata=not configured",
  };
}

test("connection cancellation is byte-preserving and never invokes native login", async () => {
  await isolated();
  await updateConfig(current => ({ ...current, adminEnabled: true, invitationDismissed: true, pricingFile: "/fixture/pricing.json" }));
  const before = await readFile(getConfigPath(), "utf8");
  let logins = 0;
  const ctx = context(["https://gateway.example", "fixture-runtime-secret"], [false], [], async () => { logins++; });
  await setupConnection(ctx, services());
  expect(logins).toBe(0);
  expect(await readFile(getConfigPath(), "utf8")).toBe(before);
});

test("gateway help wraps above a usable 80-column URL input", async () => {
  await isolated();
  const rendered: string[][] = [];
  const ctx = context(["gateway.example"], [], [], async () => { throw new Error("login should not run"); }, [], undefined, undefined, rendered);
  await setupConnection(ctx, services());
  const lines = rendered[0] ?? [];
  expect(lines.length).toBeGreaterThan(2);
  expect(lines.join(" ")).toContain("llm.example.com");
  expect(lines.join(" ")).toContain("localhost");
  expect(lines.at(-1)).toContain("Gateway URL: ");
  expect(lines.at(-1)).toContain("\x1b[7m");
});

test("completed connection never serializes or announces the runtime key", async () => {
  await isolated();
  const secret = "fixture-runtime-secret";
  const endpoint = "https://gateway.example";
  const notices: string[] = [];
  let provider = "";
  const ctx = context([endpoint, secret], [true], notices, async (name: string, callbacks: { onPrompt(prompt: { message: string; secret?: boolean }): Promise<string> }) => {
    provider = name;
    expect(await callbacks.onPrompt({ message: "OmniRoute base URL" })).toBe(endpoint);
    expect(await callbacks.onPrompt({ message: "OmniRoute API key", secret: true })).toBe(secret);
    await updateConfig(current => ({ ...current, active: { endpoint: validateEndpoint(endpoint), generation: 1 } }));
  });
  await setupConnection(ctx, services());
  expect(provider).toBe("omniroute");
  expect(await readFile(getConfigPath(), "utf8")).not.toContain(secret);
  expect(notices.join("\n")).not.toContain(secret);
  expect((await loadConfig()).active?.endpoint).toBe(endpoint);
});

test("wizard reports pending recovery when native persistence fails after staging", async () => {
  await isolated();
  const notices: string[] = [];
  const endpoint = "https://gateway.example";
  const ctx = context([endpoint, "fixture-runtime-secret"], [true], notices, async () => {
    await updateConfig(current => ({ ...current, runtimeSource: "native", pending: { endpoint, generation: 1, status: "validated" } }));
    throw new Error("native credential write interrupted");
  });
  await setupConnection(ctx, services());
  expect((await loadConfig()).pending?.endpoint).toBe(endpoint);
  expect(notices.join(" ")).toContain("activation may be pending");
  expect(notices.join(" ")).toContain("Sign in again");
  expect(notices.join(" ")).not.toContain("Existing connection retained");
  expect(notices.join(" ")).not.toContain("fixture-runtime-secret");
});

test("native login switches from environment to a persisted profile credential and survives restart", async () => {
  await isolated();
  const oldEnvironment = { baseUrl: "https://environment.example", apiKey: "fixture-environment-runtime-key" };
  process.env.OMP_OMNIROUTE_BASE_URL = oldEnvironment.baseUrl;
  process.env.OMP_OMNIROUTE_API_KEY = oldEnvironment.apiKey;
  const initial = await updateConfig(current => ({ ...current, allowInsecureHttp: false }));
  const provider = nativeLoginHandler();
  const prompts: string[] = [];
  const nativeKey = await provider.login({
    async onConfirm(options) {
      prompts.push(`confirm:${options.message}`);
      return true;
    },
    async onPrompt(options) {
      prompts.push(options.secret ? "key" : "endpoint");
      return options.secret ? "fixture-native-runtime-key" : "https://native.example";
    },
  });
  expect(nativeKey).toBe("fixture-native-runtime-key");
  expect(prompts).toEqual([
    "confirm:Use a native OmniRoute profile connection instead of the environment connection?",
    "endpoint",
    "key",
  ]);
  const staged = await loadConfig();
  expect(staged).toMatchObject({ runtimeSource: "native", pending: { endpoint: "https://native.example", generation: 1 } });
  expect(staged.revision).not.toBe(initial.revision);
  expect(await resolveRuntimeCredential({ getApiKeyForProvider: () => undefined }, staged)).toBeUndefined();

  const nativeRegistry = {
    getApiKeyForProvider: () => nativeKey,
    authStorage: { credentials: { get: () => ({ type: "api_key" as const, key: nativeKey }) } },
  };
  const activated = await recoverPendingAfterPersistence(nativeRegistry, nativeKey);
  expect(activated).toMatchObject({ runtimeSource: "native", active: { endpoint: "https://native.example", generation: 1 } });
  const restarted = await loadConfig();
  expect(await resolveRuntimeCredential(nativeRegistry, restarted)).toBe(nativeKey);
  expect(await resolveRuntimeCredential({ getApiKeyForProvider: () => undefined }, restarted)).toBeUndefined();
  expect(process.env.OMP_OMNIROUTE_BASE_URL).toBe(oldEnvironment.baseUrl);
  expect(process.env.OMP_OMNIROUTE_API_KEY).toBe(oldEnvironment.apiKey);
  const file = await readFile(getConfigPath(), "utf8");
  expect(file).not.toContain(nativeKey);
  expect(file).not.toContain(oldEnvironment.apiKey);
});

test("declining an environment-to-native switch leaves configuration and credentials unchanged", async () => {
  await isolated();
  process.env.OMP_OMNIROUTE_BASE_URL = "https://environment.example";
  process.env.OMP_OMNIROUTE_API_KEY = "fixture-environment-runtime-key";
  await updateConfig(current => ({ ...current, active: { endpoint: "https://saved.example", generation: 4 }, adminEnabled: true }));
  const before = await readFile(getConfigPath(), "utf8");
  const prompts: string[] = [];
  await expect(nativeLoginHandler().login({
    async onConfirm(options) { prompts.push(options.message); return false; },
    async onPrompt(options) { prompts.push(options.message); return "unused"; },
  })).rejects.toMatchObject({ code: "cancelled" });
  expect(prompts).toEqual(["Use a native OmniRoute profile connection instead of the environment connection?"]);
  expect(await readFile(getConfigPath(), "utf8")).toBe(before);
  expect(process.env.OMP_OMNIROUTE_API_KEY).toBe("fixture-environment-runtime-key");
});

test("native source refuses an environment-only key from the host registry", async () => {
  process.env.OMP_OMNIROUTE_BASE_URL = "https://environment.example";
  process.env.OMP_OMNIROUTE_API_KEY = "fixture-environment-runtime-key";
  let lookups = 0;
  const credential = await resolveRuntimeCredential({
    getApiKeyForProvider() { lookups++; return "fixture-environment-runtime-key"; },
    authStorage: { credentials: { get: () => undefined } },
  }, { runtimeSource: "native", allowInsecureHttp: false });
  expect(credential).toBeUndefined();
  expect(lookups).toBe(0);
});

test("native source uses the persisted key instead of the host's environment fallback", async () => {
  process.env.OMP_OMNIROUTE_BASE_URL = "https://environment.example";
  process.env.OMP_OMNIROUTE_API_KEY = "fixture-environment-runtime-key";
  let lookups = 0;
  const credential = await resolveRuntimeCredential({
    getApiKeyForProvider() { lookups++; return "fixture-environment-runtime-key"; },
    authStorage: { credentials: { get: () => ({ type: "api_key" as const, key: "fixture-native-runtime-key" }) } },
  }, { runtimeSource: "native", allowInsecureHttp: false });
  expect(credential).toBe("fixture-native-runtime-key");
  expect(lookups).toBe(0);
});

test("startup uses only the stored native row and keeps the legacy key cascade", async () => {
  await isolated();
  const storage = await discoverAuthStorage(root!, { cwd: root! });
  try {
    process.env.OMP_OMNIROUTE_API_KEY = "fixture-environment-runtime-key";
    expect(await resolveStartupRuntimeCredential(async () => ({
      credentials: storage.credentials,
      keys: { peek: async () => "fixture-environment-runtime-key" },
      close() {},
    }), new AbortController().signal, { runtimeSource: "native" })).toBeUndefined();
    expect(await resolveStartupRuntimeCredential(async () => ({
      credentials: storage.credentials,
      keys: { peek: async () => "fixture-legacy-runtime-key" },
      close() {},
    }), new AbortController().signal, {})).toBe("fixture-legacy-runtime-key");
  } finally {
    storage.close();
  }
});

test("failed native candidate validation does not select the native source", async () => {
  await isolated();
  process.env.OMP_OMNIROUTE_BASE_URL = "https://environment.example";
  process.env.OMP_OMNIROUTE_API_KEY = "fixture-environment-runtime-key";
  await updateConfig(current => ({ ...current, active: { endpoint: "https://saved.example", generation: 3 } }));
  const before = await readFile(getConfigPath(), "utf8");
  const provider = registerNativeLogin({
    load: loadConfig,
    request: async () => ({ invalid: true }),
  });
  await expect(provider.login({
    async onConfirm() { return true; },
    async onPrompt(options) { return options.secret ? "fixture-native-runtime-key" : "https://native.example"; },
  })).rejects.toMatchObject({ code: "invalid-response" });
  expect(await readFile(getConfigPath(), "utf8")).toBe(before);
  expect((await loadConfig()).runtimeSource).toBeUndefined();
});

test("a public model catalog cannot validate a rejected API key", async () => {
  await isolated();
  await updateConfig(current => ({ ...current, active: { endpoint: "https://existing.example", generation: 3 } }));
  const before = await readFile(getConfigPath(), "utf8");
  const paths: string[] = [];
  const provider = registerNativeLogin({ request: async target => {
    if (typeof target === "string") throw new Error("expected structured request");
    paths.push(target.path ?? "");
    if (target.path === "/api/cloud/auth") throw new TransportError("http", "rejected", 401);
    return { data: [{ id: "public-model" }] };
  } });
  await expect(provider.login({ onPrompt: options => options.secret ? "wrong-key" : "gateway.example" })).rejects.toMatchObject({ code: "unauthorized" });
  expect(paths).toEqual(["/api/cloud/auth"]);
  expect(await readFile(getConfigPath(), "utf8")).toBe(before);
});

test("unavailable or malformed key verification never stages a connection", async () => {
  for (const scenario of [
    { response: () => { throw new TransportError("http", "missing route", 404); }, code: "verification-unavailable" },
    { response: () => { throw new TransportError("redirect", "redirect", 302); }, code: "verification-unavailable" },
    { response: () => { throw new TransportError("network", "offline"); }, code: "network-failure" },
    { response: () => ({ unrelated: true }), code: "invalid-response" },
  ]) {
    await isolated();
    await updateConfig(current => ({ ...current, active: { endpoint: "https://existing.example", generation: 3 } }));
    const before = await readFile(getConfigPath(), "utf8");
    const provider = registerNativeLogin({ request: async target => {
      if (typeof target === "string" || target.path !== "/api/cloud/auth") throw new Error("catalog requested without key proof");
      return scenario.response();
    } });
    await expect(provider.login({ onPrompt: options => options.secret ? "candidate-key" : "gateway.example" })).rejects.toMatchObject({ code: scenario.code });
    expect(await readFile(getConfigPath(), "utf8")).toBe(before);
    setAgentDirResolverForTests(undefined);
    await rm(root!, { recursive: true, force: true });
    root = undefined;
  }
});

test("verified keys with empty or specialty-only catalogs stage an honest zero-chat connection", async () => {
  for (const data of [[], [{ id: "image-only", supported_endpoints: ["images"] }]]) {
    await isolated();
    const messages: string[] = [];
    const provider = registerNativeLogin({ request: async target => {
      if (typeof target === "string") throw new Error("expected structured request");
      if (target.path === "/api/cloud/auth") return { connections: [], modelAliases: {} };
      if (target.path === "/v1/models") return { data };
      throw new Error("unexpected route");
    } });
    expect(await provider.login({
      onPrompt: options => options.secret ? "verified-key" : "gateway.example",
      onMessage: message => { messages.push(message); },
    })).toBe("verified-key");
    expect((await loadConfig()).pending).toMatchObject({ endpoint: "https://gateway.example", status: "validated" });
    expect(messages.join(" ")).toContain("no chat-compatible models");
    setAgentDirResolverForTests(undefined);
    await rm(root!, { recursive: true, force: true });
    root = undefined;
  }
});

test("a verified key with a malformed live catalog does not stage or return a key", async () => {
  await isolated();
  await updateConfig(current => ({ ...current, active: { endpoint: "https://existing.example", generation: 3 } }));
  const before = await readFile(getConfigPath(), "utf8");
  const provider = registerNativeLogin({ request: async target => {
    if (typeof target === "string") throw new Error("expected structured request");
    if (target.path === "/api/cloud/auth") return { connections: [], modelAliases: {} };
    return { data: [{ id: "" }] };
  } });
  await expect(provider.login({ onPrompt: options => options.secret ? "candidate-key" : "gateway.example" })).rejects.toMatchObject({ code: "invalid-catalog" });
  expect(await readFile(getConfigPath(), "utf8")).toBe(before);
});

test("a /v1 endpoint verifies and loads models from the same base path", async () => {
  await isolated();
  const targets: string[] = [];
  const provider = registerNativeLogin({ request: async target => {
    if (typeof target === "string") throw new Error("expected structured request");
    targets.push(`${target.endpoint}${target.path}`);
    return target.path === "/api/cloud/auth"
      ? { connections: [], modelAliases: {} }
      : { data: [{ id: "chat", supported_endpoints: ["chat"] }] };
  } });
  await provider.login({ onPrompt: options => options.secret ? "verified-key" : "gateway.example/base/v1" });
  expect(targets).toEqual([
    "https://gateway.example/base/api/cloud/auth",
    "https://gateway.example/base/v1/models",
  ]);
});

test("cancelling during live catalog validation leaves config and native key untouched", async () => {
  await isolated();
  await updateConfig(current => ({ ...current, active: { endpoint: "https://existing.example", generation: 3 } }));
  const before = await readFile(getConfigPath(), "utf8");
  const controller = new AbortController();
  let staged = false;
  const provider = registerNativeLogin({
    onSetupComplete: () => { staged = true; },
    request: async target => {
      if (typeof target === "string") throw new Error("expected structured request");
      if (target.path === "/api/cloud/auth") return { connections: [], modelAliases: {} };
      controller.abort();
      return { data: [{ id: "live" }] };
    },
  });
  await expect(provider.login({ signal: controller.signal, onPrompt: options => options.secret ? "candidate-key" : "gateway.example" })).rejects.toMatchObject({ code: "cancelled" });
  expect(staged).toBe(false);
  expect(await readFile(getConfigPath(), "utf8")).toBe(before);
});

test("setup uses one switch confirmation, prefills only the URL, and masks the new key", async () => {
  await isolated();
  const invalidEnvironmentUrl = "https://user:embedded-secret@environment.example";
  const savedEndpoint = "https://saved.example";
  const oldKey = "fixture-environment-runtime-key";
  await updateConfig(current => ({ ...current, active: { endpoint: savedEndpoint, generation: 4 } }));
  process.env.OMP_OMNIROUTE_BASE_URL = invalidEnvironmentUrl;
  process.env.OMP_OMNIROUTE_API_KEY = oldKey;
  const newEndpoint = "https://native.example";
  const newKey = "fixture-native-runtime-key";
  const notices: string[] = [];
  const observations: Array<{ initial: string; masked: boolean }> = [];
  const confirmations: string[] = [];
  const provider = nativeLoginHandler();
  const ctx = context([newEndpoint, newKey], [true], notices,
    async (name: string, callbacks: { onPrompt(prompt: { message: string; secret?: boolean; placeholder?: string }): Promise<string> }) => {
      expect(name).toBe("omniroute");
      const key = await provider.login(nativeCallbacks(callbacks));
      const current = await loadConfig();
      if (!current.pending) throw new Error("native login did not stage a candidate");
      await commitPendingConfig(current.pending, current.revision === undefined ? undefined : { expectedRevision: current.revision });
      return key;
    }, [], observations, confirmations);
  await setupConnection(ctx, services());
  expect(confirmations).toHaveLength(1);
  expect(confirmations[0]).toContain("Replace environment connection");
  expect(confirmations[0]).toContain(newEndpoint);
  expect(confirmations[0]).toContain("environment variables remain unchanged");
  expect(observations).toEqual([
    { initial: savedEndpoint, masked: false },
    { initial: "", masked: true },
  ]);
  expect(await loadConfig()).toMatchObject({ runtimeSource: "native", active: { endpoint: newEndpoint } });
  expect(process.env.OMP_OMNIROUTE_API_KEY).toBe(oldKey);
  expect(process.env.OMP_OMNIROUTE_BASE_URL).toBe(invalidEnvironmentUrl);
  expect(notices.join("\n")).not.toContain(oldKey);
  expect(notices.join("\n")).not.toContain(newKey);
  expect(notices.join("\n")).not.toContain("embedded-secret");
  expect(observations[0]?.initial).toBe(savedEndpoint);
  const file = await readFile(getConfigPath(), "utf8");
  expect(file).not.toContain(oldKey);
  expect(file).not.toContain(newKey);
});

test("non-TUI setup refuses without prompts, storage or mutation", async () => {
  await isolated();
  let interactions = 0;
  const notices: string[] = [];
  const wizard = createSetupWizard(services());
  await wizard({
    mode: "json", hasUI: true,
    ui: {
      notify(message: string) { notices.push(message); },
      async select() { interactions++; }, async confirm() { interactions++; return false; },
      async custom() { interactions++; },
    },
  } as never);
  expect(interactions).toBe(0);
  expect(notices.join(" ")).toContain("interactive OMP terminal");
  expect((await loadConfig()).revision).toBeUndefined();
});

test("catalog metadata sources require explicit opt-in and appear in the read-only setup summary", async () => {
  await isolated();
  const notices: string[] = [];
  const selections = [
    "Catalogs (optional)", "Enable models.dev",
    "Catalogs (optional)", "Enable OpenRouter",
    "Summary", "Finish",
  ];
  await createSetupWizard(services())(context([], [], notices, async () => undefined, selections));
  expect((await loadConfig()).catalogSources).toEqual(["models.dev", "openrouter"]);
  const summary = notices.at(-1) ?? "";
  expect(summary).toContain("catalogs=models.dev:");
  expect(summary).toContain("openrouter:");
});

test("startup cancellation closes a native storage handle that arrives after abort", async () => {
  await isolated();
  for (const name of Object.keys(process.env)) {
    if (name.startsWith("OMP_AUTH_BROKER_")) delete process.env[name];
  }
  const storage = await discoverAuthStorage(root!, { cwd: root! });
  let closed = false;
  try {
    await storage.credentials.set("omniroute", { type: "api_key", key: "fixture-native-key", source: "login" });
    const opening = Promise.withResolvers<typeof storage>();
    const controller = new AbortController();
    const lookup = resolveStartupRuntimeCredential(() => {
      controller.abort();
      return opening.promise;
    }, controller.signal, { runtimeSource: "native" });
    await expect(lookup).rejects.toMatchObject({ code: "cancelled" });
    opening.resolve(storage);
    await Promise.resolve();
    await expect(storage.credentials.reload()).rejects.toThrow();
    closed = true;
  } finally {
    if (!closed) storage.close();
  }
});
