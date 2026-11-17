import * as crypto from "node:crypto";
import { isIP } from "node:net";
import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import { requiredOmaScope } from "../../src/admin/authorization-policy.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import { loadPinnedModule, type PinnedExports } from "./pinned-handler.fixture.ts";
import { createPinnedProxyHandlers } from "./pinned-proxy-handlers.fixture.ts";

export const VISIBILITY_ID = "GET /api/admin/proxy-pool-visibility";
const route = "src/app/api/admin/proxy-pool-visibility/route.ts";
const empty: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
const text: JsonSchema = { type: "string", maxLength: 512 };
const count: JsonSchema = { type: "integer", minimum: 0, maximum: 1000000 };
const setAside: JsonSchema = { type: ["object", "null"], properties: { streak: count }, required: ["streak"], additionalProperties: false };
const member: JsonSchema = { type: "object", properties: {
  opaque: { type: "boolean" }, rank: { type: "integer", minimum: 1, maximum: 10000 },
  signal: { type: "string", enum: ["position", "set-aside"] }, setAside,
  memberSetAside: { type: "array", maxItems: 10000, items: { type: "object", properties: { avoided: { type: "boolean" }, setAside }, required: ["avoided", "setAside"], additionalProperties: false } },
  transportEvidence: { type: "object", properties: { failures: count, crossSuccesses: count, windowMs: count }, required: ["failures", "crossSuccesses", "windowMs"], additionalProperties: false },
}, required: ["opaque", "rank", "signal", "setAside", "memberSetAside", "transportEvidence"], additionalProperties: false };
const view: JsonSchema = { type: "object", properties: {
  strategy: { type: ["string", "null"], enum: [null, "round-robin", "random", "latency", "sticky"] }, rankedBy: { type: "string", enum: ["health", "position"] }, processMemory: { type: "boolean", const: true },
  members: { type: "array", items: member, maxItems: 10000 }, total: count,
  // A pause's model/provider, timestamp and source reason are private. Array length remains useful.
  pauses: { type: "array", maxItems: 512, items: empty },
}, required: ["processMemory"], additionalProperties: false };

export function visibilityContract(): OperationSourceContract {
  const template = operationContractTemplate(VISIBILITY_ID) as unknown as OperationSourceContract;
  const fields: Record<string, JsonSchema> = { scope: text, scopeId: text, proxyId: text, freeTierPauses: text, provider: text };
  return { ...template,
    request: { ...template.request, pathSchema: empty, pathParameters: [], querySchema: { type: "object", properties: fields, additionalProperties: false }, body: null, parameters: Object.entries(fields).map(([name, schema]) => ({ name, in: "query" as const, required: false, style: "form", explode: true, allowReserved: false, schema, inputAllowed: true, sourceFile: route })) },
    auth: { domain: "management", specificationAlternatives: template.auth.specificationAlternatives, sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false, handlerGuard: "requireManagementAuth", bootstrap: "none", alternatives: [{ kind: "management-api-key", anyOf: ["manage", "admin"] }, { kind: "dashboard-session" }, { kind: "auth-disabled", when: "central-and-handler-auth-not-required" }, { kind: "oma-access-token", minimumScope: requiredOmaScope("GET", "/api/admin/proxy-pool-visibility") }, { kind: "trusted-local", loopbackOnly: true }] } },
    secrets: { inputFields: ["scopeId", "proxyId", "provider"], outputFields: ["id", "name", "scope", "display", "userMasked", "member", "storeInstance", "kind", "since", "endsAt", "provider", "model", "until", "reason"] },
    response: { ...template.response, mediaType: "application/json", schema: view, variants: template.response.variants.map(v => v.statusCode === "200" ? { ...v, content: [{ mediaType: "application/json", schema: view, sourceFile: route }] } : v) },
    sideEffect: "lifecycle", pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: true, reason: "Database initialization and lazy expiry/cache cleanup can modify local state; a response cannot settle all effects." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null,
    mutationSafety: { preflight: { kind: "not-applicable", sourceReason: "No independent read settles initialization and process-memory cleanup." }, reconciliation: { kind: "unknown" }, settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null } },
  };
}
export function visibilityDescriptor(): OperationDescriptor {
  const original = getOperation(VISIBILITY_ID);
  if (!original || original.source.sha256 !== "58b6fb4ce329b58d35ff87af440857cf8ec70824b3d62f8c79ebf11ca797f8b8") throw new Error("Unexpected visibility handler identity");
  return { ...original, ...visibilityContract(), mediaType: { request: null, response: "application/json" }, coverage: { status: "invokable", adapterId: "typed.fixture.proxy-pool-visibility", reason: null } };
}

