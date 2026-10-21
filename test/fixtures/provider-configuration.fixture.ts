import { Database } from "bun:sqlite";
import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import type { JsonValue } from "../../src/admin/types.ts";
import { sourceNormalizationBinding, sourceStateViewBinding, type SourceStateViewId } from "../../src/admin/source-normalization.ts";
import {
  createPinnedManagementAuthorization,
  type PinnedManagementAuthorization,
} from "./pinned-handler.fixture.ts";
import {
  createPinnedProviderConfigurationHandlers,
  createPinnedProviderConfigurationSchema,
  type PinnedProviderConfigurationHandlers,
} from "./pinned-provider-configuration.fixture.ts";

export const PROVIDER_CONFIGURATION_OPERATION_IDS = [
  "GET /api/providers/{id}/interception-rules",
  "PUT /api/providers/{id}/interception-rules",
  "DELETE /api/providers/{id}/interception-rules",
  "GET /api/providers/{id}/param-filters",
  "PUT /api/providers/{id}/param-filters",
  "DELETE /api/providers/{id}/param-filters",
] as const;

export type ProviderConfigurationOperationId = typeof PROVIDER_CONFIGURATION_OPERATION_IDS[number];
type ConfigFamily = "interception-rules" | "param-filters";
type ProviderConfigurationContract = Pick<OperationDescriptor,
  "request" | "auth" | "response" | "secrets" | "sideEffect" | "pagination" | "streaming" | "confirmation" | "retry" | "reconciliation">;


const BACKENDS = ["firecrawl", "jina", "tavily"] as const;
const ERROR_SCHEMA = { type: "object" } as const;
const SUCCESS_SCHEMA = {
  type: "object",
  required: ["success"],
  properties: { success: { type: "boolean", const: true } },
  additionalProperties: false,
} as const;

function objectSchema(properties: Record<string, JsonSchema>): JsonSchema {
  return { type: "object", properties, additionalProperties: false };
}

const MODEL_INTERCEPTION_SCHEMA = objectSchema({
  interceptSearch: { type: "boolean" },
  interceptFetch: { type: "boolean" },
  fetchBackend: { type: "string", enum: BACKENDS },
  fetchProxyUrl: { type: "string", format: "uri", maxLength: 2000 },
});
const INTERCEPTION_CONFIG_SCHEMA = objectSchema({
  interceptSearch: { type: "boolean" },
  interceptFetch: { type: "boolean" },
  fetchBackend: { type: "string", enum: BACKENDS },
  fetchProxyUrl: { type: "string", format: "uri", maxLength: 2000 },
  models: { type: "object", "x-key-role": "identifier", additionalProperties: MODEL_INTERCEPTION_SCHEMA },
});
const INTERCEPTION_REQUEST_SCHEMA = objectSchema({
  interceptSearch: { type: "boolean" },
  interceptFetch: { type: "boolean" },
  fetchBackend: { type: "string", enum: BACKENDS },
  fetchProxyUrl: { type: "string", format: "uri", maxLength: 2000 },
  models: { type: "object", additionalProperties: MODEL_INTERCEPTION_SCHEMA },
});
const PARAMETER_LIST_SCHEMA = { type: "array", items: { type: "string", minLength: 1, maxLength: 200 }, maxItems: 500 };
const MODEL_PARAM_FILTER_SCHEMA = objectSchema({
  block: PARAMETER_LIST_SCHEMA,
  allow: PARAMETER_LIST_SCHEMA,
});
const PARAM_FILTERS_SCHEMA: JsonSchema = {
  type: "object",
  required: ["block", "allow", "autoLearn"],
  properties: {
    block: PARAMETER_LIST_SCHEMA,
    allow: PARAMETER_LIST_SCHEMA,
    models: { type: "object", "x-key-role": "identifier", additionalProperties: MODEL_PARAM_FILTER_SCHEMA },
    autoLearn: { type: "boolean" },
  },
  additionalProperties: false,
};
const PARAM_FILTERS_REQUEST_SCHEMA = objectSchema({
  block: PARAMETER_LIST_SCHEMA,
  allow: PARAMETER_LIST_SCHEMA,
  models: { type: "object", additionalProperties: MODEL_PARAM_FILTER_SCHEMA },
  autoLearn: { type: "boolean" },
});

function familyFor(operationId: ProviderConfigurationOperationId): ConfigFamily {
  return operationId.includes("interception-rules") ? "interception-rules" : "param-filters";
}

function normalizationId(family: ConfigFamily): SourceStateViewId {
  return family === "interception-rules"
    ? "omniroute-v3.8.52.provider-interception-rules"
    : "omniroute-v3.8.52.provider-param-filters";
}

