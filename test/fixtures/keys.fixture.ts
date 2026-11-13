import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import type { JsonSchema, OperationDescriptor } from "../../src/admin/registry.ts";
import { KEY_POLICY_PREFLIGHT } from "../../src/admin/source-keys.ts";

// This projection is intentionally narrower than the source's management response.
// In particular it never returns key material, key hashes, prefixes, or metadata.
export const KEY_OPERATION_IDS = [
  "GET /api/keys",
  "POST /api/keys",
  "GET /api/keys/{id}",
  "PATCH /api/keys/{id}",
  "DELETE /api/keys/{id}",
] as const;

export interface KeyGrant { readonly id: string; readonly allowedCombos: readonly string[] }

export function projectKeyGrant(value: unknown): KeyGrant {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid key grant");
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id || !Array.isArray(row.allowedCombos) || !row.allowedCombos.every(item => typeof item === "string")) {
    throw new Error("Invalid key grant fields");
  }
  return { id: row.id, allowedCombos: [...row.allowedCombos] };
}

export function projectKeyGrantPage(value: unknown): { readonly keys: readonly KeyGrant[]; readonly total: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Invalid key collection");
  const collection = value as Record<string, unknown>;
  if (!Array.isArray(collection.keys) || typeof collection.total !== "number" || !Number.isSafeInteger(collection.total) || collection.total < 0) throw new Error("Invalid key collection fields");
  return { keys: collection.keys.map(projectKeyGrant), total: collection.total };
}

export function projectCompleteKeyGrants(value: unknown): { readonly keys: readonly KeyGrant[]; readonly total: number } {
  const { keys, total } = projectKeyGrantPage(value);
  if (keys.length !== total || new Set(keys.map(row => row.id)).size !== keys.length) throw new Error("Incomplete key grant collection");
  return { keys, total };
}