/** Warm SQLite fixture: route, guard, DB, ranking and memory are pinned source; network is denied. */
export class ProxyVisibilityFixture {
  readonly rotation: PinnedExports = {};
  readonly flags: PinnedExports = {};
  readonly base = createPinnedProxyHandlers(undefined, { boundaries: { "src/lib/db/proxies/rotation.ts": this.rotation, "src/shared/utils/featureFlags.ts": this.flags } });
  readonly refusal: PinnedExports;
  readonly pauses: PinnedExports;
  flagDb!: PinnedExports;
  private readonly handler: (request: Request) => Promise<Response>;
  constructor() {
    const load = this.base.load;
    const deny = () => { throw new Error("Unexpected external dispatch"); };
    const leaf = (path: string) => loadPinnedModule(path, s => { throw new Error(`Unexpected ${path} import ${s}`); });
    const transitions = leaf("open-sse/utils/proxyTransitionListeners.ts");
    const family = loadPinnedModule("open-sse/utils/proxyFamily.ts", s => s === "node:net" ? { isIP } : deny());
    this.refusal = loadPinnedModule("open-sse/utils/proxyRefusalMemory.ts", s => s === "./proxyTransitionListeners.ts" ? transitions : s === "./proxyFamily.ts" ? family : deny());
    this.pauses = leaf("open-sse/services/opencodeFreeTierSkip.ts");
    const definitions = load("src/shared/constants/featureFlagDefinitions.ts");
    const flagDb = loadPinnedModule("src/lib/db/featureFlags.ts", s => s === "@/shared/constants/featureFlagDefinitions" ? definitions : s === "./core" ? { getDbInstance: () => this.base.db } : s === "./models/modelCatalogWriteSignals" ? { finishModelCatalogWriteWithoutBackup: deny } : deny());
    this.flagDb = flagDb;
    const bridge = load("src/shared/utils/featureFlagResolverBridge.ts");
    const requireApi = load("src/shared/utils/requireApiKeyValue.mjs");
    Object.assign(this.flags, loadPinnedModule("src/shared/utils/featureFlags.ts", s => s === "@/lib/db/featureFlags" ? flagDb : s === "@/shared/constants/featureFlagDefinitions" ? definitions : s === "@/shared/utils/featureFlagResolverBridge" ? bridge : s === "@/shared/utils/requireApiKeyValue.mjs" ? requireApi : deny()));
    const health = loadPinnedModule("src/lib/proxyHealth.ts", s => s === "node:net" ? { createConnection: deny } : s.includes("proxyFamily") ? family : s.includes("proxyRefusalMemory") ? this.refusal : s === "@/shared/utils/featureFlags" ? this.flags : deny());
    const rankingImports: Record<string, unknown> = {
      "crypto": crypto, "../core": { getDbInstance: () => this.base.db }, "../proxyLatency": { pickByLatency: deny },
      "@omniroute/open-sse/utils/proxyRefusalMemory.ts": this.refusal, "@omniroute/open-sse/config/providerErrorRules.ts": { isEgressBucketedLockScope: deny },
      "@/lib/proxyEvents/proxyTransitionBridge": { maybeEmitPoolExhausted: deny }, "@/shared/utils/featureFlags": this.flags, "@/lib/proxyHealth": health,
      "../proxyLogs": { getRecentEgressIpForProxy: deny, getRecentEgressIpsForProxy: deny }, "@/shared/network/egressAddress": load("src/shared/network/egressAddress.ts"),
      "../proxyOperatorEgress": { readOperatorEgressForMember: deny }, "./types": load("src/lib/db/proxies/types.ts"), "./mappers": load("src/lib/db/proxies/mappers.ts"),
    };
    Object.assign(this.rotation, loadPinnedModule("src/lib/db/proxies/rotation.ts", s => rankingImports[s] ?? deny()));
    const module = loadPinnedModule(route, s => {
      if (s === "next/server") return { NextResponse: { json: Response.json.bind(Response) } };
      if (s === "@/lib/api/requireManagementAuth") return { requireManagementAuth: this.base.auth.requireManagementAuth };
      if (s === "@/lib/api/errorResponse") return load("src/lib/api/errorResponse.ts");
      if (s === "@/lib/db/proxies") return { ...load("src/lib/db/proxies.ts"), getScopePoolEgressRows: this.rotation.getScopePoolEgressRows, getScopeRotationStrategy: this.rotation.getScopeRotationStrategy };
      if (s === "@/lib/db/proxies/mappers") return load("src/lib/db/proxies/mappers.ts");
      if (s === "@/lib/db/proxies/rotation") return this.rotation;
      if (s === "@/shared/utils/featureFlags") return this.flags;
      if (s.includes("proxyRefusalMemory")) return this.refusal;
      if (s.includes("opencodeFreeTierSkip")) return this.pauses;
      throw new Error(`Unexpected visibility import ${s}`);
    });
    this.handler = module.GET as (request: Request) => Promise<Response>;
  }
  async handle(query: string, token?: string): Promise<Response> {
    const request = new Request(`http://fixture.invalid/api/admin/proxy-pool-visibility${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
    return this.base.auth.dispatch(request, { centralAuthRequired: true, handlerAuthRequired: true }, forwarded => this.handler(forwarded));
  }
  close(): void { (this.refusal.__resetProxyRefusalMemoryForTesting as () => void)(); (this.refusal.__resetTransportEvidenceForTesting as () => void)(); (this.pauses.clearOpencodeFreeTierSkips as () => void)(); this.base.close(); }
}
