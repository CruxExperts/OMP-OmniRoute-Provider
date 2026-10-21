import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { invokeJsonAdapter } from "../../src/admin/adapters.ts";
import { requiredOmaScope } from "../../src/admin/authorization-policy.ts";
import { canonicalizeJson, getOperation, type JsonSchema, type OperationAdapter, type OperationDescriptor, type OperationResponseVariant } from "../../src/admin/registry.ts";
import type { JsonObject, JsonValue } from "../../src/admin/types.ts";
import { fixtureRegistry } from "./admin-qualification.fixture.ts";
import {
  COMBO_OPERATION_IDS,
  comboRelationSnapshot, comboRelationExpectedPayload, comboSourceRelationViewMatches,
  type ComboSourceRequestValidatorId, type ComboSourceRelationViewId,
} from "../../src/admin/source-combos.ts";
import { createPinnedComboHandlers, createPinnedSqliteComboStore, type PinnedComboStoreRuntime } from "./pinned-combo-handlers.fixture.ts";
import { createPinnedFixtureDate } from "./pinned-handler.fixture.ts";
import type { PinnedManagementAuthorization, PinnedExports } from "./pinned-handler.fixture.ts";

export { COMBO_OPERATION_IDS };

export const COMBO_ROUTE = "/api/combos";
export const COMBO_ROUTE_SOURCE_FILES = [
  "src/app/api/combos/route.ts", "src/app/api/combos/[id]/route.ts", "src/app/api/combos/auto/route.ts",
  "src/app/api/combos/builder/options/route.ts", "src/app/api/combos/metrics/route.ts",
  "src/app/api/combos/duplicate/route.ts", "src/app/api/combos/reorder/route.ts", "src/app/api/combos/test/route.ts",
] as const;
export const COMBO_AUTH_SOURCE_FILES = [
  "src/proxy.ts", "src/server/authz/classify.ts", "src/server/authz/pipeline.ts", "src/server/authz/policies/management.ts",
  "src/server/authz/accessScopes.ts", "src/server/authz/headers.ts", "src/server/authz/routeGuard.ts",
  "src/lib/api/requireManagementAuth.ts", "src/shared/constants/managementScopes.ts", "src/shared/utils/apiAuth.ts",
] as const;
export const COMBO_TEST_ID = "test/admin-combos.test.ts";

const jsonObject = (properties: Record<string, JsonSchema>, required: readonly string[] = []): JsonSchema => ({ type: "object", properties, required, additionalProperties: false });
const str = (maxLength = 200) => ({ type: "string", minLength: 1, maxLength }) satisfies JsonSchema;
const nullableString = (maxLength = 200) => ({ oneOf: [{ type: "string", maxLength }, { type: "null" }] }) satisfies JsonSchema;
const COMBO_STEP_SCHEMA: JsonSchema = { oneOf: [
  { type: "string", minLength: 1, maxLength: 300 },
  jsonObject({ kind: { const: "model" }, model: str(300), provider: str(120), providerId: str(120), connectionId: nullableString(200),
    allowedConnectionIds: { type: "array", maxItems: 50, items: str(200) }, tags: { type: "array", maxItems: 20, items: str(100) },
    id: str(200), weight: { type: "number", minimum: 0, maximum: 100 }, label: str(200), prompt: str(20_000), fallbackOnlyOnQuotaExhaustion: { type: "boolean" } }, ["model"]),
  jsonObject({ kind: { const: "combo-ref" }, comboName: str(100), id: str(200), weight: { type: "number", minimum: 0, maximum: 100 },
    label: str(200), fallbackOnlyOnQuotaExhaustion: { type: "boolean" } }, ["kind", "comboName"]),
  jsonObject({ kind: { const: "provider-wildcard" }, provider: str(120), id: str(200), weight: { type: "number", minimum: 0, maximum: 100 },
    label: str(200), fallbackOnlyOnQuotaExhaustion: { type: "boolean" } }, ["kind", "provider"]),
] };
const integer = (minimum: number, maximum?: number): JsonSchema => ({ type: "integer", minimum, ...(maximum === undefined ? {} : { maximum }) });
const number = (minimum?: number, maximum?: number): JsonSchema => ({ type: "number", ...(minimum === undefined ? {} : { minimum }), ...(maximum === undefined ? {} : { maximum }) });
const stringArray = (maxItems = 100, maxLength = 200): JsonSchema => ({ type: "array", maxItems, items: str(maxLength) });
const COMPRESSION_ENUM = ["off", "lite", "standard", "aggressive", "ultra", "rtk", "stacked", "codex-responses", "omniglyph"];
const STRATEGY_ENUM = ["priority", "weighted", "round-robin", "context-relay", "fill-first", "p2c", "random", "least-used", "cost-optimized",
  "reset-aware", "reset-window", "headroom", "quota-weighted", "strict-random", "auto", "lkgp", "context-optimized", "cache-optimized", "fusion", "pipeline"];
