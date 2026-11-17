import { createHash } from "node:crypto";
import { operationContractTemplate, operationEvidenceBinding } from "../../scripts/generate-contracts.ts";
import { requiredOmaScope } from "../../src/admin/authorization-policy.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import { createPinnedManagementAuthorization, loadPinnedModule, readPinnedSource } from "./pinned-handler.fixture.ts";

const route = "src/app/api/analytics/diversity/route.ts";

export const DIVERSITY_ID = "GET /api/analytics/diversity";
const empty: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
const view: JsonSchema = { type: "object", properties: {
  score: { type: "number", minimum: 0, maximum: 1 },
  totalRequests: { type: "integer", minimum: 0 },
  windowSize: { type: "integer", minimum: 0 }, ttlMs: { type: "integer", minimum: 0 },
}, required: ["score", "totalRequests", "windowSize", "ttlMs"], additionalProperties: false };

/** Candidate only; independent HTTP and cold lifecycle evidence are still required. */
export function diversityContract(): OperationSourceContract {
  const template = operationContractTemplate(DIVERSITY_ID) as unknown as OperationSourceContract;
  return { ...template,
    request: { ...template.request, pathSchema: empty, pathParameters: [], querySchema: empty, parameters: [], body: null },
    auth: { domain: "management", specificationAlternatives: template.auth.specificationAlternatives, sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false, handlerGuard: "none", bootstrap: "none", alternatives: [
      { kind: "management-api-key", anyOf: ["manage", "admin"] }, { kind: "dashboard-session" },
      { kind: "auth-disabled", when: "central-and-handler-auth-not-required" },
      { kind: "oma-access-token", minimumScope: requiredOmaScope("GET", "/api/analytics/diversity") }, { kind: "trusted-local", loopbackOnly: true },
    ] } },
    response: { ...template.response, mediaType: "application/json", schema: view, variants: template.response.variants.map(v => v.statusCode === "200" ? { ...v, content: [{ mediaType: "application/json", schema: view, sourceFile: route }] } : v) },
    secrets: { inputFields: [], outputFields: ["providers", "error", "model", "connection", "request"] }, sideEffect: "lifecycle",
    pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: true, reason: "Central management authorization can initialize storage; the response does not settle those effects." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null,
    mutationSafety: { preflight: { kind: "not-applicable", sourceReason: "No independent read settles authorization initialization effects." }, reconciliation: { kind: "unknown" }, settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null } },
  };
}

export function diversityDescriptor(): OperationDescriptor {
  const original = getOperation(DIVERSITY_ID);
  if (!original || original.source.sha256 !== identities[route] || original.source.gitBlobSha !== "15005c7d702621c7eacd93b4b079099a4e1dca65" || !original.databaseInitializationRequired) throw new Error("Unexpected diversity source or lifecycle binding");
  const contract = diversityContract();
  const binding = operationEvidenceBinding(DIVERSITY_ID, contract);
  if (binding.handlerSha256 !== original.source.sha256 || !binding.databaseInitializationRequired) throw new Error("Diversity binding mismatch");
  return { ...original, ...contract, mediaType: { request: null, response: "application/json" }, coverage: { status: "invokable", adapterId: "typed.fixture.diversity-analytics", reason: null } };
}
const diversity = "open-sse/services/autoCombo/providerDiversity.ts";
const metrics = "open-sse/services/comboMetrics.ts";
const identities: Readonly<Record<string, string>> = {
  [route]: "5309a9f0b87006e3c613aa494c0364cf93f9c81d5c14bdde23865a858d1ba934",
  [diversity]: "cd9ea0e52b1c86c382129d64ee1c309d3b2723dce3b5037388bfb5d4f642ea9b",
  [metrics]: "9646c1c8138c2ce8ca8440d251cc9e7753ee7ab793fc033b91607fdb922c5b41",
};

interface Report {
  score: number;
  totalRequests: number;
  providers: Record<string, { count: number; share: number }>;
  windowSize: number;
  ttlMs: number;
}
interface Diversity {
  configureDiversity(config: { windowSize?: number; ttlMs?: number }): void;
  recordProviderUsage(provider: string): void;
  getDiversityReport(): Report;
  resetDiversity(): void;
}
interface Metrics {
  recordComboRequest(name: string, model: string | null, options: { success: boolean; latencyMs: number; target?: { provider?: string; connectionId?: string } }): void;
}

