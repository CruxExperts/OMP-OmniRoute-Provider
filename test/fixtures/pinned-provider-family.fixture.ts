import { Database, type SQLQueryBindings } from "bun:sqlite";
import {
  createPinnedManagementAuthorization,
  createPinnedFixtureDate,
  loadPinnedModule,
  readPinnedSource,
  type PinnedExports,
  type PinnedManagementAuthorization,
} from "./pinned-handler.fixture.ts";
import type { ProviderConnectionFixture } from "./provider-family.fixture.ts";

const FIXTURE_KEY = "fixture-manage";
type RouteHandler = (request: Request) => Response | Promise<Response>;
type ProviderRoute = PinnedExports & { GET: RouteHandler; POST: RouteHandler; PATCH: RouteHandler; DELETE: RouteHandler };
type ProviderStore = PinnedExports & {
  getRawProviderConnections(filter?: Record<string, unknown>, limit?: number, offset?: number, columns?: string[]): Promise<Record<string, unknown>[]>;
  getProviderConnections(filter?: Record<string, unknown>, limit?: number, offset?: number, columns?: string[]): Promise<Record<string, unknown>[]>;
  getProviderConnectionsCount(filter?: Record<string, unknown>): number;
  getProviderConnectionById(id: string): Promise<Record<string, unknown> | null>;
  createProviderConnection(data: Record<string, unknown>): Promise<Record<string, unknown>>;
  updateProviderConnection(id: string, data: Record<string, unknown>): Promise<Record<string, unknown> | null>;
  deleteProviderConnections(ids: string[]): Promise<number>;
  resolveProviderNodeForConnection(idOrType: string): Promise<Record<string, unknown> | null>;
  isCloudEnabled(): Promise<boolean>;
};

type FixtureDate = DateConstructor;
type ProviderModelNamespace = "customModels" | "syncedAvailableModels";
type ProviderModelRecord = { readonly namespace: ProviderModelNamespace; readonly key: string; readonly value: unknown };

export interface ProviderFamilyEffects {
  readonly backups: string[];
  readonly cacheInvalidations: string[];
  readonly audits: Array<Record<string, unknown>>;
  readonly testRequests: string[];
  readonly cloudSyncRequests: string[];
  readonly modelSyncRequests: string[];
  readonly updates: string[];
}

function requiredFunction(module: PinnedExports, name: string): (...args: unknown[]) => unknown {
  const candidate = module[name];
  if (typeof candidate !== "function") throw new Error(`Receipt-verified upstream module omitted ${name}`);
  return candidate as (...args: unknown[]) => unknown;
}

function sourceDate(isoTimestamp: string): FixtureDate {
  return createPinnedFixtureDate(isoTimestamp);
}

function extractedCoreSchema(): string {
  const core = readPinnedSource("src/lib/db/core.ts");
  const schema = /const SCHEMA_SQL = `([\s\S]*?)`;/m.exec(core)?.[1];
  if (!schema) throw new Error("Receipt-verified upstream core source omitted SCHEMA_SQL");
  return schema;
}

