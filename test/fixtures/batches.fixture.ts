import { Database } from "bun:sqlite";
import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import { ADMIN_ADAPTER_LIMITS } from "../../src/admin/adapters.ts";
import { requiredOmaScope } from "../../src/admin/authorization-policy.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import type { JsonSchema } from "../../src/admin/registry.ts";
import { createPinnedManagementAuthorization, loadExtractedPinnedDeclarations, loadPinnedModule, readPinnedSource, type PinnedExports } from "./pinned-handler.fixture.ts";

const deny = (): never => { throw new Error("Unexpected batch fixture boundary"); };
const leaf = (path: string): PinnedExports => loadPinnedModule(path, deny);
const next = { NextResponse: { json: Response.json.bind(Response) } };

// Client-side cap only: the upstream route itself accepts zero, negative and >100.
export const batchReadPolicy = {
  maximumListLimit: 100,
  maximumRawResponseBytes: ADMIN_ADAPTER_LIMITS.maxResponseBytes,
  listCompleteness: "unknown",
  initialization: "confirmation-required",
  settlement: "unknown",
  replay: false,
} as const;

/** Candidate only; independent evidence and admission remain gated. */
export function batchListContract(): OperationSourceContract {
  const route = "src/app/api/batches/route.ts";
  const template = operationContractTemplate("GET /api/batches") as unknown as OperationSourceContract;
  const empty: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
  const limit: JsonSchema = { type: "integer", minimum: 1, maximum: 100 };
  const count: JsonSchema = { type: "integer", minimum: 0, maximum: 4294967295 };
  const time: JsonSchema = { type: ["integer", "null"], minimum: 0, maximum: 4294967295 };
  const item: JsonSchema = { type: "object", properties: {
    id: { type: "string", pattern: "^batch_[a-zA-Z0-9_-]{1,128}$" }, status: { type: "string", enum: ["validating", "failed", "in_progress", "finalizing", "completed", "expired", "cancelling", "cancelled"] },
    requestCountsTotal: count, requestCountsCompleted: count, requestCountsFailed: count, createdAt: count,
    inProgressAt: time, expiresAt: time, finalizingAt: time, completedAt: time, failedAt: time, expiredAt: time, cancellingAt: time, cancelledAt: time,
  }, required: ["id", "status", "requestCountsTotal", "requestCountsCompleted", "requestCountsFailed", "createdAt", "inProgressAt", "expiresAt", "finalizingAt", "completedAt", "failedAt", "expiredAt", "cancellingAt", "cancelledAt"], additionalProperties: false };
  const view: JsonSchema = { type: "object", properties: { batches: { type: "array", maxItems: 100, items: item } }, required: ["batches"], additionalProperties: false };
  return { ...template,
    request: { ...template.request, pathSchema: empty, pathParameters: [], querySchema: { type: "object", properties: { limit }, additionalProperties: false }, body: null, parameters: [{ name: "limit", in: "query", required: false, style: "form", explode: true, allowReserved: false, schema: limit, inputAllowed: true, sourceFile: route }] },
    auth: { domain: "management", specificationAlternatives: template.auth.specificationAlternatives, sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false, handlerGuard: "none", handlerScope: "batch-list-resolve-scope", bootstrap: "none", alternatives: [{ kind: "management-api-key", anyOf: ["manage", "admin"] }, { kind: "dashboard-session" }, { kind: "auth-disabled", when: "central-and-handler-auth-not-required" }, { kind: "oma-access-token", minimumScope: requiredOmaScope("GET", "/api/batches") }, { kind: "trusted-local", loopbackOnly: true }] } },
    response: { ...template.response, mediaType: "application/json", schema: view, variants: template.response.variants.map(v => v.statusCode === "200" ? { ...v, content: [{ mediaType: "application/json", schema: view, sourceFile: route }] } : v) },
    secrets: { inputFields: [], outputFields: ["inputFileId", "outputFileId", "errorFileId", "apiKeyId", "metadata", "errors", "model", "usage"] }, sideEffect: "lifecycle", pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: true, reason: "Authentication and database initialization may write; the bounded list does not establish completeness or settlement, and raw responses remain subject to the adapter byte limit." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null,
    mutationSafety: { preflight: { kind: "not-applicable", sourceReason: "No independent read settles initialization effects." }, reconciliation: { kind: "unknown" }, settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null } },
  };
}
export function validateBatchListQuery(value: unknown): { limit?: number } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed batch query");
  const query = value as Record<string, unknown>;
  if (Object.keys(query).some(key => key !== "limit")) throw new Error("Unsupported batch query");
  if (query.limit === undefined) return {};
  if (typeof query.limit !== "number" || !Number.isInteger(query.limit) || query.limit < 1 || query.limit > batchReadPolicy.maximumListLimit) throw new Error("Invalid batch limit");
  return { limit: query.limit };
}

/** A bounded client view, not the raw upstream response or a completeness claim. */
export function projectBatch(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed batch");
  const row = value as Record<string, unknown>;
  const statuses = ["validating", "failed", "in_progress", "finalizing", "completed", "expired", "cancelling", "cancelled"];
  if (typeof row.id !== "string" || !/^batch_[a-zA-Z0-9_-]{1,128}$/.test(row.id) || typeof row.status !== "string" || !statuses.includes(row.status)) throw new Error("Malformed batch identity");
  const integer = (name: string, nullable: boolean): number | null => {
    const n = row[name];
    if (nullable && n === null) return null;
    if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0 || n > 4294967295) throw new Error(`Malformed ${name}`);
    return n;
  };
  return { id: row.id, status: row.status, requestCountsTotal: integer("requestCountsTotal", false), requestCountsCompleted: integer("requestCountsCompleted", false), requestCountsFailed: integer("requestCountsFailed", false), createdAt: integer("createdAt", false), inProgressAt: integer("inProgressAt", true), expiresAt: integer("expiresAt", true), finalizingAt: integer("finalizingAt", true), completedAt: integer("completedAt", true), failedAt: integer("failedAt", true), expiredAt: integer("expiredAt", true), cancellingAt: integer("cancellingAt", true), cancelledAt: integer("cancelledAt", true) };
}
export function projectBatchList(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed batch page");
  const batches = (value as Record<string, unknown>).batches;
  if (!Array.isArray(batches) || batches.length > 100) throw new Error("Malformed batch page");
  return { batches: batches.map(projectBatch) };
}
export function projectBatchItem(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Malformed batch response");
  return { batch: projectBatch((value as Record<string, unknown>).batch) };
}

