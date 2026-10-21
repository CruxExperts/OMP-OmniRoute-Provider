import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { requiredOmaScope } from "./authorization-policy.ts";
import { sourceRequestIssue, sourceRequestValidatorBinding, type SourceRequestIssue, type SourceRequestValidatorId } from "./source-validation.ts";
import { normalizeSourceRequest, sourceNormalizationBinding, sourceStateViewBinding, sourceRelationViewMatches, type SourceNormalizationId, type SourceStateViewId, type SourceRelationViewId } from "./source-normalization.ts";
import type { AdminAuthDomain, AdminMethod, AdminQueryParameter, AdminRisk, AdminSideEffect, JsonObject, JsonValue } from "./types.ts";
import { escapeControls } from "./types.ts";
import { createEligibilityIndex, eligibilityFor, isVerifiedEligibility, type EligibilityOptions, type OperationEligibilityRecord, type OperationEvidenceBinding, type OperationQualificationReceipt, type OperationSourceContract } from "./eligibility.ts";

export type OMAAccessTokenScope = "read" | "write" | "admin";
export type ManagementAuthorizationAlternative =
  | { readonly kind: "management-api-key"; readonly anyOf: readonly ("manage" | "admin")[] }
  | { readonly kind: "dashboard-session" }
  | { readonly kind: "auth-disabled"; readonly when: "central-and-handler-auth-not-required" }
  | { readonly kind: "oma-access-token"; readonly minimumScope: OMAAccessTokenScope }
  | { readonly kind: "oma-whoami-bootstrap"; readonly operationId: "GET /api/cli/whoami" }
  | { readonly kind: "mcp-connect"; readonly pathPrefix: "/api/mcp/"; readonly handlerOptIn: true }
  | { readonly kind: "runtime-api-key"; readonly sourceScopes: readonly string[] }
  | { readonly kind: "metadata-api-key"; readonly sourceScopes: readonly string[] }
  | { readonly kind: "trusted-local"; readonly loopbackOnly: true };
export type ClientApiAuthorizationAlternative =
  | { readonly kind: "runtime-api-key"; readonly sourceScopes: readonly string[] }
  | { readonly kind: "metadata-api-key"; readonly sourceScopes: readonly string[] }
  | { readonly kind: "anonymous" };
export type OperationSourceAuthorizationPolicy =
  | { readonly status: "unknown" }
  | {
      readonly status: "qualified";
      readonly source: "omniroute-v3.8.52";
      readonly routeClass: "management";
      readonly localOnly: boolean;
      readonly handlerGuard: "none" | "requireManagementAuth";
      readonly bootstrap: "none" | "oma-whoami";
      readonly alternatives: readonly ManagementAuthorizationAlternative[];
    }
  | {
      readonly status: "qualified";
      readonly source: "omniroute-v3.8.52";
      readonly routeClass: "client-api";
      readonly localOnly: boolean;
      readonly alternatives: readonly ClientApiAuthorizationAlternative[];
    }
  | {
      readonly status: "qualified";
      readonly source: "omniroute-v3.8.52";
      readonly routeClass: "public";
      readonly alternatives: readonly [{ readonly kind: "anonymous" }];
    }
  | {
      readonly status: "qualified";
      readonly source: "omniroute-v3.8.52";
      readonly routeClass: "local";
      readonly localOnly: true;
      readonly alternatives: readonly [{ readonly kind: "trusted-local"; readonly loopbackOnly: true }];
    };

export interface JsonSchema {
  readonly $ref?: string;
  readonly type?: string | readonly string[];
  readonly properties?: Readonly<Record<string, JsonSchema>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | JsonSchema;
  readonly "x-key-role"?: "identifier";
  readonly items?: JsonSchema;
  readonly enum?: readonly unknown[];
  readonly const?: unknown;
  readonly oneOf?: readonly JsonSchema[];
  readonly anyOf?: readonly JsonSchema[];
  readonly allOf?: readonly JsonSchema[];
  readonly pattern?: string;
  readonly format?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly minItems?: number;
  readonly maxItems?: number;
  readonly minProperties?: number;
  readonly maxProperties?: number;
  readonly default?: unknown;
}

export interface OperationParameterDescriptor {
  readonly name: string;
  readonly in: "path" | "query" | "header" | "cookie";
  readonly required: boolean;
  readonly style: string;
  readonly explode: boolean;
  readonly allowReserved: boolean;
  readonly schema: JsonSchema;
  readonly inputAllowed: boolean;
  readonly sourceFile?: string;
}

export interface OperationPathParameterDescriptor {
  readonly name: string;
  readonly specName: string;
  readonly serialization: "simple" | "label" | "matrix" | "catch-all-segments";
  readonly required: boolean;
  readonly style?: string;
  readonly explode?: boolean;
}

export interface OperationContentVariant {
  readonly mediaType: string;
  readonly schema: JsonSchema | null;
  readonly sourceFile?: string;
}

export interface OperationInputNormalization {
  readonly section: "path" | "query" | "body";
  readonly path: readonly string[];
  readonly kind: "trim-string" | "trim-string-array";
}

export interface OperationRequest {
  readonly pathSchema: JsonSchema;
  readonly querySchema: JsonSchema;
  readonly pathParameters: readonly OperationPathParameterDescriptor[];
  readonly parameters: readonly OperationParameterDescriptor[];
  readonly body: {
    readonly required: boolean;
    readonly mediaType: string | null;
    readonly schema: JsonSchema | null;
    readonly contentVariants: readonly OperationContentVariant[];
  } | null;
  readonly specificationDocumented: boolean;
  readonly normalizations?: readonly OperationInputNormalization[];
  readonly sourceValidator?: SourceRequestValidatorId;
  readonly sourceNormalizer?: SourceNormalizationId;
}

export interface OperationResponseVariant {
  readonly statusCode: string;
  readonly content: readonly OperationContentVariant[];
  readonly headers: Readonly<Record<string, { readonly required: boolean; readonly schema: JsonSchema | null }>>;
  readonly sourceFiles?: readonly string[];
}

export type ReconciliationInputSection = "path" | "query" | "body" | "result";
export interface ReconciliationFieldMapping {
  readonly target: { readonly section: "path" | "query"; readonly field: string };
  readonly source: { readonly section: ReconciliationInputSection; readonly path: readonly string[] };
}
export interface ReconciliationProjectedField {
  readonly name: string;
  readonly path: readonly string[];
  readonly sourceView?: SourceStateViewId;
}
export interface OperationReconciliationRelation {
  readonly targetRead: {
    readonly operationId: string;
    readonly sourceView?: SourceRelationViewId;
    readonly inputs: readonly ReconciliationFieldMapping[];
    readonly snapshot: {
      readonly kind: "resource" | "collection" | "action";
      readonly identity: readonly ReconciliationProjectedField[];
      readonly state: readonly ReconciliationProjectedField[];
      readonly collectionPath?: readonly string[];
      readonly selection?: {
        readonly input: { readonly section: "path" | "query" | "body"; readonly path: readonly string[] };
        readonly rowPath: readonly string[];
      };
    };
  };
  readonly reconcile: {
    readonly operationId: string;
    readonly inputs: readonly ReconciliationFieldMapping[];
    readonly outcome: {
      readonly kind: "exists" | "absent" | "matches" | "upsert";
      readonly identityFields: readonly string[];
      readonly stateFields: readonly string[];
      readonly expectedFromInput?: readonly {
        readonly name: string;
        readonly source: { readonly section: "path" | "query" | "body"; readonly path: readonly string[] };
        readonly sourceView?: SourceStateViewId;
      }[];
    };
  };
}

