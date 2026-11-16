import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash, validateA2aStatusContract } from "../scripts/generate-contracts.ts";
import { createAdminExecutor } from "../src/admin/executor.ts";
import { canonicalizeJson, OperationRegistry, projectResponse, type OperationDescriptor } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { A2A_STATUS_ID, A2aStatusFixture, a2aStatusContract, a2aStatusDescriptor } from "./fixtures/a2a-status.fixture.ts";

const TEST_ID = "test/admin-a2a-status.test.ts";
let observation: { before: unknown; after: unknown; result: { status: number; body: unknown } } | undefined;
let authObserved = false, executorObserved = false;
afterAll(async () => {
  if (!observation || !authObserved || !executorObserved) return;
  const contract = a2aStatusContract(), binding = operationEvidenceBinding(A2A_STATUS_ID, contract), caseSha256 = testCaseSourceHash(TEST_ID), path = outcomeArtifactPath(A2A_STATUS_ID);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), path), `${canonicalizeJson({ operationId: A2A_STATUS_ID, testId: TEST_ID, caseSha256, binding, observation })}\n`, { mode: 0o600 });
  testOutcomeHash(A2A_STATUS_ID, TEST_ID, caseSha256, binding, contract, path);
});

function registry(descriptors: readonly OperationDescriptor[]): OperationRegistry {
  const base = fixtureRegistry(descriptors);
  return new class extends OperationRegistry {
    constructor() { super([]); }
    override require(id: string) { return { ...base.require(id), eligibility: { operationId: id, status: "verified" as const, reason: "Synthetic executor fixture only." } }; }
  }();
}

test("pinned status reads cached settings and process-local task counts, with actual card and failures", async () => {
  const f = new A2aStatusFixture();
  const previous = globalThis.fetch;
  globalThis.fetch = Object.assign(async () => Response.json([]), { preconnect: previous.preconnect });
  try {
    let response = await f.handle();
    let raw = await response.json();
    expect(raw).toMatchObject({ status: "disabled", online: false, enabled: false, agent: null, capabilities: null, skills: [], tasks: { total: 0, activeStreams: 0 } });
    expect(f.cardCalls).toBe(0); expect(f.reads).toBe(1);
    const task = f.manager.createTask({ skill: "fixture-private-skill", messages: [{ role: "user", content: "fixture-private-message" }] }, "fixture-private-owner");
    f.manager.updateTask(task.id, "working"); f.manager.beginStream();
    f.enabled = true;
    raw = await (await f.handle()).json();
    expect(raw.enabled).toBe(false); expect(f.reads).toBe(1);
    f.now += 5001;
    const beforeStats = f.manager.getStats();
    const before = { settingsEnabled: f.enabled, settingsReads: f.reads, cardCalls: f.cardCalls, tasks: { counts: beforeStats.counts, total: beforeStats.total, activeStreams: beforeStats.activeStreams } };
    response = await f.handle(); raw = await response.json();
    expect(raw).toMatchObject({ status: "ok", online: true, enabled: true, tasks: { total: 1, activeStreams: 1, counts: { submitted: 0, working: 1, completed: 0, failed: 0, cancelled: 0 } }, agent: { name: "OmniRoute AI Gateway" } });
    expect(response.status).toBe(200);
    expect(f.cardCalls).toBe(1); expect(f.reads).toBe(2);
    const projected = projectResponse(a2aStatusDescriptor(), raw);
    expect(projected).toMatchObject({ status: "ok", tasks: { total: 1, activeStreams: 1 }, agent: { name: "OmniRoute AI Gateway" }, capabilities: { streaming: true } });
    expect(JSON.stringify(projected)).not.toContain("fixture.invalid");
    expect(JSON.stringify(projected)).not.toContain("fixture-private");
    expect(projected).not.toHaveProperty("skills");
    const afterStats = f.manager.getStats();
    const after = { settingsEnabled: f.enabled, settingsReads: f.reads, cardCalls: f.cardCalls, tasks: { counts: afterStats.counts, total: afterStats.total, activeStreams: afterStats.activeStreams } };
    observation = { before, after, result: { status: response.status, body: projected } };
    f.failCard = true;
    raw = await (await f.handle()).json();
    expect(raw).toMatchObject({ enabled: true, agent: null, capabilities: null, skills: [] });
    expect(projectResponse(a2aStatusDescriptor(), raw)).toMatchObject({ agent: null, capabilities: null });
    f.invalidate(); f.failSettings = true;
    response = await f.handle(); raw = await response.json();
    expect(response.status).toBe(500); expect(raw.error).toBe("fixture-private-settings-error");
  } finally { globalThis.fetch = previous; f.close(); }
});

