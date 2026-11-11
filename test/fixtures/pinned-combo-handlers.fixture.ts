import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Database } from "bun:sqlite";
import {
  createPinnedManagementAuthorization,
  createPinnedFixtureDate,
  loadExtractedPinnedDeclarations,
  loadPinnedModule,
  readPinnedSource,
  type PinnedExports,
  type PinnedManagementAuthorization,
} from "./pinned-handler.fixture.ts";

export interface MappingRow {
  id: string;
  pattern: string;
  comboId: string;
  comboName?: string;
  priority: number;
  enabled: boolean;
  description: string;
  createdAt: string;
  updatedAt: string;
}

export interface MappingInput {
  pattern: string;
  comboId: string;
  priority?: number;
  enabled?: boolean;
  description?: string;
}

export interface MappingRepository {
  list(options?: { limit?: number; offset?: number }): Promise<{ items: MappingRow[]; total: number }>;
  findById(id: string): Promise<MappingRow | null>;
  create(data: MappingInput): Promise<MappingRow>;
  update(id: string, data: Partial<MappingInput>): Promise<MappingRow | null>;
  deleteById(id: string): Promise<boolean>;
  resolveForModel(model: string): Promise<Record<string, unknown> | null>;
}

export interface PinnedMappingHandlers {
  readonly authorization: PinnedManagementAuthorization;
  readonly collection: PinnedExports;
  readonly item: PinnedExports;
  readonly db: Database;
  readonly repository: MappingRepository;
  readonly cacheVersions: () => { readonly combos: number; readonly catalog: number };
}

export interface ComboStore {
  readonly getCombos: (limit?: number, offset?: number) => Promise<Record<string, unknown>[]>;
  readonly getCombosCount: () => number;
  readonly getComboById: (id: string) => Promise<Record<string, unknown> | null>;
  readonly getComboByName: (name: string) => Promise<Record<string, unknown> | null>;
  readonly createCombo: (data: Record<string, unknown>) => Promise<Record<string, unknown>>;
  readonly updateCombo: (id: string, data: Record<string, unknown>) => Promise<Record<string, unknown> | null>;
  readonly deleteCombo: (id: string) => Promise<boolean>;
  readonly reorderCombos: (ids: string[]) => Promise<Record<string, unknown>[]>;
}

export interface PinnedComboMetrics {
  getAllComboMetrics(): Record<string, unknown>;
  getComboMetrics(name: string): Record<string, unknown> | null;
  recordComboRequest(
    name: string,
    model: string | null,
    options: { success: boolean; latencyMs: number; fallbackCount?: number; strategy?: string; target?: Record<string, unknown> },
  ): void;
  recordComboIntent(name: string, intent: string): void;
  resetComboMetrics(name: string): void;
  resetAllComboMetrics(): void;
}

export interface ComboStoreEffects {
  readonly cacheInvalidations: string[];
  readonly backupReasons: string[];
  readonly sessionHistoryClears: string[];
  readonly reasoningCacheInvalidations: number[];
  readonly lkgpPurges: string[];
  readonly rotationClears: Array<{ scope: string; scopeId: string | null }>;
  readonly proxyRegistryGenerationBumps: number[];
  readonly apiKeyCacheInvalidations: number[];
}

export interface PinnedComboStoreRuntime {
  readonly store: ComboStore;
  readonly db: Database;
  readonly effects: ComboStoreEffects;
  snapshot(): Record<string, unknown>;
  close(): void;
}

export interface PinnedComboHandlers {
  readonly authorization: PinnedManagementAuthorization;
  readonly routes: Readonly<Record<string, PinnedExports>>;
  readonly metrics: PinnedComboMetrics;
}

/**
 * Construct the server's combo persistence path from the pinned upstream
 * SQLite repository and compatibility facade. Only cross-cutting application
 * services are recorded adapters; SQL, normalization, invariants, writes, and
 * reorder semantics execute from receipt-verified upstream source.
 */
