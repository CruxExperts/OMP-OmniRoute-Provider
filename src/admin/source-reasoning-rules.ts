/*
 * Reviewed against OmniRoute v3.8.53:
 * src/app/api/settings/reasoning-routing-rules/route.ts
 * SHA-256 8607798ef6ffb9deed566cea0f25e7c9438be8eb090d1196240fab6a4f6d3018
 * src/lib/db/reasoningRoutingRules.ts
 * SHA-256 b869cce85dfea12ea59a7cd9ff85fb3e4ce93e87ae3f1e6a293e20a76a2717a9
 * The route returns the unfiltered, ordered store result. The public projection
 * deliberately omits sensitive fields and is not a complete rule inventory.
 * The process-local store cache may remain stale until source invalidation.
 */
import { requiredOmaScope } from "./authorization-policy.ts";
import type { OperationSourceContract } from "./eligibility.ts";
import type { JsonSchema, OperationDescriptor } from "./registry.ts";

export const REASONING_RULES_GET_ID = "GET /api/settings/reasoning-routing-rules";

const empty: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
const text: JsonSchema = { type: "string" };
const nullableText: JsonSchema = { oneOf: [text, { type: "null" }] };
const ruleFields: Record<string, JsonSchema> = {
  id: text, name: text, description: text, scope: text, apiKeyId: nullableText, comboId: nullableText,
  connectionId: nullableText, modelPattern: nullableText, sourceEffort: text,
  requestTags: { type: "array", items: text }, tagMatchMode: text, effortMode: text, targetEffort: nullableText,
  targetKind: text, targetModel: nullableText, targetComboId: nullableText, budgetAction: text,
  budgetTokens: { oneOf: [{ type: "number" }, { type: "null" }] }, priority: { type: "number" },
  enabled: { type: "boolean" }, createdAt: text, updatedAt: text,
};
const rulesResponse: JsonSchema = { type: "object", properties: { rules: { type: "array", items: {
  type: "object", properties: ruleFields, required: Object.keys(ruleFields), additionalProperties: false,
} } }, required: ["rules"], additionalProperties: false };
const handlerAuthError: JsonSchema = { type: "object", properties: {
  error: { type: "object", properties: { message: text, type: text }, required: ["message", "type"], additionalProperties: true },
  requestId: { type: "string", format: "uuid" },
}, required: ["error", "requestId"], additionalProperties: true };
const centralAuthError: JsonSchema = { type: "object", properties: {
  error: { type: "object", properties: { code: text, message: text, correlation_id: { type: "string", format: "uuid" } },
    required: ["code", "message", "correlation_id"], additionalProperties: false },
}, required: ["error"], additionalProperties: false };

/** Apply the source-reviewed contract to the canonical generated operation template.
 * This describes behavior only; independent qualification is still required.
 */
export function reasoningRulesGetContract(template: OperationSourceContract): OperationSourceContract {
  return {
    ...template,
    request: { ...template.request, pathSchema: empty, querySchema: empty, pathParameters: [], parameters: [], body: null },
    auth: { domain: "management", specificationAlternatives: template.auth.specificationAlternatives, sourcePolicy: {
      status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false,
      handlerGuard: "requireManagementAuth", bootstrap: "none", alternatives: [
        { kind: "management-api-key", anyOf: ["manage", "admin"] }, { kind: "dashboard-session" },
        { kind: "auth-disabled", when: "central-and-handler-auth-not-required" },
        { kind: "oma-access-token", minimumScope: requiredOmaScope("GET", "/api/settings/reasoning-routing-rules") },
        { kind: "trusted-local", loopbackOnly: true },
      ],
    } },
    response: { ...template.response, schema: { anyOf: [rulesResponse, handlerAuthError, centralAuthError] },
      variants: template.response.variants.map(variant => ({ ...variant, content: variant.content.map(content => ({
        ...content, schema: variant.statusCode === "200" ? rulesResponse : { oneOf: [handlerAuthError, centralAuthError] },
      })) })) },
    secrets: { inputFields: [], outputFields: [] }, sideEffect: "read",
    pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: false, reason: "Filtered rule view omits sensitive fields; process-local cached results may be stale until invalidated." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null, mutationSafety: null,
  };
}

/** Fixture/qualification descriptor; it does not create production eligibility. */
export function reasoningRulesGetDescriptor(original: OperationDescriptor, template: OperationSourceContract): OperationDescriptor {
  if (original.operationId !== REASONING_RULES_GET_ID || original.method !== "GET"
    || original.pathTemplate !== "/api/settings/reasoning-routing-rules"
    || original.source.sha256 !== "8607798ef6ffb9deed566cea0f25e7c9438be8eb090d1196240fab6a4f6d3018") {
    throw new Error("Reasoning rules source contract does not match the reviewed handler");
  }
  const contract = reasoningRulesGetContract(template);
  return { ...original, ...contract, mutationSafety: contract.mutationSafety ?? null,
    mediaType: { request: null, response: contract.response.mediaType },
    coverage: { status: "invokable", adapterId: "typed.fixture.settings.reasoning-rules", reason: null } };
}