const COMBO_CONFIG_PROPERTIES: Record<string, JsonSchema> = {
  responseValidation: jsonObject({ forbiddenSubstrings: stringArray(50, 500), requiredSubstrings: stringArray(50, 500), minContentLength: integer(0, 1_000_000),
    jsonPathPredicates: { type: "array", maxItems: 20, items: jsonObject({ path: str(300), condition: { type: "string", enum: ["exists", "nonEmpty", "equals", "notEquals"] },
      value: { oneOf: [str(1000), { type: "number" }, { type: "boolean" }] }, }, ["path", "condition"]) } }),
  strategy: { type: "string", enum: STRATEGY_ENUM },
  maxRetries: integer(0, 10), retryDelayMs: integer(0, 60_000), fallbackDelayMs: integer(0, 60_000), timeoutMs: integer(1_000),
  targetTimeoutMs: integer(0, 2_147_483_647), comboTimeoutMs: integer(0, 2_147_483_647), concurrencyPerModel: integer(1, 20),
  queueTimeoutMs: integer(1_000, 120_000), queueDepth: integer(0, 100), stickyRoundRobinLimit: integer(0, 1_000),
  disableSessionStickiness: { type: "boolean" }, stickyWeightedLimit: integer(0, 1_000), healthCheckEnabled: { type: "boolean" },
  healthCheckTimeoutMs: integer(100, 30_000), handoffThreshold: number(0.5, 0.94), handoffModel: { type: "string", maxLength: 200 },
  handoffProviders: stringArray(10, 100), maxMessagesForSummary: integer(5, 100), maxComboDepth: integer(1, 10),
  maxGlobalAttempts: integer(1, 200), nestedComboMode: { type: "string", enum: ["flatten", "execute"] }, trackMetrics: { type: "boolean" },
  reasoningTokenBufferEnabled: { type: "boolean" }, reasoningTransportFallback: { type: "string", enum: ["skip", "drop"] },
  compressionMode: { type: "string", enum: COMPRESSION_ENUM }, failoverBeforeRetry: { type: "boolean" },
  maxSetRetries: integer(0, 10), setRetryDelayMs: integer(0, 60_000), zeroLatencyOptimizationsEnabled: { type: "boolean" },
  hedging: { type: "boolean" }, hedgeDelayMs: integer(0, 60_000), fallbackCompressionMode: { type: "string", enum: COMPRESSION_ENUM },
  fallbackCompressionThreshold: integer(0, 2_000_000), predictiveTtftMs: integer(0, 300_000),
  relayMode: { type: "string", enum: ["schema-locked", "standard"] }, candidatePool: { type: "array", items: { type: "string", minLength: 1 } },
  weights: jsonObject({ quota: number(0, 1), health: number(0, 1), costInv: number(0, 1), latencyInv: number(0, 1), taskFit: number(0, 1),
    stability: number(0, 1), tierPriority: number(0, 1), tierAffinity: number(0, 1), specificityMatch: number(0, 1), contextAffinity: number(0, 1),
    cacheAffinity: number(0, 1), sessionAvailability: number(0, 1), resetWindowAffinity: number(0, 1), connectionDensity: number(0, 1),
    quality: number(0, 1), reliability: number(0, 1) }, ["quota", "health", "costInv", "latencyInv", "taskFit", "stability"]),
  modePack: { type: "string", maxLength: 100 }, budgetCap: number(Number.MIN_VALUE), explorationRate: number(0, 1), routerStrategy: { type: "string" },
  slaTargetP95Ms: integer(1, 300_000), slaMaxErrorRate: number(0, 1), slaMaxCostPer1MTokens: number(Number.MIN_VALUE, 1_000_000),
  slaHardConstraints: { type: "boolean" }, sla: jsonObject({ targetP95Ms: integer(1, 300_000), maxErrorRate: number(0, 1), maxCostPer1MTokens: number(Number.MIN_VALUE, 1_000_000), hardConstraints: { type: "boolean" } }),
  compositeTiers: jsonObject({ defaultTier: str(100), tiers: { type: "object", "x-key-role": "identifier", additionalProperties: jsonObject({ stepId: str(200), fallbackTier: str(100),
    label: str(200), description: str(500) }, ["stepId"]) } }, ["defaultTier", "tiers"]),
  resetAwareSessionWeight: number(0, 100), resetAwareWeeklyWeight: number(0, 100), resetAwareTieBandPercent: number(0, 100),
  resetAwareExhaustionGuardPercent: number(0, 100), quotaWeightedFloorPercent: number(0, 100),
  resetAwareQuotaCacheTtlMs: integer(0, 300_000), resetAwareQuotaCacheMaxStaleMs: integer(0, 3_600_000),
  resetWindowWindows: { type: "array", items: { type: "string", enum: ["weekly", "session", "monthly"] } }, resetWindowIncludeSession: { type: "boolean" },
  resetWindowTieBandMs: integer(0, 86_400_000), resetWindowQuotaCacheTtlMs: integer(0, 300_000), resetWindowQuotaCacheMaxStaleMs: integer(0, 3_600_000),
  connectionAwareExpansion: { type: "boolean" }, connectionAwareExpansionMaxPerTarget: integer(1, 64),
  shadowRouting: jsonObject({ enabled: { type: "boolean" }, targets: { type: "array", maxItems: 20, items: COMBO_STEP_SCHEMA },
    sampleRate: number(0, 1), maxTargets: integer(1, 10), timeoutMs: integer(1_000, 120_000) }),
  evalRouting: jsonObject({ enabled: { type: "boolean" }, suiteIds: stringArray(50, 200), maxAgeHours: number(1, 8760), minCases: integer(1, 100_000),
    qualityWeight: number(0, 1), latencyWeight: number(0, 1), cacheTtlMs: integer(1_000, 300_000) }),
  judgeModel: { type: "string", maxLength: 200 }, fusionTuning: jsonObject({ minPanel: integer(1, 50), stragglerGraceMs: integer(0, 120_000),
    panelHardTimeoutMs: integer(1_000, 600_000), maxPanel: integer(1, 200) }),
  agenticOrchestration: jsonObject({ enabled: { type: "boolean" }, maxToolRounds: integer(1, 32) }),
  contextRequirements: jsonObject({ minContextWindow: integer(0, 10_000_000), maxContextWindow: integer(0, 10_000_000),
    preferLargeContext: { type: "boolean" }, contextFilterMode: { type: "string", enum: ["strict", "lenient"] } }),
  sourceAutoCombo: { type: "string", maxLength: 200 }, weightPack: jsonObject({ quota: number(0, 1), health: number(0, 1), costInv: number(0, 1), latencyInv: number(0, 1),
    taskFit: number(0, 1), stability: number(0, 1), tierPriority: number(0, 1), tierAffinity: number(0, 1), specificityMatch: number(0, 1),
    contextAffinity: number(0, 1), cacheAffinity: number(0, 1), sessionAvailability: number(0, 1), resetWindowAffinity: number(0, 1),
    connectionDensity: number(0, 1), quality: number(0, 1), reliability: number(0, 1) }, ["quota", "health", "costInv", "latencyInv", "taskFit", "stability"]),
  modelSort: { type: "object", properties: { method: { type: "string", enum: ["manual", "provider", "score", "name"] } }, required: ["method"], additionalProperties: true },
};
const COMBO_CONFIG_SCHEMA: JsonSchema = jsonObject(COMBO_CONFIG_PROPERTIES);
const COMBO_CONFIG_INPUT_SCHEMA: JsonSchema = { ...COMBO_CONFIG_SCHEMA, additionalProperties: true };
const COMBO_FIELDS: Record<string, JsonSchema> = {
  id: str(), name: str(100), description: nullableString(2000), displayName: nullableString(200), models: { type: "array", minItems: 1, maxItems: 1000, items: COMBO_STEP_SCHEMA },
  strategy: { type: "string", enum: STRATEGY_ENUM }, config: COMBO_CONFIG_SCHEMA, isActive: { type: "boolean" }, isHidden: { type: "boolean" }, allowedProviders: { oneOf: [stringArray(100, 200), { type: "null" }] },
  allowedModelFamilies: { oneOf: [stringArray(100, 100), { type: "null" }] }, system_message: nullableString(50_000), tool_filter_regex: nullableString(1000),
  context_cache_protection: { oneOf: [{ type: "boolean" }, { type: "null" }] }, context_length: { oneOf: [integer(1000, 2_000_000), { type: "null" }] },
  dimensions: { oneOf: [{ type: "string", pattern: "^[0-9]+$" }, { type: "null" }] }, sortOrder: integer(0), version: integer(1), computed_context_length: integer(0),
  createdAt: { type: "string", format: "date-time" }, updatedAt: { type: "string", format: "date-time" },
  warning: jsonObject({ code: { const: "COMBO_NAME_SHADOWS_MODEL" }, modelId: str(300), providerId: str(200) }, ["code", "modelId", "providerId"]),
};
const COMBO_CREATE_INPUT_FIELDS: Record<string, JsonSchema> = {
  name: { ...str(100), pattern: "^[a-zA-Z0-9_/.\\[\\] -]+$" }, description: { type: "string", maxLength: 2000 },
  displayName: { type: "string", maxLength: 200 }, models: { type: "array", minItems: 1, maxItems: 1000, items: COMBO_STEP_SCHEMA },
  strategy: { type: "string", enum: STRATEGY_ENUM, default: "priority" }, config: COMBO_CONFIG_INPUT_SCHEMA,
  allowedProviders: stringArray(100, 200), allowedModelFamilies: stringArray(100, 100), system_message: { type: "string", maxLength: 50_000 },
  tool_filter_regex: { type: "string", maxLength: 1000 }, context_cache_protection: { type: "boolean" }, context_length: integer(1000, 2_000_000),
  dimensions: { oneOf: [{ type: "string", pattern: "^[0-9]+$" }, { type: "null" }] },
};
const COMBO_UPDATE_INPUT_FIELDS: Record<string, JsonSchema> = {
  name: { ...str(100), pattern: "^[a-zA-Z0-9_/.\\[\\] -]+$" }, description: nullableString(2000), displayName: nullableString(200),
  models: { type: "array", minItems: 1, maxItems: 1000, items: COMBO_STEP_SCHEMA }, strategy: { type: "string", enum: STRATEGY_ENUM },
  config: COMBO_CONFIG_INPUT_SCHEMA, isActive: { type: "boolean" }, isHidden: { type: "boolean" },
  allowedProviders: { oneOf: [stringArray(100, 200), { type: "null" }] }, allowedModelFamilies: { oneOf: [stringArray(100, 100), { type: "null" }] },
  overrideAllowedProviders: { type: "boolean" }, system_message: nullableString(50_000), tool_filter_regex: nullableString(1000),
  context_cache_protection: { oneOf: [{ type: "boolean" }, { type: "null" }] }, context_length: { oneOf: [integer(1000, 2_000_000), { type: "null" }] },
  compressionOverride: { type: "string", enum: ["", ...COMPRESSION_ENUM] },
  dimensions: { oneOf: [{ type: "string", pattern: "^[0-9]+$" }, { type: "null" }] },
};
const COMBO_SCHEMA = jsonObject(COMBO_FIELDS, ["id", "name"]);
const LIST_SCHEMA = jsonObject({ combos: { type: "array", items: COMBO_SCHEMA }, total: { type: "integer", minimum: 0 } }, ["combos", "total"]);
const MODEL_METRIC_VIEW_SCHEMA = jsonObject({ requests: number(0), successes: number(0), failures: number(0), totalLatencyMs: number(0),
  lastStatus: { oneOf: [{ type: "string", enum: ["ok", "error"] }, { type: "null" }] }, lastUsedAt: nullableString(),
  avgLatencyMs: number(0), successRate: number(0) }, ["requests", "successes", "failures", "totalLatencyMs", "lastStatus", "lastUsedAt", "avgLatencyMs", "successRate"]);