export function createPinnedSqliteComboStore(
  seeds: readonly Record<string, unknown>[],
  options: { readonly uuid?: () => string; readonly date?: DateConstructor } = {},
): PinnedComboStoreRuntime {
  const fixtureUuid = options.uuid ?? randomUUID;
  const fixtureDate = options.date ?? globalThis.Date;
  const db = new Database(":memory:");
  const coreSource = readPinnedSource("src/lib/db/core.ts");
  const schema = /const SCHEMA_SQL = `([\s\S]*?)`;/m.exec(coreSource)?.[1];
  const comboTable = schema && /CREATE TABLE IF NOT EXISTS combos\s*\([\s\S]*?\n\s*\);/i.exec(schema)?.[0];
  if (!comboTable) throw new Error("Receipt-verified upstream core schema omitted the combos table");
  const apiKeyTable = schema && /CREATE TABLE IF NOT EXISTS api_keys\s*\([\s\S]*?\n\s*\);/i.exec(schema)?.[0];
  if (!apiKeyTable) throw new Error("Receipt-verified upstream core schema omitted the api_keys table");
  db.exec(comboTable);
  db.exec(apiKeyTable);
  db.exec(readPinnedSource("src/lib/db/migrations/052_api_key_combo_throttle.sql"));
  db.exec(readPinnedSource("src/lib/db/migrations/005_combo_agent_fields.sql"));
  db.exec(readPinnedSource("src/lib/db/migrations/004_proxy_registry.sql"));
  db.exec(readPinnedSource("src/lib/db/migrations/117_proxy_pool_rotation.sql"));

  const effects: ComboStoreEffects = {
    cacheInvalidations: [],
    backupReasons: [],
    sessionHistoryClears: [],
    reasoningCacheInvalidations: [],
    lkgpPurges: [],
    rotationClears: [],
    apiKeyCacheInvalidations: [],
    proxyRegistryGenerationBumps: [],
  };
  const getDbInstance = () => db;
  const sourceReadCache = loadPinnedModule("src/lib/db/readCache.ts", specifier => {
    throw new Error(`Unapproved pinned read-cache import: ${specifier}`);
  });
  const readCache = {
    ...sourceReadCache,
    invalidateDbCache: (table: string) => {
      effects.cacheInvalidations.push(table);
      (sourceReadCache.invalidateDbCache as (scope: string) => void)(table);
    },
  };
  const steps = loadPinnedModule("src/lib/combos/steps.ts", () => {
    throw new Error("Pinned combo-step normalizer has no runtime imports");
  });
  const invariants = loadPinnedModule("src/lib/combos/invariants.ts", () => {
    throw new Error("Pinned combo-invariant module has no runtime imports");
  });
  const rotation = loadExtractedPinnedDeclarations(
    ["src/lib/db/proxies/rotation.ts"],
    ["clearRotationState"],
    specifier => { throw new Error(`Unapproved pinned combo rotation import: ${specifier}`); },
  );
  const comboAccess = loadPinnedModule("src/shared/constants/comboAccess.ts", specifier => {
    throw new Error(`Unapproved pinned combo-access import: ${specifier}`);
  });
  const comboGrantRevocation = loadPinnedModule("src/lib/db/apiKeys/comboGrantRevocation.ts", specifier => {
    if (specifier === "@/shared/constants/comboAccess") return comboAccess;
    throw new Error(`Unapproved pinned combo-grant-revocation import: ${specifier}`);
  });
  const repository = loadPinnedModule("src/lib/db/repositories/sqliteComboRepository.ts", specifier => {
    if (specifier === "uuid") return { v4: fixtureUuid };
    if (specifier === "@/lib/combos/steps") return steps;
    if (specifier === "@/lib/combos/invariants") return invariants;
    if (specifier === "../core") return { getDbInstance };
    if (specifier === "../settings/lkgp") return {
      deleteLKGPRowsByComboName: (name: string) => { effects.lkgpPurges.push(name); return []; },
    };
    if (specifier === "../proxies/rotation") return {
      clearRotationState: (target: Database, scope: string, scopeId: string | null) => {
        effects.rotationClears.push({ scope, scopeId });
        return (rotation.clearRotationState as (db: Database, scope: string, scopeId: string | null) => unknown)(target, scope, scopeId);
      },
    };
    if (specifier === "../proxies/registryGeneration") return {
      bumpProxyRegistryGeneration: () => { effects.proxyRegistryGenerationBumps.push(1); },
    };
    if (specifier === "../apiKeys/comboGrantRevocation") return comboGrantRevocation;
    if (specifier === "../apiKeys") return { clearApiKeyCaches: () => { effects.apiKeyCacheInvalidations.push(1); } };
    if (specifier === "../readCache") return readCache;
    throw new Error(`Unapproved pinned combo-repository import: ${specifier}`);
  }, { date: fixtureDate });
  const legacySync = {
    getCombosCount: repository.getCombosCount as () => number,
  };
  const facade = loadPinnedModule("src/lib/db/combos.ts", specifier => {
    if (specifier === "./backup") return { backupDbFile: (reason: string) => { effects.backupReasons.push(reason); } };
    if (specifier === "./contextHandoffs") return {
      clearSessionModelHistoryForCombo: (name: string) => { effects.sessionHistoryClears.push(name); return 1; },
    };
    if (specifier === "./core") return { getDbInstance };
    if (specifier === "./readCache") return readCache;
    if (specifier === "./reasoningRoutingRules") return {
      invalidateReasoningRoutingRuleCache: () => { effects.reasoningCacheInvalidations.push(1); },
    };
    if (specifier === "./repositories/routingConfigRepositories") {
      return { routingConfigRepositories: { combos: repository.sqliteComboRepository, legacySync } };
    }
    throw new Error(`Unapproved pinned combo-facade import: ${specifier}`);
  });

  const insertCombo = db.prepare(
    "INSERT INTO combos (id, name, data, sort_order, created_at, updated_at, context_cache_protection) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  for (const seed of seeds) {
    const id = typeof seed.id === "string" ? seed.id : fixtureUuid();
    const name = typeof seed.name === "string" ? seed.name : id;
    const sortOrder = typeof seed.sortOrder === "number" ? seed.sortOrder : 0;
    const now = typeof seed.createdAt === "string" ? seed.createdAt : "2026-10-20T00:00:00.000Z";
    const data: Record<string, unknown> = { ...seed, id, name, sortOrder };
    insertCombo.run(id, name, JSON.stringify(data), sortOrder, now, now, data.context_cache_protection === true ? 1 : 0);
  }
  db.prepare(
    "INSERT INTO proxy_registry (id, name, type, host, port) VALUES (?, ?, ?, ?, ?)",
  ).run("fixture-proxy", "Fixture proxy", "http", "127.0.0.1", 1);
  db.prepare(
    "INSERT INTO proxy_assignments (proxy_id, scope, scope_id) VALUES (?, 'combo', ?)",
  ).run("fixture-proxy", "seed-delete");
  db.prepare(
    "INSERT INTO proxy_scope_rotation (scope, scope_id) VALUES ('combo', ?)",
  ).run("seed-delete");

  const store: ComboStore = {
    getCombos: facade.getCombos as ComboStore["getCombos"],
    getCombosCount: facade.getCombosCount as ComboStore["getCombosCount"],
    getComboById: facade.getComboById as ComboStore["getComboById"],
    getComboByName: facade.getComboByName as ComboStore["getComboByName"],
    createCombo: facade.createCombo as ComboStore["createCombo"],
    updateCombo: facade.updateCombo as ComboStore["updateCombo"],
    deleteCombo: facade.deleteCombo as ComboStore["deleteCombo"],
    reorderCombos: facade.reorderCombos as ComboStore["reorderCombos"],
  };
  return {
    store,
    db,
    effects,
    snapshot: () => ({
      combos: db.prepare("SELECT id, data, sort_order, context_cache_protection FROM combos ORDER BY sort_order, name COLLATE NOCASE").all().map(value => {
        const row = value as { id: string; data: string; sort_order: number; context_cache_protection: number };
        const data = JSON.parse(row.data) as Record<string, unknown>;
        return { ...data, id: row.id, sortOrder: row.sort_order, context_cache_protection: row.context_cache_protection === 1 };
      }),
      proxyAssignments: db.prepare("SELECT scope, scope_id, proxy_id, position FROM proxy_assignments ORDER BY id").all(),
      proxyRotations: db.prepare("SELECT scope, scope_id, cursor FROM proxy_scope_rotation ORDER BY scope, scope_id").all(),
      effects: structuredClone(effects),
    }),
    close: () => db.close(),
  };
}

const nextResponse = {
  json(body: unknown, init?: ResponseInit): Response {
    return Response.json(body, init);
  },
};

function loadComboSchemas(): PinnedExports {
  const loadConstant = (path: string) => loadPinnedModule(path, specifier => {
    throw new Error(`Unexpected import in pinned combo schema constant ${path}: ${specifier}`);
  });
  const simpleConstants: Record<string, PinnedExports> = {
    "@omniroute/open-sse/config/serviceTier.ts": loadConstant("open-sse/config/serviceTier.ts"),
    "@/shared/constants/routingStrategies": loadConstant("src/shared/constants/routingStrategies.ts"),
    "@/shared/constants/batchEndpoints": loadConstant("src/shared/constants/batchEndpoints.ts"),
    "@/shared/constants/bodySize": loadConstant("src/shared/constants/bodySize.ts"),
    "@/shared/constants/comboConfigMode": loadConstant("src/shared/constants/comboConfigMode.ts"),
    "@/shared/constants/upstreamHeaders": loadConstant("src/shared/constants/upstreamHeaders.ts"),
    "@/shared/utils/runtimeTimeouts": loadConstant("src/shared/utils/runtimeTimeouts.ts"),
    "@/shared/constants/sidebarVisibility": loadPinnedModule("src/shared/constants/sidebarVisibility/types.ts", () => {
      throw new Error("Pinned sidebar visibility type constants have no runtime dependencies");
    }),
  };
  const combo = loadPinnedModule("src/shared/validation/schemas/combo.ts", specifier => {
    if (specifier === "zod") throw new Error("Zod is supplied directly by the pinned module loader");
    if (specifier === "@/shared/constants/providers") {
      // The in-memory provider catalog is empty. No optional-key providers exist in this fixture.
      return { providerAllowsOptionalApiKey: () => false };
    }
    const value = simpleConstants[specifier];
    if (value) return value;
    throw new Error(`Unapproved pinned combo-schema import: ${specifier}`);
  });
  const pagination = loadExtractedPinnedDeclarations(
    ["src/shared/validation/schemas/misc.ts"],
    ["paginationSchema"],
    specifier => { throw new Error(`Unapproved pinned pagination import: ${specifier}`); },
  );
  return { ...combo, ...pagination };
}

