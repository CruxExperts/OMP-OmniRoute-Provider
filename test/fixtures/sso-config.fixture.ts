import { Database } from "bun:sqlite";
import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import { loadPinnedModule, readPinnedSource, withPinnedSourceSnapshot } from "./pinned-handler.fixture.ts";

export const SSO_CONFIG_ID = "GET /api/auth/sso/config";
const empty: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
const identifier: JsonSchema = { type: "string", maxLength: 255, pattern: "^[A-Za-z0-9._-]*$" };
const authority: JsonSchema = { type: "string", maxLength: 512, pattern: "^(https://[A-Za-z0-9.-]+(?::[0-9]{1,5})?|http://(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(?::[0-9]{1,5})?)$" };
const uri: JsonSchema = { type: "string", maxLength: 1024, pattern: "^(?:[A-Za-z][A-Za-z0-9+.-]*://[A-Za-z0-9._~:\\[\\]-]+(?:/[A-Za-z0-9._~:/-]*)?|[A-Za-z][A-Za-z0-9+.-]*:[A-Za-z0-9._~:/-]+|[A-Za-z0-9._-]+(?:/[A-Za-z0-9._~-]+)*)$" };
export const ssoConfigView: JsonSchema = { type: "object", properties: { enabled: { type: "boolean" }, authorityHost: authority, tenantId: identifier, clientId: identifier, audience: uri, issuer: uri, scope: uri }, required: ["enabled"], additionalProperties: false };

export function ssoConfigContract(): OperationSourceContract {
  const template = operationContractTemplate(SSO_CONFIG_ID) as unknown as OperationSourceContract;
  return { ...template, request: { ...template.request, pathSchema: empty, querySchema: empty, pathParameters: [], parameters: [], body: null },
    auth: { ...template.auth, domain: "public", sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "public", alternatives: [{ kind: "anonymous" }] } },
    response: { ...template.response, mediaType: "application/json", schema: ssoConfigView, variants: template.response.variants.map(variant => variant.statusCode === "200" ? { ...variant, content: [{ mediaType: "application/json", schema: ssoConfigView, sourceFile: "src/app/api/auth/sso/config/route.ts" }] } : variant) },
    secrets: { inputFields: [], outputFields: ["graphClientSecret", "groupMappings", "defaultKeyGroupId"] }, sideEffect: "lifecycle", pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: true, reason: "A cold settings read can initialize storage and persist onboarding settings; the response does not settle lifecycle effects." }, retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null,
    mutationSafety: { preflight: { kind: "not-applicable", sourceReason: "No independent read establishes settings initialization effects." }, reconciliation: { kind: "unknown" }, settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null } } };
}
export function ssoConfigDescriptor(): OperationDescriptor {
  const original = getOperation(SSO_CONFIG_ID);
  if (!original || original.source.sha256 !== "16971949ae2e1b8f2de41c4d0c301ee531ff328683ad1f78f67c313306e503bd" || original.source.gitBlobSha !== "f31fd0f17a8a8cb89ee70e47689e5b71ff5e5f87") throw new Error("Unexpected SSO config source identity");
  const contract = ssoConfigContract();
  return { ...original, ...contract, mediaType: { request: null, response: contract.response.mediaType }, coverage: { status: "invokable", adapterId: "typed.fixture.sso-config", reason: null } };
}

export class SsoConfigFixture {
  readonly db = new Database(":memory:");
  reads = 0; fail = false; now = Date.now();
  readonly isPublic: (path: string, method: string) => boolean;
  private readonly get: () => Promise<Response>;
  private readonly invalidate: (scope: "settings") => void;
  constructor() {
    const schema = /CREATE TABLE IF NOT EXISTS key_value\s*\([\s\S]*?\n\s*\);/i.exec(readPinnedSource("src/lib/db/core.ts"))?.[0];
    if (!schema) throw new Error("Pinned settings schema unavailable");
    this.db.exec(schema);
    const graph = withPinnedSourceSnapshot(() => {
      const deny = (s: string): never => { throw new Error(`Unexpected SSO fixture import: ${s}`); };
      const shared = loadPinnedModule("src/lib/db/settings/shared.ts", deny);
      const storage = loadPinnedModule("src/lib/db/settings.ts", s => {
        switch (s) {
          case "./core": return { getDbInstance: () => { this.reads++; if (this.fail) throw new Error("fixture-private backend failure"); return this.db; } };
          case "./settings/shared": return shared;
          case "@omniroute/open-sse/config/providerModels.ts": return { PROVIDER_ID_TO_ALIAS: {} };
          case "./encryption": return { decrypt: (value: string) => value, encrypt: deny };
          case "@/shared/constants/bodySize": return { requestBodyLimitMbFromEnv: () => null };
          case "@/shared/constants/responsesPreviousResponseId": return { DEFAULT_RESPONSES_PREVIOUS_RESPONSE_ID_MODE: "off" };
          case "@/shared/constants/proxyBulkImport": return { PROXY_BULK_IMPORT_LIMIT_DEFAULT: 100 };
          case "./backup": case "@omniroute/open-sse/utils/proxyRefusalMemory.ts": case "@/shared/utils/featureFlags": case "./readCache": case "./proxies": case "@omniroute/open-sse/config/providerErrorRules.ts": case "@/lib/combos/steps": case "@/shared/utils/decodeUserinfo": case "./settings/noAuthProxyFallback": case "./settings/pricing": case "./settings/lkgp": case "./settings/cacheMetrics": return {};
          default: return deny(s);
        }
      });
      const clock = new Proxy(Date, { get: (target, property, receiver) => property === "now" ? () => this.now : Reflect.get(target, property, receiver) });
      const cache = loadPinnedModule("src/lib/db/readCache.ts", s => s === "@/lib/db/settings" ? storage : deny(s), { date: clock });
      const config = loadPinnedModule("src/server/authz/entra/config.ts", s => s === "@/lib/db/readCache" ? cache : deny(s));
      const route = loadPinnedModule("src/app/api/auth/sso/config/route.ts", s => s === "next/server" ? { NextResponse: { json: Response.json.bind(Response) } } : s === "@/server/authz/entra/config" ? config : deny(s));
      const publicRoutes = loadPinnedModule("src/shared/constants/publicApiRoutes.ts", deny);
      return { get: route.GET as () => Promise<Response>, invalidate: cache.invalidateDbCache as (scope: "settings") => void, isPublic: publicRoutes.isPublicApiRoute as (path: string, method: string) => boolean };
    });
    this.get = graph.get; this.invalidate = graph.invalidate; this.isPublic = graph.isPublic;
  }
  set(key: string, value: unknown): void { this.db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', ?, ?)").run(key, JSON.stringify(value)); }
  clearCache(): void { this.invalidate("settings"); }
  handle(): Promise<Response> { return this.get(); }
  close(): void { this.db.close(); }
}
