import { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import * as zod from "zod";
import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import { requiredOmaScope } from "../../src/admin/authorization-policy.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import { createPinnedManagementAuthorization, loadExtractedPinnedDeclarations, loadPinnedModule, readPinnedSource, type PinnedExports } from "./pinned-handler.fixture.ts";

export const HISTORY_ID = "GET /api/a2a/tasks/history";
const route = "src/app/api/a2a/tasks/history/route.ts";
const empty: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
const fields: Record<string, JsonSchema> = {
  from: { type: "string", format: "date-time", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$" }, to: { type: "string", format: "date-time", pattern: "^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}(?:\\.\\d+)?Z$" },
  skill: { type: "string", minLength: 1 }, state: { type: "string", enum: ["submitted", "working", "completed", "failed", "cancelled"] },
  limit: { type: "integer", minimum: 1 }, offset: { type: "integer", minimum: 0 },
};
const item: JsonSchema = { type: "object", properties: {
  id: { type: "string" }, state: { type: "string" }, skill: { type: ["string", "null"] },
  createdAt: { type: "string" }, updatedAt: { type: "string" }, completedAt: { type: ["string", "null"] },
}, required: ["id", "state", "skill", "createdAt", "updatedAt", "completedAt"], additionalProperties: false };
const view: JsonSchema = { type: "object", properties: { tasks: { type: "array", items: item }, total: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 500 }, offset: { type: "integer", minimum: 0 } }, required: ["tasks", "total", "limit", "offset"], additionalProperties: false };

/** Fixture contract is not release eligibility; error bodies intentionally do not project. */
export function historyContract(): OperationSourceContract {
  const template = operationContractTemplate(HISTORY_ID) as unknown as OperationSourceContract;
  return { ...template,
    request: { ...template.request, pathSchema: empty, pathParameters: [], querySchema: { type: "object", properties: fields, additionalProperties: false }, body: null,
      parameters: Object.entries(fields).map(([name, schema]) => ({ name, in: "query" as const, required: false, style: "form", explode: true, allowReserved: false, schema, inputAllowed: true, sourceFile: route })) },
    auth: { domain: "management", specificationAlternatives: template.auth.specificationAlternatives, sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false, handlerGuard: "requireManagementAuth", bootstrap: "none", alternatives: [
      { kind: "management-api-key", anyOf: ["manage", "admin"] }, { kind: "dashboard-session" },
      { kind: "auth-disabled", when: "central-and-handler-auth-not-required" },
      { kind: "oma-access-token", minimumScope: requiredOmaScope("GET", "/api/a2a/tasks/history") }, { kind: "trusted-local", loopbackOnly: true },
    ] } },
    response: { ...template.response, mediaType: "application/json", schema: view, variants: template.response.variants.map(v => v.statusCode === "200" ? { ...v, content: [{ mediaType: "application/json", schema: view, sourceFile: route }] } : v) },
    secrets: { inputFields: [], outputFields: ["input_json", "output_json", "api_key_id", "message"] }, sideEffect: "lifecycle",
    pagination: { mode: "offset", parameters: ["limit", "offset"] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: true, reason: "Cold database and settings initialization may write; a response cannot settle initialization effects." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null,
    mutationSafety: { preflight: { kind: "not-applicable", sourceReason: "No independent read settles initialization effects." }, reconciliation: { kind: "unknown" }, settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null } },
  };
}
export function historyDescriptor(): OperationDescriptor {
  const original = getOperation(HISTORY_ID);
  if (!original || original.source.sha256 !== "0c35eb4cffe05b36d66d725049e354fd70bab29e2fade1346760bf80c5e85d01") throw new Error("Unexpected A2A history handler identity");
  return { ...original, ...historyContract(), mediaType: { request: null, response: "application/json" }, coverage: { status: "invokable", adapterId: "typed.fixture.a2a-history", reason: null } };
}

function errors(): PinnedExports {
  const leaf = (p: string) => loadPinnedModule(p, s => { throw new Error(`Unexpected ${p} import: ${s}`); });
  const flags = leaf("open-sse/utils/registeredFeatureFlag.ts");
  const safety = loadPinnedModule("open-sse/utils/providerSafety.ts", s => { if (s === "./registeredFeatureFlag.ts") return flags; throw new Error(s); });
  const paths = leaf("open-sse/utils/errorPathRedaction.ts"), credentials = leaf("open-sse/utils/credentialPatterns.ts");
  const sanitation = loadPinnedModule("open-sse/utils/errorSanitization.ts", s => { if (s === "./errorPathRedaction.ts") return paths; if (s === "./credentialPatterns.ts") return credentials; if (s === "./providerSafety.ts") return safety; throw new Error(s); });
  const modules: Record<string, PinnedExports> = {
    "./cors.ts": leaf("open-sse/utils/cors.ts"), "./clinepassEnvelope.ts": leaf("open-sse/utils/clinepassEnvelope.ts"),
    "./tencentEnvelope.ts": loadPinnedModule("open-sse/utils/tencentEnvelope.ts", s => { if (s === "./providerSafety.ts") return safety; throw new Error(s); }),
    "./providerSafety.ts": safety, "./errorSanitization.ts": sanitation, "../config/errorConfig.ts": leaf("open-sse/config/errorConfig.ts"),
    "@/lib/logPayloads": loadExtractedPinnedDeclarations(["src/lib/logPayloads.ts"], ["normalizePayloadForLog"], s => { throw new Error(s); }),
    "./upstreamErrorPassthrough.ts": loadPinnedModule("open-sse/utils/upstreamErrorPassthrough.ts", s => { if (s === "./errorSanitization.ts") return sanitation; throw new Error(s); }),
    "./registeredFeatureFlag.ts": flags, "./publicErrorIdentifiers.ts": loadPinnedModule("open-sse/utils/publicErrorIdentifiers.ts", s => { if (s === "./providerSafety.ts") return safety; throw new Error(s); }),
    "./retryAfterInstant.ts": leaf("open-sse/utils/retryAfterInstant.ts"), "./proseRetryDelay.ts": leaf("open-sse/utils/proseRetryDelay.ts"), "../services/retryAfterJson.ts": leaf("open-sse/services/retryAfterJson.ts"),
  };
  return loadPinnedModule("open-sse/utils/error.ts", s => { if (modules[s]) return modules[s]; throw new Error(s); });
}

