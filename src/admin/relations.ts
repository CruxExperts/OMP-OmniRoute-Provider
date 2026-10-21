import { canonicalizeJson, RegistryError, type OperationDescriptor, type OperationReadCompleteness, type OperationReconciliationRelation, type ReconciliationFieldMapping, type ReconciliationProjectedField, type ValidatedOperationInput } from "./registry.ts";
import type { JsonObject, JsonValue } from "./types.ts";
import { sourceStateView, sourceRelationSnapshot, sourceRelationExpectedPayload, sourceUnpaginatedListProofMatches } from "./source-normalization.ts";

const MAX_COMPLETE_LIST_ROWS = 10_000;
const MAX_COMPLETE_LIST_BYTES = 8 * 1024 * 1024;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function field(value: unknown, path: readonly string[]): unknown {
  if (path.length > 24 || path.some(key => ["__proto__", "prototype", "constructor"].includes(key))) throw new RegistryError("invalid-inventory", "unsafe relation field path");
  let current = value;
  for (const key of path) {
    if ((!record(current) && !Array.isArray(current)) || !Object.hasOwn(current, key)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

export function assertSafetyReadRequest(proof: OperationReadCompleteness, descriptor: OperationDescriptor, input: ValidatedOperationInput): void {
  if (!proof.sourceReason || (proof.kind === "single-response" && descriptor.pagination.mode !== "none")) {
    throw new RegistryError("invalid-inventory", "safety read completeness is not source qualified", descriptor.operationId);
  }
  if (proof.kind === "unpaginated-list") {
    if (descriptor.pagination.mode !== "offset" || !sourceUnpaginatedListProofMatches(descriptor.operationId, proof)
      || Object.hasOwn(input.query, "limit") || Object.hasOwn(input.query, "offset")) {
      throw new RegistryError("invalid-inventory", "safety list read is paginated or not source bound", descriptor.operationId);
    }
  }
}

/** Validate the raw complete list before a source view can select an absent row. */
export function assertSafetyReadResponse(proof: OperationReadCompleteness, descriptor: OperationDescriptor, response: unknown): void {
  if (proof.kind === "single-response") return;
  if (!sourceUnpaginatedListProofMatches(descriptor.operationId, proof)) throw new RegistryError("invalid-inventory", "safety list proof is not source bound", descriptor.operationId);
  const rows = field(response, proof.itemsPath);
  const total = field(response, proof.totalPath);
  if (!Array.isArray(rows) || !Number.isSafeInteger(total) || (total as number) < 0 || (total as number) > MAX_COMPLETE_LIST_ROWS
    || rows.length !== total || Buffer.byteLength(JSON.stringify(response), "utf8") > MAX_COMPLETE_LIST_BYTES) {
    throw new RegistryError("invalid-inventory", "safety list response is incomplete or oversized", descriptor.operationId);
  }
  const identities = new Set<string>();
  for (const row of rows) {
    const parts = proof.identityPaths.map(path => field(row, path));
    if (parts.some(part => typeof part !== "string" || part.length === 0)) throw new RegistryError("invalid-inventory", "safety list identity is invalid", descriptor.operationId);
    const identity = canonicalizeJson(parts);
    if (identities.has(identity)) throw new RegistryError("invalid-inventory", "safety list identity is duplicated", descriptor.operationId);
    identities.add(identity);
  }
}

function json(value: unknown, depth = 0): JsonValue {
  if (depth > 24) throw new RegistryError("invalid-inventory", "relation projection depth exceeded");
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map(item => json(item, depth + 1));
  if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, json(item, depth + 1)]));
  throw new RegistryError("invalid-inventory", "required relation projection field is missing or invalid");
}

export function mapRelationInput(mappings: readonly ReconciliationFieldMapping[], payload: ValidatedOperationInput, result?: unknown): ValidatedOperationInput {
  const path: JsonObject = {};
  const query: JsonObject = {};
  const source = { ...payload, result };
  for (const mapping of mappings) {
    if (!["path", "query"].includes(mapping.target.section) || ["__proto__", "prototype", "constructor"].includes(mapping.target.field)) throw new RegistryError("invalid-inventory", "invalid relation input target");
    const output = mapping.target.section === "path" ? path : query;
    if (Object.hasOwn(output, mapping.target.field)) throw new RegistryError("invalid-inventory", "duplicate relation input target");
    output[mapping.target.field] = json(field(source[mapping.source.section], mapping.source.path));
  }
  return { path, query };
}

interface SnapshotEntry {
  readonly identity: JsonObject;
  readonly state: JsonObject;
  readonly absent?: boolean;
}
interface Snapshot {
  readonly kind: "resource" | "collection" | "action";
  readonly entries: readonly SnapshotEntry[];
}

function projectFields(value: unknown, fields: readonly ReconciliationProjectedField[]): JsonObject {
  const output: JsonObject = {};
  for (const entry of fields) {
    if (Object.hasOwn(output, entry.name) || ["__proto__", "prototype", "constructor"].includes(entry.name)) throw new RegistryError("invalid-inventory", "invalid relation projection name");
    const projected = json(field(value, entry.path));
    output[entry.name] = entry.sourceView === undefined ? projected : sourceStateView(entry.sourceView, projected);
  }
  return output;
}