const TARGET_METRIC_VIEW_SCHEMA = jsonObject({ ...((MODEL_METRIC_VIEW_SCHEMA as { properties: Record<string, JsonSchema> }).properties),
  executionKey: str(), stepId: nullableString(), model: str(300), provider: nullableString(), providerId: nullableString(), connectionId: nullableString(), label: nullableString() },
  ["requests", "successes", "failures", "totalLatencyMs", "lastStatus", "lastUsedAt", "avgLatencyMs", "successRate", "executionKey", "stepId", "model", "provider", "providerId", "connectionId", "label"]);
const modelMetricMap = { type: "object", "x-key-role": "identifier", additionalProperties: MODEL_METRIC_VIEW_SCHEMA } satisfies JsonSchema;
const targetMetricMap = { type: "object", "x-key-role": "identifier", additionalProperties: TARGET_METRIC_VIEW_SCHEMA } satisfies JsonSchema;
const COMBO_METRICS_VIEW_SCHEMA = jsonObject({ totalRequests: number(0), totalSuccesses: number(0), totalFailures: number(0), totalFallbacks: number(0),
  totalLatencyMs: number(0), strategy: { type: "string" }, lastUsedAt: nullableString(), intentCounts: { type: "object", "x-key-role": "identifier", additionalProperties: number(0) },
  byModel: modelMetricMap, byTarget: targetMetricMap, productionTraffic: { type: "boolean" }, avgLatencyMs: number(0), successRate: number(0), fallbackRate: number(0),
  persistedSkipBypassed: number(0), shadow: jsonObject({ totalRequests: number(0), totalSuccesses: number(0), totalFailures: number(0), totalLatencyMs: number(0),
    lastUsedAt: nullableString(), byModel: modelMetricMap, byTarget: targetMetricMap, avgLatencyMs: number(0), successRate: number(0) },
    ["totalRequests", "totalSuccesses", "totalFailures", "totalLatencyMs", "lastUsedAt", "byModel", "byTarget", "avgLatencyMs", "successRate"]) },
  ["totalRequests", "totalSuccesses", "totalFailures", "totalFallbacks", "totalLatencyMs", "strategy", "lastUsedAt", "intentCounts", "byModel", "byTarget", "productionTraffic", "avgLatencyMs", "successRate", "fallbackRate", "persistedSkipBypassed", "shadow"]);
const comboMetricMap = { type: "object", "x-key-role": "identifier", additionalProperties: { oneOf: [COMBO_METRICS_VIEW_SCHEMA, { type: "null" }] } } satisfies JsonSchema;
const METRICS_SCHEMA: JsonSchema = jsonObject({ metrics: { oneOf: [{ type: "null" }, COMBO_METRICS_VIEW_SCHEMA, comboMetricMap] },
  message: { type: "string", maxLength: 200 } }, ["metrics"]);
const AUTO_CONFIG_SCHEMA: JsonSchema = { type: "object", properties: {
  ...COMBO_CONFIG_PROPERTIES, sourceAutoCombo: { type: "string", maxLength: 200 },
  weightPack: COMBO_CONFIG_PROPERTIES.weights!,
}, additionalProperties: false };
const DUPLICATE_COMBO_SCHEMA: JsonSchema = jsonObject({ ...COMBO_FIELDS, config: AUTO_CONFIG_SCHEMA }, ["id", "name"]);
const VIRTUAL_AUTO_CONFIG_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    candidatePool: stringArray(100, 200),
    weights: { type: "object", additionalProperties: number(0, 1) },
    explorationRate: number(0, 1),
    routerStrategy: str(100),
  },
  required: ["candidatePool", "weights", "explorationRate", "routerStrategy"],
  additionalProperties: true,
};
const AUTO_CONFIG_CONTAINER_SCHEMA = jsonObject({
  auto: VIRTUAL_AUTO_CONFIG_SCHEMA,
  chaos: jsonObject({ enabled: { const: true }, panelSize: integer(0, 10), judgeModel: str(300),
    tuning: jsonObject({ panelHardTimeoutMs: integer(0), minPanel: integer(0) }) }),
}, ["auto"]);
const AUTO_SCHEMA: JsonSchema = jsonObject({ combos: { type: "array", items: jsonObject({ id: str(300), name: str(300), variant: nullableString(100), type: { const: "auto" },
  kind: { type: "string", enum: ["variant", "template", "category", "family"] }, isHidden: { type: "boolean" }, candidateCount: integer(0), candidatePool: stringArray(100, 200),
  context_length: integer(0), max_output_tokens: integer(0), config: AUTO_CONFIG_CONTAINER_SCHEMA }, ["id", "name", "variant", "type", "kind", "isHidden", "candidatePool", "candidateCount", "context_length", "max_output_tokens", "config"]) } }, ["combos"]);