type KeyContract = Pick<OperationDescriptor, "request" | "auth" | "response" | "secrets" | "sideEffect" | "pagination" | "streaming" | "confirmation" | "retry" | "reconciliation" | "mutationSafety">;
const stringList: JsonSchema = { type: "array", items: { type: "string" } };
const nullableString: JsonSchema = { type: ["string", "null"] };
const nullableNumber: JsonSchema = { type: ["number", "null"] };
const bool: JsonSchema = { type: "boolean" };
const policyFields: Record<string, JsonSchema> = {
  name: { type: "string" }, modelAccessMode: { type: "string" }, allowedModels: stringList, blockedModels: stringList,
  allowedConnections: stringList, preferredConnections: stringList, allowedQuotas: stringList, noLog: bool, autoResolve: bool,
  isActive: bool, isBanned: bool, expiresAt: nullableString, throttleDelayMs: nullableNumber, maxSessions: nullableNumber,
  accessSchedule: { anyOf: [{ type: "null" }, { type: "object", properties: { enabled: bool, from: { type: "string" }, until: { type: "string" }, days: { type: "array", items: { type: "integer" } }, tz: { type: "string" } }, required: ["enabled", "from", "until", "days", "tz"], additionalProperties: false }] },
  rateLimits: { anyOf: [{ type: "null" }, { type: "array", items: { type: "object", properties: { limit: { type: "number" }, window: { type: "number" } }, required: ["limit", "window"], additionalProperties: false } }] },
  scopes: stringList, allowedEndpoints: stringList, streamDefaultMode: { type: "string" }, codexServiceMode: { type: "string" },
  cacheDefaultMode: { type: "string" }, disableNonPublicModels: bool, allowUsageCommand: bool, usageLimitEnabled: bool,
  dailyUsageLimitUsd: nullableNumber, weeklyUsageLimitUsd: nullableNumber, chaosModeEnabled: bool, compressionEnabled: bool,
  allowAutoCombos: bool, allowCcDiscoveryAliases: bool, catalogScope: { type: "string" }, forcedModel: nullableString,
};
const grantSchema: JsonSchema = { type: "object", properties: { id: { type: "string", minLength: 1 }, allowedCombos: stringList, ...policyFields }, required: ["id", "allowedCombos"], additionalProperties: false };
const requestStringList = (maxItems: number, maxLength?: number): JsonSchema => ({ type: "array", maxItems, items: { type: "string", minLength: 1, ...(maxLength === undefined ? {} : { maxLength }) } });
const connections: JsonSchema = { type: "array", maxItems: 100, items: { type: "string", format: "uuid" } };
const requestSchedule: JsonSchema = { anyOf: [{ type: "null" }, { type: "object", properties: { enabled: bool, from: { type: "string", pattern: "^\\d{2}:\\d{2}$" }, until: { type: "string", pattern: "^\\d{2}:\\d{2}$" }, days: { type: "array", minItems: 1, maxItems: 7, items: { type: "integer", minimum: 0, maximum: 6 } }, tz: { type: "string", minLength: 1, maxLength: 100 } }, required: ["enabled", "from", "until", "days", "tz"], additionalProperties: false }] };
const requestRateLimits: JsonSchema = { anyOf: [{ type: "null" }, { type: "array", maxItems: 50, items: { type: "object", properties: { limit: { type: "integer", exclusiveMinimum: 0 }, window: { type: "integer", exclusiveMinimum: 0 } }, required: ["limit", "window"], additionalProperties: false } }] };
const createSchema: JsonSchema = { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 200 }, allowedCombos: requestStringList(500, 200), allowedModels: requestStringList(1000), scopes: requestStringList(32, 64), modelAccessMode: { enum: ["all", "restricted"] }, allowedConnections: { ...connections, minItems: 1 }, preferredConnections: connections, noLog: bool, allowUsageCommand: bool, usageLimitEnabled: bool, dailyUsageLimitUsd: { ...nullableNumber, minimum: 0 }, weeklyUsageLimitUsd: { ...nullableNumber, minimum: 0 }, chaosModeEnabled: bool, expiresAt: { type: ["string", "null"], format: "date-time" } }, required: ["name"], additionalProperties: false };
const patchSchema: JsonSchema = { type: "object", properties: { name: { type: "string", minLength: 1, maxLength: 200 }, modelAccessMode: { enum: ["all", "restricted"] }, connectionAccessMode: { enum: ["all", "restricted"] }, allowedModels: requestStringList(1000), blockedModels: requestStringList(1000), allowedCombos: requestStringList(500, 200), allowedConnections: connections, preferredConnections: connections, noLog: bool, autoResolve: bool, isActive: bool, throttleDelayMs: { type: "integer", minimum: 0, maximum: 300000 }, isBanned: bool, expiresAt: { type: ["string", "null"], format: "date-time" }, maxSessions: { type: "integer", minimum: 0, maximum: 10000 }, accessSchedule: requestSchedule, rateLimits: requestRateLimits, scopes: requestStringList(32, 64), allowedEndpoints: requestStringList(20, 64), streamDefaultMode: { enum: ["legacy", "json"] }, compressionEnabled: bool, codexServiceMode: { enum: ["inherit", "default", "priority", "flex"] }, allowAutoCombos: bool, allowCcDiscoveryAliases: bool, catalogScope: { enum: ["all", "combos", "models"] }, forcedModel: { type: ["string", "null"], maxLength: 300 }, cacheDefaultMode: { enum: ["legacy", "bypass"] }, disableNonPublicModels: bool, allowUsageCommand: bool, usageLimitEnabled: bool, dailyUsageLimitUsd: { ...nullableNumber, minimum: 0 }, weeklyUsageLimitUsd: { ...nullableNumber, minimum: 0 }, chaosModeEnabled: bool }, minProperties: 1, additionalProperties: false };
const secretPolicyFields = Object.keys(policyFields);

