import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import type { JsonSchema, OperationDescriptor } from "../../src/admin/registry.ts";
import type { ManagementAuthFixture } from "./management-auth.fixture.ts";
import { sourceHasNoAuthProvider, sourceProviderAllowsOptionalApiKey } from "../../src/admin/source-validation.ts";
import { hydrateSourceCompatibleProviderCreation } from "../../src/admin/source-normalization.ts";

type ProviderFamilyContract = Pick<OperationDescriptor,
  "request" | "auth" | "response" | "secrets" | "sideEffect" | "pagination" | "streaming" | "confirmation" | "retry" | "reconciliation">;

export const PROVIDER_FAMILY_OPERATION_IDS = [
  "GET /api/providers",
  "POST /api/providers",
  "PATCH /api/providers",
  "DELETE /api/providers",
  "GET /api/providers/{id}/cc-alias",
  "PUT /api/providers/{id}/cc-alias",
] as const;

const EMPTY_OBJECT_SCHEMA: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
const ERROR_BODY_SCHEMA: JsonSchema = { type: "object" };
const CONNECTION_SCHEMA: JsonSchema = {
  type: "object",
  required: ["id", "provider", "name", "isActive"],
  properties: {
    id: { type: "string", minLength: 1 },
    provider: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    isActive: { type: "boolean" },
  },
  additionalProperties: false,
};
const LIST_CONNECTION_SCHEMA: JsonSchema = {
  ...CONNECTION_SCHEMA,
  required: ["id", "provider", "name", "isActive", "syncedModelsAt", "rateLimitAutoProtected"],
  properties: {
    ...(CONNECTION_SCHEMA.properties ?? {}),
    syncedModelsAt: { type: ["string", "null"] },
    rateLimitAutoProtected: { type: "boolean" },
  },
};
const CONNECTION_COLLECTION_SCHEMA: JsonSchema = {
  type: "object",
  required: ["connections", "total"],
  properties: {
    connections: { type: "array", items: LIST_CONNECTION_SCHEMA },
    total: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
};
const BOOLEAN_UPDATE_RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["message", "updated", "notFound"],
  properties: {
    message: { type: "string" },
    updated: { type: "integer", minimum: 0 },
    notFound: { type: "array", items: { type: "string" } },
  },
  additionalProperties: false,
};
const DELETE_RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["message", "deleted"],
  properties: {
    message: { type: "string" },
    deleted: { type: "integer", minimum: 0 },
  },
  additionalProperties: false,
};
const PROVIDER_CREATE_RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["connection"],
  properties: { connection: CONNECTION_SCHEMA },
  additionalProperties: false,
};
const CC_ALIAS_RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["provider", "models"],
  properties: {
    provider: { type: ["string", "null"], enum: ["on", "off", null] },
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

function objectSchema(properties: Record<string, JsonSchema>, required: readonly string[]): JsonSchema {
  return { type: "object", properties, required, additionalProperties: false };
}

function responseContract(
  base: ProviderFamilyContract["response"],
  successStatus: string,
  successSchema: JsonSchema,
  statuses: readonly string[],
): ProviderFamilyContract["response"] {
  const variants = statuses.map(statusCode => {
    const documented = base.variants.find(variant => variant.statusCode === statusCode);
    const documentedContent = documented?.content ?? [];
    const content = documentedContent.length > 0
      ? documentedContent.map(item => ({
        mediaType: item.mediaType,
        schema: statusCode === successStatus ? successSchema : item.schema,
        ...(item.sourceFile === undefined ? {} : { sourceFile: item.sourceFile }),
      }))
      : [{ mediaType: "application/json", schema: statusCode === successStatus ? successSchema : null }];
    return {
      statusCode,
      content,
      headers: documented?.headers ?? {},
      ...(documented?.sourceFiles === undefined ? {} : { sourceFiles: documented.sourceFiles }),
    };
  });
  return {
    statusCodes: [...statuses],
    mediaType: "application/json",
    schema: successSchema,
    variants,
  };
}

function managementAuth(template: ProviderFamilyContract, scope: "read" | "admin"): ProviderFamilyContract["auth"] {
  return {
    domain: "management",
    specificationAlternatives: template.auth.specificationAlternatives,
    sourcePolicy: {
      status: "qualified", source: "omniroute-v3.8.52", routeClass: "management",
      localOnly: false, handlerGuard: "requireManagementAuth", bootstrap: "none",
      alternatives: [
        { kind: "management-api-key", anyOf: ["manage", "admin"] },
        { kind: "dashboard-session" },
        { kind: "auth-disabled", when: "central-and-handler-auth-not-required" },
        { kind: "oma-access-token", minimumScope: scope },
        { kind: "trusted-local", loopbackOnly: true },
      ],
    },
  };
}

function jsonBodyRequest(
  base: ProviderFamilyContract["request"],
  schema: JsonSchema,
  normalizations = base.normalizations,
): ProviderFamilyContract["request"] {
  return {
    ...base,
    body: {
      required: true,
      mediaType: "application/json",
      schema,
      contentVariants: [{ mediaType: "application/json", schema }],
    },
    ...(normalizations === undefined ? {} : { normalizations }),
  };
}

function createSourceReviewedContract(operationId: typeof PROVIDER_FAMILY_OPERATION_IDS[number]): ProviderFamilyContract {
  const template = operationContractTemplate(operationId) as unknown as ProviderFamilyContract;
  const authScope = operationId.startsWith("GET ") ? "read" : "admin";
  const common = {
    request: template.request,
    auth: managementAuth(template, authScope),
    streaming: { mode: "json" as const, framing: "application/json" },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] },
  };

  switch (operationId) {
    case "GET /api/providers": {
      const queryProperties = {
        provider: { type: "string" },
        limit: { type: "integer", minimum: 1 },
        offset: { type: "integer", minimum: 0 },
      } satisfies Record<string, JsonSchema>;
      const parameters = template.request.parameters;
      return {
        ...common,
        request: {
          ...template.request,
          querySchema: { type: "object", properties: queryProperties, additionalProperties: false },
          parameters,
          normalizations: [{ section: "query", path: ["provider"], kind: "trim-string" }],
        },
        response: responseContract(template.response, "200", CONNECTION_COLLECTION_SCHEMA, ["200", "401", "403", "500", "503"]),
        secrets: { inputFields: [], outputFields: [] },
        sideEffect: "read",
        pagination: { mode: "offset", parameters: ["limit", "offset"] },
        confirmation: { required: false, reason: "Read-only provider inventory; secret-bearing source fields are omitted by the response projection." },
        reconciliation: null,
      };
    }
    case "POST /api/providers": {
      // The source record accepts arbitrary JSON values; the executor bounds body size/depth and this entire field is secret-redacted.
      const providerDataValue: JsonSchema = {};
      const createSchema = objectSchema({
        provider: { type: "string", minLength: 1, maxLength: 100 },
        name: { type: "string", minLength: 1, maxLength: 200 },
        apiKey: { type: "string", maxLength: 100_000 },
        allowNoCredential: { type: "boolean", const: true },
        // The source inspects this raw legacy field for cloudflare-ai and returns
        // a route-level 400 directing callers to providerSpecificData.accountId.
        accountId: {},
        priority: { type: "integer", minimum: 1, maximum: 100 },
        globalPriority: { type: ["integer", "null"], minimum: 1, maximum: 100 },
        defaultModel: { type: ["string", "null"], maxLength: 200 },
        testStatus: { type: "string", maxLength: 50 },
        providerSpecificData: { type: "object", additionalProperties: providerDataValue },
      }, ["provider", "name"]);
      return {
        ...common,
        request: { ...jsonBodyRequest(template.request, createSchema), sourceValidator: "omniroute-v3.8.52.provider-create" },
        response: responseContract(template.response, "201", PROVIDER_CREATE_RESPONSE_SCHEMA, ["201", "400", "401", "403", "404", "410", "500", "503"]),
        secrets: { inputFields: ["apiKey", "providerSpecificData"], outputFields: [] },
        sideEffect: "mutation",
        pagination: { mode: "none", parameters: [] },
        confirmation: {
          required: true,
          reason: "Creates persistent provider credentials and starts the source's asynchronous connection test; a lost response cannot be reconciled to a unique pre-dispatch identity, so one human-approved attempt may end unknown and is never replayed.",
        },
        reconciliation: null,
      };
    }
    case "PATCH /api/providers": {
      const patchSchema = objectSchema({
        ids: { type: "array", items: { type: "string", minLength: 1 }, minItems: 1, maxItems: 100 },
        isActive: { type: "boolean" },
      }, ["ids", "isActive"]);
      const collectionRelation = {
        targetRead: {
          operationId: "GET /api/providers",
          inputs: [],
          snapshot: {
            kind: "collection" as const,
            collectionPath: ["connections"],
            identity: [{ name: "id", path: ["id"] }],
            state: [{ name: "provider", path: ["provider"] }, { name: "isActive", path: ["isActive"] }],
            selection: { input: { section: "body" as const, path: ["ids"] }, rowPath: ["id"] },
          },
        },
        reconcile: {
          operationId: "GET /api/providers",
          inputs: [],
          outcome: {
            kind: "matches" as const,
            identityFields: ["id"],
            stateFields: ["provider", "isActive"],
            expectedFromInput: [{ name: "isActive", source: { section: "body" as const, path: ["isActive"] } }],
          },
        },
      };
      return {
        ...common,
        request: jsonBodyRequest(template.request, patchSchema, template.request.normalizations),
        response: responseContract(template.response, "200", BOOLEAN_UPDATE_RESPONSE_SCHEMA, ["200", "400", "401", "403", "410", "500", "503"]),
        secrets: { inputFields: [], outputFields: [] },
        sideEffect: "mutation",
        pagination: { mode: "none", parameters: [] },
        confirmation: { required: true, reason: "Bulk activation changes provider routing availability; apply requires explicit human confirmation." },
        reconciliation: collectionRelation,
      };
    }
    case "DELETE /api/providers": {
      const deleteSchema = objectSchema({
        ids: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 100 },
      }, ["ids"]);
      const collectionRelation = {
        targetRead: {
          operationId: "GET /api/providers",
          inputs: [],
          snapshot: {
            kind: "collection" as const,
            collectionPath: ["connections"],
            identity: [{ name: "id", path: ["id"] }],
            state: [{ name: "provider", path: ["provider"] }, { name: "isActive", path: ["isActive"] }],
            selection: { input: { section: "body" as const, path: ["ids"] }, rowPath: ["id"] },
          },
        },
        reconcile: {
          operationId: "GET /api/providers",
          inputs: [],
          outcome: { kind: "absent" as const, identityFields: ["id"], stateFields: [] },
        },
      };
      return {
        ...common,
        request: jsonBodyRequest(template.request, deleteSchema),
        response: responseContract(template.response, "200", DELETE_RESPONSE_SCHEMA, ["200", "400", "401", "403", "500", "503"]),
        secrets: { inputFields: [], outputFields: [] },
        sideEffect: "destructive",
        pagination: { mode: "none", parameters: [] },
        confirmation: { required: true, reason: "Deletes stored provider credentials and invokes source cleanup; apply requires explicit human confirmation." },
        reconciliation: collectionRelation,
      };
    }
    case "GET /api/providers/{id}/cc-alias": {
      return {
        ...common,
        response: responseContract(template.response, "200", CC_ALIAS_RESPONSE_SCHEMA, ["200", "401", "403", "500", "503"]),
        secrets: { inputFields: [], outputFields: [] },
        sideEffect: "read",
        pagination: { mode: "none", parameters: [] },
        confirmation: { required: false, reason: "Read-only alias configuration; only allowlisted provider and model overrides are projected." },
        reconciliation: null,
      };
    }
    case "PUT /api/providers/{id}/cc-alias": {
      const aliasSchema: JsonSchema = {
        oneOf: [
          objectSchema({
            scope: { type: "string", const: "provider" },
            value: { type: ["string", "null"], enum: ["on", "off", null] },
          }, ["scope", "value"]),
          objectSchema({
            scope: { type: "string", const: "model" },
            modelId: { type: "string", minLength: 1, maxLength: 200 },
            value: { type: ["string", "null"], enum: ["on", "off", null] },
          }, ["scope", "modelId", "value"]),
        ],
      };
      return {
        ...common,
        request: jsonBodyRequest(template.request, aliasSchema, [
          { section: "body", path: ["modelId"], kind: "trim-string" },
        ]),
        response: responseContract(template.response, "200", SUCCESS_RESPONSE_SCHEMA, ["200", "400", "401", "403", "500", "503"]),
        secrets: { inputFields: [], outputFields: [] },
        sideEffect: "mutation",
        pagination: { mode: "none", parameters: [] },
        confirmation: {
          required: true,
          reason: "Sets or clears a provider or dynamically keyed model override. The closed relation contract cannot express the discriminated provider/model compare-and-set; a lost response is reported unknown, inspected by the operator with GET /api/providers/{id}/cc-alias, and never replayed.",
        },
        reconciliation: null,
      };
    }
  }
}