/** Adapt Bun's prefixed named-binding keys to the node:sqlite contract used upstream. */
function createNodeSqliteBindingAdapter(database: Database): Database {
  const adaptBindings = (sql: string, args: unknown[]) => args.map(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([name, field]) => {
      const token = [`@${name}`, `:${name}`, `$${name}`].find(candidate => sql.includes(candidate));
      return [token ?? name, field];
    }));
  });
  return new Proxy(database, {
    get(target, property, receiver) {
      if (property === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        return {
          all: (...args: unknown[]) => statement.all(...adaptBindings(sql, args) as never[]),
          get: (...args: unknown[]) => statement.get(...adaptBindings(sql, args) as never[]),
          run: (...args: unknown[]) => statement.run(...adaptBindings(sql, args) as never[]),
        };
      };
      if (property === "transaction") return (callback: () => unknown) => target.transaction(callback);
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function loadProviderConstants(): PinnedExports {
  const leaf = (path: string) => loadPinnedModule(path, specifier => {
    throw new Error(`Unapproved provider-catalog dependency ${specifier} in ${path}`);
  });
  const gitlabSetup = leaf("src/shared/constants/gitlabDuoSetupMessage.ts");
  const childCatalogs = new Map<string, PinnedExports>();
  const loadChildCatalog = (name: string) => {
    const cached = childCatalogs.get(name);
    if (cached) return cached;
    const module = loadPinnedModule(`src/shared/constants/providers/${name}.ts`, specifier => {
      if (specifier === "@/shared/constants/gitlabDuoSetupMessage") return gitlabSetup;
      if (name === "apikey/gateways" && specifier === "./onomeo") return loadChildCatalog("apikey/onomeo");
      if (name === "apikey/gateways" && specifier === "./unifically") return loadChildCatalog("apikey/unifically");
      throw new Error(`Unapproved provider catalog child dependency ${specifier} in ${name}`);
    });
    childCatalogs.set(name, module);
    return module;
  };
  const catalogs = loadPinnedModule("src/shared/constants/providers.ts", specifier => {
    if (specifier === "./providers/noauth") return loadChildCatalog("noauth");
    if (specifier === "./providers/oauth") return loadChildCatalog("oauth");
    if (specifier === "./providers/web-cookie") return loadPinnedModule("src/shared/constants/providers/web-cookie.ts", childSpecifier => {
      if (childSpecifier === "./web-cookie-chatplayground") return loadChildCatalog("web-cookie-chatplayground");
      if (childSpecifier === "./web-cookie-notrack") return loadChildCatalog("web-cookie-notrack");
      throw new Error(`Unapproved web-cookie catalog dependency ${childSpecifier}`);
    });
    if (specifier === "./providers/apikey") return loadPinnedModule("src/shared/constants/providers/apikey/index.ts", childSpecifier => {
      const child = childSpecifier.replace(/^\.\//, "");
      if (["gateways", "beatapi", "frontier-labs", "inference-hosts", "enterprise-cloud", "regional", "specialty-media"].includes(child)) {
        return loadChildCatalog(`apikey/${child}`);
      }
      throw new Error(`Unapproved API-key catalog dependency ${childSpecifier}`);
    });
    if (specifier === "./providers/local") return loadChildCatalog("local");
    if (specifier === "./providers/search") return loadChildCatalog("search");
    if (specifier === "./providers/audio") return loadChildCatalog("audio");
    if (specifier === "./providers/upstream-proxy") return loadChildCatalog("upstream-proxy");
    if (specifier === "./providers/cloud-agent") return loadChildCatalog("cloud-agent");
    if (specifier === "./providers/system") return loadChildCatalog("system");
    if (specifier === "../validation/providerSchema") return { validateProviders: () => undefined };
    if (specifier === "@omniroute/open-sse/services/usage/supportedProviders.ts") return {};
    throw new Error(`Unapproved provider-catalog import: ${specifier}`);
  });
  return catalogs;
}

function loadProviderSchema(constants: PinnedExports): PinnedExports {
  const catalogLeaf = (path: string) => loadPinnedModule(path, specifier => {
    throw new Error(`Unapproved provider validation dependency ${specifier} in ${path}`);
  });
  const dailyQuota = loadPinnedModule("open-sse/services/dailyQuotaReset.ts", specifier => {
    throw new Error(`Unapproved daily quota validation dependency: ${specifier}`);
  });
  const modelSpecificData = loadPinnedModule("src/shared/validation/providerSpecificData.ts", specifier => {
    if (specifier === "@/shared/constants/providers") return constants;
    if (specifier === "@/shared/constants/modelConcurrency") return catalogLeaf("src/shared/constants/modelConcurrency.ts");
    if (specifier === "@/shared/constants/modelSupportedEndpoints") return catalogLeaf("src/shared/constants/modelSupportedEndpoints.ts");
    if (specifier === "@/shared/constants/openRouterPreset") return catalogLeaf("src/shared/constants/openRouterPreset.ts");
    throw new Error(`Unapproved provider-specific validation dependency: ${specifier}`);
  });
  const misc = loadPinnedModule("src/shared/validation/schemas/misc.ts", specifier => {
    if (specifier === "@/shared/constants/modelSupportedEndpoints") return catalogLeaf("src/shared/constants/modelSupportedEndpoints.ts");
    if (specifier === "@/shared/constants/batchEndpoints") return { SUPPORTED_BATCH_ENDPOINTS: [] };
    if (specifier === "@/shared/constants/bodySize") return { MAX_REQUEST_BODY_LIMIT_MB: 10, MIN_REQUEST_BODY_LIMIT_MB: 1 };
    if (specifier === "@/shared/constants/comboConfigMode") return { COMBO_CONFIG_MODES: ["parallel", "fallback", "round-robin"] };
    if (specifier === "@/shared/constants/providers") return constants;
    if (specifier === "@/shared/constants/sidebarVisibility") return { HIDEABLE_SIDEBAR_ITEM_IDS: [] };
    if (specifier === "@/shared/constants/upstreamHeaders") return catalogLeaf("src/shared/constants/upstreamHeaders.ts");
    if (specifier === "@/shared/utils/runtimeTimeouts") return { MAX_TIMER_TIMEOUT_MS: 86_400_000 };
    throw new Error(`Unapproved validation misc dependency: ${specifier}`);
  });
  const validation = loadPinnedModule("src/shared/validation/schemas/provider.ts", specifier => {
    if (specifier === "@/shared/constants/modelSupportedEndpoints") return catalogLeaf("src/shared/constants/modelSupportedEndpoints.ts");
    if (specifier === "@/shared/constants/providers") return constants;
    if (specifier === "@/shared/validation/providerSpecificData") return modelSpecificData;
    if (specifier === "@/shared/constants/reservedProviderPrefixes") return { isReservedProviderPrefix: () => false, reservedProviderPrefixMessage: () => "Reserved provider prefix" };
    if (specifier === "@omniroute/open-sse/services/dailyQuotaReset.ts") return dailyQuota;
    if (specifier === "./misc.ts") return misc;
    if (specifier === "@/shared/validation/iconUrl") return catalogLeaf("src/shared/validation/iconUrl.ts");
    if (specifier === "@/shared/constants/modelConcurrency") return catalogLeaf("src/shared/constants/modelConcurrency.ts");
    throw new Error(`Unapproved provider schema dependency: ${specifier}`);
  });
  return validation;
}

function loadRequestDefaults(constants: PinnedExports): PinnedExports {
  const leaf = (path: string) => loadPinnedModule(path, specifier => {
    throw new Error(`Unapproved request-default helper import ${specifier} in ${path}`);
  });
  const secretFields = loadPinnedModule("src/lib/db/providers/providerSpecificDataSecrets.ts", () => {
    throw new Error("Provider-specific secret metadata is source-local");
  });
  const wildcardRouter = loadPinnedModule("open-sse/services/wildcardRouter.ts", () => {
    throw new Error("Pinned wildcard matching has no runtime dependencies");
  });
  const connectionModelRules = loadPinnedModule("src/domain/connectionModelRules.ts", specifier => {
    if (specifier === "@omniroute/open-sse/services/wildcardRouter.ts") return wildcardRouter;
    throw new Error(`Unapproved connection-model rule import: ${specifier}`);
  });
  const dependencies: Record<string, unknown> = {
    "@/domain/connectionModelRules": connectionModelRules,
    "@/domain/tagRouter": leaf("src/domain/tagRouter.ts"),
    "@/shared/constants/openRouterPreset": leaf("src/shared/constants/openRouterPreset.ts"),
    "@/shared/constants/upstreamHeaders": leaf("src/shared/constants/upstreamHeaders.ts"),
    "@/lib/providers/peakHourProtection": leaf("src/lib/providers/peakHourProtection.ts"),
    "@/shared/reasoning/reasoningControl": leaf("src/shared/reasoning/reasoningControl.ts"),
    "@/lib/db/providers/providerSpecificDataSecrets": secretFields,
    "@/shared/utils/apiKeyMask": leaf("src/shared/utils/apiKeyMask.ts"),
    "@/shared/constants/providers": constants,
  };
  return loadPinnedModule("src/lib/providers/requestDefaults.ts", specifier => {
    if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier];
    throw new Error(`Unapproved request-default import: ${specifier}`);
  });
}

function loadProviderReferenceCleanup(db: Database, date: FixtureDate, effects: ProviderFamilyEffects, fixtureUuid: () => string) {
  const core = { getDbInstance: () => createNodeSqliteBindingAdapter(db) };
  const backup = { backupDbFile: (reason: string) => { effects.backups.push(reason); } };
  const readCache = {
    invalidateDbCache: (table: string) => { effects.cacheInvalidations.push(table); },
    invalidateCachedLKGP: (key: string) => { effects.cacheInvalidations.push(`lkgp:${key}`); },
  };
  const lkgp = loadPinnedModule("src/lib/db/settings/lkgp.ts", specifier => {
    if (specifier === "../core") return core;
    if (specifier === "../readCache") return readCache;
    throw new Error(`Unapproved LKGP import: ${specifier}`);
  }, { date });
  const steps = loadPinnedModule("src/lib/combos/steps.ts", () => ({}), { date });
  const invariants = loadPinnedModule("src/lib/combos/invariants.ts", () => ({}), { date });
  const sqliteCombos = loadPinnedModule("src/lib/db/repositories/sqliteComboRepository.ts", specifier => {
    if (specifier === "uuid") return { v4: fixtureUuid };
    if (specifier === "@/lib/combos/steps") return steps;
    if (specifier === "@/lib/combos/invariants") return invariants;
    if (specifier === "../core") return core;
    if (specifier === "../settings/lkgp") return lkgp;
    if (specifier === "../proxies/rotation") return { clearRotationState: () => undefined };
    if (specifier === "../proxies/registryGeneration") return { bumpProxyRegistryGeneration: () => undefined };
    if (specifier === "../readCache") return readCache;
    throw new Error(`Unapproved SQLite combo repository import: ${specifier}`);
  }, { date });
  const routingRepositories = loadPinnedModule("src/lib/db/repositories/routingConfigRepositories.ts", specifier => {
    if (specifier === "./sqliteComboRepository") return sqliteCombos;
    if (specifier === "./sqliteModelComboMappingRepository") return { sqliteModelComboMappingRepository: {} };
    throw new Error(`Unapproved routing-repository import: ${specifier}`);
  }, { date });
  const combos = loadPinnedModule("src/lib/db/combos.ts", specifier => {
    if (specifier === "./backup") return backup;
    if (specifier === "./contextHandoffs") return { clearSessionModelHistoryForCombo: () => 0 };
    if (specifier === "./core") return core;
    if (specifier === "./readCache") return readCache;
    if (specifier === "./reasoningRoutingRules") return { invalidateReasoningRoutingRuleCache: () => undefined };
    if (specifier === "./repositories/routingConfigRepositories") return routingRepositories;
    throw new Error(`Unapproved combo facade import: ${specifier}`);
  }, { date });
  return { combos, lkgp };
}

function loadProviderStore(
  db: Database,
  date: FixtureDate,
  effects: ProviderFamilyEffects,
  constants: PinnedExports,
  requestDefaults: PinnedExports,
  fixtureUuid: () => string,
): ProviderStore {
  const sourceDb = createNodeSqliteBindingAdapter(db);
  const referenceCleanup = loadProviderReferenceCleanup(db, date, effects, fixtureUuid);
  const retirement = loadPinnedModule("src/shared/constants/chatgptWebRetirement.ts", () => ({}), { date });
  const caseMapping = loadPinnedModule("src/lib/db/caseMapping.ts", () => {
    throw new Error("Pinned provider row-mapping helpers have no imports");
  });
  const core = { getDbInstance: () => sourceDb, rowToCamel: caseMapping.rowToCamel, cleanNulls: caseMapping.cleanNulls };
  const cacheEffects = {
    invalidateDbCache: (table: string) => { effects.cacheInvalidations.push(table); },
    invalidateConnectionUpdate: (id: string) => { effects.cacheInvalidations.push(`connection:${id}`); },
    invalidateCachedLKGP: (_key: string) => undefined,
  };
  const modelShared = loadPinnedModule("src/lib/db/models/shared.ts", () => {
    throw new Error("Pinned model key-value helpers have no runtime dependencies");
  }, { date });
  const syncedModelPersistence = loadPinnedModule("src/lib/db/models/syncedAvailableModelPersistence.ts", specifier => {
    if (specifier === "../backup") return { backupDbFile: (reason: string) => { effects.backups.push(reason); } };
    if (specifier === "../core") return core;
    if (specifier === "../readCache") return { invalidateModelCatalogCache: () => { effects.cacheInvalidations.push("synced-models"); } };
    if (specifier === "./shared") return modelShared;
    throw new Error(`Unapproved synced-model persistence dependency: ${specifier}`);
  }, { date });
  let store!: ProviderStore;
  const columns = loadPinnedModule("src/lib/db/providers/columns.ts", specifier => {
    if (specifier === "@/shared/constants/modelConcurrency") return loadPinnedModule("src/shared/constants/modelConcurrency.ts", () => ({}));
    throw new Error(`Unapproved provider columns dependency: ${specifier}`);
  });
  const secrets = loadPinnedModule("src/lib/db/providers/providerSpecificDataSecrets.ts", () => ({}));
  const providerData = loadPinnedModule("src/lib/db/providers/providerSpecificData.ts", specifier => {
    if (specifier === "@/lib/providers/requestDefaults") return requestDefaults;
    if (specifier === "@/shared/constants/providers") return constants;
    if (specifier === "@/shared/utils/webCookieExpiry") return {
      withDerivedCookieExpiry: () => { throw new Error("Web-cookie expiry derivation is outside the pinned provider-family oracle"); },
    };
    if (specifier === "@omniroute/open-sse/config/codexIdentity.ts") return {
      ensureCodexFingerprintSeed: () => { throw new Error("Codex fingerprint derivation is outside the pinned provider-family oracle"); },
    };
    throw new Error(`Unapproved provider-specific persistence dependency: ${specifier}`);
  }, { date });
  const encryption = loadPinnedModule("src/lib/db/encryption.ts", specifier => {
    if (specifier === "crypto") return require("node:crypto");
    if (specifier === "fs") return require("node:fs");
    if (specifier === "path") return require("node:path");
    if (specifier === "os") return require("node:os");
    if (specifier === "../dataPaths.ts") return { isTestContext: () => true, resolveDataDir: () => "/tmp/provider-family" };
    if (specifier === "./providers/providerSpecificDataSecrets") return secrets;
    throw new Error(`Unapproved provider encryption dependency: ${specifier}`);
  });
  const lazyView = loadPinnedModule("src/lib/db/providers/lazyConnectionView.ts", specifier => {
    if (specifier === "../encryption") return encryption;
    if (specifier === "./providerSpecificDataSecrets") return secrets;
    if (specifier === "./columns") return columns;
    throw new Error(`Unapproved lazy provider-view dependency: ${specifier}`);
  });
  const deletion = loadPinnedModule("src/lib/db/providers/deletion.ts", specifier => {
    if (specifier === "../core") return core;
    if (specifier === "../backup") return { backupDbFile: (reason: string) => { effects.backups.push(reason); } };
    if (specifier === "../combos") return referenceCleanup.combos;
    if (specifier === "../settings/lkgp") return referenceCleanup.lkgp;
    if (specifier === "../providerLimits") return { deleteProviderLimitsCache: (id: string) => { effects.cacheInvalidations.push(`limits:${id}`); } };
    if (specifier === "@omniroute/open-sse/services/apiKeyRotator.ts") return {
      removeConnectionHealth: (id: string) => { effects.cacheInvalidations.push(`health:${id}`); },
      removeConnectionIndex: (id: string) => { effects.cacheInvalidations.push(`index:${id}`); },
    };
    if (specifier === "../readCache") return cacheEffects;
    if (specifier === "../reasoningRoutingRules") return { invalidateReasoningRoutingRuleCache: () => { effects.cacheInvalidations.push("reasoning"); } };
    if (specifier === "../settings") return { bumpProxyConfigGeneration: () => { effects.cacheInvalidations.push("proxy-generation"); } };
    if (specifier === "../models/syncedAvailableModelPersistence") return syncedModelPersistence;
    if (specifier === "./columns") return columns;
    throw new Error(`Unapproved provider-deletion import: ${specifier}`);
  }, { date });
  const nodePrefix = loadPinnedModule("src/lib/db/providers/nodePrefix.ts", specifier => {
    if (specifier === "../core") return core;
    throw new Error(`Unapproved provider node-prefix dependency: ${specifier}`);
  }, { date });
  const nodeSelect = loadPinnedModule("src/lib/db/providerNodeSelect.ts", () => {
    throw new Error("Pinned provider-node selector has no runtime imports");
  }, { date });
  const nodes = loadPinnedModule("src/lib/db/providers/nodes.ts", specifier => {
    if (specifier === "uuid") return { v4: fixtureUuid };
    if (specifier === "../core") return core;
    if (specifier === "../providerNodeSelect") return nodeSelect;
    if (specifier === "../backup") return { backupDbFile: (reason: string) => { effects.backups.push(reason); } };
    if (specifier === "../readCache") return cacheEffects;
    if (specifier === "./columns") return columns;
    if (specifier === "./nodePrefix") return nodePrefix;
    throw new Error(`Unapproved provider-node persistence dependency: ${specifier}`);
  }, { date });
  const settings = {
    getSettings: async () => ({}),
    bumpProxyConfigGeneration: () => { effects.cacheInvalidations.push("proxy-generation"); },
  };
  const managementPassword = { getStoredManagementPassword: () => null, isBcryptHash: () => false, verifyManagementPassword: async () => false };
  const migrations = loadPinnedModule("src/lib/db/providers/migrations.ts", specifier => {
    if (specifier === "../core") return core;
    if (specifier === "../backup") return { backupDbFile: (reason: string) => { effects.backups.push(reason); } };
    if (specifier === "../encryption") return encryption;
    if (specifier === "../readCache") return cacheEffects;
    if (specifier === "../webSessionDedup") return {};
    if (specifier === "./providerSpecificDataSecrets") return secrets;
    throw new Error(`Unapproved provider migration dependency: ${specifier}`);
  }, { date });
  const webSessionDedup = loadPinnedModule("src/lib/db/webSessionDedup.ts", specifier => {
    if (specifier === "@/shared/constants/providers") return constants;
    throw new Error(`Unapproved web-session dedup dependency: ${specifier}`);
  }, { date });
  const usageReconciliation = loadPinnedModule("src/lib/db/providers/usageIdentityReconciliation.ts", specifier => {
    if (specifier === "../core") return core;
    if (specifier === "@/lib/usage/accountIdentity") return loadPinnedModule("src/lib/usage/accountIdentity.ts", () => ({}), { date });
    if (specifier === "../webSessionDedup") return webSessionDedup;
    if (specifier === "./columns") return columns;
    throw new Error(`Unapproved provider usage reconciliation dependency: ${specifier}`);
  }, { date });
  const codexState = loadPinnedModule("src/lib/db/providers/codexAccountState.ts", () => ({}), { date });
  store = loadPinnedModule("src/lib/db/providers.ts", specifier => {
    if (specifier === "uuid") return { v4: fixtureUuid };
    if (specifier === "@/shared/constants/chatgptWebRetirement") return retirement;
    if (specifier === "./core") return core;
    if (specifier === "./backup") return { backupDbFile: (reason: string) => { effects.backups.push(reason); } };
    if (specifier === "./encryption") return encryption;
    if (specifier === "./providers/lazyConnectionView") return lazyView;
    if (specifier === "./readCache") return {
      ...cacheEffects,
      getCachedRawProviderConnections: (filter: Record<string, unknown>) => store.getRawProviderConnections(filter),
    };
    if (specifier === "./providers/deletion") return deletion;
    if (specifier === "./providers/providerSpecificData") return providerData;
    if (specifier === "@/lib/providers/operatorDisable") return loadPinnedModule("src/lib/providers/operatorDisable.ts", () => ({}), { date });
    if (specifier === "@/lib/credentialHealth/retestAutoDisabledFlag") return { isRetestAutoDisabledEnabled: () => false };
    if (specifier === "./providers/migrations") return migrations;
    if (specifier === "./settings") return settings;
    if (specifier === "@/lib/auth/managementPassword") return managementPassword;
    if (specifier === "./webSessionDedup") return webSessionDedup;
    if (specifier === "@/shared/constants/providers") return constants;
    if (specifier === "@/lib/oauth/utils/codexConnectionSelection") return { pickCodexConnectionForUser: () => null };
    if (specifier === "@/shared/constants/designerWebRetirement") return { isMicrosoftDesignerWebRetiredProviderId: () => false };
    if (specifier === "./providers/usageIdentityReconciliation") return usageReconciliation;
    if (specifier === "@/shared/constants/providerRetirement") return { isRuntimeRetiredProviderId: () => false };
    if (specifier === "./providers/codexAccountState") return codexState;
    if (specifier === "./providers/columns") return columns;
    if (specifier === "./providers/nodes") return nodes;
    if (specifier === "./providers/providerSpecificDataMerge") return {};
    if (specifier === "./providers/rateLimit") return {};
    throw new Error(`Unapproved provider persistence import: ${specifier}`);
  }, { date }) as ProviderStore;
  return {
    ...store,
    updateProviderConnection: async (id, data) => {
      const updated = await store.updateProviderConnection(id, data);
      if (updated) effects.updates.push(id);
      return updated;
    },
  };
}

function loadProviderModelCleanup(db: Database, store: ProviderStore, effects: ProviderFamilyEffects, date: FixtureDate): PinnedExports {
  const core = { getDbInstance: () => createNodeSqliteBindingAdapter(db) };
  const providerShared = loadPinnedModule("src/lib/db/models/shared.ts", () => ({}), { date });
  const synced = loadPinnedModule("src/lib/db/models/synced.ts", specifier => {
    if (specifier === "@omniroute/open-sse/config/providers/registry/github/retiredModels.ts") return { isRetiredGitHubCopilotModelId: () => false };
    if (specifier === "@/lib/providerModels/vertexModelMetadata") return {};
    if (specifier === "./shared") return providerShared;
    throw new Error(`Unapproved synced-model dependency: ${specifier}`);
  }, { date });
  const compat = loadPinnedModule("src/lib/db/models/compat.ts", specifier => {
    if (specifier === "../core") return core;
    if (specifier === "@/shared/constants/modelCompat") return loadPinnedModule("src/shared/constants/modelCompat.ts", () => ({}), { date });
    if (specifier === "@/shared/constants/upstreamHeaders") return loadPinnedModule("src/shared/constants/upstreamHeaders.ts", () => ({}), { date });
    if (specifier === "@/shared/utils/modelVisibility") return loadPinnedModule("src/shared/utils/modelVisibility.ts", () => ({}), { date });
    if (specifier === "./shared") return providerShared;
    if (specifier === "./modelCatalogWriteSignals") return { finishModelCatalogWriteWithBackup: () => { effects.backups.push("model-catalog"); } };
    throw new Error(`Unapproved model-compatibility dependency: ${specifier}`);
  }, { date });
  const syncedModelPersistence = loadPinnedModule("src/lib/db/models/syncedAvailableModelPersistence.ts", specifier => {
    if (specifier === "../backup") return { backupDbFile: (reason: string) => { effects.backups.push(reason); } };
    if (specifier === "../core") return core;
    if (specifier === "../readCache") return { invalidateModelCatalogCache: () => { effects.cacheInvalidations.push("synced-models"); } };
    if (specifier === "./shared") return providerShared;
    throw new Error(`Unapproved synced-model persistence dependency: ${specifier}`);
  }, { date });
  return loadPinnedModule("src/lib/db/models.ts", specifier => {
    if (specifier === "@omniroute/open-sse/config/providers/registry/github/retiredModels.ts") return { isRetiredGitHubCopilotModelId: () => false };
    if (specifier === "./core") return core;
    if (specifier === "./models/syncedCatalogFreshness") return { isSyncedAtFresh: () => false };
    if (specifier === "./providers") return store;
    if (specifier === "./models/shared") return providerShared;
    if (specifier === "./models/synced") return synced;
    if (specifier === "./models/syncedAvailableModelPersistence") return syncedModelPersistence;
    if (specifier === "./models/modelCatalogWriteSignals") return { finishModelCatalogWriteWithBackup: () => { effects.backups.push("model-catalog"); } };
    if (specifier === "./models/compat") return compat;
    if (specifier === "./models/aliases" || specifier === "./models/mitmAlias" || specifier === "./models/customVisionOverride" || specifier === "./models/syncedAvailableModelVision") return {};
    throw new Error(`Unapproved provider-model cleanup import: ${specifier}`);
  }, { date });
}

function loadProviderRoute(
  store: ProviderStore,
  database: Database,
  auth: PinnedManagementAuthorization,
  effects: ProviderFamilyEffects,
  date: FixtureDate,
): ProviderRoute {
  const constants = loadProviderConstants();
  const providerSchema = loadProviderSchema(constants);
  const requestDefaults = loadRequestDefaults(constants);
  const validation = loadPinnedModule("src/shared/validation/helpers.ts", specifier => {
    if (specifier === "next/server") return { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
    throw new Error(`Unapproved provider validation helper import: ${specifier}`);
  }, { date });
  const operatorDisable = loadPinnedModule("src/lib/providers/operatorDisable.ts", () => ({}), { date });
  const compatibleCreation = loadPinnedModule("src/lib/providers/compatibleNodeCreation.ts", specifier => {
    if (specifier === "node:util") return require("node:util");
    throw new Error(`Unapproved compatible-node creation dependency: ${specifier}`);
  }, { date });
  const modelCleanup = loadProviderModelCleanup(database, store, effects, date);
  const catalog = loadPinnedModule("src/lib/providers/catalog.ts", specifier => {
    if (specifier === "@/shared/constants/providers") return constants;
    throw new Error(`Unapproved managed-provider catalog dependency: ${specifier}`);
  }, { date });
  const retirementConstants = loadPinnedModule("src/shared/constants/chatgptWebRetirement.ts", () => ({}), { date });
  const retirement = loadPinnedModule("src/lib/providers/chatgptWebRetirementResponse.ts", specifier => {
    if (specifier === "@omniroute/open-sse/utils/error.ts") return {
      errorResponse: (status: number, message: string, data: Record<string, unknown>) => Response.json({ error: message, ...data }, { status }),
    };
    if (specifier === "@/shared/constants/chatgptWebRetirement") return retirementConstants;
    throw new Error(`Unapproved retired-provider response dependency: ${specifier}`);
  }, { date });
  const apiKeyExposure = loadPinnedModule("src/lib/apiKeyExposure.ts", specifier => {
    if (specifier === "@/lib/db/settings") return { getSettings: async () => ({}) };
    if (specifier === "@/shared/utils/featureFlags") return { isApiKeyRevealEnabledFlag: () => false };
    if (specifier === "@/shared/utils/apiKeyMask") return loadPinnedModule("src/shared/utils/apiKeyMask.ts", () => ({}), { date });
    throw new Error(`Unapproved API-key exposure dependency: ${specifier}`);
  }, { date });
  return loadPinnedModule("src/app/api/providers/route.ts", specifier => {
    if (specifier === "@/lib/db/providerLimits") return { getAllProviderLimitsCache: () => ({}) };
    if (specifier === "next/server") return { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
    if (specifier === "@/lib/db/settings") return { getSettings: async () => ({}) };
    if (specifier === "@/lib/resilience/settings") return { resolveResilienceSettings: () => ({ requestQueue: {} }) };
    if (specifier === "@omniroute/open-sse/services/rateLimitManager/autoProtection.ts") return { isConnectionAutoProtected: () => false };
    if (specifier === "@/lib/compliance/index") return {
      getAuditRequestContext: () => ({ ipAddress: "127.0.0.1", requestId: "fixture-request" }),
      logAuditEvent: (event: Record<string, unknown>) => { effects.audits.push(event); },
    };
    if (specifier === "@/lib/compliance/providerAudit") return {
      getProviderAuditTarget: (connection: unknown) => connection,
      summarizeProviderConnectionForAudit: (connection: unknown) => connection,
    };
    if (specifier === "@/models") return {
      ...store,
      isCloudEnabled: async () => false,
      cleanupProviderModelsAfterConnectionDelete: modelCleanup.cleanupProviderModelsAfterConnectionDelete,
    };
    if (specifier === "@/shared/constants/providers") return constants;
    if (specifier === "@/shared/utils/machineId") return { getConsistentMachineId: async () => "fixture-machine" };
    if (specifier === "@/lib/cloudSync") return { syncToCloud: async (id: string) => { effects.cloudSyncRequests.push(id); } };
    if (specifier === "@/shared/validation/schemas") return providerSchema;
    if (specifier === "@/shared/validation/helpers") return validation;
    if (specifier === "@omniroute/open-sse/services/qoderCli") return {
      normalizeQoderPatProviderData: () => { throw new Error("Qoder PAT normalization is outside the pinned provider-family oracle"); },
    };
    if (specifier === "@omniroute/open-sse/services/codexAccount/index.ts") return {
      projectCodexAccountPool: () => { throw new Error("Codex account projection is outside the pinned provider-family oracle"); },
    };
    if (specifier === "@omniroute/open-sse/config/codexQuotaScopes.ts") return { CODEX_SPARK_QUOTA_SESSION: "session", CODEX_SPARK_QUOTA_WEEKLY: "weekly" };
    if (specifier === "@/lib/providers/requestDefaults") return requestDefaults;
    if (specifier === "@/domain/quotaCache") return { getQuotaWindowObservation: () => null };
    if (specifier === "@/lib/api/requireManagementAuth") return { requireManagementAuth: (request: Request) => auth.requireManagementAuth(request) };
    if (specifier === "@/lib/providers/catalog") return catalog;
    if (specifier === "@/lib/apiKeyExposure") return { isApiKeyRevealEnabled: () => false, maskStoredApiKey: apiKeyExposure.maskStoredApiKey };
    if (specifier === "@/lib/db/models") return { cleanupProviderModelsAfterConnectionDelete: modelCleanup.cleanupProviderModelsAfterConnectionDelete };
    if (specifier === "@/shared/services/modelSyncScheduler") return {
      buildModelSyncInternalHeaders: () => ({}),
      fetchModelSyncInternal: async (url: string) => { effects.modelSyncRequests.push(url); return { ok: true }; },
      getModelSyncInternalBaseUrl: () => "http://127.0.0.1:1",
    };
    if (specifier === "@/lib/providerModels/modelDiscovery") return { isAutoFetchModelsEnabled: () => false };
    if (specifier === "./[id]/test/route") return { testSingleConnection: async (id: string) => { effects.testRequests.push(id); } };
    if (specifier === "@/lib/providers/chatgptWebRetirementResponse") return retirement;
    if (specifier === "@omniroute/open-sse/utils/chatgptWebExecutorAdapter.ts") return { chatGptWebStorageStateFromCookieHeader: () => null, normalizeChatGptWebStorageState: (value: unknown) => value };
    if (specifier === "@/lib/providers/operatorDisable") return operatorDisable;
    if (specifier === "@/shared/utils/apiAuth") return { getRequestPeerLocality: () => "local" };
    if (specifier === "@/lib/providers/compatibleNodeCreation") return compatibleCreation;
    if (specifier === "@omniroute/open-sse/utils/error.ts") return { sanitizeErrorMessage: (message: string) => message };
    throw new Error(`Unapproved provider route import: ${specifier}`);
  }, { date }) as ProviderRoute;
}

function providerRow(connection: ProviderConnectionFixture, now: string): Record<string, unknown> {
  return {
    id: connection.id,
    provider: connection.provider,
    auth_type: "apikey",
    name: connection.name,
    priority: connection.priority ?? 1,
    is_active: connection.isActive ? 1 : 0,
    api_key: connection.apiKey ?? null,
    access_token: connection.accessToken ?? null,
    refresh_token: connection.refreshToken ?? null,
    id_token: connection.idToken ?? null,
    provider_specific_data: connection.providerSpecificData ? JSON.stringify(connection.providerSpecificData) : null,
    test_status: "unknown",
    created_at: connection.updatedAt ?? now,
    updated_at: connection.updatedAt ?? now,
  };
}

export class ProviderFamilyFixture {
  readonly #database = new Database(":memory:");
  readonly #authorization: PinnedManagementAuthorization;
  readonly #route: ProviderRoute;
  readonly #server: Bun.Server<undefined>;
  readonly effects: ProviderFamilyEffects = { backups: [], cacheInvalidations: [], audits: [], testRequests: [], cloudSyncRequests: [], modelSyncRequests: [], updates: [] };
  readonly #counts = { get: 0, patch: 0, post: 0, delete: 0 };
  #loseNextPatchResponse = false;
  #lostPatchResponsePending = false;
  authRequired = true;

  constructor(connections: readonly ProviderConnectionFixture[], options: { clock?: () => string } = {}) {
    const now = options.clock?.() ?? new Date().toISOString();
    const date = sourceDate(now);
    this.#database.exec(extractedCoreSchema());
    const sourceDb = createNodeSqliteBindingAdapter(this.#database);
    const schemaColumns = loadPinnedModule("src/lib/db/schemaColumns.ts", () => ({}), { date });
    requiredFunction(schemaColumns, "ensureProviderConnectionsColumns")(sourceDb);
    this.#database.exec(readPinnedSource("src/lib/db/migrations/004_proxy_registry.sql"));
    this.#database.exec(readPinnedSource("src/lib/db/migrations/005_combo_agent_fields.sql"));
    this.#database.exec(readPinnedSource("src/lib/db/migrations/177_provider_connection_synced_models_at.sql"));
    const constants = loadProviderConstants();
    const requestDefaults = loadRequestDefaults(constants);
    let uuidCounter = 0;
    const uuid = () => `10000000-0000-4000-8000-${String(++uuidCounter).padStart(12, "0")}`;
    const store = loadProviderStore(this.#database, date, this.effects, constants, requestDefaults, uuid);
    this.#authorization = createPinnedManagementAuthorization({
      isDashboardSession: () => false,
      verifyAccessToken: () => null,
      validateApiKey: token => token === FIXTURE_KEY || token === "fixture-no-manage",
      getApiKeyMetadata: token => token === FIXTURE_KEY
        ? { id: "provider-family-manage", scopes: ["manage", "admin"] }
        : token === "fixture-no-manage" ? { id: "provider-family-read", scopes: ["read"] } : null,
    });
    this.#route = loadProviderRoute(store, this.#database, this.#authorization, this.effects, date);
    const insert = this.#database.prepare(`INSERT INTO provider_connections (
      id, provider, auth_type, name, priority, is_active, api_key, access_token, refresh_token, id_token,
      provider_specific_data, test_status, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )`);
    for (const connection of connections) insert.run(...Object.values(providerRow(connection, now)) as SQLQueryBindings[]);
    const nodeInsert = this.#database.prepare(`INSERT INTO provider_nodes (
      id, type, name, prefix, api_type, base_url, chat_path, models_path, custom_headers_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    nodeInsert.run(
      "openai-compatible-fixture-alias-10000000-0000-4000-8000-000000000001",
      "openai-compatible", "Fixture OpenAI node", "fixture-openai", "openai", "https://compatible.example/v1/",
      "/chat/completions", "/models", JSON.stringify({ "x-fixture-node": "canonical" }), now, now,
    );
    this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => this.#handle(request) });
  }

  get endpoint(): string { return this.#server.url.origin; }

  get state(): readonly ProviderConnectionFixture[] {
    return this.#database.prepare("SELECT * FROM provider_connections ORDER BY rowid").all().map(raw => {
      const row = raw as Record<string, unknown>;
      let providerSpecificData: Record<string, unknown> | undefined;
      if (typeof row.provider_specific_data === "string") {
        try { providerSpecificData = JSON.parse(row.provider_specific_data) as Record<string, unknown>; } catch { providerSpecificData = undefined; }
      }
      return {
        id: String(row.id), provider: String(row.provider), name: String(row.name ?? ""),
        isActive: row.is_active === 1 || row.is_active === true, priority: Number(row.priority ?? 0),
        ...(typeof row.updated_at === "string" ? { updatedAt: row.updated_at } : {}),
        syncedModelsAt: typeof row.synced_models_at === "string" ? row.synced_models_at : null,
        ...(typeof row.api_key === "string" ? { apiKey: row.api_key } : {}),
        ...(typeof row.access_token === "string" ? { accessToken: row.access_token } : {}),
        ...(typeof row.refresh_token === "string" ? { refreshToken: row.refresh_token } : {}),
        ...(typeof row.id_token === "string" ? { idToken: row.id_token } : {}),
        ...(providerSpecificData === undefined ? {} : { providerSpecificData }),
      };
    });
  }

  get counts(): Readonly<{ get: number; patch: number; post: number; delete: number; updates: number }> {
    return { ...this.#counts, updates: this.effects.updates.length };
  }

  seedModelRecords(provider: string, records: readonly ProviderModelRecord[]): void {
    const insert = this.#database.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES (?, ?, ?)");
    for (const record of records) {
      const expectedKey = record.namespace === "customModels" ? provider : `${provider}:`;
      if (record.namespace === "customModels" ? record.key !== expectedKey : !record.key.startsWith(expectedKey)) {
        throw new Error("Provider model fixture key escaped its provider namespace");
      }
      insert.run(record.namespace, record.key, JSON.stringify(record.value));
    }
  }

  modelRecords(provider: string): ProviderModelRecord[] {
    const rows = this.#database.prepare(`
      SELECT namespace, key, value FROM key_value
      WHERE (namespace = 'customModels' AND key = ?)
         OR (namespace = 'syncedAvailableModels' AND substr(key, 1, ?) = ?)
      ORDER BY namespace, key
    `).all(provider, provider.length + 1, `${provider}:`) as Array<{ namespace: ProviderModelNamespace; key: string; value: string }>;
    return rows.map(row => ({ namespace: row.namespace, key: row.key, value: JSON.parse(row.value) }));
  }

  seedCombo(id: string, name: string, models: readonly Record<string, unknown>[]): void {
    const now = "2026-10-19T00:00:00.000Z";
    this.#database.prepare("INSERT INTO combos (id, name, data, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, name, JSON.stringify({ id, name, models, strategy: "priority", config: {} }), 1, now, now);
  }

  comboModels(id: string): unknown[] {
    const row = this.#database.prepare("SELECT data FROM combos WHERE id = ?").get(id) as { data?: string } | undefined;
    if (!row?.data) throw new Error(`Fixture combo ${id} does not exist`);
    const parsed = JSON.parse(row.data) as { models?: unknown[] };
    return parsed.models ?? [];
  }

  seedLKGP(key: string, value: string): void {
    this.#database.prepare("INSERT INTO key_value (namespace, key, value) VALUES ('lkgp', ?, ?)").run(key, value);
  }

  lkgpRecords(): Array<{ key: string; value: string }> {
    return this.#database.prepare("SELECT key, value FROM key_value WHERE namespace = 'lkgp' ORDER BY key").all() as Array<{ key: string; value: string }>;
  }

  failComboCleanup(): void {
    this.#database.exec("CREATE TRIGGER __provider_fixture_fail_combo_cleanup BEFORE UPDATE ON combos BEGIN SELECT RAISE(FAIL, 'fixture combo cleanup failure'); END");
  }

  failNextList(): void {
    this.#database.exec("ALTER TABLE provider_connections RENAME TO provider_connections_fixture_failed");
  }

  failUpdateAt(id: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(id)) throw new Error("Fixture update failure ID has unsafe SQL characters");
    this.#database.exec(`CREATE TRIGGER __provider_fixture_fail_update BEFORE UPDATE ON provider_connections WHEN OLD.id = '${id}' BEGIN SELECT RAISE(FAIL, 'fixture update failure'); END`);
  }

  loseNextPatchResponse(): void { this.#loseNextPatchResponse = true; }

  consumeLostPatchResponse(): boolean {
    const pending = this.#lostPatchResponsePending;
    this.#lostPatchResponsePending = false;
    return pending;
  }

  setActive(id: string, isActive: boolean): void {
    const row = this.#database.prepare("SELECT provider_specific_data FROM provider_connections WHERE id = ?").get(id) as { provider_specific_data?: unknown } | undefined;
    if (!row) throw new Error(`fixture connection ${id} does not exist`);
    let data: Record<string, unknown> = {};
    if (typeof row.provider_specific_data === "string") {
      try { data = JSON.parse(row.provider_specific_data) as Record<string, unknown>; } catch { data = {}; }
    }
    if (isActive) delete data.operatorDisabledAt;
    this.#database.prepare("UPDATE provider_connections SET is_active = ?, provider_specific_data = ? WHERE id = ?")
      .run(isActive ? 1 : 0, JSON.stringify(data), id);
  }

  async close(): Promise<void> {
    this.#server.stop(true);
    this.#database.close();
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/providers") return Response.json({ error: "Not found" }, { status: 404 });
    const method = request.method as "GET" | "POST" | "PATCH" | "DELETE";
    const counter = method.toLowerCase() as "get" | "post" | "patch" | "delete";
    if (!Object.hasOwn(this.#counts, counter)) return Response.json({ error: "Method not allowed" }, { status: 405 });
    const handler = this.#route[method];
    if (typeof handler !== "function") return Response.json({ error: "Method not allowed" }, { status: 405 });
    const response = await this.#authorization.dispatch(request, {
      centralAuthRequired: this.authRequired,
      handlerAuthRequired: this.authRequired,
    }, forwarded => handler(forwarded));
    if (response.status !== 401 && response.status !== 403) this.#counts[counter] += 1;
    if (method === "PATCH" && this.#loseNextPatchResponse && response.status < 500) {
      this.#loseNextPatchResponse = false;
      this.#lostPatchResponsePending = true;
    }
    return response;
  }
}