export interface OperationDescriptor {
  readonly operationId: string;
  readonly method: AdminMethod;
  readonly pathTemplate: string;
  readonly request: OperationRequest;
  readonly response: {
    readonly statusCodes: readonly string[];
    readonly mediaType: string | null;
    readonly schema: JsonSchema | null;
    readonly variants: readonly OperationResponseVariant[];
  };
  readonly mediaType: { readonly request: string | null; readonly response: string | null };
  readonly auth: {
    readonly domain: AdminAuthDomain;
    readonly specificationAlternatives: readonly JsonValue[];
    readonly sourcePolicy: OperationSourceAuthorizationPolicy;
  };
  readonly secrets: { readonly inputFields: readonly string[]; readonly outputFields: readonly string[] };
  readonly sideEffect: AdminSideEffect;
  readonly pagination: { readonly mode: "none" | "offset" | "cursor" | "unknown"; readonly parameters: readonly string[] };
  readonly streaming: { readonly mode: "json" | "sse" | "websocket" | "binary" | "unknown"; readonly framing: string };
  readonly confirmation: { readonly required: boolean; readonly reason: string };
  readonly retry: { readonly allowed: boolean; readonly maxAttempts: number; readonly statusCodes: readonly number[] };
  readonly source: { readonly file: string; readonly sha256: string; readonly gitBlobSha: string; readonly export: "direct" | "re-export" };
  readonly specification: { readonly documented: boolean; readonly path: string | null; readonly operationId: string | null; readonly discrepancies: readonly unknown[] };
  readonly reconciliation: OperationReconciliationRelation | null;
  readonly coverage: { readonly status: "invokable" | "unqualified" | "non-invokable"; readonly adapterId: string | null; readonly reason: string | null };
  readonly qualification?: OperationQualificationReceipt;
}

export interface ValidatedOperationInput {
  readonly path: JsonObject;
  readonly query: JsonObject;
  readonly body?: JsonValue;
}

export interface OperationAdapter {
  readonly adapterId: string;
  readonly category: string;
  readonly descriptor: OperationDescriptor;
  readonly risk: AdminRisk;
  readonly validate: (input: unknown) => ValidatedOperationInput;
  readonly project: (response: unknown) => unknown;
  /** Exact allowlisted private state for target binding; never model-visible. */
  readonly projectTarget: (response: unknown) => unknown;
  readonly buildPath: (input: ValidatedOperationInput) => string;
  readonly buildQuery: (input: ValidatedOperationInput) => readonly AdminQueryParameter[];
  readonly eligibility: OperationEligibilityRecord;
}

export interface OperationListFilter {
  readonly category?: string;
  readonly method?: AdminMethod;
  readonly sideEffect?: AdminSideEffect;
  readonly authDomain?: OperationDescriptor["auth"]["domain"];
  readonly search?: string;
}

export class RegistryError extends Error {
  readonly code: "unknown-operation" | "non-invokable" | "invalid-input" | "invalid-inventory";
  readonly operationId: string | undefined;
  readonly field: string | undefined;
  constructor(code: RegistryError["code"], message: string, operationId?: string, field?: string) {
    super(escapeControls(message));
    this.name = "RegistryError";
    this.code = code;
    this.operationId = operationId;
    this.field = field;
  }
}

type RawRecord = Record<string, unknown>;
type SchemaDocument = RawRecord;
let inventoryDocument: SchemaDocument | undefined;
let contractSchemaDocument: SchemaDocument | undefined;

function readContractSchema(): SchemaDocument | undefined {
  if (contractSchemaDocument) return contractSchemaDocument;
  const path = resolve(import.meta.dir, "../../contracts/operations.schema.json");
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isRecord(parsed)) throw new Error("schema is not an object");
    contractSchemaDocument = parsed;
    return parsed;
  } catch {
    return undefined;
  }
}
const METHODS: readonly AdminMethod[] = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];
const METHOD_SET = new Set<string>(METHODS);
const RISK_ORDER: Record<AdminSideEffect, AdminRisk> = {
  read: "read",
  unknown: "gated-read",
  mutation: "mutation",
  secret: "secret",
  lifecycle: "lifecycle",
  destructive: "destructive",
};
const SECRET_NAMES = new Set([
  "apiKey", "api_key", "apikey", "api-key", "password", "passwd", "secret", "clientSecret", "client_secret",
  "authorization", "cookie", "set-cookie", "accessToken", "access_token", "refreshToken", "refresh_token", "auth_token", "token",
]);
const NON_NEGATIVE_SAFE_INTEGER = (value: unknown): boolean => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const BENIGN_TOKEN_METADATA: Readonly<Record<string, (value: unknown) => boolean>> = {
  "max_input_tokens": NON_NEGATIVE_SAFE_INTEGER,
  "max_output_tokens": NON_NEGATIVE_SAFE_INTEGER,
  "outputtokenlimit": NON_NEGATIVE_SAFE_INTEGER,
  "reasoningtokenbufferenabled": value => typeof value === "boolean",
};

function isRecord(value: unknown): value is RawRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertRecord(value: unknown, label: string): RawRecord {
  if (!isRecord(value)) throw new RegistryError("invalid-inventory", `${label} must be an object`);
  return value;
}

function assertString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new RegistryError("invalid-inventory", `${label} must be a non-empty string`);
  return value;
}
const OMA_SCOPES: Readonly<Record<string, true>> = { read: true, write: true, admin: true };
const MANAGEMENT_KEY_SCOPES: Readonly<Record<string, true>> = { manage: true, admin: true };

function exactKeys(value: RawRecord, keys: readonly string[], operationId: string): void {
  if (Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key))) {
    throw new RegistryError("invalid-inventory", "authorization policy has an invalid shape", operationId);
  }
}

function sourceScopeList(value: unknown, operationId: string): void {
  if (!Array.isArray(value) || value.some(scope => typeof scope !== "string" || !scope || /[\u0000-\u001f\u007f]/.test(scope))
    || new Set(value).size !== value.length) {
    throw new RegistryError("invalid-inventory", "authorization policy scope list is invalid", operationId);
  }
}

function assertAuthorizationAlternative(value: unknown, routeClass: string, descriptor: OperationDescriptor): void {
  const operationId = descriptor.operationId;
  const alternative = assertRecord(value, `${operationId}.auth.sourcePolicy alternative`);
  const kind = alternative.kind;
  const allowed = routeClass === "management"
    ? ["management-api-key", "dashboard-session", "auth-disabled", "oma-access-token", "oma-whoami-bootstrap", "mcp-connect", "runtime-api-key", "metadata-api-key", "trusted-local"]
    : routeClass === "client-api"
      ? ["runtime-api-key", "metadata-api-key", "anonymous"]
      : routeClass === "public" ? ["anonymous"] : ["trusted-local"];
  if (typeof kind !== "string" || !allowed.includes(kind)) {
    throw new RegistryError("invalid-inventory", "authorization alternative is not valid for its source route class", operationId);
  }
  switch (kind) {
    case "management-api-key":
      exactKeys(alternative, ["kind", "anyOf"], operationId);
      if (!Array.isArray(alternative.anyOf) || alternative.anyOf.length === 0
        || alternative.anyOf.some(scope => typeof scope !== "string" || MANAGEMENT_KEY_SCOPES[scope] !== true)
        || new Set(alternative.anyOf).size !== alternative.anyOf.length) {
        throw new RegistryError("invalid-inventory", "management API-key authorization alternative is invalid", operationId);
      }
      return;
    case "dashboard-session":
    case "anonymous":
      exactKeys(alternative, ["kind"], operationId);
      return;
    case "auth-disabled":
      exactKeys(alternative, ["kind", "when"], operationId);
      if (alternative.when !== "central-and-handler-auth-not-required") {
        throw new RegistryError("invalid-inventory", "conditional management authorization must retain its server-enforced condition", operationId);
      }
      return;
    case "oma-access-token":
      exactKeys(alternative, ["kind", "minimumScope"], operationId);
      if (typeof alternative.minimumScope !== "string" || OMA_SCOPES[alternative.minimumScope] !== true) {
        throw new RegistryError("invalid-inventory", "OMA scope requirement is invalid", operationId);
      }
      if (alternative.minimumScope !== requiredOmaScope(descriptor.method, descriptor.pathTemplate)) {
        throw new RegistryError("invalid-inventory", "OMA scope requirement differs from pinned source policy", operationId);
      }
      return;
    case "oma-whoami-bootstrap":
      exactKeys(alternative, ["kind", "operationId"], operationId);
      if (alternative.operationId !== "GET /api/cli/whoami") throw new RegistryError("invalid-inventory", "OMA bootstrap operation is invalid", operationId);
      return;
    case "mcp-connect":
      exactKeys(alternative, ["kind", "pathPrefix", "handlerOptIn"], operationId);
      if (alternative.pathPrefix !== "/api/mcp/" || alternative.handlerOptIn !== true
        || !descriptor.pathTemplate.startsWith("/api/mcp/")) {
        throw new RegistryError("invalid-inventory", "MCP authorization exception is not bound to its opted-in route", operationId);
      }
      return;
    case "runtime-api-key":
    case "metadata-api-key":
      exactKeys(alternative, ["kind", "sourceScopes"], operationId);
      sourceScopeList(alternative.sourceScopes, operationId);
      return;
    case "trusted-local":
      exactKeys(alternative, ["kind", "loopbackOnly"], operationId);
      if (alternative.loopbackOnly !== true) throw new RegistryError("invalid-inventory", "trusted-local authorization must be loopback-only", operationId);
      return;
  }
}

