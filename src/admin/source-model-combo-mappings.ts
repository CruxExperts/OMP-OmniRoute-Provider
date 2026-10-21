/*
 * Source behavior: OmniRoute v3.8.52, commit ad6f33f66bda34eba98645d3bfdabbde294bc843.
 * Pinned upstream files and SHA-256:
 * - src/app/api/model-combo-mappings/route.ts: 138658e09787bc715fa360c2edead37f0e63f3bfc13027185bc292b7a29dd137
 * - src/app/api/model-combo-mappings/[id]/route.ts: 88e42628c6e87daf4c44f3c83357d7352b6344307b14685b09c21f66d9bb01ec
 * - src/domain/persistence/comboRepositories.ts: 74cfd4a305f2a3f66340a9f55a7dc3e80c30938ba13bf6d1b8a82564b9acff9a
 * - src/lib/db/modelComboMappings.ts: 54d113377853672ddc03bd49891c7cd86d230e741022c8dfe4c62c1a7702c195
 * - src/lib/db/repositories/routingConfigRepositories.ts: aee9bbd40e8e51f7ebc78456f1dd32c6529e1d89a64e098ba16d5f1e844ab518
 * - src/lib/db/repositories/sqliteModelComboMappingRepository.ts: a4aac28b6aa34870c8136c06a4c9a2863991f82ce59664267b91ba38a2e816d0
 * - src/lib/db/migrations/010_model_combo_mappings.sql: 816546065a91deeb81b9b18209611ae76d1b91bb16d4508250ec75a6617c4e95
 * - src/shared/validation/schemas/misc.ts: a718f14bfbe1b08d5265393277cb61310445809ef03a01a90e163eecb1b62d93
 * - src/shared/validation/helpers.ts: 4c0ce67959151549033102b7ac1f8367c2be82560002ba1ab5a53d3c4e930d5c
 * - src/lib/api/requireManagementAuth.ts: c34dd2bd6ce9a556c043912f817d52966050118272ee742c83247b7031f28a29
 * - src/lib/api/errorResponse.ts: 6015b2648eacc5e05e9f3bf03995c24c5a25ec36fbd55d9cdbc377f4fde3e0c7
 * - src/sse/services/auth.ts: dff22592b6aac4d24445389e44344fdcc19ba02bcd7435c570e18e0c9f1a4c9e
 * - src/lib/db/apiKeys.ts: d70df067e52df12870386a33b2dd7302b272544d0728c1dacf9723aa767f126e
 * - src/lib/middleware/cliTokenAuth.ts: d0e15851807a8534b3d400dd1c9a787e139acb3bad070cf8cf029f210a89f7ec
 * - src/server/authz/accessTokenAuth.ts: 1844c6831e9cf872f700888601825517136e9096b9c933cbad6034c8e2145ac9
 * - src/shared/utils/apiAuth.ts: 15270816325cd0b39494b376b884b7b4fccd19765b1e923305734f96d2cb1020
 * - src/shared/constants/managementScopes.ts: 3d9ffd8a5439ad54f6fffc6ee7c39be7e1be080f0d605d7b193b06e6a1523e67
 * - src/server/authz/accessScopes.ts: 8cadf0203b349cec4eee5f4a00c418fea3b9f27acc9c4ce7bc244aa44e1a2d75
 *
 * MIT License
 * Copyright (c) 2026 diegosouzapw
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import type { AdminMethod, JsonObject, JsonValue } from "./types.ts";
import type { ValidatedOperationInput } from "./registry.ts";

export const MODEL_COMBO_MAPPING_COLLECTION_PATH = "/api/model-combo-mappings" as const;
export const MODEL_COMBO_MAPPING_ITEM_PATH = "/api/model-combo-mappings/{id}" as const;

export const MODEL_COMBO_MAPPING_OPERATION_IDS = Object.freeze([
  "GET /api/model-combo-mappings",
  "POST /api/model-combo-mappings",
  "GET /api/model-combo-mappings/{id}",
  "PUT /api/model-combo-mappings/{id}",
  "DELETE /api/model-combo-mappings/{id}",
] as const);

export type ModelComboMappingOperationId = typeof MODEL_COMBO_MAPPING_OPERATION_IDS[number];
export type ModelComboMappingRequestCodecId =
  | "omniroute-v3.8.52.model-combo-mappings.list-query"
  | "omniroute-v3.8.52.model-combo-mappings.create"
  | "omniroute-v3.8.52.model-combo-mappings.update";
export type ModelComboMappingRelationViewId =
  | "omniroute-v3.8.52.model-combo-mappings.create-reconcile"
  | "omniroute-v3.8.52.model-combo-mappings.update-reconcile"
  | "omniroute-v3.8.52.model-combo-mappings.delete-reconcile";

export interface ModelComboMappingCodecBinding {
  readonly id: ModelComboMappingRequestCodecId;
  readonly operationIds: readonly ModelComboMappingOperationId[];
  readonly methods: readonly AdminMethod[];
  readonly pathTemplate: string;
  readonly section: "body" | "query";
}

export interface ModelComboMappingRelationBinding {
  readonly id: ModelComboMappingRelationViewId;
  readonly operationIds: readonly ModelComboMappingOperationId[];
  readonly methods: readonly AdminMethod[];
  readonly pathTemplate: string;
  readonly section: "body";
  readonly targetRead: { readonly operationId: ModelComboMappingOperationId; readonly pathTemplate: string; readonly section: "query" | "path" };
  readonly reconciliation: { readonly operationId: ModelComboMappingOperationId; readonly pathTemplate: string; readonly section: "query" | "path"; readonly outcomeKind: "exists" | "matches" | "absent" };
}

export interface ModelComboMappingIssue {
  readonly field: string;
  readonly reason: string;
}

export type ModelComboMappingValidationResult =
  | { readonly kind: "valid"; readonly data: JsonValue }
  | { readonly kind: "invalid"; readonly issues: readonly ModelComboMappingIssue[] }
  | { readonly kind: "unbound" };

function codecBinding(
  id: ModelComboMappingRequestCodecId,
  operationIds: readonly ModelComboMappingOperationId[],
  methods: readonly AdminMethod[],
  pathTemplate: string,
  section: "body" | "query",
): ModelComboMappingCodecBinding {
  return Object.freeze({ id, operationIds: Object.freeze([...operationIds]), methods: Object.freeze([...methods]), pathTemplate, section });
}

export const MODEL_COMBO_MAPPING_CODEC_BINDINGS: Readonly<Record<ModelComboMappingRequestCodecId, ModelComboMappingCodecBinding>> = Object.freeze({
  "omniroute-v3.8.52.model-combo-mappings.list-query": codecBinding(
    "omniroute-v3.8.52.model-combo-mappings.list-query",
    ["GET /api/model-combo-mappings"], ["GET"], MODEL_COMBO_MAPPING_COLLECTION_PATH, "query",
  ),
  "omniroute-v3.8.52.model-combo-mappings.create": codecBinding(
    "omniroute-v3.8.52.model-combo-mappings.create",
    ["POST /api/model-combo-mappings"], ["POST"], MODEL_COMBO_MAPPING_COLLECTION_PATH, "body",
  ),
  "omniroute-v3.8.52.model-combo-mappings.update": codecBinding(
    "omniroute-v3.8.52.model-combo-mappings.update",
    ["PUT /api/model-combo-mappings/{id}"], ["PUT"], MODEL_COMBO_MAPPING_ITEM_PATH, "body",
  ),
});

function relationBinding(value: ModelComboMappingRelationBinding): ModelComboMappingRelationBinding {
  return Object.freeze({
    ...value,
    operationIds: Object.freeze([...value.operationIds]),
    methods: Object.freeze([...value.methods]),
    targetRead: Object.freeze({ ...value.targetRead }),
    reconciliation: Object.freeze({ ...value.reconciliation }),
  });
}

export const MODEL_COMBO_MAPPING_RELATION_BINDINGS: Readonly<Record<ModelComboMappingRelationViewId, ModelComboMappingRelationBinding>> = Object.freeze({
  "omniroute-v3.8.52.model-combo-mappings.create-reconcile": relationBinding({
    id: "omniroute-v3.8.52.model-combo-mappings.create-reconcile",
    operationIds: ["POST /api/model-combo-mappings"], methods: ["POST"],
    pathTemplate: MODEL_COMBO_MAPPING_COLLECTION_PATH, section: "body",
    targetRead: { operationId: "GET /api/model-combo-mappings", pathTemplate: MODEL_COMBO_MAPPING_COLLECTION_PATH, section: "query" },
    reconciliation: { operationId: "GET /api/model-combo-mappings", pathTemplate: MODEL_COMBO_MAPPING_COLLECTION_PATH, section: "query", outcomeKind: "exists" },
  }),
  "omniroute-v3.8.52.model-combo-mappings.update-reconcile": relationBinding({
    id: "omniroute-v3.8.52.model-combo-mappings.update-reconcile",
    operationIds: ["PUT /api/model-combo-mappings/{id}"], methods: ["PUT"],
    pathTemplate: MODEL_COMBO_MAPPING_ITEM_PATH, section: "body",
    targetRead: { operationId: "GET /api/model-combo-mappings/{id}", pathTemplate: MODEL_COMBO_MAPPING_ITEM_PATH, section: "path" },
    reconciliation: { operationId: "GET /api/model-combo-mappings/{id}", pathTemplate: MODEL_COMBO_MAPPING_ITEM_PATH, section: "path", outcomeKind: "matches" },
  }),
  "omniroute-v3.8.52.model-combo-mappings.delete-reconcile": relationBinding({
    id: "omniroute-v3.8.52.model-combo-mappings.delete-reconcile",
    operationIds: ["DELETE /api/model-combo-mappings/{id}"], methods: ["DELETE"],
    pathTemplate: MODEL_COMBO_MAPPING_ITEM_PATH, section: "body",
    targetRead: { operationId: "GET /api/model-combo-mappings", pathTemplate: MODEL_COMBO_MAPPING_COLLECTION_PATH, section: "query" },
    reconciliation: { operationId: "GET /api/model-combo-mappings", pathTemplate: MODEL_COMBO_MAPPING_COLLECTION_PATH, section: "query", outcomeKind: "absent" },
  }),
});

const CREATE_ID: ModelComboMappingRequestCodecId = "omniroute-v3.8.52.model-combo-mappings.create";
const UPDATE_ID: ModelComboMappingRequestCodecId = "omniroute-v3.8.52.model-combo-mappings.update";
const LIST_QUERY_ID: ModelComboMappingRequestCodecId = "omniroute-v3.8.52.model-combo-mappings.list-query";
const STATE_FIELDS = Object.freeze(["pattern", "comboId", "priority", "enabled", "description"] as const);

function received(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function issue(field: string, reason: string): ModelComboMappingIssue {
  return Object.freeze({ field, reason });
}

function canonicalJson(value: unknown, depth = 0): JsonValue {
  if (depth > 24) throw new TypeError("model-combo-mapping JSON depth exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return Object.is(value, -0) ? 0 : value;
  if (Array.isArray(value)) return value.map(item => canonicalJson(item, depth + 1));
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const output: JsonObject = {};
    for (const key of Object.keys(record).sort()) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") continue;
      const item = record[key];
      if (item === undefined) continue;
      output[key] = canonicalJson(item, depth + 1);
    }
    return output;
  }
  throw new TypeError("model-combo-mapping value is not JSON");
}

function bodyRecord(value: unknown, issues: ModelComboMappingIssue[]): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    issues.push(issue("", `Expected object, received ${received(value)}`));
    return undefined;
  }
  return value as Record<string, unknown>;
}

function validateString(
  record: Record<string, unknown>, field: string, required: boolean, minimum: number, issues: ModelComboMappingIssue[], maximum?: number,
  customMinimum?: string,
): string | undefined {
  const value = record[field];
  if (value === undefined && !required) return undefined;
  if (typeof value !== "string") {
    issues.push(issue(field, `Expected string, received ${received(value)}`));
    return undefined;
  }
  if (value.length < minimum) {
    issues.push(issue(field, customMinimum ?? `String must contain at least ${minimum} character(s)`));
    return undefined;
  }
  if (maximum !== undefined && value.length > maximum) {
    issues.push(issue(field, `String must contain at most ${maximum} character(s)`));
    return undefined;
  }
  return value;
}

function validateBody(codecId: ModelComboMappingRequestCodecId, value: unknown): ModelComboMappingValidationResult {
  const issues: ModelComboMappingIssue[] = [];
  const body = bodyRecord(value, issues);
  if (!body) return { kind: "invalid", issues: Object.freeze(issues) };

  const create = codecId === CREATE_ID;
  const output: JsonObject = {};
  const pattern = validateString(body, "pattern", create, 1, issues, 500, create ? "Pattern is required" : undefined);
  const comboId = validateString(body, "comboId", create, 1, issues, undefined, create ? "ComboId is required" : undefined);
  if (pattern !== undefined) output.pattern = pattern;
  if (comboId !== undefined) output.comboId = comboId;

  if (create || (Object.hasOwn(body, "priority") && body.priority !== undefined)) {
    const priority = create && body.priority === undefined ? 0 : body.priority;
    if (typeof priority !== "number" || !Number.isFinite(priority) || !Number.isInteger(priority)) {
      issues.push(issue("priority", `Expected integer, received ${received(priority)}`));
    } else output.priority = priority;
  }
  if (create || (Object.hasOwn(body, "enabled") && body.enabled !== undefined)) {
    const enabled = create && body.enabled === undefined ? true : body.enabled;
    if (typeof enabled !== "boolean") issues.push(issue("enabled", `Expected boolean, received ${received(enabled)}`));
    else output.enabled = enabled;
  }
  if (create || (Object.hasOwn(body, "description") && body.description !== undefined)) {
    const description = create && body.description === undefined ? "" : body.description;
    if (typeof description !== "string") issues.push(issue("description", `Expected string, received ${received(description)}`));
    else if (description.length > 1000) issues.push(issue("description", "String must contain at most 1000 character(s)"));
    else output.description = description;
  }
  if (issues.length > 0) return { kind: "invalid", issues: Object.freeze([...issues]) };
  return { kind: "valid", data: canonicalJson(output) };
}

function validateListQuery(value: unknown): ModelComboMappingValidationResult {
  const issues: ModelComboMappingIssue[] = [];
  const query = bodyRecord(value, issues);
  if (!query) return { kind: "invalid", issues: Object.freeze(issues) };
  const output: JsonObject = {};
  for (const [field, maximum] of [["offset", undefined], ["limit", 200]] as const) {
    const raw = query[field];
    // The handler uses searchParams.get(name) || undefined before z.coerce.number().
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw !== "string" && typeof raw !== "number") {
      issues.push(issue(field, "Expected a coercible nonnegative integer"));
      continue;
    }
    const number = Number(raw);
    if (!Number.isFinite(number) || !Number.isInteger(number) || number < 0 || (maximum !== undefined && number > maximum)) {
      issues.push(issue(field, maximum === undefined
        ? "Expected a nonnegative integer"
        : "Expected a nonnegative integer no greater than 200"));
    } else output[field] = number;
  }
  return issues.length > 0
    ? { kind: "invalid", issues: Object.freeze(issues) }
    : { kind: "valid", data: canonicalJson(output) };
}

export function isModelComboMappingRequestCodecId(value: unknown): value is ModelComboMappingRequestCodecId {
  return typeof value === "string" && Object.hasOwn(MODEL_COMBO_MAPPING_CODEC_BINDINGS, value);
}

export function modelComboMappingCodecBinding(value: unknown): ModelComboMappingCodecBinding | undefined {
  return isModelComboMappingRequestCodecId(value) ? MODEL_COMBO_MAPPING_CODEC_BINDINGS[value] : undefined;
}

export function isModelComboMappingRelationViewId(value: unknown): value is ModelComboMappingRelationViewId {
  return typeof value === "string" && Object.hasOwn(MODEL_COMBO_MAPPING_RELATION_BINDINGS, value);
}

export function modelComboMappingRelationBinding(value: unknown): ModelComboMappingRelationBinding | undefined {
  return isModelComboMappingRelationViewId(value) ? MODEL_COMBO_MAPPING_RELATION_BINDINGS[value] : undefined;
}

export function validateModelComboMappingRequest(value: unknown, input: unknown): ModelComboMappingValidationResult {
  if (!isModelComboMappingRequestCodecId(value)) return { kind: "unbound" };
  if (value === LIST_QUERY_ID) return validateListQuery(input);
  return validateBody(value, input);
}

/** Validate raw source input first, then apply create trimming/defaults and safe field projection. */
export function normalizeModelComboMappingRequest(value: unknown, input: unknown): JsonValue {
  const validation = validateModelComboMappingRequest(value, input);
  if (validation.kind !== "valid") throw new TypeError(validation.kind === "unbound"
    ? "unknown model-combo-mapping codec"
    : "invalid model-combo-mapping request");
  if (value !== CREATE_ID) return validation.data;
  const data = validation.data as JsonObject;
  return canonicalJson({ ...data, pattern: String(data.pattern).trim() });
}

