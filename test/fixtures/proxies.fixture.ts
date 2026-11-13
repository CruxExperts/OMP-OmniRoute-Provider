import { requiredOmaScope } from "../../src/admin/authorization-policy.ts";
import { getOperation, type JsonSchema, type OperationDescriptor, type OperationMutationSafety } from "../../src/admin/registry.ts";
import { PROXY_USAGE_PREFLIGHT } from "../../src/admin/source-proxies.ts";
import { fixtureRegistry } from "./admin-qualification.fixture.ts";

export const PROXY_OPERATION_IDS = [
  "DELETE /api/settings/proxies",
  "GET /api/settings/proxies",
  "GET /api/settings/proxies/assignments",
  "PATCH /api/settings/proxies",
  "POST /api/settings/proxies",
  "PUT /api/settings/proxies/assignments",
] as const;

// Only the assignment read may emit independent source observations; mutations
// and the proxy collection remain held until their prerequisites are complete.
export const HELD_SOURCE_ONLY_OPERATION_IDS = new Set<string>(PROXY_OPERATION_IDS.filter(id => id !== "GET /api/settings/proxies/assignments"));

// Safety views for the shared executor must not use the public projections as
// complete write targets: GET masks stored username/password and a PUT replaces
// the entire pool while resetting its rotation cursor. The shared integration
// must preserve unknown outcomes rather than equating this view with full state.
export const PROXY_MUTATION_PREFLIGHT_LIMITS = [
  "Proxy GET masks credentials; secret changes are not fully observable.",
  "Assignment GET omits the rotation strategy and cursor; PUT can reset or clear rotation state.",
  "Delete force removes assignments but intentionally retains unresolved account references.",
] as const;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected object");
  return value as Record<string, unknown>;
}

export function projectAssignment(value: unknown) {
  const row = record(value);
  if (typeof row.scope !== "string" || !(typeof row.scopeId === "string" || row.scopeId === null) || typeof row.proxyId !== "string") throw new Error("Invalid assignment");
  return { scope: row.scope, scopeId: row.scopeId, proxyId: row.proxyId };
}

export function projectAssignments(value: unknown) {
  const body = record(value);
  if (!Array.isArray(body.items) || !Number.isSafeInteger(body.total) || body.total !== body.items.length) throw new Error("Incomplete assignment list");
  return { items: body.items.map(projectAssignment), total: body.total as number };
}

export function projectAssignmentProof(value: unknown) {
  const body = record(value);
  if (!Array.isArray(body.items) || !Number.isSafeInteger(body.total) || body.total !== body.items.length) throw new Error("Incomplete assignment list");
  return {
    items: body.items.map(value => {
      const row = record(value);
      if (typeof row.id !== "number" || !Number.isSafeInteger(row.id) || row.id < 1) throw new Error("Invalid assignment identity");
      return { id: row.id, ...projectAssignment(value) };
    }),
    total: body.total as number,
  };
}

// Host, port, credentials, notes, relay details and source-provided errors never cross this boundary.
export function projectProxy(value: unknown) {
  const row = record(value);
  if (typeof row.id !== "string" || typeof row.name !== "string" || typeof row.type !== "string" || typeof row.status !== "string") throw new Error("Invalid proxy");
  return { id: row.id, name: row.name, type: row.type, status: row.status };
}

export function projectProxyProof(value: unknown) {
  const row = record(value);
  const safe = projectProxy(row);
  if (typeof row.host !== "string" || typeof row.port !== "number" || !Number.isInteger(row.port) || typeof row.family !== "string" || typeof row.updatedAt !== "string" || typeof row.source !== "string" || !(typeof row.region === "string" || row.region === null) || !(typeof row.subscriptionId === "string" || row.subscriptionId === null)) throw new Error("Invalid proxy target state");
  return { ...safe, host: row.host, port: row.port, family: row.family, updatedAt: row.updatedAt, source: row.source, region: row.region, subscriptionId: row.subscriptionId };
}

export function projectProxyListProof(value: unknown) {
  const body = record(value);
  if (!Array.isArray(body.items) || !Number.isSafeInteger(body.total) || body.total !== body.items.length) throw new Error("Incomplete proxy list");
  return { items: body.items.map(projectProxyProof), total: body.total as number };
}

export function projectProxyList(value: unknown) {
  const body = record(value);
  if (!Array.isArray(body.items) || !Number.isSafeInteger(body.total) || body.total !== body.items.length) throw new Error("Incomplete proxy list");
  return { items: body.items.map(projectProxy), total: body.total as number };
}

