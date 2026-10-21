import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { AdminSideEffect } from "./types.ts";
import type { OperationDescriptor } from "./registry.ts";

export type ReleaseEligibilityStatus = "verified" | "unavailable";
export interface OperationEligibilitySource {
  readonly file: string;
  readonly sha256: string;
  readonly gitBlobSha: string;
}
export interface OperationEligibilityEvidence { readonly kind: string; readonly detail: string }
export interface OperationContractBinding {
  readonly requestSchemaSha256: string;
  readonly authSha256: string;
  readonly sideEffect: AdminSideEffect;
  readonly responseProjectionSha256: string;
  readonly operationSemanticsSha256: string;
  readonly routeImportsSha256: string;
  readonly frameworkContextSha256: string;
}
export interface OperationEvidenceBinding extends OperationContractBinding {
  readonly handlerSha256: string;
  readonly handlerGitBlobSha: string;
  readonly sideEffectSha256: string;
}
export interface OperationQualificationTest {
  readonly id: string;
  readonly caseSha256: string;
  readonly outcomeSha256: string;
}
export interface OperationQualificationReceipt {
  readonly releaseCommit: string;
  readonly binding: OperationEvidenceBinding;
  readonly test: OperationQualificationTest;
}
export type OperationSourceContract = Pick<OperationDescriptor,
  "request" | "auth" | "response" | "secrets" | "sideEffect" | "pagination" | "streaming" | "confirmation" | "retry" | "reconciliation">;

/** Runtime keeps a compact proof view, not a second copy of every source contract. */
export interface OperationEligibilityRecord {
  readonly operationId: string;
  readonly status: ReleaseEligibilityStatus;
  readonly reason: string;
  readonly source?: OperationEligibilitySource;
  readonly evidence?: readonly OperationEligibilityEvidence[];
  readonly binding?: OperationContractBinding;
  readonly test?: OperationQualificationTest;
}
interface EligibilityDocument {
  readonly releaseCommit?: string;
  readonly default: { readonly status: "unavailable"; readonly reason: string };
  readonly operations: readonly OperationEligibilityRecord[];
}
export interface EligibilityOptions { readonly records?: readonly OperationEligibilityRecord[] }
export interface EligibilityVerification {
  readonly source: OperationEligibilitySource;
  readonly qualification: OperationQualificationReceipt | undefined;
  readonly binding: OperationEvidenceBinding | undefined;
}

