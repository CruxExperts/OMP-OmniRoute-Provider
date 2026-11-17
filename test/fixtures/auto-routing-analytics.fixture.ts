import { Database } from "bun:sqlite";
import { operationContractTemplate, operationEvidenceBinding } from "../../scripts/generate-contracts.ts";
import { requiredOmaScope } from "../../src/admin/authorization-policy.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import { createPinnedManagementAuthorization, loadPinnedModule } from "./pinned-handler.fixture.ts";

export const ANALYTICS_ID = "GET /api/analytics/auto-routing";
const route = "src/app/api/analytics/auto-routing/route.ts";
const empty: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
const count: JsonSchema = { type: "integer", minimum: 0 };
const view: JsonSchema = { type: "object", properties: {
  totalRequests: count, variantBreakdown: { type: "object", additionalProperties: count },
  topProviders: { type: "array", maxItems: 10, items: { type: "object", properties: { provider: { type: "string" }, count }, required: ["provider", "count"], additionalProperties: false } },
}, required: ["totalRequests", "variantBreakdown", "topProviders"], additionalProperties: false };

/** Candidate only: warm disposable observations do not establish release eligibility. */
export function analyticsContract(): OperationSourceContract {
  const template = operationContractTemplate(ANALYTICS_ID) as unknown as OperationSourceContract;
  return { ...template,
    request: { ...template.request, pathSchema: empty, pathParameters: [], querySchema: empty, parameters: [], body: null },
    auth: { domain: "management", specificationAlternatives: template.auth.specificationAlternatives, sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false, handlerGuard: "requireManagementAuth", bootstrap: "none", alternatives: [
      { kind: "management-api-key", anyOf: ["manage", "admin"] }, { kind: "dashboard-session" },
      { kind: "auth-disabled", when: "central-and-handler-auth-not-required" },
      { kind: "oma-access-token", minimumScope: requiredOmaScope("GET", "/api/analytics/auto-routing") }, { kind: "trusted-local", loopbackOnly: true },
    ] } },
    response: { ...template.response, mediaType: "application/json", schema: view, variants: template.response.variants.map(v => v.statusCode === "200" ? { ...v, content: [{ mediaType: "application/json", schema: view, sourceFile: route }] } : v) },
    secrets: { inputFields: [], outputFields: ["error_summary", "api_key_id", "connection_id", "request_body", "response_body"] }, sideEffect: "lifecycle",
    pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: true, reason: "First database access can initialize or recover storage; the response does not settle those effects." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null,
    mutationSafety: { preflight: { kind: "not-applicable", sourceReason: "No independent read settles initialization effects." }, reconciliation: { kind: "unknown" }, settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null } },
  };
}
export function analyticsDescriptor(): OperationDescriptor {
  const original = getOperation(ANALYTICS_ID);
  if (!original || original.source.sha256 !== "a29213937ad3210c5edb4a3bf07c4c3bd55d52dca45ff1a76a185e06527ecbf1" || original.source.gitBlobSha !== "27fd7e8350f76a3e1a1429b69344c21ce350d9b5") throw new Error("Unexpected analytics source identity");
  const contract = analyticsContract();
  const binding = operationEvidenceBinding(ANALYTICS_ID, contract);
  if (binding.handlerSha256 !== original.source.sha256 || binding.handlerGitBlobSha !== original.source.gitBlobSha) throw new Error("Analytics binding mismatch");
  return { ...original, ...contract, mediaType: { request: null, response: "application/json" }, coverage: { status: "invokable", adapterId: "typed.fixture.auto-routing-analytics", reason: null } };
}

/** Actual pinned route and SQL on an already-open database; excludes ingress and cold DB initialization. */
export class AutoRoutingAnalyticsFixture {
  readonly db = new Database(":memory:");
  failAt = 0;
  calls = 0;
  failAuth = false;
  readonly guard = createPinnedManagementAuthorization({
    isDashboardSession: token => token === "fixture-session",
    verifyAccessToken: token => { if (token === "oma_fixture-error") throw new Error("fixture-private-auth-error"); return token === "oma_fixture-read" ? { id: "read", name: "read", scope: "read" } : null; },
    validateApiKey: key => ["fixture-manage", "fixture-admin", "fixture-unscoped", "fixture-auth-error"].includes(key),
    getApiKeyMetadata: key => { if (this.failAuth || key === "fixture-auth-error") throw new Error("fixture-private-auth-error"); return { id: "fixture", scopes: key === "fixture-manage" ? ["manage"] : key === "fixture-admin" ? ["admin"] : [] }; },
  });
  readonly handler: (request: Request) => Promise<Response>;
  constructor() {
    this.db.exec("CREATE TABLE call_logs (requested_model TEXT, request_type TEXT, provider TEXT, error_summary TEXT, api_key_id TEXT, request_body TEXT)");
    const logical = loadPinnedModule("src/lib/db/logicalCallSql.ts", s => { throw new Error(`Unexpected logical SQL import: ${s}`); });
    const usage = loadPinnedModule("src/lib/db/usageLogs.ts", s => {
      if (s === "./logicalCallSql") return logical;
      if (s === "./core") return { getDbInstance: () => { this.calls++; if (this.calls === this.failAt) throw new Error("fixture-private-database-error"); return this.db; } };
      throw new Error(`Unexpected usage import: ${s}`);
    });
    const module = loadPinnedModule(route, s => {
      if (s === "next/server") return { NextResponse: { json: Response.json.bind(Response) } };
      if (s === "@/lib/db/usageLogs") return usage;
      if (s === "@/lib/api/requireManagementAuth") return { requireManagementAuth: this.guard.requireManagementAuth };
      throw new Error(`Unexpected analytics route import: ${s}`);
    });
    this.handler = module.GET as (request: Request) => Promise<Response>;
  }
  close(): void { this.db.close(); }
  async handle(credential?: string, centralAuthRequired = true, handlerAuthRequired = true, query = ""): Promise<Response> {
    this.calls = 0;
    const headers: Record<string, string> = {};
    if (credential === "session") headers.cookie = "auth_token=fixture-session";
    else if (credential) headers.authorization = `Bearer ${credential}`;
    const request = new Request(`http://fixture.invalid/api/analytics/auto-routing${query}`, { headers });
    return this.guard.dispatch(request, { centralAuthRequired, handlerAuthRequired }, forwarded => this.handler(forwarded));
  }
}
