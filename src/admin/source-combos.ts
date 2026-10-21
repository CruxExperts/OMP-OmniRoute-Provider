/*
 * Source-derived combo request and relation codecs for OmniRoute v3.8.52,
 * commit ad6f33f66bda34eba98645d3bfdabbde294bc843.
 *
 * These helpers are deliberately pure. The existing registry/executor owns
 * transport, authorization, planning, confirmation, dispatch, and reconciliation.
 */
import type { AdminMethod, JsonObject, JsonValue } from "./types.ts";
import type { SourceRequestIssue } from "./source-validation.ts";
import type { ValidatedOperationInput } from "./registry.ts";

export const COMBO_OPERATION_IDS = [
  "GET /api/combos",
  "POST /api/combos",
  "GET /api/combos/{id}",
  "PUT /api/combos/{id}",
  "PATCH /api/combos/{id}",
  "DELETE /api/combos/{id}",
  "GET /api/combos/auto",
  "GET /api/combos/builder/options",
  "GET /api/combos/metrics",
  "DELETE /api/combos/metrics",
  "POST /api/combos/duplicate",
  "POST /api/combos/reorder",
  "POST /api/combos/test",
] as const;

export type ComboOperationId = typeof COMBO_OPERATION_IDS[number];
export type ComboSourceRequestValidatorId =
  | "omniroute-v3.8.52.combos.create"
  | "omniroute-v3.8.52.combos.update"
  | "omniroute-v3.8.52.combos.duplicate"
  | "omniroute-v3.8.52.combos.reorder"
  | "omniroute-v3.8.52.combos.test";
export type ComboSourceNormalizationId = ComboSourceRequestValidatorId | "omniroute-v3.8.52.combos.list-query" | "omniroute-v3.8.52.combos.metrics-reset-query";
export type ComboSourceRelationViewId =
  | "omniroute-v3.8.52.combos.create-reconcile"
  | "omniroute-v3.8.52.combos.duplicate-reconcile"
  | "omniroute-v3.8.52.combos.item-update-reconcile"
  | "omniroute-v3.8.52.combos.item-delete-reconcile"
  | "omniroute-v3.8.52.combos.reorder-reconcile"
  | "omniroute-v3.8.52.combos.metrics-reset-reconcile";

export interface ComboRequestBinding {
  readonly methods: readonly AdminMethod[];
  readonly pathTemplate: string;
  readonly section: "body" | "query";
}

export interface ComboRelationBinding {
  readonly id: ComboSourceRelationViewId;
  readonly operationIds: readonly string[];
  readonly targetReadId: string;
  readonly reconcileId: string;
  readonly outcomeKind: "exists" | "absent" | "matches";
}

function requestBinding(methods: readonly AdminMethod[], pathTemplate: string, section: "body" | "query"): ComboRequestBinding {
  return Object.freeze({ methods: Object.freeze([...methods]), pathTemplate, section });
}

const REQUEST_BINDINGS: Readonly<Record<ComboSourceRequestValidatorId, ComboRequestBinding>> = Object.freeze({
  "omniroute-v3.8.52.combos.create": requestBinding(["POST"], "/api/combos", "body"),
  "omniroute-v3.8.52.combos.update": requestBinding(["PUT", "PATCH"], "/api/combos/{id}", "body"),
  "omniroute-v3.8.52.combos.duplicate": requestBinding(["POST"], "/api/combos/duplicate", "body"),
  "omniroute-v3.8.52.combos.reorder": requestBinding(["POST"], "/api/combos/reorder", "body"),
  "omniroute-v3.8.52.combos.test": requestBinding(["POST"], "/api/combos/test", "body"),
});

const NORMALIZATION_BINDINGS: Readonly<Record<ComboSourceNormalizationId, ComboRequestBinding>> = Object.freeze({
  ...REQUEST_BINDINGS,
  "omniroute-v3.8.52.combos.list-query": requestBinding(["GET"], "/api/combos", "query"),
  "omniroute-v3.8.52.combos.metrics-reset-query": requestBinding(["DELETE"], "/api/combos/metrics", "query"),
});

function relationBinding(binding: ComboRelationBinding): ComboRelationBinding {
  return Object.freeze({ ...binding, operationIds: Object.freeze([...binding.operationIds]) });
}

export const COMBO_RELATION_BINDINGS: Readonly<Record<ComboSourceRelationViewId, ComboRelationBinding>> = Object.freeze({
  "omniroute-v3.8.52.combos.create-reconcile": relationBinding({
    id: "omniroute-v3.8.52.combos.create-reconcile",
    operationIds: ["POST /api/combos"], targetReadId: "GET /api/combos",
    reconcileId: "GET /api/combos", outcomeKind: "exists",
  }),
  "omniroute-v3.8.52.combos.duplicate-reconcile": relationBinding({
    id: "omniroute-v3.8.52.combos.duplicate-reconcile",
    operationIds: ["POST /api/combos/duplicate"], targetReadId: "GET /api/combos",
    reconcileId: "GET /api/combos", outcomeKind: "exists",
  }),
  "omniroute-v3.8.52.combos.item-update-reconcile": relationBinding({
    id: "omniroute-v3.8.52.combos.item-update-reconcile",
    operationIds: ["PUT /api/combos/{id}", "PATCH /api/combos/{id}"],
    targetReadId: "GET /api/combos/{id}", reconcileId: "GET /api/combos/{id}", outcomeKind: "matches",
  }),
  "omniroute-v3.8.52.combos.item-delete-reconcile": relationBinding({
    id: "omniroute-v3.8.52.combos.item-delete-reconcile",
    operationIds: ["DELETE /api/combos/{id}"], targetReadId: "GET /api/combos",
    reconcileId: "GET /api/combos", outcomeKind: "absent",
  }),
  "omniroute-v3.8.52.combos.reorder-reconcile": relationBinding({
    id: "omniroute-v3.8.52.combos.reorder-reconcile",
    operationIds: ["POST /api/combos/reorder"], targetReadId: "GET /api/combos",
    reconcileId: "GET /api/combos", outcomeKind: "matches",
  }),
  "omniroute-v3.8.52.combos.metrics-reset-reconcile": relationBinding({
    id: "omniroute-v3.8.52.combos.metrics-reset-reconcile",
    operationIds: ["DELETE /api/combos/metrics"], targetReadId: "GET /api/combos/metrics",
    reconcileId: "GET /api/combos/metrics", outcomeKind: "absent",
  }),
});