function assertSourceAuthorizationPolicy(descriptor: OperationDescriptor): void {
  const raw = descriptor.auth?.sourcePolicy as unknown;
  const operationId = descriptor.operationId;
  const policy = assertRecord(raw, `${operationId}.auth.sourcePolicy`);
  if (policy.status === "unknown") {
    exactKeys(policy, ["status"], operationId);
    return;
  }
  if (policy.status !== "qualified" || policy.source !== "omniroute-v3.8.52" || !Array.isArray(policy.alternatives)) {
    throw new RegistryError("invalid-inventory", "authorization policy is not source-qualified", operationId);
  }
  if (policy.alternatives.length === 0) throw new RegistryError("invalid-inventory", "authorization policy has no alternatives", operationId);
  const routeClass = policy.routeClass;
  if (routeClass === "management") {
    exactKeys(policy, ["status", "source", "routeClass", "localOnly", "handlerGuard", "bootstrap", "alternatives"], operationId);
    if (typeof policy.localOnly !== "boolean" || (policy.handlerGuard !== "none" && policy.handlerGuard !== "requireManagementAuth")
      || (policy.bootstrap !== "none" && policy.bootstrap !== "oma-whoami")) {
      throw new RegistryError("invalid-inventory", "management authorization policy is invalid", operationId);
    }
  } else if (routeClass === "client-api") {
    exactKeys(policy, ["status", "source", "routeClass", "localOnly", "alternatives"], operationId);
    if (typeof policy.localOnly !== "boolean") throw new RegistryError("invalid-inventory", "client API authorization policy is invalid", operationId);
  } else if (routeClass === "public") {
    exactKeys(policy, ["status", "source", "routeClass", "alternatives"], operationId);
  } else if (routeClass === "local") {
    exactKeys(policy, ["status", "source", "routeClass", "localOnly", "alternatives"], operationId);
    if (policy.localOnly !== true) throw new RegistryError("invalid-inventory", "local authorization policy must be loopback-only", operationId);
  } else {
    throw new RegistryError("invalid-inventory", "authorization route class is unsupported", operationId);
  }
  for (const alternative of policy.alternatives) assertAuthorizationAlternative(alternative, routeClass, descriptor);
  if (routeClass === "public" && (policy.alternatives.length !== 1
    || !isRecord(policy.alternatives[0]) || policy.alternatives[0].kind !== "anonymous")) {
    throw new RegistryError("invalid-inventory", "public authorization must be an explicit anonymous alternative", operationId);
  }
  if (routeClass === "local" && (policy.alternatives.length !== 1
    || !isRecord(policy.alternatives[0]) || policy.alternatives[0].kind !== "trusted-local")) {
    throw new RegistryError("invalid-inventory", "local authorization must be an explicit trusted-local alternative", operationId);
  }
  const bootstrapAlternatives = policy.alternatives.filter(item => isRecord(item) && item.kind === "oma-whoami-bootstrap");
  if (policy.bootstrap === "oma-whoami") {
    if (routeClass !== "management" || operationId !== "GET /api/cli/whoami" || descriptor.method !== "GET"
      || descriptor.pathTemplate !== "/api/cli/whoami" || bootstrapAlternatives.length !== 1) {
      throw new RegistryError("invalid-inventory", "OMA bootstrap is not bound to the qualified whoami operation", operationId);
    }
  } else if (bootstrapAlternatives.length !== 0 || operationId === "GET /api/cli/whoami") {
    throw new RegistryError("invalid-inventory", "whoami must use its exact non-recursive bootstrap policy", operationId);
  }
  const domain = descriptor.auth.domain;
  if (domain === "unknown") throw new RegistryError("invalid-inventory", "qualified authorization policy has an unknown credential domain", operationId);
  const alternatives = policy.alternatives.filter(isRecord);
  const has = (kind: string): boolean => alternatives.some(item => item.kind === kind);
  const compatible = domain === "management"
    ? routeClass === "management" && ["management-api-key", "dashboard-session", "oma-access-token", "oma-whoami-bootstrap", "mcp-connect", "trusted-local"].some(has)
    : domain === "runtime"
      ? ["client-api", "management"].includes(routeClass) && has("runtime-api-key")
      : domain === "metadata"
        ? ["client-api", "management"].includes(routeClass) && has("metadata-api-key")
        : domain === "public"
          ? routeClass === "public" && has("anonymous")
          : routeClass === "local" || (routeClass === "management" && has("trusted-local"));
  if (!compatible) throw new RegistryError("invalid-inventory", "authorization policy does not match its credential domain", operationId);
}

function assertRequestSourceValidator(descriptor: OperationDescriptor): void {
  const validator = descriptor.request?.sourceValidator as unknown;
  if (validator === undefined) return;
  const expected = sourceRequestValidatorBinding(validator);
  if (!expected || !expected.methods.includes(descriptor.method) || expected.pathTemplate !== descriptor.pathTemplate) {
    throw new RegistryError("invalid-inventory", "source request validator is not allowed for this operation", descriptor.operationId);
  }
}

function assertSourceNormalizationUse(descriptor: OperationDescriptor): void {
  const normalizer: unknown = descriptor.request.sourceNormalizer;
  if (normalizer !== undefined) {
    const binding = sourceNormalizationBinding(normalizer);
    if (!binding || !binding.methods.includes(descriptor.method) || descriptor.pathTemplate !== binding.pathTemplate) {
      throw new RegistryError("invalid-inventory", "source normalizer does not match its closed operation", descriptor.operationId);
    }
  }
  const relation = descriptor.reconciliation;
  if (!relation) return;
  if (relation.targetRead.sourceView !== undefined
    && (descriptor.operationId !== `${descriptor.method} ${descriptor.pathTemplate}`
      || !sourceRelationViewMatches(relation.targetRead.sourceView, descriptor.operationId,
        relation.targetRead.operationId, relation.reconcile.operationId, relation.reconcile.outcome.kind))) {
    throw new RegistryError("invalid-inventory", "source relation view does not match its exact mutation and read operations", descriptor.operationId);
  }
  for (const field of relation.targetRead.snapshot.identity) {
    if (field.sourceView !== undefined) throw new RegistryError("invalid-inventory", "configuration state views cannot redefine resource identity", descriptor.operationId);
  }
  for (const field of relation.targetRead.snapshot.state) {
    if (field.sourceView === undefined) continue;
    const binding = sourceStateViewBinding(field.sourceView);
    if (!binding || relation.targetRead.operationId !== `${binding.readMethod} ${binding.pathTemplate}`) {
      throw new RegistryError("invalid-inventory", "source state view does not match its closed target read", descriptor.operationId);
    }
  }
  for (const field of relation.reconcile.outcome.expectedFromInput ?? []) {
    if (field.sourceView === undefined) continue;
    const binding = sourceStateViewBinding(field.sourceView);
    const target = relation.targetRead.snapshot.state.find(candidate => candidate.name === field.name);
    if (!binding || !binding.methods.includes(descriptor.method) || descriptor.pathTemplate !== binding.pathTemplate
      || relation.reconcile.operationId !== `${binding.readMethod} ${binding.pathTemplate}`
      || target?.sourceView !== field.sourceView || field.source.section !== "body" || field.source.path.length !== 0) {
      throw new RegistryError("invalid-inventory", "expected source state view does not match its closed mutation", descriptor.operationId);
    }
  }
}
function validateSourceRequest(descriptor: OperationDescriptor, body: unknown): void {
  const validatorId = descriptor.request.sourceValidator;
  if (validatorId === undefined) return;
  let issue: SourceRequestIssue | undefined;
  try {
    issue = sourceRequestIssue(validatorId, body);
  } catch {
    throw new RegistryError("invalid-inventory", "source request validator failed closed", descriptor.operationId);
  }
  if (!issue) return;
  const field = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z][A-Za-z0-9]*)*$/.test(issue.field) ? issue.field : "body";
  throw new RegistryError("invalid-input", "source-specific request validation failed", descriptor.operationId, field);
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as RawRecord)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