export function projectProxyUsage(value: unknown) {
  const body = record(value);
  if (!Number.isSafeInteger(body.count) || !Number.isSafeInteger(body.assignmentCount) || !Number.isSafeInteger(body.accountReferenceCount) || !Array.isArray(body.assignments) || !Array.isArray(body.accountReferences)) throw new Error("Invalid proxy usage");
  const accountReferences = body.accountReferences.map(entry => {
    const row = record(entry);
    if (typeof row.connectionId !== "string" || typeof row.provider !== "string" || !Number.isSafeInteger(row.accountCount)) throw new Error("Invalid proxy account reference");
    return { connectionId: row.connectionId, provider: row.provider, accountCount: row.accountCount };
  });
  return { count: body.count, assignmentCount: body.assignmentCount, accountReferenceCount: body.accountReferenceCount, assignments: body.assignments.map(projectAssignment), accountReferences };
}

const EMPTY_SCHEMA: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
const STR: JsonSchema = { type: "string" };
const ID: JsonSchema = { type: "string", minLength: 1 };
const NUM: JsonSchema = { type: "integer" };
const ASSIGNMENT_ROW: JsonSchema = { type: "object", required: ["id", "scope", "scopeId", "proxyId"], properties: { id: NUM, scope: STR, scopeId: { type: ["string", "null"] }, proxyId: ID }, additionalProperties: false };
const PUBLIC_ASSIGNMENT: JsonSchema = { type: "object", required: ["scope", "scopeId", "proxyId"], properties: { scope: STR, scopeId: { type: ["string", "null"] }, proxyId: ID }, additionalProperties: false };
const PROXY_ROW: JsonSchema = { type: "object", required: ["id", "name", "type", "status"], properties: { id: ID, name: STR, type: STR, status: STR, host: STR, port: NUM, family: STR, updatedAt: STR, source: STR, region: { type: ["string", "null"] }, subscriptionId: { type: ["string", "null"] } }, additionalProperties: false };
const LIST: JsonSchema = { type: "object", required: ["items", "total"], properties: { items: { type: "array", items: PROXY_ROW }, total: NUM }, additionalProperties: false };
const ASSIGNMENTS: JsonSchema = { type: "object", required: ["items", "total"], properties: { items: { type: "array", items: ASSIGNMENT_ROW }, total: NUM }, additionalProperties: false };
const USAGE: JsonSchema = { type: "object", required: ["count", "assignmentCount", "accountReferenceCount", "assignments", "accountReferences"], properties: {
  count: NUM, assignmentCount: NUM, accountReferenceCount: NUM, assignments: { type: "array", items: PUBLIC_ASSIGNMENT },
  accountReferences: { type: "array", items: { type: "object", required: ["connectionId", "provider", "accountCount"], properties: { connectionId: ID, provider: ID, accountCount: NUM }, additionalProperties: false } },
}, additionalProperties: false };
const ASSIGN_RESULT: JsonSchema = { type: "object", required: ["success", "assignment"], properties: { success: { type: "boolean" }, assignment: { anyOf: [PUBLIC_ASSIGNMENT, { type: "null" }] } }, additionalProperties: false };
const SUCCESS: JsonSchema = { type: "object", required: ["success"], properties: { success: { type: "boolean" } }, additionalProperties: false };
const REQUEST_FIELDS: Readonly<Record<string, JsonSchema>> = { name: STR, type: STR, host: STR, port: { type: ["number", "string"] }, username: STR, password: STR, region: { type: ["string", "null"] }, notes: { type: ["string", "null"] }, status: STR, source: STR, family: STR, id: STR, subscriptionId: { type: ["string", "null"] }, assignment: { type: "object", properties: { scope: STR, scopeId: { type: ["string", "null"] } }, additionalProperties: false } };
const ASSIGN_BODY: JsonSchema = { type: "object", required: ["scope"], properties: { scope: STR, scopeId: { type: ["string", "null"] }, proxyId: { type: ["string", "null"] } }, additionalProperties: false };
const QUERY_KEYS = ["id", "whereUsed", "force", "proxyId", "scope", "scopeId"] as const;
const queryParameters = QUERY_KEYS.map(name => ({ name, in: "query" as const, required: false, style: "form", explode: true, allowReserved: false, schema: STR, inputAllowed: true }));
const LIST_PROOF = { kind: "unpaginated-list" as const, sourceReason: "The pinned route returns all rows from its SQLite list without pagination.", itemsPath: ["items"], totalPath: ["total"], identityPaths: [["id"]] };
const USAGE_READ = { operationId: "GET /api/settings/proxies", sourceView: PROXY_USAGE_PREFLIGHT, inputs: [], snapshot: { kind: "resource" as const, identity: [], state: [] } };

