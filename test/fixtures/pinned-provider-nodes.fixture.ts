import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import {
  createPinnedManagementAuthorization,
  loadPinnedModule,
  readPinnedSource,
  type PinnedExports,
  type PinnedManagementAuthorization,
} from "./pinned-handler.fixture.ts";
import type { ProviderNodeFixture } from "./provider-nodes.fixture.ts";

type NodeRoute = PinnedExports & { GET: (request?: Request) => Response | Promise<Response> };
type NodeStore = PinnedExports & {
  getProviderNodes(filter?: Record<string, unknown>, limit?: number, offset?: number): Promise<Record<string, unknown>[]>;
  getProviderNodesCount(filter?: Record<string, unknown>): number;
  isProviderNodeIdConflictError(error: unknown): boolean;
};

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

function loadProviderNodeStore(database: Database): NodeStore {
  const db = createNodeSqliteBindingAdapter(database);
  const caseMapping = loadPinnedModule("src/lib/db/caseMapping.ts", specifier => {
    throw new Error(`Unexpected case-mapping dependency: ${specifier}`);
  });
  const core = { getDbInstance: () => db, rowToCamel: caseMapping.rowToCamel };
  const modelConcurrency = loadPinnedModule("src/shared/constants/modelConcurrency.ts", specifier => {
    throw new Error(`Unexpected model-concurrency dependency: ${specifier}`);
  });
  const columns = loadPinnedModule("src/lib/db/providers/columns.ts", specifier => {
    if (specifier === "@/shared/constants/modelConcurrency") return modelConcurrency;
    throw new Error(`Unexpected provider-column dependency: ${specifier}`);
  });
  const select = loadPinnedModule("src/lib/db/providerNodeSelect.ts", specifier => {
    throw new Error(`Unexpected provider-node selection dependency: ${specifier}`);
  });
  const nodePrefix = loadPinnedModule("src/lib/db/providers/nodePrefix.ts", specifier => {
    if (specifier === "../core") return core;
    throw new Error(`Unexpected provider-node prefix dependency: ${specifier}`);
  });
  return loadPinnedModule("src/lib/db/providers/nodes.ts", specifier => {
    if (specifier === "uuid") return { v4: randomUUID };
    if (specifier === "../core") return core;
    if (specifier === "../providerNodeSelect") return select;
    if (specifier === "../backup") return { backupDbFile: () => undefined };
    if (specifier === "../readCache") return { invalidateDbCache: () => undefined };
    if (specifier === "./columns") return columns;
    if (specifier === "./nodePrefix") return nodePrefix;
    throw new Error(`Unexpected provider-node persistence dependency: ${specifier}`);
  }) as NodeStore;
}

function loadFeatureFlagResolver(core: { readonly getDbInstance: () => Database }): PinnedExports {
  const definitions = loadPinnedModule("src/shared/constants/featureFlagDefinitions.ts", specifier => {
    throw new Error(`Unexpected feature-flag definition dependency: ${specifier}`);
  });
  const featureFlagStore = loadPinnedModule("src/lib/db/featureFlags.ts", specifier => {
    if (specifier === "@/shared/constants/featureFlagDefinitions") return definitions;
    if (specifier === "./core") return core;
    if (specifier === "./models/modelCatalogWriteSignals") return { finishModelCatalogWriteWithoutBackup: () => undefined };
    throw new Error(`Unexpected feature-flag storage dependency: ${specifier}`);
  });
  const processSingleton = loadPinnedModule("src/shared/utils/processSingleton.ts", specifier => {
    throw new Error(`Unexpected process-singleton dependency: ${specifier}`);
  });
  const bridge = loadPinnedModule("src/shared/utils/featureFlagResolverBridge.ts", specifier => {
    if (specifier === "@/shared/utils/processSingleton") return processSingleton;
    throw new Error(`Unexpected feature-flag bridge dependency: ${specifier}`);
  });
  return loadPinnedModule("src/shared/utils/featureFlags.ts", specifier => {
    if (specifier === "@/lib/db/featureFlags") return featureFlagStore;
    if (specifier === "@/shared/constants/featureFlagDefinitions") return definitions;
    if (specifier === "@/shared/utils/featureFlagResolverBridge") return bridge;
    throw new Error(`Unexpected feature-flag resolver dependency: ${specifier}`);
  });
}

function loadPaginationSchema(): unknown {
  const constants = {
    ACCOUNT_FALLBACK_STRATEGY_VALUES: [],
    ROUTING_STRATEGY_VALUES: [],
  };
  const misc = loadPinnedModule("src/shared/validation/schemas/misc.ts", specifier => {
    if (specifier === "zod") return { z: require("zod").z };
    if (specifier === "@/shared/constants/routingStrategies") return constants;
    if (specifier === "@/shared/constants/batchEndpoints") return { SUPPORTED_BATCH_ENDPOINTS: [] };
    if (specifier === "@/shared/constants/bodySize") return { MAX_REQUEST_BODY_LIMIT_MB: 10, MIN_REQUEST_BODY_LIMIT_MB: 1 };
    if (specifier === "@/shared/constants/comboConfigMode") return { COMBO_CONFIG_MODES: [] };
    if (specifier === "@/shared/constants/providers") return { providerAllowsOptionalApiKey: () => false };
    if (specifier === "@/shared/constants/sidebarVisibility") return { HIDEABLE_SIDEBAR_ITEM_IDS: [] };
    if (specifier === "@/shared/constants/upstreamHeaders") return {
      isForbiddenUpstreamHeaderName: () => false,
      isForbiddenCustomHeaderName: () => false,
    };
    if (specifier === "@/shared/utils/runtimeTimeouts") return { MAX_TIMER_TIMEOUT_MS: 86_400_000 };
    throw new Error(`Unexpected validation-schema dependency: ${specifier}`);
  });
  if (!misc.paginationSchema) throw new Error("Receipt-verified validation module omitted paginationSchema");
  return misc.paginationSchema;
}