function loadInventory(): OperationDescriptor[] {
  const path = resolve(import.meta.dir, "../../contracts/operations.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    throw new RegistryError("invalid-inventory", `operation inventory unavailable: ${error instanceof Error ? error.name : "read-failure"}`);
  }
  const root = assertRecord(parsed, "operation inventory");
  inventoryDocument = root;
  if (!Array.isArray(root.operations)) throw new RegistryError("invalid-inventory", "operation inventory operations must be an array");
  const seen = new Set<string>();
  const descriptors: OperationDescriptor[] = [];
  for (const item of root.operations) {
    const operation = assertRecord(item, "operation descriptor");
    const operationId = assertString(operation.operationId, "operationId");
    if (seen.has(operationId)) throw new RegistryError("invalid-inventory", `duplicate operation ${operationId}`);
    seen.add(operationId);
    const method = assertString(operation.method, `${operationId}.method`);
    if (!METHOD_SET.has(method)) throw new RegistryError("invalid-inventory", `unsupported method ${method}`);
    const descriptor = operation as unknown as OperationDescriptor;
    if (descriptor.coverage.status === "invokable" && !descriptor.coverage.adapterId) throw new RegistryError("invalid-inventory", `missing adapter for ${operationId}`);
    descriptors.push(descriptor);
  }
  return descriptors;
}

function categoryFor(pathTemplate: string): string {
  const parts = pathTemplate.split("/").filter(Boolean);
  const first = parts[0];
  if (!first) return "root";
  if (first === "api") {
    const section = parts[1];
    return section && !section.startsWith("{") ? `api/${section}` : "api";
  }
  return first;

}
function assertJsonValue(value: unknown, path: string, depth = 0): asserts value is JsonValue {
  if (depth > 24) throw new RegistryError("invalid-input", "JSON depth limit exceeded", undefined, path);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (Number.isFinite(value)) return;
    throw new RegistryError("invalid-input", "number must be finite", undefined, path);
  }
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) assertJsonValue(value[index], `${path}[${index}]`, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const [key, child] of Object.entries(value)) {
      assertJsonValue(child, `${path}.${key}`, depth + 1);
    }
    return;
  }
  throw new RegistryError("invalid-input", "value must be JSON", undefined, path);
}
function schemaRefTarget(ref: string, operationId: string): JsonSchema {
  if (!ref.startsWith("#/") || /(?:^|\/)\.\.(?:\/|$)/.test(ref)) {
    throw new RegistryError("invalid-inventory", `external or unsafe schema reference ${ref}`, operationId);
  }
  const segments = ref.slice(2).split("/").map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
  const roots = [inventoryDocument, readContractSchema()].filter((root): root is SchemaDocument => root !== undefined);
  for (const root of roots) {
    let current: unknown = root;
    for (const segment of segments) {
      if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) {
        current = undefined;
        break;
      }
      current = current[segment];
    }
    if (isRecord(current)) return current as JsonSchema;
  }
  throw new RegistryError("invalid-inventory", `unknown local schema reference ${ref}`, operationId);
}

function resolveSchema(schema: JsonSchema, operationId: string, seen = new Set<string>()): JsonSchema {
  const ref = schema.$ref;
  if (!ref) return schema;
  if (seen.has(ref)) throw new RegistryError("invalid-inventory", `cyclic schema reference ${ref}`, operationId);
  const nextSeen = new Set(seen);
  nextSeen.add(ref);
  const target = resolveSchema(schemaRefTarget(ref, operationId), operationId, nextSeen);
  const { $ref: _ignored, ...siblings } = schema;
  return Object.keys(siblings).length === 0 ? target : { allOf: [target, siblings] };
}


function schemaTypeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case "object": return isRecord(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: throw new RegistryError("invalid-inventory", `unsupported JSON schema type ${type}`);
  }
}

function schemaError(operationId: string, field: string, detail: string): never {
  throw new RegistryError("invalid-input", `${field}: ${detail}`, operationId, field);
}

function normalizeOperationInput(descriptor: OperationDescriptor, input: JsonObject): void {
  if (descriptor.request.sourceNormalizer !== undefined) {
    const binding = sourceNormalizationBinding(descriptor.request.sourceNormalizer);
    if (!binding) throw new RegistryError("invalid-inventory", "unknown source normalizer", descriptor.operationId);
    const value = input[binding.section] ?? (binding.section === "query" ? {} : undefined);
    if (value !== undefined) {
      try { input[binding.section] = normalizeSourceRequest(descriptor.request.sourceNormalizer, value); }
      catch { schemaError(descriptor.operationId, binding.section, "source-specific normalization failed"); }
    }
  }
  for (const normalization of descriptor.request.normalizations ?? []) {
    if (normalization.path.length === 0 || normalization.path.some(key => ["__proto__", "prototype", "constructor"].includes(key))) {
      throw new RegistryError("invalid-inventory", "invalid normalization field path", descriptor.operationId);
    }
    let container: unknown = input[normalization.section];
    for (const key of normalization.path.slice(0, -1)) {
      container = isRecord(container) && Object.hasOwn(container, key) ? container[key] : undefined;
    }
    const field = normalization.path[normalization.path.length - 1]!;
    if (!isRecord(container) || !Object.hasOwn(container, field)) continue;
    const value = container[field];
    if (normalization.kind === "trim-string") {
      if (typeof value !== "string") schemaError(descriptor.operationId, field, "must be a string");
      container[field] = value.trim();
    } else if (normalization.kind === "trim-string-array") {
      if (!Array.isArray(value) || value.some(item => typeof item !== "string")) schemaError(descriptor.operationId, field, "must be a string array");
      container[field] = value.map((item: string) => item.trim());
    } else {
      throw new RegistryError("invalid-inventory", "unsupported source normalization", descriptor.operationId);
    }
  }
}