function handlerFor(operationId: ProviderConfigurationOperationId): string {
  const path = operationId.slice(operationId.indexOf(" ") + 1);
  const binding = sourceNormalizationBinding(normalizationId(familyFor(operationId)));
  if (!binding || path !== binding.pathTemplate) throw new Error("provider configuration operation has no pinned source binding");
  return `src/app${binding.pathTemplate.replace("{id}", "[id]")}/route.ts`;
}


function managementAuth(template: ProviderConfigurationContract, minimumScope: "read" | "admin"): ProviderConfigurationContract["auth"] {
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
  base: ProviderConfigurationContract["response"],
  operationId: ProviderConfigurationOperationId,
  successSchema: ProviderConfigurationContract["response"]["schema"],
): ProviderConfigurationContract["response"] {
  const handler = handlerFor(operationId);
  const statuses = operationId.startsWith("PUT ")
    ? ["200", "400", "401", "403", "500", "503"]
    : ["200", "401", "403", "500", "503"];
  const variants = statuses.map(statusCode => {
    const documented = base.variants.find(variant => variant.statusCode === statusCode);
    if (statusCode === "401" || statusCode === "403" || statusCode === "503") {
      if (!documented) throw new Error(`pinned route is missing shared auth/error variant ${statusCode}: ${operationId}`);
      return documented;
    }
    const content = documented?.content.length
      ? documented.content.map(item => statusCode === "200" ? { ...item, schema: successSchema } : item)
      : [{ mediaType: "application/json", schema: statusCode === "200" ? successSchema : ERROR_SCHEMA, sourceFile: handler }];
    const sourceFiles = [...new Set([...(documented?.sourceFiles ?? []), handler])];
    return { statusCode, content, headers: documented?.headers ?? {}, sourceFiles };
  });
  return { statusCodes: statuses, mediaType: "application/json", schema: successSchema, variants };
}

function putRequest(template: ProviderConfigurationContract["request"], family: ConfigFamily): ProviderConfigurationContract["request"] {
  const schema = family === "interception-rules" ? INTERCEPTION_REQUEST_SCHEMA : PARAM_FILTERS_REQUEST_SCHEMA;
  const sourceNormalizer = normalizationId(family);
  return {
    ...template,
    body: {
      required: true,
      mediaType: "application/json",
      schema,
      contentVariants: [{ mediaType: "application/json", schema }],
    },
    sourceNormalizer,
  };
}

function constrainProviderPath(
  request: ProviderConfigurationContract["request"],
  family: ConfigFamily,
): ProviderConfigurationContract["request"] {
  const schema = request.pathSchema;
  const idSchema = schema.properties?.id;
  if (schema.type !== "object" || schema.additionalProperties !== false || !schema.required?.includes("id") || !idSchema) {
    throw new Error("provider configuration template must have a closed path schema with a required id");
  }
  const pattern = family === "interception-rules"
    ? "^(?!__proto__(?![\\s\\S]))[^\\s](?:[\\s\\S]*[^\\s])?$"
    : "^(?!__proto__(?![\\s\\S]))[\\s\\S]+$";
  return {
    ...request,
    pathSchema: {
      ...schema,
      properties: { ...schema.properties, id: { ...idSchema, pattern } },
    },
  };
}

function pathInputMapping() {
  return [{
    target: { section: "path" as const, field: "id" },
    source: { section: "path" as const, path: ["id"] },
  }];
}

function updateRelation(family: ConfigFamily) {
  const view = normalizationId(family);
  const binding = sourceStateViewBinding(view);
  if (!binding) throw new Error("provider configuration normalization has no pinned source binding");
  const getOperationId = `${binding.readMethod} ${binding.pathTemplate}`;
  return {
    targetRead: {
      operationId: getOperationId,
      inputs: pathInputMapping(),
      snapshot: {
        kind: "resource" as const,
        identity: [],
        state: [{ name: "config", path: [], sourceView: view }],
      },
    },
    reconcile: {
      operationId: getOperationId,
      inputs: pathInputMapping(),
      outcome: {
        kind: "matches" as const,
        identityFields: [],
        stateFields: ["config"],
        expectedFromInput: [{
          name: "config",
          source: { section: "body" as const, path: [] },
          sourceView: view,
        }],
      },
    },
  };
}

