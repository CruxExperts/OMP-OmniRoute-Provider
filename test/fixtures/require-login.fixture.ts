import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import { loadPinnedModule, readPinnedSource, withPinnedSourceSnapshot } from "./pinned-handler.fixture.ts";

export const REQUIRE_LOGIN_ID = "GET /api/settings/require-login";
const empty: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
const boolean: JsonSchema = { type: "boolean" };
export const requireLoginView: JsonSchema = {
  type: "object", properties: {
    authenticated: boolean, requireLogin: boolean, hasPassword: boolean, setupComplete: boolean,
    oidcEnabled: boolean, oidcDisablePasswordLogin: boolean,
    nodeVersion: { type: "string", maxLength: 100, pattern: "^(?:v[0-9]+\\.[0-9]+\\.[0-9]+|bun-[0-9]+\\.[0-9]+\\.[0-9]+ \\(Node\\.js API [0-9]+\\.[0-9]+\\.[0-9]+\\))$" },
    nodeCompatible: boolean,
  }, required: ["authenticated", "requireLogin", "hasPassword", "setupComplete", "oidcEnabled", "oidcDisablePasswordLogin", "nodeVersion", "nodeCompatible"], additionalProperties: false,
};

/** Candidate: not authorization or independent ingress/native qualification. */
export function requireLoginContract(): OperationSourceContract {
  const template = operationContractTemplate(REQUIRE_LOGIN_ID) as unknown as OperationSourceContract;
  return { ...template, request: { ...template.request, pathSchema: empty, querySchema: empty, pathParameters: [], parameters: [], body: null },
    auth: { ...template.auth, domain: "public", sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "public", alternatives: [{ kind: "anonymous" }] } },
    response: { ...template.response, mediaType: "application/json", schema: requireLoginView, variants: template.response.variants.map(variant => variant.statusCode === "200" ? { ...variant, content: [{ mediaType: "application/json", schema: requireLoginView, sourceFile: "src/app/api/settings/require-login/route.ts" }] } : variant) },
    secrets: { inputFields: [], outputFields: ["password", "oidcClientSecret"] }, sideEffect: "lifecycle", pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: true, reason: "Cold settings reads may initialize storage or persist onboarding; the response cannot settle those effects." }, retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null,
    mutationSafety: { preflight: { kind: "not-applicable", sourceReason: "No independent read settles initialization effects." }, reconciliation: { kind: "unknown" }, settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null } } };
}
export function requireLoginDescriptor(): OperationDescriptor {
  const original = getOperation(REQUIRE_LOGIN_ID);
  if (!original || original.source.sha256 !== "f24b9fe0702ce4ead3abc2cda77a2013d9ad3df47e034cd8e4e4dfff00aa1e31" || original.source.gitBlobSha !== "336aebcdafb778fe56e880c9d72a6ffe90e7dba4") throw new Error("Unexpected require-login source identity");
  const contract = requireLoginContract();
  return { ...original, ...contract, mediaType: { request: null, response: contract.response.mediaType }, coverage: { status: "invokable", adapterId: "typed.fixture.require-login", reason: null } };
}

const secret = "fixture-only-jwt-secret-not-a-credential";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
export function loginFixtureToken(payload: Record<string, unknown>): string {
  const input = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}
// Fixture JOSE edge verifies HS256 and time claims; installed JOSE remains an independent evidence gap.
const jose = { async jwtVerify(token: string, key: Uint8Array, options: { algorithms: string[] }) {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error("Invalid JWT");
  const [header, payloadPart, signature] = parts as [string, string, string];
  if (JSON.parse(Buffer.from(header, "base64url").toString()).alg !== "HS256" || !options.algorithms.includes("HS256")) throw new Error("Invalid algorithm");
  const expected = createHmac("sha256", key).update(`${header}.${payloadPart}`).digest(), actual = Buffer.from(signature, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid signature");
  const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString()) as Record<string, unknown>;
  const now = Date.now() / 1000;
  if ((payload.exp !== undefined && (typeof payload.exp !== "number" || payload.exp <= now)) || (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > now))) throw new Error("Invalid time claim");
  return { payload };
} };

