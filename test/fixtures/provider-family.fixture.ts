import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import type { JsonSchema, OperationDescriptor } from "../../src/admin/registry.ts";

type ProviderFamilyContract = Pick<OperationDescriptor,
  "request" | "auth" | "response" | "secrets" | "sideEffect" | "pagination" | "streaming" | "confirmation" | "retry" | "reconciliation" | "mutationSafety">;

export const PROVIDER_FAMILY_OPERATION_IDS = [
  "GET /api/providers",
  "POST /api/providers",
  "PATCH /api/providers",
  "DELETE /api/providers",
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
    mutationSafety: (operationId === "GET /api/providers" ? null : {
      preflight: { kind: "unavailable", reason: "Full provider revision and dependent destructive scope are not yet observable from source-qualified reads." },
      reconciliation: { kind: "unknown" },
      settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null },
    }) as ProviderFamilyContract["mutationSafety"],
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
