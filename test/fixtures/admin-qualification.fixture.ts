import { readFileSync } from "node:fs";
import { OperationRegistry, operationContractBinding, type OperationDescriptor } from "../../src/admin/registry.ts";
import { operationRequiresIngressEvidence, type OperationEligibilityRecord } from "../../src/admin/eligibility.ts";

/** Synthetic dispatch authority for unit fixtures only; never release evidence. */
export function fixtureRegistry(input: readonly OperationDescriptor[]): OperationRegistry {
  const release = JSON.parse(readFileSync(new URL("../../contracts/release-eligibility.json", import.meta.url), "utf8")) as {
    release: { commit: string };
    sourceDerivation?: { record: string; sha256: string };
    effectiveTreeSha256?: string;
  };
  const records: OperationEligibilityRecord[] = [];
  const descriptors = input.map(original => {
    const descriptor = structuredClone(original);
    const binding = operationContractBinding(descriptor, {
      routeImportsSha256: "0".repeat(64), frameworkContextSha256: "0".repeat(64),
      ...(release.sourceDerivation ? { sourceDerivation: release.sourceDerivation, effectiveTreeSha256: release.effectiveTreeSha256 } : {}),
    });
    const test = { id: "test/fixtures/admin-qualification.fixture.ts", caseSha256: "0".repeat(64), outcomeSha256: "0".repeat(64) };
    const ingress = operationRequiresIngressEvidence(descriptor.operationId) ? { ingressSha256: "0".repeat(64) } : {};
    const lifecycle = descriptor.databaseInitializationRequired ? { lifecycleSha256: "0".repeat(64) } : {};
    const effect = descriptor.operationId === "GET /api/providers/deprecated" || descriptor.operationId === "GET /api/auth/csrf" ? { effectSha256: "0".repeat(64) } : {};
    const native = descriptor.operationId === "GET /api/acp/agents" ? { nativeEvidenceSha256: "0".repeat(64) } : {};
    const a2a = descriptor.operationId === "GET /api/a2a/status" ? { a2aEvidenceSha256: "0".repeat(64) } : {};
    records.push({ operationId: descriptor.operationId, status: "verified", reason: "Synthetic fixture authority; not release qualification.",
      source: descriptor.source, binding, test, ...ingress, ...lifecycle, ...effect, ...native, ...a2a, evidence: [{ kind: "synthetic-fixture", detail: "Unit-dispatch authority only; no pinned-source qualification is claimed." }] });
    return { ...descriptor, qualification: { releaseCommit: release.release.commit, binding, test, ...ingress, ...lifecycle, ...effect, ...native, ...a2a } };
  });
  return new OperationRegistry(descriptors, { records });
}