export class RequireLoginFixture {
  readonly db = new Database(":memory:");
  now = Date.now(); reads = 0; fail = false; cookie: string | undefined;
  readonly isPublic: (path: string, method: string) => boolean;
  private readonly get: () => Promise<Response>;
  private readonly clearSettings: (scope: "settings") => void;
  private readonly clearFlags: () => void;
  private readonly clearBridge: () => void;
  constructor() {
    const schema = /CREATE TABLE IF NOT EXISTS key_value\s*\([\s\S]*?\n\s*\);/i.exec(readPinnedSource("src/lib/db/core.ts"))?.[0];
    if (!schema) throw new Error("Pinned settings schema unavailable");
    this.db.exec(schema);
    const graph = withPinnedSourceSnapshot(() => {
      const deny = (s: string): never => { throw new Error(`Unexpected require-login fixture import: ${s}`); };
      const db = () => { this.reads++; if (this.fail) throw new Error("fixture-private backend failure"); return this.db; };
      const clock = new Proxy(Date, { get: (target, property, receiver) => property === "now" ? () => this.now : Reflect.get(target, property, receiver) });
      const definitions = loadPinnedModule("src/shared/constants/featureFlagDefinitions.ts", deny);
      const flagDb = loadPinnedModule("src/lib/db/featureFlags.ts", s => s === "./core" ? { getDbInstance: db } : s === "@/shared/constants/featureFlagDefinitions" ? definitions : s === "./models/modelCatalogWriteSignals" ? {} : deny(s), { date: clock });
      const localBridgeKey = Symbol("fixture-feature-flag-resolver");
      const bridge = loadPinnedModule("src/shared/utils/featureFlagResolverBridge.ts", s => s === "@/shared/utils/processSingleton" ? { sharedSymbol: () => localBridgeKey } : deny(s));
      const requireKey = loadPinnedModule("src/shared/utils/requireApiKeyValue.mjs", deny);
      const flags = loadPinnedModule("src/shared/utils/featureFlags.ts", s => s === "@/lib/db/featureFlags" ? flagDb : s === "@/shared/constants/featureFlagDefinitions" ? definitions : s === "@/shared/utils/featureFlagResolverBridge" ? bridge : s === "@/shared/utils/requireApiKeyValue.mjs" ? requireKey : deny(s));
      const shared = loadPinnedModule("src/lib/db/settings/shared.ts", deny);
      const storage = loadPinnedModule("src/lib/db/settings.ts", s => {
        switch (s) {
          case "./core": return { getDbInstance: db };
          case "./settings/shared": return shared;
          case "@omniroute/open-sse/config/providerModels.ts": return { PROVIDER_ID_TO_ALIAS: {} };
          case "./encryption": return { decrypt: (value: string) => value, encrypt: deny };
          case "@/shared/constants/bodySize": return { requestBodyLimitMbFromEnv: () => null };
          case "@/shared/constants/responsesPreviousResponseId": return { DEFAULT_RESPONSES_PREVIOUS_RESPONSE_ID_MODE: "off" };
          case "@/shared/constants/proxyBulkImport": return { PROXY_BULK_IMPORT_LIMIT_DEFAULT: 100 };
          case "@/shared/utils/featureFlags": return flags;
          case "./backup": case "@omniroute/open-sse/utils/proxyRefusalMemory.ts": case "./readCache": case "./proxies": case "@omniroute/open-sse/config/providerErrorRules.ts": case "@/lib/combos/steps": case "@/shared/utils/decodeUserinfo": case "./settings/noAuthProxyFallback": case "./settings/pricing": case "./settings/lkgp": case "./settings/cacheMetrics": return {};
          default: return deny(s);
        }
      });
      const cache = loadPinnedModule("src/lib/db/readCache.ts", s => s === "@/lib/db/settings" ? storage : deny(s), { date: clock });
      const session = loadPinnedModule("src/shared/utils/dashboardSessionToken.ts", s => s === "jose" ? jose : s === "@/lib/db/readCache" ? cache : deny(s));
      const password = loadPinnedModule("src/lib/auth/managementPassword.ts", s => s === "bcryptjs" ? {} : s === "@/lib/db/settings" ? storage : deny(s));
      const runtime = loadPinnedModule("src/shared/utils/nodeRuntimeSupport.ts", deny);
      const route = loadPinnedModule("src/app/api/settings/require-login/route.ts", s => {
        switch (s) {
          case "next/server": return { NextResponse: { json: Response.json.bind(Response) } };
          case "next/headers": return { cookies: async () => ({ get: (name: string) => name === "auth_token" && this.cookie ? { value: this.cookie } : undefined }) };
          case "@/shared/utils/featureFlags": return flags;
          case "@/lib/db/settings": return storage;
          case "@/lib/auth/managementPassword": return password;
          case "@/shared/utils/dashboardSessionToken": return session;
          case "@/shared/utils/nodeRuntimeSupport.ts": return runtime;
          case "@/lib/auth/bootstrapToken": case "@/lib/api/errorResponse": case "@/lib/api/operatorCredential": case "@/lib/api/settingsAudit": case "@/server/authz/headers": case "@/shared/validation/schemas": case "@/shared/validation/helpers": return {};
          default: return deny(s);
        }
      });
      const publicRoutes = loadPinnedModule("src/shared/constants/publicApiRoutes.ts", deny);
      return { get: route.GET as () => Promise<Response>, clearSettings: cache.invalidateDbCache as (scope: "settings") => void, clearFlags: flagDb.clearFeatureFlagOverrideCache as () => void, isPublic: publicRoutes.isPublicApiRoute as (path: string, method: string) => boolean, clearBridge: () => delete (globalThis as unknown as Record<symbol, unknown>)[localBridgeKey] };
    });
    this.get = graph.get; this.clearSettings = graph.clearSettings; this.clearFlags = graph.clearFlags; this.isPublic = graph.isPublic; this.clearBridge = graph.clearBridge;
  }
  set(key: string, value: unknown): void { this.db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', ?, ?)").run(key, JSON.stringify(value)); }
  setFlag(value: string): void { this.db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('feature_flags', 'OMNIROUTE_OIDC_DISABLE_PASSWORD_LOGIN', ?)").run(value); }
  clearCache(): void { this.clearSettings("settings"); this.clearFlags(); }
  async handle(options: { cookie?: string; initialPassword?: string; flagEnv?: string; oidcEnv?: string; secret?: string | null } = {}): Promise<Response> {
    const keys = ["JWT_SECRET", "INITIAL_PASSWORD", "OMNIROUTE_OIDC_DISABLE_PASSWORD_LOGIN", "OIDC_DISABLE_PASSWORD_LOGIN"] as const;
    const previous = keys.map(key => process.env[key]);
    const values = [options.secret === undefined ? secret : options.secret ?? undefined, options.initialPassword, options.flagEnv, options.oidcEnv];
    this.cookie = options.cookie;
    for (let i = 0; i < keys.length; i++) { const value = values[i]; if (value === undefined) delete process.env[keys[i]!]; else process.env[keys[i]!] = value; }
    try { return await this.get(); } finally { keys.forEach((key, i) => { const value = previous[i]; if (value === undefined) delete process.env[key]; else process.env[key] = value; }); this.cookie = undefined; }
  }
  close(): void { this.clearBridge(); this.db.close(); }
}