function sourceContract(operationId: ProviderConfigurationOperationId): ProviderConfigurationContract {
  const template = operationContractTemplate(operationId) as unknown as ProviderConfigurationContract;
  const family = familyFor(operationId);
  const method = operationId.slice(0, operationId.indexOf(" "));
  const read = method === "GET";
  const write = method === "PUT";
  const successSchema = read
    ? family === "interception-rules" ? INTERCEPTION_CONFIG_SCHEMA : PARAM_FILTERS_SCHEMA
    : SUCCESS_SCHEMA;
  const confirmation = read
    ? { required: false, reason: "Source-defined provider configuration read; management authentication is required." }
    : !write
      ? { required: true, reason: "Deletes only this provider's configuration row. The matching GET returns defaults for both an absent row and a persisted empty row, so deletion cannot be reconciled from the public response; one human-approved attempt is allowed, and an ambiguous result remains unknown without replay." }
      : { required: true, reason: "Upserts this provider's complete configuration row after source validation; apply requires human confirmation and target-state revalidation." };
  const pathBoundRequest = constrainProviderPath(template.request, family);
  const request = write ? putRequest(pathBoundRequest, family) : pathBoundRequest;
  const reconciliation = write ? updateRelation(family) : null;
  return {
    request,
    auth: managementAuth(template, read ? "read" : "admin"),
    response: responseContract(template.response, operationId, successSchema),
    secrets: family === "interception-rules"
      ? { inputFields: write ? ["fetchProxyUrl"] : [], outputFields: read ? ["fetchProxyUrl"] : [] }
      : { inputFields: [], outputFields: [] },
    sideEffect: read ? "read" : "mutation",
    pagination: { mode: "none", parameters: [] },
    streaming: { mode: "json", framing: "application/json" },
    confirmation,
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] },
    reconciliation,
  };
}

export const PROVIDER_CONFIGURATION_SOURCE_CONTRACTS = Object.fromEntries(
  PROVIDER_CONFIGURATION_OPERATION_IDS.map(operationId => [operationId, sourceContract(operationId)]),
) as Record<ProviderConfigurationOperationId, OperationSourceContract>;

export function providerConfigurationDescriptor(operationId: ProviderConfigurationOperationId): OperationDescriptor {
  const template = getOperation(operationId);
  if (!template) throw new Error(`pinned provider configuration operation is absent: ${operationId}`);
  const contract = PROVIDER_CONFIGURATION_SOURCE_CONTRACTS[operationId];
  return {
    ...template,
    ...contract,
    mediaType: {
      request: contract.request.body?.mediaType ?? null,
      response: contract.response.mediaType,
    },
    coverage: { status: "invokable", adapterId: `typed.fixture.${operationId.toLowerCase().replace(/[^a-z0-9]+/g, ".")}`, reason: null },
  };
}

export interface ProviderConfigurationFixtureSeed {
  readonly interception?: Readonly<Record<string, JsonValue>>;
  readonly paramFilters?: Readonly<Record<string, JsonValue>>;
}

interface DeleteHold {
  readonly received: Promise<void>;
  readonly wait: Promise<void>;
  release(): void;
  notifyReceived(): void;
}

/** Faithful loopback-only route/DB fixture for the six pinned management handlers. */
export class ProviderConfigurationFixture {
  readonly #database = new Database(":memory:");
  readonly #authorization: PinnedManagementAuthorization;
  readonly #counts = new Map<string, number>();
  readonly #server: ReturnType<typeof Bun.serve>;
  #failNextWrite = false;
  #readFaultArmed = false;
  #handlers: PinnedProviderConfigurationHandlers;
  #nextDeleteHold: DeleteHold | undefined;
  authRequired = true;

