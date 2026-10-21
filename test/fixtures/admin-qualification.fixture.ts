import { readFileSync } from "node:fs";
import { OperationRegistry, operationContractBinding, type OperationDescriptor } from "../../src/admin/registry.ts";
import type { OperationEligibilityRecord } from "../../src/admin/eligibility.ts";

/** Synthetic dispatch authority for unit fixtures only; never release evidence. */
export function fixtureRegistry(input: readonly OperationDescriptor[]): OperationRegistry {
  const release = JSON.parse(readFileSync(new URL("../../contracts/release-eligibility.json", import.meta.url), "utf8")) as { release: { commit: string } };
  const records: OperationEligibilityRecord[] = [];
  const descriptors = input.map(original => {
    const descriptor = structuredClone(original);
    const binding = operationContractBinding(descriptor, { routeImportsSha256: "0".repeat(64), frameworkContextSha256: "0".repeat(64) });
    const test = { id: "test/fixtures/admin-qualification.fixture.ts", caseSha256: "0".repeat(64), outcomeSha256: "0".repeat(64) };
    records.push({ operationId: descriptor.operationId, status: "verified", reason: "Synthetic fixture authority; not release qualification.",
      source: descriptor.source, binding, test, evidence: [{ kind: "synthetic-fixture", detail: "Unit-dispatch authority only; no pinned-source qualification is claimed." }] });
    return { ...descriptor, qualification: { releaseCommit: release.release.commit, binding, test } };
  });
  return new OperationRegistry(descriptors, { records });
}
