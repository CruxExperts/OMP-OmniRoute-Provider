import { assertConcurrencySourceBinding, operationContractTemplate } from "../../scripts/generate-contracts.ts";
import { requiredOmaScope } from "../../src/admin/authorization-policy.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import { createPinnedManagementAuthorization, loadPinnedModule, type PinnedExports } from "./pinned-handler.fixture.ts";

export const CONCURRENCY_ID = "GET /api/admin/concurrency";
const route = "src/app/api/admin/concurrency/route.ts";
const empty: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
// All three maps are keyed by private provider/account/model identities. Do not
// expose their keys, timestamps, or nested metrics, even in private target views.
const projection: JsonSchema = { type: "object", properties: {
  rateLimits: { ...empty, maxProperties: 10000 },
  comboQueues: { ...empty, maxProperties: 10000 },
  semaphores: { ...empty, maxProperties: 10000 },
}, required: ["rateLimits", "comboQueues", "semaphores"], additionalProperties: false };

export function concurrencyContract(): OperationSourceContract {
  assertConcurrencySourceBinding();
  const template = operationContractTemplate(CONCURRENCY_ID) as unknown as OperationSourceContract;
  return { ...template,
    request: { ...template.request, pathSchema: empty, pathParameters: [], querySchema: empty, body: null, parameters: [] },
    auth: { domain: "management", specificationAlternatives: template.auth.specificationAlternatives, sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false, handlerGuard: "requireManagementAuth", bootstrap: "none", alternatives: [{ kind: "management-api-key", anyOf: ["manage", "admin"] }, { kind: "dashboard-session" }, { kind: "auth-disabled", when: "central-and-handler-auth-not-required" }, { kind: "oma-access-token", minimumScope: requiredOmaScope("GET", "/api/admin/concurrency") }, { kind: "trusted-local", loopbackOnly: true }] } },
    secrets: { inputFields: [], outputFields: ["timestamp"] },
    response: { ...template.response, mediaType: "application/json", schema: projection, variants: template.response.variants.map(v => v.statusCode === "200" ? { ...v, content: [{ mediaType: "application/json", schema: projection, sourceFile: route }] } : v) },
    // Authentication and source module loading can initialize persistent state;
    // a response does not establish settlement of those effects.
    sideEffect: "lifecycle", pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: true, reason: "Management authentication can initialize the local database; the response does not settle initialization effects." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null,
    mutationSafety: { preflight: { kind: "not-applicable", sourceReason: "No independent read settles initialization." }, reconciliation: { kind: "unknown" }, settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null } },
  };
}
export function concurrencyDescriptor(): OperationDescriptor {
  const original = getOperation(CONCURRENCY_ID);
  if (!original || original.source.sha256 !== "d153dfc298841d3971c7ffab84f043386e4afd0902ccd64df874640c22f94a15" || original.source.gitBlobSha !== "7fd03e4742e0daecc8bb74f88abba0cd61cee9c9") throw new Error("Unexpected concurrency handler identity");
  return { ...original, ...concurrencyContract(), databaseInitializationRequired: true, mediaType: { request: null, response: "application/json" }, coverage: { status: "invokable", adapterId: "typed.fixture.concurrency", reason: null } };
}

/** Independent source-owned gate seeding; no provider or network dispatch. */
export class ConcurrencyFixture {
  readonly combo: PinnedExports;
  readonly account: PinnedExports;
  readonly manager: PinnedExports;
  private readonly handler: (request: Request) => Promise<Response>;
  private readonly auth = createPinnedManagementAuthorization({
    isDashboardSession: () => false,
    verifyAccessToken: token => token === "oma_fixture-read" ? { id: "read", name: "read", scope: "read" } : token === "oma_fixture-admin" ? { id: "admin", name: "admin", scope: "admin" } : null,
    validateApiKey: key => key === "fixture-manage" || key === "fixture-low",
    getApiKeyMetadata: key => key === "fixture-manage" ? { id: key, scopes: ["manage"] } : key === "fixture-low" ? { id: "low", scopes: [] } : null,
  });
  constructor(failSnapshot = false) {
    const deny = () => { throw new Error("Unapproved concurrency fixture boundary"); };
    const leaf = (path: string) => loadPinnedModule(path, deny);
    this.combo = leaf("open-sse/services/rateLimitSemaphore.ts");
    this.account = leaf("open-sse/services/accountSemaphore.ts");
    const bounded = loadPinnedModule("src/lib/quota/boundedMap.ts", s => s === "@/shared/utils/logger" ? { createLogger: deny } : deny());
    const watchdog = leaf("open-sse/services/rateLimitManager/wedgeWatchdog.ts");
    // Limiter creation requires upstream's Bottleneck package, absent from this
    // package's locked dependencies. It fails closed instead of simulating counts.
    const unavailable = new Proxy({}, { get: () => deny });
    this.manager = loadPinnedModule("open-sse/services/rateLimitManager.ts", s => {
      if (s === "../../src/lib/quota/boundedMap.ts") return bounded;
      if (s === "./rateLimitManager/wedgeWatchdog") return watchdog;
      if (s === "../../src/lib/resilience/settings") return { DEFAULT_RESILIENCE_SETTINGS: { requestQueue: {} } };
      if (s === "bottleneck") return { default: deny, __esModule: true };
      return unavailable;
    });
    const module = loadPinnedModule(route, s => {
      if (s === "next/server") return { NextResponse: { json: Response.json.bind(Response) } };
      if (s === "@/lib/api/requireManagementAuth") return { requireManagementAuth: this.auth.requireManagementAuth };
      if (s === "@omniroute/open-sse/services/rateLimitManager.ts") return failSnapshot ? { getAllRateLimitStatus: deny } : this.manager;
      if (s === "@omniroute/open-sse/services/rateLimitSemaphore.ts") return this.combo;
      if (s === "@omniroute/open-sse/services/accountSemaphore.ts") return this.account;
      return deny();
    });
    this.handler = module.GET as (request: Request) => Promise<Response>;
  }
  async handle(token?: string): Promise<Response> {
    const request = new Request("http://fixture.invalid/api/admin/concurrency", { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return this.auth.dispatch(request, { centralAuthRequired: true, handlerAuthRequired: true }, forwarded => this.handler(forwarded));
  }
  async close(): Promise<void> {
    (this.combo.resetAll as () => void)();
    (this.account.resetAll as () => void)();
    await (this.manager.__resetRateLimitManagerForTests as () => Promise<void>)();
  }
}