  constructor(seed: ProviderConfigurationFixtureSeed = {}) {
    createPinnedProviderConfigurationSchema(this.#database);
    const insert = this.#database.prepare("INSERT INTO key_value (namespace, key, value) VALUES (?, ?, ?)");
    for (const [id, config] of Object.entries(seed.interception ?? {})) {
      insert.run("interception_rules", id, JSON.stringify(config));
    }
    for (const [id, config] of Object.entries(seed.paramFilters ?? {})) {
      insert.run("provider_param_filters", id, JSON.stringify(config));
    }
    const scopes = new Map<string, readonly string[]>([
      ["fixture-management-key", ["manage"]],
      ["fixture-runtime-key", ["read"]],
    ]);
    this.#authorization = createPinnedManagementAuthorization({
      isDashboardSession: token => token === "fixture-dashboard-session",
      verifyAccessToken: () => null,
      validateApiKey: key => scopes.has(key),
      getApiKeyMetadata: key => {
        const apiScopes = scopes.get(key);
        return apiScopes ? { id: `fixture-${key}`, scopes: apiScopes } : null;
      },
    });
    this.#handlers = createPinnedProviderConfigurationHandlers(this.#database, this.#authorization);
    this.#server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: request => this.#handle(request),
    });
  }

  get endpoint(): string {
    return this.#server.url.origin;
  }

  count(operationId: string): number {
    return this.#counts.get(operationId) ?? 0;
  }


  failNextRead(): void {
    if (this.#readFaultArmed) throw new Error("A provider-configuration read fault is already armed");
    this.#database.exec("ALTER TABLE key_value RENAME TO fixture_saved_key_value");
    this.#readFaultArmed = true;
    // Reload the real modules so their source-owned caches cannot hide the SQLite read failure.
    this.#handlers = createPinnedProviderConfigurationHandlers(this.#database, this.#authorization);
  }

  failNextWrite(): void {
    this.#database.exec(`
      DROP TRIGGER IF EXISTS fixture_provider_config_insert_failure;
      DROP TRIGGER IF EXISTS fixture_provider_config_delete_failure;
      CREATE TRIGGER fixture_provider_config_insert_failure BEFORE INSERT ON key_value
        WHEN NEW.namespace IN ('interception_rules', 'provider_param_filters')
        BEGIN SELECT RAISE(ABORT, 'access_token=fixture'); END;
      CREATE TRIGGER fixture_provider_config_delete_failure BEFORE DELETE ON key_value
        WHEN OLD.namespace IN ('interception_rules', 'provider_param_filters')
        BEGIN SELECT RAISE(ABORT, 'access_token=fixture'); END;
    `);
    this.#failNextWrite = true;
  }

  holdNextDeleteResponse(): DeleteHold {
    let receivedResolve!: () => void;
    let releaseResolve!: () => void;
    const hold: DeleteHold = {
      received: new Promise<void>(resolve => { receivedResolve = resolve; }),
      wait: new Promise<void>(resolve => { releaseResolve = resolve; }),
      release: () => releaseResolve(),
      notifyReceived: () => receivedResolve(),
    };
    this.#nextDeleteHold = hold;
    return hold;
  }

  interception(providerId: string): JsonValue {
    return serializableJson(this.#handlers.getInterceptionRules(providerId)) ?? {};
  }

  paramFilters(providerId: string): JsonValue {
    return serializableJson(this.#handlers.getParamFilterConfig(providerId)) ?? { block: [], allow: [], autoLearn: false };
  }

  hasStoredConfiguration(family: ConfigFamily, providerId: string): boolean {
    const namespace = family === "interception-rules" ? "interception_rules" : "provider_param_filters";
    return this.#database.prepare(
      "SELECT 1 AS present FROM key_value WHERE namespace = ? AND key = ?",
    ).get(namespace, providerId) !== null;
  }

  close(): void {
    this.#server.stop(true);
    this.#database.close();
  }

  async #handle(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const match = /^\/api\/providers\/([^/]+)\/(interception-rules|param-filters)$/.exec(path);
    if (!match) return Response.json({ error: "Not found" }, { status: 404 });
    let providerId: string;
    try { providerId = decodeURIComponent(match[1]!); } catch { return Response.json({ error: "Invalid provider id" }, { status: 400 }); }
    const family = match[2] as ConfigFamily;
    if (request.method !== "GET" && request.method !== "PUT" && request.method !== "DELETE") {
      return Response.json({ error: "Method not allowed" }, { status: 405 });
    }
    const operationId = `${request.method} /api/providers/{id}/${family}` as ProviderConfigurationOperationId;
    const count = this.count(operationId) + 1;
    this.#counts.set(operationId, count);

    const handler = this.#handlers[family === "interception-rules" ? "interception" : "paramFilters"];
    const method = request.method as "GET" | "PUT" | "DELETE";
    const restoreReadFailure = this.#readFaultArmed && method === "GET";
    const restoreWriteFailure = this.#failNextWrite && (method === "PUT" || method === "DELETE");
    if (restoreReadFailure) this.#readFaultArmed = false;
    if (restoreWriteFailure) this.#failNextWrite = false;
    try {
      const response = await this.#authorization.dispatch(
        request,
        { centralAuthRequired: this.authRequired, handlerAuthRequired: this.authRequired },
        forwarded => handler[method](forwarded, { params: Promise.resolve({ id: providerId }) }),
      );
      if (method === "DELETE" && response.status === 200) {
        const hold = this.#nextDeleteHold;
        this.#nextDeleteHold = undefined;
        if (hold) {
          hold.notifyReceived();
          await hold.wait;
        }
      }
      return response;
    } finally {
      if (restoreReadFailure) this.#database.exec("ALTER TABLE fixture_saved_key_value RENAME TO key_value");
      if (restoreWriteFailure) {
        this.#database.exec(`
          DROP TRIGGER IF EXISTS fixture_provider_config_insert_failure;
          DROP TRIGGER IF EXISTS fixture_provider_config_delete_failure;
        `);
      }
    }
  }
}

function serializableJson(value: unknown): JsonValue | undefined {
  if (value === null) return null;
  const json = JSON.stringify(value);
  return json === undefined ? undefined : JSON.parse(json) as JsonValue;
}
