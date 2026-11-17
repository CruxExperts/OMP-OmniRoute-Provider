import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import { requiredOmaScope } from "../../src/admin/authorization-policy.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import { createPinnedManagementAuthorization, loadPinnedModule, readPinnedSource } from "./pinned-handler.fixture.ts";

const route = "src/app/api/auth/csrf/route.ts";
const routeSha256 = "05ed2a77a15c322bdde3614a80b6057a788f99fcd221d90e2eb7a638561491a5";
export const AUTH_CSRF_ID = "GET /api/auth/csrf";
const empty: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
const view: JsonSchema = { type: "object", properties: { issued: { type: "boolean" } }, required: ["issued"], additionalProperties: false };

/** Candidate with no token disclosure; external effects and independent evidence remain gated. */
export function authCsrfContract(): OperationSourceContract {
  const template = operationContractTemplate(AUTH_CSRF_ID) as unknown as OperationSourceContract;
  return { ...template,
    request: { ...template.request, pathSchema: empty, pathParameters: [], querySchema: empty, parameters: [], body: null },
    auth: { domain: "management", specificationAlternatives: template.auth.specificationAlternatives, sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false, handlerGuard: "requireManagementAuth", bootstrap: "none", alternatives: [
      { kind: "management-api-key", anyOf: ["manage", "admin"] }, { kind: "dashboard-session" },
      { kind: "auth-disabled", when: "central-and-handler-auth-not-required" },
      { kind: "oma-access-token", minimumScope: requiredOmaScope("GET", "/api/auth/csrf") }, { kind: "trusted-local", loopbackOnly: true },
    ] } },
    response: { ...template.response, mediaType: "application/json", schema: view, variants: template.response.variants.map(v => v.statusCode === "200" ? { ...v, content: [{ mediaType: "application/json", schema: view, sourceFile: route }] } : v) },
    secrets: { inputFields: [], outputFields: ["token", "expiresAt"] }, sideEffect: "lifecycle",
    pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: true, reason: "Management authentication can initialize storage; token issuance does not settle those effects." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null,
    mutationSafety: { preflight: { kind: "not-applicable", sourceReason: "No independent read settles authentication initialization effects." }, reconciliation: { kind: "unknown" }, settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null } },
  };
}

export function authCsrfDescriptor(): OperationDescriptor {
  const original = getOperation(AUTH_CSRF_ID);
  if (!original || original.source.sha256 !== routeSha256 || original.source.gitBlobSha !== "a18026b4474ea4b7259d6ae0accfbc32429fef61" || !original.databaseInitializationRequired) throw new Error("Unexpected CSRF source or lifecycle binding");
  const contract = authCsrfContract();
  return { ...original, ...contract, mediaType: { request: null, response: "application/json" }, coverage: { status: "invokable", adapterId: "typed.fixture.auth-csrf", reason: null } };
}

/** Source-bound characterization only; neither native lifecycle nor HTTP evidence. */
export class AuthCsrfFixture {
  calls = 0;
  readonly guard = createPinnedManagementAuthorization({
    isDashboardSession: token => token === "fixture-session",
    verifyAccessToken: token => token === "oma_fixture-read" ? { id: "read", name: "read", scope: "read" } : token === "oma_fixture-write" ? { id: "write", name: "write", scope: "write" } : token === "oma_fixture-admin" ? { id: "admin", name: "admin", scope: "admin" } : null,
    validateApiKey: key => ["fixture-manage", "fixture-admin", "fixture-auth-error"].includes(key),
    getApiKeyMetadata: key => {
      if (key === "fixture-auth-error") throw new Error("fixture-private-auth-error");
      return { id: "fixture", scopes: [key === "fixture-admin" ? "admin" : "manage"] };
    },
  });
  readonly issue: (request: Request, now?: number) => { token: string; expiresAt: string } | null;
  private readonly get: (request: Request) => Promise<Response>;

  constructor() {
    if (createHash("sha256").update(readPinnedSource(route)).digest("hex") !== routeSha256) throw new Error("Unexpected CSRF route identity");
    const constants = loadPinnedModule("src/shared/constants/dashboardCsrf.ts", specifier => { throw new Error(`Unexpected CSRF constant dependency: ${specifier}`); });
    const issuer = loadPinnedModule("src/server/authz/csrf.ts", specifier => {
      if (specifier === "node:crypto") return { createHash, createHmac, timingSafeEqual };
      if (specifier === "@/shared/constants/dashboardCsrf") return constants;
      throw new Error(`Unexpected CSRF issuer dependency: ${specifier}`);
    });
    this.issue = issuer.issueDashboardCsrfToken as typeof this.issue;
    const handler = loadPinnedModule(route, specifier => {
      if (specifier === "next/server") return { NextResponse: { json: Response.json.bind(Response) } };
      if (specifier === "@/lib/api/requireManagementAuth") return { requireManagementAuth: this.guard.requireManagementAuth };
      if (specifier === "@/server/authz/csrf") return issuer;
      throw new Error(`Unexpected CSRF route dependency: ${specifier}`);
    });
    this.get = handler.GET as typeof this.get;
  }

  async handle(credential?: string, authRequired = true): Promise<Response> {
    const headers: Record<string, string> = {};
    if (credential === "session") headers.cookie = "auth_token=fixture-session";
    else if (credential) headers.authorization = `Bearer ${credential}`;
    const request = new Request("http://fixture.invalid/api/auth/csrf", { headers });
    return this.guard.dispatch(request, { centralAuthRequired: authRequired, handlerAuthRequired: authRequired }, forwarded => { this.calls++; return this.get(forwarded); });
  }
}
