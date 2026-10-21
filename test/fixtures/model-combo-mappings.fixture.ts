import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { invokeJsonAdapter, type AdapterResponse, type AdminCredential } from "../../src/admin/adapters.ts";
import { requiredOmaScope } from "../../src/admin/authorization-policy.ts";
import {
  getOperation,
  type JsonSchema,
  type OperationAdapter,
  type OperationDescriptor,
  type OperationResponseVariant,
} from "../../src/admin/registry.ts";
import type { JsonValue } from "../../src/admin/types.ts";
import type { Database } from "bun:sqlite";
import { fixtureRegistry } from "./admin-qualification.fixture.ts";
import {
  MODEL_COMBO_MAPPING_COLLECTION_PATH,
  MODEL_COMBO_MAPPING_ITEM_PATH,
  MODEL_COMBO_MAPPING_OPERATION_IDS as SOURCE_MODEL_COMBO_MAPPING_OPERATION_IDS,
  type ModelComboMappingOperationId,
  type ModelComboMappingRelationViewId,
} from "../../src/admin/source-model-combo-mappings.ts";
import { createPinnedMappingHandlers } from "./pinned-combo-handlers.fixture.ts";
import type { PinnedManagementAuthorization } from "./pinned-handler.fixture.ts";

export const MODEL_COMBO_MAPPING_OPERATION_IDS = SOURCE_MODEL_COMBO_MAPPING_OPERATION_IDS;
export type ModelComboMappingFixtureOperationId = typeof MODEL_COMBO_MAPPING_OPERATION_IDS[number];
export const MODEL_COMBO_MAPPING_COLLECTION_HANDLER = "src/app/api/model-combo-mappings/route.ts";
export const MODEL_COMBO_MAPPING_ITEM_HANDLER = "src/app/api/model-combo-mappings/[id]/route.ts";