/** Executes the pinned producer, in-memory owner and route, not the cold runtime. */
export class DiversityAnalyticsFixture {
  now = Date.parse("2026-01-01T00:00:00Z");
  calls = 0;
  failure: Error | undefined;
  readonly owner: Diversity;
  readonly metrics: Metrics;
  readonly handler: () => Promise<Response>;
  readonly guard = createPinnedManagementAuthorization({
    isDashboardSession: token => token === "fixture-session",
    verifyAccessToken: token => token === "oma_fixture-read" ? { id: "read", name: "read", scope: "read" } : null,
    validateApiKey: key => ["fixture-manage", "fixture-admin", "fixture-unscoped", "fixture-auth-error"].includes(key),
    getApiKeyMetadata: key => {
      if (key === "fixture-auth-error") throw new Error("fixture-private-auth-error");
      return { id: "fixture", scopes: key === "fixture-manage" ? ["manage"] : key === "fixture-admin" ? ["admin"] : [] };
    },
  });
  constructor() {
    for (const [path, digest] of Object.entries(identities)) {
      if (createHash("sha256").update(readPinnedSource(path)).digest("hex") !== digest) throw new Error(`Unexpected diversity source identity: ${path}`);
    }
    const fixture = this;
    const clock = new Proxy(Date, {
      construct(target, args, newTarget) { return Reflect.construct(target, args.length ? args : [fixture.now], newTarget); },
      get(target, property, receiver) { return property === "now" ? () => fixture.now : Reflect.get(target, property, receiver); },
    }) as DateConstructor;
    const noImports = (specifier: string): never => { throw new Error(`Unexpected diversity dependency: ${specifier}`); };
    const owner = loadPinnedModule(diversity, noImports, { date: clock });
    this.owner = owner as unknown as Diversity;
    this.metrics = loadPinnedModule(metrics, specifier => {
      if (specifier === "./autoCombo/providerDiversity") return owner;
      return noImports(specifier);
    }, { date: clock }) as unknown as Metrics;
    const paths = loadPinnedModule("open-sse/utils/errorPathRedaction.ts", noImports);
    const patterns = loadPinnedModule("open-sse/utils/credentialPatterns.ts", noImports);
    const flags = loadPinnedModule("open-sse/utils/registeredFeatureFlag.ts", noImports);
    const safety = loadPinnedModule("open-sse/utils/providerSafety.ts", specifier => specifier === "./registeredFeatureFlag.ts" ? flags : noImports(specifier));
    const sanitizer = loadPinnedModule("open-sse/utils/errorSanitization.ts", specifier => {
      if (specifier === "./errorPathRedaction.ts") return paths;
      if (specifier === "./credentialPatterns.ts") return patterns;
      if (specifier === "./providerSafety.ts") return safety;
      return noImports(specifier);
    });
    const module = loadPinnedModule(route, specifier => {
      if (specifier === "next/server") return { NextResponse: { json: Response.json.bind(Response) } };
      if (specifier === "../../../../../open-sse/services/autoCombo/providerDiversity") return { getDiversityReport: () => { this.calls++; if (this.failure) throw this.failure; return this.owner.getDiversityReport(); } };
      if (specifier === "@omniroute/open-sse/utils/error") return sanitizer;
      return noImports(specifier);
    });
    this.handler = module.GET as () => Promise<Response>;
  }
  async handle(credential?: string, centralAuthRequired = true, query = ""): Promise<Response> {
    this.calls = 0;
    const headers: Record<string, string> = {};
    if (credential === "session") headers.cookie = "auth_token=fixture-session";
    else if (credential) headers.authorization = `Bearer ${credential}`;
    const request = new Request(`http://fixture.invalid/api/analytics/diversity${query}`, { headers });
    return this.guard.dispatch(request, { centralAuthRequired, handlerAuthRequired: false }, () => this.handler());
  }
}