/** Synthetic adapter authority only: these contracts are not release evidence. */
export function buildProxyFixtureRegistry() {
  const descriptors: OperationDescriptor[] = PROXY_OPERATION_IDS.map(operationId => {
    const source = getOperation(operationId);
    if (!source) throw new Error(`Missing proxy operation ${operationId}`);
    const read = source.method === "GET";
    const assignment = operationId.endsWith("/assignments");
    const mutation = !read;
    const queryNames = assignment ? ["proxyId", "scope", "scopeId"] : source.method === "GET" ? ["id", "whereUsed"] : source.method === "DELETE" ? ["id", "force"] : [];
    const bodySchema: JsonSchema | null = source.method === "PUT" ? ASSIGN_BODY : source.method === "POST" || source.method === "PATCH" ? { type: "object", required: source.method === "POST" ? ["name", "host", "port"] : ["id"], properties: Object.fromEntries(Object.entries(REQUEST_FIELDS).filter(([key]) => source.method === "PATCH" || !["id", "subscriptionId"].includes(key))), additionalProperties: false } : null;
    const responseSchema: JsonSchema = read ? assignment ? ASSIGNMENTS : { anyOf: [LIST, PROXY_ROW, USAGE] } : source.method === "DELETE" ? SUCCESS : assignment ? ASSIGN_RESULT : PROXY_ROW;
    const observations: Extract<OperationMutationSafety["preflight"], { kind: "required" }>["observations"] = [
      { name: "registry", read: { operationId: "GET /api/settings/proxies", inputs: [], snapshot: { kind: "collection", collectionPath: ["items"], identity: [{ name: "id", path: ["id"] }], state: ["name", "type", "status", "host", "port", "family", "updatedAt", "source", "region", "subscriptionId"].map(name => ({ name, path: [name] })) } }, readCompleteness: LIST_PROOF },
      ...(assignment || source.method === "POST" || source.method === "PATCH" ? [{ name: "assignments", read: { operationId: "GET /api/settings/proxies/assignments", inputs: [], snapshot: { kind: "collection" as const, collectionPath: ["items"], identity: [{ name: "id", path: ["id"] }], state: [{ name: "scope", path: ["scope"] }, { name: "scopeId", path: ["scopeId"] }, { name: "proxyId", path: ["proxyId"] }] } }, readCompleteness: LIST_PROOF }] : []),
      ...(source.method === "DELETE" ? [{ name: "proxy-usage", read: USAGE_READ, readCompleteness: { kind: "single-response" as const, sourceReason: "The pinned whereUsed lookup returns all assignments and account references in one response." } }] : []),
    ];
    const status = source.method === "POST" ? "201" : "200";
    return { ...source,
      request: { ...source.request, pathSchema: EMPTY_SCHEMA, querySchema: { type: "object", ...(source.method === "DELETE" ? { required: ["id"] } : {}), properties: Object.fromEntries(queryNames.map(key => [key, STR])), additionalProperties: false }, parameters: queryParameters.filter(item => queryNames.includes(item.name)).map(item => ({ ...item, sourceFile: source.source.file })), body: bodySchema ? { required: true, mediaType: "application/json", schema: bodySchema, contentVariants: [{ mediaType: "application/json", schema: bodySchema }] } : null, ...(source.method === "POST" ? { sourceValidator: "omniroute-v3.8.53.proxies.create" as const } : source.method === "PATCH" ? { sourceValidator: "omniroute-v3.8.53.proxies.update" as const } : source.method === "PUT" ? { sourceValidator: "omniroute-v3.8.53.proxies.assign" as const } : {}) },
      auth: { domain: "management", specificationAlternatives: source.auth.specificationAlternatives, sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false, handlerGuard: "requireManagementAuth", bootstrap: "none", alternatives: [{ kind: "auth-disabled", when: "central-and-handler-auth-not-required" }, { kind: "management-api-key", anyOf: ["manage", "admin"] }, { kind: "dashboard-session" }, { kind: "oma-access-token", minimumScope: requiredOmaScope(source.method, source.pathTemplate) }, { kind: "trusted-local", loopbackOnly: true }] } },
      response: operationId === "GET /api/settings/proxies/assignments"
        ? { ...source.response, schema: responseSchema, variants: source.response.variants.map(variant => variant.statusCode === "200" ? { ...variant, content: variant.content.map(content => ({ ...content, schema: responseSchema })) } : variant) }
        : { statusCodes: [status], mediaType: "application/json", schema: responseSchema, variants: [{ statusCode: status, headers: {}, content: [{ mediaType: "application/json", schema: responseSchema }] }] },
      mediaType: { request: bodySchema ? "application/json" : null, response: "application/json" },
      secrets: { inputFields: read ? [] : ["username", "password", "host", "notes"], outputFields: ["host", "port", "username", "password", "notes"] },
      sideEffect: read ? "read" : "mutation", pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
      confirmation: { required: mutation, reason: mutation ? "Proxy mutations alter routing state." : assignment ? "Reads assignments; the source returns an indistinguishable empty list when the assignment table is missing, so this response alone cannot establish absence for a destructive preflight." : "Read proxy state." }, retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null,
      mutationSafety: read ? null : { preflight: { kind: "required", observations, visibilityLimits: [...PROXY_MUTATION_PREFLIGHT_LIMITS] }, reconciliation: { kind: "unknown" }, settlement: { responseComplete: { statusCodes: [Number(status)] }, definiteRejection: null } },
      coverage: { status: "invokable", adapterId: `fixture.proxy.${source.method.toLowerCase()}.${assignment ? "assignments" : "collection"}`, reason: null },
    };
  });
  return fixtureRegistry(descriptors);
}
