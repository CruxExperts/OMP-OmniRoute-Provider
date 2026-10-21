import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import * as zod from "zod";
import { readRouteSources } from "../../scripts/route-source-store.ts";

const pinnedNodeCrypto = { createHash, createHmac, randomUUID, timingSafeEqual };
const UPSTREAM_ROOT = resolve(process.cwd(), ".agents/state/omp-provider-release/upstream/omniroute-v3.8.52");
const MANIFEST_PATH = resolve(process.cwd(), "provenance/route-sources.json");

interface SourceReceipt {
  readonly path: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly gitBlobSha: string;
}

interface SourceManifest {
  readonly release: { readonly tag: string; readonly commit: string };
  readonly sourceCorpus: { readonly files: readonly SourceReceipt[] };
}

export type PinnedRequire = (specifier: string) => unknown;
export type PinnedExports = Record<string, unknown>;
export type PinnedAccessTokenVerdict =
  | { readonly kind: "absent" | "error" | "invalid" }
  | { readonly kind: "insufficient"; readonly have: "read" | "write" | "admin"; readonly need: "read" | "write" | "admin" }
  | { readonly kind: "ok"; readonly scope: "read" | "write" | "admin"; readonly id: string; readonly name: string };

export interface PinnedApiKeyMetadata {
  readonly id: string;
  readonly scopes: readonly string[];
}

export interface PinnedManagementAuthorizationBackends {
  readonly isDashboardSession: (token: string) => boolean;
  readonly verifyAccessToken: (token: string) => { readonly id: string; readonly name: string; readonly scope: unknown } | null;
  readonly validateApiKey: (key: string) => boolean | Promise<boolean>;
  readonly getApiKeyMetadata: (key: string) => PinnedApiKeyMetadata | null | Promise<PinnedApiKeyMetadata | null>;
  readonly internalServiceToken?: string;
  readonly loopbackCliToken?: string;
}

export interface PinnedManagementAuthorization {
  requireManagementAuth(request: Request): Promise<Response | null>;
  dispatch<T extends Response>(
    request: Request,
    options: { readonly centralAuthRequired: boolean; readonly handlerAuthRequired: boolean },
    handler: (forwardedRequest: Request) => T | Promise<T>,
  ): Promise<Response>;
}

function manifest(): SourceManifest {
  const value = readRouteSources(MANIFEST_PATH);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Pinned OmniRoute source manifest is not an object");
  }
  const candidate = value as Partial<SourceManifest>;
  if (candidate.release?.tag !== "v3.8.52" || candidate.release.commit !== "ad6f33f66bda34eba98645d3bfdabbde294bc843") {
    throw new Error("Pinned OmniRoute handler fixture is bound to unexpected upstream source");
  }
  if (!Array.isArray(candidate.sourceCorpus?.files)) throw new Error("Pinned source manifest omitted corpus receipts");
  return candidate as SourceManifest;
}

