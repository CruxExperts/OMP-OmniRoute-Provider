import { Database } from "bun:sqlite";
import { operationContractTemplate, operationEvidenceBinding } from "../../scripts/generate-contracts.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { fixtureRegistry } from "./admin-qualification.fixture.ts";
import {
  createPinnedManagementAuthorization,
  loadExtractedPinnedDeclarations,
  loadPinnedModule,
  readPinnedSource,
  type PinnedExports,
  type PinnedManagementAuthorization,
} from "./pinned-handler.fixture.ts";

export const PROVIDER_CC_ALIAS_OPERATION_IDS = [
  "GET /api/providers/{id}/cc-alias",
  "PUT /api/providers/{id}/cc-alias",
] as const;

export type ProviderCcAliasOperationId = typeof PROVIDER_CC_ALIAS_OPERATION_IDS[number];

type ProviderCcAliasContract = OperationSourceContract;

const ALIAS_VALUE_SCHEMA: JsonSchema = { type: ["string", "null"], enum: ["on", "off", null] };
const ALIAS_RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["provider", "models"],
  properties: {
    provider: ALIAS_VALUE_SCHEMA,
    models: { type: "object", "x-key-role": "identifier", additionalProperties: { type: "string", enum: ["on", "off"] } },
  },
  additionalProperties: false,
};
const SUCCESS_RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["success"],
  properties: { success: { type: "boolean", const: true } },
  additionalProperties: false,
};
const ERROR_RESPONSE_SCHEMA: JsonSchema = { type: "object" };
const UPDATE_REQUEST_SCHEMA: JsonSchema = {
  oneOf: [
    {
      type: "object",
      required: ["scope", "value"],
      properties: { scope: { type: "string", const: "provider" }, value: ALIAS_VALUE_SCHEMA },
      additionalProperties: false,
    },
    {
      type: "object",
      required: ["scope", "modelId", "value"],
      properties: {
        scope: { type: "string", const: "model" },
        modelId: { type: "string", minLength: 1, maxLength: 200 },
        value: ALIAS_VALUE_SCHEMA,
      },
      additionalProperties: false,
    },
  ],
};

function managementAuth(
  template: ProviderCcAliasContract,
  minimumScope: "read" | "admin",
): ProviderCcAliasContract["auth"] {
  return {
    domain: "management",
    specificationAlternatives: template.auth.specificationAlternatives,
    sourcePolicy: {
      status: "qualified",
      source: "omniroute-v3.8.52",
      routeClass: "management",
      localOnly: false,
      handlerGuard: "requireManagementAuth",
      bootstrap: "none",
      alternatives: [
        { kind: "management-api-key", anyOf: ["manage", "admin"] },
        { kind: "dashboard-session" },
        { kind: "auth-disabled", when: "central-and-handler-auth-not-required" },
        { kind: "oma-access-token", minimumScope },
        { kind: "trusted-local", loopbackOnly: true },
      ],
    },
  };
}

function responseContract(
  template: ProviderCcAliasContract["response"],
  statusCodes: readonly string[],
  successSchema: JsonSchema,
  successStatus: string,
): ProviderCcAliasContract["response"] {
  const variants = statusCodes.map(statusCode => {
    const source = template.variants.find(variant => variant.statusCode === statusCode);
    const content = source?.content.length
      ? source.content.map(item => ({ ...item, schema: statusCode === successStatus ? successSchema : item.schema }))
      : [{ mediaType: "application/json", schema: statusCode === successStatus ? successSchema : ERROR_RESPONSE_SCHEMA }];
    return {
      statusCode,
      content,
      headers: source?.headers ?? {},
      ...(source?.sourceFiles === undefined ? {} : { sourceFiles: source.sourceFiles }),
    };
  });
  return { statusCodes: [...statusCodes], mediaType: "application/json", schema: successSchema, variants };
}