function validateSchema(schema: JsonSchema | null | undefined, value: unknown, field: string, operationId: string, depth = 0): void {
  if (!schema) return;
  if (depth > 24) throw new RegistryError("invalid-inventory", "schema depth limit exceeded", operationId, field);
  schema = resolveSchema(schema, operationId);
  const matches = (candidate: JsonSchema): boolean => {
    try { validateSchema(candidate, value, field, operationId, depth + 1); return true; }
    catch (error) {
      if (error instanceof RegistryError && error.code === "invalid-input") return false;
      throw error;
    }
  };
  if (schema.oneOf && schema.oneOf.filter(matches).length !== 1) schemaError(operationId, field, "does not match exactly one allowed shape");
  if (schema.anyOf && !schema.anyOf.some(matches)) schemaError(operationId, field, "does not match an allowed shape");
  for (const candidate of schema.allOf ?? []) validateSchema(candidate, value, field, operationId, depth + 1);
  if (schema.enum && !schema.enum.some(allowed => canonicalizeJson(allowed) === canonicalizeJson(value))) schemaError(operationId, field, "has an invalid value");
  if (Object.hasOwn(schema, "const") && canonicalizeJson(schema.const) !== canonicalizeJson(value)) schemaError(operationId, field, "does not match the constant value");
  const types = schema.type === undefined ? [] : (typeof schema.type === "string" ? [schema.type] : schema.type);
  if (types.length > 0 && !types.some(type => schemaTypeMatches(type, value))) schemaError(operationId, field, "has an invalid type");
  if (typeof value === "string") {
    if (schema.minLength !== undefined || schema.maxLength !== undefined) {
      let length = 0;
      for (const _character of value) length++;
      if (schema.minLength !== undefined && length < schema.minLength) schemaError(operationId, field, "is too short");
      if (schema.maxLength !== undefined && length > schema.maxLength) schemaError(operationId, field, "is too long");
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) schemaError(operationId, field, "has an invalid format");
    if (schema.format === "date-time") {
      const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|([+-])(\d{2}):(\d{2}))$/i.exec(value);
      const date = match ? new Date(`${match[1]}T00:00:00Z`) : undefined;
      if (!match || !date || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== match[1]
        || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59 || Number(match[6] ?? 0) > 23 || Number(match[7] ?? 0) > 59 || !Number.isFinite(Date.parse(value))) schemaError(operationId, field, "is not a date-time");
    } else if (schema.format === "byte") {
      const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
        || (value.endsWith("==") && (alphabet.indexOf(value[value.length - 3]!) & 15) !== 0)
        || (!value.endsWith("==") && value.endsWith("=") && (alphabet.indexOf(value[value.length - 2]!) & 3) !== 0)) schemaError(operationId, field, "is not canonical base64");
    } else if (schema.format === "uri") {
      try { new URL(value); } catch { schemaError(operationId, field, "is not an absolute URI"); }
    } else if (schema.format === "uuid" && !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value)) {
      schemaError(operationId, field, "is not a UUID");
    } else if (schema.format !== undefined && !["binary", "byte", "uuid", "date-time", "uri"].includes(schema.format)) {
      throw new RegistryError("invalid-inventory", `unsupported schema format ${schema.format}`, operationId, field);
    }
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) schemaError(operationId, field, "is below minimum");
    if (schema.maximum !== undefined && value > schema.maximum) schemaError(operationId, field, "is above maximum");
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) schemaError(operationId, field, "is below exclusive minimum");
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) schemaError(operationId, field, "is above exclusive maximum");
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) schemaError(operationId, field, "has too few items");
    if (schema.maxItems !== undefined && value.length > schema.maxItems) schemaError(operationId, field, "has too many items");
    if (schema.items) value.forEach((item, index) => validateSchema(schema.items, item, `${field}[${index}]`, operationId, depth + 1));
  }
  if (isRecord(value)) {
    const properties = schema.properties ?? {};
    if (schema.minProperties !== undefined || schema.maxProperties !== undefined) {
      const count = Object.keys(value).length;
      if (schema.minProperties !== undefined && count < schema.minProperties) schemaError(operationId, field, "has too few properties");
      if (schema.maxProperties !== undefined && count > schema.maxProperties) schemaError(operationId, field, "has too many properties");
    }
    for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) schemaError(operationId, `${field}.${required}`, "is required");
    for (const [key, child] of Object.entries(value)) {
      const childSchema = Object.hasOwn(properties, key) ? properties[key] : undefined;
      if (childSchema) validateSchema(childSchema, child, `${field}.${key}`, operationId, depth + 1);
      else if (schema.additionalProperties === false) schemaError(operationId, `${field}.${key}`, "is not allowed");
      else if (isRecord(schema.additionalProperties)) validateSchema(schema.additionalProperties, child, `${field}.${key}`, operationId, depth + 1);
    }
  }
}
function validateMultipartBody(body: unknown, operationId: string): void {
  if (!isRecord(body)) schemaError(operationId, "body", "must be an object");
  const files = body.files;
  if (files !== undefined) {
    if (!Array.isArray(files)) schemaError(operationId, "body.files", "must be an array");
    files.forEach((entry, index) => {
      if (!isRecord(entry)) schemaError(operationId, `body.files[${index}]`, "must be an object");
      const allowed = new Set(["field", "path", "filename", "contentType"]);
      for (const key of Object.keys(entry)) if (!allowed.has(key)) schemaError(operationId, `body.files[${index}].${key}`, "is not allowed");
      for (const required of ["field", "path"]) {
        if (typeof entry[required] !== "string" || entry[required].length === 0) schemaError(operationId, `body.files[${index}].${required}`, "must be a non-empty string");
      }
      const field = entry.field as string;
      const path = entry.path as string;
      if (/[\u0000-\u001f\u007f]/.test(field) || field.length > 200) schemaError(operationId, `body.files[${index}].field`, "contains unsafe characters");
      if (!isAbsolute(path) || /[\u0000\r\n]/.test(path)) schemaError(operationId, `body.files[${index}].path`, "must be an absolute path without control characters");
      if (entry.filename !== undefined && (typeof entry.filename !== "string" || entry.filename.length === 0 || entry.filename.length > 255 || /[\\/\u0000-\u001f\u007f]/.test(entry.filename))) {
        schemaError(operationId, `body.files[${index}].filename`, "is invalid");
      }
      if (entry.contentType !== undefined && (typeof entry.contentType !== "string" || entry.contentType.length === 0 || entry.contentType.length > 256 || /[\u0000-\u001f\u007f]/.test(entry.contentType) || !/^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}\/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}(?:\s*;\s*[A-Za-z0-9!#$&^_.+-]+=[A-Za-z0-9!#$&^_.+-]+)*$/.test(entry.contentType))) {
        schemaError(operationId, `body.files[${index}].contentType`, "is invalid");
      }
    });
  }
  if (body.fields !== undefined) {
    if (!isRecord(body.fields)) schemaError(operationId, "body.fields", "must be an object");
    assertJsonValue(body.fields, "body.fields");
  }
}


function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (isRecord(value)) return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]));
  return value;
}

export function canonicalizeJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function encodePathValue(value: JsonValue, operationId: string, field: string): string {
  if (value === null || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")) {
    schemaError(operationId, field, "must be a primitive path value");
  }
  const text = String(value);
  if (text.length === 0) schemaError(operationId, field, "must not be empty");
  let decoded = text;
  for (let boundary = 0; boundary < 2; boundary++) {
    if (decoded === "." || decoded === ".." || /[\\/\u0000-\u001f\u007f]/.test(decoded)) {
      schemaError(operationId, field, "contains an unsafe path segment");
    }
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      schemaError(operationId, field, "contains invalid encoding");
    }
  }
  if (decoded === "." || decoded === ".." || /[\\/\u0000-\u001f\u007f]/.test(decoded)) {
    schemaError(operationId, field, "contains an ambiguous path segment");
  }
  return encodeURIComponent(text);
}

function serializePathValue(value: JsonValue, parameter: OperationPathParameterDescriptor, operationId: string): string {
  const field = `path.${parameter.name}`;
  const style = parameter.serialization;
  if (style === "catch-all-segments") {
    if (typeof value !== "string") schemaError(operationId, field, "must be a string of path segments");
    if (value.length === 0) {
      if (!parameter.required) return "";
      schemaError(operationId, field, "must contain at least one path segment");
    }
    const segments = value.split("/");
    if (segments.some((segment) => segment.length === 0)) schemaError(operationId, field, "must not contain empty path segments");
    return segments.map((segment) => encodePathValue(segment, operationId, field)).join("/");
  }

  const encode = (item: JsonValue): string => encodePathValue(item, operationId, field);
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    const encoded = encode(value);
    if (style === "label") return `.${encoded}`;
    if (style === "matrix") return `;${encodeURIComponent(parameter.specName)}=${encoded}`;
    return encoded;
  }
  if (value === null) schemaError(operationId, field, "must not be null");

  const explode = parameter.explode === true;
  if (Array.isArray(value)) {
    if (value.length === 0) schemaError(operationId, field, "must not be an empty array");
    const items = value.map(encode);
    if (style === "label" && explode) return `.${items.join(".")}`;
    if (style === "matrix" && explode) return items.map((item) => `;${encodeURIComponent(parameter.specName)}=${item}`).join("");
    const joined = items.join(",");
    if (style === "label") return `.${joined}`;
    if (style === "matrix") return `;${encodeURIComponent(parameter.specName)}=${joined}`;
    return joined;
  }

  const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length === 0) schemaError(operationId, field, "must not be an empty object");
  const encodedEntries = entries.map(([key, item]) => [encodePathValue(key, operationId, field), encode(item)] as const);
  if (style === "matrix" && explode) {
    return encodedEntries.map(([key, item]) => `;${key}=${item}`).join("");
  }
  const pairs = encodedEntries.flatMap(([key, item]) => explode ? [`${key}=${item}`] : [key, item]);
  const delimiter = style === "label" && explode ? "." : ",";
  const joined = pairs.join(delimiter);
  if (style === "label") return `.${joined}`;
  if (style === "matrix") return `;${encodeURIComponent(parameter.specName)}=${joined}`;
  return joined;
}

