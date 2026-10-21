import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash } from "./generate-contracts.ts";

const root = resolve(import.meta.dir, "..");
type RecordValue = Record<string, unknown>;
const record = (value: unknown): RecordValue => {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid qualification record");
  return value as RecordValue;
};
/** Compare freshly executed outcomes with reviewed, content-addressed reference evidence. */
export function verifyFreshQualification(): { verifiedOperations: number } {
  const eligibility = record(JSON.parse(readFileSync(resolve(root, "contracts/release-eligibility.json"), "utf8")));
  if (!Array.isArray(eligibility.operations)) throw new Error("Qualification operation inventory is missing");
  for (const value of eligibility.operations) {
    const entry = record(value);
    if (entry.status !== "verified" || typeof entry.operationId !== "string") throw new Error("Invalid qualified operation identity");
    const test = record(entry.test);
    if (typeof test.id !== "string" || typeof test.observedOutcome !== "string" || !/^provenance\/qualification\/[a-f0-9]{64}\.json$/.test(test.observedOutcome)) throw new Error("Qualification must reference reviewed content-addressed evidence");
    const binding = operationEvidenceBinding(entry.operationId, entry.contract);
    const currentCase = testCaseSourceHash(test.id);
    if (test.caseSha256 !== currentCase) throw new Error(`Qualification test source changed: ${entry.operationId}`);
    const referenceOutcome = testOutcomeHash(entry.operationId, test.id, currentCase, binding, entry.contract, test.observedOutcome);
    if (referenceOutcome !== test.outcomeSha256) throw new Error(`Reviewed outcome digest changed: ${entry.operationId}`);
    const freshOutcome = testOutcomeHash(entry.operationId, test.id, currentCase, binding, entry.contract, outcomeArtifactPath(entry.operationId));
    if (freshOutcome !== referenceOutcome) throw new Error(`Fresh outcome differs from reviewed qualification: ${entry.operationId}`);
  }
  return { verifiedOperations: eligibility.operations.length };
}
if (import.meta.main) console.log(JSON.stringify(verifyFreshQualification()));