export function projectRelationSnapshot(relation: OperationReconciliationRelation["targetRead"], response: unknown, payload: ValidatedOperationInput): JsonValue {
  if (relation.sourceView !== undefined) return sourceRelationSnapshot(relation.sourceView, payload, response);
  const contract = relation.snapshot;
  const project = (value: unknown): SnapshotEntry => ({ identity: projectFields(value, contract.identity), state: projectFields(value, contract.state) });
  let entries: SnapshotEntry[];
  if (contract.kind !== "collection") {
    if (contract.selection || contract.collectionPath) throw new RegistryError("invalid-inventory", "collection selector requires a collection snapshot");
    entries = [project(response)];
  } else {
    const rows = field(response, contract.collectionPath ?? []);
    if (!Array.isArray(rows)) throw new RegistryError("invalid-inventory", "relation collection is not an array");
    if (contract.selection) {
      const selection = contract.selection;
      const selected = field(payload[selection.input.section], selection.input.path);
      if (!Array.isArray(selected) || selected.some(value => typeof value !== "string")) throw new RegistryError("invalid-inventory", "relation selection requires source-normalized string identifiers");
      const identityField = contract.identity.find(entry => canonicalizeJson(entry.path) === canonicalizeJson(selection.rowPath));
      if (contract.identity.length !== 1 || !identityField) throw new RegistryError("invalid-inventory", "collection selection requires one exact identifier projection");
      const ids = new Set(selected as string[]);
      const matched = new Map<string, SnapshotEntry>();
      for (const row of rows) {
        const id = field(row, selection.rowPath);
        if (typeof id !== "string") throw new RegistryError("invalid-inventory", "relation collection identifier is invalid");
        if (!ids.has(id)) continue;
        if (matched.has(id)) throw new RegistryError("invalid-inventory", "relation collection contains an ambiguous identifier");
        matched.set(id, project(row));
      }
      entries = [...ids].map(id => matched.get(id) ?? { identity: { [identityField.name]: id }, state: {}, absent: true });
    } else {
      entries = rows.map(project);
    }
  }
  entries.sort((left, right) => canonicalizeJson(left.identity).localeCompare(canonicalizeJson(right.identity)));
  const identities = new Set<string>();
  for (const entry of entries) {
    const identity = canonicalizeJson(entry.identity);
    if (identities.has(identity)) throw new RegistryError("invalid-inventory", "relation snapshot identity is not unique");
    identities.add(identity);
  }
  return json({ kind: contract.kind, entries });
}

function parseSnapshot(value: JsonValue): Snapshot {
  if (!record(value) || !["resource", "collection", "action"].includes(String(value.kind)) || !Array.isArray(value.entries)
    || value.entries.some(entry => !record(entry) || !record(entry.identity) || !record(entry.state) || (entry.absent !== undefined && entry.absent !== true))) {
    throw new RegistryError("invalid-inventory", "relation snapshot is invalid");
  }
  return value as unknown as Snapshot;
}

/** Only a declared observable postcondition can turn a lost response into an applied result. */
export function relationOutcomeMatches(relation: OperationReconciliationRelation, original: JsonValue, observed: JsonValue, payload: ValidatedOperationInput): boolean {
  const before = parseSnapshot(original);
  const after = parseSnapshot(observed);
  if (before.kind !== after.kind) return false;
  const outcome = relation.reconcile.outcome;
  const expected: JsonObject = {};
  const expectedPayload = relation.targetRead.sourceView !== undefined && (outcome.expectedFromInput?.length ?? 0) > 0
    ? sourceRelationExpectedPayload(relation.targetRead.sourceView, payload, original)
    : payload;
  for (const mapping of outcome.expectedFromInput ?? []) {
    if (!outcome.stateFields.includes(mapping.name) || Object.hasOwn(expected, mapping.name)) throw new RegistryError("invalid-inventory", "reconciliation expected field is not a declared state field");
    const projected = json(field(expectedPayload[mapping.source.section], mapping.source.path));
    expected[mapping.name] = mapping.sourceView === undefined ? projected : sourceStateView(mapping.sourceView, projected);
  }
  const same = (left: unknown, right: unknown): boolean => canonicalizeJson(left) === canonicalizeJson(right);
  const identity = (entry: SnapshotEntry): string => canonicalizeJson(entry.identity);
  const prior = new Map(before.entries.map(entry => [identity(entry), entry]));
  const current = new Map(after.entries.map(entry => [identity(entry), entry]));
  const desired = (entry: SnapshotEntry, old?: SnapshotEntry): boolean => !entry.absent && outcome.stateFields.every(name => {
    if (!Object.hasOwn(entry.state, name)) return false;
    if (Object.hasOwn(expected, name)) return same(entry.state[name], expected[name]);
    return old !== undefined && Object.hasOwn(old.state, name) && same(entry.state[name], old.state[name]);
  });
  if (outcome.kind === "absent") {
    return before.entries.length > 0 && before.entries.every(entry => {
      const next = current.get(identity(entry));
      return next === undefined || next.absent === true;
    });
  }
  if (Object.keys(expected).length === 0) throw new RegistryError("invalid-inventory", "reconciliation requires an explicit expected postcondition");
  if (outcome.kind === "exists") {
    const candidates = after.entries.filter(entry => !entry.absent && (prior.get(identity(entry))?.absent ?? !prior.has(identity(entry))) && desired(entry));
    return candidates.length === 1 && before.entries.every(entry => {
      if (entry.absent) return true;
      const next = current.get(identity(entry));
      return next !== undefined && same(entry, next);
    });
  }
  if (before.entries.length !== after.entries.length || (outcome.kind === "upsert" && before.entries.length === 0)) return false;
  return before.entries.every(entry => {
    const next = current.get(identity(entry));
    if (!next) return false;
    if (entry.absent && outcome.kind !== "upsert") return next.absent === true;
    if (outcome.identityFields.some(name => !Object.hasOwn(entry.identity, name) || !same(entry.identity[name], next.identity[name]))) return false;
    return desired(next, entry);
  });
}