const AUTO_SINGLE_SCHEMA: JsonSchema = jsonObject({ id: str(300), name: str(300), strategy: { const: "auto" }, models: { type: "array", items: COMBO_STEP_SCHEMA },
  isActive: { type: "boolean" }, type: { const: "auto" }, config: AUTO_CONFIG_CONTAINER_SCHEMA, candidateCount: integer(0),
  context_length: integer(0), max_output_tokens: integer(0) }, ["id", "name", "strategy", "models", "isActive", "type", "config", "candidateCount", "context_length", "max_output_tokens"]);
const AUTO_RESPONSE_SCHEMA: JsonSchema = { oneOf: [AUTO_SCHEMA, AUTO_SINGLE_SCHEMA] };
const BUILDER_MODEL_SCHEMA = jsonObject({ id: str(300), qualifiedModel: str(500), name: str(300), source: { type: "string", enum: ["imported", "system", "custom", "fallback"] },
  sources: { type: "array", items: { type: "string", enum: ["imported", "system", "custom", "fallback"] } }, supportedEndpoints: stringArray(100, 200),
  apiFormat: str(120), contextLength: integer(0), outputTokenLimit: integer(0), supportsThinking: { type: "boolean" } }, ["id", "qualifiedModel", "name", "source", "sources"]);
const BUILDER_CONNECTION_SCHEMA = jsonObject({ id: str(200), label: str(300), type: str(120), status: { type: "string", enum: ["active", "inactive", "rate-limited", "error"] },
  priority: number(), isActive: { type: "boolean" }, defaultModel: nullableString(300), rateLimitedUntil: { oneOf: [number(), { type: "null" }] },
  lastError: nullableString(2000), lastTested: nullableString(100) }, ["id", "label", "type", "status", "priority", "isActive"]);
const BUILDER_PROVIDER_SCHEMA = jsonObject({ providerId: str(200), providerType: str(120), displayName: str(300), alias: str(200), prefix: nullableString(200),
  icon: { type: "string", maxLength: 500 }, color: { type: "string", maxLength: 100 }, source: { type: "string", enum: ["system", "provider-node"] },
  acceptsArbitraryModel: { type: "boolean" }, connectionCount: integer(0), activeConnectionCount: integer(0), modelCount: integer(0),
  connections: { type: "array", items: BUILDER_CONNECTION_SCHEMA }, models: { type: "array", items: BUILDER_MODEL_SCHEMA } },
  ["providerId", "providerType", "displayName", "alias", "icon", "color", "source", "acceptsArbitraryModel", "connectionCount", "activeConnectionCount", "modelCount", "connections", "models"]);
const BUILDER_SCHEMA: JsonSchema = jsonObject({ schemaVersion: integer(1), generatedAt: { type: "string", format: "date-time" },
  providers: { type: "array", items: BUILDER_PROVIDER_SCHEMA }, comboRefs: { type: "array", items: jsonObject({ id: str(), name: str(100), strategy: { type: "string", enum: STRATEGY_ENUM },
    stepCount: integer(0), version: integer(1), sortOrder: integer(0) }, ["id", "name", "strategy", "stepCount", "version"]) } }, ["schemaVersion", "generatedAt", "providers", "comboRefs"]);
const TEST_TARGET_SCHEMA = jsonObject({ model: str(300), provider: str(120), stepId: str(), executionKey: str(), connectionId: nullableString(), label: nullableString() }, ["model", "provider", "stepId", "executionKey", "connectionId", "label"]);
const TEST_RESULT_SCHEMA: JsonSchema = jsonObject({ comboName: str(100), strategy: { type: "string", enum: STRATEGY_ENUM }, testMode: { const: "target-health-check" },
  comboType: { const: "auto" }, totalCandidates: integer(0),
  resolvedBy: nullableString(300), resolvedByExecutionKey: nullableString(), resolvedByTarget: { oneOf: [TEST_TARGET_SCHEMA, { type: "null" }] },
  results: { type: "array", items: jsonObject({ model: str(300), provider: str(120), stepId: str(), executionKey: str(), connectionId: nullableString(), label: nullableString(),
    status: { type: "string", enum: ["ok", "error"] }, error: nullableString(2000), statusCode: integer(100), latencyMs: number(0),
    responseText: nullableString(5000), isTimeout: { type: "boolean" } }, ["model", "provider", "stepId", "executionKey", "connectionId", "label", "status"]) },
  testedAt: { type: "string", format: "date-time" } }, ["comboName", "strategy", "testMode", "resolvedBy", "resolvedByExecutionKey", "resolvedByTarget", "results", "testedAt"]);
const DELETE_METRICS_SCHEMA: JsonSchema = jsonObject({ success: { const: true }, message: str(200) }, ["success", "message"]);
const REORDER_SCHEMA: JsonSchema = jsonObject({ combos: { type: "array", items: COMBO_SCHEMA } }, ["combos"]);
const ERROR_SCHEMA: JsonSchema = jsonObject({ error: { oneOf: [{ type: "string", maxLength: 2000 }, jsonObject({ message: { type: "string", maxLength: 2000 }, code: str(120), correlation_id: str(200) })] },
  details: { type: "string", maxLength: 2000 } }, ["error"]);