export function isComboRequestValidatorId(value: unknown): value is ComboSourceRequestValidatorId {
  return typeof value === "string" && Object.hasOwn(REQUEST_BINDINGS, value);
}

export function isComboNormalizationId(value: unknown): value is ComboSourceNormalizationId {
  return typeof value === "string" && Object.hasOwn(NORMALIZATION_BINDINGS, value);
}

export function isComboRelationViewId(value: unknown): value is ComboSourceRelationViewId {
  return typeof value === "string" && Object.hasOwn(COMBO_RELATION_BINDINGS, value);
}



export function comboSourceValidatorBinding(id: unknown): ComboRequestBinding | undefined {
  return isComboRequestValidatorId(id) ? REQUEST_BINDINGS[id] : undefined;
}

export function comboSourceNormalizationBinding(id: unknown): ComboRequestBinding | undefined {
  return isComboNormalizationId(id) ? NORMALIZATION_BINDINGS[id] : undefined;
}

export function comboSourceRelationViewMatches(
  id: unknown,
  operationId: string,
  targetReadId: unknown,
  reconciliationId: unknown,
  outcomeKind: unknown,
): boolean {
  if (!isComboRelationViewId(id)) return false;
  const binding = COMBO_RELATION_BINDINGS[id];
  return binding.operationIds.includes(operationId)
    && binding.targetReadId === targetReadId
    && binding.reconcileId === reconciliationId
    && binding.outcomeKind === outcomeKind;
}

const STRATEGIES: Readonly<Record<string, true>> = Object.freeze({
  priority: true, weighted: true, "round-robin": true, "context-relay": true, "fill-first": true, p2c: true,
  random: true, "least-used": true, "cost-optimized": true, "reset-aware": true, "reset-window": true,
  headroom: true, "quota-weighted": true, "strict-random": true, auto: true, lkgp: true,
  "context-optimized": true, "cache-optimized": true, fusion: true, pipeline: true,
});
const COMPRESSION_MODES: Readonly<Record<string, true>> = Object.freeze({
  off: true, lite: true, standard: true, aggressive: true, ultra: true, rtk: true, stacked: true,
  "codex-responses": true, omniglyph: true,
});
const MODEL_FIELDS: Readonly<Record<string, true>> = Object.freeze({
  kind: true, provider: true, providerId: true, model: true, connectionId: true, allowedConnectionIds: true,
  tags: true, prompt: true, id: true, weight: true, label: true, fallbackOnlyOnQuotaExhaustion: true,
});
const REF_FIELDS: Readonly<Record<string, true>> = Object.freeze({
  kind: true, comboName: true, id: true, weight: true, label: true, fallbackOnlyOnQuotaExhaustion: true,
});
const CREATE_FIELDS: Readonly<Record<string, true>> = Object.freeze({
  name: true, description: true, displayName: true, models: true, strategy: true, config: true,
  allowedProviders: true, allowedModelFamilies: true, system_message: true, tool_filter_regex: true,
  context_cache_protection: true, context_length: true, dimensions: true,
});
const UPDATE_FIELDS: Readonly<Record<string, true>> = Object.freeze({
  ...CREATE_FIELDS, isActive: true, isHidden: true, overrideAllowedProviders: true, compressionOverride: true,
});
const CONFIG_COERCED_INTS: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  maxRetries: [0, 10], retryDelayMs: [0, 60_000], fallbackDelayMs: [0, 60_000], timeoutMs: [1_000, Number.MAX_SAFE_INTEGER],
  targetTimeoutMs: [0, 2_147_483_647], comboTimeoutMs: [0, 2_147_483_647], concurrencyPerModel: [1, 20],
  queueTimeoutMs: [1_000, 120_000], queueDepth: [0, 100], stickyRoundRobinLimit: [0, 1_000],
  stickyWeightedLimit: [0, 1_000], healthCheckTimeoutMs: [100, 30_000], maxMessagesForSummary: [5, 100],
  maxComboDepth: [1, 10], maxGlobalAttempts: [1, 200], maxSetRetries: [0, 10], setRetryDelayMs: [0, 60_000],
  hedgeDelayMs: [0, 60_000], fallbackCompressionThreshold: [0, 2_000_000], predictiveTtftMs: [0, 300_000],
  slaTargetP95Ms: [1, 300_000], resetAwareQuotaCacheTtlMs: [0, 300_000], resetAwareQuotaCacheMaxStaleMs: [0, 3_600_000],
  resetWindowTieBandMs: [0, 86_400_000], resetWindowQuotaCacheTtlMs: [0, 300_000],
  resetWindowQuotaCacheMaxStaleMs: [0, 3_600_000], connectionAwareExpansionMaxPerTarget: [1, 64],
});
const CONFIG_NUMBER_RANGES: Readonly<Record<string, readonly [number, number]>> = Object.freeze({
  handoffThreshold: [0.5, 0.94], budgetCap: [Number.MIN_VALUE, Number.MAX_VALUE], explorationRate: [0, 1],
  slaMaxErrorRate: [0, 1], slaMaxCostPer1MTokens: [Number.MIN_VALUE, 1_000_000],
  resetAwareSessionWeight: [0, 100], resetAwareWeeklyWeight: [0, 100], resetAwareTieBandPercent: [0, 100],
  resetAwareExhaustionGuardPercent: [0, 100], quotaWeightedFloorPercent: [0, 100],
});
const BOOLEAN_CONFIG_FIELDS: Readonly<Record<string, true>> = Object.freeze({
  disableSessionStickiness: true, healthCheckEnabled: true, trackMetrics: true, reasoningTokenBufferEnabled: true,
  failoverBeforeRetry: true, zeroLatencyOptimizationsEnabled: true, hedging: true, slaHardConstraints: true,
  resetWindowIncludeSession: true, connectionAwareExpansion: true,
});
const DEAD_COMBO_CONFIG_KEYS: Readonly<Record<string, true>> = Object.freeze({
  pipelineConcurrency: true, resetAwareEnabled: true, resetAwareWindow: true,
});

