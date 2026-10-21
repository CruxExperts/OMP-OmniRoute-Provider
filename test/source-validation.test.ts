import { describe, expect, test } from "bun:test";
import {
  sourceRequestIssue,
  type SourceRequestIssue,
  type SourceRequestValidatorId,
} from "../src/admin/source-validation.ts";

const VALIDATOR_ID: SourceRequestValidatorId = "omniroute-v3.8.52.provider-create";
const SECRET = "sentinel-secret-must-never-appear-in-errors";

function providerBody(
  provider = "openai-compatible-fixture",
  providerSpecificData?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    provider,
    name: "fixture connection",
    ...(provider === "fixture" ? { apiKey: "fixture-api-key" } : {}),
    ...(providerSpecificData === undefined ? {} : { providerSpecificData }),
  };
}

function expectIssue(body: unknown, field: string): SourceRequestIssue {
  const issue = sourceRequestIssue(VALIDATOR_ID, body);
  expect(issue?.field).toBe(field);
  expect(issue?.reason).toBeTruthy();
  return issue!;
}

describe("pinned provider-create source validation", () => {
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
      "openai-compatible-private-provider", "anthropic-compatible-private-provider",
      // Source's `in` test against an ordinary object also recognizes inherited keys.
      "constructor", "toString", "__proto__",
    ];
    for (const provider of optionalProviders) {
      expect(sourceRequestIssue(VALIDATOR_ID, providerBody(provider))).toBeUndefined();
    }
    expectIssue(providerBody("opencode"), "apiKey");
    expect(sourceRequestIssue(VALIDATOR_ID, { ...providerBody("opencode"), apiKey: "fixture-key" })).toBeUndefined();
    expectIssue(providerBody("ordinary-cloud-provider"), "apiKey");
    expectIssue({ ...providerBody("ordinary-cloud-provider"), apiKey: " \t\n " }, "apiKey");
    expect(sourceRequestIssue(VALIDATOR_ID, { ...providerBody("ordinary-cloud-provider"), apiKey: SECRET })).toBeUndefined();
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
      ...providerBody("ordinary-cloud-provider"), apiKey: SECRET,
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
      ...providerBody("ordinary-cloud-provider"),
      apiKey: SECRET,
      priority: 100,
      globalPriority: null,
      defaultModel: null,
      testStatus: "ok",
    })).toBeUndefined();
  });

  test("requires Google PSE cx and GitHub Enterprise Copilot HTTPS URL", () => {
    const googleBase = providerBody("google-pse-search");
    expectIssue({ ...googleBase, apiKey: SECRET }, "providerSpecificData.cx");
    expectIssue({ ...googleBase, apiKey: SECRET, providerSpecificData: { cx: " \t " } }, "providerSpecificData.cx");
    expectIssue({ ...googleBase, apiKey: SECRET, providerSpecificData: { cx: "x".repeat(501) } }, "providerSpecificData.cx");
    expect(sourceRequestIssue(VALIDATOR_ID, {
      ...googleBase, apiKey: SECRET, providerSpecificData: { cx: " engine-id " },
    })).toBeUndefined();

    const gheBase = providerBody("ghe-copilot");
    expectIssue({ ...gheBase, apiKey: SECRET }, "providerSpecificData.gheUrl");
    expectIssue({ ...gheBase, apiKey: SECRET, providerSpecificData: { gheUrl: "  " } }, "providerSpecificData.gheUrl");
    expectIssue({ ...gheBase, apiKey: SECRET, providerSpecificData: { gheUrl: "http://github.example" } }, "providerSpecificData.gheUrl");
    expect(sourceRequestIssue(VALIDATOR_ID, {
      ...gheBase, apiKey: SECRET, providerSpecificData: { gheUrl: "https://github.example" },
    })).toBeUndefined();
  });

  test("validates URL, optional strings, capability enums, and source coercion behavior", () => {
    expectIssue(providerBody("fixture", { gheUrl: 1 }), "providerSpecificData.gheUrl");
    expectIssue(providerBody("fixture", { baseUrl: "file:///tmp" }), "providerSpecificData.baseUrl");
    expectIssue(providerBody("fixture", { customUserAgent: "a".repeat(501) }), "providerSpecificData.customUserAgent");
    expectIssue(providerBody("fixture", { region: 65 }), "providerSpecificData.region");
    expectIssue(providerBody("fixture", { codexFingerprintMode: "unknown" }), "providerSpecificData.codexFingerprintMode");
    expectIssue(providerBody("fixture", { preserveEncryptedReasoning: "yes" }), "providerSpecificData.preserveEncryptedReasoning");
    expectIssue(providerBody("fixture", { blockExtraUsage: 1 }), "providerSpecificData.blockExtraUsage");
    expectIssue(providerBody("fixture", { autoFetchModels: "yes" }), "providerSpecificData.autoFetchModels");
    expectIssue(providerBody("fixture", { disableStreamOptions: "yes" }), "providerSpecificData.disableStreamOptions");
    expectIssue(providerBody("fixture", { preset: "x".repeat(201) }), "providerSpecificData.preset");
    expectIssue(providerBody("fixture", { requestDefaults: { reasoningEffort: "extreme" } }), "providerSpecificData.requestDefaults.reasoningEffort");
    expectIssue(providerBody("fixture", { requestDefaults: { serviceTier: " turbo " } }), "providerSpecificData.requestDefaults.serviceTier");
    expectIssue(providerBody("fixture", { requestDefaults: { context1m: 1 } }), "providerSpecificData.requestDefaults.context1m");

    expect(sourceRequestIssue(VALIDATOR_ID, providerBody("fixture", {
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
    expect(sourceRequestIssue(VALIDATOR_ID, providerBody("fixture", { codexFingerprintMode: 12 }))).toBeUndefined();
    expect(sourceRequestIssue(VALIDATOR_ID, providerBody("fixture", { baseUrl: "http:gateway.example" }))).toBeUndefined();
  });

  test("validates cache and peak-hour nested objects without adding stricter time rules", () => {
    expectIssue(providerBody("fixture", { cache: null }), "providerSpecificData.cache");
    expectIssue(providerBody("fixture", { cache: { supportsPromptCaching: "yes" } }), "providerSpecificData.cache.supportsPromptCaching");
    expectIssue(providerBody("fixture", { cache: { cacheControlPassthrough: " CLAUDE-FORMAT " } }), "providerSpecificData.cache.cacheControlPassthrough");
    expectIssue(providerBody("fixture", { peakHourProtection: [] }), "providerSpecificData.peakHourProtection");
    expectIssue(providerBody("fixture", { peakHourProtection: { enabled: 1 } }), "providerSpecificData.peakHourProtection.enabled");
    expectIssue(providerBody("fixture", { peakHourProtection: { mode: "BLOCK" } }), "providerSpecificData.peakHourProtection.mode");
    expectIssue(providerBody("fixture", { peakHourProtection: { windows: [null] } }), "providerSpecificData.peakHourProtection.windows.0");
    expectIssue(providerBody("fixture", { peakHourProtection: { windows: [{ startUtc: "9:0", endUtc: "10:00" }] } }), "providerSpecificData.peakHourProtection.windows.0.startUtc");
    expectIssue(providerBody("fixture", { peakHourProtection: { windows: [{ startUtc: "09:00", endUtc: "10:00", days: "mon" }] } }), "providerSpecificData.peakHourProtection.windows.0.days");
    expectIssue(providerBody("fixture", { peakHourProtection: { windows: [{ startUtc: "09:00", endUtc: "10:00", days: ["holiday"] }] } }), "providerSpecificData.peakHourProtection.windows.0.days");
    expectIssue(providerBody("fixture", { peakHourProtection: { windows: Array.from({ length: 17 }, () => ({ startUtc: "09:00", endUtc: "10:00" })) } }), "providerSpecificData.peakHourProtection.windows");

    expect(sourceRequestIssue(VALIDATOR_ID, providerBody("fixture", {
      cache: { supportsPromptCaching: false, cacheControlPassthrough: "claude-format" },
      peakHourProtection: {
        enabled: true,
        mode: ["block"],
        windows: [{ startUtc: "99:99", endUtc: "0:00", days: [["mon"], "fri"] }],
      },
    }))).toBeUndefined();
    // A non-array windows field is intentionally ignored by the pinned validator.
    expect(sourceRequestIssue(VALIDATOR_ID, providerBody("fixture", { peakHourProtection: { windows: {} } }))).toBeUndefined();
  });

  test("validates credentials, workspace pairing, routing lists, and numeric bounds", () => {
    expectIssue(providerBody("fixture", { consoleApiKey: 1 }), "providerSpecificData.consoleApiKey");
    expectIssue(providerBody("fixture", { newApiUserId: "u".repeat(257) }), "providerSpecificData.newApiUserId");
    expectIssue(providerBody("fixture", { authCookie: 1 }), "providerSpecificData.authCookie");
    expectIssue(providerBody("fixture", { qwenCloudSecToken: "c".repeat(10_001) }), "providerSpecificData.qwenCloudSecToken");
    expectIssue(providerBody("fixture", { glmOrganizationId: 1 }), "providerSpecificData.glmOrganizationId");
    expectIssue(providerBody("fixture", { glmOrganizationId: "org-only" }), "providerSpecificData.glmProjectId");
    expectIssue(providerBody("fixture", { bigmodelProject: "project-only" }), "providerSpecificData.glmOrganizationId");
    expectIssue(providerBody("fixture", { tag: "t".repeat(101) }), "providerSpecificData.tag");
    expectIssue(providerBody("fixture", { tags: ["ok", "  "] }), "providerSpecificData.tags");
    expectIssue(providerBody("fixture", { tags: Array.from({ length: 51 }, () => "tag") }), "providerSpecificData.tags");
    expectIssue(providerBody("fixture", { excludedModels: ["**"] }), "providerSpecificData.excludedModels");
    expectIssue(providerBody("fixture", { excluded_models: [" "] }), "providerSpecificData.excludedModels");
    expectIssue(providerBody("fixture", { excludedModels: "x".repeat(5_001) }), "providerSpecificData.excludedModels");
    expectIssue(providerBody("fixture", { clientProfile: "desktop" }), "providerSpecificData.clientProfile");
    expectIssue(providerBody("fixture", { newApiAggregatorBalance: "true" }), "providerSpecificData.newApiAggregatorBalance");
    expectIssue(providerBody("fixture", { quotaPerUnit: 0 }), "providerSpecificData.quotaPerUnit");
    expectIssue(providerBody("fixture", { quotaPerUnit: Number.POSITIVE_INFINITY }), "providerSpecificData.quotaPerUnit");
    expectIssue(providerBody("fixture", { timeoutMs: 1.5 }), "providerSpecificData.timeoutMs");
    expectIssue(providerBody("fixture", { timeoutMs: 86_400_001 }), "providerSpecificData.timeoutMs");

    expect(sourceRequestIssue(VALIDATOR_ID, providerBody("fixture", {
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
    const specificDataIssue = expectIssue(providerBody("fixture", { consoleApiKey: SECRET, cache: null }), "providerSpecificData.cache");
    expect(JSON.stringify(apiKeyIssue)).not.toContain(SECRET);
    expect(JSON.stringify(specificDataIssue)).not.toContain(SECRET);
    expect(JSON.stringify(specificDataIssue)).not.toContain("consoleApiKey");
  });
});
