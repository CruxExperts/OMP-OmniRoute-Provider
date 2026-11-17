import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash, validateConcurrencyContract, validateConcurrencyLifecycleObservation } from "../scripts/generate-contracts.ts";
import { canonicalizeJson, OperationRegistry, operationContractBinding } from "../src/admin/registry.ts";
import { isVerifiedEligibility, type OperationEligibilityRecord } from "../src/admin/eligibility.ts";
import { CONCURRENCY_ID, ConcurrencyFixture, concurrencyContract, concurrencyDescriptor } from "./fixtures/concurrency.fixture.ts";

const descriptor = concurrencyDescriptor();
const release = JSON.parse(readFileSync(new URL("../contracts/release-eligibility.json", import.meta.url), "utf8")) as { release: { commit: string }; sourceDerivation: { record: string; sha256: string }; effectiveTreeSha256: string };
const digest = "0".repeat(64);
const binding = operationContractBinding(descriptor, { routeImportsSha256: digest, frameworkContextSha256: digest, sourceDerivation: release.sourceDerivation, effectiveTreeSha256: release.effectiveTreeSha256 });
const proofTest = { id: "test/admin-concurrency.test.ts", caseSha256: digest, outcomeSha256: digest };
const evidenceDigests = { ingressSha256: digest, lifecycleSha256: digest, effectSha256: digest };
const qualification = { releaseCommit: release.release.commit, binding, test: proofTest, ...evidenceDigests };
const proof: OperationEligibilityRecord = { operationId: CONCURRENCY_ID, status: "verified", reason: "Synthetic dispatch authority only", source: descriptor.source, binding, test: proofTest, ...evidenceDigests, evidence: [{ kind: "fixture", detail: "Not release evidence" }] };
const authority = new OperationRegistry([{ ...descriptor, qualification }], { records: [proof] });
const adapter = authority.require(CONCURRENCY_ID);
const complete = new Set<string>();
let before: { rateLimits: number; comboQueues: number; semaphores: number } | undefined;
let observation: { before: { rateLimits: number; comboQueues: number; semaphores: number }; after: { rateLimits: number; comboQueues: number; semaphores: number }; result: { status: number; body: unknown } } | undefined;
const testId = "test/admin-concurrency.test.ts";
afterAll(async () => {
  if (!observation || ["contract", "auth", "populated", "block"].some(key => !complete.has(key))) return;
  const contract = concurrencyContract(), binding = operationEvidenceBinding(CONCURRENCY_ID, contract);
  const caseSha256 = testCaseSourceHash(testId), artifactPath = outcomeArtifactPath(CONCURRENCY_ID);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId: CONCURRENCY_ID, testId, caseSha256, binding, observation })}\n`, { mode: 0o600 });
  testOutcomeHash(CONCURRENCY_ID, testId, caseSha256, binding, contract, artifactPath);
});
type Snapshot = { timestamp: string; rateLimits: Record<string, unknown>; comboQueues: Record<string, { running: number; queued: number; max: number; rateLimitedUntil: string | null }>; semaphores: Record<string, { running: number; queued: number; maxConcurrency: number; blockedUntil: string | null }> };

test("concurrency authority requires matching ingress, lifecycle and effect receipts", () => {
  const expected = { source: descriptor.source, qualification, binding };
  expect(isVerifiedEligibility(proof, expected)).toBe(true);
  for (const field of ["ingressSha256", "lifecycleSha256", "effectSha256"] as const) {
    const { [field]: _missing, ...withoutDigest } = proof;
    expect(isVerifiedEligibility(withoutDigest, expected)).toBe(false);
    expect(isVerifiedEligibility({ ...proof, [field]: "1".repeat(64) }, expected)).toBe(false);
    const { [field]: _receiptMissing, ...withoutReceipt } = qualification;
    expect(isVerifiedEligibility(proof, { ...expected, qualification: withoutReceipt })).toBe(false);
  }
  expect(isVerifiedEligibility({ ...proof, operationId: "GET /api/health" }, expected)).toBe(false);
  expect(isVerifiedEligibility({ ...proof, operationId: "GET /api/acp/agents" }, expected)).toBe(false);
});

test("concurrency effect schema rejects cross-domain artifacts", () => {
  const schema = JSON.parse(readFileSync(new URL("../contracts/release-eligibility.schema.json", import.meta.url), "utf8")) as { $defs: { operation: { allOf: Array<{ if: { properties: { operationId?: { const?: string } } }; then: { properties?: { effectEvidence?: { properties: { artifact: { pattern: string } } } } } }> } } };
  const clause = schema.$defs.operation.allOf.find(row => row.if.properties.operationId?.const === CONCURRENCY_ID);
  const pattern = new RegExp(clause!.then.properties!.effectEvidence!.properties.artifact.pattern);
  expect(pattern.test(`provenance/qualification/concurrency-lifecycle-${digest}.json`)).toBe(true);
  expect(pattern.test(`provenance/qualification/csrf-lifecycle-${digest}.json`)).toBe(false);
  expect(pattern.test(`provenance/qualification/deprecated-provider-sweep-${digest}.json`)).toBe(false);
});

test("closed input and conservative lifecycle policy", () => {
  expect(adapter.validate({})).toBeDefined();
  for (const input of [{ query: { extra: "x" } }, { path: { extra: "x" } }, { body: {} }]) expect(() => adapter.validate(input)).toThrow();
  const contract = concurrencyContract();
  expect(contract.sideEffect).toBe("lifecycle");
  expect(contract.confirmation.required).toBe(true);
  expect(contract.retry).toEqual({ allowed: false, maxAttempts: 1, statusCodes: [] });
  expect(contract.mutationSafety?.reconciliation.kind).toBe("unknown");
  expect(contract.mutationSafety?.settlement.responseComplete.statusCodes).toEqual([]);
  validateConcurrencyContract(contract);
  const unsafe = { ...contract, response: { ...contract.response, schema: { type: "object", additionalProperties: true } } };
  expect(() => validateConcurrencyContract(unsafe)).toThrow();
  expect(() => validateConcurrencyLifecycleObservation({}, {})).toThrow();
  complete.add("contract");
});

test("management auth, genuine empty snapshot, and uncaught handler failure", async () => {
  const fixture = new ConcurrencyFixture();
  try {
    for (const [token, status] of [[undefined, 401], ["fixture-low", 403], ["oma_fixture-invalid", 401], ["fixture-manage", 200], ["oma_fixture-read", 200], ["oma_fixture-admin", 200]] as const) {
      expect((await fixture.handle(token)).status).toBe(status);
    }
    const response = await fixture.handle("oma_fixture-read");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json() as Snapshot;
    expect(Number.isFinite(Date.parse(body.timestamp))).toBe(true);
    expect(body.rateLimits).toEqual({}); expect(body.comboQueues).toEqual({}); expect(body.semaphores).toEqual({});
    before = { rateLimits: Object.keys(body.rateLimits).length, comboQueues: Object.keys(body.comboQueues).length, semaphores: Object.keys(body.semaphores).length };
    complete.add("auth");
    expect(adapter.project(body)).toEqual({ rateLimits: {}, comboQueues: {}, semaphores: {} });
  } finally { await fixture.close(); }
  const broken = new ConcurrencyFixture(true);
  try { await expect(broken.handle("oma_fixture-read")).rejects.toThrow("Unapproved concurrency fixture boundary"); }
  finally { await broken.close(); }
});

test("actual semaphore producers seed populated private snapshots without dispatch", async () => {
  const fixture = new ConcurrencyFixture();
  try {
    const acquireCombo = fixture.combo.acquire as (key: string, options: { maxConcurrency: number }) => Promise<() => void>;
    const acquireAccount = fixture.account.acquire as (key: string, options: { maxConcurrency: number }) => Promise<() => void>;
    const releaseCombo = await acquireCombo("combo:private-combo", { maxConcurrency: 2 });
    const releaseOther = await acquireCombo("model:private-not-combo", { maxConcurrency: 3 });
    const releaseAccount = await acquireAccount("private-provider:private-account", { maxConcurrency: 4 });
    try {
      const response = await fixture.handle("oma_fixture-read");
      const body = await response.json() as Snapshot;
      expect(body.rateLimits).toEqual({});
      expect(body.comboQueues).toEqual({ "combo:private-combo": { running: 1, queued: 0, max: 2, rateLimitedUntil: null } });
      expect(body.semaphores).toEqual({ "private-provider:private-account": { running: 1, queued: 0, maxConcurrency: 4, blockedUntil: null } });
      const projected = adapter.project(body);
      expect(adapter.projectTarget(body)).toEqual(projected);
      expect(projected).toEqual({ rateLimits: {}, comboQueues: {}, semaphores: {} });
      expect(JSON.stringify(projected)).not.toContain("private");
      if (!before) throw new Error("Empty snapshot was not observed");
      observation = { before, after: { rateLimits: Object.keys(body.rateLimits).length, comboQueues: Object.keys(body.comboQueues).length, semaphores: Object.keys(body.semaphores).length }, result: { status: response.status, body: projected } };
      complete.add("populated");
      expect(adapter.project({ ...body, rateLimits: { "private-key": { queued: 1, running: 1, executing: 0 } } })).toEqual(projected);
      expect(() => adapter.project({ ...body, semaphores: null })).toThrow();
    } finally { releaseCombo(); releaseOther(); releaseAccount(); }
  } finally { await fixture.close(); }
});

test("account block is reported by the source without being consumed by reads", async () => {
  const fixture = new ConcurrencyFixture();
  try {
    (fixture.account.markBlocked as (key: string, ms: number) => void)("private-provider:private-account", 60_000);
    const first = await (await fixture.handle("oma_fixture-read")).json() as Snapshot;
    const second = await (await fixture.handle("oma_fixture-read")).json() as Snapshot;
    expect(typeof first.semaphores["private-provider:private-account"]?.blockedUntil).toBe("string");
    expect(second.semaphores).toEqual(first.semaphores);
    (fixture.account.unblock as (key: string) => void)("private-provider:private-account");
    const after = await (await fixture.handle("oma_fixture-read")).json() as Snapshot;
    expect(after.semaphores).toEqual({});
    complete.add("block");
  } finally { await fixture.close(); }
});

test("elapsed blocks survive snapshots until source admission and idle cleanup", async () => {
  const fixture = new ConcurrencyFixture();
  const key = "private-provider:private-account";
  try {
    (fixture.account.markBlocked as (key: string, ms: number) => void)(key, 50);
    const first = await (await fixture.handle("oma_fixture-read")).json() as Snapshot;
    const deadline = Date.parse(first.semaphores[key]?.blockedUntil ?? "");
    expect(Number.isFinite(deadline)).toBe(true);
    // This integration case must exercise the source's actual wall clock.
    await delay(Math.max(0, deadline - Date.now()) + 10);
    const elapsed = await (await fixture.handle("oma_fixture-read")).json() as Snapshot;
    expect(elapsed.semaphores).toEqual(first.semaphores);
    const release = await (fixture.account.acquire as (key: string, options: { maxConcurrency: number }) => Promise<() => void>)(key, { maxConcurrency: 1 });
    release();
    // Wait for the source's asynchronous idle-cleanup timer, not a fixed deadline.
    const cleanupDeadline = Date.now() + 2_000;
    let cleaned = await (await fixture.handle("oma_fixture-read")).json() as Snapshot;
    while (Object.keys(cleaned.semaphores).length && Date.now() < cleanupDeadline) {
      await delay(10);
      cleaned = await (await fixture.handle("oma_fixture-read")).json() as Snapshot;
    }
    expect(cleaned.semaphores).toEqual({});
  } finally { await fixture.close(); }
});