function loadPinnedComboStructure(): PinnedExports {
  const steps = loadPinnedModule("src/lib/combos/steps.ts", () => {
    throw new Error("Pinned combo-step normalizer has no runtime imports");
  });
  const modelParser = (value: unknown) => {
    if (typeof value !== "string") return { provider: null, providerAlias: null, model: null };
    const split = value.indexOf("/");
    return split > 0
      ? { provider: value.slice(0, split), providerAlias: null, model: value.slice(split + 1) }
      : { provider: null, providerAlias: null, model: value };
  };
  const targetSorters = loadPinnedModule("open-sse/services/combo/targetSorters.ts", specifier => {
    if (specifier === "../../../src/shared/utils/circuitBreaker") return { getCircuitBreaker: () => { throw new Error("Combo sorter circuit-breaker adapter is outside this fixture"); } };
    if (specifier === "../../../src/shared/utils/secureRandom") return {
      secureRandomFloat: () => { throw new Error("Random target selection is outside this fixture"); },
      secureRandomInt: () => { throw new Error("Random target selection is outside this fixture"); },
    };
    if (specifier === "../../../src/lib/combos/steps.ts") return steps;
    if (specifier === "../comboMetrics.ts") return { getComboMetrics: () => { throw new Error("Target metrics are outside this fixture"); } };
    if (specifier === "../model.ts") return { parseModel: modelParser };
    if (specifier === "./types.ts") return {};
    throw new Error(`Unapproved pinned combo-target-sorter import: ${specifier}`);
  });
  const comboData = loadPinnedModule("open-sse/services/combo/comboData.ts", () => {
    throw new Error("Pinned combo-data module has no runtime imports");
  });
  const depthPolicy = loadExtractedPinnedDeclarations(
    ["open-sse/services/combo/comboPredicates.ts"],
    ["MAX_COMBO_DEPTH", "MAX_COMBO_DEPTH_HARD_CAP", "clampComboDepth"],
    () => { throw new Error("Pinned combo-depth policy is declared locally"); },
  );
  const prefillError = loadPinnedModule("open-sse/services/assistantPrefillError.ts", specifier => { throw new Error(`Unapproved prefill error import: ${specifier}`); });
  const bridgeFailure = loadPinnedModule("open-sse/utils/chatgptWebBridgeFailure.ts", specifier => { throw new Error(`Unapproved bridge-failure import: ${specifier}`); });
  const drainStatus = loadPinnedModule("open-sse/utils/drainStatus.ts", specifier => { throw new Error(`Unapproved drain-status import: ${specifier}`); });
  const modelAccessDenied = loadPinnedModule("open-sse/services/modelAccessDenied.ts", specifier => {
    if (specifier === "./assistantPrefillError.ts") return prefillError;
    throw new Error(`Unapproved pinned model-access import: ${specifier}`);
  });
  const visibility = loadPinnedModule("open-sse/services/combo/comboVisibility.ts", specifier => {
    if (specifier === "../../../src/lib/db/models") return { getHiddenModelsByProvider: () => new Map() };
    if (specifier === "../model.ts") return { parseModel: modelParser };
    if (specifier === "../../../src/lib/hiddenModelLookup") return {
      createHiddenModelLookup: () => (_provider: string | null, _model: string) => false,
    };
    if (specifier === "./types.ts") return {};
    throw new Error(`Unapproved pinned combo-visibility import: ${specifier}`);
  });
  const unsupportedPredicate = () => { throw new Error("Unrelated combo predicate is outside this fixture"); };
  const predicateConstants = loadExtractedPinnedDeclarations(["open-sse/config/constants.ts"], ["EXECUTOR_CONTRACT_VIOLATION_CODE", "DEVIN_BRIDGE_NOT_CONFIGURED_CODE", "UNSAFE_DEVIN_HOME_CODE", "LOCAL_CONFIGURATION_ERROR_CODES"], specifier => { throw new Error(`Unapproved predicate constant import: ${specifier}`); });
  const comboPredicates = loadPinnedModule("open-sse/services/combo/comboPredicates.ts", specifier => {
    if (specifier === "../../config/constants.ts") return predicateConstants;
    if (specifier === "../antigravityQuotaFamily.ts") return { finitePercentUsed: unsupportedPredicate, remainingPercentFromQuotaWindows: unsupportedPredicate };
    if (specifier === "../../utils/error.ts") return { errorResponse: unsupportedPredicate };
    if (specifier === "../../utils/contentPolicyError.ts") return { isContentPolicyRefusal: unsupportedPredicate };
    if (specifier === "../model.ts") return { parseModel: modelParser };
    if (specifier === "../../handlers/chatCore/cooldownClassification.ts") return { isSelfInflictedUpstreamTimeout: unsupportedPredicate };
    if (specifier === "@/shared/utils/circuitBreaker") return {
      isLocalStreamLifecycleError: unsupportedPredicate,
      isLocalExecutionError: unsupportedPredicate,
      isModelCapacityOverloadError: unsupportedPredicate,
    };
    if (specifier === "../accountFallback.ts") return {
      CONTEXT_OVERFLOW_PATTERNS: [/context/],
      PARAM_VALIDATION_PATTERNS: [/parameter/],
      RATE_LIMIT_TEXT_PATTERNS: [/rate/],
      AUTH_CREDENTIAL_ERROR_PATTERNS: [/auth/],
      isProviderModelUnsupported400: unsupportedPredicate,
      cooldownUntilMs: unsupportedPredicate,
    };
    if (specifier === "../accountFallback/requestScoped400.ts") return { isRequestScoped400: unsupportedPredicate };
    if (specifier === "../accountFallback/perModelFailureScope.ts") return { hasPerModelFailureScope: unsupportedPredicate, isExplicitModelCapacityFailure: unsupportedPredicate, isModelUnsupported401: unsupportedPredicate, isModelNotFound404: unsupportedPredicate };
    if (specifier === "../errorClassifier.ts") return { isResourceNotFoundResponse: unsupportedPredicate };
    if (specifier === "../../executors/opencodeGeoBlock.ts") return { isOpencodeFreeTierRefusal: unsupportedPredicate };
    if (specifier === "../rateLimitManager/errors.ts") return { getTrustedLocalRateLimitResponse: unsupportedPredicate };
    if (specifier === "../../handlers/chatCore/translationFailure.ts") return { TRANSLATION_FAILURE_CODE: "FIXTURE_UNRELATED" };
    if (specifier === "../resolvedModelAccess.ts") return { isLocalModelPolicyResponse: unsupportedPredicate };
    if (specifier === "./comboErrorAggregation.ts") return { classifyComboOutcome: unsupportedPredicate };
    if (specifier === "../assistantPrefillError.ts") return prefillError;
    if (specifier === "../../utils/chatgptWebBridgeFailure.ts") return bridgeFailure;
    if (specifier === "../../utils/drainStatus.ts") return drainStatus;
    if (specifier === "../modelAccessDenied.ts") return modelAccessDenied;
    if (specifier === "./types.ts" || specifier === "./validateQuality.ts") return {};
    throw new Error(`Unapproved pinned combo-predicate import: ${specifier}`);
  });
  const mediaCompatibility = loadPinnedModule("open-sse/services/combo/mediaCompatibility.ts", specifier => {
    if (specifier === "../../utils/mediaParts.ts") return { containsMediaKind: unsupportedPredicate };
    if (specifier === "../../utils/ciTransportInput.ts") return { ciTransportSupportsInput: unsupportedPredicate };
    if (specifier === "../modelCapabilities.ts") return { getInputModalities: unsupportedPredicate, getResolvedModelCapabilities: unsupportedPredicate, isTextOnlyChatTransport: unsupportedPredicate };
    throw new Error(`Unapproved media-compatibility import: ${specifier}`);
  });
  const structure = loadPinnedModule("open-sse/services/combo/comboStructure.ts", specifier => {
    if (specifier === "../../../src/lib/modelCapabilities") return {
      getModelContextLimit: () => { throw new Error("Model context catalog is outside this fixture"); },
    };
    if (specifier === "../../../src/lib/db/models") return { getHiddenModelsByProvider: () => new Map() };
    if (specifier === "../../../src/lib/combos/steps.ts") return steps;
    if (specifier === "../../../src/shared/constants/providers.ts") return {
      getProviderByAlias: () => null,
      getProviderById: () => null,
    };
    if (specifier === "../contextManager.ts") return { estimateTokens: () => { throw new Error("Token estimation is outside this fixture"); } };
    if (specifier === "../../utils/mediaParts.ts") return { containsMediaKind: () => { throw new Error("Media compatibility is outside this fixture"); } };
    if (specifier === "../modelCapabilities.ts") return { getResolvedModelCapabilities: () => null };
    if (specifier === "../model.ts") return { parseModel: modelParser, stripContextWindowSuffix: (value: string) => value };
    if (specifier === "./comboData.ts") return comboData;
    if (specifier === "./comboVisibility.ts") return visibility;
    if (specifier === "./comboPredicates.ts") return comboPredicates;
    if (specifier === "./mediaCompatibility.ts") return mediaCompatibility;
    if (specifier === "./contextOverrideGate.ts") return {
      evaluateContextLimit: () => { throw new Error("Context override evaluation is outside this fixture"); },
      getModelContextOverrideValue: () => null,
    };
    if (specifier === "./targetSorters.ts") return targetSorters;
    if (specifier === "./types.ts") return {};
    throw new Error(`Unapproved pinned combo-structure import: ${specifier}`);
  });
  return { ...structure, ...depthPolicy };
}

