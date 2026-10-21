import { createHash } from "node:crypto";
import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { invokeJsonAdapter, type AdapterResponse, type AdminCredential } from "../../src/admin/adapters.ts";
import { canonicalizeJson, getOperation, type JsonSchema, type OperationAdapter, type OperationDescriptor, type OperationResponseVariant } from "../../src/admin/registry.ts";
import type { JsonObject, JsonValue } from "../../src/admin/types.ts";
import { fixtureRegistry } from "./admin-qualification.fixture.ts";
import { FALLBACK_CHAIN_DELETE, FALLBACK_CHAIN_GET, FALLBACK_CHAIN_POST, type FallbackChainMutationOperation } from "../../src/admin/source-fallback-chains.ts";
import { createPinnedManagementAuthorization, loadExtractedPinnedDeclarations, loadPinnedAccessTokenAuth, loadPinnedModule } from "./pinned-handler.fixture.ts";
import type { ManagementAuthFixture } from "./management-auth.fixture.ts";

export { FALLBACK_CHAIN_DELETE, FALLBACK_CHAIN_GET, FALLBACK_CHAIN_POST };

export const FALLBACK_CHAIN_OPERATION_IDS = [FALLBACK_CHAIN_GET, FALLBACK_CHAIN_POST, FALLBACK_CHAIN_DELETE] as const;
export type FallbackChainOperationId = typeof FALLBACK_CHAIN_OPERATION_IDS[number];

export const FALLBACK_CHAIN_ROUTE_SOURCE_FILE = "src/app/api/fallback/chains/route.ts";
const pinnedAuth = loadPinnedAccessTokenAuth(() => null);
export const FALLBACK_CHAIN_AUTH_SOURCE_FILES = [
  "src/proxy.ts",
  "src/server/authz/classify.ts",
  "src/server/authz/pipeline.ts",
  "src/server/authz/policies/management.ts",
  "src/server/authz/accessScopes.ts",
  "src/server/authz/accessTokenAuth.ts",
  "src/server/authz/headers.ts",
  "src/server/authz/peerContext.ts",
  "src/server/authz/peerStamp.ts",
  "src/server/authz/routeGuard.ts",
  "src/server/origin/publicOrigin.ts",
  "src/lib/accessTokens/scopes.ts",
  "src/lib/db/accessTokens.ts",
  "src/lib/db/apiKeys.ts",
  "src/shared/constants/managementScopes.ts",
  "src/shared/constants/publicApiRoutes.ts",
  "src/shared/utils/apiAuth.ts",
  "src/shared/utils/dashboardSessionToken.ts",
  "src/sse/services/auth.ts",
] as const;

const FALLBACK_CHAIN_ROUTE = "/api/fallback/chains";

interface PinnedFallbackPolicy {
  getAllFallbackChains(): Record<string, unknown>;
  registerFallback(model: string, chain: readonly { provider: string; priority?: number; enabled?: boolean }[]): void;
  removeFallback(model: string): boolean;
}

const CHAIN_ENTRY_SCHEMA: JsonSchema = {
  type: "object",
  required: ["provider", "priority", "enabled"],
  properties: {
    provider: { type: "string", minLength: 1 },
    priority: { type: "integer", minimum: 0 },
    enabled: { type: "boolean" },
  },
  // The handler returns persisted chain entries verbatim; the adapter still
  // projects only provider, priority, and enabled from each entry.
  additionalProperties: true,
};

const CHAIN_MAP_SCHEMA: JsonSchema = {
  type: "object",
  "x-key-role": "identifier",
  additionalProperties: { type: "array", items: CHAIN_ENTRY_SCHEMA },
};