const CONFIG_COERCED_NUMBERS: Readonly<Record<string, true>> = Object.freeze({
  handoffThreshold: true, explorationRate: true, slaMaxErrorRate: true, slaMaxCostPer1MTokens: true,
  resetAwareSessionWeight: true, resetAwareWeeklyWeight: true, resetAwareTieBandPercent: true,
  resetAwareExhaustionGuardPercent: true, quotaWeightedFloorPercent: true,
});

const NESTED_CONFIG_COERCIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  sla: ["targetP95Ms", "maxErrorRate", "maxCostPer1MTokens"],
  shadowRouting: ["sampleRate", "maxTargets", "timeoutMs"],
  evalRouting: ["maxAgeHours", "minCases", "qualityWeight", "latencyWeight", "cacheTtlMs"],
  fusionTuning: ["minPanel", "stragglerGraceMs", "panelHardTimeoutMs", "maxPanel"],
  contextRequirements: ["minContextWindow", "maxContextWindow"],
});

function stripDeadConfig(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !Object.hasOwn(DEAD_COMBO_CONFIG_KEYS, key)));
}

function jsonObject(value: unknown): JsonObject | undefined {
  const normalized = json(value);
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized)) return undefined;
  const result: JsonObject = {};
  for (const [key, child] of Object.entries(normalized)) result[key] = json(child);
  return result;
}

function trimStringArray(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map(item => typeof item === "string" ? item.trim() : item);
}

function json(value: unknown, depth = 0): JsonValue {
  if (depth > 24) throw new TypeError("combo JSON depth exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => json(item, depth + 1));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, json(child, depth + 1)]));
  }
  throw new TypeError("combo value is not JSON");
}

function issue(field: string, reason: string): SourceRequestIssue {
  return { field, reason };
}

function trimmedString(value: unknown, field: string, min: number, max: number): SourceRequestIssue | undefined {
  if (typeof value !== "string") return issue(field, "must be a string");
  const parsed = value.trim();
  if (parsed.length < min) return issue(field, "is too short");
  if (parsed.length > max) return issue(field, "is too long");
  return undefined;
}

function validateName(value: unknown, field = "name"): SourceRequestIssue | undefined {
  if (typeof value !== "string") return issue(field, "must be a string");
  const error = trimmedString(value, field, 1, 100);
  if (error) return error;
  const name = value.trim();
  return /^[A-Za-z0-9_\/.\[\] -]+$/.test(name) ? undefined : issue(field, "contains unsupported characters");
}

function validateStep(value: unknown, field: string): SourceRequestIssue | undefined {
  if (typeof value === "string") return trimmedString(value, field, 1, 300);
  if (value === null || typeof value !== "object" || Array.isArray(value)) return issue(field, "must be a model, provider wildcard, or combo-reference object");
  const step = value as Record<string, unknown>;
  if (step.kind === "combo-ref") {
    const refError = trimmedString(step.comboName, `${field}.comboName`, 1, 100);
    if (refError) return refError;
  } else {
    const wildcard = step.kind === "provider-wildcard";
    if (step.kind !== undefined && step.kind !== "model" && !wildcard) return issue(`${field}.kind`, "must be model or provider-wildcard");
    const targetError = wildcard ? trimmedString(step.provider, `${field}.provider`, 1, 120) : trimmedString(step.model, `${field}.model`, 1, 300);
    if (targetError) return targetError;
    for (const key of ["provider", "providerId", "id", "label", "prompt"]) {
      if (step[key] !== undefined) {
        const limit = key === "prompt" ? 20_000 : key === "provider" || key === "providerId" ? 120 : 200;
        const error = trimmedString(step[key], `${field}.${key}`, 1, limit);
        if (error) return error;
      }
    }
    if (step.connectionId !== undefined && step.connectionId !== null) {
      const error = trimmedString(step.connectionId, `${field}.connectionId`, 1, 200);
      if (error) return error;
    }
    for (const key of ["allowedConnectionIds", "tags"] as const) {
      const rows = step[key];
      if (rows !== undefined) {
        const max = key === "tags" ? 20 : 50;
        if (!Array.isArray(rows) || rows.length > max) return issue(`${field}.${key}`, "has an invalid array length");
        for (let index = 0; index < rows.length; index += 1) {
          const error = trimmedString(rows[index], `${field}.${key}.${index}`, 1, key === "tags" ? 100 : 200);
          if (error) return error;
        }
      }
    }
    if (step.fallbackOnlyOnQuotaExhaustion !== undefined && typeof step.fallbackOnlyOnQuotaExhaustion !== "boolean") {
      return issue(`${field}.fallbackOnlyOnQuotaExhaustion`, "must be a boolean");
    }
  }
  if (step.id !== undefined) {
    const error = trimmedString(step.id, `${field}.id`, 1, 200);
    if (error) return error;
  }
  if (step.label !== undefined) {
    const error = trimmedString(step.label, `${field}.label`, 1, 200);
    if (error) return error;
  }
  if (step.weight !== undefined && (typeof step.weight !== "number" || !Number.isFinite(step.weight) || step.weight < 0 || step.weight > 100)) {
    return issue(`${field}.weight`, "must be between 0 and 100");
  }
  return undefined;
}

function validateModels(value: unknown): SourceRequestIssue | undefined {
  if (!Array.isArray(value) || value.length < 1) return issue("models", "a combo requires at least one model");
  for (let index = 0; index < value.length; index += 1) {
    const error = validateStep(value[index], `models.${index}`);
    if (error) return error;
  }
  return undefined;
}
function validateOptionalString(value: unknown, field: string, max: number, nullable = false, trim = false): SourceRequestIssue | undefined {
  if (value === undefined || (nullable && value === null)) return undefined;
  if (typeof value !== "string") return issue(field, "must be a string");
  return (trim ? value.trim() : value).length <= max ? undefined : issue(field, "is too long");
}

function validateOptionalStringArray(value: unknown, field: string, maxItems: number, maxLength: number, nullable = false): SourceRequestIssue | undefined {
  if (value === undefined || (nullable && value === null)) return undefined;
  if (!Array.isArray(value) || value.length > maxItems) return issue(field, "has an invalid array length");
  for (let index = 0; index < value.length; index += 1) {
    const invalid = trimmedString(value[index], `${field}.${index}`, 1, maxLength);
    if (invalid) return invalid;
  }
  return undefined;
}