function buildPath(pathTemplate: string, path: JsonObject, operationId: string, parameters: readonly OperationPathParameterDescriptor[]): string {
  const byName = new Map(parameters.map((parameter) => [parameter.name, parameter]));
  const built = pathTemplate.replace(/\/\{([A-Za-z0-9._~-]+)\}/g, (_, key: string) => {
    const parameter = byName.get(key);
    if (!parameter) throw new RegistryError("invalid-inventory", `path parameter ${key} has no serialization descriptor`, operationId, `path.${key}`);
    const value = path[key];
    if (value === undefined) {
      if (!parameter.required) return "";
      schemaError(operationId, `path.${key}`, "is required");
    }
    const serialized = serializePathValue(value, parameter, operationId);
    return serialized === "" ? "" : `/${serialized}`;
  });
  if (/\{/.test(built)) schemaError(operationId, "path", "is missing a required parameter");
  return built;
}

function encodeQueryAtom(value: unknown, parameter: OperationParameterDescriptor, operationId: string): string {
  if (value === null || (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean")) {
    throw new RegistryError("invalid-input", `query.${parameter.name} must contain only primitive values`, operationId, `query.${parameter.name}`);
  }
  const encoded = encodeURIComponent(String(value));
  return parameter.allowReserved
    ? encoded.replace(/%(?:3A|2F|3F|40|21|24|27|28|29|2A|2C|3B|5B|5D)/gi, (escape) => String.fromCharCode(Number.parseInt(escape.slice(1), 16)))
    : encoded;
}

function buildQuery(query: JsonObject, parameters: readonly OperationParameterDescriptor[], operationId: string): readonly AdminQueryParameter[] {
  const byName = new Map(parameters.filter((parameter) => parameter.in === "query").map((parameter) => [parameter.name, parameter]));
  const serialized: AdminQueryParameter[] = [];
  const append = (name: string, value: string): void => {
    serialized.push({ encodedName: name, encodedValue: value });
  };
  for (const name of Object.keys(query).sort()) {
    const parameter = byName.get(name);
    if (!parameter) throw new RegistryError("invalid-inventory", `query parameter ${name} has no serialization descriptor`, operationId, `query.${name}`);
    if (!parameter.inputAllowed || typeof parameter.explode !== "boolean" || typeof parameter.allowReserved !== "boolean") {
      throw new RegistryError("invalid-inventory", `query parameter ${name} has invalid serialization metadata`, operationId, `query.${name}`);
    }
    const encodedName = encodeURIComponent(parameter.name);
    const value = query[name]!;
    const encode = (item: unknown): string => encodeQueryAtom(item, parameter, operationId);
    if (Array.isArray(value)) {
      if (value.length === 0) throw new RegistryError("invalid-input", `query.${name} must not be an empty array`, operationId, `query.${name}`);
      if (parameter.style === "form" && parameter.explode) {
        for (const item of value) append(encodedName, encode(item));
      } else if (parameter.style === "form") {
        append(encodedName, value.map(encode).join(","));
      } else if (parameter.style === "spaceDelimited" && !parameter.explode) {
        append(encodedName, value.map(encode).join("%20"));
      } else if (parameter.style === "pipeDelimited" && !parameter.explode) {
        append(encodedName, value.map(encode).join("|"));
      } else {
        throw new RegistryError("invalid-inventory", `query array ${name} has unsupported ${parameter.style} serialization`, operationId, `query.${name}`);
      }
      continue;
    }
    if (isRecord(value)) {
      const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right));
      if (entries.length === 0) throw new RegistryError("invalid-input", `query.${name} must not be an empty object`, operationId, `query.${name}`);
      if (parameter.style === "deepObject" && parameter.explode) {
        for (const [property, item] of entries) append(`${encodedName}%5B${encodeURIComponent(property)}%5D`, encode(item));
      } else if (parameter.style === "form" && parameter.explode) {
        for (const [property, item] of entries) append(encodeURIComponent(property), encode(item));
      } else if (parameter.style === "form") {
        append(encodedName, entries.flatMap(([property, item]) => [encodeURIComponent(property), encode(item)]).join(","));
      } else {
        throw new RegistryError("invalid-inventory", `query object ${name} has unsupported ${parameter.style} serialization`, operationId, `query.${name}`);
      }
      continue;
    }
    if (parameter.style === "deepObject" || parameter.style === "spaceDelimited" || parameter.style === "pipeDelimited") {
      throw new RegistryError("invalid-inventory", `query scalar ${name} has unsupported ${parameter.style} serialization`, operationId, `query.${name}`);
    }
    append(encodedName, encode(value));
  }
  return serialized;
}

export function isSecretOutputField(
  key: string,
  value: unknown,
  parentPath: readonly string[] = [],
  explicitSecretPaths: readonly string[] = [],
): boolean {
  const fieldPath = [...parentPath, key].join(".").toLowerCase();
  const lowerKey = key.toLowerCase();
  if (explicitSecretPaths.some(field => {
    const normalized = field.toLowerCase();
    return normalized.includes(".") ? normalized === fieldPath : normalized === lowerKey;
  })) return true;

  const benignValue = Object.hasOwn(BENIGN_TOKEN_METADATA, lowerKey) ? BENIGN_TOKEN_METADATA[lowerKey] : undefined;
  if (benignValue?.(value)) return false;
  return SECRET_NAMES.has(key) || /(?:secret|password|token|credential|authorization|cookie|api[-_]?key)/i.test(key);
}

function projectionShape(schema: JsonSchema, value: unknown, descriptor: OperationDescriptor, depth: number): JsonSchema {
  if (depth > 24) throw new RegistryError("invalid-inventory", "response schema depth limit exceeded", descriptor.operationId);
  schema = resolveSchema(schema, descriptor.operationId);
  if (schema["x-key-role"] !== undefined
    && (schema["x-key-role"] !== "identifier" || schema.type !== "object" || !isRecord(schema.additionalProperties))) {
    throw new RegistryError("invalid-inventory", "identifier keys require an explicitly typed object map", descriptor.operationId);
  }
  if (!schema.oneOf && !schema.anyOf && !schema.allOf) return schema;
  const { oneOf, anyOf, allOf, ...base } = schema;
  const matches = (candidate: JsonSchema): boolean => {
    try { validateSchema(candidate, value, "response", descriptor.operationId); return true; }
    catch (error) { if (error instanceof RegistryError && error.code === "invalid-input") return false; throw error; }
  };
  const selected: JsonSchema[] = [base, ...(allOf ?? [])];
  if (oneOf) {
    const branches = oneOf.filter(matches);
    if (branches.length !== 1) schemaError(descriptor.operationId, "response", "does not match exactly one response variant");
    selected.push(branches[0]!);
  }
  if (anyOf) {
    const branches = anyOf.filter(matches);
    if (branches.length === 0) schemaError(descriptor.operationId, "response", "does not match a response variant");
    selected.push(...branches);
  }
  const properties: Record<string, JsonSchema> = Object.create(null);
  const items: JsonSchema[] = [];
  let additionalProperties: JsonSchema | false | undefined;
  let identifierKeys = true;
  const required = new Set<string>();
  for (const candidate of selected) {
    validateSchema(candidate, value, "response", descriptor.operationId);
    const shape = projectionShape(candidate, value, descriptor, depth + 1);
    for (const [name, child] of Object.entries(shape.properties ?? {})) {
      properties[name] = Object.hasOwn(properties, name) ? { allOf: [properties[name]!, child] } : child;
    }
    for (const name of shape.required ?? []) required.add(name);
    if (shape.items) items.push(shape.items);
    if (shape.additionalProperties === false) additionalProperties = false;
    else if (additionalProperties !== false && isRecord(shape.additionalProperties)) {
      additionalProperties = additionalProperties ? { allOf: [additionalProperties, shape.additionalProperties] } : shape.additionalProperties;
      identifierKeys &&= shape["x-key-role"] === "identifier";
    }
  }
  return {
    type: value === null ? "null" : Array.isArray(value) ? "array" : typeof value,
    ...(isRecord(value) ? {
      properties, required: [...required], additionalProperties: additionalProperties ?? false,
      ...(additionalProperties && identifierKeys ? { "x-key-role": "identifier" as const } : {}),
    } : {}),
    ...(items.length === 0 ? {} : { items: items.length === 1 ? items[0]! : { allOf: items } }),
  };
}