const GET_SUCCESS_SCHEMA = CHAIN_MAP_SCHEMA;
const POST_SUCCESS_SCHEMA: JsonSchema = {
  type: "object",
  required: ["success", "model"],
  properties: { success: { type: "boolean", const: true }, model: { type: "string", minLength: 1, maxLength: 200 } },
  additionalProperties: false,
};
const DELETE_SUCCESS_SCHEMA: JsonSchema = {
  type: "object",
  required: ["success", "removed"],
  properties: { success: { type: "boolean", const: true }, removed: { type: "boolean" } },
  additionalProperties: false,
};
const VALIDATION_DETAIL_SCHEMA: JsonSchema = {
  type: "object",
  required: ["field", "message"],
  properties: { field: { type: "string" }, message: { type: "string" }, keys: { type: "array", items: { type: "string" } } },
  additionalProperties: false,
};
const AUTH_ERROR_SCHEMA: JsonSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["code", "message", "correlation_id"],
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        correlation_id: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};
const ROUTE_ERROR_SCHEMA: JsonSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      oneOf: [
        { type: "string" },
        {
          type: "object",
          required: ["message", "details"],
          properties: { message: { type: "string" }, details: { type: "array", items: VALIDATION_DETAIL_SCHEMA } },
          additionalProperties: false,
        },
      ],
    },
  },
  additionalProperties: false,
};
function objectSchema(properties: Record<string, JsonSchema>, required: readonly string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: true };
}

function bodyRequest(
  base: OperationSourceContract["request"],
  schema: JsonSchema,
  normalizations: NonNullable<OperationSourceContract["request"]["normalizations"]>,
  sourceValidator: NonNullable<OperationSourceContract["request"]["sourceValidator"]>,
): OperationSourceContract["request"] {
  const template = base.body;
  return {
    ...base,
    body: {
      required: true,
      mediaType: "application/json",
      schema,
      contentVariants: template?.contentVariants.map(content => ({ ...content, schema })) ?? [{ mediaType: "application/json", schema }],
    },
    normalizations,
    sourceValidator,
  };
}

function operationAuth(base: OperationSourceContract["auth"], operationId: FallbackChainOperationId): OperationSourceContract["auth"] {
  const method = operationId.slice(0, operationId.indexOf(" "));
  return {
    domain: "management",
    specificationAlternatives: base.specificationAlternatives,
    sourcePolicy: {
      status: "qualified",
      source: "omniroute-v3.8.52",
      routeClass: "management",
      localOnly: false,
      handlerGuard: "none",
      bootstrap: "none",
      alternatives: [
        { kind: "auth-disabled", when: "central-and-handler-auth-not-required" },
        { kind: "management-api-key", anyOf: ["manage", "admin"] },
        { kind: "dashboard-session" },
        { kind: "oma-access-token", minimumScope: pinnedAuth.inferRequiredScope(method, "/api/fallback/chains") },
        { kind: "trusted-local", loopbackOnly: true },
      ],
    },
  };
}

function responseContract(
  base: OperationSourceContract["response"],
  successSchema: JsonSchema,
): OperationSourceContract["response"] {
  const success = { oneOf: [successSchema, ROUTE_ERROR_SCHEMA, AUTH_ERROR_SCHEMA] } satisfies JsonSchema;
  const variants: OperationResponseVariant[] = base.variants.map(variant => ({
    ...variant,
    content: variant.content.map(content => ({
      ...content,
      schema: variant.statusCode === "200"
        ? successSchema
        : ["401", "403", "503"].includes(variant.statusCode)
          ? AUTH_ERROR_SCHEMA
          : ROUTE_ERROR_SCHEMA,
    })),
  }));
  return { ...base, schema: success, variants };
}

function reconciliation(operationId: FallbackChainMutationOperation): OperationSourceContract["reconciliation"] {
  const commonTarget = {
    operationId: FALLBACK_CHAIN_GET,
    inputs: [],
    snapshot: {
      kind: "resource" as const,
      identity: [{ name: "model", path: ["model"] }],
      state: [{ name: "chain", path: ["chain"] }],
    },
  };
  if (operationId === FALLBACK_CHAIN_POST) {
    return {
      targetRead: { ...commonTarget, sourceView: "omniroute-v3.8.52.fallback-chains.reconciliation" },
      reconcile: {
        operationId: FALLBACK_CHAIN_GET,
        inputs: [],
        outcome: {
          kind: "upsert",
          identityFields: ["model"],
          stateFields: ["chain"],
          expectedFromInput: [{ name: "chain", source: { section: "body", path: ["chain"] } }],
        },
      },
    };
  }
  return {
    targetRead: { ...commonTarget, sourceView: "omniroute-v3.8.52.fallback-chains.reconciliation" },
    reconcile: {
      operationId: FALLBACK_CHAIN_GET,
      inputs: [],
      outcome: { kind: "absent", identityFields: ["model"], stateFields: [] },
    },
  };
}

