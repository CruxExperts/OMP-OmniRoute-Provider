import { Database } from "bun:sqlite";
import * as zod from "zod";
import { createPinnedManagementAuthorization, loadPinnedModule, readPinnedSource } from "./pinned-handler.fixture.ts";

/** Warm, disposable SQLite and bounded infrastructure; not a cold-start or framework-ingress proof. */
export function createPinnedSettingsFixture(sharedDb?: Database) {
  const db = sharedDb ?? new Database(":memory:");
  if (!sharedDb) {
    const schema = /CREATE TABLE IF NOT EXISTS key_value\s*\([\s\S]*?\n\s*\);/i.exec(readPinnedSource("src/lib/db/core.ts"))?.[0];
    if (!schema) throw new Error("Pinned key_value schema unavailable");
    db.exec(schema);
  }
  let failOpen = false;
  const deny = () => { throw new Error("Unexpected settings fixture boundary"); };
  const auth = createPinnedManagementAuthorization({
    isDashboardSession: () => false,
    verifyAccessToken: token => token === "oma_fixture-read" ? { id: "read", name: "read", scope: "read" } : null,
    validateApiKey: key => key === "fixture-manage",
    getApiKeyMetadata: key => key === "fixture-manage" ? { id: "manage", scopes: ["manage"] } : null,
  });
  const shared = loadPinnedModule("src/lib/db/settings/shared.ts", deny);
  const storage = loadPinnedModule("src/lib/db/settings.ts", specifier => {
    switch (specifier) {
      case "./core": return { getDbInstance: () => { if (failOpen) throw new Error("private backend failure"); return db; } };
      case "./settings/shared": return shared;
      case "@omniroute/open-sse/config/providerModels.ts": return { PROVIDER_ID_TO_ALIAS: {} };
      case "./encryption": return { decrypt: (value: string) => value, encrypt: deny };
      case "@/shared/constants/bodySize": return { requestBodyLimitMbFromEnv: () => null };
      case "@/shared/constants/responsesPreviousResponseId": return { DEFAULT_RESPONSES_PREVIOUS_RESPONSE_ID_MODE: "off" };
      case "@/shared/constants/proxyBulkImport": return { PROXY_BULK_IMPORT_LIMIT_DEFAULT: 100 };
      case "./backup": case "@omniroute/open-sse/utils/proxyRefusalMemory.ts": case "@/shared/utils/featureFlags": case "./readCache": case "./proxies": case "@omniroute/open-sse/config/providerErrorRules.ts": case "@/lib/combos/steps": case "@/shared/utils/decodeUserinfo": case "./settings/noAuthProxyFallback": case "./settings/pricing": case "./settings/lkgp": case "./settings/cacheMetrics": return {};
      default: throw new Error(`Unexpected settings storage import: ${specifier}`);
    }
  });
  const route = loadPinnedModule("src/app/api/settings/route.ts", specifier => {
    switch (specifier) {
      case "next/server": return { NextResponse: { json: Response.json.bind(Response) } };
      case "zod": return zod;
      case "@/lib/db/settings": return storage;
      case "@/lib/api/requireManagementAuth": return { requireManagementAuth: auth.requireManagementAuth };
      case "@/lib/runtime/ports": return { getRuntimePorts: () => ({ apiPort: 1234, dashboardPort: 1235 }) };
      case "@/lib/cloudSync": return { CLOUD_URL: "https://private-cloud.invalid" };
      case "@/shared/utils/machineId": return { getConsistentMachineId: async () => "private-machine" };
      case "@/lib/db/upstreamProxy": return { getUpstreamProxyConfig: async () => null };
      case "@/lib/auth/managementPassword": return { hasManagementPasswordConfigured: () => false };
      case "@/shared/utils/featureFlags": return { isFeatureFlagEnabled: () => false };
      case "@/shared/utils/dashboardSessionToken": return { SESSIONS_VALID_AFTER_SETTING: "sessionsValidAfter", REVOKED_SESSIONS_SETTING: "revokedSessions" };
      case "@/server/authz/headers": return { AUTHZ_HEADER_AUTH_KIND: "x-auth-kind", AUTHZ_HEADER_AUTH_ID: "x-auth-id", AUTHZ_HEADER_PEER_LOCALITY: "x-peer-locality" };
      case "@/lib/radar/links": return { getRadarAdminUrl: () => "https://private-radar.invalid" };
      case "@/shared/utils/apiAuth": return { isAuthRequired: async () => true };
      case "@/shared/constants/securityImpactingSettings": return { SECURITY_IMPACTING_SETTINGS_KEYS: [], DASHBOARD_SESSION_STATE_SETTINGS_KEYS: [] };
      case "@/shared/validation/settingsSchemas": case "@/shared/utils/oidcAdmissionClaim": case "@/shared/validation/helpers": case "@/lib/resilience/modelLockoutSettings": case "@/lib/db/providers": case "@omniroute/open-sse/executors/cliproxyapi.ts": case "@/lib/api/operatorCredential": case "@/shared/utils/freeModels": case "@/lib/compliance": case "@/lib/api/settingsAudit": return {};
      default: throw new Error(`Unexpected settings route import: ${specifier}`);
    }
  });
  const get = route.GET as (request: Request) => Promise<Response>;
  return {
    db, authorization: auth, get,
    setFailure(value: boolean) { failOpen = value; },
    async handle(token?: string, query = "") {
      const request = new Request(`http://fixture.invalid/api/settings${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      return auth.dispatch(request, { centralAuthRequired: true, handlerAuthRequired: true }, get);
    },
    close() { if (!sharedDb) db.close(); },
  };
}

/** Warm SQLite and source-backed handler/store; not framework ingress or lifecycle evidence. */
export function createPinnedReasoningRulesFixture() {
  const db = new Database(":memory:");
  const migration = readPinnedSource("src/lib/db/migrations/126_reasoning_routing_rules.sql");
  const table = /CREATE TABLE IF NOT EXISTS reasoning_routing_rules\s*\([\s\S]*?\n\);/i.exec(migration)?.[0];
  if (!table) throw new Error("Pinned reasoning rules schema unavailable");
  db.exec(table);
  let failOpen = false;
  const auth = createPinnedManagementAuthorization({
    isDashboardSession: token => token === "fixture-session",
    verifyAccessToken: token => token === "oma_fixture-read" ? { id: "read", name: "read", scope: "read" } : null,
    validateApiKey: key => key === "fixture-manage" || key === "fixture-unscoped",
    getApiKeyMetadata: key => key === "fixture-manage" ? { id: "manage", scopes: ["manage"] } : key === "fixture-unscoped" ? { id: "unscoped", scopes: [] } : null,
  });
  const store = loadPinnedModule("src/lib/db/reasoningRoutingRules.ts", specifier => {
    if (specifier === "node:crypto") return { randomUUID: () => { throw new Error("Unexpected write"); } };
    if (specifier === "./core") return { getDbInstance: () => { if (failOpen) throw new Error("fixture-private-database-error"); return db; } };
    if (specifier === "./stateReset") return { registerDbStateResetter: () => {} };
    throw new Error(`Unexpected reasoning store import: ${specifier}`);
  });
  const route = loadPinnedModule("src/app/api/settings/reasoning-routing-rules/route.ts", specifier => {
    if (specifier === "next/server") return { NextResponse: { json: Response.json.bind(Response) } };
    if (specifier === "@/lib/api/requireManagementAuth") return { requireManagementAuth: auth.requireManagementAuth };
    if (specifier === "@/lib/db/reasoningRoutingRules") return store;
    if (specifier === "@/lib/reasoningRouting/input" || specifier === "@/shared/validation/schemas" || specifier === "@/shared/validation/helpers" || specifier === "@omniroute/open-sse/utils/error.ts") return {};
    throw new Error(`Unexpected reasoning route import: ${specifier}`);
  });
  const get = route.GET as (request: Request) => Promise<Response>;
  return {
    db,
    invalidate() { (store.invalidateReasoningRoutingRuleCache as () => void)(); },
    setFailure(value: boolean) { failOpen = value; },
    async handle(token?: string) {
      const headers = new Headers();
      if (token === "fixture-session") headers.set("cookie", `auth_token=${token}`);
      else if (token) headers.set("authorization", `Bearer ${token}`);
      const request = new Request("http://fixture.invalid/api/settings/reasoning-routing-rules", { headers });
      return auth.dispatch(request, { centralAuthRequired: true, handlerAuthRequired: true }, get);
    },
    close() { db.close(); },
  };
}