function routeSourceFile(operationId: string): string {
  const routeFiles: Readonly<Record<string, string>> = {
    "GET /api/combos": COMBO_ROUTE_SOURCE_FILES[0],
    "POST /api/combos": COMBO_ROUTE_SOURCE_FILES[0],
    "GET /api/combos/{id}": COMBO_ROUTE_SOURCE_FILES[1],
    "PUT /api/combos/{id}": COMBO_ROUTE_SOURCE_FILES[1],
    "PATCH /api/combos/{id}": COMBO_ROUTE_SOURCE_FILES[1],
    "DELETE /api/combos/{id}": COMBO_ROUTE_SOURCE_FILES[1],
    "GET /api/combos/auto": COMBO_ROUTE_SOURCE_FILES[2],
    "GET /api/combos/builder/options": COMBO_ROUTE_SOURCE_FILES[3],
    "GET /api/combos/metrics": COMBO_ROUTE_SOURCE_FILES[4],
    "DELETE /api/combos/metrics": COMBO_ROUTE_SOURCE_FILES[4],
    "POST /api/combos/duplicate": COMBO_ROUTE_SOURCE_FILES[5],
    "POST /api/combos/reorder": COMBO_ROUTE_SOURCE_FILES[6],
    "POST /api/combos/test": COMBO_ROUTE_SOURCE_FILES[7],
  };
  const sourceFile = routeFiles[operationId];
  if (!sourceFile) throw new Error(`combo handler is not source-bound: ${operationId}`);
  return sourceFile;
}
const HANDLER_GUARDS: Readonly<Record<typeof COMBO_OPERATION_IDS[number], "requireManagementAuth">> = Object.freeze({
  "GET /api/combos": "requireManagementAuth", "POST /api/combos": "requireManagementAuth",
  "GET /api/combos/{id}": "requireManagementAuth", "PUT /api/combos/{id}": "requireManagementAuth",
  "PATCH /api/combos/{id}": "requireManagementAuth", "DELETE /api/combos/{id}": "requireManagementAuth",
  "GET /api/combos/auto": "requireManagementAuth", "GET /api/combos/builder/options": "requireManagementAuth",
  "GET /api/combos/metrics": "requireManagementAuth", "DELETE /api/combos/metrics": "requireManagementAuth",
  "POST /api/combos/duplicate": "requireManagementAuth", "POST /api/combos/reorder": "requireManagementAuth",
  "POST /api/combos/test": "requireManagementAuth",
});
const HANDLER_STATUS_CODES: Readonly<Record<typeof COMBO_OPERATION_IDS[number], readonly string[]>> = Object.freeze({
  "GET /api/combos": ["200", "400", "500"], "POST /api/combos": ["201", "400", "500"],
  "GET /api/combos/{id}": ["200", "404", "500"], "PUT /api/combos/{id}": ["200", "400", "404", "409", "500"],
  "PATCH /api/combos/{id}": ["200", "400", "404", "409", "500"], "DELETE /api/combos/{id}": ["200", "404", "409", "500"],
  "GET /api/combos/auto": ["200", "400", "404"], "GET /api/combos/builder/options": ["200", "500"],
  "GET /api/combos/metrics": ["200", "500"], "DELETE /api/combos/metrics": ["200", "500"],
  "POST /api/combos/duplicate": ["201", "400", "422", "500"], "POST /api/combos/reorder": ["200", "400", "500"],
  "POST /api/combos/test": ["200", "400", "404", "500"],
});
function queryParameter(name: string, schema: JsonSchema, operationId: string, required = false) {
  return { name, in: "query" as const, required, style: "form", explode: true, allowReserved: false, schema, inputAllowed: true, sourceFile: routeSourceFile(operationId) };
}
function bodyRequest(base: OperationSourceContract["request"], schema: JsonSchema, validator: ComboSourceRequestValidatorId, operationId: string, normalizations: NonNullable<OperationSourceContract["request"]["normalizations"]>): OperationSourceContract["request"] {
  const baseBody = base.body;
  const variants = baseBody?.contentVariants ?? [];
  const contentVariants = variants.some(content => content.mediaType === "application/json")
    ? variants.map(content => content.mediaType === "application/json" ? { ...content, schema } : content)
    : [...variants, { mediaType: "application/json", schema }];
  return { ...base, body: { ...baseBody, required: true, mediaType: "application/json", schema, contentVariants },
    sourceValidator: validator as NonNullable<OperationSourceContract["request"]["sourceValidator"]>,
    sourceNormalizer: validator as NonNullable<OperationSourceContract["request"]["sourceNormalizer"]>, normalizations };
}
function routePath(operationId: string): string { return operationId.slice(operationId.indexOf(" ") + 1); }
function operationAuth(base: OperationSourceContract["auth"], operationId: string): OperationSourceContract["auth"] {
  const split = operationId.indexOf(" ");
  const method = operationId.slice(0, split);
  const handlerGuard = HANDLER_GUARDS[operationId as keyof typeof HANDLER_GUARDS];
  if (!handlerGuard) throw new Error(`combo handler guard is not source-bound: ${operationId}`);
  return { domain: "management", specificationAlternatives: base.specificationAlternatives, sourcePolicy: {
    status: "qualified", source: "omniroute-v3.8.52", routeClass: "management", localOnly: false, handlerGuard, bootstrap: "none",
    alternatives: [{ kind: "auth-disabled", when: "central-and-handler-auth-not-required" }, { kind: "management-api-key", anyOf: ["manage", "admin"] },
      { kind: "dashboard-session" }, { kind: "oma-access-token", minimumScope: requiredOmaScope(method as "GET" | "POST" | "PUT" | "PATCH" | "DELETE", routePath(operationId)) }, { kind: "trusted-local", loopbackOnly: true }],
  } };
}
function responseContract(base: OperationSourceContract["response"], operationId: string, success: JsonSchema): OperationSourceContract["response"] {
  const handlerStatuses = HANDLER_STATUS_CODES[operationId as keyof typeof HANDLER_STATUS_CODES];
  if (!handlerStatuses) throw new Error(`combo response statuses are not source-bound: ${operationId}`);
  const variants: OperationResponseVariant[] = base.variants.map(variant => {
    if (!handlerStatuses.includes(variant.statusCode)) return variant;
    const schema = variant.statusCode.startsWith("2") ? success : ERROR_SCHEMA;
    return { ...variant,
      content: variant.content.map(content => content.mediaType === "application/json" ? { ...content, schema } : content) };
  });
  return { ...base, schema: success, variants };
}