function createSourceContract(operationId: FallbackChainOperationId): OperationSourceContract {
  const base = operationContractTemplate(operationId) as unknown as OperationSourceContract;
  if (operationId === FALLBACK_CHAIN_GET) {
    return {
      ...base,
      auth: operationAuth(base.auth, operationId),
      sideEffect: "read",
      streaming: { mode: "json", framing: "application/json" },
      confirmation: { required: false, reason: "Source-defined ordinary read; central management authorization remains enforced." },
      retry: { allowed: false, maxAttempts: 1, statusCodes: [] },
      response: responseContract(base.response, GET_SUCCESS_SCHEMA),
      reconciliation: null,
      mutationSafety: null,
    };
  }

  const modelSchema: JsonSchema = {
    type: "string", minLength: 1, maxLength: 200,
    // The source GET cannot expose this model's current state after trim normalization.
    pattern: "^(?!\\s*__proto__\\s*$)[\\s\\S]+$",
  };
  const modelNormalization = [{ section: "body" as const, path: ["model"], kind: "trim-string" as const }];
  const requestSchema = operationId === FALLBACK_CHAIN_POST
    ? objectSchema({
      model: modelSchema,
      chain: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          required: ["provider"],
          properties: {
            provider: { type: "string", minLength: 1, pattern: "\\S" },
            priority: { type: "integer", minimum: 1, maximum: 100 },
            enabled: { type: "boolean" },
          },
          additionalProperties: true,
        },
      },
    }, ["model", "chain"])
    : objectSchema({ model: modelSchema }, ["model"]);
  const targetRead = reconciliation(operationId)?.targetRead;
  if (!targetRead) throw new Error(`fallback-chain preflight view is missing: ${operationId}`);
  return {
    ...base,
    request: bodyRequest(
      base.request,
      requestSchema,
      modelNormalization,
      operationId === FALLBACK_CHAIN_POST
        ? "omniroute-v3.8.52.fallback-chains.register"
        : "omniroute-v3.8.52.fallback-chains.remove",
    ),
    auth: operationAuth(base.auth, operationId),
    sideEffect: "mutation",
    streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: true, reason: "Human confirmation is required before replacing or removing a model-keyed fallback chain." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] },
    response: responseContract(base.response, operationId === FALLBACK_CHAIN_POST ? POST_SUCCESS_SCHEMA : DELETE_SUCCESS_SCHEMA),
    reconciliation: reconciliation(operationId),
    mutationSafety: {
      preflight: {
        kind: "required",
        visibilityLimits: [
          "The server exposes its in-memory fallback map. This read cannot reveal direct database writes or another process's map, or prove persistence.",
          "The server can silently fail persistence after changing its runtime map. Even a normal success reply leaves this mutation outcome unknown; it will not be replayed automatically.",
          "Another client can change the selected chain after the final read; the server provides no atomic conditional write.",
        ],
        observations: [{
          name: "runtime-model-chain",
          read: targetRead,
          readCompleteness: {
            kind: "single-response",
            sourceReason: "Pinned GET returns the complete in-memory fallback map in one response; it does not prove SQLite durability.",
          },
        }],
      },
      reconciliation: { kind: "unknown" },
      settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null },
    },
  };
}

export const FALLBACK_CHAIN_SOURCE_CONTRACTS: Readonly<Record<FallbackChainOperationId, OperationSourceContract>> = Object.freeze({
  [FALLBACK_CHAIN_GET]: createSourceContract(FALLBACK_CHAIN_GET),
  [FALLBACK_CHAIN_POST]: createSourceContract(FALLBACK_CHAIN_POST),
  [FALLBACK_CHAIN_DELETE]: createSourceContract(FALLBACK_CHAIN_DELETE),
});

