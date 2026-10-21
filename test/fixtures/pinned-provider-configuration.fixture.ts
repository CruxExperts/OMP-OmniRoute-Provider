import { Database } from "bun:sqlite";
import {
  createPinnedManagementAuthorization,
  loadExtractedPinnedDeclarations,
  loadPinnedModule,
  readPinnedSource,
  type PinnedExports,
  type PinnedManagementAuthorization,
} from "./pinned-handler.fixture.ts";

type ProviderConfig = Record<string, unknown>;
type RouteContext = { readonly params: Promise<{ readonly id: string }> };
type RouteHandler = (request: Request, context: RouteContext) => Promise<Response>;
type ProviderConfigRoute = PinnedExports & {
  readonly GET: RouteHandler;
  readonly PUT: RouteHandler;
  readonly DELETE: RouteHandler;
};

export interface PinnedProviderConfigurationHandlers {
  readonly interception: ProviderConfigRoute;
  readonly paramFilters: ProviderConfigRoute;
  readonly getInterceptionRules: (provider: string) => ProviderConfig | null;
  readonly getParamFilterConfig: (provider: string) => ProviderConfig | null;
}

function requiredFunction<T extends (...args: never[]) => unknown>(module: PinnedExports, name: string): T {
  const value = module[name];
  if (typeof value !== "function") throw new Error(`Pinned provider configuration module omitted ${name}`);
  return value as T;
}

/** Uses the exact receipt-verified upstream key_value table schema. */
export function createPinnedProviderConfigurationSchema(database: Database): void {
  const source = readPinnedSource("src/lib/db/core.ts");
  const schema = /const SCHEMA_SQL = `([\s\S]*?)`;/m.exec(source)?.[1];
  const table = schema && /CREATE TABLE IF NOT EXISTS key_value\s*\([\s\S]*?\n\s*\);/i.exec(schema)?.[0];
  if (!table) throw new Error("Receipt-verified core schema omitted the key_value table");
  database.exec(table);
}