function validateOptionalBoolean(value: unknown, field: string, nullable = false): SourceRequestIssue | undefined {
  return value === undefined || (nullable && value === null) || typeof value === "boolean"
    ? undefined
    : issue(field, "must be a boolean");
}

function validateOptionalContextLength(value: unknown, field: string, nullable = false): SourceRequestIssue | undefined {
  if (value === undefined || (nullable && value === null)) return undefined;
  return typeof value === "number" && Number.isInteger(value) && value >= 1000 && value <= 2_000_000
    ? undefined
    : issue(field, "is outside the source range");
}

function validateOptionalDimensions(value: unknown, field: string, nullable = false): SourceRequestIssue | undefined {
  if (value === undefined || (nullable && value === null)) return undefined;
  return typeof value === "string" && /^\d+$/.test(value)
    ? undefined
    : issue(field, "must be a positive integer string");
}


function validateConfig(value: unknown): SourceRequestIssue | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return issue("config", "must be an object");
  const config = value as Record<string, unknown>;
  for (const [key, [min, max]] of Object.entries(CONFIG_COERCED_INTS)) {
    if (config[key] === undefined) continue;
    const n = Number(config[key]);
    if (!Number.isInteger(n) || n < min || n > max) return issue(`config.${key}`, "is outside the source range");
  }
  for (const [key, [min, max]] of Object.entries(CONFIG_NUMBER_RANGES)) {
    if (config[key] === undefined) continue;
    const n = config[key];
    if (typeof n !== "number" || !Number.isFinite(n) || n < min || n > max) return issue(`config.${key}`, "is outside the source range");
  }
  for (const key of Object.keys(BOOLEAN_CONFIG_FIELDS)) {
    if (config[key] !== undefined && typeof config[key] !== "boolean") return issue(`config.${key}`, "must be a boolean");
  }
  if (config.compressionMode !== undefined && (typeof config.compressionMode !== "string" || !Object.hasOwn(COMPRESSION_MODES, config.compressionMode))) {
    return issue("config.compressionMode", "is not a supported compression mode");
  }
  if (config.nestedComboMode !== undefined && !["flatten", "execute"].includes(String(config.nestedComboMode))) {
    return issue("config.nestedComboMode", "is not a supported nested combo mode");
  }
  return undefined;
}

function validateBody(id: ComboSourceRequestValidatorId, value: unknown): SourceRequestIssue | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return issue("body", "must be an object");
  const body = value as Record<string, unknown>;
  if (id === "omniroute-v3.8.52.combos.duplicate") {
    const name = trimmedString(body.name, "name", 1, Number.MAX_SAFE_INTEGER);
    if (name) return name;
    return body.strategy === undefined || Object.hasOwn(STRATEGIES, String(body.strategy))
      ? undefined : issue("strategy", "is not a supported routing strategy");
  }
  if (id === "omniroute-v3.8.52.combos.reorder") {
    if (!Array.isArray(body.comboIds) || body.comboIds.length < 1 || body.comboIds.length > 1000) return issue("comboIds", "must contain 1 to 1000 combo IDs");
    const ids: string[] = [];
    for (let index = 0; index < body.comboIds.length; index += 1) {
      const item = body.comboIds[index];
      const error = trimmedString(item, `comboIds.${index}`, 1, 200);
      if (error) return error;
      if (typeof item !== "string") return issue(`comboIds.${index}`, "must be a string");
      ids.push(item.trim());
    }
    return new Set(ids).size === ids.length ? undefined : issue("comboIds", "must contain unique IDs");
  }
  if (id === "omniroute-v3.8.52.combos.test") {
    return trimmedString(body.comboName, "comboName", 1, Number.MAX_SAFE_INTEGER);
  }
  if (id === "omniroute-v3.8.52.combos.create") {
    const nameError = validateName(body.name);
    if (nameError) return nameError;
    const modelsError = validateModels(body.models);
    if (modelsError) return modelsError;
    if (body.strategy !== undefined && !Object.hasOwn(STRATEGIES, String(body.strategy))) return issue("strategy", "is not a supported routing strategy");
    if (body.config !== undefined) {
      const configError = validateConfig(body.config);
      if (configError) return configError;
    }
    for (const [field, max, trim] of [["description", 2000, false], ["displayName", 200, true], ["system_message", 50_000, false], ["tool_filter_regex", 1000, false]] as const) {
      const error = validateOptionalString(body[field], field, max, false, trim);
      if (error) return error;
    }
    for (const [field, maxItems, maxLength] of [["allowedProviders", 100, 200], ["allowedModelFamilies", 100, 100]] as const) {
      const error = validateOptionalStringArray(body[field], field, maxItems, maxLength);
      if (error) return error;
    }
    const cacheError = validateOptionalBoolean(body.context_cache_protection, "context_cache_protection");
    if (cacheError) return cacheError;
    const contextError = validateOptionalContextLength(body.context_length, "context_length");
    if (contextError) return contextError;
    const dimensionsError = validateOptionalDimensions(body.dimensions, "dimensions", true);
    if (dimensionsError) return dimensionsError;
    return undefined;
  }
  if (id === "omniroute-v3.8.52.combos.update") {
    const keys = Object.keys(body).filter(key => Object.hasOwn(UPDATE_FIELDS, key) && key !== "overrideAllowedProviders");
    if (keys.length === 0) return issue("body", "No valid fields to update");
    if (body.name !== undefined) {
      const nameError = validateName(body.name);
      if (nameError) return nameError;
    }
    if (body.models !== undefined) {
      const modelsError = validateModels(body.models);
      if (modelsError) return modelsError;
    }
    if (body.strategy !== undefined && !Object.hasOwn(STRATEGIES, String(body.strategy))) return issue("strategy", "is not a supported routing strategy");
    if (body.config !== undefined) {
      const configError = validateConfig(body.config);
      if (configError) return configError;
    }
    if (body.compressionOverride !== undefined && body.compressionOverride !== "" && !Object.hasOwn(COMPRESSION_MODES, String(body.compressionOverride))) {
      return issue("compressionOverride", "is not a supported compression mode");
    }
    for (const [field, max, trim] of [
      ["description", 2000, false], ["displayName", 200, true], ["system_message", 50_000, false], ["tool_filter_regex", 1000, false],
    ] as const) {
      const error = validateOptionalString(body[field], field, max, true, trim);
      if (error) return error;
    }
    for (const [field, maxItems, maxLength] of [["allowedProviders", 100, 200], ["allowedModelFamilies", 100, 100]] as const) {
      const error = validateOptionalStringArray(body[field], field, maxItems, maxLength, true);
      if (error) return error;
    }
    for (const field of ["isActive", "isHidden"] as const) {
      const error = validateOptionalBoolean(body[field], field);
      if (error) return error;
    }
    const cacheError = validateOptionalBoolean(body.context_cache_protection, "context_cache_protection", true);
    if (cacheError) return cacheError;
    const contextError = validateOptionalContextLength(body.context_length, "context_length", true);
    if (contextError) return contextError;
    const dimensionsError = validateOptionalDimensions(body.dimensions, "dimensions", true);
    if (dimensionsError) return dimensionsError;
    const overrideError = validateOptionalBoolean(body.overrideAllowedProviders, "overrideAllowedProviders");
    if (overrideError) return overrideError;
    return undefined;
  }
  return issue("body", "validator is not bound to a combo mutation");
}

