import { Database } from "bun:sqlite";
import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import { requiredOmaScope } from "../../src/admin/authorization-policy.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import {
  createPinnedManagementAuthorization,
  loadExtractedPinnedDeclarations,
  loadPinnedModule,
  readPinnedSource,
  withPinnedSourceSnapshot,
  type PinnedManagementAuthorization,
  type PinnedManagementAuthorizationBackends,
} from "./pinned-handler.fixture.ts";

export const MFA_STATUS_ID = "GET /api/auth/mfa/status";
const empty: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
const view: JsonSchema = { type: "object", properties: { enabled: { type: "boolean" }, backupCodesRemaining: { type: "integer", minimum: 0 }, recoverySwitchSet: { type: "boolean" } }, required: ["enabled", "backupCodesRemaining", "recoverySwitchSet"], additionalProperties: false };

/** Candidate only: native lifecycle and framework ingress evidence are required for admission. */
export function mfaStatusContract(): OperationSourceContract {
  const template = operationContractTemplate(MFA_STATUS_ID) as unknown as OperationSourceContract;
  return { ...template,
    request: { ...template.request, pathSchema: empty, querySchema: empty, pathParameters: [], parameters: [], body: null },
    auth: { domain: "management", specificationAlternatives: template.auth.specificationAlternatives, sourcePolicy: {
      status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false,
      handlerGuard: "requireManagementAuth", bootstrap: "none", alternatives: [
        { kind: "management-api-key", anyOf: ["manage", "admin"] }, { kind: "dashboard-session" },
        { kind: "auth-disabled", when: "central-and-handler-auth-not-required" },
        { kind: "oma-access-token", minimumScope: requiredOmaScope("GET", "/api/auth/mfa/status") },
        { kind: "trusted-local", loopbackOnly: true },
      ],
    } },
    response: { ...template.response, mediaType: "application/json", schema: view, variants: template.response.variants.map(variant => variant.statusCode === "200" ? { ...variant, content: [{ mediaType: "application/json", schema: view, sourceFile: "src/app/api/auth/mfa/status/route.ts" }] } : variant) },
    secrets: { inputFields: [], outputFields: ["secret", "backupCodeHashes", "enabledAt"] },
    sideEffect: "lifecycle", pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: true, reason: "Cold database initialization and migration can write; the response does not settle lifecycle effects." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null,
    mutationSafety: { preflight: { kind: "not-applicable", sourceReason: "No independent read settles initialization effects." }, reconciliation: { kind: "unknown" }, settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null } },
  };
}

export function mfaStatusDescriptor(): OperationDescriptor {
  const original = getOperation(MFA_STATUS_ID);
  if (!original || original.source.sha256 !== "722f9a027e69d1b0179130ea59787a58d468cf649d2e9383cac4b8f3498d5509" || original.source.gitBlobSha !== "e6aa48caa7c3c499f9a1d08853b2b50f3b603cd3") throw new Error("Unexpected MFA status source identity");
  const contract = mfaStatusContract();
  return { ...original, ...contract, mediaType: { request: null, response: contract.response.mediaType }, coverage: { status: "invokable", adapterId: "typed.fixture.mfa-status", reason: null } };
}

/** Pinned route and status/storage implementations; database initialization is a separate native proof. */
export class MfaStatusFixture {
  readonly db = new Database(":memory:");
  readonly guard: PinnedManagementAuthorization;
  reads = 0;
  fail = false;
  private readonly get: (request: Request) => Promise<Response>;

  constructor(backends: PinnedManagementAuthorizationBackends) {
    const schema = /CREATE TABLE IF NOT EXISTS key_value\s*\([\s\S]*?\n\s*\);/i.exec(readPinnedSource("src/lib/db/core.ts"))?.[0];
    if (!schema) throw new Error("Pinned settings schema unavailable");
    this.db.exec(schema);
    this.guard = createPinnedManagementAuthorization(backends);
    this.get = withPinnedSourceSnapshot(() => {
      const deny = (specifier: string): never => { throw new Error(`Unexpected MFA status fixture import: ${specifier}`); };
      const next = { NextResponse: { json: Response.json.bind(Response) } };
      const storage = loadPinnedModule("src/lib/db/dashboardMfa.ts", specifier => {
        if (specifier === "./core") return { getDbInstance: () => { this.reads++; if (this.fail) throw new Error("private backend failure"); return this.db; } };
        if (specifier === "./encryption") return { decrypt: (value: string) => value, encrypt: deny };
        return deny(specifier);
      });
      const dashboard = loadExtractedPinnedDeclarations(["src/server/auth/dashboardMfa.ts"], ["isRecoverySwitchSet", "getDashboardMfaStatus"], specifier => specifier === "@/lib/db/dashboardMfa" ? storage : deny(specifier), 'import { getDashboardMfaState } from "@/lib/db/dashboardMfa";');
      const error = { buildErrorBody: (_status: number, message: string) => ({ error: { message } }) };
      const support = loadPinnedModule("src/server/auth/mfaRouteSupport.ts", specifier => {
        if (specifier === "next/server") return next;
        if (specifier === "@omniroute/open-sse/utils/error.ts") return error;
        if (["@/lib/compliance/index", "@/lib/db/readCache", "@/lib/auth/managementPassword", "@/server/auth/loginGuard", "@/server/auth/loginPeer", "@/shared/utils/dashboardSessionToken"].includes(specifier)) return {};
        return deny(specifier);
      });
      const route = loadPinnedModule("src/app/api/auth/mfa/status/route.ts", specifier => {
        if (specifier === "next/server") return next;
        if (specifier === "@/lib/api/requireManagementAuth") return this.guard;
        if (specifier === "@/server/auth/dashboardMfa") return dashboard;
        if (specifier === "@/server/auth/mfaRouteSupport") return support;
        return deny(specifier);
      });
      return route.GET as (request: Request) => Promise<Response>;
    });
  }

  async handle(request: Request): Promise<Response> {
    return this.guard.dispatch(request, { centralAuthRequired: true, handlerAuthRequired: true }, this.get);
  }

  close(): void { this.db.close(); }
}