const DEFAULT_REASON = "No exact pinned-source and observed behavior evidence is recorded for this operation in the release eligibility contract.";
const CONTRACT_FIELDS = ["request", "auth", "response", "secrets", "sideEffect", "pagination", "streaming", "confirmation", "retry", "reconciliation"] as const;
const HASH_FIELDS = ["requestSchemaSha256", "authSha256", "responseProjectionSha256", "operationSemanticsSha256", "routeImportsSha256", "frameworkContextSha256"] as const;
let document: EligibilityDocument | undefined;
function unavailable(operationId: string, reason = DEFAULT_REASON): OperationEligibilityRecord { return { operationId, status: "unavailable", reason }; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function sha(value: unknown, length: number): value is string { return typeof value === "string" && new RegExp(`^[a-f0-9]{${length}}$`).test(value); }
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function parseRecord(value: unknown): OperationEligibilityRecord | undefined {
  if (!record(value) || typeof value.operationId !== "string" || !value.operationId || value.status !== "verified" || typeof value.reason !== "string" || !value.reason) return undefined;
  const source = value.source;
  const contract = value.contract;
  const binding = value.binding;
  const test = value.test;
  const evidence = value.evidence;
  if (!record(source) || typeof source.file !== "string" || !sha(source.sha256, 64) || !sha(source.gitBlobSha, 40)) return undefined;
  if (!record(contract) || Object.keys(contract).length !== CONTRACT_FIELDS.length || CONTRACT_FIELDS.some(key => !Object.hasOwn(contract, key))) return undefined;
  if (!record(binding) || Object.keys(binding).length !== HASH_FIELDS.length + 1 || HASH_FIELDS.some(key => !sha(binding[key], 64))
    || !["read", "mutation", "secret", "lifecycle", "destructive"].includes(String(binding.sideEffect))) return undefined;
  if (!record(test) || typeof test.id !== "string" || !/^test\/(?!.*(?:^|\/)\.\.(?:\/|$))[^\\]+$/.test(test.id) || !sha(test.caseSha256, 64) || !sha(test.outcomeSha256, 64)) return undefined;
  if (typeof test.observedOutcome !== "string" || !/^provenance\/qualification\/[a-f0-9]{64}\.json$/.test(test.observedOutcome)) return undefined;
  if (!Array.isArray(evidence) || evidence.length === 0 || evidence.some(item => !record(item) || typeof item.kind !== "string" || !item.kind || typeof item.detail !== "string" || !item.detail)) return undefined;
  return freeze({ operationId: value.operationId, status: "verified", reason: value.reason,
    source: { file: source.file, sha256: source.sha256, gitBlobSha: source.gitBlobSha },
    binding: { ...Object.fromEntries(HASH_FIELDS.map(key => [key, binding[key]])), sideEffect: binding.sideEffect } as unknown as OperationContractBinding,
    test: { id: test.id, caseSha256: test.caseSha256, outcomeSha256: test.outcomeSha256 },
    evidence: evidence.map(item => ({ kind: String(item.kind), detail: String(item.detail) })) });
}
function loadDocument(): EligibilityDocument {
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolve(import.meta.dir, "../../contracts/release-eligibility.json"), "utf8"));
    if (!record(parsed) || parsed.schemaVersion !== 2 || parsed.recordKind !== "omniroute-release-eligibility" || !record(parsed.release) || !sha(parsed.release.commit, 40)
      || !record(parsed.default) || parsed.default.status !== "unavailable" || typeof parsed.default.reason !== "string" || !parsed.default.reason || !Array.isArray(parsed.operations)) throw new Error("invalid eligibility document");
    const operations = parsed.operations.map(parseRecord);
    if (operations.some(item => item === undefined)) throw new Error("invalid operation evidence");
    return freeze({ releaseCommit: parsed.release.commit, default: { status: "unavailable", reason: parsed.default.reason }, operations: operations as OperationEligibilityRecord[] });
  } catch { return freeze({ default: { status: "unavailable", reason: DEFAULT_REASON }, operations: [] }); }
}
function currentDocument(): EligibilityDocument { return document ??= loadDocument(); }
export function createEligibilityIndex(options: EligibilityOptions = {}): ReadonlyMap<string, OperationEligibilityRecord> {
  const records = options.records ?? currentDocument().operations;
  const index = new Map<string, OperationEligibilityRecord>();
  for (const item of records) {
    if (!item.operationId) continue;
    if (index.has(item.operationId)) { index.set(item.operationId, unavailable(item.operationId, "Eligibility contract contains duplicate records for this operation.")); continue; }
    index.set(item.operationId, options.records === undefined ? item : freeze(structuredClone(item)));
  }
  return index;
}
export function eligibilityFor(operationId: string, index: ReadonlyMap<string, OperationEligibilityRecord>): OperationEligibilityRecord {
  return index.get(operationId) ?? unavailable(operationId, currentDocument().default.reason);
}
export function isVerifiedEligibility(item: OperationEligibilityRecord, expected: EligibilityVerification): boolean {
  const { source, qualification, binding } = expected;
  if (item.status !== "verified" || !qualification || !binding || !item.binding || !item.test || !item.evidence?.length
    || !sha(qualification.releaseCommit, 40) || qualification.releaseCommit !== currentDocument().releaseCommit
    || item.source?.file !== source.file || item.source.sha256 !== source.sha256 || item.source.gitBlobSha !== source.gitBlobSha
    || qualification.binding.handlerSha256 !== source.sha256 || qualification.binding.handlerGitBlobSha !== source.gitBlobSha
    || item.test.id !== qualification.test.id || item.test.caseSha256 !== qualification.test.caseSha256 || item.test.outcomeSha256 !== qualification.test.outcomeSha256
    || !sha(item.test.caseSha256, 64) || !sha(item.test.outcomeSha256, 64)) return false;
  if (binding.sideEffect === "unknown" || item.binding.sideEffect !== binding.sideEffect) return false;
  for (const key of HASH_FIELDS) if (!sha(binding[key], 64) || item.binding[key] !== binding[key] || qualification.binding[key] !== binding[key]) return false;
  return qualification.binding.sideEffect === binding.sideEffect && qualification.binding.sideEffectSha256 === binding.sideEffectSha256;
}