function loadProviderNodeRoute(store: NodeStore, featureFlags: PinnedExports): NodeRoute {
  const zod = require("zod");
  const validation = loadPinnedModule("src/shared/validation/helpers.ts", specifier => {
    if (specifier === "next/server") return { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
    if (specifier === "zod") return zod;
    throw new Error(`Unexpected provider-node validation dependency: ${specifier}`);
  });
  const paginationSchema = loadPaginationSchema();
  return loadPinnedModule("src/app/api/provider-nodes/route.ts", specifier => {
    if (specifier === "next/server") return { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
    if (specifier === "@/models") return {
      getProviderNodes: store.getProviderNodes,
      createProviderNode: () => { throw new Error("provider-node creation is outside this GET-only fixture"); },
    };
    if (specifier === "@/lib/db/providers/nodes") return {
      getProviderNodesCount: store.getProviderNodesCount,
      isProviderNodeIdConflictError: store.isProviderNodeIdConflictError,
    };
    if (specifier === "@/lib/api/errorResponse") return {};
    if (specifier === "@/shared/constants/providers") return {
      OPENAI_COMPATIBLE_PREFIX: "openai-compatible",
      ANTHROPIC_COMPATIBLE_PREFIX: "anthropic-compatible",
      CLAUDE_CODE_COMPATIBLE_PREFIX: "claude-code-compatible",
    };
    if (specifier === "@/shared/utils") return { generateId: () => "unused-provider-node-id" };
    if (specifier === "@/shared/utils/featureFlags") return featureFlags;
    if (specifier === "@/shared/validation/schemas") return { paginationSchema };
    if (specifier === "@/shared/validation/helpers") return validation;
    if (specifier === "./urlGuard") return {};
    throw new Error(`Unexpected provider-node route dependency: ${specifier}`);
  }) as NodeRoute;
}

export class ProviderNodesFixture {
  readonly #database = new Database(":memory:");
  readonly #authorization: PinnedManagementAuthorization;
  readonly #store: NodeStore;
  readonly #route: NodeRoute;
  readonly #server: Bun.Server<undefined>;
  #centralAuthRequired = true;

  constructor(nodes: readonly ProviderNodeFixture[]) {
    this.#database.exec(extractedCoreSchema());
    for (const migration of [
      "src/lib/db/migrations/113_provider_node_icon_url.sql",
      "src/lib/db/migrations/172_provider_node_daily_quota_reset.sql",
    ]) this.#database.exec(readPinnedSource(migration));

    const sqlite = createNodeSqliteBindingAdapter(this.#database);
    const sourceCaseMapping = loadPinnedModule("src/lib/db/caseMapping.ts", specifier => {
      throw new Error(`Unexpected case-mapping dependency: ${specifier}`);
    });
    const core = {
      getDbInstance: () => sqlite,
      rowToCamel: sourceCaseMapping.rowToCamel,
    };
    this.#store = loadProviderNodeStore(this.#database);
    const featureFlags = loadFeatureFlagResolver(core);
    this.#route = loadProviderNodeRoute(this.#store, featureFlags);
    this.#authorization = createPinnedManagementAuthorization({
      isDashboardSession: () => false,
      verifyAccessToken: () => null,
      validateApiKey: token => token === "fixture-provider-nodes-manage" || token === "fixture-provider-nodes-read",
      getApiKeyMetadata: token => token === "fixture-provider-nodes-manage"
        ? { id: "provider-nodes-manage", scopes: ["manage", "admin"] }
        : token === "fixture-provider-nodes-read" ? { id: "provider-nodes-read", scopes: ["read"] } : null,
    });

    const insert = this.#database.prepare(`INSERT INTO provider_nodes (
      id, type, name, prefix, api_type, base_url, chat_path, models_path, icon_url,
      custom_headers_json, daily_quota_reset_timezone, daily_quota_reset_hour, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const node of nodes) insert.run(
      node.id, node.type, node.name, node.prefix, node.apiType, node.baseUrl,
      node.chatPath, node.modelsPath, node.iconUrl,
      node.customHeaders === null ? null : JSON.stringify(node.customHeaders),
      node.dailyQuotaResetTimezone, node.dailyQuotaResetHour, node.createdAt, node.updatedAt,
    );
    this.#database.prepare("INSERT INTO key_value (namespace, key, value) VALUES ('feature_flags', 'ENABLE_CC_COMPATIBLE_PROVIDER', 'true')").run();
    this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => this.#handle(request) });
  }

  get endpoint(): string { return this.#server.url.origin; }

  set centralAuthRequired(value: boolean) { this.#centralAuthRequired = value; }

  async state(): Promise<Record<string, unknown>[]> {
    return this.#store.getProviderNodes();
  }

  failList(): void {
    this.#database.exec("ALTER TABLE provider_nodes RENAME TO provider_nodes_fixture_failed");
  }

  async close(): Promise<void> {
    this.#server.stop(true);
    this.#database.close();
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== "/api/provider-nodes") return Response.json({ error: "Not found" }, { status: 404 });
    if (request.method !== "GET") return Response.json({ error: "Method not allowed" }, { status: 405 });
    return this.#authorization.dispatch(request, {
      centralAuthRequired: this.#centralAuthRequired,
      handlerAuthRequired: false,
    }, forwarded => this.#route.GET(forwarded));
  }
}
