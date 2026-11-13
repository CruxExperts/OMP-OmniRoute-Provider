import type { ValidatedOperationInput } from "./registry.ts";
import type { JsonValue } from "./types.ts";

export const PROXY_USAGE_PREFLIGHT = "omniroute-v3.8.53.proxies.delete-usage-preflight" as const;
const DELETE_PROXY = "DELETE /api/settings/proxies";
const GET_PROXY = "GET /api/settings/proxies";

export function proxyUsagePreflightMatches(id: unknown, operationId: string, readId: unknown): boolean {
  return id === PROXY_USAGE_PREFLIGHT && operationId === DELETE_PROXY && readId === GET_PROXY;
}

export function proxyUsagePreflightInput(id: unknown, payload: ValidatedOperationInput, input: ValidatedOperationInput): ValidatedOperationInput {
  if (id !== PROXY_USAGE_PREFLIGHT) return input;
  const target = payload.query.id;
  if (typeof target !== "string" || target.length === 0) throw new TypeError("proxy delete requires a nonempty id");
  return { path: {}, query: { id: target, whereUsed: "1" } };
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError("invalid proxy usage response");
  return value as Record<string, unknown>;
}

export function proxyUsagePreflightSnapshot(payload: ValidatedOperationInput, response: unknown): JsonValue {
  const target = payload.query.id;
  if (typeof target !== "string" || !target) throw new TypeError("proxy usage target missing");
  const source = record(response);
  if (!Number.isSafeInteger(source.count) || !Number.isSafeInteger(source.assignmentCount) || !Number.isSafeInteger(source.accountReferenceCount)
    || !Array.isArray(source.assignments) || !Array.isArray(source.accountReferences)) throw new TypeError("invalid proxy usage response");
  if (source.assignments.length > 10_000 || source.accountReferences.length > 10_000 || Buffer.byteLength(JSON.stringify(response), "utf8") > 8 * 1024 * 1024) throw new TypeError("proxy usage response exceeds bounds");
  const assignments = source.assignments.map(value => {
    const row = record(value);
    if (typeof row.scope !== "string" || !(typeof row.scopeId === "string" || row.scopeId === null) || row.proxyId !== target) throw new TypeError("invalid proxy usage assignment");
    return { scope: row.scope, scopeId: row.scopeId, proxyId: target };
  });
  const accounts = source.accountReferences.map(value => {
    const row = record(value);
    if (typeof row.connectionId !== "string" || !row.connectionId || typeof row.provider !== "string" || !row.provider
      || typeof row.accountCount !== "number" || !Number.isSafeInteger(row.accountCount) || row.accountCount < 1) throw new TypeError("invalid proxy account usage");
    return { connectionId: row.connectionId, provider: row.provider, accountCount: row.accountCount };
  });
  const accountCount = accounts.reduce((sum, row) => sum + row.accountCount, 0);
  if (new Set(assignments.map(row => JSON.stringify(row))).size !== assignments.length || new Set(accounts.map(row => row.connectionId)).size !== accounts.length) throw new TypeError("ambiguous proxy usage response");
  if (source.assignmentCount !== assignments.length || source.accountReferenceCount !== accountCount || source.count !== assignments.length + accountCount) throw new TypeError("incomplete proxy usage response");
  assignments.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  accounts.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { kind: "resource", entries: [{ identity: { id: target }, state: { count: source.count as number, assignments, accountReferences: accounts } }] };
}

export type ProxyRequestValidatorId = "omniroute-v3.8.53.proxies.create" | "omniroute-v3.8.53.proxies.update" | "omniroute-v3.8.53.proxies.assign";

/** Checks the strict pinned schemas, including the scoped-assignment refinement. */
export function validateProxyRequest(id: ProxyRequestValidatorId, value: unknown): { field: string; reason: string } | undefined {
  const issue = (field: string, reason: string) => ({ field, reason });
  if (value === null || typeof value !== "object" || Array.isArray(value)) return issue("body", "expected object");
  const body = value as Record<string, unknown>;
  const assignment = id === "omniroute-v3.8.53.proxies.assign" ? body : body.assignment;
  if (assignment !== undefined) {
    if (assignment === null || typeof assignment !== "object" || Array.isArray(assignment)) return issue("assignment", "expected object");
    const fields = assignment as Record<string, unknown>;
    const allowed = id.endsWith(".assign") ? ["scope", "scopeId", "proxyId"] : ["scope", "scopeId"];
    if (Object.keys(fields).some(key => !allowed.includes(key))) return issue("assignment", "unknown field");
    if (typeof fields.scope !== "string" || !["global", "provider", "account", "combo", "key"].includes(fields.scope)) return issue("scope", "invalid scope");
    if (fields.scopeId !== undefined && fields.scopeId !== null && typeof fields.scopeId !== "string") return issue("scopeId", "expected string or null");
    if (fields.scope !== "global" && (typeof fields.scopeId !== "string" || !fields.scopeId.trim())) return issue("scopeId", "required for non-global scope");
    if (id.endsWith(".assign") && fields.proxyId !== undefined && fields.proxyId !== null && typeof fields.proxyId !== "string") return issue("proxyId", "expected string or null");
  }
  if (id.endsWith(".assign")) return undefined;
  const allowed = ["name", "type", "host", "port", "username", "password", "region", "notes", "status", "source", "family", "assignment", ...(id.endsWith(".update") ? ["id", "subscriptionId"] : [])];
  if (Object.keys(body).some(key => !allowed.includes(key))) return issue("body", "unknown field");
  if (id.endsWith(".update") && (typeof body.id !== "string" || !body.id.trim())) return issue("id", "required");
  for (const [field, max] of [["name", 120], ["host", 255]] as const) {
    const item = body[field];
    if ((id.endsWith(".create") || item !== undefined) && (typeof item !== "string" || !item.trim() || item.trim().length > max)) return issue(field, "invalid value");
  }
  if (id.endsWith(".create") || body.port !== undefined) {
    let port: number;
    try { port = Number(body.port); } catch { return issue("port", "invalid port"); }
    if (!Number.isInteger(port) || port < 1 || port > 65535) return issue("port", "invalid port");
  }
  if (body.type !== undefined && (typeof body.type !== "string" || !["http", "https", "socks5", "vercel", "deno", "cloudflare"].includes(body.type.trim().toLowerCase()))) return issue("type", "invalid type");
  for (const field of ["username", "password"] as const) if (body[field] !== undefined && typeof body[field] !== "string") return issue(field, "expected string");
  for (const [field, max] of [["region", 64], ["notes", 1000]] as const) if (body[field] !== undefined && body[field] !== null && (typeof body[field] !== "string" || body[field].trim().length > max)) return issue(field, "invalid value");
  if (body.subscriptionId !== undefined && body.subscriptionId !== null && (typeof body.subscriptionId !== "string" || !body.subscriptionId.trim())) return issue("subscriptionId", "invalid value");
  for (const [field, allowedValues] of [["status", ["active", "inactive", "dead"]], ["source", ["manual", "oneproxy", "dashboard-custom", "vercel-relay", "deno-relay", "cloudflare-relay"]], ["family", ["auto", "ipv4", "ipv6"]]] as const) {
    if (body[field] !== undefined && (typeof body[field] !== "string" || !(allowedValues as readonly string[]).includes(body[field]))) return issue(field, "invalid value");
  }
  return undefined;
}