export function createPinnedProviderConfigurationHandlers(
  database: Database,
  authorization: PinnedManagementAuthorization,
): PinnedProviderConfigurationHandlers {
  const core = { getDbInstance: () => database };
  const interceptionPersistence = loadPinnedModule("src/lib/db/interceptionRules.ts", specifier => {
    if (specifier === "./core") return core;
    throw new Error(`Unapproved pinned interception-rules import: ${specifier}`);
  });
  const paramFilterPersistence = loadPinnedModule("src/lib/db/paramFilters.ts", specifier => {
    if (specifier === "./core") return core;
    throw new Error(`Unapproved pinned param-filter import: ${specifier}`);
  });
  const schemas = loadExtractedPinnedDeclarations(
    ["src/shared/validation/schemas/provider.ts"],
    [
      "paramFilterListSchema",
      "modelParamFilterSchema",
      "updateParamFilterConfigSchema",
      "fetchInterceptionBackendSchema",
      "modelInterceptionRuleSchema",
      "updateInterceptionRulesSchema",
    ],
    specifier => { throw new Error(`Unapproved pinned provider-schema import: ${specifier}`); },
  );
  const validation = loadExtractedPinnedDeclarations(
    ["src/shared/validation/helpers.ts"],
    ["validateBody", "isValidationFailure"],
    specifier => { throw new Error(`Unapproved pinned validation-helper import: ${specifier}`); },
  );
  const pathRedaction = loadPinnedModule("open-sse/utils/errorPathRedaction.ts", () => {
    throw new Error("Pinned error path redaction has no runtime imports");
  });
  const credentialPatterns = loadPinnedModule("open-sse/utils/credentialPatterns.ts", () => {
    throw new Error("Pinned error credential patterns have no runtime imports");
  });
  const providerSafety = loadPinnedModule("open-sse/utils/providerSafety.ts", specifier => {
    if (specifier === "./registeredFeatureFlag.ts") {
      return { isRegisteredFeatureFlagEnabled: () => false };
    }
    throw new Error(`Unapproved pinned provider-safety import: ${specifier}`);
  });
  const sanitization = loadPinnedModule("open-sse/utils/errorSanitization.ts", specifier => {
    if (specifier === "./errorPathRedaction.ts") return pathRedaction;
    if (specifier === "./credentialPatterns.ts") return credentialPatterns;
    if (specifier === "./providerSafety.ts") return providerSafety;
    throw new Error(`Unapproved pinned error-sanitization import: ${specifier}`);
  });
  const errorConfig = loadPinnedModule("open-sse/config/errorConfig.ts", () => {
    throw new Error("Pinned error configuration has no runtime imports");
  });
  const passthrough = loadPinnedModule("open-sse/utils/upstreamErrorPassthrough.ts", specifier => {
    if (specifier === "./errorSanitization.ts") return sanitization;
    throw new Error(`Unapproved pinned error-passthrough import: ${specifier}`);
  });
  const retryAfter = loadPinnedModule("open-sse/utils/retryAfterInstant.ts", () => {
    throw new Error("Pinned retry-after parser has no runtime imports");
  });
  const proseRetry = loadPinnedModule("open-sse/utils/proseRetryDelay.ts", () => {
    throw new Error("Pinned prose retry parser has no runtime imports");
  });
  const retryAfterJson = loadPinnedModule("open-sse/services/retryAfterJson.ts", () => {
    throw new Error("Pinned JSON retry parser has no runtime imports");
  });
  const cors = loadPinnedModule("open-sse/utils/cors.ts", () => {
    throw new Error("Pinned CORS module has no runtime imports");
  });
  const clinepass = loadPinnedModule("open-sse/utils/clinepassEnvelope.ts", () => {
    throw new Error("Pinned Clinepass envelope parser has no runtime imports");
  });
  const tencent = loadPinnedModule("open-sse/utils/tencentEnvelope.ts", specifier => {
    if (specifier === "./providerSafety.ts") return providerSafety;
    throw new Error(`Unapproved pinned Tencent-envelope import: ${specifier}`);
  });
  const logPayloadFunctions = loadExtractedPinnedDeclarations(
    ["src/lib/logPayloads.ts"],
    ["normalizePayloadForLog"],
    specifier => { throw new Error(`Unapproved pinned log-payload import: ${specifier}`); },
  );
  const errorHelpers = loadPinnedModule("open-sse/utils/error.ts", specifier => {
    if (specifier === "./cors.ts") return cors;
    if (specifier === "./clinepassEnvelope.ts") return clinepass;
    if (specifier === "./tencentEnvelope.ts") return tencent;
    if (specifier === "./providerSafety.ts") return providerSafety;
    if (specifier === "./errorSanitization.ts") return sanitization;
    if (specifier === "../config/errorConfig.ts") return errorConfig;
    if (specifier === "@/lib/logPayloads") return logPayloadFunctions;
    if (specifier === "./upstreamErrorPassthrough.ts") return passthrough;
    if (specifier === "@/shared/utils/featureFlags") return { isFeatureFlagEnabled: () => false };
    if (specifier === "./retryAfterInstant.ts") return retryAfter;
    if (specifier === "./proseRetryDelay.ts") return proseRetry;
    if (specifier === "../services/retryAfterJson.ts") return retryAfterJson;
    throw new Error(`Unapproved pinned error-module import: ${specifier}`);
  });
  const routeRequireManagementAuth = { requireManagementAuth: authorization.requireManagementAuth };
  const nextResponse = { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) };
  const routeRequire = (specifier: string): unknown => {
    if (specifier === "next/server") return { NextResponse: nextResponse };
    if (specifier === "@/lib/api/requireManagementAuth") return routeRequireManagementAuth;
    if (specifier === "@/shared/validation/schemas") return schemas;
    if (specifier === "@/shared/validation/helpers") return validation;
    if (specifier === "@omniroute/open-sse/utils/error") return errorHelpers;
    if (specifier === "@/lib/db/interceptionRules") return interceptionPersistence;
    if (specifier === "@/lib/db/paramFilters") return paramFilterPersistence;
    throw new Error(`Unapproved pinned provider-configuration route import: ${specifier}`);
  };
  const interception = loadPinnedModule(
    "src/app/api/providers/[id]/interception-rules/route.ts",
    routeRequire,
  );
  const paramFilters = loadPinnedModule(
    "src/app/api/providers/[id]/param-filters/route.ts",
    routeRequire,
  );

  return {
    interception: interception as ProviderConfigRoute,
    paramFilters: paramFilters as ProviderConfigRoute,
    getInterceptionRules: requiredFunction(interceptionPersistence, "getInterceptionRules"),
    getParamFilterConfig: requiredFunction(paramFilterPersistence, "getParamFilterConfig"),
  };
}