const QUERY_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  "GET /api/combos": jsonObject({ limit: { type: "integer", minimum: 0, maximum: 200 }, offset: { type: "integer", minimum: 0 } }),
  "GET /api/combos/auto": jsonObject({ id: { type: "string", maxLength: 300 } }),
  "GET /api/combos/metrics": jsonObject({ combo: { type: "string", maxLength: 100 } }),
  "DELETE /api/combos/metrics": jsonObject({ combo: { type: "string", maxLength: 100 } }),
};
const RESPONSE_SCHEMAS: Readonly<Record<string, JsonSchema>> = {
  "GET /api/combos": LIST_SCHEMA,
  "POST /api/combos": COMBO_SCHEMA,
  "GET /api/combos/{id}": COMBO_SCHEMA,
  "PUT /api/combos/{id}": COMBO_SCHEMA,
  "PATCH /api/combos/{id}": COMBO_SCHEMA,
  "DELETE /api/combos/{id}": jsonObject({ success: { const: true } }, ["success"]),
  "GET /api/combos/auto": AUTO_RESPONSE_SCHEMA,
  "GET /api/combos/builder/options": BUILDER_SCHEMA,
  "GET /api/combos/metrics": METRICS_SCHEMA,
  "DELETE /api/combos/metrics": DELETE_METRICS_SCHEMA,
  "POST /api/combos/duplicate": DUPLICATE_COMBO_SCHEMA,
  "POST /api/combos/reorder": REORDER_SCHEMA,
  "POST /api/combos/test": TEST_RESULT_SCHEMA,
};
const SOURCE_VALIDATORS: Readonly<Record<string, ComboSourceRequestValidatorId>> = {
  "POST /api/combos": "omniroute-v3.8.52.combos.create",
  "PUT /api/combos/{id}": "omniroute-v3.8.52.combos.update", "PATCH /api/combos/{id}": "omniroute-v3.8.52.combos.update",
  "POST /api/combos/duplicate": "omniroute-v3.8.52.combos.duplicate", "POST /api/combos/reorder": "omniroute-v3.8.52.combos.reorder", "POST /api/combos/test": "omniroute-v3.8.52.combos.test",
};
function relation(operationId: string): OperationSourceContract["reconciliation"] {
  type RelationInputs = NonNullable<OperationSourceContract["reconciliation"]>["targetRead"]["inputs"];
  const read = (id: string, inputs: RelationInputs = []) => ({ operationId: id, inputs });
  if (operationId === "POST /api/combos") {
    return {
      targetRead: { ...read("GET /api/combos"), snapshot: { kind: "collection", identity: [{ name: "id", path: ["id"] }], state: [{ name: "name", path: ["name"] }] }, sourceView: "omniroute-v3.8.52.combos.create-reconcile" },
      reconcile: { ...read("GET /api/combos"), outcome: { kind: "exists", identityFields: ["id"], stateFields: ["name"], expectedFromInput: [{ name: "name", source: { section: "body", path: ["name"] } }] } },
    };
  }
  if (operationId === "POST /api/combos/duplicate") {
    return {
      targetRead: { ...read("GET /api/combos"), snapshot: { kind: "collection", identity: [{ name: "id", path: ["id"] }], state: [{ name: "name", path: ["name"] }] }, sourceView: "omniroute-v3.8.52.combos.duplicate-reconcile" },
      reconcile: { ...read("GET /api/combos"), outcome: { kind: "exists", identityFields: ["id"], stateFields: ["name"], expectedFromInput: [{ name: "name", source: { section: "body", path: ["name"] } }] } },
    };
  }
  if (operationId === "PUT /api/combos/{id}" || operationId === "PATCH /api/combos/{id}") {
    const inputs = [{ source: { section: "path" as const, path: ["id"] }, target: { section: "path" as const, field: "id" } }];
    const stateNames = ["name", "description", "displayName", "models", "strategy", "config", "isActive", "isHidden", "allowedProviders", "allowedModelFamilies", "system_message", "tool_filter_regex", "context_cache_protection", "context_length", "dimensions", "sortOrder", "version"];
    return {
      targetRead: { operationId: "GET /api/combos/{id}", inputs, snapshot: { kind: "resource", identity: [{ name: "id", path: ["id"] }], state: stateNames.map(name => ({ name, path: [name] })) }, sourceView: "omniroute-v3.8.52.combos.item-update-reconcile" },
      reconcile: { operationId: "GET /api/combos/{id}", inputs, outcome: { kind: "matches", identityFields: ["id"], stateFields: stateNames, expectedFromInput: stateNames.map(name => ({ name, source: { section: "body" as const, path: [name] } })) } },
    };
  }
  if (operationId === "DELETE /api/combos/{id}") {
    return {
      targetRead: { ...read("GET /api/combos"), snapshot: { kind: "resource", identity: [{ name: "id", path: ["id"] }], state: [{ name: "name", path: ["name"] }] }, sourceView: "omniroute-v3.8.52.combos.item-delete-reconcile" },
      reconcile: { ...read("GET /api/combos"), outcome: { kind: "absent", identityFields: ["id"], stateFields: [] } },
    };
  }
  if (operationId === "POST /api/combos/reorder") {
    return {
      targetRead: { ...read("GET /api/combos"), snapshot: { kind: "resource", identity: [{ name: "scope", path: ["scope"] }], state: [{ name: "order", path: ["order"] }] }, sourceView: "omniroute-v3.8.52.combos.reorder-reconcile" },
      reconcile: { ...read("GET /api/combos"), outcome: { kind: "matches", identityFields: ["scope"], stateFields: ["order"], expectedFromInput: [{ name: "order", source: { section: "body", path: ["comboIds"] } }] } },
    };
  }
  if (operationId === "DELETE /api/combos/metrics") {
    const inputs = [{ source: { section: "query" as const, path: ["combo"] }, target: { section: "query" as const, field: "combo" } }];
    return {
      targetRead: { operationId: "GET /api/combos/metrics", inputs, snapshot: { kind: "collection", identity: [{ name: "comboName", path: ["comboName"] }], state: [{ name: "metrics", path: ["metrics"] }] }, sourceView: "omniroute-v3.8.52.combos.metrics-reset-reconcile" },
      reconcile: { operationId: "GET /api/combos/metrics", inputs, outcome: { kind: "absent", identityFields: ["comboName"], stateFields: [] } },
    };
  }
  return null;
}
function contractFor(operationId: string): OperationSourceContract {
  const base = operationContractTemplate(operationId) as unknown as OperationSourceContract;
  const querySchema = QUERY_SCHEMAS[operationId];
  const validator = SOURCE_VALIDATORS[operationId];
  let request = base.request;
  if (validator) {
    const schema = operationId === "POST /api/combos/duplicate" ? jsonObject({ name: { type: "string", minLength: 1 }, strategy: { type: "string", enum: STRATEGY_ENUM } }, ["name"])
      : operationId === "POST /api/combos/reorder" ? jsonObject({ comboIds: { type: "array", minItems: 1, maxItems: 1000, items: { type: "string", minLength: 1, maxLength: 200 } } }, ["comboIds"])
      : operationId === "POST /api/combos/test" ? jsonObject({ comboName: { type: "string", minLength: 1 } }, ["comboName"])
      : operationId === "POST /api/combos" ? jsonObject(COMBO_CREATE_INPUT_FIELDS, ["name", "models"])
      : jsonObject(COMBO_UPDATE_INPUT_FIELDS, []);
    const norm: NonNullable<OperationSourceContract["request"]["normalizations"]> = operationId === "POST /api/combos/duplicate"
      ? [{ section: "body", path: ["name"], kind: "trim-string" }]
      : operationId === "POST /api/combos/reorder" ? [{ section: "body", path: ["comboIds"], kind: "trim-string-array" }]
      : operationId === "POST /api/combos/test" ? [{ section: "body", path: ["comboName"], kind: "trim-string" }]
      : operationId === "POST /api/combos"
        ? [{ section: "body", path: ["name"], kind: "trim-string" }, { section: "body", path: ["displayName"], kind: "trim-string" },
          { section: "body", path: ["allowedProviders"], kind: "trim-string-array" }, { section: "body", path: ["allowedModelFamilies"], kind: "trim-string-array" }]
        : [{ section: "body", path: ["name"], kind: "trim-string" }, { section: "body", path: ["displayName"], kind: "trim-string" },
          { section: "body", path: ["allowedProviders"], kind: "trim-string-array" }, { section: "body", path: ["allowedModelFamilies"], kind: "trim-string-array" }];
    request = bodyRequest(request, schema, validator, operationId, norm);
  } else if (querySchema) {
    const list = operationId === "GET /api/combos";
    const autoCombos = operationId === "GET /api/combos/auto";
    const metricsReset = operationId === "DELETE /api/combos/metrics";
    request = { ...request, querySchema, parameters: [
      ...(list ? [queryParameter("limit", { type: "integer", minimum: 0, maximum: 200 }, operationId), queryParameter("offset", { type: "integer", minimum: 0 }, operationId)] : []),
      ...(autoCombos ? [queryParameter("id", { type: "string", maxLength: 300 }, operationId)] : []),
      ...(operationId.includes("/metrics") ? [queryParameter("combo", { type: "string", maxLength: 100 }, operationId)] : []),
    ], ...(list ? { sourceNormalizer: "omniroute-v3.8.52.combos.list-query" as NonNullable<OperationSourceContract["request"]["sourceNormalizer"]> } : {}),
    ...(metricsReset ? { sourceNormalizer: "omniroute-v3.8.52.combos.metrics-reset-query" as NonNullable<OperationSourceContract["request"]["sourceNormalizer"]> } : {}) };
  }
  const isRead = operationId.startsWith("GET ");
  const isTest = operationId === "POST /api/combos/test";
  const targetRelation = isRead || isTest ? null : relation(operationId);
  const metricsReset = operationId === "DELETE /api/combos/metrics";
  const preflight = isTest
    ? { kind: "unavailable" as const, reason: "The charged test resolves mutable combo and provider targets that no source-qualified read observes before dispatch." }
    : metricsReset && targetRelation
      ? { kind: "required" as const, observations: [{
          name: "metrics-reset-scope",
          read: targetRelation.targetRead,
          readCompleteness: { kind: "single-response" as const, sourceReason: "The pinned GET returns one selected production/shadow metrics object or null, or the complete exposed map for all production/shadow names. Neither response exposes standalone persisted-skip counters or names present only in that hidden counter map." },
        }],
        visibilityLimits: [
          "A named GET returns that name's metrics object or null; null means no exposed production or shadow metrics, not that hidden persisted-skip state is absent.",
          "An all-name GET exposes production and shadow metrics entries; standalone persisted-skip counters and names present only in that counter map are omitted.",
          "The all-name JSON map omits a metric named __proto__; a named GET can still observe that name directly.",
          "A named reset deletes production metrics, shadow metrics, and the selected name's persisted-skip counter.",
          "Reset-all deletes all three counter maps and stops the metrics cleanup interval until module reload.",
        ] as const,
      }
    : operationId === "PUT /api/combos/{id}" || operationId === "PATCH /api/combos/{id}"
      ? { kind: "unavailable" as const, reason: "The update handler reads the mutable full combo collection for normalization, name collision, and DAG checks; the paginated collection GET has no complete-list proof." }
    : targetRelation?.targetRead.operationId === "GET /api/combos"
      ? { kind: "unavailable" as const, reason: "The collection read is paginated and has no source-qualified complete-list proof; absence and dependency state cannot be established." }
      : targetRelation
        ? { kind: "required" as const, observations: [{
            name: "combo-target",
            read: targetRelation.targetRead,
            readCompleteness: { kind: "single-response" as const, sourceReason: "The pinned GET returns the complete selected combo or metric target in one response without pagination." },
          }] }
        : { kind: "unavailable" as const, reason: "No source-qualified preflight read resolves the mutation target." };
  const contract: OperationSourceContract = { ...base, request, auth: operationAuth(base.auth, operationId), sideEffect: isRead ? "read" : "mutation",
    secrets: { ...base.secrets, outputFields: [...base.secrets.outputFields, "providers.connections.lastError", "config.apiKey"] },
    pagination: operationId === "GET /api/combos" ? { mode: "offset", parameters: ["limit", "offset"] } : { mode: "none", parameters: [] },
    streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: !isRead, reason: isRead ? "Source-defined management-authorized read." : isTest ? "Combo test executes configured model requests that may incur external cost." : "Human confirmation is required before applying this combo management mutation." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] },
    response: responseContract(base.response, operationId, RESPONSE_SCHEMAS[operationId] ?? ERROR_SCHEMA),
    reconciliation: targetRelation,
    mutationSafety: isRead ? null : {
      preflight,
      reconciliation: { kind: "unknown" },
      settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null },
    } };
  return contract;
}

