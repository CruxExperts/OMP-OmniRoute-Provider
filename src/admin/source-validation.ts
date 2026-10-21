/*
 * Source contract: diegosouzapw/OmniRoute, v3.8.52 commit
 * ad6f33f66bda34eba98645d3bfdabbde294bc843.
 *
 * Pinned upstream files and SHA-256:
 * - src/shared/validation/schemas/provider.ts (createProviderSchema):
 *   fa0f2b7ef52e46b21fb779b972d27560acd7762978b0f918e6934e4f97f9203c
 * - src/shared/validation/providerSpecificData.ts:
 *   be979609ba17862e7875f817e2b4db55df81afee74c0937bfee42d268be6d35b
 * - src/shared/constants/providers.ts:
 *   ef98615ab91f7208d0692e61cee2f41b7ea206f74c181ab971157893ea4d05e8
 * - src/shared/constants/providers/noauth.ts:
 *   0885c88d9247c3d2b7d9885d049138aec665c30dc1f2bb091829d3851acb1544
 * - src/shared/constants/providers/local.ts:
 *   5a4b9e60c9359df938fd2b7968b83c738e758b3dccfe25ed18fe5236c7638477
 * - src/shared/constants/openRouterPreset.ts:
 *   57745b74cea853a1aec25704968077aaf0fedf7a0612641ed88d31a6e4a72975
 * - src/app/api/providers/route.ts:
 *   f6b09f5aaeeef0e759743e17a05a00f8d774180649db70c91b5da8d4c1c030d3
 * - src/lib/providers/compatibleNodeCreation.ts:
 *   3b6a0b0b81ddf2eec0492e1eff89a628df13e2da808c345ec2abdecc2bb0f774
 *
 * The provider identifiers below are portable data transcribed from those
 * upstream authorities; this file does not claim ownership of that data or
 * upstream validation behavior. The pinned upstream repository is MIT-licensed:
 *
 * Copyright (c) 2026 diegosouzapw
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import { FALLBACK_CHAIN_DELETE, FALLBACK_CHAIN_POST, validateFallbackChainRequest } from "./source-fallback-chains.ts";
import { comboSourceValidatorBinding, isComboRequestValidatorId, validateComboRequest, type ComboSourceRequestValidatorId } from "./source-combos.ts";
import type { AdminMethod } from "./types.ts";


export interface SourceRequestValidatorBinding {
  readonly methods: readonly AdminMethod[];
  readonly pathTemplate: string;
}

const SOURCE_REQUEST_VALIDATOR_BINDINGS = Object.freeze({
  "omniroute-v3.8.52.provider-create": Object.freeze({ methods: Object.freeze(["POST"] as const), pathTemplate: "/api/providers" }),
  "omniroute-v3.8.52.fallback-chains.register": Object.freeze({ methods: Object.freeze(["POST"] as const), pathTemplate: "/api/fallback/chains" }),
  "omniroute-v3.8.52.fallback-chains.remove": Object.freeze({ methods: Object.freeze(["DELETE"] as const), pathTemplate: "/api/fallback/chains" }),
}) satisfies Readonly<Record<string, SourceRequestValidatorBinding>>;

export type SourceRequestValidatorId = keyof typeof SOURCE_REQUEST_VALIDATOR_BINDINGS | ComboSourceRequestValidatorId;

export function sourceRequestValidatorBinding(id: unknown): SourceRequestValidatorBinding | undefined {
  const combo = comboSourceValidatorBinding(id);
  if (combo) return combo;
  if (typeof id !== "string" || !Object.hasOwn(SOURCE_REQUEST_VALIDATOR_BINDINGS, id)) return undefined;
  return SOURCE_REQUEST_VALIDATOR_BINDINGS[id as keyof typeof SOURCE_REQUEST_VALIDATOR_BINDINGS];
}

export interface SourceRequestIssue {
  readonly field: string;
  readonly reason: string;
}

const VALIDATOR_ID: SourceRequestValidatorId = "omniroute-v3.8.52.provider-create";
const MAX_PROVIDER_CREDENTIAL_LENGTH = 100_000;
const MAX_PROVIDER_SPECIFIC_TIMEOUT_MS = 86_400_000;
const OPENROUTER_PRESET_MAX_LENGTH = 200;

// Data copied from shared/constants/providers/noauth.ts at the pinned commit.
// Deliberately keep an ordinary-object prototype because upstream uses `in`
// against NOAUTH_PROVIDERS when classifying optional API keys.
const NOAUTH_PROVIDER_IDS: Readonly<Record<string, true>> = Object.freeze({
  "devin-cli-agentic": true,
  "duckduckgo-web": true,
  "cloudflare-playground": true,
  "veoaifree-web": true,
  auggie: true,
  zcode: true,
  "codex-app-server": true,
  uncloseai: true,
  aihorde: true,
});

// Data copied from shared/constants/providers.ts at the pinned commit.
const EXPLICIT_OPTIONAL_API_KEY_PROVIDER_IDS: Readonly<Record<string, true>> = Object.freeze({
  "searxng-search": true,
  firecrawl: true,
  "copilot-web": true,
  "g4f-groq": true,
  "g4f-gemini": true,
  "g4f-pollinations": true,
  "g4f-ollama": true,
  "g4f-nvidia": true,
  huggingchat: true,
  gitlawb: true,
  "gitlawb-gmi": true,
  "naga-ac": true,
  uc: true,
});

// Data copied from shared/constants/providers/local.ts at the pinned commit.
const LOCAL_PROVIDER_IDS: Readonly<Record<string, true>> = Object.freeze({
  "mlx-gemma": true,
  "mlx-qwen": true,
  "ollama-local": true,
  "lm-studio": true,
  vllm: true,
  lemonade: true,
  llamafile: true,
  "llama-cpp": true,
  triton: true,
  "docker-model-runner": true,
  xinference: true,
  oobabooga: true,
  sdwebui: true,
  comfyui: true,
});

// Source's explicit self-hosted classification (a subset of LOCAL_PROVIDER_IDS).
const SELF_HOSTED_CHAT_PROVIDER_IDS: Readonly<Record<string, true>> = Object.freeze({
  "mlx-gemma": true,
  "mlx-qwen": true,
  "ollama-local": true,
  "lm-studio": true,
  vllm: true,
  lemonade: true,
  llamafile: true,
  "llama-cpp": true,
  triton: true,
  "docker-model-runner": true,
  xinference: true,
  oobabooga: true,
});

const OPENAI_COMPATIBLE_PREFIX = "openai-compatible-";
const ANTHROPIC_COMPATIBLE_PREFIX = "anthropic-compatible-";
const OPTIONAL_FIELD_BOOLEAN_REASONS = "must be a boolean";
const MAX_STRING_FIELDS = [
  ["openCodeGoWorkspaceId", 1_000],
  ["opencodeGoWorkspaceId", 1_000],
  ["workspaceId", 1_000],
  ["openCodeGoAuthCookie", 10_000],
  ["opencodeGoAuthCookie", 10_000],
  ["authCookie", 10_000],
  ["ollamaUsageCookie", 10_000],
  ["ollamaCloudUsageCookie", 10_000],
  ["ollamaCloudCookie", 10_000],
  ["usageCookie", 10_000],
  ["alibabaConsoleCookie", 10_000],
  ["alibabaConsoleSecToken", 10_000],
  ["qwenCloudCookie", 10_000],
  ["qwenCloudSecToken", 10_000],
  ["volcConsoleCookie", 10_000],
  ["glmOrganizationId", 200],
  ["bigmodelOrganization", 200],
  ["glmOrganization", 200],
  ["glmProjectId", 200],
  ["bigmodelProject", 200],
  ["glmProject", 200],
] as const;
const WORKSPACE_ID_KEYS = ["glmOrganizationId", "bigmodelOrganization", "glmOrganization"] as const;
const PROJECT_ID_KEYS = ["glmProjectId", "bigmodelProject", "glmProject"] as const;
const BOOLEAN_FIELDS = [
  "openaiStoreEnabled",
  "preserveEncryptedReasoning",
  "blockExtraUsage",
  "autoFetchModels",
  "disableStreamOptions",
] as const;
const REQUEST_DEFAULT_BOOLEAN_FIELDS = ["context1m", "redactThinking", "summarizeThinking"] as const;
const CACHE_PASSTHROUGH_VALUES: Readonly<Record<string, true>> = Object.freeze({
  strip: true,
  "openai-format": true,
  "claude-format": true,
});
const CODEX_FINGERPRINT_MODE_VALUES: readonly string[] = ["off", "device", "session", "full"];
const CODEX_REASONING_EFFORT_VALUES: readonly string[] = ["none", "low", "medium", "high", "xhigh", "max"];
const REQUEST_DEFAULT_SERVICE_TIER_VALUES: readonly string[] = ["default", "priority", "fast", "flex"];
const PEAK_HOUR_PROTECTION_MODES: readonly string[] = ["block", "avoid"];
const PEAK_HOUR_PROTECTION_DAYS: readonly string[] = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const UTC_TIME_PATTERN = /^\d{1,2}:\d{2}$/;

function fail(field: string, reason: string): SourceRequestIssue {
  return { field, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isOptionalApiKeyProvider(provider: string): boolean {
  return (
    provider in NOAUTH_PROVIDER_IDS ||
    Object.prototype.hasOwnProperty.call(EXPLICIT_OPTIONAL_API_KEY_PROVIDER_IDS, provider) ||
    Object.prototype.hasOwnProperty.call(LOCAL_PROVIDER_IDS, provider) ||
    Object.prototype.hasOwnProperty.call(SELF_HOSTED_CHAT_PROVIDER_IDS, provider) ||
    provider.startsWith(OPENAI_COMPATIBLE_PREFIX) ||
    provider.startsWith(ANTHROPIC_COMPATIBLE_PREFIX)
  );
}

/** Mirrors the source's schema-level optional-key classification, including its `in` semantics. */
export function sourceProviderAllowsOptionalApiKey(provider: unknown): boolean {
  return typeof provider === "string" && isOptionalApiKeyProvider(provider);
}