export const PROVIDER_FAMILY_SOURCE_CONTRACTS: Readonly<Record<typeof PROVIDER_FAMILY_OPERATION_IDS[number], ProviderFamilyContract>> =
  Object.fromEntries(PROVIDER_FAMILY_OPERATION_IDS.map(operationId => [operationId, createSourceReviewedContract(operationId)])) as Record<
    typeof PROVIDER_FAMILY_OPERATION_IDS[number],
    ProviderFamilyContract
  >;

export interface ProviderConnectionFixture {
  id: string;
  provider: string;
  name: string;
  isActive: boolean;
  priority?: number;
  updatedAt?: string;
  syncedModelsAt?: string | null;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  providerSpecificData?: Record<string, unknown>;
}

const REDACTED_PROVIDER_DATA_KEYS = [
  "accessToken", "refreshToken", "idToken", "apiKey", "consoleApiKey", "secretAccessKey",
  "awsSecretAccessKey", "sessionToken", "awsSessionToken", "openCodeGoAuthCookie", "opencodeGoAuthCookie",
  "authCookie", "ollamaUsageCookie", "ollamaCloudUsageCookie", "ollamaCloudCookie", "usageCookie",
  "qwenCloudCookie", "qwenCloudSecToken", "alibabaConsoleCookie", "alibabaConsoleSecToken", "runtimeKey",
  "validationId", "volcConsoleCookie", "volcCsrfToken", "codexFingerprintSeed", "codexClientIdentity",
  "codexOriginalIdentityHeaders", "codexTurnStateEcho",
] as const;