export const COMBO_SOURCE_CONTRACTS: Readonly<Record<typeof COMBO_OPERATION_IDS[number], OperationSourceContract>> = Object.freeze(Object.fromEntries(COMBO_OPERATION_IDS.map(id => [id, contractFor(id)])) as Record<typeof COMBO_OPERATION_IDS[number], OperationSourceContract>);
export function buildComboFixtureRegistry() {
  const descriptors: OperationDescriptor[] = COMBO_OPERATION_IDS.map(operationId => {
    const source = getOperation(operationId);
    if (!source) throw new Error(`pinned combo operation is absent: ${operationId}`);
    const contract = COMBO_SOURCE_CONTRACTS[operationId];
    const name = operationId.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
    return { ...source, ...contract, mediaType: { request: contract.request.body?.mediaType ?? null, response: contract.response.mediaType },
      coverage: { status: "invokable", adapterId: `typed.fixture.${name}`, reason: null } };
  });
  return fixtureRegistry(descriptors);
}
export function comboAdapterDescriptor(adapter: OperationAdapter) {
  const descriptor = adapter.descriptor;
  return { operationId: descriptor.operationId, adapterId: adapter.adapterId, method: descriptor.method, pathTemplate: descriptor.pathTemplate,
    mediaType: { request: descriptor.request.body?.mediaType ?? null, response: descriptor.response.mediaType },
    request: { pathParameters: descriptor.request.pathParameters, body: descriptor.request.body }, streaming: descriptor.streaming,
    auth: { domain: descriptor.auth.domain }, coverage: { status: "invokable" as const } };
}

export type ComboSeed = Readonly<Record<string, unknown>>;
export interface ComboFixtureOptions { readonly auth: PinnedManagementAuthorization; readonly seeds?: readonly ComboSeed[]; }
const clone = <T>(value: T): T => structuredClone(value);
const jsonResponse = (body: unknown, status = 200): Response => Response.json(body, { status });