function sourceContract(operationId: ProviderCcAliasOperationId): ProviderCcAliasContract {
  const template = operationContractTemplate(operationId) as unknown as ProviderCcAliasContract;
  const read = operationId.startsWith("GET ");
  const request = read
    ? template.request
    : {
        ...template.request,
        body: {
          required: true,
          mediaType: "application/json",
          schema: UPDATE_REQUEST_SCHEMA,
          contentVariants: [{ mediaType: "application/json", schema: UPDATE_REQUEST_SCHEMA }],
        },
        normalizations: [{ section: "body" as const, path: ["modelId"], kind: "trim-string" as const }],
      };
  const body = request.body;
  const requestWithContent = !body ? request : {
    ...request,
    body: {
      ...body,
      contentVariants: [{ mediaType: "application/json", schema: body.schema }],
    },
  };
  const aliasRelation = {
    targetRead: {
      operationId: "GET /api/providers/{id}/cc-alias",
      sourceView: "omniroute-v3.8.52.provider-cc-alias.selected-override" as const,
      inputs: [{ target: { section: "path" as const, field: "id" }, source: { section: "path" as const, path: ["id"] } }],
      snapshot: { kind: "resource" as const, identity: [], state: [] },
    },
    reconcile: {
      operationId: "GET /api/providers/{id}/cc-alias",
      inputs: [{ target: { section: "path" as const, field: "id" }, source: { section: "path" as const, path: ["id"] } }],
      outcome: {
        kind: "matches" as const,
        identityFields: ["providerId", "scope", "modelId"],
        stateFields: ["value"],
        expectedFromInput: [{ name: "value", source: { section: "body" as const, path: ["value"] } }],
      },
    },
  };
  const mutationSafety: ProviderCcAliasContract["mutationSafety"] = read ? null : {
    preflight: {
      kind: "required",
      observations: [{
        name: "selected-provider-cc-alias",
        read: aliasRelation.targetRead,
        readCompleteness: {
          kind: "single-response",
          sourceReason: "The pinned v3.8.52 GET reads the provider override by exact key and every model override in one SQLite query, then returns the provider's complete override map in one response.",
        },
      }],
    },
    reconciliation: { kind: "unknown" },
    settlement: { responseComplete: { statusCodes: [200] }, definiteRejection: null },
  };
  return {
    request: requestWithContent,
    auth: managementAuth(template, read ? "read" : "admin"),
    response: read
      ? responseContract(template.response, ["200", "401", "403", "500", "503"], ALIAS_RESPONSE_SCHEMA, "200")
      : responseContract(template.response, ["200", "400", "401", "403", "500", "503"], SUCCESS_RESPONSE_SCHEMA, "200"),
    secrets: { inputFields: [], outputFields: [] },
    sideEffect: read ? "read" : "mutation",
    pagination: { mode: "none", parameters: [] },
    streaming: { mode: "json", framing: "application/json" },
    confirmation: read
      ? { required: false, reason: "Read-only provider and model alias overrides." }
      : {
          required: true,
          reason: "Writes or clears one provider or model alias override after checking the selected override against the preview. The pinned route has no atomic compare-and-set, so an external writer can still race between the check and PUT; any ambiguous result remains unknown and is never replayed.",
        },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] },
    reconciliation: read ? null : aliasRelation,
    mutationSafety,
  };
}

export const PROVIDER_CC_ALIAS_SOURCE_CONTRACTS = Object.fromEntries(
  PROVIDER_CC_ALIAS_OPERATION_IDS.map(operationId => [operationId, sourceContract(operationId)]),
) as Readonly<Record<ProviderCcAliasOperationId, ProviderCcAliasContract>>;

export function buildProviderCcAliasRegistry() {
  const descriptors = PROVIDER_CC_ALIAS_OPERATION_IDS.map(operationId => {
    const source = getOperation(operationId);
    if (!source) throw new Error(`pinned provider cc-alias operation is absent: ${operationId}`);
    const contract = PROVIDER_CC_ALIAS_SOURCE_CONTRACTS[operationId];
    const binding = operationEvidenceBinding(operationId, contract);
    if (binding.handlerSha256 !== source.source.sha256 || binding.handlerGitBlobSha !== source.source.gitBlobSha) {
      throw new Error(`cc-alias source contract does not match the pinned handler: ${operationId}`);
    }
    const name = operationId.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
    return {
      ...source,
      ...contract,
      mediaType: { request: contract.request.body?.mediaType ?? null, response: contract.response.mediaType },
      coverage: { status: "invokable" as const, adapterId: `typed.fixture.${name}`, reason: null },
    } satisfies OperationDescriptor;
  });
  return fixtureRegistry(descriptors);
}