function keyContract(operationId: typeof KEY_OPERATION_IDS[number]): KeyContract {
  const base = operationContractTemplate(operationId) as unknown as KeyContract;
  const read = operationId.startsWith("GET ");
  const list = operationId === "GET /api/keys";
  const create = operationId === "POST /api/keys";
  const patch = operationId === "PATCH /api/keys/{id}";
  const bodySchema = create ? createSchema : patch ? patchSchema : undefined;
  const success: JsonSchema = list ? { type: "object", properties: { keys: { type: "array", items: grantSchema }, total: { type: "integer", minimum: 0 } }, required: ["keys", "total"], additionalProperties: false }
    : read || create ? grantSchema : { type: "object", properties: { message: { type: "string" } }, required: ["message"], additionalProperties: false };
  const targetRead = { operationId: "GET /api/keys", inputs: [], snapshot: { kind: "collection" as const, collectionPath: ["keys"], identity: [{ name: "id", path: ["id"] }], state: [{ name: "allowedCombos", path: ["allowedCombos"] }] }, sourceView: KEY_POLICY_PREFLIGHT };
  return {
    ...base,
    request: bodySchema ? { ...base.request, sourceValidator: create ? "omniroute-v3.8.53.keys.create" : "omniroute-v3.8.53.keys.update", sourceNormalizer: create ? "omniroute-v3.8.53.keys.create" : "omniroute-v3.8.53.keys.update", body: { required: true, mediaType: "application/json", schema: bodySchema, contentVariants: [{ mediaType: "application/json", schema: bodySchema }] } } : list ? { ...base.request, querySchema: { type: "object", properties: { limit: { type: ["string", "integer"] }, offset: { type: ["string", "integer"] } }, additionalProperties: false }, parameters: ["limit", "offset"].map(name => ({ name, in: "query" as const, required: false, style: "form", explode: true, allowReserved: false, schema: { type: ["string", "integer"] }, inputAllowed: true, sourceFile: "src/app/api/keys/route.ts" })) } : base.request,
    auth: { domain: "management", specificationAlternatives: base.auth.specificationAlternatives, sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false, handlerGuard: "requireManagementAuth", bootstrap: "none", alternatives: [{ kind: "management-api-key", anyOf: ["manage", "admin"] }, { kind: "dashboard-session" }, { kind: "oma-access-token", minimumScope: read ? "read" : "admin" }, { kind: "auth-disabled", when: "central-and-handler-auth-not-required" }, { kind: "trusted-local", loopbackOnly: true }] } },
    response: { ...base.response, schema: success, variants: base.response.variants.map(variant => ({
      ...variant, content: variant.content.map(content => ({ ...content, schema: variant.statusCode.startsWith("2") ? success : { type: "object" } })),
    })) },
    secrets: { inputFields: [], outputFields: secretPolicyFields }, sideEffect: read ? "read" : operationId.startsWith("DELETE") ? "destructive" : "mutation",
    pagination: list ? { mode: "offset", parameters: ["limit", "offset"] } : { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: !read, reason: read ? "Management key grants read without secret output." : "Key policy mutation requires human confirmation; uncertain responses are never replayed." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null,
    mutationSafety: read ? null : { preflight: { kind: "required", observations: [{ name: "key-policy-inventory", read: targetRead, readCompleteness: { kind: "unpaginated-list", sourceReason: "The handler returns the complete collection when limit and offset are omitted.", itemsPath: ["keys"], totalPath: ["total"], identityPaths: [["id"]] } }], visibilityLimits: ["Reads are not atomic with external writers.", "Cloud synchronization state is not exposed by this read.", ...(operationId.startsWith("DELETE") ? ["Deletion also removes budget and cost history; those operator-only exported records are not visible to management API keys."] : [])] }, reconciliation: { kind: "unknown" }, settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null } },
  };
}

export const KEY_SOURCE_CONTRACTS = Object.fromEntries(KEY_OPERATION_IDS.map(id => [id, keyContract(id)])) as Record<typeof KEY_OPERATION_IDS[number], KeyContract>;