/** Warm disposable SQLite; core initialization and real network ingress are not simulated. */
export class BatchFixture {
  readonly db = new Database(":memory:");
  readonly store: PinnedExports;
  readonly list: (request: Request) => Promise<Response>;
  readonly item: (request: Request, context: { params: { id: string } }) => Promise<Response>;
  readonly auth = createPinnedManagementAuthorization({
    isDashboardSession: token => token === "fixture-session",
    verifyAccessToken: () => null,
    validateApiKey: key => ["owner-a", "owner-b", "manager"].includes(key),
    getApiKeyMetadata: key => key === "owner-a" || key === "owner-b" ? { id: key, scopes: [] } : key === "manager" ? { id: key, scopes: ["manage"] } : null,
  });
  constructor() {
    this.db.exec(readPinnedSource("src/lib/db/migrations/028_create_files_and_batches.sql"));
    const mapping = leaf("src/lib/db/caseMapping.ts");
    this.store = loadPinnedModule("src/lib/db/batches.ts", s => {
      if (s === "./core") return { getDbInstance: () => this.db, ...mapping };
      if (s === "./files") return { deleteFile: deny, deleteFileOwnedBy: deny };
      if (s === "uuid") return { v4: deny };
      if (s === "../../../open-sse/utils/logger.ts") return { logger: () => ({}) };
      return deny();
    });
    const scopes = leaf("src/shared/constants/managementScopes.ts");
    const headers = leaf("src/sse/services/headerReader.ts");
    const goog = loadPinnedModule("src/sse/services/googApiKeyAuth.ts", s => s === "./headerReader.ts" ? headers : deny());
    const extractor = loadExtractedPinnedDeclarations(["src/sse/services/auth.ts"], ["readNonEmptyUrlToken", "extractApiKey"], s => s === "./headerReader.ts" ? headers : s === "./googApiKeyAuth.ts" ? goog : deny(), 'import { readHeaderValue } from "./headerReader.ts";\nimport { extractGoogApiKeyHeader } from "./googApiKeyAuth.ts";');
    const policy = loadPinnedModule("src/app/api/v1/_helpers/apiKeyScope.ts", s => {
      if (s === "next/server") return next;
      if (s === "@/lib/db/apiKeys") return { getApiKeyMetadata: (key: string) => key === "owner-a" || key === "owner-b" ? { id: key, scopes: [] } : key === "manager" ? { id: key, scopes: ["manage"] } : key === "revoked" ? { id: key, scopes: [] } : null, validateApiKey: (key: string) => key !== "revoked" };
      if (s === "@/sse/services/auth") return extractor;
      if (s === "@/shared/utils/apiAuth") return { isDashboardSessionAuthenticated: (request: Request) => request.headers.get("x-fixture-session") === "yes" };
      if (s === "@/shared/utils/cors") return { CORS_HEADERS: {}, credentialRejectionHeaders: () => ({}) };
      if (s === "@omniroute/open-sse/utils/error") return { buildErrorBody: (status: number, message: string) => ({ status, message }) };
      if (s === "@/shared/constants/anonymousOwner") return leaf("src/shared/constants/anonymousOwner.ts");
      if (s === "@/shared/constants/managementScopes") return scopes;
      return deny();
    });
    const parser = loadPinnedModule("src/lib/api/queryIntegerParam.ts", s => s === "next/server" ? next : deny());
    const resolver = (s: string) => {
      if (s === "next/server") return next;
      if (s === "@/lib/api/queryIntegerParam") return parser;
      if (s === "@/lib/db/batches") return this.store;
      if (s === "@/app/api/v1/_helpers/apiKeyScope") return policy;
      return deny();
    };
    this.list = loadPinnedModule("src/app/api/batches/route.ts", resolver).GET as typeof this.list;
    this.item = loadPinnedModule("src/app/api/batches/[id]/route.ts", resolver).GET as typeof this.item;
  }
  seed(id: string, owner: string | null, created: number): void {
    this.db.prepare("INSERT INTO batches (id, endpoint, completion_window, status, input_file_id, output_file_id, created_at, request_counts_total, request_counts_completed, request_counts_failed, metadata, errors, api_key_id) VALUES (?, '/v1/chat/completions', '24h', 'completed', ?, ?, ?, 3, 2, 1, ?, ?, ?)").run(id, "private-input-path", "private-output-path", created, '{"secret":"private-metadata"}', '[{"message":"private-error"}]', owner);
  }
  request(query = "", key?: string, session = false): Request {
    return new Request(`http://fixture.invalid/api/batches${query}`, { headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(session ? { "x-fixture-session": "yes" } : {}) } });
  }
  async dispatch(request: Request, id?: string): Promise<Response> {
    return this.auth.dispatch(request, { centralAuthRequired: true, handlerAuthRequired: true }, forwarded => id === undefined ? this.list(forwarded) : this.item(forwarded, { params: { id } }));
  }
  close(): void { this.db.close(); }
}