test("pinned central policy distinguishes anonymous and management credentials", async () => {
  const f = new A2aStatusFixture();
  try {
    let calls = 0;
    const request = (authorization?: string) => new Request("http://fixture.invalid/api/a2a/status", { headers: authorization ? { authorization } : {} });
    const dispatch = (authorization?: string, required = true) => f.auth.dispatch(request(authorization), { centralAuthRequired: required, handlerAuthRequired: false }, async () => { calls++; return f.handle(); });
    expect((await dispatch()).status).toBe(401);
    expect(calls).toBe(0);
    expect((await dispatch("Bearer fixture-read-key")).status).toBe(403);
    expect((await dispatch("Bearer fixture-manage")).status).toBe(200);
    for (const scope of ["read", "write", "admin"]) expect((await dispatch(`Bearer oma_${scope}`)).status).toBe(200);
    expect((await dispatch("Bearer oma_unknown")).status).toBe(401);
    expect((await dispatch(undefined, false)).status).toBe(200);
    expect(calls).toBe(5);
    authObserved = true;
  } finally { f.close(); }
});

test("candidate request and projection are closed and lifecycle execution is one shot", async () => {
  const contract = a2aStatusContract();
  expect(() => validateA2aStatusContract(contract)).not.toThrow();
  expect(() => validateA2aStatusContract({ ...contract, sideEffect: "read" })).toThrow();
  expect(() => validateA2aStatusContract({ ...contract, confirmation: { ...contract.confirmation, required: false } })).toThrow();
  expect(() => validateA2aStatusContract({ ...contract, retry: { allowed: true, maxAttempts: 2, statusCodes: [500] } })).toThrow();
  expect(contract.auth.domain).toBe("management"); expect(contract.sideEffect).toBe("lifecycle");
  expect(contract.confirmation.required).toBe(true); expect(contract.retry).toEqual({ allowed: false, maxAttempts: 1, statusCodes: [] });
  expect(contract.mutationSafety?.settlement.responseComplete.statusCodes).toEqual([]);
  const adapter = fixtureRegistry([a2aStatusDescriptor()]).require(A2A_STATUS_ID);
  expect(adapter.validate({})).toEqual({ path: {}, query: {} });
  expect(() => adapter.validate({ query: { token: "private" } })).toThrow();
  expect(() => adapter.validate({ body: {} })).toThrow();
  const f = new A2aStatusFixture();
  try {
    let calls = 0;
    const seen: unknown[] = [];
    const executor = createAdminExecutor({ registry: registry([a2aStatusDescriptor()]), dispatch: async (_operation, context) => {
      calls++; seen.push({ credential: context.auth.credential, retryAllowed: context.retryAllowed });
      const response = await f.handle(); return { kind: "response", status: response.status, body: await response.json() };
    } });
    const endpoint = "http://127.0.0.1:20128";
    executor.setAdminBinding({ profileId: "omniroute", endpoint });
    executor.bindCredential({ profileId: "omniroute", endpoint, apiKey: "fixture-management-key" });
    const denied = await executor.plan(A2A_STATUS_ID, {});
    expect((await executor.apply(denied.planId, { confirmed: false })).status).toBe("denied"); expect(calls).toBe(0);
    const plan = await executor.plan(A2A_STATUS_ID, {});
    const result = await executor.apply(plan.planId, { confirmed: true });
    expect(result.status).toBe("unknown"); expect(calls).toBe(1);
    expect(seen).toEqual([{ credential: { kind: "apiKey", value: "fixture-management-key" }, retryAllowed: false }]);
    expect(JSON.stringify(result)).not.toContain("fixture-management-key");
    expect(() => projectResponse(a2aStatusDescriptor(), { status: "ok", online: true, enabled: true, tasks: { counts: { submitted: -1, working: 0, completed: 0, failed: 0, cancelled: 0 }, total: 0, activeStreams: 0 }, agent: null, capabilities: null })).toThrow();
    executorObserved = true;
  } finally { f.close(); }
});
