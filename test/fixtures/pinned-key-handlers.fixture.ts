import * as crypto from "node:crypto";
import { posix } from "node:path";
import { Database } from "bun:sqlite";
import { createPinnedManagementAuthorization, loadPinnedAccessTokenAuth, loadPinnedModule, readPinnedSource, type PinnedExports } from "./pinned-handler.fixture.ts";
import { KEY_POLICY_FIELDS } from "../../src/admin/source-keys.ts";
import { projectKeyGrant, projectKeyGrantPage, projectCompleteKeyGrants } from "./keys.fixture.ts";

/** Disposable SQLite only: route and apiKeys SQL are the receipt-verified source. */
export function createPinnedKeyHandlers(sharedDb?: Database, options: { uuid?: () => string; date?: DateConstructor } = {}) {
  const db = sharedDb ?? new Database(":memory:");
  try {
  const schema = /const SCHEMA_SQL = `([\s\S]*?)`;/m.exec(readPinnedSource("src/lib/db/core.ts"))?.[1];
  if (!schema) throw new Error("Pinned core schema unavailable");
  if (!sharedDb) for (const table of ["api_keys", "domain_budgets", "domain_cost_history"]) {
    const sql = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\([\\s\\S]*?\\n\\s*\\);`, "i").exec(schema)?.[0];
    if (!sql) throw new Error(`Pinned schema omitted ${table}`);
    db.exec(sql);
  }
  // Upstream's node:sqlite permits bare names in binding objects; Bun requires prefixes.
  const sourceDb = new Proxy(db, {
    get(target, property) {
      if (property === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        const bindings = (args: unknown[]) => args.map(value => {
          if (!value || typeof value !== "object" || Array.isArray(value)) return value;
          return Object.fromEntries(Object.entries(value).map(([name, field]) => {
            const token = [`@${name}`, `:${name}`, `$${name}`].find(candidate => sql.includes(candidate));
            return [token ?? name, field];
          }));
        });
        return {
          all: (...args: unknown[]) => statement.all(...bindings(args) as never[]),
          get: (...args: unknown[]) => statement.get(...bindings(args) as never[]),
          run: (...args: unknown[]) => statement.run(...bindings(args) as never[]),
        };
      };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const deny = () => { throw new Error("Unrelated external key fixture boundary invoked"); };
  const unrelated = new Proxy({}, { get: () => deny });
  const cache = new Map<string, PinnedExports>();
  const loading = new Set<string>();
  const caseMapping = loadPinnedModule("src/lib/db/caseMapping.ts", deny);
  const noOp = () => undefined;
  const boundaries: Record<string, unknown> = {
    "src/lib/db/core.ts": { getDbInstance: () => sourceDb, rowToCamel: caseMapping.rowToCamel },
    "src/lib/db/backup.ts": { backupDbFile: noOp },
    "src/lib/db/stateReset.ts": { registerDbStateResetter: noOp },
    "src/lib/db/reasoningRoutingRules.ts": { invalidateReasoningRoutingRuleCache: noOp },
    "src/lib/compliance/noLog.ts": { setNoLog: noOp },
    "src/lib/db/apiKeyGroups.ts": unrelated,
    "src/lib/db/apiKeys/publishedModelLookup.ts": unrelated,
    "src/lib/db/apiKeys/selfLoopKey.ts": unrelated,
    "src/lib/db/apiKeys/modelPermissions.ts": unrelated,
    "src/lib/compliance.ts": { logAuditEvent: noOp },
    "src/shared/utils/rateLimiter.ts": { isRedisConfigured: () => false, getRedisClient: deny },
    "open-sse/services/modelDeprecation.ts": unrelated,
    "open-sse/utils/noThinkingAlias.ts": unrelated,
    "src/domain/modelAccessPolicy.ts": unrelated,
    "src/lib/db/encryption.ts": { isEncryptionEnabled: () => false, looksEncrypted: () => false, encrypt: deny, decrypt: deny },
    "src/shared/constants/providers.ts": { providerAllowsOptionalApiKey: () => false },
    "src/shared/constants/batchEndpoints.ts": { SUPPORTED_BATCH_ENDPOINTS: [] },
    "src/shared/constants/bodySize.ts": { MAX_REQUEST_BODY_LIMIT_MB: 10, MIN_REQUEST_BODY_LIMIT_MB: 1 },
    "src/shared/constants/comboConfigMode.ts": { COMBO_CONFIG_MODES: ["parallel", "fallback", "round-robin"] },
    "src/shared/constants/sidebarVisibility.ts": { HIDEABLE_SIDEBAR_ITEM_IDS: [] },
    "src/shared/utils/runtimeTimeouts.ts": { MAX_TIMER_TIMEOUT_MS: 86400000 },
  };
  const sourcePath = (parent: string, specifier: string): string => {
    let path: string;
    if (specifier.startsWith("@/")) path = `src/${specifier.slice(2)}`;
    else if (specifier.startsWith("@omniroute/open-sse/")) path = `open-sse/${specifier.slice("@omniroute/open-sse/".length)}`;
    else if (specifier.startsWith(".")) path = posix.normalize(posix.join(posix.dirname(parent), specifier));
    else throw new Error(`Unapproved key fixture import ${specifier} in ${parent}`);
    return /\.[cm]?[jt]s$/.test(path) ? path : `${path}.ts`;
  };
  const load = (path: string): PinnedExports => {
    const boundary = boundaries[path];
    if (boundary !== undefined) return boundary as PinnedExports;
    const existing = cache.get(path);
    if (existing) return existing;
    if (loading.has(path)) throw new Error(`Key fixture source cycle: ${path}`);
    loading.add(path);
    try {
      const result = loadPinnedModule(path, specifier => {
        if (specifier === "crypto" || specifier === "node:crypto") return crypto;
        if (specifier === "uuid") return { v4: options.uuid ?? crypto.randomUUID };
        if (specifier === "next/server") return { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
        return load(sourcePath(path, specifier));
      }, options.date ? { date: options.date } : {});
      cache.set(path, result);
      return result;
    } finally { loading.delete(path); }
  };
  const store = load("src/lib/db/apiKeys.ts");
  const auth = createPinnedManagementAuthorization({
    isDashboardSession: () => false,
    verifyAccessToken: token => token === "oma_fixture_read" ? { id: "r", name: "read", scope: "read" } : token === "oma_fixture_admin" ? { id: "a", name: "admin", scope: "admin" } : null,
    validateApiKey: key => key === "fixture-manage" || key === "fixture-low",
    getApiKeyMetadata: key => key === "fixture-manage" ? { id: "manager", scopes: ["manage"] } : key === "fixture-low" ? { id: "low", scopes: [] } : null,
  });
  const schemas = load("src/shared/validation/schemas/keys.ts");
  const validation = load("src/shared/validation/helpers.ts");
  const scopes = load("src/shared/constants/managementScopes.ts");
  const exposure = load("src/shared/utils/apiKeyMask.ts");
  const accessTokenAuth = loadPinnedAccessTokenAuth(token => token === "oma_fixture_read" ? { id: "r", name: "read", scope: "read" } : token === "oma_fixture_admin" ? { id: "a", name: "admin", scope: "admin" } : null);
  const sourceGuard = loadPinnedModule("src/lib/api/requireManagementAuth.ts", specifier => {
    if (specifier === "@/shared/utils/apiAuth") return { isAuthRequired: async () => true, isDashboardSessionAuthenticated: async () => false };
    if (specifier === "@/lib/api/errorResponse") return { createErrorResponse: ({ status, message }: { status: number; message: string }) => Response.json({ error: message }, { status }) };
    if (specifier === "@/sse/services/auth") return {
      extractApiKey: (request: Request) => request.headers.get("authorization")?.replace(/^Bearer /i, ""),
      isValidApiKey: async (key: string) => key === "fixture-manage" || key === "fixture-low",
    };
    if (specifier === "@/lib/db/apiKeys") return { getApiKeyMetadata: async (key: string) => key === "fixture-manage" ? { scopes: ["manage"] } : key === "fixture-low" ? { scopes: [] } : null };
    if (specifier === "@/lib/middleware/cliTokenAuth") return { isCliTokenAuthValid: async () => false };
    if (specifier === "@/server/authz/accessTokenAuth") return accessTokenAuth;
    if (specifier === "@/lib/api/internalServiceAuth") return { isTrustedLoopbackInternalServiceRequest: () => false };
    if (specifier === "@/server/authz/headers") return load("src/server/authz/headers.ts");
    if (specifier === "@/shared/constants/managementScopes") return scopes;
    throw new Error(`Unapproved scoped-guard import: ${specifier}`);
  });
  const loadRoute = (path: string): PinnedExports => loadPinnedModule(path, specifier => {
    if (specifier === "next/server") return { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
    if (specifier === "@/lib/db/apiKeys") return store;
    if (specifier === "@/lib/db/settings") return { isCloudEnabled: async () => false };
    if (specifier === "@/shared/utils/machineId") return { getConsistentMachineId: async () => "fixture-machine" };
    if (specifier === "@/lib/cloudSync") return { syncToCloud: deny };
    if (specifier === "@/shared/validation/schemas") return schemas;
    if (specifier === "@/shared/validation/helpers") return validation;
    if (specifier === "@/lib/apiKeyExposure") return { isApiKeyRevealEnabled: () => false, ...exposure };
    if (specifier === "@/lib/api/requireManagementAuth") return {
      requireManagementAuth: (request: Request) => auth.requireManagementAuth(request),
      requireCredentialForManagementScopedKey: sourceGuard.requireCredentialForManagementScopedKey,
    };
    if (specifier === "@/shared/constants/selfServiceScopes") return load("src/shared/constants/selfServiceScopes.ts");
    if (specifier === "@/sse/utils/logger") return { error: noOp };
    if (specifier === "@omniroute/open-sse/utils/error.ts") return { buildErrorBody: (_status: number, message: string) => ({ error: { message } }) };
    throw new Error(`Unapproved key route import: ${specifier}`);
  });
  const collection = loadRoute("src/app/api/keys/route.ts");
  const item = loadRoute("src/app/api/keys/[id]/route.ts");
  return {
    async request(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, options: { body?: unknown; token?: string; rawBody?: string; authRequired?: boolean; privatePolicy?: boolean } = {}) {
      const url = new URL(path, "http://127.0.0.1:3190");
      const segment = /^\/api\/keys\/([^/]+)$/.exec(url.pathname)?.[1];
      const id = segment === undefined ? undefined : decodeURIComponent(segment);
      if (url.pathname !== "/api/keys" && id === undefined) throw new Error("Unsupported fixture key path");
      const route = id === undefined ? collection : item;
      const handler = route[method];
      if (typeof handler !== "function") throw new Error("Unsupported fixture key operation");
      const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
      const request = new Request(url, { method, headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body }) });
      const response = await auth.dispatch(request, { centralAuthRequired: options.authRequired ?? true, handlerAuthRequired: options.authRequired ?? true }, async forwarded => {
        const previous = process.env.API_KEY_SECRET;
        process.env.API_KEY_SECRET = "disposable-key-fixture-secret";
        try { return await (handler(forwarded, { params: Promise.resolve({ id }) }) as Promise<Response>); }
        finally {
          if (previous === undefined) delete process.env.API_KEY_SECRET;
          else process.env.API_KEY_SECRET = previous;
        }
      });
      const data: unknown = await response.json();
      if (options.privatePolicy && response.ok && method === "GET" && id === undefined) {
        if (typeof data !== "object" || data === null || !("keys" in data) || !Array.isArray(data.keys) || !("total" in data)) throw new Error("Invalid key inventory");
        const allowed = new Set<string>(["id", ...KEY_POLICY_FIELDS]);
        return { status: response.status, data: { keys: data.keys.map((row: unknown) => {
          if (typeof row !== "object" || row === null || Array.isArray(row)) throw new Error("Invalid key row");
          return Object.fromEntries(Object.entries(row).filter(([name]) => allowed.has(name)));
        }), total: data.total } };
      }
      // Discard the one-time source secret before returning from the fixture boundary.
      const projected = response.ok && method === "POST" ? projectKeyGrant(data)
        : response.ok && method === "GET" && id !== undefined ? projectKeyGrant(data)
        : response.ok && method === "GET" && !url.search ? projectCompleteKeyGrants(data)
        : response.ok && method === "GET" ? projectKeyGrantPage(data)
        : response.ok && (method === "PATCH" || method === "DELETE") ? { message: typeof data === "object" && data !== null && "message" in data && typeof data.message === "string" ? data.message : "" }
        : { error: response.status };
      return { status: response.status, data: projected };
    },
    dropKeyTable() { db.exec("DROP TABLE api_keys"); },
    close() { if (!sharedDb) db.close(); },
  };
  } catch (error) {
    if (!sharedDb) db.close();
    throw error;
  }
}