const fixtureProviderConnection = {
  id: "fixture-connection",
  provider: "fixture",
  authType: "api_key",
  apiKey: "fixture-provider-secret",
  lastError: "fixture-provider-secret",
  name: "Fixture account",
  isActive: true,
  defaultModel: "chat",
  priority: 0,
  providerSpecificData: null,
};
const fixtureProviderModels = [
  { id: "chat", name: "Fixture Chat", supportedEndpoints: ["chat"], contextWindow: 65_536, outputTokenLimit: 4_096 },
];

function loadPinnedVirtualFactory(suffixComposition: PinnedExports, modelFamily: PinnedExports, breakerState: () => string): PinnedExports {
  const scoring = loadPinnedModule("open-sse/services/autoCombo/scoring.ts", specifier => {
    if (specifier === "../manifestAdapter") return {};
    if (specifier === "../../utils/number") return { clamp01: (value: number) => Math.max(0, Math.min(1, value)) };
    if (specifier === "../tierResolver") return { classifyTier: () => null };
    throw new Error(`Unapproved pinned auto-scoring import: ${specifier}`);
  });
  const modePacks = loadPinnedModule("open-sse/services/autoCombo/modePacks.ts", () => {
    throw new Error("Pinned auto mode packs have no runtime imports");
  });
  const breaker = loadPinnedModule("open-sse/services/autoCombo/snapshotBreaker.ts", specifier => {
    if (specifier === "../../../src/shared/utils/circuitBreaker.ts") return {
      getCircuitBreaker: () => ({ getStatus: () => ({ state: breakerState() }) }),
    };
    throw new Error(`Unapproved pinned auto-breaker import: ${specifier}`);
  });
  const modelCapabilities = {
    createModelCapabilityResolutionSnapshot: () => ({}),
    getResolvedModelCapabilities: () => ({ contextWindow: 65_536, maxOutputTokens: 4_096, supportsVision: false, reasoning: false, supportsThinking: false }),
  };
  const tokenLimit = { getTokenLimit: () => 65_536 };
  const advertisedLimits = loadPinnedModule("open-sse/services/autoCombo/advertisedLimits.ts", specifier => {
    if (specifier === "@/lib/modelCapabilities") return modelCapabilities;
    if (specifier === "../contextManager") return tokenLimit;
    throw new Error(`Unapproved pinned auto-advertised-limits import: ${specifier}`);
  });
  const fixtureModelIds = new Set(fixtureProviderModels.map(model => model.id));
  const candidatesWithoutRestrictions = (candidates: unknown[]) => candidates;
  const diagnosticPoolWithoutRestrictions = (candidates: unknown[]) => ({ pool: candidates });
  const virtualFactoryDependencies: Record<string, unknown> = {
    "./emulatedNoAuthAllowlist": { getAutoRoutableEmulatedNoAuthProviders: () => new Set<string>() },
    "./engine": {},
    "./modePacks": modePacks,
    "./scoring": scoring,
    "@/lib/db/readCache": {
      getCachedProviderConnections: async (options: { isActive: boolean }) => options.isActive ? [fixtureProviderConnection] : [],
    },
    "@/lib/db/settings": { getSettings: async () => ({}) },
    "./providerRegistryAccessor": { getProviderRegistry: () => ({ fixture: { alias: "fixture", models: fixtureProviderModels } }) },
    "@/shared/constants/providers": { NOAUTH_PROVIDERS: {} },
    "@/shared/constants/designerWebRetirement": { isMicrosoftDesignerWebRetiredProviderId: () => false },
    "@/shared/constants/providerRetirement": { isRuntimeRetiredProviderId: () => false },
    "@/shared/constants/chatgptWebRetirement": { isCommonChatGptWebRetiredProviderId: () => false },
    "@/shared/providers/webSessionCredentials": { hasUsableWebSessionCredential: () => false },
    "@/shared/utils/numeric": { toNumber: (value: unknown, fallback: number) => Number.isFinite(Number(value)) ? Number(value) : fallback },
    "@/shared/utils/compatibleProviderId": { isCompatibleProviderConnectionId: (provider: string) => provider.startsWith("openai-compatible-") || provider.startsWith("anthropic-compatible-") },
    "@omniroute/open-sse/utils/logger": { defaultLogger: { warn: () => undefined, info: () => undefined, error: () => undefined } },
    "../contextManager": tokenLimit,
    "@/lib/modelCapabilities": modelCapabilities,
    "./suffixComposition": suffixComposition,
    "../tierResolver": { classifyTier: () => null },
    "../routing/quality.ts": { getQualityScore: () => 0.5 },
    "./snapshotBreaker.ts": breaker,
    "../providerCostData": { resolveVirtualCost: () => 0 },
    "./autoPrefix": {},
    "./modelFamily": modelFamily,
    "@/models": { getHiddenModelsByProvider: () => new Map<string, Set<string>>() },
    "@/lib/db/models": {
      getSyncedAvailableModelsByConnection: async () => ({ [fixtureProviderConnection.id]: fixtureProviderModels }),
      getCustomModels: async () => [],
    },
    "./paidModelFilter": { filterPaidOnlyCandidatesWithDiagnosis: (candidates: unknown[]) => ({ pool: candidates }) },
    "./modelLockoutFilter": { filterLockoutCandidates: diagnosticPoolWithoutRestrictions, warnPoolDrop: () => undefined },
    "./modelExposureFilter": { filterModelExposureCandidates: candidatesWithoutRestrictions },
    "./failClosedPool": { failClosedAutoConfig: () => ({}) },
    "./subscriptionLadder": { filterSubscriptionOnlyCandidates: candidatesWithoutRestrictions, orderPoolByRung: candidatesWithoutRestrictions },
    "./strictZeroCostFilter": {
      classifyStrictZeroCostCandidate: () => ({ outcome: "safe" }),
      describeStrictExclusions: () => "",
      filterStrictZeroCostCandidatesWithDiagnosis: (candidates: unknown[], options: { enabled: boolean }) => {
        if (options.enabled) throw new Error("Strict zero-cost state is not configured in this fixture");
        return diagnosticPoolWithoutRestrictions(candidates);
      },
      filterTosAvoidCandidates: (candidates: unknown[], exclude: boolean) => {
        if (exclude) throw new Error("ToS exclusion state is not configured in this fixture");
        return candidates;
      },
      findBudgetEntry: () => undefined,
    },
    "./freeAccessQuota": { resolveFreeAccessState: () => { throw new Error("Quota state is outside this fixture"); } },
    "@/domain/connectionModelRules": { isModelExcludedByConnection: (model: string) => !fixtureModelIds.has(model) },
    "../model.ts": { resolveProviderAlias: (provider: string) => provider },
    "./candidateOverrides": { filterExcludedCandidates: candidatesWithoutRestrictions },
    "@/lib/db/autoCandidateOverrides": { getExcludedConnectionIds: async () => new Set<string>() },
    "./noAuthReadiness": { isNoAuthProviderReadyForAutoRouting: () => false },
    "./resilienceCandidateFilter": {
      filterResilienceBlockedCandidates: candidatesWithoutRestrictions,
      buildConnectionResilienceMap: () => new Map<string, unknown>(),
      SYNTHETIC_NOAUTH_CONNECTION_ID: "fixture-no-auth",
    },
    "./autoEvaluationTrace": {
      applyTracedPoolStage: (_id: unknown, _previous: unknown, next: unknown) => next,
      recordAutoCandidatePool: () => undefined,
      recordAutoDroppedCandidates: () => undefined,
      recordAutoSurvivors: () => undefined,
    },
    "./advertisedLimits": advertisedLimits,
    "../../utils/numeric.ts": loadPinnedModule("open-sse/utils/numeric.ts", specifier => { throw new Error(`Unapproved numeric helper import: ${specifier}`); }),
    "./cooperativeYield": loadPinnedModule("open-sse/services/autoCombo/cooperativeYield.ts", specifier => { throw new Error(`Unapproved cooperative scheduling import: ${specifier}`); }),
  };
  return loadPinnedModule("open-sse/services/autoCombo/virtualFactory.ts", specifier => {
    if (Object.hasOwn(virtualFactoryDependencies, specifier)) return virtualFactoryDependencies[specifier];
    throw new Error(`Unapproved pinned virtual-auto import: ${specifier}`);
  });
}