export function validateComboRequest(id: ComboSourceRequestValidatorId, body: unknown): SourceRequestIssue | undefined {
  return validateBody(id, body);
}

function pickFields(source: Record<string, unknown>, allowed: Readonly<Record<string, true>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(source).filter(([key]) => Object.hasOwn(allowed, key)));
}

function normalizeStep(value: JsonValue): JsonValue {
  if (typeof value === "string") return value.trim();
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const step = value as Record<string, unknown>;
  const ref = step.kind === "combo-ref";
  const allowed = ref ? REF_FIELDS : MODEL_FIELDS;
  const result = pickFields(step, allowed);
  for (const key of ["id", "label", "provider", "providerId", "model", "comboName", "prompt"] as const) {
    const item = result[key];
    if (typeof item === "string") result[key] = item.trim();
  }
  if (typeof result.weight !== "number") result.weight = 0;
  for (const key of ["allowedConnectionIds", "tags"] as const) {
    const items = trimStringArray(result[key]);
    if (items !== undefined) result[key] = items;
  }
  return json(result);
}

function normalizeConfig(value: unknown): JsonValue | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const config = value as Record<string, unknown>;
  const result: Record<string, unknown> = stripDeadConfig(config);
  for (const key of Object.keys(CONFIG_COERCED_INTS)) {
    if (result[key] !== undefined) result[key] = Number(result[key]);
  }
  for (const key of Object.keys(CONFIG_COERCED_NUMBERS)) {
    if (result[key] !== undefined) result[key] = Number(result[key]);
  }
  for (const [field, keys] of Object.entries(NESTED_CONFIG_COERCIONS)) {
    const child = result[field];
    if (child === null || typeof child !== "object" || Array.isArray(child)) continue;
    const normalizedChild: Record<string, unknown> = { ...child };
    for (const key of keys) if (normalizedChild[key] !== undefined) normalizedChild[key] = Number(normalizedChild[key]);
    result[field] = normalizedChild;
  }
  if (result.zeroLatencyOptimizationsEnabled !== true
    && (result.hedging === true || (typeof result.predictiveTtftMs === "number" && result.predictiveTtftMs > 0)
      || (typeof result.fallbackCompressionMode === "string" && result.fallbackCompressionMode !== "off"))) {
    result.zeroLatencyOptimizationsEnabled = true;
  }
  return json(result);
}

function normalizedBody(id: ComboSourceRequestValidatorId, value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const body = value as Record<string, unknown>;
  if (id === "omniroute-v3.8.52.combos.create") {
    const result = pickFields(body, CREATE_FIELDS);
    if (typeof result.name === "string") result.name = result.name.trim();
    if (typeof result.displayName === "string") result.displayName = result.displayName.trim();
    if (Array.isArray(result.models)) result.models = result.models.map(item => normalizeStep(json(item)));
    if (result.strategy === undefined) result.strategy = "priority";
    const config = normalizeConfig(result.config);
    if (config !== undefined) result.config = config;
    for (const field of ["allowedProviders", "allowedModelFamilies"] as const) {
      const items = trimStringArray(result[field]);
      if (items !== undefined) result[field] = items;
    }
    return json(result);
  }
  if (id === "omniroute-v3.8.52.combos.update") {
    const result = pickFields(body, UPDATE_FIELDS);
    if (typeof result.name === "string") result.name = result.name.trim();
    if (typeof result.displayName === "string") result.displayName = result.displayName.trim();
    if (Array.isArray(result.models)) result.models = result.models.map(item => normalizeStep(json(item)));
    for (const field of ["allowedProviders", "allowedModelFamilies"] as const) {
      const items = trimStringArray(result[field]);
      if (items !== undefined) result[field] = items;
    }
    const config = normalizeConfig(result.config);
    if (config !== undefined) result.config = config;
    return json(result);
  }
  if (id === "omniroute-v3.8.52.combos.duplicate") {
    const result: Record<string, unknown> = { name: typeof body.name === "string" ? body.name.trim() : body.name };
    if (body.strategy !== undefined) result.strategy = body.strategy;
    return json(result);
  }
  if (id === "omniroute-v3.8.52.combos.reorder") {
    return json({ comboIds: Array.isArray(body.comboIds) ? body.comboIds.map(item => typeof item === "string" ? item.trim() : item) : body.comboIds });
  }
  if (id === "omniroute-v3.8.52.combos.test") {
    return json({ comboName: typeof body.comboName === "string" ? body.comboName.trim() : body.comboName });
  }
  return value;
}

export function normalizeComboRequest(id: ComboSourceNormalizationId, value: JsonValue): JsonValue {
  if (id === "omniroute-v3.8.52.combos.list-query") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const query = value as Record<string, JsonValue>;
    const normalized: Record<string, unknown> = {};
    for (const key of ["limit", "offset"] as const) {
      if (query[key] === undefined || query[key] === null || query[key] === "") continue;
      normalized[key] = typeof query[key] === "string" ? Number(query[key]) : query[key];
    }
    return json(normalized);
  }
  if (id === "omniroute-v3.8.52.combos.metrics-reset-query") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    const query = value as Record<string, JsonValue>;
    return json({ combo: typeof query.combo === "string" ? query.combo : "" });
  }
  return normalizedBody(id, value);
}

