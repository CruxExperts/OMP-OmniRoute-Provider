import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { operationContractTemplate, operationEvidenceBinding } from "../../scripts/generate-contracts.ts";
import { requiredOmaScope } from "../../src/admin/authorization-policy.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import { createPinnedFixtureDate, createPinnedManagementAuthorization, loadPinnedModule, readPinnedSource } from "./pinned-handler.fixture.ts";

export const COMPRESSION_ID = "GET /api/analytics/compression";
const route = "src/app/api/analytics/compression/route.ts";
const owner = "src/lib/db/compressionAnalytics.ts";
const empty: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
const number: JsonSchema = { type: "number" };
const hour: JsonSchema = { type: "object", properties: { hour: { type: "string" }, count: number, tokensSaved: number }, required: ["hour", "count", "tokensSaved"], additionalProperties: false };
const usageFields = ["requestsWithReceipts", "promptTokens", "completionTokens", "totalTokens", "cacheReadTokens", "cacheWriteTokens", "estimatedUsdSaved"];
const usage: JsonSchema = { type: "object", properties: Object.fromEntries(usageFields.map(key => [key, number])), required: usageFields, additionalProperties: false };
const mcp: JsonSchema = { type: "object", properties: { snapshots: number, estimatedTokensSaved: number }, required: ["snapshots", "estimatedTokensSaved"], additionalProperties: false };
const fields = { totalRequests: number, totalTokensSaved: number, avgSavingsPct: number, avgDurationMs: number, last24h: { type: "array", minItems: 24, maxItems: 24, items: hour }, totalSkipped: number, validationFallbacks: number, realUsage: usage, mcpDescriptionCompression: mcp } satisfies Record<string, JsonSchema>;
const view: JsonSchema = { type: "object", properties: fields, required: Object.keys(fields), additionalProperties: false };
const since: JsonSchema = { type: "string", enum: ["24h", "7d", "30d", "all"] };

/** Source normalizes unknown periods to 24h; this client intentionally rejects them. */
export function compressionContract(): OperationSourceContract {
  const template = operationContractTemplate(COMPRESSION_ID) as unknown as OperationSourceContract;
  return { ...template,
    request: { ...template.request, pathSchema: empty, pathParameters: [], querySchema: { type: "object", properties: { since }, additionalProperties: false }, parameters: [{ name: "since", in: "query", required: false, style: "form", explode: true, allowReserved: false, schema: since, inputAllowed: true, sourceFile: route }], body: null },
    auth: { domain: "management", specificationAlternatives: template.auth.specificationAlternatives, sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false, handlerGuard: "requireManagementAuth", bootstrap: "none", alternatives: [
      { kind: "management-api-key", anyOf: ["manage", "admin"] }, { kind: "dashboard-session" }, { kind: "auth-disabled", when: "central-and-handler-auth-not-required" }, { kind: "oma-access-token", minimumScope: requiredOmaScope("GET", "/api/analytics/compression") }, { kind: "trusted-local", loopbackOnly: true },
    ] } },
    response: { ...template.response, mediaType: "application/json", schema: view, variants: template.response.variants.map(v => v.statusCode === "200" ? { ...v, content: [{ mediaType: "application/json", schema: view, sourceFile: route }] } : v) },
    secrets: { inputFields: [], outputFields: ["byProvider", "byCompressionCombo", "bySkipReason", "bySource", "byMode", "byEngine", "request_id", "combo_id", "error"] }, sideEffect: "lifecycle",
    pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: true, reason: "Database initialization and lazy schema changes have uncertain settlement." }, retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null,
    mutationSafety: { preflight: { kind: "not-applicable", sourceReason: "No independent read settles initialization effects." }, reconciliation: { kind: "unknown" }, settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null } },
  };
}
export function compressionDescriptor(): OperationDescriptor {
  const original = getOperation(COMPRESSION_ID);
  if (!original || original.source.sha256 !== "4159741eb6a3a6f0529bf290d0ec2287c56ff604af7ffb7a1689f36353c40fd5" || original.source.gitBlobSha !== "7006cac6eba75683d773afe1b1a1967607063e0f") throw new Error("Unexpected compression route identity");
  if (createHash("sha256").update(readPinnedSource(owner)).digest("hex") !== "2989f4d16a331bd20624748a8624dba0065e0e70dee96e6cf3227449e9b28f66") throw new Error("Unexpected compression SQL owner identity");
  const contract = compressionContract();
  const binding = operationEvidenceBinding(COMPRESSION_ID, contract);
  if (binding.handlerSha256 !== original.source.sha256 || binding.handlerGitBlobSha !== original.source.gitBlobSha) throw new Error("Compression binding mismatch");
  return { ...original, ...contract, mediaType: { request: null, response: "application/json" }, coverage: { status: "invokable", adapterId: "typed.fixture.compression-analytics", reason: null } };
}

/** Actual pinned route, management guard and SQL, on disposable already-open SQLite. */
export class CompressionAnalyticsFixture {
  readonly db = new Database(":memory:");
  calls = 0;
  failDb = false;
  readonly guard = createPinnedManagementAuthorization({
    isDashboardSession: token => token === "fixture-session",
    verifyAccessToken: token => token === "oma_fixture-read" ? { id: "read", name: "read", scope: "read" } : null,
    validateApiKey: key => ["fixture-manage", "fixture-admin", "fixture-unscoped", "fixture-auth-error"].includes(key),
    getApiKeyMetadata: key => { if (key === "fixture-auth-error") throw new Error("fixture-private-auth-error"); return { id: "fixture", scopes: key === "fixture-manage" ? ["manage"] : key === "fixture-admin" ? ["admin"] : [] }; },
  });
  readonly handler: (request: Request) => Promise<Response>;
  constructor() {
    this.db.exec(readPinnedSource("src/lib/db/migrations/038_compression_analytics.sql"));
    const sql = loadPinnedModule(owner, s => {
      if (s === "./core") return { getDbInstance: () => { this.calls++; if (this.failDb) throw new Error("fixture-private-database-error"); return this.db; } };
      throw new Error(`Unexpected compression SQL import: ${s}`);
    }, { date: createPinnedFixtureDate("2026-11-16T12:30:00.000Z") });
    const module = loadPinnedModule(route, s => {
      if (s === "next/server") return { NextResponse: { json: Response.json.bind(Response) } };
      if (s === "@/lib/db/compressionAnalytics") return sql;
      if (s === "@/lib/api/requireManagementAuth") return { requireManagementAuth: this.guard.requireManagementAuth };
      throw new Error(`Unexpected compression route import: ${s}`);
    });
    this.handler = module.GET as (request: Request) => Promise<Response>;
  }
  close(): void { this.db.close(); }
  async handle(credential?: string, query = "", centralAuthRequired = true, handlerAuthRequired = true): Promise<Response> {
    this.calls = 0;
    const headers: Record<string, string> = {};
    if (credential === "session") headers.cookie = "auth_token=fixture-session";
    else if (credential) headers.authorization = `Bearer ${credential}`;
    const request = new Request(`http://fixture.invalid/api/analytics/compression${query}`, { headers });
    return this.guard.dispatch(request, { centralAuthRequired, handlerAuthRequired }, forwarded => this.handler(forwarded));
  }
}
