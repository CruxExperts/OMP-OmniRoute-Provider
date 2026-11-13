import type { JsonValue } from "./types.ts";

/** A complete key inventory projected only to the grants used by combo operations. */
export const KEY_GRANTS_PREFLIGHT = "omniroute-v3.8.53.keys.grants-preflight" as const;
export const KEY_POLICY_PREFLIGHT = "omniroute-v3.8.53.keys.policy-preflight" as const;
export const KEY_POLICY_FIELDS = ["name", "modelAccessMode", "allowedModels", "blockedModels", "allowedCombos", "allowedConnections", "preferredConnections", "allowedQuotas", "noLog", "autoResolve", "isActive", "isBanned", "expiresAt", "throttleDelayMs", "maxSessions", "accessSchedule", "rateLimits", "scopes", "allowedEndpoints", "streamDefaultMode", "codexServiceMode", "cacheDefaultMode", "disableNonPublicModels", "allowUsageCommand", "usageLimitEnabled", "dailyUsageLimitUsd", "weeklyUsageLimitUsd", "chaosModeEnabled", "compressionEnabled", "allowAutoCombos", "allowCcDiscoveryAliases", "catalogScope", "forcedModel"] as const;

export function keyPolicyPreflightMatches(id: unknown, operationId: string, readId: unknown): boolean {
  return id === KEY_POLICY_PREFLIGHT && readId === "GET /api/keys"
    && ["POST /api/keys", "PATCH /api/keys/{id}", "DELETE /api/keys/{id}"].includes(operationId);
}
function policyJson(value: unknown, depth = 0): JsonValue {
  if (depth > 24) throw new TypeError("Key policy depth exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => policyJson(item, depth + 1));
  if (typeof value === "object" && value !== null) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, policyJson(item, depth + 1)]));
  throw new TypeError("Invalid key policy value");
}


export function keyPolicyPreflightSnapshot(response: unknown): JsonValue {
  const grants = keyGrantsPreflightSnapshot(response);
  if (typeof response !== "object" || response === null || !("keys" in response) || !Array.isArray(response.keys)) throw new TypeError("Invalid key policy inventory");
  const rows = new Map<string, Record<string, unknown>>();
  for (const row of response.keys) {
    if (typeof row !== "object" || row === null || Array.isArray(row) || !("id" in row) || typeof row.id !== "string") throw new TypeError("Invalid key policy row");
    rows.set(row.id, row as Record<string, unknown>);
  }
  if (typeof grants !== "object" || grants === null || Array.isArray(grants) || !Array.isArray(grants.entries)) throw new TypeError("Invalid key grants");
  return { kind: "collection", entries: grants.entries.map(entry => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry) || !("identity" in entry) || typeof entry.identity !== "object" || entry.identity === null || Array.isArray(entry.identity) || !("id" in entry.identity) || typeof entry.identity.id !== "string") throw new TypeError("Invalid key identity");
    const row = rows.get(entry.identity.id);
    if (!row) throw new TypeError("Missing key policy row");
    const state: Record<string, JsonValue> = {};
    for (const field of KEY_POLICY_FIELDS) {
      const value = row[field];
      state[field] = value === undefined ? null : policyJson(value);
    }
    return { identity: { id: entry.identity.id }, state };
  }) };
}
export type KeyRequestValidatorId = "omniroute-v3.8.53.keys.create" | "omniroute-v3.8.53.keys.update";
export function normalizeKeyRequest(id: KeyRequestValidatorId, value: JsonValue): JsonValue {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const body = { ...value };
  if (id === "omniroute-v3.8.53.keys.update" && typeof body.name === "string") body.name = body.name.trim();
  for (const field of ["allowedModels", "blockedModels", "allowedCombos", "scopes", "allowedEndpoints"]) {
    const items = body[field];
    if (Array.isArray(items)) body[field] = items.map(item => typeof item === "string" ? item.trim() : item);
  }
  if (typeof body.forcedModel === "string") body.forcedModel = body.forcedModel.trim();
  for (const field of ["dailyUsageLimitUsd", "weeklyUsageLimitUsd"]) {
    const amount = body[field];
    if (amount !== undefined && amount !== null) {
      const number = Number(amount);
      if (!Number.isFinite(number)) throw new TypeError("Invalid coerced key limit");
      body[field] = number;
    }
  }
  return body;
}
export function validateKeyRequest(id: KeyRequestValidatorId, value: unknown): { field: string; reason: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { field: "body", reason: "must be an object" };
  const body = value as Record<string, unknown>;
  const issue = (field: string, reason: string) => ({ field, reason });
  if (id === "omniroute-v3.8.53.keys.create" && (typeof body.name !== "string" || body.name.length < 1 || body.name.length > 200)) return issue("name", "must contain 1 to 200 characters");
  if (id === "omniroute-v3.8.53.keys.update" && Object.keys(body).length === 0) return issue("body", "No valid fields to update");
  if (body.modelAccessMode === "all" && Array.isArray(body.allowedModels) && body.allowedModels.length) return issue("allowedModels", "must be empty when modelAccessMode is all");
  if (body.connectionAccessMode === "restricted" && (!Array.isArray(body.allowedConnections) || body.allowedConnections.length === 0)) return issue("allowedConnections", "must not be empty for restricted mode");
  if (body.connectionAccessMode === "all" && Array.isArray(body.allowedConnections) && body.allowedConnections.length) return issue("allowedConnections", "must be empty for all mode");
  if (Array.isArray(body.scopes) && body.scopes.includes("lease:exclusive") && (id === "omniroute-v3.8.53.keys.create" || body.allowedConnections !== undefined) && (!Array.isArray(body.allowedConnections) || !body.allowedConnections.length)) return issue("allowedConnections", "lease:exclusive requires explicit connections");
  if (Array.isArray(body.allowedConnections) && body.allowedConnections.length && Array.isArray(body.preferredConnections) && body.preferredConnections.some(value => !body.allowedConnections || !Array.isArray(body.allowedConnections) || !body.allowedConnections.includes(value))) return issue("preferredConnections", "must be a subset of allowedConnections");
  return undefined;
}

export function keyGrantsPreflightMatches(id: unknown, operationId: string, readId: unknown): boolean {
  return id === KEY_GRANTS_PREFLIGHT && readId === "GET /api/keys"
    && (operationId === "DELETE /api/combos/{id}" || operationId === "POST /api/combos/import");
}

export function keyGrantsPreflightSnapshot(response: unknown): JsonValue {
  if (typeof response !== "object" || response === null || Array.isArray(response) || !("keys" in response) || !("total" in response)
    || !Array.isArray(response.keys) || typeof response.total !== "number" || !Number.isSafeInteger(response.total)
    || response.total < 0 || response.total > 10_000 || response.keys.length !== response.total) throw new TypeError("Incomplete key-grant inventory");
  const seen = new Set<string>();
  const entries = response.keys.map((row: unknown) => {
    if (typeof row !== "object" || row === null || Array.isArray(row) || !("id" in row) || !("allowedCombos" in row)
      || typeof row.id !== "string" || row.id.length === 0 || !Array.isArray(row.allowedCombos)
      || !row.allowedCombos.every((item: unknown) => typeof item === "string") || seen.has(row.id)) throw new TypeError("Invalid key-grant inventory");
    seen.add(row.id);
    return { identity: { id: row.id }, state: { allowedCombos: [...row.allowedCombos] as string[] } };
  });
  entries.sort((a, b) => a.identity.id.localeCompare(b.identity.id));
  return { kind: "collection", entries };
}