export interface ModelComboMappingFixtureRow {
  readonly id: string;
  pattern: string;
  comboId: string;
  priority: number;
  enabled: boolean;
  description: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface ModelComboMappingFixtureState {
  readonly mappings: readonly ModelComboMappingPersistedRow[];
}

export interface ModelComboMappingPersistedRow {
  readonly id: string;
  readonly pattern: string;
  readonly combo_id: string;
  readonly priority: number;
  readonly enabled: number;
  readonly description: string;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface ModelComboMappingsHttpFixtureOptions {
  readonly auth: PinnedManagementAuthorization;
  readonly initial?: readonly Partial<ModelComboMappingFixtureRow>[];
  readonly comboNames?: Readonly<Record<string, string>>;
  readonly now?: () => string;
  readonly uuid?: () => string;
}

export interface ModelComboMappingFixtureCounts {
  readonly collectionGet: number;
  readonly itemGet: number;
  readonly post: number;
  readonly put: number;
  readonly delete: number;
  readonly authChecks: number;
}

const STRING: JsonSchema = { type: "string" };
const NONEMPTY_STRING: JsonSchema = { type: "string", minLength: 1 };
const INTEGER: JsonSchema = { type: "integer" };
const VALIDATION_DETAIL_SCHEMA: JsonSchema = {
  type: "object",
  required: ["field", "message"],
  properties: { field: STRING, message: STRING, keys: { type: "array", items: STRING } },
  additionalProperties: false,
};
const VALIDATION_ERROR_SCHEMA: JsonSchema = {
  type: "object",
  required: ["error"],
  properties: {
    error: {
      type: "object",
      required: ["message", "details"],
      properties: { message: STRING, details: { type: "array", items: VALIDATION_DETAIL_SCHEMA } },
      additionalProperties: false,
    },
  },
  additionalProperties: false,
};
const AUTH_ERROR_SCHEMA: JsonSchema = {
  type: "object",
  required: ["error", "requestId"],
  properties: {
    error: {
      type: "object",
      required: ["message", "type"],
      properties: {
        message: STRING,
        type: { type: "string", enum: ["invalid_request", "not_found", "conflict", "server_error"] },
        details: {},
      },
      additionalProperties: false,
    },
    requestId: NONEMPTY_STRING,
  },
  additionalProperties: false,
};
const STRING_ERROR_SCHEMA: JsonSchema = {
  type: "object",
  required: ["error"],
  properties: { error: STRING },
  additionalProperties: false,
};

const mappingProperties: Record<string, JsonSchema> = {
  id: NONEMPTY_STRING,
  pattern: { type: "string", maxLength: 500 },
  comboId: NONEMPTY_STRING,
  comboName: STRING,
  priority: INTEGER,
  enabled: { type: "boolean" },
  description: { type: "string", maxLength: 1000 },
  createdAt: NONEMPTY_STRING,
  updatedAt: NONEMPTY_STRING,
};
const MAPPING_SCHEMA: JsonSchema = {
  type: "object",
  required: ["id", "pattern", "comboId", "priority", "enabled", "description", "createdAt", "updatedAt"],
  properties: mappingProperties,
  additionalProperties: false,
};
const CREATED_MAPPING_SCHEMA: JsonSchema = {
  type: "object",
  required: ["id", "pattern", "comboId", "priority", "enabled", "description", "createdAt", "updatedAt"],
  properties: {
    id: mappingProperties.id!, pattern: mappingProperties.pattern!, comboId: mappingProperties.comboId!,
    priority: mappingProperties.priority!, enabled: mappingProperties.enabled!, description: mappingProperties.description!,
    createdAt: mappingProperties.createdAt!, updatedAt: mappingProperties.updatedAt!,
  },
  additionalProperties: false,
};
const COLLECTION_SUCCESS_SCHEMA: JsonSchema = {
  type: "object",
  required: ["mappings", "total"],
  properties: { mappings: { type: "array", items: MAPPING_SCHEMA }, total: { type: "integer", minimum: 0 } },
  additionalProperties: false,
};
const ITEM_SUCCESS_SCHEMA: JsonSchema = {
  type: "object",
  required: ["mapping"],
  properties: { mapping: MAPPING_SCHEMA },
  additionalProperties: false,
};
const CREATE_SUCCESS_SCHEMA: JsonSchema = {
  type: "object",
  required: ["mapping"],
  properties: { mapping: CREATED_MAPPING_SCHEMA },
  additionalProperties: false,
};
const DELETE_SUCCESS_SCHEMA: JsonSchema = {
  type: "object",
  required: ["success"],
  properties: { success: { type: "boolean", const: true } },
  additionalProperties: false,
};
const QUERY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    offset: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    limit: { type: "integer", minimum: 0, maximum: 200 },
  },
  additionalProperties: false,
};
const ITEM_PATH_SCHEMA: JsonSchema = {
  type: "object",
  required: ["id"],
  properties: { id: NONEMPTY_STRING },
  additionalProperties: false,
};
const CREATE_BODY_SCHEMA: JsonSchema = {
  type: "object",
  required: ["pattern", "comboId"],
  properties: {
    pattern: { type: "string", minLength: 1, maxLength: 500 },
    comboId: NONEMPTY_STRING,
    priority: { type: "integer", minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
    enabled: { type: "boolean" },
    description: { type: "string", maxLength: 1000 },
  },
  additionalProperties: true,
};

const LIST_QUERY_NORMALIZER = "omniroute-v3.8.52.model-combo-mappings.list-query" as const;
const CREATE_NORMALIZER = "omniroute-v3.8.52.model-combo-mappings.create" as const;
const UPDATE_NORMALIZER = "omniroute-v3.8.52.model-combo-mappings.update" as const;
const UPDATE_BODY_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    pattern: { type: "string", minLength: 1, maxLength: 500 },
    comboId: NONEMPTY_STRING,
    priority: { type: "integer", minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER },
    enabled: { type: "boolean" },
    description: { type: "string", maxLength: 1000 },
  },
  additionalProperties: true,
};

function mappingPath(id: string): string {
  return `${MODEL_COMBO_MAPPING_COLLECTION_PATH}/${encodeURIComponent(id)}`;
}

function operationSchemaMap(operationId: ModelComboMappingFixtureOperationId): Readonly<Record<string, JsonSchema>> {
  const auth = AUTH_ERROR_SCHEMA;
  const routeFailure = STRING_ERROR_SCHEMA;
  switch (operationId) {
    case "GET /api/model-combo-mappings":
      return { "200": COLLECTION_SUCCESS_SCHEMA, "400": VALIDATION_ERROR_SCHEMA, "401": auth, "403": auth, "500": routeFailure, "503": auth };
    case "POST /api/model-combo-mappings":
      return { "201": CREATE_SUCCESS_SCHEMA, "400": VALIDATION_ERROR_SCHEMA, "401": auth, "403": auth, "500": routeFailure, "503": auth };
    case "GET /api/model-combo-mappings/{id}":
      return { "200": ITEM_SUCCESS_SCHEMA, "401": auth, "403": auth, "404": routeFailure, "500": routeFailure, "503": auth };
    case "PUT /api/model-combo-mappings/{id}":
      return { "200": ITEM_SUCCESS_SCHEMA, "400": VALIDATION_ERROR_SCHEMA, "401": auth, "403": auth, "404": routeFailure, "500": routeFailure, "503": auth };
    case "DELETE /api/model-combo-mappings/{id}":
      return { "200": DELETE_SUCCESS_SCHEMA, "401": auth, "403": auth, "404": routeFailure, "500": routeFailure, "503": auth };
  }
}