type AliasValue = "on" | "off";

function isAliasValue(value: unknown): value is AliasValue | null {
  return value === null || value === "on" || value === "off";
}
const FIXTURE_PROVIDER_IDS: Record<string, true> = {
  openai: true,
  anthropic: true,
  gemini: true,
  openrouter: true,
  "cloudflare-ai": true,
  "google-pse-search": true,
  "ghe-copilot": true,
};
const COMPATIBLE_NODE_FIXTURES = Object.freeze({
  "openai-compatible-fixture-alias": Object.freeze({
    id: "openai-compatible-fixture-canonical",
    prefix: "fixture-openai",
    apiType: "openai",
    baseUrl: "https://compatible.example/v1/",
    name: "Fixture OpenAI node",
    chatPath: "/chat/completions",
    modelsPath: "/models",
    customHeaders: Object.freeze({ "x-fixture-node": "canonical" }),
  }),
  "anthropic-compatible-fixture-alias": Object.freeze({
    id: "anthropic-compatible-fixture-canonical",
    prefix: "fixture-anthropic",
    baseUrl: "https://anthropic-compatible.example/v1/",
    name: "Fixture Anthropic node",
    chatPath: "/messages",
    modelsPath: "/models",
  }),
});

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseConnection(connection: ProviderConnectionFixture): Record<string, unknown> {
  const result: Record<string, unknown> = { ...structuredClone(connection) };
  result.apiKey = connection.apiKey ? `${connection.apiKey.slice(0, 8)}****${connection.apiKey.slice(-4)}` : undefined;
  result.accessToken = undefined;
  result.refreshToken = undefined;
  result.idToken = undefined;
  if (connection.providerSpecificData) {
    const providerSpecificData = { ...connection.providerSpecificData };
    for (const name of REDACTED_PROVIDER_DATA_KEYS) delete providerSpecificData[name];
    if (providerSpecificData.browserCdpEndpoint) providerSpecificData.browserCdpEndpoint = "configured";
    result.providerSpecificData = Object.keys(providerSpecificData).length > 0 ? providerSpecificData : undefined;
  }
  return result;
}