function loadPinnedMediaCatalogs(): Record<string, PinnedExports> {
  const allowed: Record<string, true> = {
    "open-sse/config/imageRegistry.ts": true, "open-sse/config/imageRegistryData.ts": true,
    "open-sse/config/audioRegistry.ts": true, "open-sse/config/videoRegistry.ts": true,
    "open-sse/config/dynamicImageModelSources.ts": true, "open-sse/config/grokBuildEndpoints.ts": true,
    "open-sse/config/runway.ts": true, "open-sse/config/museCode.ts": true, "open-sse/utils/urlSanitize.ts": true,
    "open-sse/config/providers/registry/lmarena/directModels.ts": true, "open-sse/config/providers/registry/segmind/imageModels.ts": true,
    "open-sse/config/providers/registry/segmind/videoModels.ts": true, "open-sse/config/providers/registry/kie/imageModels.ts": true,
    "open-sse/config/providers/registry/magnific/index.ts": true, "open-sse/config/providers/registry/stability-ai/imageModels.ts": true,
    "open-sse/config/providers/registry/cheaperinference/imageModels.ts": true, "open-sse/config/providers/registry/aihorde/imageModels.ts": true,
    "open-sse/config/providers/registry/zenmux/imageModels.ts": true, "open-sse/config/providers/registry/muse-code/imageModels.ts": true,
    "open-sse/config/providers/registry/codex/imageModels.ts": true, "open-sse/services/adobeFireflyModels.ts": true,
    "open-sse/services/adobeFireflyModelSnapshot.ts": true, "open-sse/services/syntxMediaCatalog.ts": true, "open-sse/services/syntxAuth.ts": true,
  };
  const cache = new Map<string, PinnedExports>();
  const outsideFixture = () => { throw new Error("Unrelated media catalog branch is outside this fixture"); };
  const load = (path: string): PinnedExports => {
    const cached = cache.get(path);
    if (cached) return cached;
    if (!Object.hasOwn(allowed, path)) throw new Error(`Unapproved pinned media catalog module: ${path}`);
    const result = loadPinnedModule(path, specifier => {
      if (path.endsWith("/imageRegistry.ts") && specifier === "@/shared/utils/featureFlagResolverBridge.ts") return { resolveRegisteredFeatureFlag: () => false };
      if (path.endsWith("/imageRegistry.ts") && specifier === "./providerModels.ts") return { getModelsByProviderId: outsideFixture };
      if (path.endsWith("/videoRegistry.ts") && specifier === "./grokBuild.ts") return load("open-sse/config/grokBuildEndpoints.ts");
      if (path.endsWith("/videoRegistry.ts") && specifier === "./registryUtils.ts") return { parseModelFromRegistry: outsideFixture };
      if (path.endsWith("/audioRegistry.ts") && specifier === "@/shared/constants/providers") return { getProviderAlias: outsideFixture };
      if (path.endsWith("/audioRegistry.ts") && specifier === "@/shared/network/loopbackNodeHost") return { isLoopbackNodeHost: outsideFixture };
      if (specifier === "../utils/modelIdSafety.ts") return { hasUnsafeModelIdSyntax: outsideFixture };
      if (!specifier.startsWith(".")) throw new Error(`Unapproved pinned media import ${specifier} from ${path}`);
      return load(posix.normalize(posix.join(posix.dirname(path), specifier)));
    });
    cache.set(path, result);
    return result;
  };
  return {
    "@omniroute/open-sse/config/imageRegistry.ts": load("open-sse/config/imageRegistry.ts"),
    "@omniroute/open-sse/config/audioRegistry.ts": load("open-sse/config/audioRegistry.ts"),
    "@omniroute/open-sse/config/videoRegistry.ts": load("open-sse/config/videoRegistry.ts"),
  };
}