/** Pinned route/auth/store and migration on warm disposable SQLite, not real ingress/core. */
export class A2aHistoryFixture {
  readonly db = new Database(":memory:", { strict: true });
  readonly guard = createPinnedManagementAuthorization({
    isDashboardSession: token => token === "fixture-session", verifyAccessToken: token => token === "oma_fixture-read" ? { id: "read", name: "read", scope: "read" } : null,
    validateApiKey: key => ["fixture-owner-a", "fixture-owner-b", "fixture-manage"].includes(key),
    getApiKeyMetadata: key => key === "fixture-manage" ? { id: "manage", scopes: ["manage"] } : ["fixture-owner-a", "fixture-owner-b"].includes(key) ? { id: "inference", scopes: [] } : null,
  });
  requireApiKey = true;
  fail = false;
  private readonly handler: (request: Request) => Promise<Response>;
  constructor() {
    const identities: Readonly<Record<string, string>> = {
      "src/app/api/a2a/tasks/history/route.ts": "0c35eb4cffe05b36d66d725049e354fd70bab29e2fade1346760bf80c5e85d01",
      "src/app/api/a2a/_auth.ts": "d0f8d6b85f05818f89095e4568ec6a68a1128799c702b0b71fcfa636f1049276",
      "src/lib/a2a/authenticate.ts": "2e9ce08e52918179a9e3f66d4e08a66b1cfcecb9ce78a9c66b8ebf9ad593e31e",
      "src/lib/db/a2aTasks.ts": "19dbc63c5513f3dfc9b74534eb9805b8c8274d5391ef631110fe76d1b2b3a838",
      "src/lib/db/migrations/002_mcp_a2a_tables.sql": "824787caafd2c048662a3cbc21c645d38c1c910f742454497dfd8755623e0723",
    };
    for (const [path, expected] of Object.entries(identities)) {
      if (createHash("sha256").update(readPinnedSource(path)).digest("hex") !== expected) throw new Error(`Unexpected history source: ${path}`);
    }
    this.db.exec(readPinnedSource("src/lib/db/migrations/002_mcp_a2a_tables.sql"));
    const extraction = loadExtractedPinnedDeclarations(["src/sse/services/auth.ts", "src/sse/services/headerReader.ts", "src/sse/services/googApiKeyAuth.ts"], ["extractApiKey", "readNonEmptyUrlToken", "readHeaderValue", "extractGoogApiKeyHeader"], s => { throw new Error(s); });
    const authServices = { ...extraction, isValidApiKey: async (key: string) => ["fixture-owner-a", "fixture-owner-b", "fixture-manage"].includes(key) };
    const feature = { isRequireApiKeyEnabled: () => this.requireApiKey };
    const owner = loadPinnedModule("src/lib/a2a/authenticate.ts", s => { if (s === "crypto") return { createHash, timingSafeEqual }; if (s === "@/sse/services/auth") return authServices; if (s === "@/shared/utils/apiAuth") return { isDashboardSessionAuthenticated: async () => false }; if (s === "@/shared/utils/featureFlags") return feature; throw new Error(s); });
    const auth = loadPinnedModule("src/app/api/a2a/_auth.ts", s => { if (s === "@/lib/api/requireManagementAuth") return { requireManagementAuth: this.guard.requireManagementAuth }; if (s === "@/sse/services/auth") return authServices; if (s === "@/shared/utils/featureFlags") return feature; if (s === "@/lib/a2a/authenticate") return owner; throw new Error(s); });
    const storage = loadPinnedModule("src/lib/db/a2aTasks.ts", s => { if (s === "./core.ts") return { getDbInstance: () => { if (this.fail) throw new Error("fixture-private-storage-marker"); return this.db; } }; throw new Error(s); });
    const err = errors();
    const module = loadPinnedModule(route, s => { if (s === "next/server") return { NextResponse: { json: Response.json.bind(Response) } }; if (s === "zod") return zod; if (s === "@/app/api/a2a/_auth") return auth; if (s === "@/lib/db/a2aTasks") return storage; if (s === "@omniroute/open-sse/utils/error") return err; throw new Error(s); });
    this.handler = module.GET as (request: Request) => Promise<Response>;
  }
  close(): void { this.db.close(); }
  async handle(query = "", credential?: string, ingress = false, handlerAuthRequired = true): Promise<Response> {
    const headers: Record<string, string> = {};
    if (credential === "session") headers.cookie = "auth_token=fixture-session";
    else if (credential) headers.authorization = `Bearer ${credential}`;
    const request = new Request(`http://fixture.invalid/api/a2a/tasks/history${query}`, { headers });
    return this.guard.dispatch(request, { centralAuthRequired: ingress, handlerAuthRequired }, forwarded => this.handler(forwarded));
  }
}