/** Mirrors the route's stricter own-property check for registered no-auth providers. */
export function sourceHasNoAuthProvider(provider: unknown): boolean {
  return typeof provider === "string" && Object.hasOwn(NOAUTH_PROVIDER_IDS, provider);
}

// ECMAScript String.prototype.trim whitespace, checked by code unit to avoid
// allocating a trimmed copy on successful requests.
function isTrimWhitespace(code: number): boolean {
  return (
    code === 0x0009 ||
    code === 0x000a ||
    code === 0x000b ||
    code === 0x000c ||
    code === 0x000d ||
    code === 0x0020 ||
    code === 0x00a0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

function trimmedStart(value: string): number {
  let start = 0;
  while (start < value.length && isTrimWhitespace(value.charCodeAt(start))) start++;
  return start;
}

function trimmedEnd(value: string): number {
  let end = value.length;
  while (end > 0 && isTrimWhitespace(value.charCodeAt(end - 1))) end--;
  return end;
}

function trimmedLength(value: string): number {
  const start = trimmedStart(value);
  return start === value.length ? 0 : trimmedEnd(value) - start;
}

function equalsAsciiCaseInsensitive(value: string, start: number, end: number, expected: string): boolean {
  if (end - start !== expected.length) return false;
  for (let index = 0; index < expected.length; index++) {
    let code = value.charCodeAt(start + index);
    if (code >= 0x0041 && code <= 0x005a) code += 0x20;
    if (code !== expected.charCodeAt(index)) return false;
  }
  return true;
}

function equalsTrimmedAsciiCaseInsensitive(value: string, expected: string): boolean {
  const start = trimmedStart(value);
  const end = trimmedEnd(value);
  return end >= start && equalsAsciiCaseInsensitive(value, start, end, expected);
}

function isOneOfTrimmedAsciiCaseInsensitive(value: string, choices: readonly string[]): boolean {
  const start = trimmedStart(value);
  const end = trimmedEnd(value);
  for (let index = 0; index < choices.length; index++) {
    if (end >= start && equalsAsciiCaseInsensitive(value, start, end, choices[index]!)) return true;
  }
  return false;
}

function trimmedEquals(value: string, expected: string): boolean {
  const start = trimmedStart(value);
  const end = trimmedEnd(value);
  if (end < start || end - start !== expected.length) return false;
  for (let index = 0; index < expected.length; index++) {
    if (value.charCodeAt(start + index) !== expected.charCodeAt(index)) return false;
  }
  return true;
}
function hasNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && trimmedLength(value) > 0;
}

function isOneOfStringCoercion(value: unknown, values: readonly string[]): boolean {
  // The upstream uses String(value) for these two enum checks. On JSON values,
  // only strings and single-element nested arrays can coerce to these plain
  // alphabetic enum values without introducing a comma or non-alphabetic text.
  let candidate = value;
  while (Array.isArray(candidate)) {
    if (candidate.length !== 1) return false;
    candidate = candidate[0];
  }
  if (typeof candidate !== "string") return false;
  for (let index = 0; index < values.length; index++) {
    if (candidate === values[index]) return true;
  }
  return false;
}

function validateProviderSpecificData(data: Record<string, unknown>): SourceRequestIssue | undefined {
  const gheUrl = data.gheUrl;
  if (gheUrl !== undefined) {
    if (typeof gheUrl !== "string") return fail("providerSpecificData.gheUrl", "must be a valid HTTPS URL");
    try {
      if (new URL(gheUrl).protocol !== "https:") {
        return fail("providerSpecificData.gheUrl", "must use HTTPS");
      }
    } catch {
      return fail("providerSpecificData.gheUrl", "must be a valid HTTPS URL");
    }
  }

  const baseUrl = data.baseUrl;
  if (baseUrl !== undefined) {
    if (typeof baseUrl !== "string") return fail("providerSpecificData.baseUrl", "must be a valid http(s) URL");
    try {
      const protocol = new URL(baseUrl).protocol;
      if (protocol !== "http:" && protocol !== "https:") {
        return fail("providerSpecificData.baseUrl", "must be a valid http(s) URL");
      }
    } catch {
      return fail("providerSpecificData.baseUrl", "must be a valid http(s) URL");
    }
  }

  const customUserAgent = data.customUserAgent;
  if (customUserAgent !== undefined && customUserAgent !== null &&
      (typeof customUserAgent !== "string" || customUserAgent.length > 500)) {
    return fail("providerSpecificData.customUserAgent", "must be a string up to 500 characters");
  }

  const cx = data.cx;
  if (cx !== undefined && cx !== null && (typeof cx !== "string" || cx.length > 500)) {
    return fail("providerSpecificData.cx", "must be a string up to 500 characters");
  }

  const region = data.region;
  if (region !== undefined && region !== null && (typeof region !== "string" || region.length > 64)) {
    return fail("providerSpecificData.region", "must be a string up to 64 characters");
  }

  for (let index = 0; index < BOOLEAN_FIELDS.length; index++) {
    const key = BOOLEAN_FIELDS[index]!;
    const value = data[key];
    if (value !== undefined && typeof value !== "boolean") {
      return fail(`providerSpecificData.${key}`, OPTIONAL_FIELD_BOOLEAN_REASONS);
    }
  }

  const codexFingerprintMode = data.codexFingerprintMode;
  if (codexFingerprintMode !== undefined && codexFingerprintMode !== null &&
      typeof codexFingerprintMode === "string" &&
      trimmedLength(codexFingerprintMode) > 0 &&
      !isOneOfTrimmedAsciiCaseInsensitive(codexFingerprintMode, CODEX_FINGERPRINT_MODE_VALUES)) {
    return fail("providerSpecificData.codexFingerprintMode", "must be off, device, session, or full");
  }

  const peakHourProtection = data.peakHourProtection;
  if (peakHourProtection !== undefined && peakHourProtection !== null) {
    if (!isRecord(peakHourProtection)) {
      return fail("providerSpecificData.peakHourProtection", "must be an object");
    }
    const enabled = peakHourProtection.enabled;
    if (enabled !== undefined && typeof enabled !== "boolean") {
      return fail("providerSpecificData.peakHourProtection.enabled", "must be a boolean");
    }
    const mode = peakHourProtection.mode;
    if (mode !== undefined && !isOneOfStringCoercion(mode, PEAK_HOUR_PROTECTION_MODES)) {
      return fail("providerSpecificData.peakHourProtection.mode", "must be block or avoid");
    }
    const windows = peakHourProtection.windows;
    if (Array.isArray(windows)) {
      if (windows.length > 16) return fail("providerSpecificData.peakHourProtection.windows", "supports at most 16 windows");
      for (let index = 0; index < windows.length; index++) {
        const window = windows[index];
        if (!isRecord(window)) {
          return fail(`providerSpecificData.peakHourProtection.windows.${index}`, "must be an object");
        }
        const startUtc = window.startUtc;
        if (typeof startUtc !== "string" || !UTC_TIME_PATTERN.test(startUtc)) {
          return fail(`providerSpecificData.peakHourProtection.windows.${index}.startUtc`, "must use HH:MM format");
        }
        const endUtc = window.endUtc;
        if (typeof endUtc !== "string" || !UTC_TIME_PATTERN.test(endUtc)) {
          return fail(`providerSpecificData.peakHourProtection.windows.${index}.endUtc`, "must use HH:MM format");
        }
        const days = window.days;
        if (days !== undefined) {
          if (!Array.isArray(days)) {
            return fail(`providerSpecificData.peakHourProtection.windows.${index}.days`, "must be an array");
          }
          for (let dayIndex = 0; dayIndex < days.length; dayIndex++) {
            if (!isOneOfStringCoercion(days[dayIndex], PEAK_HOUR_PROTECTION_DAYS)) {
              return fail(`providerSpecificData.peakHourProtection.windows.${index}.days`, "contains an invalid day");
            }
          }
        }
      }
    }
  }


  const preset = data.preset;
  if (preset !== undefined && preset !== null) {
    if (typeof preset !== "string" || trimmedLength(preset) > OPENROUTER_PRESET_MAX_LENGTH) {
      return fail("providerSpecificData.preset", "must be a string up to 200 trimmed characters");
    }
  }

  const requestDefaults = data.requestDefaults;
  if (requestDefaults !== undefined) {
    if (!isRecord(requestDefaults)) {
      return fail("providerSpecificData.requestDefaults", "must be an object");
    }
    const reasoningEffort = requestDefaults.reasoningEffort;
    if (reasoningEffort !== undefined && reasoningEffort !== null &&
        (typeof reasoningEffort !== "string" || !isOneOfTrimmedAsciiCaseInsensitive(reasoningEffort, CODEX_REASONING_EFFORT_VALUES))) {
      return fail("providerSpecificData.requestDefaults.reasoningEffort", "must be a supported reasoning effort");
    }
    const serviceTier = requestDefaults.serviceTier;
    if (serviceTier !== undefined && serviceTier !== null &&
        (typeof serviceTier !== "string" || !isOneOfTrimmedAsciiCaseInsensitive(serviceTier, REQUEST_DEFAULT_SERVICE_TIER_VALUES))) {
      return fail("providerSpecificData.requestDefaults.serviceTier", "must be a supported service tier");
    }
    for (let index = 0; index < REQUEST_DEFAULT_BOOLEAN_FIELDS.length; index++) {
      const key = REQUEST_DEFAULT_BOOLEAN_FIELDS[index]!;
      const value = requestDefaults[key];
      if (value !== undefined && value !== null && typeof value !== "boolean") {
        return fail(`providerSpecificData.requestDefaults.${key}`, "must be a boolean or null");
      }
    }
  }

  const cache = data.cache;
  if (cache !== undefined) {
    if (!isRecord(cache)) return fail("providerSpecificData.cache", "must be an object");
    const supportsPromptCaching = cache.supportsPromptCaching;
    if (supportsPromptCaching !== undefined && typeof supportsPromptCaching !== "boolean") {
      return fail("providerSpecificData.cache.supportsPromptCaching", "must be a boolean");
    }
    const cacheControlPassthrough = cache.cacheControlPassthrough;
    if (cacheControlPassthrough !== undefined &&
        (typeof cacheControlPassthrough !== "string" ||
         !Object.prototype.hasOwnProperty.call(CACHE_PASSTHROUGH_VALUES, cacheControlPassthrough))) {
      return fail("providerSpecificData.cache.cacheControlPassthrough", "must be strip, openai-format, or claude-format");
    }
  }

  const consoleApiKey = data.consoleApiKey;
  if (consoleApiKey !== undefined && consoleApiKey !== null && typeof consoleApiKey !== "string") {
    return fail("providerSpecificData.consoleApiKey", "must be a string or null");
  }
  if (typeof consoleApiKey === "string" && consoleApiKey.length > 10_000) {
    return fail("providerSpecificData.consoleApiKey", "must be at most 10000 characters");
  }

  const newApiUserId = data.newApiUserId;
  if (newApiUserId !== undefined && newApiUserId !== null && typeof newApiUserId !== "string") {
    return fail("providerSpecificData.newApiUserId", "must be a string or null");
  }
  if (typeof newApiUserId === "string" && newApiUserId.length > 256) {
    return fail("providerSpecificData.newApiUserId", "must be at most 256 characters");
  }

  for (let index = 0; index < MAX_STRING_FIELDS.length; index++) {
    const [key, maximumLength] = MAX_STRING_FIELDS[index]!;
    const value = data[key];
    if (value !== undefined && value !== null && typeof value !== "string") {
      return fail(`providerSpecificData.${key}`, "must be a string or null");
    }
    if (typeof value === "string" && value.length > maximumLength) {
      return fail(`providerSpecificData.${key}`, `must be at most ${maximumLength} characters`);
    }
  }

  const organizationId = firstTrimmedString(data, WORKSPACE_ID_KEYS);
  const projectId = firstTrimmedString(data, PROJECT_ID_KEYS);
  if ((organizationId !== undefined) !== (projectId !== undefined)) {
    return fail(
      organizationId !== undefined ? "providerSpecificData.glmProjectId" : "providerSpecificData.glmOrganizationId",
      "organization and project identifiers must both be set",
    );
  }

  const tag = data.tag;
  if (tag !== undefined && tag !== null && (typeof tag !== "string" || tag.length > 100)) {
    return fail("providerSpecificData.tag", "must be a string up to 100 characters");
  }

  const routingTags = data.tags;
  if (routingTags !== undefined && routingTags !== null) {
    if (!Array.isArray(routingTags) || routingTags.length > 50) {
      return fail("providerSpecificData.tags", "must be an array with at most 50 items");
    }
    for (let index = 0; index < routingTags.length; index++) {
      const value = routingTags[index];
      if (typeof value !== "string" || trimmedLength(value) === 0 || trimmedLength(value) > 64) {
        return fail("providerSpecificData.tags", "must contain non-empty strings up to 64 characters each");
      }
    }
  }

  const excludedModels = data.excludedModels ?? data.excluded_models;
  if (excludedModels !== undefined && excludedModels !== null) {
    if (typeof excludedModels === "string") {
      if (excludedModels.length > 5_000) {
        return fail("providerSpecificData.excludedModels", "string must be up to 5000 characters");
      }
    } else if (!Array.isArray(excludedModels) || excludedModels.length > 100) {
      return fail("providerSpecificData.excludedModels", "must be an array with at most 100 items");
    } else {
      for (let index = 0; index < excludedModels.length; index++) {
        const pattern = excludedModels[index];
        if (typeof pattern !== "string" || trimmedLength(pattern) === 0 || trimmedLength(pattern) > 200 || trimmedEquals(pattern, "**")) {
          return fail("providerSpecificData.excludedModels", "must contain non-empty patterns up to 200 characters");
        }
      }
    }
  }

  const clientProfile = data.clientProfile;
  if (clientProfile !== undefined && clientProfile !== null &&
      (typeof clientProfile !== "string" ||
       (!equalsTrimmedAsciiCaseInsensitive(clientProfile, "ide") &&
        !equalsTrimmedAsciiCaseInsensitive(clientProfile, "cli")))) {
    return fail("providerSpecificData.clientProfile", "must be ide or cli");
  }

  const newApiAggregatorBalance = data.newApiAggregatorBalance;
  if (newApiAggregatorBalance !== undefined && newApiAggregatorBalance !== null &&
      typeof newApiAggregatorBalance !== "boolean") {
    return fail("providerSpecificData.newApiAggregatorBalance", "must be a boolean or null");
  }

  const quotaPerUnit = data.quotaPerUnit;
  if (quotaPerUnit !== undefined && quotaPerUnit !== null &&
      (typeof quotaPerUnit !== "number" || !Number.isFinite(quotaPerUnit) || quotaPerUnit <= 0)) {
    return fail("providerSpecificData.quotaPerUnit", "must be a positive finite number or null");
  }

  const timeoutMs = data.timeoutMs;
  if (timeoutMs !== undefined && timeoutMs !== null &&
      (typeof timeoutMs !== "number" || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_PROVIDER_SPECIFIC_TIMEOUT_MS)) {
    return fail("providerSpecificData.timeoutMs", "must be an integer from 1 through 86400000 or null");
  }

  return undefined;
}

function firstTrimmedString(data: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (let index = 0; index < keys.length; index++) {
    const value = data[keys[index]!];
    if (typeof value === "string" && trimmedLength(value) > 0) return value;
  }
  return undefined;
}

export function sourceRequestIssue(
  id: SourceRequestValidatorId,
  body: unknown,
): SourceRequestIssue | undefined {
  if (isComboRequestValidatorId(id)) return validateComboRequest(id, body);
  if (id === "omniroute-v3.8.52.fallback-chains.register" || id === "omniroute-v3.8.52.fallback-chains.remove") {
    const result = validateFallbackChainRequest(
      id === "omniroute-v3.8.52.fallback-chains.register" ? FALLBACK_CHAIN_POST : FALLBACK_CHAIN_DELETE,
      body,
    );
    if (result.success) return undefined;
    const issue = result.error.details[0];
    return fail(issue?.field || "body", "must satisfy the pinned fallback-chain request schema");
  }
  if (id !== VALIDATOR_ID) return fail("validatorId", "is not a supported source validator");
  if (!isRecord(body)) return fail("body", "must be an object");

  const provider = body.provider;
  if (typeof provider !== "string" || provider.length < 1 || provider.length > 100) {
    return fail("provider", "must be a string from 1 through 100 characters");
  }
  const name = body.name;
  if (typeof name !== "string" || name.length < 1 || name.length > 200) {
    return fail("name", "must be a string from 1 through 200 characters");
  }

  const apiKey = body.apiKey;
  if (apiKey !== undefined && (typeof apiKey !== "string" || apiKey.length > MAX_PROVIDER_CREDENTIAL_LENGTH)) {
    return fail("apiKey", "must be a string up to 100000 characters");
  }
  const allowNoCredential = body.allowNoCredential;
  if (allowNoCredential !== undefined && allowNoCredential !== true) {
    return fail("allowNoCredential", "must be true when present");
  }
  if (allowNoCredential === true && !isOptionalApiKeyProvider(provider)) {
    return fail("allowNoCredential", "this provider does not allow a connection without a credential");
  }
  if (typeof apiKey === "string" && apiKey.trim().startsWith("enc:v1:")) {
    return fail("apiKey", "must be plaintext, not an encrypted credential envelope");
  }
  if (!isOptionalApiKeyProvider(provider) && !hasNonEmptyString(apiKey)) {
    return fail("apiKey", "is required and must not be blank");
  }

  const priority = body.priority;
  if (priority !== undefined &&
      (typeof priority !== "number" || !Number.isInteger(priority) || priority < 1 || priority > 100)) {
    return fail("priority", "must be an integer from 1 through 100");
  }
  const globalPriority = body.globalPriority;
  if (globalPriority !== undefined && globalPriority !== null &&
      (typeof globalPriority !== "number" || !Number.isInteger(globalPriority) || globalPriority < 1 || globalPriority > 100)) {
    return fail("globalPriority", "must be an integer from 1 through 100 or null");
  }
  const defaultModel = body.defaultModel;
  if (defaultModel !== undefined && defaultModel !== null &&
      (typeof defaultModel !== "string" || defaultModel.length > 200)) {
    return fail("defaultModel", "must be a string up to 200 characters or null");
  }
  const testStatus = body.testStatus;
  if (testStatus !== undefined && (typeof testStatus !== "string" || testStatus.length > 50)) {
    return fail("testStatus", "must be a string up to 50 characters");
  }

  const providerSpecificData = body.providerSpecificData;
  if (providerSpecificData !== undefined) {
    if (!isRecord(providerSpecificData)) {
      return fail("providerSpecificData", "must be an object");
    }
    const specificIssue = validateProviderSpecificData(providerSpecificData);
    if (specificIssue) return specificIssue;

    if (provider === "google-pse-search" && !hasNonEmptyString(providerSpecificData.cx)) {
      return fail("providerSpecificData.cx", "is required and must not be blank");
    }
    if (provider === "ghe-copilot" && !hasNonEmptyString(providerSpecificData.gheUrl)) {
      return fail("providerSpecificData.gheUrl", "is required and must not be blank");
    }
  } else if (provider === "google-pse-search") {
    return fail("providerSpecificData.cx", "is required and must not be blank");
  } else if (provider === "ghe-copilot") {
    return fail("providerSpecificData.gheUrl", "is required and must not be blank");
  }

  return undefined;
}