type RouteContext = { readonly params: Promise<{ readonly id: string }> };
type Handler = (request: Request, context: RouteContext) => Promise<Response>;
type RouteModule = PinnedExports & { readonly GET: Handler; readonly PUT: Handler };

function keyValueTableSql(): string {
  const core = readPinnedSource("src/lib/db/core.ts");
  const schema = /const SCHEMA_SQL = `([\s\S]*?)`;/m.exec(core)?.[1];
  const table = schema && /CREATE TABLE IF NOT EXISTS key_value\s*\([\s\S]*?\n\s*\);/i.exec(schema)?.[0];
  if (!table) throw new Error("Receipt-verified core schema omitted the key_value table");
  return table;
}

function createPinnedAliasRoute(
  database: Database,
  authorization: PinnedManagementAuthorization,
  onCatalogWrite: () => void,
): RouteModule {
  const nextResponse = { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) };
  const featureFlagDefinitions = loadPinnedModule("src/shared/constants/featureFlagDefinitions.ts", () => {
    throw new Error("Pinned feature-flag definitions have no runtime imports");
  });
  const modelCatalogSignals = { finishModelCatalogWriteWithoutBackup: onCatalogWrite };
  const featureFlags = loadPinnedModule("src/lib/db/featureFlags.ts", specifier => {
    if (specifier === "@/shared/constants/featureFlagDefinitions") return featureFlagDefinitions;
    if (specifier === "./core") return { getDbInstance: () => database };
    if (specifier === "./models/modelCatalogWriteSignals") return modelCatalogSignals;
    throw new Error(`Unapproved pinned feature-flag import: ${specifier}`);
  });
  const aliases = loadPinnedModule("src/lib/db/ccDiscoveryAliases.ts", specifier => {
    if (specifier === "./featureFlags") return featureFlags;
    if (specifier === "./core") return { getDbInstance: () => database };
    if (specifier === "./models/modelCatalogWriteSignals") return modelCatalogSignals;
    throw new Error(`Unapproved pinned cc-alias persistence import: ${specifier}`);
  });
  const schemas = loadExtractedPinnedDeclarations(
    ["src/shared/validation/schemas/provider.ts"],
    ["ccAliasSettingValueSchema", "updateCcAliasSettingSchema"],
    specifier => { throw new Error(`Unapproved pinned cc-alias schema import: ${specifier}`); },
  );
  const validation = loadPinnedModule("src/shared/validation/helpers.ts", specifier => {
    if (specifier === "next/server") return { NextResponse: nextResponse };
    throw new Error(`Unapproved pinned validation-helper import: ${specifier}`);
  });
  const auth = { requireManagementAuth: (request: Request) => authorization.requireManagementAuth(request) };
  const pathRedaction = loadPinnedModule("open-sse/utils/errorPathRedaction.ts", () => {
    throw new Error("Pinned error path redaction has no runtime imports");
  });
  const credentialPatterns = loadPinnedModule("open-sse/utils/credentialPatterns.ts", () => {
    throw new Error("Pinned credential patterns have no runtime imports");
  });
  const providerSafety = loadPinnedModule("open-sse/utils/providerSafety.ts", specifier => {
    if (specifier === "./registeredFeatureFlag.ts") return { isRegisteredFeatureFlagEnabled: () => false };
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
    throw new Error("Pinned CORS constants have no runtime imports");
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
  return loadPinnedModule("src/app/api/providers/[id]/cc-alias/route.ts", specifier => {
    if (specifier === "next/server") return { NextResponse: nextResponse };
    if (specifier === "@/lib/db/ccDiscoveryAliases") return aliases;
    if (specifier === "@/lib/api/requireManagementAuth") return auth;
    if (specifier === "@/shared/validation/schemas") return schemas;
    if (specifier === "@/shared/validation/helpers") return validation;
    if (specifier === "@omniroute/open-sse/utils/error") return errorHelpers;
    throw new Error(`Unapproved pinned cc-alias route import: ${specifier}`);
  }) as RouteModule;
}

export class ProviderCcAliasFixture {
  readonly #database = new Database(":memory:");
  readonly #authorization: PinnedManagementAuthorization;
  readonly #routes: RouteModule;
  readonly #server: Bun.Server<undefined>;
  #catalogWriteSignals = 0;
  #failCatalogWriteSignal = false;
  #readFailureState: readonly { key: string; value: string }[] | undefined;

  constructor() {
    this.#database.exec(keyValueTableSql());
    const scopes = new Map<string, readonly string[]>([
      ["fixture-cc-alias-manage", ["manage"]],
      ["fixture-cc-alias-read", ["read"]],
    ]);
    this.#authorization = createPinnedManagementAuthorization({
      isDashboardSession: () => false,
      verifyAccessToken: () => null,
      validateApiKey: key => scopes.has(key),
      getApiKeyMetadata: key => {
        const apiScopes = scopes.get(key);
        return apiScopes ? { id: `fixture-${key}`, scopes: apiScopes } : null;
      },
    });
    this.#routes = createPinnedAliasRoute(this.#database, this.#authorization, () => {
      if (this.#failCatalogWriteSignal) throw new Error("fixture model-catalog signal failed after alias persistence");
      this.#catalogWriteSignals += 1;
    });
    this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => this.#handle(request) });
  }

  get endpoint(): string { return this.#server.url.origin; }

  get catalogWriteSignals(): number { return this.#catalogWriteSignals; }

  failCatalogWriteSignal(): void { this.#failCatalogWriteSignal = true; }

  clearCatalogWriteSignalFailure(): void { this.#failCatalogWriteSignal = false; }

  state(): readonly { key: string; value: string }[] {
    return this.#database.prepare(
      "SELECT key, value FROM key_value WHERE namespace = ? ORDER BY key",
    ).all("ccDiscoveryAliases") as { key: string; value: string }[];
  }

  failAliasWritesWith(message: string): void {
    const quoted = message.replaceAll("'", "''");
    this.#database.exec(`CREATE TRIGGER fixture_cc_alias_write_failure BEFORE INSERT ON key_value
      WHEN NEW.namespace = 'ccDiscoveryAliases'
      BEGIN SELECT RAISE(ABORT, '${quoted}'); END;`);
  }

  clearAliasWriteFailure(): void {
    this.#database.exec("DROP TRIGGER IF EXISTS fixture_cc_alias_write_failure");
  }

  dropStorageForReadFailure(): void {
    this.#readFailureState = this.state();
    this.#database.exec("DROP TABLE key_value");
  }

  restoreStorageAfterReadFailure(): void {
    this.#database.exec(keyValueTableSql());
    for (const row of this.#readFailureState ?? []) {
      this.#database.prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)")
        .run("ccDiscoveryAliases", row.key, row.value);
    }
    this.#readFailureState = undefined;
  }

  close(): void {
    this.#server.stop(true);
    this.#database.close();
  }

  #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const match = /^\/api\/providers\/([^/]+)\/cc-alias$/.exec(url.pathname);
    if (!match) return Promise.resolve(Response.json({ error: "Not found" }, { status: 404 }));
    if (request.method !== "GET" && request.method !== "PUT") {
      return Promise.resolve(Response.json({ error: "Method not allowed" }, { status: 405 }));
    }
    let id: string;
    try { id = decodeURIComponent(match[1]!); }
    catch { return Promise.resolve(Response.json({ error: "Not found" }, { status: 404 })); }
    return this.#authorization.dispatch(
      request,
      { centralAuthRequired: true, handlerAuthRequired: true },
      forwarded => this.#routes[request.method as "GET" | "PUT"](forwarded, { params: Promise.resolve({ id }) }),
    );
  }
}
