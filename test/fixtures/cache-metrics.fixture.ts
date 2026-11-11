import { Database } from "bun:sqlite";
import { assertCacheMetricsSourceBinding, operationContractTemplate, operationEvidenceBinding } from "../../scripts/generate-contracts.ts";
import { requiredOmaScope } from "../../src/admin/authorization-policy.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import { createPinnedManagementAuthorization as makeAuth, loadPinnedModule } from "./pinned-handler.fixture.ts";

export const CACHE_METRICS_IDS = ["GET /api/settings/cache-metrics", "DELETE /api/settings/cache-metrics"] as const;
export type CacheMetricsId = (typeof CACHE_METRICS_IDS)[number];
const number: JsonSchema = { type: "number" };
const counts = { requests: number, inputTokens: number, cachedTokens: number, cacheCreationTokens: number };
const provider: JsonSchema = { type: "object", properties: { ...counts, totalRequests: number, cachedRequests: number }, required: ["requests", "totalRequests", "cachedRequests", "inputTokens", "cachedTokens", "cacheCreationTokens"], additionalProperties: false };
const strategy: JsonSchema = { type: "object", properties: counts, required: Object.keys(counts), additionalProperties: false };
const metrics: JsonSchema = {
  type: "object",
  properties: {
    totalRequests: number, requestsWithCacheControl: number, totalInputTokens: number, totalCachedTokens: number,
    totalCacheCreationTokens: number, tokensSaved: number, estimatedCostSaved: number,
    byProvider: { type: "object", additionalProperties: provider },
    byStrategy: { type: "object", additionalProperties: strategy }, lastUpdated: { type: "string" },
  },
  required: ["totalRequests", "requestsWithCacheControl", "totalInputTokens", "totalCachedTokens", "totalCacheCreationTokens", "tokensSaved", "estimatedCostSaved", "byProvider", "byStrategy", "lastUpdated"],
  additionalProperties: false,
};
const routeError: JsonSchema = { type: "object", properties: { error: { type: "string" } }, required: ["error"], additionalProperties: false };
const authError: JsonSchema = { type: "object", properties: { error: { type: "object", properties: { message: { type: "string" }, type: { type: "string", enum: ["invalid_request", "server_error"] } }, required: ["message", "type"], additionalProperties: true }, requestId: { type: "string", format: "uuid" } }, required: ["error", "requestId"], additionalProperties: true };
const centralError: JsonSchema = { type: "object", properties: { error: { type: "object", properties: { code: { type: "string", minLength: 1 }, message: { type: "string" }, correlation_id: { type: "string", format: "uuid" } }, required: ["code", "message", "correlation_id"], additionalProperties: false } }, required: ["error"], additionalProperties: false };
const combined: JsonSchema = { oneOf: [metrics, routeError, authError, centralError] };

export function cacheMetricsContract(id: CacheMetricsId): OperationSourceContract {
  assertCacheMetricsSourceBinding(id);
  const template = operationContractTemplate(id) as unknown as OperationSourceContract;
  return {
    ...template,
    auth: { domain: "management", specificationAlternatives: template.auth.specificationAlternatives, sourcePolicy: {
      status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false,
      handlerGuard: "requireManagementAuth", bootstrap: "none", alternatives: [
        { kind: "management-api-key", anyOf: ["manage", "admin"] }, { kind: "dashboard-session" },
        { kind: "auth-disabled", when: "central-and-handler-auth-not-required" },
        { kind: "oma-access-token", minimumScope: requiredOmaScope(id.slice(0, id.indexOf(" ")), "/api/settings/cache-metrics") },
        { kind: "trusted-local", loopbackOnly: true },
      ],
    } },
    response: { ...template.response, mediaType: "application/json", schema: combined,
      variants: template.response.variants.map(variant => ({ ...variant, content: variant.content.map(content => ({ ...content, schema: variant.statusCode === "200" ? metrics : variant.statusCode === "500" ? routeError : { oneOf: [authError, centralError] } })) })) },
    secrets: { inputFields: [], outputFields: [] }, sideEffect: "unknown",
    pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: true, reason: "The warm fixture observes reads only; cold database initialization can have additional effects and remains unqualified." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null, mutationSafety: null,
  };
}

export function cacheMetricsDescriptor(id: CacheMetricsId): OperationDescriptor {
  const original = getOperation(id);
  if (!original) throw new Error(`Missing pinned operation ${id}`);
  const contract = cacheMetricsContract(id);
  const binding = operationEvidenceBinding(id, contract);
  if (binding.handlerSha256 !== original.source.sha256 || binding.handlerGitBlobSha !== original.source.gitBlobSha) {
    throw new Error(`cache metrics source contract does not match the pinned handler: ${id}`);
  }
  // Synthetic registry authority applies only to this already-open fixture, never release eligibility.
  return { ...original, ...contract, sideEffect: "read", confirmation: { required: false, reason: "Already-open disposable fixture only." }, mediaType: { request: null, response: "application/json" }, coverage: { status: "invokable", adapterId: `typed.fixture.cache-metrics.${id.startsWith("GET") ? "get" : "delete"}`, reason: null } };
}

/** Receipt-verified handler and SQL against an already-open disposable SQLite database; excludes cold initialization, Next ingress and durable storage. */
export class CacheMetricsFixture {
  readonly db = new Database(":memory:");
  readonly #authorization = makeAuth({
    isDashboardSession: () => false, verifyAccessToken: () => null,
    validateApiKey: key => key === "fixture-manage", getApiKeyMetadata: key => key === "fixture-manage" ? { id: "fixture", scopes: ["manage"] } : null,
  });
  readonly #handlers: Record<"GET" | "DELETE", (request: Request) => Promise<Response>>;
  failOpen = false;
  constructor() {
    this.db.exec("CREATE TABLE usage_history (provider TEXT, combo_strategy TEXT, tokens_input INTEGER, tokens_cache_read INTEGER, tokens_cache_creation INTEGER)");
    const backend = loadPinnedModule("src/lib/db/settings/cacheMetrics.ts", specifier => {
      if (specifier === "../core") return { getDbInstance: () => { if (this.failOpen) throw new Error("fixture-private-backend-error"); return this.db; } };
      throw new Error(`Unexpected cache metrics backend import: ${specifier}`);
    });
    const route = loadPinnedModule("src/app/api/settings/cache-metrics/route.ts", specifier => {
      if (specifier === "next/server") return { NextResponse: { json: Response.json.bind(Response) } };
      if (specifier === "@/lib/db/settings") return backend;
      if (specifier === "@/lib/api/requireManagementAuth") return { requireManagementAuth: this.#authorization.requireManagementAuth };
      throw new Error(`Unexpected cache metrics route import: ${specifier}`);
    });
    this.#handlers = { GET: route.GET as (request: Request) => Promise<Response>, DELETE: route.DELETE as (request: Request) => Promise<Response> };
  }
  close(): void { this.db.close(); }
  async handle(method: "GET" | "DELETE", key?: string): Promise<Response> {
    const request = new Request("http://fixture.invalid/api/settings/cache-metrics", { method, headers: key ? { authorization: `Bearer ${key}` } : {} });
    return this.#authorization.dispatch(request, { centralAuthRequired: true, handlerAuthRequired: true }, forwarded => this.#handlers[method](forwarded));
  }
}