function setProjectedField(output: JsonObject, field: string, value: JsonValue): void {
  if (field === "__proto__") Object.defineProperty(output, field, { value, enumerable: true, configurable: true, writable: true });
  else output[field] = value;
}

function projectNode(
  value: unknown,
  schema: JsonSchema | null | undefined,
  descriptor: OperationDescriptor,
  key: string | undefined,
  depth: number,
  privateTarget: boolean,
  parentPath: readonly string[],
): JsonValue | undefined {
  if (depth > 24) throw new RegistryError("invalid-inventory", "response depth limit exceeded", descriptor.operationId);
  if (!privateTarget && key && isSecretOutputField(key, value, parentPath, descriptor.secrets.outputFields)) return undefined;
  const currentPath = key === undefined ? parentPath : [...parentPath, key];
  if (!schema) return undefined;
  schema = projectionShape(schema, value, descriptor, depth);
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (schema.type === undefined && schema.enum === undefined && !Object.hasOwn(schema, "const")) throw new RegistryError("invalid-inventory", "response scalar lacks an explicit type", descriptor.operationId);
    validateSchema(schema, value, "response", descriptor.operationId);
    return !privateTarget && typeof value === "string" ? escapeControls(value) : value;
  }
  if (Array.isArray(value)) {
    const { items, ...constraints } = schema;
    validateSchema(constraints, value, "response", descriptor.operationId);
    if (!items && value.length > 0) throw new RegistryError("invalid-inventory", "response array lacks an item allowlist", descriptor.operationId);
    return value.map(item => {
      const projected = projectNode(item, items, descriptor, undefined, depth + 1, privateTarget, currentPath);
      if (projected === undefined) throw new RegistryError("invalid-inventory", "response array item cannot be projected", descriptor.operationId);
      return projected;
    });
  }
  if (!isRecord(value)) throw new RegistryError("invalid-inventory", "response is not bounded JSON", descriptor.operationId);
  const { properties = {}, required = [], additionalProperties, ...constraints } = schema;
  validateSchema(constraints, value, "response", descriptor.operationId);
  for (const name of required) if (!Object.hasOwn(value, name)) schemaError(descriptor.operationId, `response.${name}`, "is required");
  const output: JsonObject = {};
  for (const [field, childSchema] of Object.entries(properties)) {
    if (!Object.hasOwn(value, field)) continue;
    const projected = projectNode(value[field], childSchema, descriptor, field, depth + 1, privateTarget, currentPath);
    if (projected !== undefined) setProjectedField(output, privateTarget ? field : escapeControls(field), projected);
  }
  if (isRecord(additionalProperties)) {
    // Only a source-qualified identifier map treats its outer keys as data.
    // Structural keys and all nested fields retain normal secret redaction.
    for (const [field, child] of Object.entries(value)) {
      if (Object.hasOwn(properties, field)) continue;
      const identifierKey = schema["x-key-role"] === "identifier";
      const projected = projectNode(child, additionalProperties, descriptor, identifierKey ? undefined : field, depth + 1, privateTarget, currentPath);
      if (projected === undefined) continue;
      setProjectedField(output, privateTarget ? field : escapeControls(field), projected);
    }
  }
  return output;
}

function projectJsonResponse(descriptor: OperationDescriptor, response: unknown, privateTarget: boolean): unknown {
  if (response === undefined && descriptor.response.schema === null) return undefined;
  assertJsonValue(response, "response");
  if (Buffer.byteLength(JSON.stringify(response), "utf8") > 8 * 1024 * 1024) throw new RegistryError("invalid-inventory", "response size limit exceeded", descriptor.operationId);
  return projectNode(response, descriptor.response.schema, descriptor, undefined, 0, privateTarget, []);
}

export function projectResponse(descriptor: OperationDescriptor, response: unknown): unknown {
  return projectJsonResponse(descriptor, response, false);
}


export function operationSourceContract(descriptor: OperationDescriptor): OperationSourceContract {
  return {
    request: descriptor.request, auth: descriptor.auth, response: descriptor.response,
    secrets: descriptor.secrets, sideEffect: descriptor.sideEffect, pagination: descriptor.pagination,
    streaming: descriptor.streaming, confirmation: descriptor.confirmation, retry: descriptor.retry,
    reconciliation: descriptor.reconciliation,
  };
}

export function operationContractBinding(descriptor: OperationDescriptor, provenance: Pick<OperationEvidenceBinding, "routeImportsSha256" | "frameworkContextSha256">): OperationEvidenceBinding {
  const hash = (value: unknown): string => createHash("sha256").update(canonicalizeJson(value)).digest("hex");
  return {
    handlerSha256: descriptor.source.sha256, handlerGitBlobSha: descriptor.source.gitBlobSha,
    requestSchemaSha256: hash(descriptor.request), authSha256: hash(descriptor.auth),
    sideEffect: descriptor.sideEffect, responseProjectionSha256: hash(descriptor.response),
    operationSemanticsSha256: hash(operationSourceContract(descriptor)), sideEffectSha256: hash(descriptor.sideEffect),
    routeImportsSha256: provenance.routeImportsSha256, frameworkContextSha256: provenance.frameworkContextSha256,
  };
}

export function operationRisk(descriptor: OperationDescriptor): AdminRisk {
  if (descriptor.sideEffect === "read" && (descriptor.confirmation.required || descriptor.secrets.inputFields.length > 0)) return "gated-read";
  return RISK_ORDER[descriptor.sideEffect];
}