export function readPinnedSource(path: string): string {
  const receipt = manifest().sourceCorpus.files.find(entry => entry.path === path);
  if (!receipt) throw new Error(`Pinned source manifest has no receipt for ${path}`);
  const bytes = readFileSync(resolve(UPSTREAM_ROOT, path));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (bytes.byteLength !== receipt.bytes || sha256 !== receipt.sha256) {
    throw new Error(`Pinned source bytes do not match manifest receipt: ${path}`);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export function loadPinnedModule(
  path: string,
  restrictedRequire: PinnedRequire,
  options: { readonly date?: DateConstructor } = {},
): PinnedExports {
  const source = readPinnedSource(path);
  return executeCommonJs(path, source, restrictedRequire, options.date ?? globalThis.Date);
}

/**
 * A fixed Date constructor for pinned business modules. It intentionally makes
 * elapsed-time measurements deterministic; fixtures using it do not qualify
 * real-world latency or timeout performance.
 */
export function createPinnedFixtureDate(isoTimestamp: string): DateConstructor {
  const fixedMilliseconds = globalThis.Date.parse(isoTimestamp);
  if (!Number.isFinite(fixedMilliseconds)) throw new Error("Pinned fixture clock must use a valid ISO timestamp");
  const RealDate = globalThis.Date;
  return new Proxy(RealDate, {
    construct(target, args, newTarget) {
      return Reflect.construct(target, args.length === 0 ? [fixedMilliseconds] : args, newTarget);
    },
    apply() {
      return new RealDate(fixedMilliseconds).toString();
    },
    get(target, property, receiver) {
      if (property === "now") return () => fixedMilliseconds;
      return Reflect.get(target, property, receiver);
    },
  }) as DateConstructor;
}

/**
 * Execute the pinned v3.8.52 management pipeline and route guard around one
 * in-memory handler. Only infrastructure edges (settings, session verifier,
 * key/token stores, IP filter, body-size check and unrelated route classes) are
 * fixture-backed. Route classification, peer stamping/locality, scope checks,
 * management policy, trusted-header stripping, origin/CSRF checks and the
 * route-level guard all run from receipt-verified upstream source.
 */
export function createPinnedManagementAuthorization(
  backends: PinnedManagementAuthorizationBackends,
): PinnedManagementAuthorization {
  const nodeCrypto = pinnedNodeCrypto;
  const headers = loadPinnedModule("src/server/authz/headers.ts", () => {
    throw new Error("Pinned auth-header module has no runtime dependencies");
  });
  const managementScopes = loadPinnedModule("src/shared/constants/managementScopes.ts", () => {
    throw new Error("Pinned management-scope module has no runtime dependencies");
  });
  const routeGuard = loadPinnedModule("src/server/authz/routeGuard.ts", specifier => {
    if (specifier === "@/lib/config/runtimeSettings") {
      return { getAuthzBypassSnapshot: () => ({ enabled: false, prefixes: [] }) };
    }
    if (specifier === "@/shared/constants/spawnCapablePrefixes") {
      return loadPinnedModule("src/shared/constants/spawnCapablePrefixes.ts", () => {
        throw new Error("Pinned spawn-capable prefixes module has no runtime dependencies");
      });
    }
    if (specifier === "@/lib/vncSession/manifest") {
      return loadExtractedPinnedDeclarations(
        ["src/lib/vncSession/manifest.ts"],
        ["VNC_ROUTE_PREFIX"],
        () => { throw new Error("Pinned VNC manifest declaration has no runtime dependencies"); },
      );
    }
    throw new Error(`Unapproved pinned route-guard import: ${specifier}`);
  });
  const peerStamp = loadPinnedModule("src/server/authz/peerStamp.ts", specifier => {
    if (specifier === "node:crypto") return nodeCrypto;
    if (specifier === "./routeGuard") return routeGuard;
    throw new Error(`Unapproved pinned peer-stamp import: ${specifier}`);
  });
  const peerContext = loadPinnedModule("src/server/authz/peerContext.ts", specifier => {
    if (specifier === "node:crypto") return nodeCrypto;
    if (specifier === "../../lib/machineToken") return {
      getLegacyCliTokenSync: () => backends.loopbackCliToken ?? "",
      getMachineTokenSync: () => backends.loopbackCliToken ?? "",
    };
    if (specifier === "./headers") return headers;
    if (specifier === "./peerStamp") return peerStamp;
    if (specifier === "./routeGuard") return routeGuard;
    throw new Error(`Unapproved pinned peer-context import: ${specifier}`);
  });
  const accessTokens = loadPinnedAccessTokenAuth(token => backends.verifyAccessToken(token));
  const apiKeyFunctions = loadExtractedPinnedDeclarations(
    ["src/sse/services/auth.ts", "src/sse/services/headerReader.ts", "src/sse/services/googApiKeyAuth.ts"],
    ["extractApiKey", "readNonEmptyUrlToken", "readHeaderValue", "extractGoogApiKeyHeader"],
    specifier => { throw new Error(`Unapproved pinned API-key helper import: ${specifier}`); },
  );
  const apiKeyAuth = {
    ...apiKeyFunctions,
    isValidApiKey: (key: string) => backends.validateApiKey(key),
  };
  const sessionConstants = loadExtractedPinnedDeclarations(
    ["src/shared/utils/dashboardSessionToken.ts"],
    ["DASHBOARD_SESSION_COOKIE"],
    () => { throw new Error("Pinned dashboard-session cookie constant has no runtime dependencies"); },
  );
  // The cryptographic/database verifier is an explicit in-memory session backend;
  // apiAuth and the pipeline still decide whether and when this verdict is used.
  const sessionVerifier = {
    ...sessionConstants,
    getDashboardJwtSecret: () => Buffer.from(FIXTURE_SESSION_SECRET, "utf8"),
    mintDashboardSessionToken: async () => "unused-fixture-session",
    verifyDashboardSessionToken: async (token: string | null | undefined) =>
      token && backends.isDashboardSession(token)
        ? { authenticated: true, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30 }
        : null,
  };
  const publicRoutes = loadPinnedModule("src/shared/constants/publicApiRoutes.ts", specifier => {
    throw new Error(`Unapproved pinned public-route import: ${specifier}`);
  });
  let activeAuthRequired = true;
  const apiAuth = loadPinnedModule("src/shared/utils/apiAuth.ts", specifier => {
    if (specifier === "@/lib/auth/bootstrapToken") return {
      getOrCreateBootstrapToken: () => "fixture-bootstrap-token",
      peekBootstrapToken: (token: string | null) => token === "fixture-bootstrap-token",
    };
    if (specifier === "@/lib/db/settings") return {
      getSettings: async () => ({
        requireLogin: activeAuthRequired,
        password: "fixture-password",
        setupComplete: true,
      }),
    };
    if (specifier === "@/server/authz/headers") return headers;
    if (specifier === "@/server/authz/peerStamp") return peerStamp;
    if (specifier === "@/server/authz/routeGuard") return routeGuard;
    if (specifier === "@/shared/constants/publicApiRoutes") return publicRoutes;
    if (specifier === "@/shared/utils/dashboardSessionToken") return sessionVerifier;
    if (specifier === "@/sse/services/auth") return apiKeyAuth;
    if (specifier === "next/headers") return { cookies: async () => ({ get: () => undefined }) };
    if (specifier === "@/lib/db/apiKeys") return {
      validateApiKey: (key: string) => backends.validateApiKey(key),
      getApiKeyMetadata: (key: string) => backends.getApiKeyMetadata(key),
    };
    if (specifier === "@/shared/constants/managementScopes") return managementScopes;
    throw new Error(`Unapproved pinned API-auth import: ${specifier}`);
  });
  const internalServiceAuth = loadPinnedModule("src/lib/api/internalServiceAuth.ts", specifier => {
    if (specifier === "@/server/authz/headers") return headers;
    if (specifier === "node:fs") return { readFileSync: () => { throw new Error("Fixture never reads service-token files"); } };
    if (specifier === "node:crypto") return nodeCrypto;
    throw new Error(`Unapproved pinned internal-service-auth import: ${specifier}`);
  });
  const requireManagementAuth = loadPinnedModule("src/lib/api/requireManagementAuth.ts", specifier => {
    if (specifier === "@/shared/utils/apiAuth") return apiAuth;
    if (specifier === "@/lib/api/errorResponse") return errorResponse;
    if (specifier === "@/sse/services/auth") return apiKeyAuth;
    if (specifier === "@/lib/db/apiKeys") return {
      getApiKeyMetadata: (key: string) => backends.getApiKeyMetadata(key),
    };
    if (specifier === "@/lib/middleware/cliTokenAuth") return { isCliTokenAuthValid: async () => false };
    if (specifier === "@/server/authz/accessTokenAuth") return accessTokens;
    if (specifier === "@/lib/api/internalServiceAuth") return internalServiceAuth;
    if (specifier === "@/server/authz/headers") return headers;
    if (specifier === "@/shared/constants/managementScopes") return managementScopes;
    throw new Error(`Unapproved pinned route-guard-auth import: ${specifier}`);
  });
  const context = loadPinnedModule("src/server/authz/context.ts", () => {
    throw new Error("Pinned authz context module has no runtime dependencies");
  });
  const managementPolicy = loadPinnedModule("src/server/authz/policies/management.ts", specifier => {
    if (specifier === "node:crypto") return nodeCrypto;
    if (specifier === "../../../shared/services/modelSyncScheduler") return { isModelSyncInternalRequest: () => false };
    if (specifier === "../../../shared/utils/apiAuth") return apiAuth;
    if (specifier === "../context") return context;
    if (specifier === "../../../sse/services/auth") return apiKeyAuth;
    if (specifier === "../../../lib/db/apiKeys") return { getApiKeyMetadata: (key: string) => backends.getApiKeyMetadata(key) };
    if (specifier === "../../../lib/api/requireManagementAuth") return managementScopes;
    if (specifier === "../../../shared/constants/managementScopes") return managementScopes;
    if (specifier === "../accessTokenAuth") return accessTokens;
    if (specifier === "../../../lib/api/internalServiceAuth") return internalServiceAuth;
    if (specifier === "../../../lib/guardrails/videoBridgeBrokerAuth") return {
      VIDEO_BRIDGE_BROKER_PATH: "/api/modality-bridge/video/broker",
      VIDEO_BRIDGE_DRILLDOWN_PATH: "/api/modality-bridge/video/drilldown",
      isVideoBridgeBrokerTokenRequest: () => false,
    };
    if (specifier === "../peerContext") return peerContext;
    if (specifier === "../routeGuard") return routeGuard;
    throw new Error(`Unapproved pinned management-policy import: ${specifier}`);
  });
  const classifier = loadPinnedModule("src/server/authz/classify.ts", specifier => {
    if (specifier === "../../shared/constants/publicApiRoutes") return publicRoutes;
    throw new Error(`Unapproved pinned route-classifier import: ${specifier}`);
  });
  const csrfConstants = loadExtractedPinnedDeclarations(
    ["src/shared/constants/dashboardCsrf.ts"],
    ["DASHBOARD_CSRF_HEADER"],
    () => { throw new Error("Pinned dashboard-CSRF constant has no runtime dependencies"); },
  );
  const csrf = loadPinnedModule("src/server/authz/csrf.ts", specifier => {
    if (specifier === "node:crypto") return nodeCrypto;
    if (specifier === "@/shared/constants/dashboardCsrf") return csrfConstants;
    throw new Error(`Unapproved pinned CSRF import: ${specifier}`);
  });
  const trustProxyMode = loadPinnedModule("src/server/origin/trustProxyMode.ts", () => {
    throw new Error("Pinned proxy-trust settings module has no runtime dependencies");
  });
  const publicOrigin = loadPinnedModule("src/server/origin/publicOrigin.ts", specifier => {
    if (specifier === "@/server/authz/routeGuard") return routeGuard;
    if (specifier === "@/server/authz/headers") return headers;
    if (specifier === "@/server/authz/peerStamp") return peerStamp;
    if (specifier === "./trustProxyMode") return trustProxyMode;
    throw new Error(`Unapproved pinned origin-policy import: ${specifier}`);
  });
  const nextResponse = createFixtureNextResponse();
  const pipeline = loadPinnedModule("src/server/authz/pipeline.ts", specifier => {
    if (specifier === "next/server") return { NextResponse: nextResponse.NextResponse };
    if (specifier === "../../lib/db/readCache") return { getCachedSettings: async () => ({}) };
    if (specifier === "../../lib/gracefulShutdown") return { isDraining: () => false };
    if (specifier === "../../shared/middleware/bodySizeGuard") return {
      checkBodySize: () => null,
      getBodySizeLimit: () => Number.MAX_SAFE_INTEGER,
    };
    if (specifier === "@/shared/utils/dashboardSessionToken") return sessionVerifier;
    if (specifier === "../../shared/utils/requestId") return { generateRequestId: () => randomUUID() };
    if (specifier === "../cors/origins") return { applyCorsHeaders: () => undefined };
    if (specifier === "../origin/publicOrigin") return publicOrigin;
    if (specifier === "./classify") return classifier;
    if (specifier === "./csrf") return csrf;
    if (specifier === "./peerStamp") return peerStamp;
    if (specifier === "@omniroute/open-sse/services/ipFilter.ts") return { checkRequestIP: () => ({ allowed: true }) };
    if (specifier === "./policies/clientApi") return { clientApiPolicy: { evaluate: async () => { throw new Error("Unrelated client API policy was invoked by a management fixture"); } } };
    if (specifier === "./policies/management") return { managementPolicy: managementPolicy.managementPolicy };
    if (specifier === "./policies/public") return { publicPolicy: { evaluate: async () => { throw new Error("Unrelated public policy was invoked by a management fixture"); } } };
    if (specifier === "./headers") return headers;
    if (specifier === "./context") return context;
    throw new Error(`Unapproved pinned authz-pipeline import: ${specifier}`);
  });
  const executePipeline = pipeline.runAuthzPipeline;
  const executeRouteGuard = requireManagementAuth.requireManagementAuth;
  if (typeof executePipeline !== "function" || typeof executeRouteGuard !== "function") {
    throw new Error("Pinned management authorization omitted an expected export");
  }

  return {
    async requireManagementAuth(request) {
      const result = (requireManagementAuth.requireManagementAuth as (request: Request) => Promise<Response | null>)(request);
      return await result;
    },
    async dispatch(request, options, handler) {
      return withSerializedFixtureEnvironment(async () => {
      const priorEnvironment = withFixtureEnvironment(backends);
      try {
        const serverRequest = stampFixturePeer(request, headers, FIXTURE_PEER_STAMP_TOKEN);
        activeAuthRequired = options.centralAuthRequired;
        const middlewareResponse = await (executePipeline as (request: unknown, options: { enforce: boolean }) => Promise<Response>)(
          asNextRequest(serverRequest),
          { enforce: true },
        );
        const forwardedHeaders = nextResponse.takeForwardedHeaders(middlewareResponse);
        if (!forwardedHeaders) return middlewareResponse;

        activeAuthRequired = options.handlerAuthRequired;
        const forwardedRequest = new Request(serverRequest, { headers: forwardedHeaders });
        return await handler(forwardedRequest);
      } finally {
        restoreEnvironment(priorEnvironment);
      }
      });
    },
  };
}

// Every instance shares process.env, so serialize the full async source pipeline.
let environmentTail = Promise.resolve();
async function withSerializedFixtureEnvironment<T>(action: () => Promise<T>): Promise<T> {
  const previous = environmentTail;
  let release!: () => void;
  environmentTail = new Promise<void>(resolve => { release = resolve; });
  await previous;
  try { return await action(); }
  finally { release(); }
}

const FIXTURE_PEER_STAMP_TOKEN = "pinned-authz-fixture-peer-stamp-token";
const FIXTURE_SESSION_SECRET = "pinned-authz-fixture-session-secret";

function withFixtureEnvironment(backends: PinnedManagementAuthorizationBackends): Record<string, string | undefined> {
  const names = ["OMNIROUTE_PEER_STAMP_TOKEN", "OMNIROUTE_INTERNAL_SERVICE_TOKEN", "OMNIROUTE_DISABLE_CLI_TOKEN", "JWT_SECRET"] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.OMNIROUTE_PEER_STAMP_TOKEN = FIXTURE_PEER_STAMP_TOKEN;
  process.env.OMNIROUTE_INTERNAL_SERVICE_TOKEN = backends.internalServiceToken ?? "";
  process.env.OMNIROUTE_DISABLE_CLI_TOKEN = "false";
  process.env.JWT_SECRET = FIXTURE_SESSION_SECRET;
  return previous;
}

function restoreEnvironment(previous: Record<string, string | undefined>): void {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

function stampFixturePeer(request: Request, headersModule: PinnedExports, token: string): Request {
  const peerIpHeader = headersModule.PEER_IP_HEADER;
  const viaProxyHeader = headersModule.VIA_PROXY_HEADER;
  const clientIpHeader = headersModule.CLIENT_IP_HEADER;
  const headers = new Headers(request.headers);
  for (const name of [peerIpHeader, viaProxyHeader, clientIpHeader]) {
    if (typeof name === "string") headers.delete(name);
  }
  if (typeof peerIpHeader === "string") headers.set(peerIpHeader, `${token}|127.0.0.1`);
  if (typeof viaProxyHeader === "string") headers.set(viaProxyHeader, `${token}|0`);
  if (typeof clientIpHeader === "string") headers.set(clientIpHeader, `${token}|127.0.0.1`);
  return new Request(request, { headers });
}

function asNextRequest(request: Request): object {
  const nextUrl = Object.assign(new URL(request.url), { basePath: "" });
  return {
    url: request.url,
    method: request.method,
    headers: request.headers,
    body: request.body,
    nextUrl,
    cookies: {
      get: (name: string) => {
        const cookie = request.headers.get("cookie");
        if (!cookie) return undefined;
        for (const segment of cookie.split(";")) {
          const [key, ...value] = segment.split("=");
          if (key?.trim() === name && value.length > 0) return { value: value.join("=").trim() };
        }
        return undefined;
      },
    },
  };
}

function createFixtureNextResponse(): {
  readonly NextResponse: typeof Response & { next(init?: { request?: { headers?: Headers } }): Response };
  takeForwardedHeaders(response: Response): Headers | null;
} {
  const forwarded = new WeakMap<Response, Headers>();
  class FixtureNextResponse extends Response {
    readonly cookies = { delete: () => undefined, set: () => undefined };
    static next(init?: { request?: { headers?: Headers } }): Response {
      const response = new FixtureNextResponse(null, { status: 200 });
      const requestHeaders = init?.request?.headers;
      if (requestHeaders) forwarded.set(response, new Headers(requestHeaders));
      return response;
    }
    static json(body: unknown, init: ResponseInit = {}): Response {
      const headers = new Headers(init.headers);
      if (!headers.has("content-type")) headers.set("content-type", "application/json");
      return new FixtureNextResponse(JSON.stringify(body), { ...init, headers });
    }
    static redirect(url: string | URL, status = 307): Response {
      return Response.redirect(url, status);
    }
  }
  return {
    NextResponse: FixtureNextResponse,
    takeForwardedHeaders: response => forwarded.get(response) ?? null,
  };
}

const errorResponse = loadPinnedModule("src/lib/api/errorResponse.ts", specifier => {
    if (specifier === "crypto") return pinnedNodeCrypto;
  if (specifier === "@omniroute/open-sse/utils/errorSanitization.ts") return { sanitizeErrorMessage: (message: string) => message };
  throw new Error(`Unapproved pinned error-response import: ${specifier}`);
});

export function loadExtractedPinnedDeclarations(
  files: readonly string[],
  declarationNames: readonly string[],
  restrictedRequire: PinnedRequire,
): PinnedExports {
  const requested = new Set(declarationNames);
  const declarations = new Map<string, string>();
  for (const path of files) {
    const source = readPinnedSource(path);
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    for (const statement of file.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name && requested.has(statement.name.text)) {
        const name = statement.name.text;
        if (declarations.has(name)) throw new Error(`Pinned declaration is ambiguous: ${name}`);
        declarations.set(name, statement.getText(file));
        continue;
      }
      if (!ts.isVariableStatement(statement)) continue;
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !requested.has(declaration.name.text)) continue;
        const name = declaration.name.text;
        if (declarations.has(name)) throw new Error(`Pinned declaration is ambiguous: ${name}`);
        declarations.set(name, statement.getText(file));
      }
    }
  }
  const missing = [...requested].filter(name => !declarations.has(name));
  if (missing.length) throw new Error(`Pinned source declarations are missing: ${missing.join(", ")}`);
  return executeCommonJs(
    `extracted:${files.join(",")}`,
    `import { z } from "zod";\n${[...requested].map(name => declarations.get(name)).join("\n")}`,
    specifier => specifier === "zod" ? zod : restrictedRequire(specifier),
  );
}