export interface FallbackChainFixtureCounts {
  readonly get: number;
  readonly post: number;
  readonly delete: number;
  readonly saves: number;
  readonly deletes: number;
  readonly loads: number;
}

export interface FallbackChainFixtureState {
  readonly runtime: JsonValue;
  readonly durable: JsonValue;
}

export interface FallbackChainsHttpFixtureOptions {
  readonly persisted?: Readonly<Record<string, unknown>>;
  readonly auth: ManagementAuthFixture;
  readonly apiKeys?: Readonly<Record<string, readonly string[]>>;
  readonly accessTokens?: readonly { readonly secret: string; readonly id: string; readonly name: string; readonly scope: "read" | "write" | "admin" }[];
  readonly loopbackCliToken?: string;
  readonly dashboardCookies?: readonly string[];
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function safePublicEntries(value: unknown): JsonValue {
  if (!Array.isArray(value)) return [];
  const rows: JsonValue[] = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const entry: JsonObject = {};
    if (typeof record.provider === "string") entry.provider = record.provider;
    if (typeof record.priority === "number" && Number.isFinite(record.priority)) entry.priority = record.priority;
    if (typeof record.enabled === "boolean") entry.enabled = record.enabled;
    rows.push(entry);
  }
  return rows;
}

function safePublicMap(map: ReadonlyMap<string, unknown>): JsonValue {
  return Object.fromEntries([...map.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([model, value]) => [model, safePublicEntries(value)]));
}

/** Source-faithful loopback boundary for the exact pinned fallback-chain Next route. */
export class FallbackChainsHttpFixture {
  readonly #server: { readonly url: URL; stop(closeActiveConnections?: boolean): void };
  readonly #auth: ManagementAuthFixture;
  readonly #accessTokens: ReadonlyMap<string, { readonly id: string; readonly name: string; readonly scope: "read" | "write" | "admin" }>;
  readonly #apiKeys: ReadonlyMap<string, readonly string[]>;
  readonly #loopbackCliToken: string | undefined;
  readonly #dashboardCookies: ReadonlySet<string>;
  readonly #authorization: ReturnType<typeof createPinnedManagementAuthorization>;
  readonly #durable = new Map<string, unknown>();
  readonly #policy: PinnedFallbackPolicy;
  #readRuntime: () => Record<string, unknown> = () => ({});
  readonly #handlers: Record<string, (request: Request) => Response | Promise<Response>>;
  readonly #failHandler = new Set<string>();
  #failNextLoad = false;
  #failNextSave = false;
  #failNextDelete = false;
  #getCount = 0;
  #postCount = 0;
  #deleteCount = 0;
  #saveCount = 0;
  #deletePersistCount = 0;
  #loadCount = 0;

