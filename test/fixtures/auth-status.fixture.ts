import { Database } from "bun:sqlite";
import { createHmac, timingSafeEqual } from "node:crypto";
import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import { loadPinnedModule, readPinnedSource, withPinnedSourceSnapshot } from "./pinned-handler.fixture.ts";

export const AUTH_STATUS_ID = "GET /api/auth/status";
const empty: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
const view: JsonSchema = { type: "object", properties: { authenticated: { type: "boolean" } }, required: ["authenticated"], additionalProperties: false };

/** Candidate only: independent cold database lifecycle and platform qualification remain open. */
export function authStatusContract(): OperationSourceContract {
  const template = operationContractTemplate(AUTH_STATUS_ID) as unknown as OperationSourceContract;
  return { ...template,
    request: { ...template.request, pathSchema: empty, querySchema: empty, pathParameters: [], parameters: [], body: null },
    auth: { ...template.auth, domain: "public", sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "public", alternatives: [{ kind: "anonymous" }], optionalSessionCookie: "dashboard-session" } },
    response: { ...template.response, mediaType: "application/json", schema: view },
    secrets: { inputFields: [], outputFields: [] }, sideEffect: "lifecycle",
    pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: true, reason: "A valid session on a settings cache miss can persist headless onboarding settings; the response does not independently settle lifecycle effects." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null,
    mutationSafety: { preflight: { kind: "not-applicable", sourceReason: "No independent read establishes the session-dependent onboarding effect." }, reconciliation: { kind: "unknown" }, settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null } },
  };
}

export function authStatusDescriptor(): OperationDescriptor {
  const original = getOperation(AUTH_STATUS_ID);
  if (!original || original.source.sha256 !== "fb7c44407ba45fa0cf7464cee27458d866d5ba80283ebfa6d5a1a544f3684ede") throw new Error("Unexpected auth status source identity");
  const contract = authStatusContract();
  return { ...original, ...contract, mediaType: { request: null, response: contract.response.mediaType }, coverage: { status: "invokable", adapterId: "typed.fixture.auth-status", reason: null } };
}

const secret = "fixture-only-jwt-secret-not-a-credential";
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
/** Independent HS256 signer, never a credential or observation artifact. */
export function signFixtureToken(payload: Record<string, unknown>): string {
  const input = `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}`;
  return `${input}.${createHmac("sha256", secret).update(input).digest("base64url")}`;
}

// Narrow JOSE boundary: real HMAC and expiry checking, not a simulated verdict.
// It is not a substitute for qualification against the installed JOSE package.
const jose = {
  async jwtVerify(token: string, key: Uint8Array, options: { algorithms: string[] }) {
    const parts = token.split(".");
    if (parts.length !== 3 || !parts.every(part => /^[A-Za-z0-9_-]+$/.test(part))) throw new Error("Invalid JWT");
    const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8")) as { alg?: unknown };
    if (header.alg !== "HS256" || !options.algorithms.includes("HS256")) throw new Error("Invalid algorithm");
    const expected = createHmac("sha256", key).update(`${headerPart}.${payloadPart}`).digest();
    const actual = Buffer.from(signaturePart, "base64url");
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error("Invalid signature");
    const payload = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8")) as Record<string, unknown>;
    const now = Date.now() / 1000;
    if ((payload.exp !== undefined && (typeof payload.exp !== "number" || payload.exp <= now)) || (payload.nbf !== undefined && (typeof payload.nbf !== "number" || payload.nbf > now))) throw new Error("Invalid time claim");
    return { payload };
  },
};

/** Actual source handler, session verifier, cache and SQLite settings; framework and JOSE are boundaries. */
export class AuthStatusFixture {
  readonly db = new Database(":memory:");
  now = Date.now();
  reads = 0;
  fail = false;
  cookie: string | undefined;
  private readonly get: () => Promise<Response>;
  private readonly invalidate: (scope: "settings") => void;
  readonly isPublic: (path: string, method: string) => boolean;
  constructor(joseBoundary: unknown = jose) {
    const schema = /CREATE TABLE IF NOT EXISTS key_value\s*\([\s\S]*?\n\s*\);/i.exec(readPinnedSource("src/lib/db/core.ts"))?.[0];
    if (!schema) throw new Error("Pinned settings schema unavailable");
    this.db.exec(schema);
    const graph = withPinnedSourceSnapshot(() => {
      const deny = (s: string): never => { throw new Error(`Unexpected status fixture import: ${s}`); };
      const shared = loadPinnedModule("src/lib/db/settings/shared.ts", deny);
      const storage = loadPinnedModule("src/lib/db/settings.ts", s => {
        switch (s) {
          case "./core": return { getDbInstance: () => { this.reads++; if (this.fail) throw new Error("private backend failure"); return this.db; } };
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
      const session = loadPinnedModule("src/shared/utils/dashboardSessionToken.ts", s => {
        if (s === "jose") return joseBoundary;
        if (s === "@/lib/db/readCache") return cache;
        return deny(s);
      });
      const route = loadPinnedModule("src/app/api/auth/status/route.ts", s => {
        if (s === "next/server") return { NextResponse: { json: Response.json.bind(Response) } };
        if (s === "next/headers") return { cookies: async () => ({ get: (name: string) => name === "auth_token" && this.cookie ? { value: this.cookie } : undefined }) };
        if (s === "@/shared/utils/dashboardSessionToken") return session;
        return deny(s);
      });
      const publicRoutes = loadPinnedModule("src/shared/constants/publicApiRoutes.ts", deny);
      return { get: route.GET as () => Promise<Response>, invalidate: cache.invalidateDbCache as (scope: "settings") => void, isPublic: publicRoutes.isPublicApiRoute as (path: string, method: string) => boolean };
    });
    this.get = graph.get; this.invalidate = graph.invalidate; this.isPublic = graph.isPublic;
  }
  set(key: string, value: unknown): void { this.db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', ?, ?)").run(key, JSON.stringify(value)); }
  clearCache(): void { this.invalidate("settings"); }
  async handle(cookie?: string, jwtSecret: string | null = secret, initialPassword?: string): Promise<Response> {
    const priorSecret = process.env.JWT_SECRET, priorPassword = process.env.INITIAL_PASSWORD;
    this.cookie = cookie;
    if (jwtSecret === null) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = jwtSecret;
    if (initialPassword === undefined) delete process.env.INITIAL_PASSWORD; else process.env.INITIAL_PASSWORD = initialPassword;
    try { return await this.get(); } finally {
      if (priorSecret === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = priorSecret;
      if (priorPassword === undefined) delete process.env.INITIAL_PASSWORD; else process.env.INITIAL_PASSWORD = priorPassword;
      this.cookie = undefined;
    }
  }
  close(): void { this.db.close(); }
}