function sanitizePrivateFixtureState(value: unknown): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(sanitizePrivateFixtureState);
  if (typeof value !== "object") return null;
  const result: JsonObject = {};
  for (const [key, nested] of Object.entries(value)) {
    if (/api.?key|token|secret|password|authorization/i.test(key)) continue;
    result[key] = sanitizePrivateFixtureState(nested);
  }
  return result;
}
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const FIXTURE_CLOCK_TIME = "2026-10-20T00:00:00.000Z";

function fixtureUuidGenerator(): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    if (sequence > 0xffff_ffff) throw new Error("Combo fixture exhausted its deterministic UUID sequence");
    return `00000000-0000-4000-8000-0001${sequence.toString(16).padStart(8, "0")}`;
  };
}

export class CombosHttpFixture {
  readonly endpoint: string;
  readonly #auth: PinnedManagementAuthorization;
  readonly #storage: PinnedComboStoreRuntime;
  readonly #handlers: ReturnType<typeof createPinnedComboHandlers>;
  readonly #routes: Readonly<Record<string, PinnedExports>>;
  readonly #counts = new Map<string, number>();
  readonly #rejectedProbeModels = new Set<string>();
  readonly #server: Bun.Server<undefined>;

  private constructor(auth: PinnedManagementAuthorization, seeds: readonly ComboSeed[]) {
    this.#auth = auth;
    const fixtureUuid = fixtureUuidGenerator();
    const fixtureDate = createPinnedFixtureDate(FIXTURE_CLOCK_TIME);
    this.#storage = createPinnedSqliteComboStore(seeds.map(seed => clone(seed) as Record<string, unknown>), {
      uuid: fixtureUuid,
      date: fixtureDate,
    });
    this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => this.#handle(request) });
    this.endpoint = this.#server.url.origin;
    this.#handlers = createPinnedComboHandlers({
      authorization: auth,
      store: this.#storage.store,
      apiPort: () => Number(this.#server.url.port),
      uuid: fixtureUuid,
      date: fixtureDate,
    });
    this.#routes = this.#handlers.routes;
    this.#handlers.metrics.recordComboRequest("Probe", "fixture/chat", {
      success: true,
      latencyMs: 12,
      strategy: "priority",
      target: { executionKey: "fixture-target", provider: "fixture", providerId: "fixture", connectionId: "fixture-connection" },
    });
    this.#handlers.metrics.recordComboIntent("Probe", "coding");
  }

  static start(options: ComboFixtureOptions): CombosHttpFixture {
    return new CombosHttpFixture(options.auth, options.seeds ?? []);
  }
  get counts(): Readonly<Record<string, number>> { return Object.fromEntries(this.#counts); }
  rejectNextProbe(model: string): void {
    if (!model.trim()) throw new Error("A probe model id is required for the controlled fixture failure");
    this.#rejectedProbeModels.add(model);
  }
  recordHiddenPersistedSkipBypass(name: string): void {
    (this.#handlers.metrics as unknown as { recordPersistedSkipBypass(name: string): void }).recordPersistedSkipBypass(name);
  }
  hiddenPersistedSkipBypasses(name: string): number {
    return (this.#handlers.metrics as unknown as { getPersistedSkipBypassed(name: string): number }).getPersistedSkipBypassed(name);
  }
  recordComboMetrics(name: string): void {
    this.#handlers.metrics.recordComboRequest(name, "fixture/chat", { success: true, latencyMs: 7, strategy: "priority" });
  }
  get state(): JsonValue {
    return sanitizePrivateFixtureState({
      ...this.#storage.snapshot(),
      metrics: this.#handlers.metrics.getAllComboMetrics(),
    });
  }
  close(): void { this.#server.stop(true); this.#handlers.metrics.resetAllComboMetrics(); this.#storage.close(); }
  #count(method: string, path: string): void { const key = `${method} ${path}`; this.#counts.set(key, (this.#counts.get(key) ?? 0) + 1); }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    if ((path === "/v1/chat/completions" || path === "/v1/embeddings") && method === "POST") {
      this.#count(method, path);
      if (request.headers.get("authorization") !== "Bearer fixture-internal-api-key"
        || request.headers.get("x-internal-test") !== "combo-health-check"
        || request.headers.get("x-omniroute-no-cache") !== "true"
        || request.headers.get("x-omniroute-compression") !== "off") {
        return jsonResponse({ error: "Invalid internal combo test request" }, 403);
      }
      const body = object(await request.json().catch(() => null));
      if (!body || typeof body.model !== "string") return jsonResponse({ error: "Invalid model probe body" }, 400);
      if (this.#rejectedProbeModels.delete(body.model)) {
        return jsonResponse({ error: { message: "fixture upstream rejected probe" }, diagnostics: "must-not-project" }, 503);
      }
      if (path === "/v1/embeddings") return jsonResponse({ data: [{ embedding: [0.1, 0.2] }] });
      const events = [
        { choices: [{ delta: { content: "pong" }, finish_reason: null }] },
        { choices: [{ delta: {}, finish_reason: "stop" }] },
      ].map(value => `data: ${JSON.stringify(value)}\n\n`).join("");
      return new Response(`${events}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
    }

    let route: PinnedExports | undefined;
    let handlerName: string | undefined;
    let context: { params: Promise<{ id: string }> } | undefined;
    if (path === "/api/combos") route = this.#routes["src/app/api/combos/route.ts"];
    else if (path === "/api/combos/auto") route = this.#routes["src/app/api/combos/auto/route.ts"];
    else if (path === "/api/combos/builder/options") route = this.#routes["src/app/api/combos/builder/options/route.ts"];
    else if (path === "/api/combos/metrics") route = this.#routes["src/app/api/combos/metrics/route.ts"];
    else if (path === "/api/combos/duplicate") route = this.#routes["src/app/api/combos/duplicate/route.ts"];
    else if (path === "/api/combos/reorder") route = this.#routes["src/app/api/combos/reorder/route.ts"];
    else if (path === "/api/combos/test") route = this.#routes["src/app/api/combos/test/route.ts"];
    else {
      const item = /^\/api\/combos\/([^/]+)$/.exec(path);
      if (item && !["auto", "metrics", "duplicate", "reorder", "test"].includes(item[1]!)) {
        route = this.#routes["src/app/api/combos/[id]/route.ts"];
        handlerName = "item";
        let id: string;
        try { id = decodeURIComponent(item[1]!); } catch { return jsonResponse({ error: "Not found" }, 404); }
        context = { params: Promise.resolve({ id }) };
      }
    }
    if (!route) return jsonResponse({ error: "Not found" }, 404);
    this.#count(method, path);
    const handler = route[method];
    if (typeof handler !== "function") return jsonResponse({ error: "Method not allowed" }, 405);
    const execute = (forwarded: Request) => handlerName === "item"
      ? (handler as (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>)(forwarded, context!)
      : (handler as (request: Request) => Promise<Response>)(forwarded);
    return this.#auth.dispatch(request, { centralAuthRequired: true, handlerAuthRequired: false }, execute);
  }
}
