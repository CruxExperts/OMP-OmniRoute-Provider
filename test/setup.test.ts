import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverAuthStorage } from "@oh-my-pi/pi-coding-agent";
import { clearPendingCandidate, recoverPendingAfterPersistence, registerNativeLogin, resolveRuntimeCredential, resolveStartupRuntimeCredential } from "../src/auth.ts";
import { commitPendingConfig, getConfigPath, loadConfig, setAgentDirResolverForTests, updateConfig, validateEndpoint } from "../src/config.ts";
import { OptionalCredentials } from "../src/credentials.ts";
import { createSetupWizard, setupConnection, type SetupServices } from "../src/setup.ts";

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
        };
        promptObservations?.push({ initial: component.getValue?.() ?? "", masked: component.mask === true });
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
      if (typeof target !== "string") throw new Error("unexpected request target");
      expect(target).toMatch(/\/v1\/models$/);
      expect(credential).toBe("fixture-native-runtime-key");
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
  })).rejects.toMatchObject({ code: "validation-failed" });
  expect(await readFile(getConfigPath(), "utf8")).toBe(before);
  expect((await loadConfig()).runtimeSource).toBeUndefined();
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
