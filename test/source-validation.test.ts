import { describe, expect, test } from "bun:test";
import {
  sourceRequestIssue,
  sourceProviderAllowsOptionalApiKey,
  type SourceRequestIssue,
  type SourceRequestValidatorId,
} from "../src/admin/source-validation.ts";
import { loadPinnedModule } from "./fixtures/pinned-handler.fixture.ts";

const VALIDATOR_ID: SourceRequestValidatorId = "omniroute-v3.8.52.provider-create";
const SECRET = "sentinel-secret-must-never-appear-in-errors";

function providerBody(
  provider = "openai-compatible-fixture",
  providerSpecificData?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    provider,
    name: "fixture connection",
    ...(provider === "openai" ? { apiKey: "fixture-api-key" } : {}),
    ...(providerSpecificData === undefined ? {} : { providerSpecificData }),
  };
}

function expectIssue(body: unknown, field: string): SourceRequestIssue {
  const issue = sourceRequestIssue(VALIDATOR_ID, body);
  expect(issue?.field).toBe(field);
  expect(issue?.reason).toBeTruthy();
  return issue!;
}

function loadPinnedManualCreateOracle() {
  const leaf = (path: string) => loadPinnedModule(path, specifier => {
    throw new Error(`Unexpected provider-catalog dependency ${specifier} in ${path}`);
  });
  const gitlabSetup = leaf("src/shared/constants/gitlabDuoSetupMessage.ts");
  const childCatalogs = new Map<string, Record<string, unknown>>();
  const loadChild = (name: string) => {
    const cached = childCatalogs.get(name);
    if (cached) return cached;
    const module = loadPinnedModule(`src/shared/constants/providers/${name}.ts`, specifier => {
      if (specifier === "@/shared/constants/gitlabDuoSetupMessage") return gitlabSetup;
      if (name === "apikey/gateways" && specifier === "./onomeo") return loadChild("apikey/onomeo");
      if (name === "apikey/gateways" && specifier === "./unifically") return loadChild("apikey/unifically");
      throw new Error(`Unexpected catalog leaf dependency ${specifier} in ${name}`);
    });
    childCatalogs.set(name, module);
    return module;
  };
  const constants = loadPinnedModule("src/shared/constants/providers.ts", specifier => {
    if (specifier === "./providers/noauth") return loadChild("noauth");
    if (specifier === "./providers/oauth") return loadChild("oauth");
    if (specifier === "./providers/web-cookie") return loadPinnedModule("src/shared/constants/providers/web-cookie.ts", child => {
      if (child === "./web-cookie-chatplayground") return loadChild("web-cookie-chatplayground");
      if (child === "./web-cookie-notrack") return loadChild("web-cookie-notrack");
      throw new Error(`Unexpected web-cookie catalog dependency ${child}`);
    });
    if (specifier === "./providers/apikey") return loadPinnedModule("src/shared/constants/providers/apikey/index.ts", child => {
      const name = child.replace(/^\.\//, "");
      if (["gateways", "beatapi", "frontier-labs", "inference-hosts", "enterprise-cloud", "regional", "specialty-media"].includes(name)) {
        return loadChild(`apikey/${name}`);
      }
      throw new Error(`Unexpected API-key catalog dependency ${child}`);
    });
    const childNameBySpecifier: Readonly<Record<string, string>> = {
      "./providers/local": "local",
      "./providers/search": "search",
      "./providers/audio": "audio",
      "./providers/upstream-proxy": "upstream-proxy",
      "./providers/cloud-agent": "cloud-agent",
      "./providers/system": "system",
    };
    const childName = childNameBySpecifier[specifier];
    if (childName !== undefined) return loadChild(childName);
    if (specifier === "../validation/providerSchema") return { validateProviders: () => undefined };
    if (specifier === "@omniroute/open-sse/services/usage/supportedProviders.ts") return {};
    throw new Error(`Unexpected provider aggregator dependency ${specifier}`);
  });
  const catalog = loadPinnedModule("src/lib/providers/catalog.ts", specifier => {
    if (specifier === "@/shared/constants/providers") return constants;
    throw new Error(`Unexpected provider catalog dependency ${specifier}`);
  });
  const candidates = new Set<string>();
  const groups = catalog.STATIC_PROVIDER_CATALOG_GROUPS as Record<string, { providers: Record<string, { id: string; alias?: string }> }>;
  for (const group of Object.values(groups)) {
    for (const provider of Object.values(group.providers)) {
      candidates.add(provider.id);
      if (provider.alias) candidates.add(provider.alias);
    }
  }
  for (const provider of constants.FREE_APIKEY_PROVIDER_IDS as Set<string>) candidates.add(provider);
  for (const provider of ["clinepass", "codebuddy-cn", "codebuddy-intl", "xai", "muse-code", "cline", "kilocode"]) candidates.add(provider);
  const canonicalize = (provider: string): string =>
    (constants.resolveProviderId as (id: string) => string)(provider);
  const manual = (provider: string): boolean => {
    const canonical = canonicalize(provider);
    return (catalog.isManagedProviderConnectionId as (id: string) => boolean)(canonical) ||
      (constants.isOpenAICompatibleProvider as (id: string) => boolean)(canonical) ||
      (constants.isAnthropicCompatibleProvider as (id: string) => boolean)(canonical) ||
      Object.hasOwn(constants.NOAUTH_PROVIDERS as object, canonical);
  };
  return { candidates, canonicalize, manual };
}

describe("pinned provider-create source validation", () => {
  test("matches the executed route manual-create allowlist across pinned catalog IDs and aliases", () => {
    const source = loadPinnedManualCreateOracle();
    expect(source.candidates.size).toBeGreaterThan(500);
    for (const provider of source.candidates) {
      const canonical = source.canonicalize(provider);
      const body = {
        provider,
        name: "fixture connection",
        apiKey: SECRET,
        ...(canonical === "google-pse-search" ? { providerSpecificData: { cx: "fixture-engine" } } : {}),
      };
      const issue = sourceRequestIssue(VALIDATOR_ID, body);
      expect(issue?.field === "provider").toBe(!source.manual(provider));
      if (source.manual(provider)) expect(issue).toBeUndefined();
    }

    for (const provider of ["constructor", "toString", "__proto__", "ghe-copilot", "grok-cli", "unknown-provider"]) {
      expect(source.manual(provider)).toBe(false);
      expectIssue({ provider, name: "fixture", apiKey: SECRET, providerSpecificData: provider === "ghe-copilot" ? { gheUrl: "https://enterprise.example" } : undefined }, "provider");
    }
    for (const provider of ["openai-compatible-dynamic", "anthropic-compatible-dynamic"]) {
      expect(source.manual(provider)).toBe(true);
      expect(sourceRequestIssue(VALIDATOR_ID, { provider, name: "fixture", apiKey: SECRET })).toBeUndefined();
    }
  });

  test("fails closed for unknown validator IDs and structurally invalid direct calls", () => {
    expect(sourceRequestIssue("unknown-validator" as SourceRequestValidatorId, providerBody())?.field).toBe("validatorId");
    expectIssue(null, "body");
    expectIssue([], "body");
    expectIssue({ name: "missing provider" }, "provider");
    expectIssue({ provider: "fixture" }, "name");
    expectIssue({ provider: "fixture", name: "valid", apiKey: 1 }, "apiKey");
    expectIssue({ provider: "fixture", name: "valid", providerSpecificData: null, apiKey: SECRET }, "providerSpecificData");
    expectIssue({ provider: "fixture", name: "valid", providerSpecificData: new Date(), apiKey: SECRET }, "providerSpecificData");
  });

  test("matches each pinned optional-key provider family without narrowing it", () => {
    const optionalProviders = [
      "devin-cli-agentic", "duckduckgo-web", "cloudflare-playground", "veoaifree-web",
      "auggie", "zcode", "codex-app-server", "uncloseai", "aihorde",
      "searxng-search", "firecrawl", "copilot-web", "g4f-groq", "g4f-gemini",
      "g4f-pollinations", "g4f-ollama", "g4f-nvidia", "huggingchat", "gitlawb",
      "gitlawb-gmi", "naga-ac", "uc",
      "mlx-gemma", "mlx-qwen", "ollama-local", "lm-studio", "vllm", "lemonade",
      "llamafile", "llama-cpp", "triton", "docker-model-runner", "xinference",
      "oobabooga", "sdwebui", "comfyui",
    ];
    for (const provider of optionalProviders) {
      expect(sourceProviderAllowsOptionalApiKey(provider)).toBe(true);
    }
    expect(sourceProviderAllowsOptionalApiKey("constructor")).toBe(true);
    expect(sourceProviderAllowsOptionalApiKey("toString")).toBe(true);
    expect(sourceProviderAllowsOptionalApiKey("__proto__")).toBe(true);
    expectIssue(providerBody("constructor"), "provider");
    expectIssue(providerBody("toString"), "provider");
    expectIssue(providerBody("__proto__"), "provider");
    expectIssue(providerBody("opencode"), "apiKey");
    expect(sourceRequestIssue(VALIDATOR_ID, { ...providerBody("openai"), apiKey: "fixture-key" })).toBeUndefined();
    expectIssue(providerBody("ordinary-cloud-provider"), "apiKey");
    expectIssue({ ...providerBody("ordinary-cloud-provider"), apiKey: " \t\n " }, "apiKey");
    expectIssue({ ...providerBody("ordinary-cloud-provider"), apiKey: SECRET }, "provider");
    expect(sourceRequestIssue(VALIDATOR_ID, providerBody("openai-compatible-x", { apiKey: "not-a-provider-key-field" }))).toBeUndefined();
  });

  test("matches 3.8.52 explicit no-credential intent and rejects encrypted API-key envelopes", () => {
    expect(sourceRequestIssue(VALIDATOR_ID, {
      ...providerBody("cloudflare-playground"),
      allowNoCredential: true,
    })).toBeUndefined();
    expectIssue({ ...providerBody("cloudflare-playground"), allowNoCredential: false }, "allowNoCredential");
    expectIssue({ ...providerBody("ordinary-cloud-provider"), apiKey: SECRET, allowNoCredential: true }, "allowNoCredential");
    expectIssue({ ...providerBody("ordinary-cloud-provider"), apiKey: " enc:v1:stored-envelope " }, "apiKey");
    expect(sourceRequestIssue(VALIDATOR_ID, {
      ...providerBody("openai"), apiKey: SECRET,
    })).toBeUndefined();
  });

  test("enforces provider base scalar and range constraints", () => {
    expectIssue({ ...providerBody(), provider: "" }, "provider");
    expectIssue({ ...providerBody(), provider: "p".repeat(101) }, "provider");
    expectIssue({ ...providerBody(), provider: "\u{1D400}".repeat(51) }, "provider");
    expectIssue({ ...providerBody(), name: "" }, "name");
    expectIssue({ ...providerBody(), name: "n".repeat(201) }, "name");
    expectIssue({ ...providerBody(), name: "\u{1D400}".repeat(101) }, "name");
    expectIssue({ ...providerBody(), priority: 0 }, "priority");
    expectIssue({ ...providerBody(), priority: 1.5 }, "priority");
    expectIssue({ ...providerBody(), globalPriority: 101 }, "globalPriority");
    expect(sourceRequestIssue(VALIDATOR_ID, { ...providerBody(), globalPriority: null })).toBeUndefined();
    expectIssue({ ...providerBody(), defaultModel: "m".repeat(201) }, "defaultModel");
    expectIssue({ ...providerBody(), testStatus: "s".repeat(51) }, "testStatus");
    expectIssue({ ...providerBody(), apiKey: "k".repeat(100_001) }, "apiKey");
    expect(sourceRequestIssue(VALIDATOR_ID, {
      ...providerBody("openai"),
      apiKey: SECRET,
      priority: 100,
      globalPriority: null,
      defaultModel: null,
      testStatus: "ok",
    })).toBeUndefined();
  });

  test("requires Google PSE cx and rejects OAuth-only manual create even with valid GHE URL", () => {
    const googleBase = providerBody("google-pse-search");
    expectIssue({ ...googleBase, apiKey: SECRET }, "providerSpecificData.cx");
    expectIssue({ ...googleBase, apiKey: SECRET, providerSpecificData: { cx: " \t " } }, "providerSpecificData.cx");
    expectIssue({ ...googleBase, apiKey: SECRET, providerSpecificData: { cx: "x".repeat(501) } }, "providerSpecificData.cx");
    expect(sourceRequestIssue(VALIDATOR_ID, {
      ...googleBase, apiKey: SECRET, providerSpecificData: { cx: " engine-id " },
    })).toBeUndefined();

    const gheBase = providerBody("ghe-copilot");
    expectIssue({ ...gheBase, apiKey: SECRET }, "provider");
    expectIssue({ ...gheBase, apiKey: SECRET, providerSpecificData: { gheUrl: "  " } }, "providerSpecificData.gheUrl");
    expectIssue({ ...gheBase, apiKey: SECRET, providerSpecificData: { gheUrl: "http://github.example" } }, "providerSpecificData.gheUrl");
    expect(sourceRequestIssue(VALIDATOR_ID, {
      ...gheBase, apiKey: SECRET, providerSpecificData: { gheUrl: "https://github.example" },
    })?.field).toBe("provider");
  });

  test("validates URL, optional strings, capability enums, and source coercion behavior", () => {
    expectIssue(providerBody(undefined, { gheUrl: 1 }), "providerSpecificData.gheUrl");
    expectIssue(providerBody(undefined, { baseUrl: "file:///tmp" }), "providerSpecificData.baseUrl");
    expectIssue(providerBody(undefined, { customUserAgent: "a".repeat(501) }), "providerSpecificData.customUserAgent");
    expectIssue(providerBody(undefined, { region: 65 }), "providerSpecificData.region");
    expectIssue(providerBody(undefined, { codexFingerprintMode: "unknown" }), "providerSpecificData.codexFingerprintMode");
    expectIssue(providerBody(undefined, { preserveEncryptedReasoning: "yes" }), "providerSpecificData.preserveEncryptedReasoning");
    expectIssue(providerBody(undefined, { blockExtraUsage: 1 }), "providerSpecificData.blockExtraUsage");
    expectIssue(providerBody(undefined, { autoFetchModels: "yes" }), "providerSpecificData.autoFetchModels");
    expectIssue(providerBody(undefined, { disableStreamOptions: "yes" }), "providerSpecificData.disableStreamOptions");
    expectIssue(providerBody(undefined, { preset: "x".repeat(201) }), "providerSpecificData.preset");
    expectIssue(providerBody(undefined, { requestDefaults: { reasoningEffort: "extreme" } }), "providerSpecificData.requestDefaults.reasoningEffort");
    expectIssue(providerBody(undefined, { requestDefaults: { serviceTier: " turbo " } }), "providerSpecificData.requestDefaults.serviceTier");
    expectIssue(providerBody(undefined, { requestDefaults: { context1m: 1 } }), "providerSpecificData.requestDefaults.context1m");

    expect(sourceRequestIssue(VALIDATOR_ID, providerBody(undefined, {
      gheUrl: "https://enterprise.example",
      baseUrl: "https://gateway.example/v1",
      customUserAgent: null,
      cx: null,
      region: null,
      openaiStoreEnabled: false,
      codexFingerprintMode: "  FULL ",
      preserveEncryptedReasoning: true,
      blockExtraUsage: false,
      autoFetchModels: true,
      disableStreamOptions: false,
      preset: "   ",
      requestDefaults: {
        reasoningEffort: " HIGH ", serviceTier: " Priority ", context1m: null,
        redactThinking: false, summarizeThinking: true,
      },
    }))).toBeUndefined();
    // Upstream skips non-string fingerprint values after coercing them to an empty string.
    expect(sourceRequestIssue(VALIDATOR_ID, providerBody(undefined, { codexFingerprintMode: 12 }))).toBeUndefined();
    expect(sourceRequestIssue(VALIDATOR_ID, providerBody(undefined, { baseUrl: "http:gateway.example" }))).toBeUndefined();
  });

  test("validates cache and peak-hour nested objects without adding stricter time rules", () => {
    expectIssue(providerBody(undefined, { cache: null }), "providerSpecificData.cache");
    expectIssue(providerBody(undefined, { cache: { supportsPromptCaching: "yes" } }), "providerSpecificData.cache.supportsPromptCaching");
    expectIssue(providerBody(undefined, { cache: { cacheControlPassthrough: " CLAUDE-FORMAT " } }), "providerSpecificData.cache.cacheControlPassthrough");
    expectIssue(providerBody(undefined, { peakHourProtection: [] }), "providerSpecificData.peakHourProtection");
    expectIssue(providerBody(undefined, { peakHourProtection: { enabled: 1 } }), "providerSpecificData.peakHourProtection.enabled");
    expectIssue(providerBody(undefined, { peakHourProtection: { mode: "BLOCK" } }), "providerSpecificData.peakHourProtection.mode");
    expectIssue(providerBody(undefined, { peakHourProtection: { windows: [null] } }), "providerSpecificData.peakHourProtection.windows.0");
    expectIssue(providerBody(undefined, { peakHourProtection: { windows: [{ startUtc: "9:0", endUtc: "10:00" }] } }), "providerSpecificData.peakHourProtection.windows.0.startUtc");
    expectIssue(providerBody(undefined, { peakHourProtection: { windows: [{ startUtc: "09:00", endUtc: "10:00", days: "mon" }] } }), "providerSpecificData.peakHourProtection.windows.0.days");
    expectIssue(providerBody(undefined, { peakHourProtection: { windows: [{ startUtc: "09:00", endUtc: "10:00", days: ["holiday"] }] } }), "providerSpecificData.peakHourProtection.windows.0.days");
    expectIssue(providerBody(undefined, { peakHourProtection: { windows: Array.from({ length: 17 }, () => ({ startUtc: "09:00", endUtc: "10:00" })) } }), "providerSpecificData.peakHourProtection.windows");

    expect(sourceRequestIssue(VALIDATOR_ID, providerBody(undefined, {
      cache: { supportsPromptCaching: false, cacheControlPassthrough: "claude-format" },
      peakHourProtection: {
        enabled: true,
        mode: ["block"],
        windows: [{ startUtc: "99:99", endUtc: "0:00", days: [["mon"], "fri"] }],
      },
    }))).toBeUndefined();
    // A non-array windows field is intentionally ignored by the pinned validator.
    expect(sourceRequestIssue(VALIDATOR_ID, providerBody(undefined, { peakHourProtection: { windows: {} } }))).toBeUndefined();
  });

  test("validates credentials, workspace pairing, routing lists, and numeric bounds", () => {
    expectIssue(providerBody(undefined, { consoleApiKey: 1 }), "providerSpecificData.consoleApiKey");
    expectIssue(providerBody(undefined, { newApiUserId: "u".repeat(257) }), "providerSpecificData.newApiUserId");
    expectIssue(providerBody(undefined, { authCookie: 1 }), "providerSpecificData.authCookie");
    expectIssue(providerBody(undefined, { qwenCloudSecToken: "c".repeat(10_001) }), "providerSpecificData.qwenCloudSecToken");
    expectIssue(providerBody(undefined, { glmOrganizationId: 1 }), "providerSpecificData.glmOrganizationId");
    expectIssue(providerBody(undefined, { glmOrganizationId: "org-only" }), "providerSpecificData.glmProjectId");
    expectIssue(providerBody(undefined, { bigmodelProject: "project-only" }), "providerSpecificData.glmOrganizationId");
    expectIssue(providerBody(undefined, { tag: "t".repeat(101) }), "providerSpecificData.tag");
    expectIssue(providerBody(undefined, { tags: ["ok", "  "] }), "providerSpecificData.tags");
    expectIssue(providerBody(undefined, { tags: Array.from({ length: 51 }, () => "tag") }), "providerSpecificData.tags");
    expectIssue(providerBody(undefined, { excludedModels: ["**"] }), "providerSpecificData.excludedModels");
    expectIssue(providerBody(undefined, { excluded_models: [" "] }), "providerSpecificData.excludedModels");
    expectIssue(providerBody(undefined, { excludedModels: "x".repeat(5_001) }), "providerSpecificData.excludedModels");
    expectIssue(providerBody(undefined, { clientProfile: "desktop" }), "providerSpecificData.clientProfile");
    expectIssue(providerBody(undefined, { newApiAggregatorBalance: "true" }), "providerSpecificData.newApiAggregatorBalance");
    expectIssue(providerBody(undefined, { quotaPerUnit: 0 }), "providerSpecificData.quotaPerUnit");
    expectIssue(providerBody(undefined, { quotaPerUnit: Number.POSITIVE_INFINITY }), "providerSpecificData.quotaPerUnit");
    expectIssue(providerBody(undefined, { timeoutMs: 1.5 }), "providerSpecificData.timeoutMs");
    expectIssue(providerBody(undefined, { timeoutMs: 86_400_001 }), "providerSpecificData.timeoutMs");

    expect(sourceRequestIssue(VALIDATOR_ID, providerBody(undefined, {
      consoleApiKey: null,
      newApiUserId: null,
      openCodeGoWorkspaceId: "workspace",
      glmOrganizationId: "org",
      bigmodelProject: "project",
      tag: null,
      tags: [" tag ", "other"],
      excluded_models: ["model/*", "  exact-id  "],
      clientProfile: " CLI ",
      newApiAggregatorBalance: null,
      quotaPerUnit: Number.MIN_VALUE,
      timeoutMs: 86_400_000,
    }))).toBeUndefined();
  });

  test("never echoes API keys or provider-specific secrets in issues", () => {
    const apiKeyIssue = expectIssue({ ...providerBody("ordinary-cloud-provider"), apiKey: SECRET + "x".repeat(100_001) }, "apiKey");
    const specificDataIssue = expectIssue(providerBody(undefined, { consoleApiKey: SECRET, cache: null }), "providerSpecificData.cache");
    expect(JSON.stringify(apiKeyIssue)).not.toContain(SECRET);
    expect(JSON.stringify(specificDataIssue)).not.toContain(SECRET);
    expect(JSON.stringify(specificDataIssue)).not.toContain("consoleApiKey");
  });
});