function rowsOfCombos(response: unknown): Record<string, unknown>[] {
  if (response === null || typeof response !== "object" || Array.isArray(response)) return [];
  const rows = (response as Record<string, unknown>).combos;
  if (!Array.isArray(rows)) return [];
  const result: Record<string, unknown>[] = [];
  for (const item of rows) {
    if (item !== null && typeof item === "object" && !Array.isArray(item)) result.push(item as Record<string, unknown>);
  }
  return result;
}

function stateOfCombo(row: Record<string, unknown>): JsonObject {
  const fields = [
    "name", "description", "displayName", "models", "strategy", "config", "isActive", "isHidden",
    "allowedProviders", "allowedModelFamilies", "system_message", "tool_filter_regex", "context_cache_protection",
    "context_length", "dimensions", "sortOrder", "version",
  ] as const;
  const state: JsonObject = {};
  for (const key of fields) state[key] = row[key] === undefined ? null : json(row[key]);
  return state;
}

function relationEntry(identity: JsonObject, state: JsonObject, absent = false): JsonObject {
  return { identity, state, ...(absent ? { absent: true } : {}) };
}

function relationDocument(kind: "resource" | "collection", entries: JsonObject[]): JsonValue {
  return { kind, entries };
}

function pathId(payload: ValidatedOperationInput): string | undefined {
  const value = payload.path.id;
  return typeof value === "string" ? value : undefined;
}

function queryCombo(payload: ValidatedOperationInput): string | undefined {
  const value = payload.query.combo;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function comboRelationSnapshot(
  id: ComboSourceRelationViewId,
  payload: ValidatedOperationInput,
  response: unknown,
): JsonValue {
  if (id === "omniroute-v3.8.52.combos.create-reconcile" || id === "omniroute-v3.8.52.combos.duplicate-reconcile") {
    const entries = rowsOfCombos(response).map(row => {
      if (typeof row.id !== "string") throw new TypeError("combo collection has an invalid identity");
      return relationEntry(
        { id: row.id },
        { name: typeof row.name === "string" ? row.name : "" },
      );
    });
    return relationDocument("collection", entries);
  }
  if (id === "omniroute-v3.8.52.combos.item-update-reconcile") {
    if (response === null || typeof response !== "object" || Array.isArray(response)) throw new TypeError("combo resource response is invalid");
    const row = response as Record<string, unknown>;
    if (typeof row.id !== "string") throw new TypeError("combo resource response is invalid");
    return relationDocument("resource", [relationEntry({ id: row.id }, stateOfCombo(row))]);
  }
  if (id === "omniroute-v3.8.52.combos.item-delete-reconcile") {
    const selected = pathId(payload);
    if (!selected) throw new TypeError("delete relation requires the exact combo path identity");
    const match = rowsOfCombos(response).find(row => row.id === selected);
    return relationDocument("resource", [match
      ? relationEntry({ id: selected }, { name: typeof match.name === "string" ? match.name : "" })
      : relationEntry({ id: selected }, {}, true)]);
  }
  if (id === "omniroute-v3.8.52.combos.reorder-reconcile") {
    const order = rowsOfCombos(response).map(row => {
      if (typeof row.id !== "string") throw new TypeError("combo order contains an invalid identity");
      return row.id;
    });
    return relationDocument("resource", [relationEntry({ scope: "all-combos" }, { order })]);
  }
  if (id !== "omniroute-v3.8.52.combos.metrics-reset-reconcile"
    || response === null || typeof response !== "object" || Array.isArray(response)) {
    throw new TypeError("combo relation view is not bound to the supplied operation");
  }
  const metrics = (response as Record<string, unknown>).metrics;
  const combo = queryCombo(payload);
  if (combo !== undefined) {
    if (metrics !== null && metrics !== undefined && (typeof metrics !== "object" || Array.isArray(metrics))) {
      throw new TypeError("combo metrics selection is invalid");
    }
    return relationDocument("collection", [relationEntry(
      { scope: "selected", comboName: combo },
      { metrics: metrics === null || metrics === undefined ? null : json(metrics) },
    )]);
  }
  if (metrics === null || metrics === undefined) throw new TypeError("all combo metrics map is missing");
  if (typeof metrics !== "object" || Array.isArray(metrics)) throw new TypeError("combo metrics map is invalid");
  return relationDocument("collection", [relationEntry({ scope: "all" }, { metrics: json(metrics) })]);
}

function parseRelationSnapshot(value: JsonValue): { kind: string; entries: Array<{ identity: JsonObject; state: JsonObject; absent?: boolean }> } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("combo relation snapshot is invalid");
  const root = value as Record<string, JsonValue>;
  if (!Array.isArray(root.entries)) throw new TypeError("combo relation snapshot is invalid");
  const entries: Array<{ identity: JsonObject; state: JsonObject; absent?: boolean }> = [];
  for (const entry of root.entries) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) throw new TypeError("combo relation entry is invalid");
    const item = entry as Record<string, JsonValue>;
    const identity = jsonObject(item.identity);
    const state = jsonObject(item.state);
    if (!identity || !state) throw new TypeError("combo relation entry is invalid");
    entries.push({ identity, state, ...(item.absent === true ? { absent: true } : {}) });
  }
  return { kind: String(root.kind), entries };
}