function objectAt(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`${field} is not an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new TypeError(`${field} is not a string`);
  return value;
}

function stateOf(row: unknown): JsonObject {
  const value = objectAt(row, "mapping");
  const id = requiredString(value.id, "mapping.id");
  const pattern = requiredString(value.pattern, "mapping.pattern");
  const comboId = requiredString(value.comboId, "mapping.comboId");
  const priority = value.priority;
  const enabled = value.enabled;
  const description = value.description;
  if (typeof priority !== "number" || !Number.isFinite(priority) || typeof enabled !== "boolean" || typeof description !== "string") {
    throw new TypeError("mapping state is malformed");
  }
  return canonicalJson({ id, state: { pattern, comboId, priority, enabled, description } }) as JsonObject;
}

function snapshotEntry(row: unknown): JsonObject {
  const state = stateOf(row);
  const id = state.id;
  const stateValue = state.state;
  if (typeof id !== "string" || typeof stateValue !== "object" || stateValue === null || Array.isArray(stateValue)) {
    throw new TypeError("mapping identity is malformed");
  }
  return { identity: { id }, state: stateValue as JsonObject };
}

function listRows(response: unknown): readonly unknown[] {
  const body = objectAt(response, "collection response");
  if (!Array.isArray(body.mappings)) throw new TypeError("mapping collection is malformed");
  return body.mappings;
}

function payloadObject(payload: ValidatedOperationInput, section: "path" | "body"): JsonObject {
  const value = payload[section];
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new TypeError(`mapping ${section} input is malformed`);
  return canonicalJson(value) as JsonObject;
}

function snapshot(value: unknown): { readonly kind: string; readonly entries: readonly Record<string, unknown>[] } {
  const root = objectAt(value, "mapping relation snapshot");
  if (typeof root.kind !== "string" || !Array.isArray(root.entries)
    || root.entries.some(entry => typeof entry !== "object" || entry === null || Array.isArray(entry))) {
    throw new TypeError("mapping relation snapshot is malformed");
  }
  return { kind: root.kind, entries: root.entries as Record<string, unknown>[] };
}

export function modelComboMappingRelationSnapshot(
  value: unknown,
  payload: ValidatedOperationInput,
  response: unknown,
): JsonValue {
  if (!isModelComboMappingRelationViewId(value)) throw new TypeError("unknown model-combo-mapping relation view");
  const entries: JsonObject[] = [];
  if (value === "omniroute-v3.8.52.model-combo-mappings.create-reconcile") {
    for (const row of listRows(response)) entries.push(snapshotEntry(row));
    entries.sort((left, right) => String((left.identity as JsonObject).id).localeCompare(String((right.identity as JsonObject).id)));
    const identities = new Set<string>();
    for (const entry of entries) {
      const id = String((entry.identity as JsonObject).id);
      if (identities.has(id)) throw new TypeError("mapping collection identity is ambiguous");
      identities.add(id);
    }
    return canonicalJson({ kind: "collection", entries });
  }
  if (value === "omniroute-v3.8.52.model-combo-mappings.update-reconcile") {
    const responseObject = objectAt(response, "item response");
    return canonicalJson({ kind: "resource", entries: [snapshotEntry(responseObject.mapping)] });
  }

  const id = requiredString(payloadObject(payload, "path").id, "path.id");
  const selected = listRows(response).filter(row =>
    typeof row === "object" && row !== null && !Array.isArray(row) && (row as Record<string, unknown>).id === id,
  );
  if (selected.length > 1) throw new TypeError("mapping collection identity is ambiguous");
  if (selected.length === 1) return canonicalJson({ kind: "collection", entries: [snapshotEntry(selected[0])] });
  return canonicalJson({ kind: "collection", entries: [{ identity: { id }, state: {}, absent: true }] });
}

/** Merge a partial PUT over the exact pre-dispatch resource; the DB updates omitted columns from that row. */
export function modelComboMappingRelationExpectedPayload(
  value: unknown,
  payload: ValidatedOperationInput,
  originalSnapshot: JsonValue,
): ValidatedOperationInput {
  if (!isModelComboMappingRelationViewId(value)) throw new TypeError("unknown model-combo-mapping relation view");
  if (value === "omniroute-v3.8.52.model-combo-mappings.delete-reconcile") return payload;

  const body = payloadObject(payload, "body");
  const codecId = value === "omniroute-v3.8.52.model-combo-mappings.create-reconcile" ? CREATE_ID : UPDATE_ID;
  const normalized = normalizeModelComboMappingRequest(codecId, body) as JsonObject;
  if (value === "omniroute-v3.8.52.model-combo-mappings.create-reconcile") return { ...payload, body: normalized };

  const before = snapshot(originalSnapshot);
  const id = requiredString(payloadObject(payload, "path").id, "path.id");
  if (before.kind !== "resource" || before.entries.length !== 1) throw new TypeError("mapping update target is not a single resource");
  const entry = before.entries[0];
  if (!entry || typeof entry.identity !== "object" || entry.identity === null || Array.isArray(entry.identity)
    || (entry.identity as Record<string, unknown>).id !== id
    || typeof entry.state !== "object" || entry.state === null || Array.isArray(entry.state)) {
    throw new TypeError("mapping update target identity changed");
  }
  const complete = { ...(entry.state as JsonObject) };
  for (const field of STATE_FIELDS) {
    if (Object.hasOwn(normalized, field)) complete[field] = normalized[field]!;
  }
  return { ...payload, body: canonicalJson(complete) as JsonObject };
}

export function modelComboMappingRelationViewMatches(
  value: unknown,
  operationId: string,
  targetReadId: unknown,
  reconciliationId: unknown,
  outcomeKind: unknown,
): boolean {
  const binding = modelComboMappingRelationBinding(value);
  if (!binding) return false;
  return binding.operationIds.includes(operationId as ModelComboMappingOperationId)
    && targetReadId === binding.targetRead.operationId
    && reconciliationId === binding.reconciliation.operationId
    && outcomeKind === binding.reconciliation.outcomeKind;
}

export function modelComboMappingStateFields(): readonly string[] {
  return STATE_FIELDS;
}
