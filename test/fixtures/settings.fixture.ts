import { operationContractTemplate, operationEvidenceBinding } from "../../scripts/generate-contracts.ts";
import { requiredOmaScope } from "../../src/admin/authorization-policy.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";

export const SETTINGS_GET_ID = "GET /api/settings";
// Deliberately a cloud-configuration view, not the complete settings response.
// An absent stored row defaults to false in getSettings; a non-boolean persisted
// value is not coerced by the source and must not become a false claim here.
const cloudView: JsonSchema = { type: "object", properties: { cloudEnabled: { type: "boolean" } }, required: ["cloudEnabled"], additionalProperties: false };
const empty: JsonSchema = { type: "object", properties: {}, additionalProperties: false };

export function settingsGetContract(): OperationSourceContract {
  const template = operationContractTemplate(SETTINGS_GET_ID) as unknown as OperationSourceContract;
  return {
    ...template,
    request: { ...template.request, pathSchema: empty, querySchema: empty, parameters: [], body: null },
    auth: { domain: "management", specificationAlternatives: template.auth.specificationAlternatives, sourcePolicy: {
      status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false,
      handlerGuard: "requireManagementAuth", bootstrap: "none", alternatives: [
        { kind: "management-api-key", anyOf: ["manage", "admin"] }, { kind: "dashboard-session" },
        { kind: "auth-disabled", when: "central-and-handler-auth-not-required" },
        { kind: "oma-access-token", minimumScope: requiredOmaScope("GET", "/api/settings") },
        { kind: "trusted-local", loopbackOnly: true },
      ],
    } },
    // The inferred 200 variant currently has no content. Preserve it exactly;
    // the separate projection schema does not assert missing media provenance.
    response: { ...template.response, schema: cloudView },
    secrets: { inputFields: [], outputFields: ["password", "radarAdminUrl", "cloudUrl", "machineId", "oidcClientSecret", "entraGraphClientSecret"] },
    sideEffect: "unknown", pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: true, reason: "Cloud configuration projection only; warm fixture does not prove cold initialization or all settings effects." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null, mutationSafety: null,
  };
}

export function settingsGetDescriptor(): OperationDescriptor {
  const original = getOperation(SETTINGS_GET_ID);
  if (!original) throw new Error(`Missing pinned operation ${SETTINGS_GET_ID}`);
  const contract = settingsGetContract();
  const binding = operationEvidenceBinding(SETTINGS_GET_ID, contract);
  if (binding.handlerSha256 !== original.source.sha256 || binding.handlerGitBlobSha !== original.source.gitBlobSha) throw new Error("Settings source contract does not match pinned handler");
  return { ...original, ...contract, mediaType: { request: null, response: contract.response.mediaType }, coverage: { status: "invokable", adapterId: "typed.fixture.settings.cloud-view", reason: null } };
}