/** Source-faithful HTTP fixture for `/api/providers` collection and cc-alias handler cases. */
export class ProviderFamilyFixture {
  readonly #connections = new Map<string, ProviderConnectionFixture>();
  readonly #ccAliasProviderSettings = new Map<string, AliasValue>();
  readonly #ccAliasModelSettings = new Map<string, AliasValue>();
  readonly #server: { readonly url: URL; stop(closeActiveConnections?: boolean): void };
  readonly #clock: () => string;
  readonly #auth: ManagementAuthFixture | undefined;
  #nextId = 1;
  #failNextList = false;
  #failUpdateId: string | undefined;
  #loseNextPatchResponse = false;
  #lostPatchResponsePending = false;
  #getCount = 0;
  #patchCount = 0;
  #postCount = 0;
  #deleteCount = 0;
  #updateCount = 0;
  authRequired = true;

  constructor(
    connections: readonly ProviderConnectionFixture[],
    options: { clock?: () => string; auth?: ManagementAuthFixture } = {},
  ) {
    for (const connection of connections) {
      this.#connections.set(connection.id, structuredClone(connection));
      const numericId = Number(connection.id);
      if (Number.isInteger(numericId)) this.#nextId = Math.max(this.#nextId, numericId + 1);
    }
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#auth = options.auth;
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: request => this.#handle(request),
    });
  }

  get endpoint(): string {
    return this.#server.url.origin;
  }

  get state(): readonly ProviderConnectionFixture[] {
    return [...this.#connections.values()].map(connection => structuredClone(connection));
  }

  get counts(): Readonly<{ get: number; patch: number; post: number; delete: number; updates: number }> {
    return { get: this.#getCount, patch: this.#patchCount, post: this.#postCount, delete: this.#deleteCount, updates: this.#updateCount };
  }

  failNextList(): void {
    this.#failNextList = true;
  }

  failUpdateAt(id: string): void {
    this.#failUpdateId = id;
  }

  loseNextPatchResponse(): void {
    this.#loseNextPatchResponse = true;
  }

  consumeLostPatchResponse(): boolean {
    const pending = this.#lostPatchResponsePending;
    this.#lostPatchResponsePending = false;
    return pending;
  }

  setActive(id: string, isActive: boolean): void {
    const connection = this.#connections.get(id);
    if (!connection) throw new Error(`fixture connection ${id} does not exist`);
    connection.isActive = isActive;
    const providerSpecificData = { ...(connection.providerSpecificData ?? {}) };
    if (isActive) delete providerSpecificData.operatorDisabledAt;
    else providerSpecificData.operatorDisabledAt = this.#clock();
    connection.providerSpecificData = providerSpecificData;
  }

  async close(): Promise<void> {
    this.#server.stop(true);
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/cli/whoami" && request.method === "GET" && this.#auth) return this.#auth.handle(request);
    const aliasMatch = /^\/api\/providers\/([^/]+)\/cc-alias$/.exec(url.pathname);
    if (url.pathname !== "/api/providers" && !aliasMatch) return json({ error: "Not found" }, 404);

    const authError = this.#authorize(request);
    if (authError) return authError;

    if (aliasMatch) {
      const providerId = decodeURIComponent(aliasMatch[1] ?? "");
      if (request.method === "GET") return this.#getCcAlias(providerId);
      if (request.method === "PUT") return this.#setCcAlias(providerId, request);
      return json({ error: "Method not allowed" }, 405);
    }
    if (request.method === "GET") {
      this.#getCount += 1;
      return this.#list(url);
    }
    if (request.method === "PATCH") {
      this.#patchCount += 1;
      return this.#patch(request);
    }
    if (request.method === "POST") {
      this.#postCount += 1;
      return this.#create(request);
    }
    if (request.method === "DELETE") {
      this.#deleteCount += 1;
      return this.#delete(request);
    }
    return json({ error: "Method not allowed" }, 405);
  }

  #authorize(request: Request): Response | undefined {
    if (!this.authRequired) return undefined;
    if (this.#auth) return this.#auth.authorize(request);
    const authorization = request.headers.get("authorization");
    if (!authorization) return json({ error: "Authentication required" }, 401);
    const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (token === "fixture-manage") return undefined;
    if (token === "fixture-no-manage") {
      return json({ error: "API key lacks 'manage' scope. Enable it in the API Keys dashboard." }, 403);
    }
    return json({ error: "Invalid management token" }, 403);
  }

  #list(url: URL): Response {
    if (this.#failNextList) {
      this.#failNextList = false;
      return json({ error: "Failed to fetch providers" }, 500);
    }
    const provider = url.searchParams.get("provider")?.trim();
    const limitValue = url.searchParams.get("limit");
    const offsetValue = url.searchParams.get("offset");
    const parsedLimit = limitValue ? Number.parseInt(limitValue, 10) : undefined;
    const parsedOffset = offsetValue ? Number.parseInt(offsetValue, 10) : undefined;
    const limit = Number.isInteger(parsedLimit) && parsedLimit && parsedLimit > 0 ? parsedLimit : undefined;
    const offset = Number.isInteger(parsedOffset) && parsedOffset && parsedOffset > 0 ? parsedOffset : 0;
    const matching = [...this.#connections.values()].filter(connection => !provider || connection.provider === provider);
    matching.sort((left, right) => (left.priority ?? 0) - (right.priority ?? 0)
      || (Date.parse(right.updatedAt ?? "") || 0) - (Date.parse(left.updatedAt ?? "") || 0));
    const page = matching.slice(offset, limit === undefined ? undefined : offset + limit);
    return json({
      connections: page.map(connection => ({
        ...responseConnection(connection),
        syncedModelsAt: typeof connection.syncedModelsAt === "string" ? connection.syncedModelsAt : null,
        // The synthetic fixture has resilience auto-protection disabled.
        rateLimitAutoProtected: false,
      })),
      total: matching.length,
    });
  }

  async #readBody(request: Request): Promise<{ value?: unknown; error?: Response }> {
    try {
      return { value: await request.json() as unknown };
    } catch {
      return { error: json({ error: "Invalid JSON body" }, 400) };
    }
  }

  async #patch(request: Request): Promise<Response> {
    const parsed = await this.#readBody(request);
    if (parsed.error) return parsed.error;
    const body = parsed.value;
    if (!isRecord(body) || !Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 100
      || body.ids.some(id => typeof id !== "string" || id.trim().length === 0) || typeof body.isActive !== "boolean") {
      return json({ error: "Invalid request" }, 400);
    }
    const ids = body.ids.map(id => (id as string).trim());
    const isActive = body.isActive;
    if (isActive) {
      const retired = ids.map(id => this.#connections.get(id)).find(connection => connection?.provider === "chatgpt-web");
      if (retired) return json({ error: "Provider is retired" }, 410);
    }

    const updatedIds: string[] = [];
    const notFoundIds: string[] = [];
    for (const id of ids) {
      if (this.#failUpdateId === id) {
        this.#failUpdateId = undefined;
        return json({ error: "Failed to batch update connections" }, 500);
      }
      const existing = this.#connections.get(id);
      if (!existing) {
        notFoundIds.push(id);
        continue;
      }
      existing.isActive = isActive;
      const providerSpecificData = { ...(existing.providerSpecificData ?? {}) };
      if (isActive) delete providerSpecificData.operatorDisabledAt;
      else providerSpecificData.operatorDisabledAt = this.#clock();
      existing.providerSpecificData = providerSpecificData;
      this.#updateCount += 1;
      updatedIds.push(id);
    }
    const message = `${isActive ? "Activated" : "Deactivated"} ${updatedIds.length} connection(s)`;
    if (this.#loseNextPatchResponse) {
      this.#loseNextPatchResponse = false;
      this.#lostPatchResponsePending = true;
    }
    return json({ message, updated: updatedIds.length, notFound: notFoundIds }, 200);
  }

  async #create(request: Request): Promise<Response> {
    const parsed = await this.#readBody(request);
    if (parsed.error) return parsed.error;
    const body = parsed.value;
    if (!isRecord(body) || typeof body.provider !== "string" || body.provider.length < 1 || body.provider.length > 100
      || typeof body.name !== "string" || body.name.length < 1 || body.name.length > 200
      || (body.apiKey !== undefined && (typeof body.apiKey !== "string" || body.apiKey.length > 100_000))
      || (body.allowNoCredential !== undefined && body.allowNoCredential !== true)) {
      return json({ error: "Invalid request" }, 400);
    }
    if (body.provider === "cloudflare-ai" && Object.hasOwn(body, "accountId")) {
      return json({ error: "Use providerSpecificData.accountId instead of top-level accountId" }, 400);
    }
    if (body.allowNoCredential === true && !sourceProviderAllowsOptionalApiKey(body.provider)) {
      return json({ error: "This provider does not allow a connection without a credential" }, 400);
    }
    if (typeof body.apiKey === "string" && body.apiKey.trim().startsWith("enc:v1:")) {
      return json({ error: "apiKey must be plaintext, not an encrypted credential envelope" }, 400);
    }
    if (!sourceProviderAllowsOptionalApiKey(body.provider)
      && (typeof body.apiKey !== "string" || body.apiKey.trim().length === 0)) {
      return json({ error: "Invalid request" }, 400);
    }
    const isCompatibleProvider = body.provider.startsWith("openai-compatible-")
      || body.provider.startsWith("anthropic-compatible-");
    if (!Object.hasOwn(FIXTURE_PROVIDER_IDS, body.provider) && !sourceHasNoAuthProvider(body.provider) && !isCompatibleProvider) {
      return json({ error: "Invalid provider" }, 400);
    }
    let specific = isRecord(body.providerSpecificData) ? body.providerSpecificData : undefined;
    if (body.provider === "google-pse-search" && (typeof specific?.cx !== "string" || !specific.cx.trim())) return json({ error: "Programmable Search Engine ID (cx) is required" }, 400);
    if (body.provider === "ghe-copilot") {
      if (typeof specific?.gheUrl !== "string" || !specific.gheUrl.trim()) return json({ error: "GitHub Enterprise URL (gheUrl) is required" }, 400);
      try {
        if (new URL(specific.gheUrl).protocol !== "https:") return json({ error: "GitHub Enterprise URL (gheUrl) must use HTTPS" }, 400);
      } catch { return json({ error: "GitHub Enterprise URL (gheUrl) is invalid" }, 400); }
    }
    if (isCompatibleProvider) {
      const node = Object.hasOwn(COMPATIBLE_NODE_FIXTURES, body.provider)
        ? COMPATIBLE_NODE_FIXTURES[body.provider as keyof typeof COMPATIBLE_NODE_FIXTURES]
        : undefined;
      if (!node) return json({ error: body.provider.startsWith("anthropic-compatible-") ? "Anthropic Compatible node not found" : "OpenAI Compatible node not found" }, 404);
      const hydrated = hydrateSourceCompatibleProviderCreation(
        body.provider,
        node,
        specific ?? null,
        body.provider.startsWith("openai-compatible-"),
      );
      if (hydrated.error) return json({ error: hydrated.error }, 400);
      specific = hydrated.data;
    }
    const connection: ProviderConnectionFixture = {
      id: String(this.#nextId++),
      provider: body.provider,
      name: body.name,
      isActive: false,
      priority: typeof body.priority === "number" ? body.priority : 1,
      updatedAt: this.#clock(),
      ...(typeof body.apiKey === "string" ? { apiKey: body.apiKey } : {}),
      ...(specific === undefined ? {} : { providerSpecificData: structuredClone(specific) }),
    };
    this.#connections.set(connection.id, connection);
    const response = responseConnection(connection);
    delete response.apiKey;
    return json({ connection: response }, 201);
  }

  async #delete(request: Request): Promise<Response> {
    const parsed = await this.#readBody(request);
    if (parsed.error) return parsed.error;
    const body = parsed.value;
    if (!isRecord(body) || !Array.isArray(body.ids) || body.ids.length === 0) {
      return json({ error: "ids must be a non-empty array of connection IDs" }, 400);
    }
    if (body.ids.length > 100) return json({ error: "Cannot delete more than 100 connections at once" }, 400);
    let deleted = 0;
    for (const id of body.ids) {
      if (typeof id === "string" && this.#connections.delete(id)) deleted += 1;
    }
    return json({ message: `Deleted ${deleted} connection(s)`, deleted }, 200);
  }

  #getCcAlias(providerId: string): Response {
    const prefix = `${providerId}/`;
    const models: Record<string, AliasValue> = {};
    for (const [key, value] of this.#ccAliasModelSettings) {
      if (key.startsWith(prefix)) models[key.slice(prefix.length)] = value;
    }
    return json({ provider: this.#ccAliasProviderSettings.get(providerId) ?? null, models });
  }

  async #setCcAlias(providerId: string, request: Request): Promise<Response> {
    const parsed = await this.#readBody(request);
    if (parsed.error) return parsed.error;
    const body = parsed.value;
    if (!isRecord(body) || !isAliasValue(body.value)) return json({ error: "Invalid request" }, 400);
    if (body.scope === "provider") {
      if (body.value === null) this.#ccAliasProviderSettings.delete(providerId);
      else this.#ccAliasProviderSettings.set(providerId, body.value);
      return json({ success: true });
    }
    if (body.scope === "model" && typeof body.modelId === "string" && body.modelId.trim().length > 0
      && body.modelId.trim().length <= 200) {
      const key = `${providerId}/${body.modelId.trim()}`;
      if (body.value === null) this.#ccAliasModelSettings.delete(key);
      else this.#ccAliasModelSettings.set(key, body.value);
      return json({ success: true });
    }
    return json({ error: "Invalid request" }, 400);
  }
}
