import { Database } from "bun:sqlite";
import { operationContractTemplate, operationEvidenceBinding } from "../../scripts/generate-contracts.ts";
import { requiredOmaScope } from "../../src/admin/authorization-policy.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import { createPinnedManagementAuthorization as makeAuth, loadPinnedModule } from "./pinned-handler.fixture.ts";

export const CC_DISCOVERY_METRICS_ID = "GET /api/settings/cc-discovery-metrics";
const metrics: JsonSchema = {
  type: "object", properties: {
    aliasRequests: { type: "number" }, discoveryHits: { type: "number" },
    byModel: { type: "object", additionalProperties: { type: "number" } },
  }, required: ["aliasRequests", "discoveryHits", "byModel"], additionalProperties: false,
};
const routeError: JsonSchema = { type: "object", properties: { error: { type: "object", properties: { message: { type: "string" }, type: { type: "string" }, code: { type: "string" } }, required: ["message"], additionalProperties: true } }, required: ["error"], additionalProperties: true };
const authError: JsonSchema = { type: "object", properties: { error: { type: "object", properties: { message: { type: "string" }, type: { type: "string" } }, required: ["message", "type"], additionalProperties: true }, requestId: { type: "string", format: "uuid" } }, required: ["error", "requestId"], additionalProperties: true };
const centralError: JsonSchema = { type: "object", properties: { error: { type: "object", properties: { code: { type: "string", minLength: 1 }, message: { type: "string" }, correlation_id: { type: "string", format: "uuid" } }, required: ["code", "message", "correlation_id"], additionalProperties: false } }, required: ["error"], additionalProperties: false };

export function ccDiscoveryMetricsContract(): OperationSourceContract {
  const template = operationContractTemplate(CC_DISCOVERY_METRICS_ID) as unknown as OperationSourceContract;
  return {
    ...template,
    auth: { domain: "management", specificationAlternatives: template.auth.specificationAlternatives, sourcePolicy: {
      status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false,
      handlerGuard: "requireManagementAuth", bootstrap: "none", alternatives: [
        { kind: "management-api-key", anyOf: ["manage", "admin"] }, { kind: "dashboard-session" },
        { kind: "auth-disabled", when: "central-and-handler-auth-not-required" },
        { kind: "oma-access-token", minimumScope: requiredOmaScope("GET", "/api/settings/cc-discovery-metrics") },
        { kind: "trusted-local", loopbackOnly: true },
      ],
    } },
    response: { ...template.response, mediaType: "application/json", schema: { anyOf: [metrics, routeError, authError, centralError] },
      variants: template.response.variants.map(variant => ({ ...variant, content: variant.content.map(content => ({ ...content, schema: variant.statusCode === "200" ? metrics : variant.statusCode === "500" ? routeError : { oneOf: [authError, centralError] } })) })) },
    secrets: { inputFields: [], outputFields: [] }, sideEffect: "read",
    pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: false, reason: "The handler reads aggregate counters without modifying them." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null, mutationSafety: null,
  };
}

export function ccDiscoveryMetricsDescriptor(): OperationDescriptor {
  const original = getOperation(CC_DISCOVERY_METRICS_ID);
  if (!original) throw new Error(`Missing pinned operation ${CC_DISCOVERY_METRICS_ID}`);
  const contract = ccDiscoveryMetricsContract();
  const binding = operationEvidenceBinding(CC_DISCOVERY_METRICS_ID, contract);
  if (binding.handlerSha256 !== original.source.sha256 || binding.handlerGitBlobSha !== original.source.gitBlobSha) throw new Error("Discovery metrics source contract does not match pinned handler");
  // Synthetic fixture authority does not confer release eligibility.
  return { ...original, ...contract, sideEffect: "read", confirmation: { required: false, reason: "Already-open disposable fixture only." }, mediaType: { request: null, response: "application/json" }, coverage: { status: "invokable", adapterId: "typed.fixture.cc-discovery-metrics.get", reason: null } };
}

/** Receipt-verified route and counter module against an already-open disposable DB, not real ingress or cold startup. */
export class CcDiscoveryMetricsFixture {
  readonly db = new Database(":memory:");
  readonly #authorization = makeAuth({
    isDashboardSession: token => token === "fixture-session",
    verifyAccessToken: token => token === "oma_fixture-read" ? { id: "read", name: "read", scope: "read" } : null,
    validateApiKey: key => key === "fixture-manage" || key === "fixture-unscoped",
    getApiKeyMetadata: key => key === "fixture-manage" ? { id: "manage", scopes: ["manage"] } : key === "fixture-unscoped" ? { id: "unscoped", scopes: [] } : null,
  });
  readonly #route: (request: Request) => Promise<Response>;
  readonly #alias: (model: string) => void;
  readonly #hit: () => void;
  failOpen = false;
  constructor() {
    this.db.exec("CREATE TABLE key_value (namespace TEXT NOT NULL, key TEXT NOT NULL, value TEXT, PRIMARY KEY(namespace, key))");
    const store = loadPinnedModule("src/lib/db/ccDiscoveryMetrics.ts", specifier => {
      if (specifier === "./core") return { getDbInstance: () => { if (this.failOpen) throw new Error("fixture-private-database-error"); return this.db; } };
      throw new Error(`Unexpected discovery metrics store import: ${specifier}`);
    });
    this.#alias = store.incrementCcAliasRequestCount as (model: string) => void;
    this.#hit = store.incrementCcDiscoveryHitCount as () => void;
    const route = loadPinnedModule("src/app/api/settings/cc-discovery-metrics/route.ts", specifier => {
      if (specifier === "next/server") return { NextResponse: { json: Response.json.bind(Response) } };
      if (specifier === "@/lib/db/ccDiscoveryMetrics") return store;
      if (specifier === "@/lib/api/requireManagementAuth") return { requireManagementAuth: this.#authorization.requireManagementAuth };
      if (specifier === "@omniroute/open-sse/utils/error") return { buildErrorBody: () => { throw new Error("Unexpected route error path; store is designed not to throw"); } };
      throw new Error(`Unexpected discovery metrics route import: ${specifier}`);
    });
    if (typeof route.GET !== "function" || "DELETE" in route) throw new Error("Unexpected discovery metrics handler exports");
    this.#route = route.GET as (request: Request) => Promise<Response>;
  }
  alias(model: string): void { this.#alias(model); }
  hit(): void { this.#hit(); }
  close(): void { this.db.close(); }
  async handle(credential?: string): Promise<Response> {
    const headers = credential ? { authorization: `Bearer ${credential}` } : {};
    const request = new Request("http://fixture.invalid/api/settings/cc-discovery-metrics", { headers });
    return this.#authorization.dispatch(request, { centralAuthRequired: true, handlerAuthRequired: true }, forwarded => this.#route(forwarded));
  }
}