function normalizeStoredModels(value: unknown, comboName: string, existingNames: ReadonlySet<string>): JsonValue[] {
  if (!Array.isArray(value)) return [];
  const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "step";
  const stepId = (kind: "model" | "combo-ref" | "provider-wildcard", index: number, seed: string): string =>
    [slug(comboName || "combo"), kind === "combo-ref" ? "ref" : kind === "provider-wildcard" ? "wildcard" : "model", String(index + 1), slug(seed)].join("-").slice(0, 200);
  const comboReference = (name: string, index: number, weight = 0, explicitId?: string, label?: string): JsonObject => ({
    id: explicitId ?? stepId("combo-ref", index, name),
    kind: "combo-ref",
    comboName: name,
    weight,
    ...(label ? { label } : {}),
  });
  const normalized: JsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (typeof item === "string") {
      const target = item.trim();
      if (!target) continue;
      if (existingNames.has(target) || target === comboName) {
        normalized.push(comboReference(target, index));
        continue;
      }
      const slash = target.indexOf("/");
      const provider = slash > 0 ? target.slice(0, slash).trim() : undefined;
      const modelPattern = slash > 0 ? target.slice(slash + 1).trim() : "";
      if (provider && modelPattern.includes("*")) {
        normalized.push({
          id: stepId("provider-wildcard", index, `${provider}/${modelPattern}`),
          kind: "provider-wildcard",
          providerId: provider,
          modelPattern,
          weight: 0,
        });
        continue;
      }
      normalized.push({
        id: stepId("model", index, target),
        kind: "model",
        model: target,
        ...(provider ? { providerId: provider } : {}),
        weight: 0,
      });
      continue;
    }
    if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
    const raw = item as Record<string, unknown>;
    const explicitId = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
    const weight = typeof raw.weight === "number" && Number.isFinite(raw.weight) ? Math.max(0, Math.min(100, raw.weight)) : 0;
    const label = typeof raw.label === "string" && raw.label.trim() ? raw.label.trim() : undefined;
    const fallbackOnlyOnQuotaExhaustion = raw.fallbackOnlyOnQuotaExhaustion === true;
    if (raw.kind === "combo-ref" && typeof raw.comboName === "string" && raw.comboName.trim()) {
      normalized.push({
        ...comboReference(raw.comboName.trim(), index, weight, explicitId, label),
        ...(fallbackOnlyOnQuotaExhaustion ? { fallbackOnlyOnQuotaExhaustion: true } : {}),
      });
      continue;
    }
    if (raw.kind === "provider-wildcard") {
      const providerId = typeof raw.providerId === "string" ? raw.providerId.trim()
        : typeof raw.provider === "string" ? raw.provider.trim() : "";
      if (!providerId) continue;
      const modelPattern = typeof raw.modelPattern === "string" && raw.modelPattern.trim() ? raw.modelPattern.trim() : "*";
      const connectionId = raw.connectionId === null
        ? null
        : typeof raw.connectionId === "string" && raw.connectionId.trim() ? raw.connectionId.trim() : undefined;
      const allowedConnectionIds = trimStringArray(raw.allowedConnectionIds)?.filter((id): id is string => typeof id === "string" && id.length > 0);
      const seed = connectionId ? `${providerId}/${modelPattern}:${connectionId}` : `${providerId}/${modelPattern}`;
      normalized.push({
        id: explicitId ?? stepId("provider-wildcard", index, seed),
        kind: "provider-wildcard",
        providerId,
        modelPattern,
        ...(connectionId !== undefined ? { connectionId } : {}),
        weight,
        ...(label ? { label } : {}),
        ...(allowedConnectionIds?.length ? { allowedConnectionIds } : {}),
      });
      continue;
    }
    if (typeof raw.model !== "string" || !raw.model.trim()) continue;
    const modelValue = raw.model.trim();
    const provider = typeof raw.providerId === "string" && raw.providerId.trim()
      ? raw.providerId.trim()
      : typeof raw.provider === "string" && raw.provider.trim()
        ? raw.provider.trim()
        : modelValue.includes("/") ? modelValue.slice(0, modelValue.indexOf("/")).trim() : undefined;
    const explicitModel = raw.kind === "model";
    if (!explicitModel && !provider && (existingNames.has(modelValue) || modelValue === comboName)) {
      normalized.push(comboReference(modelValue, index, weight, explicitId, label));
      continue;
    }
    const slash = modelValue.indexOf("/");
    const modelProvider = slash > 0 ? modelValue.slice(0, slash).trim() : provider;
    const modelPattern = slash > 0 ? modelValue.slice(slash + 1).trim() : "";
    if (modelProvider && modelPattern.includes("*")) {
      const connectionId = raw.connectionId === null
        ? null
        : typeof raw.connectionId === "string" && raw.connectionId.trim() ? raw.connectionId.trim() : undefined;
      const allowedConnectionIds = trimStringArray(raw.allowedConnectionIds)?.filter((id): id is string => typeof id === "string" && id.length > 0);
      const seed = connectionId ? `${modelProvider}/${modelPattern}:${connectionId}` : `${modelProvider}/${modelPattern}`;
      normalized.push({
        id: explicitId ?? stepId("provider-wildcard", index, seed),
        kind: "provider-wildcard",
        providerId: modelProvider,
        modelPattern,
        ...(connectionId !== undefined ? { connectionId } : {}),
        weight,
        ...(label ? { label } : {}),
        ...(allowedConnectionIds?.length ? { allowedConnectionIds } : {}),
      });
      continue;
    }
    const model = modelValue.includes("/") || !provider ? modelValue : `${provider}/${modelValue}`;
    const connectionId = raw.connectionId === null
      ? null
      : typeof raw.connectionId === "string" && raw.connectionId.trim() ? raw.connectionId.trim() : undefined;
    const seed = connectionId ? `${model}:${connectionId}` : model;
    const tags = trimStringArray(raw.tags)?.filter((tag): tag is string => typeof tag === "string" && tag.length > 0);
    const allowedConnectionIds = trimStringArray(raw.allowedConnectionIds)?.filter((id): id is string => typeof id === "string" && id.length > 0);
    normalized.push({
      id: explicitId ?? stepId("model", index, seed),
      kind: "model",
      model,
      ...(provider ? { providerId: provider } : {}),
      ...(connectionId !== undefined ? { connectionId } : {}),
      weight,
      ...(label ? { label } : {}),
      ...(typeof raw.prompt === "string" && raw.prompt.trim() ? { prompt: raw.prompt.trim() } : {}),
      ...(tags?.length ? { tags } : {}),
      ...(allowedConnectionIds?.length ? { allowedConnectionIds } : {}),
      ...(fallbackOnlyOnQuotaExhaustion ? { fallbackOnlyOnQuotaExhaustion: true } : {}),
    });
  }
  return normalized;
}