function loadComboRoutes(options: {
  authorization: PinnedManagementAuthorization;
  store: ComboStore;
  apiPort: () => number;
  uuid: () => string;
  date: DateConstructor;
  breakerState: () => string;
}): { routes: PinnedComboHandlers["routes"]; metrics: PinnedComboMetrics } {
  const { authorization, store } = options;
  const next = { NextResponse: nextResponse };
  const steps = loadPinnedModule("src/lib/combos/steps.ts", () => {
    throw new Error("Pinned combo-step normalizer has no runtime imports");
  });
  const schema = loadComboSchemas();
  const validationHelpers = loadPinnedModule("src/shared/validation/helpers.ts", specifier => {
    if (specifier === "next/server") return next;
    throw new Error(`Unapproved pinned combo-validation import: ${specifier}`);
  });
  const compositeTiers = loadPinnedModule("src/lib/combos/compositeTiers.ts", specifier => {
    if (specifier === "@/lib/combos/steps") return steps;
    throw new Error(`Unapproved pinned combo-tier import: ${specifier}`);
  });
  const invariants = loadPinnedModule("src/lib/combos/invariants.ts", () => {
    throw new Error("Pinned combo-invariant module has no runtime imports");
  });
  const deadKeys = loadPinnedModule("src/lib/combos/deadConfigKeys.ts", () => {
    throw new Error("Pinned dead-combo-config module has no runtime imports");
  });
  const accountLabels = loadPinnedModule("src/lib/combos/controlCenterAccountLabels.ts", specifier => {
    if (specifier === "./steps") return steps;
    if (specifier === "@/lib/db/providers") return {
      getProviderConnectionDisplayMetadata: (ids: string[]) => ids.includes(fixtureProviderConnection.id) ? [fixtureProviderConnection] : [],
    };
    throw new Error(`Unapproved pinned combo account-label import: ${specifier}`);
  });
  const structure = loadPinnedComboStructure();
  const comboContext = loadPinnedModule("src/lib/combos/comboContext.ts", specifier => {
    if (specifier === "@omniroute/open-sse/services/combo") return structure;
    if (specifier === "@/lib/modelMetadataRegistry") return { getCanonicalModelMetadata: () => null };
    if (specifier === "@omniroute/open-sse/services/contextManager") return { getSourcedTokenLimit: () => undefined };
    if (specifier === "@/app/api/v1/models/catalogProviderMaps") return {
      buildAliasMaps: () => ({}),
      getComboTargetModelId: () => null,
    };
    throw new Error(`Unapproved pinned combo-context import: ${specifier}`);
  });
  const modelNameCollision = loadPinnedModule("src/lib/combos/modelNameCollision.ts", specifier => {
    if (specifier === "@/shared/constants/models") return { PROVIDER_MODELS: {} };
    throw new Error(`Unapproved pinned combo-name import: ${specifier}`);
  });
  const comboErrorResponse = loadPinnedModule("src/lib/api/comboErrorResponse.ts", specifier => {
    if (specifier === "@/shared/constants/errorCodes") return loadPinnedModule("src/shared/constants/errorCodes.ts", () => {
      throw new Error("Pinned error-code constants have no runtime imports");
    });
    if (specifier === "@/shared/utils/requestId") return {
      attachRequestIdToResponse: (_request: Request, response: Response) => response,
      getRequestId: () => undefined,
    };
    throw new Error(`Unapproved pinned combo-error import: ${specifier}`);
  });
  const comboService = structure;
  const apiAuth = { requireManagementAuth: (request: Request) => authorization.requireManagementAuth(request) };
  const db = {
    getCombos: store.getCombos,
    getCombosCount: store.getCombosCount,
    getComboById: store.getComboById,
    getComboByName: store.getComboByName,
    createCombo: store.createCombo,
    updateCombo: store.updateCombo,
    deleteCombo: store.deleteCombo,
    reorderCombos: store.reorderCombos,
  };
  const common: Record<string, unknown> = {
    "next/server": next,
    "@/lib/db/combos": db,
    "@/lib/db/settings": { isCloudEnabled: async () => false },
    "@/shared/utils/machineId": { getConsistentMachineId: async () => "fixture-machine" },
    "@/lib/cloudSync": { syncToCloud: async () => { throw new Error("Cloud sync is disabled in the fixture"); } },
    "@/lib/combos/compositeTiers": compositeTiers,
    "@/lib/combos/steps": steps,
    "@omniroute/open-sse/services/combo.ts": comboService,
    "@omniroute/open-sse/services/combo": comboService,
    "@omniroute/open-sse/services/model.ts": { resolveCanonicalProviderModel: (provider: string, model: string) => ({ provider, model }) },
    "@/shared/validation/schemas": schema,
    "@/shared/validation/schemas/combo": schema,
    "@/shared/validation/helpers": validationHelpers,
    "@/lib/api/requireManagementAuth": apiAuth,
    "@/lib/api/comboErrorResponse": comboErrorResponse,
    "@/lib/combos/comboContext": comboContext,
    "@/lib/combos/invariants": invariants,
    "@/lib/combos/modelNameCollision": modelNameCollision,
    "@/lib/combos/deadConfigKeys": deadKeys,
    "@/lib/combos/controlCenterAccountLabels": accountLabels,
  };
  const loadRoute = (path: string, extra: Record<string, unknown> = {}) => loadPinnedModule(path, specifier => {
    if (Object.hasOwn(extra, specifier)) return extra[specifier];
    if (Object.hasOwn(common, specifier)) return common[specifier];
    throw new Error(`Unapproved pinned combo route import ${specifier} from ${path}`);
  }, { date: options.date });
  const autoPrefix = loadPinnedModule("open-sse/services/autoCombo/autoPrefix.ts", () => {
    throw new Error("Pinned auto prefix module has no runtime imports");
  });
  const modelFamily = loadPinnedModule("open-sse/services/autoCombo/modelFamily.ts", () => {
    throw new Error("Pinned model-family module has no runtime imports");
  });
  const visionModels = loadPinnedModule("src/shared/constants/visionModels.ts", specifier => {
    throw new Error(`Unapproved pinned vision-model import: ${specifier}`);
  });
  const visionBridge = loadPinnedModule("src/shared/constants/visionBridgeDefaults.ts", specifier => {
    throw new Error(`Unapproved pinned vision-bridge import: ${specifier}`);
  });
  const suffixComposition = loadPinnedModule("open-sse/services/autoCombo/suffixComposition.ts", specifier => {
    if (specifier === "../tierResolver") return { classifyTier: () => { throw new Error("Tier catalog is outside this fixture"); } };
    if (specifier === "@/lib/modelCapabilities") return { getResolvedModelCapabilities: () => null };
    if (specifier === "@/shared/constants/visionModels") return visionModels;
    if (specifier === "@/shared/constants/visionBridgeDefaults") return visionBridge;
    throw new Error(`Unapproved pinned auto-suffix import: ${specifier}`);
  });
  const virtualFactory = loadPinnedVirtualFactory(suffixComposition, modelFamily, options.breakerState);
  const builtinCatalog = loadPinnedModule("open-sse/services/autoCombo/builtinCatalog.ts", specifier => {
    if (specifier === "./autoPrefix") return autoPrefix;
    if (specifier === "./suffixComposition") return suffixComposition;
    if (specifier === "./modelFamily") return modelFamily;
    if (specifier === "./virtualFactory.ts") return virtualFactory;
    throw new Error(`Unapproved pinned auto-catalog import: ${specifier}`);
  });
  const autoVirtual = loadPinnedModule("src/lib/combos/autoVirtual.ts", specifier => {
    if (specifier === "@omniroute/open-sse/services/autoCombo/virtualFactory") return virtualFactory;
    if (specifier === "@omniroute/open-sse/services/autoCombo/builtinCatalog") return builtinCatalog;
    throw new Error(`Unapproved pinned auto-virtual import: ${specifier}`);
  });
  const metricsModule = loadPinnedModule("open-sse/services/comboMetrics.ts", specifier => {
    if (specifier === "./autoCombo/providerDiversity") return { recordProviderUsage: () => undefined };
    throw new Error(`Unapproved pinned combo-metrics import: ${specifier}`);
  }, { date: options.date });
  for (const exportName of ["getAllComboMetrics", "getComboMetrics", "recordComboRequest", "recordComboIntent", "resetComboMetrics", "resetAllComboMetrics"]) {
    if (typeof metricsModule[exportName] !== "function") throw new Error(`Pinned combo metrics omitted ${exportName}`);
  }
  const metrics = metricsModule as unknown as PinnedComboMetrics;
  const mediaCatalogs = loadPinnedMediaCatalogs();
  const builderOptions = loadPinnedModule("src/lib/combos/builderOptions.ts", specifier => {
    if (Object.hasOwn(mediaCatalogs, specifier)) return mediaCatalogs[specifier];
    if (specifier === "@/lib/db/models") return {
      getAllCustomModels: async () => ({}),
      getAllSyncedAvailableModels: async () => ({ fixture: fixtureProviderModels }),
      getModelIsHidden: () => false,
    };
    if (specifier === "@/lib/db/combos") return db;
    if (specifier === "@/lib/db/providers") return {
      getProviderConnections: async () => [fixtureProviderConnection],
      getProviderNodes: async () => [{ id: "fixture", type: "openai-compatible", name: "Fixture", prefix: "fixture" }],
    };
    if (specifier === "@/lib/db/settings") return { getSettings: async () => ({}) };
    if (specifier === "@/lib/display/names") return { getAccountDisplayName: (connection: Record<string, unknown>) => String(connection.name ?? "Fixture"), getProviderDisplayName: (provider: string) => provider };
    if (specifier === "@/lib/providers/managedAvailableModels") return { getCompatibleFallbackModels: async () => [] };
    if (specifier === "@/lib/modelCapabilities") return { getResolvedModelCapabilities: () => ({ contextWindow: 65_536, maxOutputTokens: 4_096, supportsThinking: false }) };
    if (specifier === "@/lib/modelsDevSync") return { getSyncedCapabilities: () => null };
    if (specifier === "@/shared/constants/models") return { getModelsByProviderId: () => fixtureProviderModels };
    if (specifier === "@/shared/constants/providers") return { AI_PROVIDERS: {}, NOAUTH_PROVIDERS: {}, isAnthropicCompatibleProvider: () => false, isClaudeCodeCompatibleProvider: () => false, isOpenAICompatibleProvider: () => false };
    if (specifier === "@omniroute/open-sse/utils/syncedEffortVariants") return { appendSyncedEffortVariants: (models: unknown[]) => models };
    if (specifier === "@omniroute/open-sse/config/providerRegistry.ts") return {};
    throw new Error(`Unapproved pinned combo-builder import: ${specifier}`);
  }, { date: options.date });
  const staleModelRefs = loadPinnedModule("src/lib/combos/staleModelRefs.ts", specifier => {
    if (specifier === "@/lib/db/combos") return db;
    if (specifier === "./steps") return steps;
    if (specifier === "@/lib/db/models/activeSyncedCatalog") return {
      getActiveSyncedCatalog: async (provider: string) => ({ authoritative: provider === "fixture" }),
    };
    if (specifier === "@/sse/services/model") return {
      parseModel: (value: string) => ({ provider: value.split("/")[0] }),
      getModelInfo: async (value: string) => fixtureProviderModels.some(model => `fixture/${model.id}` === value) ? {} : { errorType: "model_not_found" },
    };
    throw new Error(`Unapproved pinned stale-combo-reference import: ${specifier}`);
  });
  const sourceModuleMap: Record<string, PinnedExports> = {
    "src/app/api/combos/route.ts": loadRoute("src/app/api/combos/route.ts"),
    "src/app/api/combos/[id]/route.ts": loadRoute("src/app/api/combos/[id]/route.ts", {
      "@/lib/quota/quotaModelNaming": loadPinnedModule("src/lib/quota/quotaModelNaming.ts", () => { throw new Error("Pinned quota naming has no runtime imports"); }),
    }),
    "src/app/api/combos/auto/route.ts": loadRoute("src/app/api/combos/auto/route.ts", {
      "@/lib/combos/autoVirtual": autoVirtual,
      "@omniroute/open-sse/services/autoCombo/autoPrefix": autoPrefix,
      "@omniroute/open-sse/services/autoCombo/builtinCatalog": builtinCatalog,
      "@omniroute/open-sse/services/autoCombo/suffixComposition": suffixComposition,
      "@omniroute/open-sse/services/autoCombo/virtualFactory": virtualFactory,
    }),
    "src/app/api/combos/builder/options/route.ts": loadRoute("src/app/api/combos/builder/options/route.ts", { "@/lib/combos/builderOptions": builderOptions, "@/lib/combos/staleModelRefs": staleModelRefs }),
    "src/app/api/combos/metrics/route.ts": loadRoute("src/app/api/combos/metrics/route.ts", { "@omniroute/open-sse/services/comboMetrics.ts": metrics }),
    "src/app/api/combos/duplicate/route.ts": loadRoute("src/app/api/combos/duplicate/route.ts", {
      "@/lib/combos/snapshotWeights": loadPinnedModule("src/lib/combos/snapshotWeights.ts", () => { throw new Error("Pinned snapshot weight normalizer has no runtime imports"); }),
      "@omniroute/open-sse/services/autoCombo/builtinCatalog": builtinCatalog,
      "@omniroute/open-sse/services/autoCombo/autoPrefix": autoPrefix,
      "@omniroute/open-sse/services/autoCombo/virtualFactory": virtualFactory,
      "@omniroute/open-sse/services/autoCombo/modelFamily": modelFamily,
      "@omniroute/open-sse/utils/error": { buildErrorBody: (status: number, message: string) => ({ error: { status, message } }) },
    }),
    "src/app/api/combos/reorder/route.ts": loadRoute("src/app/api/combos/reorder/route.ts"),
    "src/app/api/combos/test/route.ts": loadRoute("src/app/api/combos/test/route.ts", {
      "node:crypto": { randomUUID: options.uuid },
      "@/lib/db/apiKeys": { pickApiKeyForInternalUse: async () => "fixture-internal-api-key" },
      "@/lib/combos/testHealth": loadPinnedModule("src/lib/combos/testHealth.ts", () => { throw new Error("Pinned combo-test health helper has no runtime imports"); }),
      "@/lib/api/modelTestRunner": loadPinnedModelTestRunner(options),
      "@/lib/runtime/ports": { getRuntimePorts: () => ({ apiPort: options.apiPort() }) },
      "@/shared/providers/webSessionCredentials": { requiresWebSessionCredential: () => false },
      "@omniroute/open-sse/utils/error": { sanitizeErrorMessage: (message: string) => message },
      "@/lib/combos/autoVirtual": autoVirtual,
      "@omniroute/open-sse/services/combo.ts": structure,
    }),
  };
  return { routes: sourceModuleMap, metrics };
}