function executeCommonJs(
  path: string,
  source: string,
  restrictedRequire: PinnedRequire,
  dateConstructor: DateConstructor = globalThis.Date,
): PinnedExports {
  const compiled = ts.transpileModule(source, {
    fileName: path,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
      importsNotUsedAsValues: ts.ImportsNotUsedAsValues.Remove,
    },
  }).outputText;
  const module = { exports: {} as PinnedExports };
  const scopedRequire = (specifier: string): unknown => {
    if (specifier === "zod") return zod;
    return restrictedRequire(specifier);
  };
  new Function("require", "module", "exports", "Date", compiled)(scopedRequire, module, module.exports, dateConstructor);
  return module.exports;
}

export function loadPinnedAccessTokenAuth(
  verifyAccessToken: (token: string) => { readonly id: string; readonly name: string; readonly scope: unknown } | null,
): { readonly evaluateAccessTokenAuth: (request: Request) => PinnedAccessTokenVerdict; readonly inferRequiredScope: (method: string, path: string) => "read" | "write" | "admin" } {
  const scopeModule = loadPinnedModule("src/lib/accessTokens/scopes.ts", () => {
    throw new Error("Pinned access scopes module has no runtime dependencies");
  });
  const inferenceModule = loadPinnedModule("src/server/authz/accessScopes.ts", () => {
    throw new Error("Pinned access-scope inference module has no runtime dependencies");
  });
  const authModule = loadPinnedModule("src/server/authz/accessTokenAuth.ts", specifier => {
    if (specifier === "@/lib/db/accessTokens") return { verifyAccessToken };
    if (specifier === "@/lib/accessTokens/scopes") return scopeModule;
    if (specifier === "@/server/authz/accessScopes") return inferenceModule;
    throw new Error(`Unapproved pinned access-token import: ${specifier}`);
  });
  const evaluate = authModule.evaluateAccessTokenAuth;
  const infer = inferenceModule.inferRequiredScope;
  if (typeof evaluate !== "function" || typeof infer !== "function") {
    throw new Error("Pinned access-token modules omitted their expected exports");
  }
  return {
    evaluateAccessTokenAuth: evaluate as (request: Request) => PinnedAccessTokenVerdict,
    inferRequiredScope: infer as (method: string, path: string) => "read" | "write" | "admin",
  };
}

export function providerAliasFromPinnedRegistry(path: string, providerId: string): { id: string; alias: string } {
  const source = readPinnedSource(path);
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !ts.isObjectLiteralExpression(declaration.initializer)) continue;
      for (const property of declaration.initializer.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isIdentifier(property.name) || property.name.text !== "id") continue;
        if (!ts.isStringLiteral(property.initializer) || property.initializer.text !== providerId) continue;
        const aliasProperty = declaration.initializer.properties.find(candidate => ts.isPropertyAssignment(candidate)
          && ts.isIdentifier(candidate.name) && candidate.name.text === "alias");
        if (!aliasProperty || !ts.isPropertyAssignment(aliasProperty) || !ts.isStringLiteral(aliasProperty.initializer)) {
          throw new Error(`Pinned provider registry has no literal alias for ${providerId}`);
        }
        return { id: providerId, alias: aliasProperty.initializer.text };
      }
    }
  }
  throw new Error(`Pinned provider registry has no entry for ${providerId}`);
}