function sourceResponseContract(
  operationId: ModelComboMappingFixtureOperationId,
  base: OperationSourceContract["response"],
): OperationSourceContract["response"] {
  const statusSchemas = operationSchemaMap(operationId);
  const routeFile = operationId.endsWith("{id}") ? MODEL_COMBO_MAPPING_ITEM_HANDLER : MODEL_COMBO_MAPPING_COLLECTION_HANDLER;
  const variants: OperationResponseVariant[] = base.variants.map(variant => {
    if (variant.content.length === 0) return variant;
    const schema = statusSchemas[variant.statusCode];
    if (!schema) throw new Error(`mapping response schema missing for ${operationId} HTTP ${variant.statusCode}`);
    return {
      ...variant,
      content: variant.content.map(content => ({ ...content, schema })),
    };
  });
  const union = Object.values(statusSchemas).filter((schema, index, all) => all.indexOf(schema) === index);
  return {
    ...base,
    schema: { oneOf: union },
    variants,
    statusCodes: variants.map(variant => variant.statusCode),
  };
}

function mappingAuth(base: OperationSourceContract["auth"], operationId: ModelComboMappingFixtureOperationId): OperationSourceContract["auth"] {
  const method = operationId.slice(0, operationId.indexOf(" "));
  const path = operationId.includes("{id}") ? MODEL_COMBO_MAPPING_ITEM_PATH : MODEL_COMBO_MAPPING_COLLECTION_PATH;
  return {
    domain: "management",
    specificationAlternatives: base.specificationAlternatives,
    sourcePolicy: {
      status: "qualified",
      source: "omniroute-v3.8.52",
      routeClass: "management",
      localOnly: false,
      handlerGuard: "requireManagementAuth",
      bootstrap: "none",
      alternatives: [
        { kind: "auth-disabled", when: "central-and-handler-auth-not-required" },
        { kind: "management-api-key", anyOf: ["manage", "admin"] },
        { kind: "dashboard-session" },
        { kind: "oma-access-token", minimumScope: requiredOmaScope(method ?? "GET", path) },
        { kind: "trusted-local", loopbackOnly: true },
      ],
    },
  };
}

function requestBody(schema: JsonSchema, base: OperationSourceContract["request"]): NonNullable<OperationSourceContract["request"]["body"]> {
  const mediaType = "application/json";
  return {
    required: true,
    mediaType,
    schema,
    contentVariants: base.body?.contentVariants.map(content => ({ ...content, mediaType, schema })) ?? [{ mediaType, schema }],
  };
}

function sourceReconciliation(operationId: ModelComboMappingFixtureOperationId): OperationSourceContract["reconciliation"] {
  const state = ["pattern", "comboId", "priority", "enabled", "description"] as const;
  const pathRead = {
    operationId: "GET /api/model-combo-mappings/{id}",
    inputs: [{ target: { section: "path" as const, field: "id" }, source: { section: "path" as const, path: ["id"] } }],
    snapshot: {
      kind: "resource" as const,
      identity: [{ name: "id", path: ["mapping", "id"] }],
      state: state.map(name => ({ name, path: ["mapping", name] })),
    },
  };
  const collectionRead = {
    operationId: "GET /api/model-combo-mappings",
    inputs: [],
    snapshot: {
      kind: "collection" as const,
      collectionPath: ["mappings"],
      identity: [{ name: "id", path: ["id"] }],
      state: state.map(name => ({ name, path: [name] })),
    },
  };
  if (operationId === "POST /api/model-combo-mappings") {
    return {
      targetRead: {
        ...collectionRead,
        sourceView: "omniroute-v3.8.52.model-combo-mappings.create-reconcile",
      },
      reconcile: {
        operationId: "GET /api/model-combo-mappings",
        inputs: [],
        outcome: {
          kind: "exists",
          identityFields: ["id"],
          stateFields: [...state],
          expectedFromInput: state.map(name => ({ name, source: { section: "body" as const, path: [name] } })),
        },
      },
    };
  }
  if (operationId === "PUT /api/model-combo-mappings/{id}") {
    return {
      targetRead: {
        ...pathRead,
        sourceView: "omniroute-v3.8.52.model-combo-mappings.update-reconcile",
      },
      reconcile: {
        operationId: pathRead.operationId,
        inputs: pathRead.inputs,
        outcome: {
          kind: "matches",
          identityFields: ["id"],
          stateFields: [...state],
          expectedFromInput: state.map(name => ({ name, source: { section: "body" as const, path: [name] } })),
        },
      },
    };
  }
  if (operationId === "DELETE /api/model-combo-mappings/{id}") {
    const selectedCollectionRead = {
      ...collectionRead,
      snapshot: {
        ...collectionRead.snapshot,
        selection: { input: { section: "path" as const, path: ["id"] }, rowPath: ["id"] },
      },
    };
    return {
      targetRead: {
        ...selectedCollectionRead,
        sourceView: "omniroute-v3.8.52.model-combo-mappings.delete-reconcile",
      },
      reconcile: {
        operationId: collectionRead.operationId,
        inputs: [],
        outcome: { kind: "absent", identityFields: ["id"], stateFields: [] },
      },
    };
  }
  return null;
}