export class OperationRegistry {
  readonly #descriptors: readonly OperationDescriptor[];
  readonly #descriptorIndex: ReadonlyMap<string, OperationDescriptor>;
  readonly #adapters: ReadonlyMap<string, OperationAdapter>;
  constructor(descriptors?: readonly OperationDescriptor[], options: EligibilityOptions = {}) {
    const eligibilityIndex = createEligibilityIndex(options);
    this.#descriptors = deepFreeze(descriptors === undefined ? loadInventory() : descriptors.map(clone));
    const descriptorIndex = new Map<string, OperationDescriptor>();
    for (const descriptor of this.#descriptors) {
      assertSourceAuthorizationPolicy(descriptor);
      assertRequestSourceValidator(descriptor);
      assertSourceNormalizationUse(descriptor);
      if (descriptorIndex.has(descriptor.operationId)) throw new RegistryError("invalid-inventory", `duplicate operation ${descriptor.operationId}`, descriptor.operationId);
      descriptorIndex.set(descriptor.operationId, descriptor);
    }
    this.#descriptorIndex = descriptorIndex;
    const adapterMap = new Map<string, OperationAdapter>();
    for (const descriptor of this.#descriptors) {
      if (descriptor.coverage.status !== "invokable" || descriptor.coverage.adapterId === null) continue;
      if (adapterMap.has(descriptor.operationId)) throw new RegistryError("invalid-inventory", `duplicate invokable operation ${descriptor.operationId}`, descriptor.operationId);
      const configuredEligibility = eligibilityFor(descriptor.operationId, eligibilityIndex);
      const qualification = descriptor.qualification;
      const binding = qualification ? operationContractBinding(descriptor, qualification.binding) : undefined;
      const eligibility = configuredEligibility.status === "verified" && !isVerifiedEligibility(configuredEligibility, { source: descriptor.source, qualification, binding })
        ? {
            operationId: descriptor.operationId,
            status: "unavailable" as const,
            reason: "Eligibility evidence does not match the pinned source, operation semantics, and observed case receipt.",
          }
        : configuredEligibility;
      const adapter: OperationAdapter = deepFreeze({
        adapterId: descriptor.coverage.adapterId,
        category: categoryFor(descriptor.pathTemplate),
        descriptor,
        risk: operationRisk(descriptor),
        validate: (input: unknown) => this.validate(descriptor, input),
        project: (response: unknown) => projectResponse(descriptor, response),
        projectTarget: (response: unknown) => projectJsonResponse(descriptor, response, true),
        buildPath: (input: ValidatedOperationInput) => buildPath(descriptor.pathTemplate, input.path, descriptor.operationId, descriptor.request.pathParameters),
        buildQuery: (input: ValidatedOperationInput) => buildQuery(input.query, descriptor.request.parameters, descriptor.operationId),
        eligibility: deepFreeze(eligibility),
      });
      adapterMap.set(descriptor.operationId, adapter);
    }
    const invokableCount = this.#descriptors.filter(descriptor => descriptor.coverage.status === "invokable" && descriptor.coverage.adapterId !== null).length;
    if (adapterMap.size !== invokableCount) throw new RegistryError("invalid-inventory", "inventory coverage is incomplete");
    this.#adapters = adapterMap;
  }

  get size(): number {
    return this.#adapters.size;
  }

  getOperation(operationId: string): OperationDescriptor | undefined {
    const descriptor = this.#descriptorIndex.get(operationId);
    return descriptor ? clone(descriptor) : undefined;
  }

  getEligibility(operationId: string): OperationEligibilityRecord {
    const adapter = this.#adapters.get(operationId);
    if (adapter) return adapter.eligibility;
    return { operationId, status: "unavailable", reason: this.#descriptorIndex.has(operationId)
      ? "Operation has no qualified executable adapter."
      : "Operation is not present in the closed inventory." };
  }

  lookup(operationId: string): OperationAdapter | undefined {
    const adapter = this.#adapters.get(operationId);
    return adapter ? adapter : undefined;
  }

  require(operationId: string): OperationAdapter {
    const adapter = this.#adapters.get(operationId);
    if (adapter) return adapter;
    const descriptor = this.#descriptorIndex.get(operationId);
    if (descriptor) throw new RegistryError("non-invokable", `operation ${operationId} is not invokable`, operationId);
    throw new RegistryError("unknown-operation", "operation is not in the closed inventory", operationId);
  }

  listOperations(filter: OperationListFilter = {}): readonly OperationAdapter[] {
    const search = filter.search?.toLowerCase();
    return [...this.#adapters.values()]
      .filter((adapter) => filter.category === undefined || adapter.category === filter.category)
      .filter((adapter) => filter.method === undefined || adapter.descriptor.method === filter.method)
      .filter((adapter) => filter.sideEffect === undefined || adapter.descriptor.sideEffect === filter.sideEffect)
      .filter((adapter) => filter.authDomain === undefined || adapter.descriptor.auth.domain === filter.authDomain)
      .filter((adapter) => search === undefined || `${adapter.descriptor.operationId} ${adapter.descriptor.pathTemplate}`.toLowerCase().includes(search))
      .sort((left, right) => left.descriptor.operationId.localeCompare(right.descriptor.operationId));
  }

  listCategories(): readonly string[] {
    return [...new Set([...this.#adapters.values()].map((adapter) => adapter.category))].sort();
  }

  validateOperation(operationId: string, input: unknown): ValidatedOperationInput {
    return this.require(operationId).validate(input);
  }

  project(operationId: string, response: unknown): unknown {
    return this.require(operationId).project(response);
  }

  buildRequestPath(operationId: string, input: ValidatedOperationInput): string {
    return this.require(operationId).buildPath(input);
  }

  descriptors(): readonly OperationDescriptor[] {
    return this.#descriptors.map(clone);
  }

  private validate(descriptor: OperationDescriptor, input: unknown): ValidatedOperationInput {
    if (!isRecord(input)) throw new RegistryError("invalid-input", "input must be an object", descriptor.operationId);
    const allowed = new Set(["path", "query", "body"]);
    for (const key of Object.keys(input)) if (!allowed.has(key)) throw new RegistryError("invalid-input", `input.${key}: is not allowed`, descriptor.operationId, `input.${key}`);
    assertJsonValue(input, "input");
    if (Buffer.byteLength(JSON.stringify(input), "utf8") > 8 * 1024 * 1024) schemaError(descriptor.operationId, "input", "body size limit exceeded");
    const normalized = clone(input);
    normalizeOperationInput(descriptor, normalized);
    const path = normalized.path === undefined ? {} : normalized.path;
    const query = normalized.query === undefined ? {} : normalized.query;
    if (!isRecord(path)) throw new RegistryError("invalid-input", "path must be an object", descriptor.operationId, "path");
    if (!isRecord(query)) throw new RegistryError("invalid-input", "query must be an object", descriptor.operationId, "query");
    assertJsonValue(path, "path");
    assertJsonValue(query, "query");
    validateSchema(descriptor.request.pathSchema, path, "path", descriptor.operationId);
    validateSchema(descriptor.request.querySchema, query, "query", descriptor.operationId);
    const bodySchema = descriptor.request.body;
    const bodyProvided = normalized.body !== undefined;
    let validatedBody: JsonValue | undefined;
    if (!bodySchema) {
      if (bodyProvided) throw new RegistryError("invalid-input", "body is not accepted", descriptor.operationId, "body");
    } else if (!bodyProvided) {
      if (bodySchema.required) throw new RegistryError("invalid-input", "body is required", descriptor.operationId, "body");
    } else {
      const body = normalized.body;
      if (body === undefined) throw new RegistryError("invalid-input", "body is required", descriptor.operationId, "body");
      assertJsonValue(body, "body");
      validateSchema(bodySchema.schema, body, "body", descriptor.operationId);
      if (descriptor.mediaType.request?.split(";", 1)[0]?.trim().toLowerCase() === "multipart/form-data") validateMultipartBody(body, descriptor.operationId);
      validatedBody = body;
    }
    validateSourceRequest(descriptor, validatedBody);
    return validatedBody === undefined ? { path, query } : { path, query, body: validatedBody };
  }
}

let defaultOperationRegistry: OperationRegistry | undefined;

export function getOperationRegistry(): OperationRegistry {
  return defaultOperationRegistry ??= new OperationRegistry();
}


export const getOperation = (operationId: string): OperationDescriptor | undefined => getOperationRegistry().getOperation(operationId);
export const lookupOperation = (operationId: string): OperationAdapter | undefined => getOperationRegistry().lookup(operationId);
export const listOperations = (filter?: OperationListFilter): readonly OperationAdapter[] => getOperationRegistry().listOperations(filter);
export const listCategories = (): readonly string[] => getOperationRegistry().listCategories();
export const validateOperation = (operationId: string, input: unknown): ValidatedOperationInput => getOperationRegistry().validateOperation(operationId, input);
export const operationIds = (): readonly string[] => listOperations().map((adapter) => adapter.descriptor.operationId);
export const validateOperationPayload = (operationId: string, input: unknown): ValidatedOperationInput => getOperationRegistry().validateOperation(operationId, input);
export const projectResponseForOperation = (operationId: string, response: unknown): unknown => getOperationRegistry().project(operationId, response);