export function normalizeComboModelsForSource(
  value: unknown,
  comboName: string,
  existingComboNames: readonly string[],
): JsonValue[] {
  return normalizeStoredModels(value, comboName, new Set(existingComboNames));
}

function normalizeUpdateState(body: Record<string, unknown>, prior: Record<string, JsonValue>, comboName: string): Record<string, JsonValue> {
  const merged: Record<string, JsonValue> = { ...prior };
  for (const [key, value] of Object.entries(body)) {
    if (value === null) delete merged[key];
    else merged[key] = json(value);
  }
  if (typeof body.compressionOverride === "string") {
    const priorConfig = prior.config;
    const nextConfig: Record<string, unknown> = priorConfig !== null && typeof priorConfig === "object" && !Array.isArray(priorConfig)
      ? { ...priorConfig }
      : {};
    if (body.compressionOverride) nextConfig.compressionMode = body.compressionOverride;
    else delete nextConfig.compressionMode;
    merged.config = json(stripDeadConfig(nextConfig));
    delete merged.compressionOverride;
  }
  if (body.overrideAllowedProviders === true) {
    delete merged.overrideAllowedProviders;
    const currentProviders = Array.isArray(prior.allowedProviders) ? prior.allowedProviders : [];
    if (Array.isArray(body.models) && body.allowedProviders === undefined && currentProviders.length > 0) {
      const stepProviders: string[] = [];
      for (const item of body.models) {
        if (item === null || typeof item !== "object" || Array.isArray(item)) continue;
        const step = item as Record<string, unknown>;
        if (step.kind === "combo-ref") continue;
        if (typeof step.providerId === "string" && step.providerId.trim()) {
          stepProviders.push(step.providerId.trim());
        } else if (typeof step.provider === "string" && step.provider.trim()) {
          stepProviders.push(step.provider.trim());
        } else if (typeof step.model === "string" && step.model.includes("/")) {
          throw new TypeError("provider allowlist expansion requires canonical provider resolution");
        }
      }
      if (currentProviders.some(provider => typeof provider !== "string")) {
        throw new TypeError("stored combo provider allowlist is invalid");
      }
      merged.allowedProviders = json([...new Set([...currentProviders as string[], ...stepProviders])]);
    }
  }
  if (typeof body.name === "string") merged.name = body.name.trim();
  if (Array.isArray(body.models)) {
    const priorName = typeof prior.name === "string" ? prior.name : "";
    for (const item of body.models) {
      if (typeof item === "string" && item.trim() !== priorName && item.trim() !== comboName) {
        throw new TypeError("combo-reference normalization requires the pinned combo collection");
      }
      if (item !== null && typeof item === "object" && !Array.isArray(item)) {
        const step = item as Record<string, unknown>;
        const modelName = typeof step.model === "string" ? step.model.trim() : "";
        if (step.kind !== "model" && step.kind !== "combo-ref"
          && typeof step.providerId !== "string" && typeof step.provider !== "string"
          && modelName && !modelName.includes("/") && modelName !== priorName && modelName !== comboName) {
          throw new TypeError("combo-reference normalization requires the pinned combo collection");
        }
      }
    }
    merged.models = normalizeStoredModels(body.models, comboName, new Set(priorName ? [priorName] : []));
  }
  if (body.config !== undefined && body.config !== null && body.compressionOverride === undefined) {
    const config = normalizeConfig(body.config);
    if (config !== undefined) merged.config = config;
  }
  for (const key of [
    "name", "description", "displayName", "models", "strategy", "config", "isActive", "isHidden",
    "allowedProviders", "allowedModelFamilies", "system_message", "tool_filter_regex",
    "context_cache_protection", "context_length", "dimensions", "sortOrder", "version",
  ]) {
    if (!Object.hasOwn(merged, key)) merged[key] = null;
  }
  return merged;
}

export function comboRelationExpectedPayload(
  id: ComboSourceRelationViewId,
  payload: ValidatedOperationInput,
  originalSnapshot: JsonValue,
): ValidatedOperationInput {
  const bodyValue = payload.body;
  const body = bodyValue !== undefined && bodyValue !== null && typeof bodyValue === "object" && !Array.isArray(bodyValue)
    ? bodyValue as Record<string, unknown>
    : {};
  const before = parseRelationSnapshot(originalSnapshot);
  if (id === "omniroute-v3.8.52.combos.duplicate-reconcile") {
    const template = typeof body.name === "string" ? body.name : "";
    const baseName = `static-${template.replace("auto/", "")}`;
    const names = new Set(before.entries.map(entry => entry.state.name).filter((value): value is string => typeof value === "string"));
    let expectedName = baseName;
    let suffix = 1;
    while (names.has(expectedName)) {
      suffix += 1;
      expectedName = `${baseName} ${suffix}`;
    }
    return { ...payload, body: { ...body, name: expectedName } };
  }
  if (id === "omniroute-v3.8.52.combos.reorder-reconcile") {
    const priorOrder = before.entries[0]?.state.order;
    const inputOrder = body.comboIds;
    if (!Array.isArray(priorOrder) || !Array.isArray(inputOrder)) throw new TypeError("reorder relation requires observed prior and requested order");
    const existing = new Set(priorOrder.filter((value): value is string => typeof value === "string"));
    const seen = new Set<string>();
    const requested = inputOrder.filter((value): value is string => typeof value === "string" && existing.has(value) && !seen.has(value) && Boolean(seen.add(value)));
    const finalOrder = [...requested, ...priorOrder.filter((value): value is string => typeof value === "string" && !seen.has(value))];
    return { ...payload, body: { ...body, comboIds: finalOrder } };
  }
  if (id === "omniroute-v3.8.52.combos.item-update-reconcile") {
    const prior = before.entries[0]?.state;
    if (!prior) throw new TypeError("update relation is missing its pre-state");
    const merged = normalizeUpdateState(body, prior, typeof body.name === "string" ? body.name : String(prior.name ?? ""));
    return { ...payload, body: merged };
  }
  return payload;
}

export function comboRelationSnapshotIsJson(value: unknown): value is JsonValue {
  try {
    json(value);
    return true;
  } catch {
    return false;
  }
}

export type ComboRelationSnapshot = JsonValue;
export type ComboRequestJson = JsonValue;
export type ComboProjectionObject = JsonObject;