function sourceContract(operationId: ModelComboMappingFixtureOperationId): OperationSourceContract {
  const base = operationContractTemplate(operationId) as unknown as OperationSourceContract;
  const list = operationId === "GET /api/model-combo-mappings";
  const create = operationId === "POST /api/model-combo-mappings";
  const update = operationId === "PUT /api/model-combo-mappings/{id}";
  const item = operationId.includes("{id}");
  const bodySchema = create ? CREATE_BODY_SCHEMA : update ? UPDATE_BODY_SCHEMA : null;
  const request = {
    ...base.request,
    pathSchema: item ? ITEM_PATH_SCHEMA : { type: "object", properties: {}, additionalProperties: false } satisfies JsonSchema,
    querySchema: list ? QUERY_SCHEMA : { type: "object", properties: {}, additionalProperties: false } satisfies JsonSchema,
    body: bodySchema ? requestBody(bodySchema, base.request) : null,
    ...(!list && !create && !update ? {} : {
      sourceNormalizer: list ? LIST_QUERY_NORMALIZER : create ? CREATE_NORMALIZER : UPDATE_NORMALIZER,
    }),
  };
  const mutation = operationId !== "GET /api/model-combo-mappings" && operationId !== "GET /api/model-combo-mappings/{id}";
  return {
    ...base,
    request,
    auth: mappingAuth(base.auth, operationId),
    response: sourceResponseContract(operationId, base.response),
    secrets: { inputFields: [], outputFields: [] },
    sideEffect: mutation ? "mutation" : "read",
    pagination: list ? { mode: "offset", parameters: ["limit", "offset"] } : { mode: "none", parameters: [] },
    streaming: { mode: "json", framing: "application/json" },
    confirmation: {
      required: mutation,
      reason: mutation
        ? "Human confirmation is required before creating, updating, or deleting a model-combo mapping."
        : "Source-defined ordinary mapping read; the management authorization boundary remains enforced.",
    },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] },
    reconciliation: mutation ? sourceReconciliation(operationId) : null,
  };
}

export const MODEL_COMBO_MAPPING_SOURCE_CONTRACTS: Readonly<Record<ModelComboMappingFixtureOperationId, OperationSourceContract>> = Object.freeze(
  Object.fromEntries(MODEL_COMBO_MAPPING_OPERATION_IDS.map(operationId => [operationId, sourceContract(operationId)])) as Record<ModelComboMappingFixtureOperationId, OperationSourceContract>,
);

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function routeError(message: string, status = 500): Response {
  return json({ error: message }, status);
}

export class ModelComboMappingsHttpFixture {
  readonly #auth: PinnedManagementAuthorization;
  readonly #server: Bun.Server<undefined>;
  readonly #routes: ReturnType<typeof createPinnedMappingHandlers>;
  readonly #counts = { collectionGet: 0, itemGet: 0, post: 0, put: 0, delete: 0, authChecks: 0 };