function loadPinnedModelTestRunner(options: { readonly uuid: () => string; readonly date: DateConstructor }): PinnedExports {
  const testHealth = loadPinnedModule("src/lib/combos/testHealth.ts", specifier => {
    throw new Error("Unapproved pinned combo-health import: " + specifier);
  });
  const unusedRuntime = (..._args: unknown[]) => {
    throw new Error("Unrelated model-test runtime behavior is outside this fixture");
  };
  return loadPinnedModule("src/lib/api/modelTestRunner.ts", specifier => {
    if (specifier === "node:crypto") return { randomUUID: options.uuid };
    if (specifier === "@/lib/combos/testHealth") return testHealth;
    if (specifier === "@/lib/providerModels/prepareConnectionModelTest") return { prepareConnectionModelTest: unusedRuntime };
    if (specifier === "@/app/api/v1/chat/completions/route") return { POST: unusedRuntime };
    if (specifier === "@/app/api/v1/audio/speech/route") return { POST: unusedRuntime };
    if (specifier === "@/app/api/v1/audio/transcriptions/route") return { POST: unusedRuntime };
    if (specifier === "@/app/api/v1/embeddings/route") return { handleValidatedEmbeddingRequestBody: unusedRuntime };
    if (specifier === "@/app/api/v1/rerank/route") return { POST: unusedRuntime };
    if (specifier === "@/app/api/v1/responses/route") return { POST: unusedRuntime };
    if (specifier === "@/lib/db/models") return { getCustomModels: unusedRuntime };
    if (specifier === "@/lib/db/providers") return { getProviderNodeById: unusedRuntime };
    if (specifier === "@/shared/providers/webSessionCredentials") return { requiresWebSessionCredential: unusedRuntime };
    if (specifier === "@omniroute/open-sse/utils/error") return { sanitizeErrorMessage: unusedRuntime };
    if (specifier === "@omniroute/open-sse/config/imageRegistry") return { isImageOnlyModel: unusedRuntime };
    if (specifier === "@omniroute/open-sse/services/rateLimitManager") return { withRateLimit: unusedRuntime };
    if (specifier === "@omniroute/open-sse/services/accountFallback") return { isCreditsExhausted: unusedRuntime, isDailyQuotaExhausted: unusedRuntime };
    if (specifier === "@/shared/utils/classify429") return { looksLikeQuotaExhausted: unusedRuntime };
    if (specifier === "@omniroute/open-sse/services/rateLimitManager/errors") return { getTrustedLocalRateLimitError: unusedRuntime };
    if (specifier === "@/shared/utils/probeOrigin") return { runAsProbe: unusedRuntime };
    if (specifier === "@/lib/exclusiveLeaseIsolation") return { isConnectionUnavailableToAuxiliaryActivity: unusedRuntime };
    if (specifier === "@/shared/middleware/chatAdmissionIdentity") return { resolveSelfLoopBearer: unusedRuntime };
    throw new Error("Unapproved pinned model-test import: " + specifier);
  }, { date: options.date });
}

