import * as crypto from "node:crypto";
import { posix } from "node:path";
import { Database } from "bun:sqlite";
import * as zod from "zod";
import { createPinnedManagementAuthorization, loadExtractedPinnedDeclarations, loadPinnedModule, readPinnedSource, type PinnedExports } from "./pinned-handler.fixture.ts";
import { projectAssignment, projectAssignmentProof, projectAssignments, projectProxy, projectProxyList, projectProxyListProof, projectProxyProof, projectProxyUsage } from "./proxies.fixture.ts";

/** Receipt-verified route and store, with SQLite and bounded infrastructure edges. */
export function createPinnedProxyHandlers(sharedDb?: Database) {
  const db = sharedDb ?? new Database(":memory:");
  const schema = /const SCHEMA_SQL = `([\s\S]*?)`;/m.exec(readPinnedSource("src/lib/db/core.ts"))?.[1];
  if (!schema) throw new Error("Pinned core schema unavailable");
  if (!sharedDb) for (const table of ["key_value", "provider_connections"]) {
    const sql = new RegExp(`CREATE TABLE IF NOT EXISTS ${table}\\s*\\([\\s\\S]*?\\n\\s*\\);`, "i").exec(schema)?.[0];
    if (!sql) throw new Error(`Pinned schema omitted ${table}`);
    db.exec(sql);
  }
  if (!sharedDb) for (const migration of [
    "src/lib/db/migrations/004_proxy_registry.sql",
    "src/lib/db/migrations/017_version_manager_upstream_proxy.sql",
    "src/lib/db/migrations/040_oneproxy_proxy_fields.sql",
    "src/lib/db/migrations/099_proxy_family.sql",
    "src/lib/db/migrations/117_proxy_pool_rotation.sql",
    "src/lib/db/migrations/131_proxy_subscriptions.sql",
  ]) db.exec(readPinnedSource(migration));
  const deny = () => { throw new Error("Unapproved proxy fixture boundary invoked"); };
  const noop = () => undefined;
  const rotation = loadExtractedPinnedDeclarations(["src/lib/db/proxies/rotation.ts"], ["clearRotationState", "resetRotationCursor"], deny);
  const auth = createPinnedManagementAuthorization({
    isDashboardSession: () => false,
    verifyAccessToken: token => token === "oma_fixture-admin" ? { id: "admin", name: "admin", scope: "admin" } : token === "oma_fixture-read" ? { id: "read", name: "read", scope: "read" } : null,
    validateApiKey: key => key === "fixture-manage" || key === "fixture-manage-rotated" || key === "fixture-low",
    getApiKeyMetadata: key => key === "fixture-manage" || key === "fixture-manage-rotated" ? { id: key, scopes: ["manage"] } : key === "fixture-low" ? { id: "low", scopes: [] } : null,
  });
  const cache = new Map<string, PinnedExports>();
  const loading = new Set<string>();
  const boundaries: Record<string, unknown> = {
    "src/lib/db/core.ts": { getDbInstance: () => db },
    "src/lib/db/backup.ts": { backupDbFile: noop },
    "src/lib/db/encryption.ts": { looksEncrypted: () => false, decrypt: deny },
    "src/lib/db/proxies/rotation.ts": rotation,
    "src/lib/db/proxySubscriptions.ts": { addProxiesToScopePool: deny },
    "src/lib/db/settings.ts": { resolveProxyForConnection: deny, bumpProxyConfigGeneration: noop },
    "src/lib/db/relayProbeStats.ts": { getRelayProbeStats: () => ({}) },
    "src/shared/constants/providers.ts": { providerAllowsOptionalApiKey: () => false },
    "src/shared/constants/sidebarVisibility.ts": { HIDEABLE_SIDEBAR_ITEM_IDS: [] },
    "src/lib/api/requireManagementAuth.ts": { requireManagementAuth: (request: Request) => auth.requireManagementAuth(request) },
  };
  const sourcePath = (parent: string, specifier: string) => {
    const path = specifier.startsWith("@/") ? `src/${specifier.slice(2)}` : specifier.startsWith("@omniroute/open-sse/") ? `open-sse/${specifier.slice("@omniroute/open-sse/".length)}` : specifier.startsWith(".") ? posix.normalize(posix.join(posix.dirname(parent), specifier)) : "";
    if (!path) throw new Error(`Unapproved proxy import ${specifier} in ${parent}`);
    return /\.[cm]?[jt]s$/.test(path) ? path : `${path}.ts`;
  };
  const load = (path: string): PinnedExports => {
    if (boundaries[path] !== undefined) return boundaries[path] as PinnedExports;
    const existing = cache.get(path);
    if (existing) return existing;
    if (loading.has(path)) throw new Error(`Proxy source cycle: ${path}`);
    loading.add(path);
    try {
      const result = loadPinnedModule(path, specifier => {
        if (specifier === "crypto" || specifier === "node:crypto") return crypto;
        if (specifier === "zod") return zod;
        if (specifier === "next/server") return { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
        if (specifier === "@omniroute/open-sse/utils/proxyDispatcher") return { clearDispatcherCache: noop, isSocks5ProxyEnabled: () => true };
        if (specifier === "@/shared/validation/schemas") return load("src/shared/validation/schemas/proxy.ts");
        return load(sourcePath(path, specifier));
      });
      cache.set(path, result);
      return result;
    } finally { loading.delete(path); }
  };
  const collection = load("src/app/api/settings/proxies/route.ts");
  const assignments = load("src/app/api/settings/proxies/assignments/route.ts");
  return {
    async request(method: "GET" | "POST" | "PATCH" | "DELETE" | "PUT", path: string, options: { body?: unknown; rawBody?: string; token?: string; assignmentProof?: boolean; proxyProof?: boolean } = {}) {
      const url = new URL(path, "http://127.0.0.1:3190");
      if (url.pathname !== "/api/settings/proxies" && url.pathname !== "/api/settings/proxies/assignments") throw new Error("Unsupported proxy fixture path");
      if (url.searchParams.has("resolveConnectionId")) throw new Error("Connection resolution excluded from fixture projection");
      const route = url.pathname.endsWith("/assignments") ? assignments : collection;
      const handler = route[method];
      if (typeof handler !== "function") throw new Error("Unsupported proxy fixture method");
      const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
      const request = new Request(url, { method, headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { body }) });
      const response = await auth.dispatch(request, { centralAuthRequired: true, handlerAuthRequired: true }, forwarded => handler(forwarded) as Promise<Response>);
      const data: unknown = await response.json();
      if (!response.ok) return { status: response.status, data: null };
      if (url.pathname.endsWith("/assignments")) {
        if (method === "GET") return { status: response.status, data: options.assignmentProof ? projectAssignmentProof(data) : projectAssignments(data) };
        if (!data || typeof data !== "object" || !("success" in data) || !("assignment" in data)) throw new Error("Invalid assignment response");
        return { status: response.status, data: { success: data.success === true, assignment: data.assignment === null ? null : projectAssignment(data.assignment) } };
      }
      if (method === "DELETE") {
        if (!data || typeof data !== "object" || !("success" in data)) throw new Error("Invalid delete response");
        return { status: response.status, data: { success: data.success === true } };
      }
      if (method === "GET" && url.searchParams.get("whereUsed") === "1" && url.searchParams.get("id")) return { status: response.status, data: projectProxyUsage(data) };
      if (method === "GET" && !url.searchParams.has("id")) return { status: response.status, data: options.proxyProof ? projectProxyListProof(data) : projectProxyList(data) };
      return { status: response.status, data: options.proxyProof ? projectProxyProof(data) : projectProxy(data) };
    },
    rotation(scope: string, scopeId: string) {
      return db.prepare("SELECT strategy, cursor FROM proxy_scope_rotation WHERE scope = ? AND scope_id = ?").get(scope, scopeId);
    },
    dropAssignmentTable() { db.exec("DROP TABLE proxy_assignments"); },
    breakAssignmentSchema() { db.exec("DROP TABLE proxy_assignments; CREATE TABLE proxy_assignments (id INTEGER PRIMARY KEY)"); },
    dropProxyTable() { db.exec("DROP TABLE proxy_registry"); },
    breakProxySchema() { db.exec("DROP TABLE proxy_registry; CREATE TABLE proxy_registry (id TEXT PRIMARY KEY)"); },
    close() { if (!sharedDb) db.close(); },
  };
}
