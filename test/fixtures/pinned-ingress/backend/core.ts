/* Research-only database boundary. Source authorization and token validation remain upstream. */
import { appendFileSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { API_KEY_COLUMN_FALLBACKS } from "@/lib/db/apiKeyColumnFallbacks";

type Row = { id: string; token_hash: string; token_prefix: string; name: string; scope: string; created_at: string; last_used_at: string | null; expires_at: string | null; revoked_at: string | null };
type KeyRow = Record<string, unknown> & { id: string; key_hash: string | null; key?: string | null; key_prefix?: string | null; last_used_at?: string | null };
type State = { tokens: Row[]; apiKeys?: KeyRow[]; ipFilter?: { enabled: boolean; mode: string; blacklist: string[]; whitelist: string[] }; failTokenRead?: boolean; failApiKeyRead?: boolean };
const file = process.env.INGRESS_STATE_FILE;
const events = process.env.INGRESS_EVENT_FILE;
if (!file?.startsWith("/work/data/") || !events?.startsWith("/work/data/")) throw new Error("INGRESS_SANDBOX_PATH_REQUIRED");
const state = JSON.parse(readFileSync(file, "utf8")) as State;
if (!Array.isArray(state.tokens)) throw new Error("INGRESS_INVALID_STATE");
const rows = state.tokens.map(row => ({ ...row }));
const apiKeys = (state.apiKeys ?? []).map(row => ({ ...row }));
if (!apiKeys.every(row => typeof row.id === "string" && (row.key_hash === null || typeof row.key_hash === "string"))) throw new Error("INGRESS_INVALID_API_KEYS");
const keyValidationQuery = "SELECT id, expires_at, revoked_at, is_active, is_banned FROM api_keys WHERE key_hash = ?";
const keyMetadataQuery = "SELECT id, name, machine_id, model_access_mode, allowed_models, blocked_models, allowed_combos, allowed_connections, preferred_connections, allowed_quotas, no_log, auto_resolve, is_active, access_schedule, max_requests_per_day, max_requests_per_minute, throttle_delay_ms, max_sessions, revoked_at, expires_at, ip_allowlist, scopes, rate_limits, is_banned, key_hash, allowed_endpoints, stream_default_mode, cache_default_mode, codex_service_mode, disable_non_public_models, allow_usage_command, usage_limit_enabled, daily_usage_limit_usd, weekly_usage_limit_usd, chaos_mode_enabled, compression_enabled, allow_auto_combos, allow_cc_discovery_aliases, catalog_scope, forced_model, proxy_id FROM api_keys WHERE key_hash = ?";
const legacyKeyQuery = "SELECT id, key, key_hash, key_prefix FROM api_keys WHERE key_hash IS NULL OR key_hash = ''";
function event(name: string): void { appendFileSync(events!, JSON.stringify({ event: name }) + "\n", { mode: 0o600 }); }
function unsupported(operation: string): never { event(`unsupported:${operation}`); throw new Error(`INGRESS_UNSUPPORTED:${operation}`); }
export const isCloud = false;
export const isBuildPhase = process.env.OMNIROUTE_BUILDING === "1";
export const DATA_DIR = "/work/data";
export const SQLITE_FILE = "/work/data/fixture.sqlite";
export function rowToCamel(): never { return unsupported("rowToCamel"); }
export function cleanNulls(): never { return unsupported("cleanNulls"); }
export function applyDatabaseOptimizationSettings(): never { return unsupported("applyDatabaseOptimizationSettings"); }
export function getDbInstance() {
  return {
    prepare(sql: string) {
      const normalized = sql.replace(/\s+/g, " ").trim();
      return {
        get(...args: unknown[]) {
          if (normalized === "SELECT * FROM cli_access_tokens WHERE token_hash = ?") {
            event("access-token:lookup");
            if (state.failTokenRead) throw new Error("INGRESS_TOKEN_BACKEND_ERROR");
            return rows.find(row => row.token_hash === args[0]);
          }
          if (normalized === keyValidationQuery || normalized === keyMetadataQuery) {
            event(normalized === keyValidationQuery ? "key-validation-read" : "key-metadata-read");
            if (state.failApiKeyRead) throw new Error("INGRESS_API_KEY_BACKEND_ERROR");
            return apiKeys.find(row => row.key_hash === args[0]);
          }
          if (normalized === "SELECT value FROM key_value WHERE namespace = ? AND key = ?" && args[0] === "ipFilter" && args[1] === "config") {
            event("ip-filter:read");
            return state.ipFilter ? { value: JSON.stringify(state.ipFilter) } : undefined;
          }
          return unsupported(`get:${createHash("sha256").update(normalized).digest("hex")}`);
        },
        run(...args: unknown[]) {
          if (normalized === "UPDATE cli_access_tokens SET last_used_at = ? WHERE id = ?") {
            event("access-token:usage-stamp");
            const row = rows.find(item => item.id === args[1]);
            if (!row || typeof args[0] !== "string") return unsupported("usage-stamp-arguments");
            row.last_used_at = args[0];
            return { changes: 1, lastInsertRowid: 0 };
          }
          if (normalized === "UPDATE api_keys SET last_used_at = @lastUsedAt WHERE id = @id") {
            event("key-usage-stamp");
            const params = args[0] as { id?: unknown; lastUsedAt?: unknown } | undefined;
            const row = apiKeys.find(item => item.id === params?.id);
            if (!row || typeof params?.lastUsedAt !== "string") return unsupported("key-stamp-arguments");
            row.last_used_at = params.lastUsedAt;
            return { changes: 1, lastInsertRowid: 0 };
          }
          if (normalized === "UPDATE api_keys SET key = ?, key_hash = ?, key_prefix = ? WHERE id = ?") {
            event("api-key:backfill");
            const row = apiKeys.find(item => item.id === args[3]);
            if (!row || typeof args[0] !== "string" || typeof args[1] !== "string" || typeof args[2] !== "string") return unsupported("key-backfill-arguments");
            row.key = args[0]; row.key_hash = args[1]; row.key_prefix = args[2];
            return { changes: 1, lastInsertRowid: 0 };
          }
          return unsupported(`run:${createHash("sha256").update(normalized).digest("hex")}`);
        },
        all() {
          if (normalized === "PRAGMA table_info(api_keys)") { event("key-schema-read"); return API_KEY_COLUMN_FALLBACKS.map(column => ({ name: column.name })); }
          if (normalized === legacyKeyQuery) { event("key-legacy-read"); return apiKeys.filter(row => row.key_hash === null || row.key_hash === ""); }
          return unsupported(`all:${createHash("sha256").update(normalized).digest("hex")}`);
        },
      };
    },
    exec() { return unsupported("exec"); },
    pragma() { return unsupported("pragma"); },
    transaction() { return unsupported("transaction"); },
  };
}