  constructor(options: ModelComboMappingsHttpFixtureOptions) {
    this.#auth = options.auth;
    this.#routes = createPinnedMappingHandlers({
      authorization: options.auth,
      ...(options.initial === undefined ? {} : { initial: options.initial }),
      ...(options.comboNames === undefined ? {} : { comboNames: options.comboNames }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.uuid === undefined ? {} : { uuid: options.uuid }),
    });
    this.#server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: request => this.#handle(request) });
  }

  get endpoint(): string { return this.#server.url.origin; }

  get counts(): ModelComboMappingFixtureCounts {
    return { ...this.#counts };
  }

  get database(): Database {
    return this.#routes.db;
  }

  resolveComboForModel(model: string): Promise<Record<string, unknown> | null> {
    return this.#routes.repository.resolveForModel(model);
  }

  get state(): ModelComboMappingFixtureState {
    const mappings = this.#routes.db.prepare(`SELECT id, pattern, combo_id, priority, enabled, description, created_at, updated_at
      FROM model_combo_mappings ORDER BY id`).all() as ModelComboMappingPersistedRow[];
    return { mappings };
  }

  close(): void {
    this.#server.stop(true);
    this.#routes.db.close();
  }

  async #handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const collection = path === MODEL_COMBO_MAPPING_COLLECTION_PATH;
    const item = new RegExp(`^${MODEL_COMBO_MAPPING_COLLECTION_PATH}/([^/]+)$`).exec(path);
    if (!collection && !item) return routeError("Not found", 404);
    this.#counts.authChecks += 1;
    if (collection && request.method === "GET") this.#counts.collectionGet += 1;
    if (collection && request.method === "POST") this.#counts.post += 1;
    if (item && request.method === "GET") this.#counts.itemGet += 1;
    if (item && request.method === "PUT") this.#counts.put += 1;
    if (item && request.method === "DELETE") this.#counts.delete += 1;

    return this.#auth.dispatch(request, { centralAuthRequired: true, handlerAuthRequired: false }, async forwarded => {
      if (collection && forwarded.method === "GET") return (this.#routes.collection.GET as (request: Request) => Promise<Response>)(forwarded);
      if (collection && forwarded.method === "POST") return (this.#routes.collection.POST as (request: Request) => Promise<Response>)(forwarded);
      if (!item) return routeError("Method not allowed", 405);
      let id: string;
      try { id = decodeURIComponent(item[1]!); } catch { return routeError("Mapping not found", 404); }
      const context: { params: Promise<{ id: string }> } = { params: Promise.resolve({ id }) };
      if (forwarded.method === "GET") return (this.#routes.item.GET as (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>)(forwarded, context);
      if (forwarded.method === "PUT") return (this.#routes.item.PUT as (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>)(forwarded, context);
      if (forwarded.method === "DELETE") return (this.#routes.item.DELETE as (request: Request, context: { params: Promise<{ id: string }> }) => Promise<Response>)(forwarded, context);
      return routeError("Method not allowed", 405);
    });
  }
}

export function buildModelComboMappingFixtureRegistry() {
  const descriptors: OperationDescriptor[] = MODEL_COMBO_MAPPING_OPERATION_IDS.map(operationId => {
    const source = getOperation(operationId);
    if (!source) throw new Error(`pinned model-combo-mapping operation is absent: ${operationId}`);
    const contract = MODEL_COMBO_MAPPING_SOURCE_CONTRACTS[operationId];
    const name = operationId.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
    return {
      ...source,
      ...contract,
      mediaType: { request: contract.request.body?.mediaType ?? null, response: contract.response.mediaType },
      coverage: { status: "invokable", adapterId: `typed.fixture.${name}`, reason: null },
    };
  });
  return fixtureRegistry(descriptors);
}

export function modelComboMappingAdapterDescriptor(adapter: OperationAdapter) {
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

export async function invokeModelComboMappingAdapter(
  adapter: OperationAdapter,
  fixture: ModelComboMappingsHttpFixture,
  credential: AdminCredential,
  input: unknown,
): Promise<AdapterResponse> {
  const validated = adapter.validate(input);
  return invokeJsonAdapter({
    descriptor: modelComboMappingAdapterDescriptor(adapter),
    endpoint: fixture.endpoint,
    credential,
    resolvedPath: adapter.buildPath(validated),
    queryParameters: adapter.buildQuery(validated),
    ...(validated.body === undefined ? {} : { body: validated.body }),
  });
}

export function relationViewForOperation(operationId: ModelComboMappingOperationId): ModelComboMappingRelationViewId | undefined {
  if (operationId === "POST /api/model-combo-mappings") return "omniroute-v3.8.52.model-combo-mappings.create-reconcile";
  if (operationId === "PUT /api/model-combo-mappings/{id}") return "omniroute-v3.8.52.model-combo-mappings.update-reconcile";
  if (operationId === "DELETE /api/model-combo-mappings/{id}") return "omniroute-v3.8.52.model-combo-mappings.delete-reconcile";
  return undefined;
}

export function fixtureStateJson(fixture: ModelComboMappingsHttpFixture): JsonValue {
  return { mappings: fixture.state.mappings.map(row => ({ ...row })) };
}
