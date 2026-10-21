import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import type { JsonSchema, OperationDescriptor } from "../../src/admin/registry.ts";

export const PROVIDER_NODES_OPERATION_ID = "GET /api/provider-nodes" as const;

type ProviderNodesContract = Pick<OperationDescriptor,
  "request" | "auth" | "response" | "secrets" | "sideEffect" | "pagination" | "streaming" | "confirmation" | "retry" | "reconciliation" | "mutationSafety">;

const ERROR_SCHEMA: JsonSchema = { type: "object" };
const NULLABLE_STRING: JsonSchema = { type: ["string", "null"] };
const NODE_SCHEMA: JsonSchema = {
  type: "object",
  required: [
    "id", "type", "name", "prefix", "apiType", "baseUrl", "chatPath", "modelsPath",
    "iconUrl", "customHeaders", "dailyQuotaResetTimezone", "dailyQuotaResetHour", "createdAt", "updatedAt",
  ],
  properties: {
    id: { type: "string", minLength: 1 },
    type: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    prefix: NULLABLE_STRING,
    apiType: NULLABLE_STRING,
    baseUrl: NULLABLE_STRING,
    chatPath: NULLABLE_STRING,
    modelsPath: NULLABLE_STRING,
    iconUrl: NULLABLE_STRING,
    customHeaders: {
      type: ["object", "null"],
      additionalProperties: { type: "string" },
    },
    dailyQuotaResetTimezone: NULLABLE_STRING,
    dailyQuotaResetHour: { type: ["integer", "null"] },
    createdAt: { type: "string", format: "date-time" },
    updatedAt: { type: "string", format: "date-time" },
  },
  additionalProperties: false,
};
const PROVIDER_NODES_RESPONSE_SCHEMA: JsonSchema = {
  type: "object",
  required: ["nodes", "total", "ccCompatibleProviderEnabled"],
  properties: {
    nodes: { type: "array", items: NODE_SCHEMA },
    total: { type: "integer", minimum: 0 },
    ccCompatibleProviderEnabled: { type: "boolean" },
  },
  additionalProperties: false,
};

function managementAuth(template: ProviderNodesContract["auth"]): ProviderNodesContract["auth"] {
  return {
    domain: "management",
    specificationAlternatives: template.specificationAlternatives,
    sourcePolicy: {
      status: "qualified",
      source: "omniroute-v3.8.52",
      routeClass: "management",
      localOnly: false,
      handlerGuard: "none",
      bootstrap: "none",
      alternatives: [
        { kind: "management-api-key", anyOf: ["manage", "admin"] },
        { kind: "dashboard-session" },
        { kind: "auth-disabled", when: "central-and-handler-auth-not-required" },
        { kind: "oma-access-token", minimumScope: "read" },
        { kind: "trusted-local", loopbackOnly: true },
      ],
    },
  };
}

function responseContract(
  template: ProviderNodesContract["response"],
  statusCodes: readonly string[],
): ProviderNodesContract["response"] {
  const successStatus = "200";
  const variants = statusCodes.map(statusCode => {
    const source = template.variants.find(variant => variant.statusCode === statusCode);
    const content = source?.content.length
      ? source.content.map(item => ({
        ...item,
        schema: statusCode === successStatus ? PROVIDER_NODES_RESPONSE_SCHEMA : ERROR_SCHEMA,
      }))
      : [{ mediaType: "application/json", schema: statusCode === successStatus ? PROVIDER_NODES_RESPONSE_SCHEMA : ERROR_SCHEMA }];
    return {
      statusCode,
      content,
      headers: source?.headers ?? {},
      ...(source?.sourceFiles === undefined ? {} : { sourceFiles: source.sourceFiles }),
    };
  });
  return {
    statusCodes: [...statusCodes],
    mediaType: "application/json",
    schema: PROVIDER_NODES_RESPONSE_SCHEMA,
    variants,
  };
}

function sourceContract(): ProviderNodesContract {
  const template = operationContractTemplate(PROVIDER_NODES_OPERATION_ID) as unknown as ProviderNodesContract;
  const offsetParameter = {
    name: "offset",
    in: "query" as const,
    required: false,
    style: "form",
    explode: true,
    allowReserved: false,
    schema: { type: "integer", minimum: 0 },
    inputAllowed: true,
    sourceFile: "src/app/api/provider-nodes/route.ts",
  };
  const limitParameter = {
    name: "limit",
    in: "query" as const,
    required: false,
    style: "form",
    explode: true,
    allowReserved: false,
    schema: { type: "integer", minimum: 0, maximum: 200 },
    inputAllowed: true,
    sourceFile: "src/app/api/provider-nodes/route.ts",
  };
  return {
    request: {
      ...template.request,
      // The client boundary takes integer values and serializes them as URL text.
      // Upstream Zod separately coerces raw URL strings and accepts the inclusive 0..200 range.
      querySchema: {
        type: "object",
        properties: {
          offset: { type: "integer", minimum: 0 },
          limit: { type: "integer", minimum: 0, maximum: 200 },
        },
        additionalProperties: false,
      },
      parameters: [offsetParameter, limitParameter],
    },
    auth: managementAuth(template.auth),
    response: responseContract(template.response, ["200", "400", "401", "403", "500", "503"]),
    secrets: { inputFields: [], outputFields: ["customHeaders", "baseUrl", "chatPath", "modelsPath"] },
    sideEffect: "read",
    pagination: { mode: "offset", parameters: ["limit", "offset"] },
    streaming: { mode: "json", framing: "application/json" },
    confirmation: {
      required: false,
      reason: "Read-only provider node inventory. Credential-bearing headers, URLs, and private request paths remain available only in the source target projection.",
    },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] },
    reconciliation: null,
    mutationSafety: null,
  };
}

export const PROVIDER_NODES_SOURCE_CONTRACT: ProviderNodesContract = sourceContract();

export interface ProviderNodeFixture {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly prefix: string | null;
  readonly apiType: string | null;
  readonly baseUrl: string | null;
  readonly chatPath: string | null;
  readonly modelsPath: string | null;
  readonly iconUrl: string | null;
  readonly customHeaders: Record<string, string> | null;
  readonly dailyQuotaResetTimezone: string | null;
  readonly dailyQuotaResetHour: number | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