export function createPinnedComboHandlers(options: {
  authorization: PinnedManagementAuthorization;
  store: ComboStore;
  apiPort: () => number;
  uuid?: () => string;
  date?: DateConstructor;
  breakerState?: () => string;
}): PinnedComboHandlers {
  const loaded = loadComboRoutes({
    ...options,
    uuid: options.uuid ?? randomUUID,
    date: options.date ?? globalThis.Date,
    breakerState: options.breakerState ?? (() => "CLOSED"),
  });
  return { authorization: options.authorization, routes: loaded.routes, metrics: loaded.metrics };
}

function isMappingRepository(value: unknown): value is MappingRepository {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return ["list", "findById", "create", "update", "deleteById", "resolveForModel"]
    .every(name => typeof candidate[name] === "function");
}

function loadMappingHandlers(options: {
  readonly authorization: PinnedManagementAuthorization;
  readonly db: Database;
  readonly uuid: () => string;
  readonly date: DateConstructor;
}): { collection: PinnedExports; item: PinnedExports; repository: MappingRepository; cacheVersions: () => { combos: number; catalog: number } } {
  const globPattern = loadPinnedModule("src/shared/utils/globPattern.ts", specifier => {
    throw new Error(`Unapproved pinned model-mapping glob import: ${specifier}`);
  });
  const repositoryModule = loadPinnedModule("src/lib/db/repositories/sqliteModelComboMappingRepository.ts", specifier => {
    if (specifier === "uuid") return { v4: options.uuid };
    if (specifier === "@/shared/utils/globPattern") return globPattern;
    if (specifier === "../core") return { getDbInstance: () => options.db };
    throw new Error(`Unapproved pinned SQLite model-mapping import: ${specifier}`);
  }, { date: options.date });
  const repository = repositoryModule.sqliteModelComboMappingRepository;
  if (!isMappingRepository(repository)) throw new Error("Pinned SQLite model-mapping repository omitted CRUD methods");

  const auth = { requireManagementAuth: (request: Request) => options.authorization.requireManagementAuth(request) };
  const helpers = loadPinnedModule("src/shared/validation/helpers.ts", specifier => {
    if (specifier === "next/server") return { NextResponse: nextResponse };
    throw new Error(`Unapproved pinned mapping-validation import: ${specifier}`);
  });
  const pagination = loadExtractedPinnedDeclarations(
    ["src/shared/validation/schemas/misc.ts"],
    ["paginationSchema"],
    specifier => { throw new Error(`Unapproved pinned pagination import: ${specifier}`); },
  );
  const readCache = loadPinnedModule("src/lib/db/readCache.ts", specifier => {
    throw new Error(`Unapproved pinned mapping read-cache import: ${specifier}`);
  });
  const db = loadPinnedModule("src/lib/db/modelComboMappings.ts", specifier => {
    if (specifier === "./repositories/routingConfigRepositories") {
      return { routingConfigRepositories: { modelComboMappings: repository } };
    }
    if (specifier === "./readCache") return readCache;
    throw new Error(`Unapproved pinned model-mapping persistence import: ${specifier}`);
  });
  const facadeExports = ["getModelComboMappings", "getModelComboMappingById", "createModelComboMapping", "updateModelComboMapping", "deleteModelComboMapping", "resolveComboForModel"];
  if (facadeExports.some(name => typeof db[name] !== "function")) {
    throw new Error("Pinned model-combo-mapping facade omitted an expected export");
  }
  const routeRequire = (specifier: string): unknown => {
    if (specifier === "next/server") return { NextResponse: nextResponse };
    if (specifier === "@/lib/api/requireManagementAuth") return auth;
    if (specifier === "@/lib/db/modelComboMappings") return db;
    if (specifier === "@/shared/validation/schemas") return pagination;
    if (specifier === "@/shared/validation/helpers") return helpers;
    throw new Error(`Unapproved pinned model-mapping route import: ${specifier}`);
  };
  return {
    collection: loadPinnedModule("src/app/api/model-combo-mappings/route.ts", routeRequire),
    item: loadPinnedModule("src/app/api/model-combo-mappings/[id]/route.ts", routeRequire),
    repository,
    cacheVersions: () => ({ combos: (readCache.getCombosCacheVersion as () => number)(), catalog: (readCache.getModelCatalogCacheVersion as () => number)() }),
  };
}

export function createPinnedMappingHandlers(options: {
  readonly authorization: PinnedManagementAuthorization;
  readonly initial?: readonly Partial<MappingRow>[];
  readonly comboNames?: Readonly<Record<string, string>>;
  readonly now?: () => string;
  readonly uuid?: () => string;
}): PinnedMappingHandlers {
  const db = new Database(":memory:");
  const coreSource = readPinnedSource("src/lib/db/core.ts");
  const schema = /const SCHEMA_SQL = `([\s\S]*?)`;/m.exec(coreSource)?.[1];
  const comboTable = schema && /CREATE TABLE IF NOT EXISTS combos\s*\([\s\S]*?\n\s*\);/i.exec(schema)?.[0];
  if (!comboTable) throw new Error("Receipt-verified upstream core schema omitted the combos table");
  db.exec(comboTable);
  db.exec(readPinnedSource("src/lib/db/migrations/010_model_combo_mappings.sql"));

  const baseTime = options.now?.() ?? "2026-10-19T12:00:00.000Z";
  const insertCombo = db.prepare("INSERT INTO combos (id, name, data, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const [index, [id, name]] of Object.entries(options.comboNames ?? {}).entries()) {
    insertCombo.run(id, name, JSON.stringify({ id, name, models: [], isActive: true }), index, baseTime, baseTime);
  }

  let generatedId = 0;
  const uuid = options.uuid ?? (() => `00000000-0000-4000-8000-${String(++generatedId).padStart(12, "0")}`);
  const insertMapping = db.prepare(`INSERT INTO model_combo_mappings
    (id, pattern, combo_id, priority, enabled, description, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const seed of options.initial ?? []) {
    const id = seed.id ?? uuid();
    const createdAt = seed.createdAt ?? baseTime;
    insertMapping.run(
      id,
      seed.pattern ?? `^${id}`,
      seed.comboId ?? "combo-fixture",
      seed.priority ?? 0,
      seed.enabled === false ? 0 : 1,
      seed.description ?? "",
      createdAt,
      seed.updatedAt ?? createdAt,
    );
  }

  const loaded = loadMappingHandlers({
    authorization: options.authorization,
    db,
    uuid,
    date: createPinnedFixtureDate(baseTime),
  });
  const { authorization } = options;
  return { authorization, collection: loaded.collection, item: loaded.item, db, repository: loaded.repository, cacheVersions: loaded.cacheVersions };
}