  constructor(options: FallbackChainsHttpFixtureOptions) {
    for (const [model, chain] of Object.entries(options.persisted ?? {})) this.#durable.set(model, clone(chain));
    this.#auth = options.auth;
    this.#accessTokens = new Map((options.accessTokens ?? []).map(record => [record.secret, { id: record.id, name: record.name, scope: record.scope }]));
    this.#apiKeys = new Map(Object.entries(options.apiKeys ?? {}));
    this.#loopbackCliToken = options.loopbackCliToken;
    this.#dashboardCookies = new Set(options.dashboardCookies ?? []);
    this.#authorization = createPinnedManagementAuthorization({
      isDashboardSession: token => this.#dashboardCookies.has(token)
        || [...this.#dashboardCookies].some(cookie => cookie.split(";").some(segment => segment.trim() === `auth_token=${token}`)),
      verifyAccessToken: token => {
        if (this.#auth.failVerification) throw new Error("fixture token database unavailable");
        return this.#accessTokens.get(token) ?? null;
      },
      validateApiKey: key => this.#apiKeys.has(key),
      getApiKeyMetadata: key => {
        const scopes = this.#apiKeys.get(key);
        return scopes ? { id: `fixture-${key}`, scopes: [...scopes] } : null;
      },
      ...(this.#loopbackCliToken === undefined ? {} : { loopbackCliToken: this.#loopbackCliToken }),
    });
    this.#policy = this.#createPinnedPolicy();
    this.#handlers = this.#createPinnedHandlers();
    this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => this.#handle(request) });
  }

  get endpoint(): string {
    return this.#server.url.origin;
  }

  get counts(): FallbackChainFixtureCounts {
    return {
      get: this.#getCount,
      post: this.#postCount,
      delete: this.#deleteCount,
      saves: this.#saveCount,
      deletes: this.#deletePersistCount,
      loads: this.#loadCount,
    };
  }

  get state(): FallbackChainFixtureState {
    const runtime = this.#readRuntime();
    return { runtime: safePublicMap(new Map(Object.entries(runtime))), durable: safePublicMap(this.#durable) };
  }

  get durableSnapshot(): Readonly<Record<string, unknown>> {
    return Object.fromEntries([...this.#durable.entries()].map(([model, value]) => [model, clone(value)]));
  }

  failNextRoute(method: "GET" | "POST" | "DELETE"): void {
    this.#failHandler.add(method);
  }

  failNextDatabaseLoad(): void {
    this.#failNextLoad = true;
  }

  failNextDatabaseSave(): void {
    this.#failNextSave = true;
  }

  failNextDatabaseDelete(): void {
    this.#failNextDelete = true;
  }

  async close(): Promise<void> {
    this.#server.stop(true);
  }

  #consumeHandlerFailure(method: string): boolean {
    if (!this.#failHandler.has(method)) return false;
    this.#failHandler.delete(method);
    return true;
  }

  #loadAllFallbackChains(): Record<string, unknown> {
    this.#loadCount += 1;
    if (this.#failNextLoad) {
      this.#failNextLoad = false;
      throw new Error("fixture database read failed");
    }
    return Object.fromEntries([...this.#durable.entries()].map(([model, chain]) => [model, clone(chain)]));
  }

  #saveFallbackChain(model: string, chain: readonly unknown[]): void {
    this.#saveCount += 1;
    if (this.#failNextSave) {
      this.#failNextSave = false;
      throw new Error("fixture database write failed");
    }
    this.#durable.set(model, clone(chain));
  }

  #deleteFallbackChain(model: string): boolean {
    this.#deletePersistCount += 1;
    if (this.#failNextDelete) {
      this.#failNextDelete = false;
      throw new Error("fixture database delete failed");
    }
    const removed = this.#durable.has(model);
    this.#durable.delete(model);
    return removed;
  }

  #createPinnedPolicy(): PinnedFallbackPolicy {
    const domainState = {
      loadAllFallbackChains: () => this.#loadAllFallbackChains(),
      saveFallbackChain: (model: string, chain: readonly unknown[]) => this.#saveFallbackChain(model, chain),
      deleteFallbackChain: (model: string) => this.#deleteFallbackChain(model),
      loadFallbackChain: () => null,
      deleteAllFallbackChains: () => { this.#durable.clear(); },
    };
    const policy = loadPinnedModule("src/domain/fallbackPolicy.ts", specifier => {
      if (specifier === "../lib/db/domainState") return domainState;
      throw new Error(`Unapproved pinned fallback-policy import: ${specifier}`);
    });
    const getAll = policy.getAllFallbackChains;
    const register = policy.registerFallback;
    const remove = policy.removeFallback;
    if (typeof getAll !== "function" || typeof register !== "function" || typeof remove !== "function") {
      throw new Error("Pinned fallback policy omitted expected exports");
    }
    this.#readRuntime = getAll as () => Record<string, unknown>;
    return {
      getAllFallbackChains: () => {
        if (this.#consumeHandlerFailure("GET")) throw new Error("fixture route read failed");
        return getAll();
      },
      registerFallback: (model, chain) => {
        if (this.#consumeHandlerFailure("POST")) throw new Error("fixture route register failed");
        return register(model, chain);
      },
      removeFallback: model => {
        if (this.#consumeHandlerFailure("DELETE")) throw new Error("fixture route remove failed");
        return remove(model);
      },
    };
  }

  #createPinnedHandlers(): Record<string, (request: Request) => Response | Promise<Response>> {
    const schemas = loadExtractedPinnedDeclarations(
      ["src/shared/validation/schemas/misc.ts", "src/shared/validation/schemas/routing.ts"],
      ["modelIdSchema", "fallbackChainEntrySchema", "registerFallbackSchema", "removeFallbackSchema"],
      () => { throw new Error("Fallback schema extraction has no non-Zod runtime imports"); },
    );
    const validation = loadPinnedModule("src/shared/validation/helpers.ts", specifier => {
      if (specifier === "next/server") return { NextResponse: { json: Response.json.bind(Response) } };
      throw new Error(`Unapproved pinned validation-helper import: ${specifier}`);
    });
    const route = loadPinnedModule("src/app/api/fallback/chains/route.ts", specifier => {
      if (specifier === "next/server") return { NextResponse: { json: Response.json.bind(Response) } };
      if (specifier === "@/domain/fallbackPolicy") return this.#policy;
      if (specifier === "@/shared/validation/schemas") return schemas;
      if (specifier === "@/shared/validation/helpers") return validation;
      throw new Error(`Unapproved pinned fallback-route import: ${specifier}`);
    });
    const handlers: Record<string, (request: Request) => Response | Promise<Response>> = {};
    for (const method of ["GET", "POST", "DELETE"] as const) {
      const handler = route[method];
      if (typeof handler !== "function") throw new Error(`Pinned fallback route omitted ${method}`);
      handlers[method] = handler as (request: Request) => Response | Promise<Response>;
    }
    return handlers;
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== FALLBACK_CHAIN_ROUTE) return json({ error: "Not found" }, 404);

    if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") return json({ error: "Method not allowed" }, 405);
    const handler = this.#handlers[request.method];
    if (!handler) return json({ error: "Method not allowed" }, 405);
    return await this.#authorization.dispatch(request, {
      centralAuthRequired: this.#auth.authRequired,
      handlerAuthRequired: this.#auth.authRequired,
    }, async forwardedRequest => {
      if (request.method === "GET") this.#getCount += 1;
      else if (request.method === "POST") this.#postCount += 1;
      else this.#deleteCount += 1;
      return await handler(forwardedRequest);
    });
  }
}

export function buildFallbackChainFixtureRegistry() {
  const descriptors: OperationDescriptor[] = FALLBACK_CHAIN_OPERATION_IDS.map(operationId => {
    const source = getOperation(operationId);
    if (!source) throw new Error(`pinned fallback-chain operation is absent: ${operationId}`);
    const contract = FALLBACK_CHAIN_SOURCE_CONTRACTS[operationId];
    const name = operationId.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
    return {
      ...source,
      ...contract,
      mediaType: {
        request: contract.request.body?.mediaType ?? null,
        response: contract.response.mediaType,
      },
      coverage: { status: "invokable", adapterId: `typed.fixture.${name}`, reason: null },
    };
  });
  return fixtureRegistry(descriptors);
}

export function fallbackChainAdapterDescriptor(adapter: OperationAdapter) {
  const descriptor = adapter.descriptor;
  return {
    operationId: descriptor.operationId,
    adapterId: adapter.adapterId,
    method: descriptor.method,
    pathTemplate: descriptor.pathTemplate,
    mediaType: descriptor.mediaType,
    request: { pathParameters: descriptor.request.pathParameters, body: descriptor.request.body },
    streaming: descriptor.streaming,
    auth: { domain: descriptor.auth.domain },
    coverage: { status: "invokable" as const },
  };
}

export async function invokeFallbackChainAdapter(
  adapter: OperationAdapter,
  fixture: FallbackChainsHttpFixture,
  credential: AdminCredential,
  input: unknown,
): Promise<AdapterResponse> {
  const validated = adapter.validate(input);
  return invokeJsonAdapter({
    descriptor: fallbackChainAdapterDescriptor(adapter),
    endpoint: fixture.endpoint,
    credential,
    resolvedPath: adapter.buildPath(validated),
    queryParameters: adapter.buildQuery(validated),
    ...(validated.body === undefined ? {} : { body: validated.body }),
  });
}

export function fallbackChainEvidenceDigest(value: unknown): string {
  return createHash("sha256").update(canonicalizeJson(value)).digest("hex");
}
