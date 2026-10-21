import { afterAll, afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  operationEvidenceBinding,
  outcomeArtifactPath,
  testCaseSourceHash,
  testOutcomeHash,
} from "../scripts/generate-contracts.ts";
import { invokeJsonAdapter } from "../src/admin/adapters.ts";
import { createAdminExecutor } from "../src/admin/executor.ts";
import { canonicalizeJson, type OperationAdapter, type OperationDescriptor } from "../src/admin/registry.ts";
import { assertSafetyReadRequest, assertSafetyReadResponse, mapRelationInput, projectRelationSnapshot } from "../src/admin/relations.ts";
import {
  buildProviderCcAliasRegistry,
  PROVIDER_CC_ALIAS_OPERATION_IDS,
  PROVIDER_CC_ALIAS_SOURCE_CONTRACTS,
  ProviderCcAliasFixture,
  type ProviderCcAliasOperationId,
} from "./fixtures/provider-cc-alias.fixture.ts";

const [GET_CC_ALIAS, PUT_CC_ALIAS] = PROVIDER_CC_ALIAS_OPERATION_IDS;
const TEST_ID = "test/admin-provider-cc-alias.test.ts";
const PROFILE_ID = "provider-cc-alias-source-fixture";
const MANAGEMENT_KEY = "fixture-cc-alias-manage";
const READ_KEY = "fixture-cc-alias-read";
const FIXED_NOW = Date.parse("2026-10-20T00:00:00.000Z");

type JsonRecord = Record<string, unknown>;
type HttpSnapshot = { readonly status: number; readonly body: unknown };
type Outcome = { readonly before: unknown; readonly after: unknown; readonly result: { readonly status: number; readonly body: unknown } };

function asRecord(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a JSON object");
  return value as JsonRecord;
}

function descriptorFor(adapter: OperationAdapter) {
  return {
    ...adapter.descriptor,
    adapterId: adapter.adapterId,
  } satisfies OperationDescriptor & { readonly adapterId: string };
}

async function directRequest(
  fixture: ProviderCcAliasFixture,
  method: "GET" | "PUT",
  provider: string,
  options: { readonly key?: string; readonly body?: unknown } = {},
): Promise<HttpSnapshot> {
  const response = await fetch(`${fixture.endpoint}/api/providers/${encodeURIComponent(provider)}/cc-alias`, {
    method,
    headers: {
      ...(options.key === undefined ? {} : { authorization: `Bearer ${options.key}` }),
      ...(options.body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  let body: unknown;
  try { body = await response.json(); }
  catch { body = null; }
  return { status: response.status, body };
}

async function directRawPut(fixture: ProviderCcAliasFixture, provider: string, body: string): Promise<HttpSnapshot> {
  const response = await fetch(`${fixture.endpoint}/api/providers/${encodeURIComponent(provider)}/cc-alias`, {
    method: "PUT",
    headers: { authorization: `Bearer ${MANAGEMENT_KEY}`, "content-type": "application/json" },
    body,
  });
  let responseBody: unknown;
  try { responseBody = await response.json(); }
  catch { responseBody = null; }
  return { status: response.status, body: responseBody };
}

function createHarness(fixture: ProviderCcAliasFixture) {
  const registry = buildProviderCcAliasRegistry();
  const responses = new Map<ProviderCcAliasOperationId, HttpSnapshot[]>();
  let loseNextPutResponse = false;
  let targetReads = 0;
  let reconciliationReads = 0;
  let nextPlanId = 0;
  const executor = createAdminExecutor({
    registry,
    now: () => FIXED_NOW,
    randomId: () => `cc-alias-plan-${++nextPlanId}`,
    readTarget: async context => {
      targetReads += 1;
      const readAdapter = registry.require(context.readOperation.operationId);
      const input = readAdapter.validate(mapRelationInput(context.relation.inputs, context.payload));
      assertSafetyReadRequest(context.readCompleteness, descriptorFor(readAdapter), input);
      const response = await invokeJsonAdapter({
        descriptor: descriptorFor(readAdapter),
        endpoint: context.auth.endpoint,
        ...(context.auth.credential === undefined ? {} : { credential: context.auth.credential }),
        resolvedPath: readAdapter.buildPath(input),
        queryParameters: readAdapter.buildQuery(input),
        ...(input.body === undefined ? {} : { body: input.body }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      if (response.status >= 400) throw Object.assign(new Error("pinned source target read failed"), { status: response.status });
      assertSafetyReadResponse(context.readCompleteness, descriptorFor(readAdapter), response.data);
      const snapshot = projectRelationSnapshot(context.relation, response.data, context.payload);
      return {
        digest: createHash("sha256").update(canonicalizeJson(snapshot)).digest("hex"),
        snapshot,
      };
    },
    reconcile: async () => {
      reconciliationReads += 1;
      return { status: "unknown" };
    },
    dispatch: async (request, context) => {
      const operationId = request.operationId as ProviderCcAliasOperationId;
      const adapter = registry.require(operationId);
      const response = await invokeJsonAdapter({
        descriptor: descriptorFor(adapter),
        endpoint: context.auth.endpoint,
        ...(context.auth.credential === undefined ? {} : { credential: context.auth.credential }),
        resolvedPath: request.path,
        queryParameters: request.queryParameters,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const snapshots = responses.get(operationId) ?? [];
      snapshots.push({ status: response.status, body: response.data ?? null });
      responses.set(operationId, snapshots);
      if (operationId === PUT_CC_ALIAS && loseNextPutResponse) {
        loseNextPutResponse = false;
        throw Object.assign(new Error("fixture transport lost the completed HTTP response"), { code: "network-lost-response" });
      }
      if (operationId === PUT_CC_ALIAS) {
        return { kind: "response", status: response.status, body: response.data ?? null };
      }
      if (response.status >= 400) throw Object.assign(new Error("pinned source fixture rejected the request"), { status: response.status });
      return response.data;
    },
  });
  executor.bindCredential({ profileId: PROFILE_ID, endpoint: fixture.endpoint, apiKey: MANAGEMENT_KEY });
  return {
    executor,
    registry,
    responses,
    loseNextPutResponse() { loseNextPutResponse = true; },
    targetReadCount() { return targetReads; },
    reconciliationReadCount() { return reconciliationReads; },
    count(operationId: ProviderCcAliasOperationId) { return responses.get(operationId)?.length ?? 0; },
    last(operationId: ProviderCcAliasOperationId): HttpSnapshot {
      const value = responses.get(operationId)?.at(-1);
      if (!value) throw new Error(`no HTTP response captured for ${operationId}`);
      return value;
    },
  };
}

const completedCases = new Map<ProviderCcAliasOperationId, Set<string>>();
const observations = new Map<ProviderCcAliasOperationId, Outcome>();
const fixtures: ProviderCcAliasFixture[] = [];
const executors: ReturnType<typeof createAdminExecutor>[] = [];
let allAssertionsPassed = false;

function mark(operationId: ProviderCcAliasOperationId, caseId: string): void {
  const cases = completedCases.get(operationId) ?? new Set<string>();
  cases.add(caseId);
  completedCases.set(operationId, cases);
}

function observe(operationId: ProviderCcAliasOperationId, caseIds: readonly string[], outcome: Outcome): void {
  observations.set(operationId, structuredClone(outcome));
  for (const caseId of caseIds) mark(operationId, caseId);
}

afterEach(async () => {
  for (const executor of executors.splice(0)) executor.shutdown();
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()));
});

afterAll(async () => {
  const requiredCases: Readonly<Record<ProviderCcAliasOperationId, readonly string[]>> = {
    [GET_CC_ALIAS]: ["anonymous-auth", "authorized-read", "provider-model-isolation"],
    [PUT_CC_ALIAS]: ["scope-denial", "schema-validation", "trim-set-clear", "credential-cancellation", "selected-target-drift", "competing-plans", "unrelated-alias-change", "prototype-model-identifiers", "malformed-json", "storage-errors", "lost-response-unknown", "partial-error-unknown"],
  };
  if (!allAssertionsPassed || !PROVIDER_CC_ALIAS_OPERATION_IDS.every(operationId =>
    requiredCases[operationId].every(caseId => completedCases.get(operationId)?.has(caseId)) && observations.has(operationId))) return;

  const observationDirectory = resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations");
  await mkdir(observationDirectory, { recursive: true, mode: 0o700 });
  for (const operationId of PROVIDER_CC_ALIAS_OPERATION_IDS) {
    const observation = observations.get(operationId);
    if (!observation) return;
    const contract = PROVIDER_CC_ALIAS_SOURCE_CONTRACTS[operationId];
    const binding = operationEvidenceBinding(operationId, contract);
    const caseSha256 = testCaseSourceHash(TEST_ID);
    const artifactPath = outcomeArtifactPath(operationId);
    const artifact = { operationId, testId: TEST_ID, caseSha256, binding, observation };
    await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson(artifact)}\n`, { mode: 0o600 });
    testOutcomeHash(operationId, TEST_ID, caseSha256, binding, contract, artifactPath);
  }
});

test("pinned v3.8.52 cc-alias GET and PUT preserve source auth, selected-state checks, SQLite, and confirmation semantics", async () => {
  const fixture = new ProviderCcAliasFixture();
  fixtures.push(fixture);
  const harness = createHarness(fixture);
  executors.push(harness.executor);
  expect(PROVIDER_CC_ALIAS_SOURCE_CONTRACTS[GET_CC_ALIAS].mutationSafety).toBeNull();
  expect(PROVIDER_CC_ALIAS_SOURCE_CONTRACTS[PUT_CC_ALIAS].mutationSafety).toMatchObject({
    preflight: {
      kind: "required",
      observations: [{
        name: "selected-provider-cc-alias",
        read: { operationId: GET_CC_ALIAS },
        readCompleteness: {
          kind: "single-response",
          sourceReason: "The pinned v3.8.52 GET reads the provider override by exact key and every model override in one SQLite query, then returns the provider's complete override map in one response.",
        },
      }],
    },
    reconciliation: { kind: "unknown" },
    settlement: { responseComplete: { statusCodes: [200] }, definiteRejection: null },
  });
  const before = fixture.state();
  expect(before).toEqual([]);

  const anonymousRead = await directRequest(fixture, "GET", "anthropic");
  expect(anonymousRead.status).toBe(401);
  const insufficientScope = await directRequest(fixture, "PUT", "anthropic", {
    key: READ_KEY,
    body: { scope: "provider", value: "on" },
  });
  expect(insufficientScope.status).toBe(403);
  expect(fixture.state()).toEqual([]);

  const invalidModel = await directRequest(fixture, "PUT", "anthropic", {
    key: MANAGEMENT_KEY,
    body: { scope: "model", modelId: " \t ", value: "on" },
  });
  expect(invalidModel.status).toBe(400);
  expect(fixture.state()).toEqual([]);

  const initialRead = await harness.executor.read(GET_CC_ALIAS, { path: { id: "anthropic" } });
  expect(initialRead.output).toEqual({ provider: null, models: {} });
  expect(harness.last(GET_CC_ALIAS)).toEqual({ status: 200, body: { provider: null, models: {} } });

  const firstPlan = await harness.executor.plan(PUT_CC_ALIAS, {
    path: { id: "anthropic" },
    body: { scope: "provider", value: "on" },
  });
  expect(firstPlan.preview.confirmationRequired).toBe(true);
  expect(firstPlan.targetDigest).toMatch(/^[a-f0-9]{64}$/);
  expect(firstPlan.preview.projectedTarget).toEqual({
    kind: "resource",
    entries: [{ identity: { providerId: "anthropic", scope: "provider", modelId: null }, state: { value: null } }],
  });
  expect(firstPlan.preview.consequence).toContain("no atomic compare-and-set");
  expect(harness.count(PUT_CC_ALIAS)).toBe(0);
  const firstApply = await harness.executor.apply(firstPlan.planId, { confirmed: true });
  expect(firstApply.status).toBe("applied");
  expect(asRecord(firstApply.output)).toEqual({ success: true });
  expect(harness.count(PUT_CC_ALIAS)).toBe(1);
  expect(fixture.state()).toEqual([{ key: "provider:anthropic", value: "on" }]);

  const trimmedModel = await directRequest(fixture, "PUT", "anthropic", {
    key: MANAGEMENT_KEY,
    body: { scope: "model", modelId: "  model/opus  ", value: "off" },
  });
  expect(trimmedModel.status).toBe(200);
  expect(fixture.state()).toContainEqual({ key: "model:anthropic/model/opus", value: "off" });
  const isolatedModel = await directRequest(fixture, "PUT", "openai", {
    key: MANAGEMENT_KEY,
    body: { scope: "model", modelId: "model/opus", value: "on" },
  });
  expect(isolatedModel.status).toBe(200);
  const isolatedProvider = await directRequest(fixture, "PUT", "openai", {
    key: MANAGEMENT_KEY,
    body: { scope: "provider", value: "on" },
  });
  expect(isolatedProvider.status).toBe(200);
  const anthropicRead = await directRequest(fixture, "GET", "anthropic", { key: MANAGEMENT_KEY });
  expect(anthropicRead).toEqual({ status: 200, body: { provider: "on", models: { "model/opus": "off" } } });

  const clearProvider = await directRequest(fixture, "PUT", "anthropic", {
    key: MANAGEMENT_KEY,
    body: { scope: "provider", value: null },
  });
  const clearModel = await directRequest(fixture, "PUT", "anthropic", {
    key: MANAGEMENT_KEY,
    body: { scope: "model", modelId: "model/opus", value: null },
  });
  expect(clearProvider.status).toBe(200);
  expect(clearModel.status).toBe(200);
  expect(fixture.state()).toEqual([
    { key: "model:openai/model/opus", value: "on" },
    { key: "provider:openai", value: "on" },
  ]);
  const clearedAnthropic = await directRequest(fixture, "GET", "anthropic", { key: MANAGEMENT_KEY });
  const preservedOpenai = await directRequest(fixture, "GET", "openai", { key: MANAGEMENT_KEY });
  expect(clearedAnthropic).toEqual({ status: 200, body: { provider: null, models: {} } });
  expect(preservedOpenai).toEqual({ status: 200, body: { provider: "on", models: { "model/opus": "on" } } });
  expect(fixture.catalogWriteSignals).toBe(6);

  const finalRead = await harness.executor.read(GET_CC_ALIAS, { path: { id: "anthropic" } });
  expect(finalRead.output).toEqual({ provider: null, models: {} });
  const getResult = harness.last(GET_CC_ALIAS);
  expect(getResult).toEqual({ status: 200, body: { provider: null, models: {} } });

  const cancellationPlan = await harness.executor.plan(PUT_CC_ALIAS, {
    path: { id: "claude" },
    body: { scope: "provider", value: "on" },
  });
  const dispatchesBeforeCancel = harness.count(PUT_CC_ALIAS);
  harness.executor.clearCredential();
  await expect(harness.executor.apply(cancellationPlan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-invalidated" });
  expect(harness.count(PUT_CC_ALIAS)).toBe(dispatchesBeforeCancel);
  expect((await directRequest(fixture, "GET", "claude", { key: MANAGEMENT_KEY })).body).toEqual({ provider: null, models: {} });
  harness.executor.bindCredential({ profileId: PROFILE_ID, endpoint: fixture.endpoint, apiKey: MANAGEMENT_KEY });

  const stalePlan = await harness.executor.plan(PUT_CC_ALIAS, {
    path: { id: "claude" },
    body: { scope: "provider", value: "off" },
  });
  expect(stalePlan.targetDigest).toMatch(/^[a-f0-9]{64}$/);
  const interveningWrite = await directRequest(fixture, "PUT", "claude", {
    key: MANAGEMENT_KEY,
    body: { scope: "provider", value: "on" },
  });
  expect(interveningWrite.status).toBe(200);
  const writesBeforeDrift = harness.count(PUT_CC_ALIAS);
  await expect(harness.executor.apply(stalePlan.planId, { confirmed: true })).rejects.toMatchObject({ code: "target-drift" });
  expect(harness.count(PUT_CC_ALIAS)).toBe(writesBeforeDrift);
  expect((await directRequest(fixture, "GET", "claude", { key: MANAGEMENT_KEY })).body).toEqual({ provider: "on", models: {} });

  const unrelatedPlan = await harness.executor.plan(PUT_CC_ALIAS, {
    path: { id: "claude" },
    body: { scope: "provider", value: "off" },
  });
  const unrelatedWrite = await directRequest(fixture, "PUT", "claude", {
    key: MANAGEMENT_KEY,
    body: { scope: "model", modelId: "model/unrelated", value: "on" },
  });
  expect(unrelatedWrite.status).toBe(200);
  expect((await harness.executor.apply(unrelatedPlan.planId, { confirmed: true })).status).toBe("applied");
  expect((await directRequest(fixture, "GET", "claude", { key: MANAGEMENT_KEY })).body)
    .toEqual({ provider: "off", models: { "model/unrelated": "on" } });

  const writesBeforeProto = harness.count(PUT_CC_ALIAS);
  await expect(harness.executor.plan(PUT_CC_ALIAS, {
    path: { id: "claude" },
    body: { scope: "model", modelId: "__proto__", value: "on" },
  })).rejects.toThrow();
  expect(harness.count(PUT_CC_ALIAS)).toBe(writesBeforeProto);
  const constructorWrite = await directRequest(fixture, "PUT", "claude", {
    key: MANAGEMENT_KEY,
    body: { scope: "model", modelId: "constructor", value: "on" },
  });
  expect(constructorWrite.status).toBe(200);
  expect((await directRequest(fixture, "GET", "claude", { key: MANAGEMENT_KEY })).body)
    .toEqual({ provider: "off", models: { constructor: "on", "model/unrelated": "on" } });
  const constructorDriftPlan = await harness.executor.plan(PUT_CC_ALIAS, {
    path: { id: "claude" },
    body: { scope: "model", modelId: "constructor", value: "off" },
  });
  const constructorDriftWrite = await directRequest(fixture, "PUT", "claude", {
    key: MANAGEMENT_KEY,
    body: { scope: "model", modelId: "constructor", value: "off" },
  });
  expect(constructorDriftWrite.status).toBe(200);
  const writesBeforeModelDrift = harness.count(PUT_CC_ALIAS);
  await expect(harness.executor.apply(constructorDriftPlan.planId, { confirmed: true })).rejects.toMatchObject({ code: "target-drift" });
  expect(harness.count(PUT_CC_ALIAS)).toBe(writesBeforeModelDrift);
  const constructorUnrelatedPlan = await harness.executor.plan(PUT_CC_ALIAS, {
    path: { id: "claude" },
    body: { scope: "model", modelId: "constructor", value: "on" },
  });
  const anotherModelWrite = await directRequest(fixture, "PUT", "claude", {
    key: MANAGEMENT_KEY,
    body: { scope: "model", modelId: "model/another", value: "on" },
  });
  expect(anotherModelWrite.status).toBe(200);
  expect((await harness.executor.apply(constructorUnrelatedPlan.planId, { confirmed: true })).status).toBe("applied");
  expect((await directRequest(fixture, "GET", "claude", { key: MANAGEMENT_KEY })).body)
    .toEqual({ provider: "off", models: { constructor: "on", "model/another": "on", "model/unrelated": "on" } });
  const clearConstructor = await directRequest(fixture, "PUT", "claude", {
    key: MANAGEMENT_KEY,
    body: { scope: "model", modelId: "constructor", value: null },
  });
  expect(clearConstructor.status).toBe(200);

  const competingOn = await harness.executor.plan(PUT_CC_ALIAS, {
    path: { id: "claude" },
    body: { scope: "provider", value: "on" },
  });
  const competingOff = await harness.executor.plan(PUT_CC_ALIAS, {
    path: { id: "claude" },
    body: { scope: "provider", value: "off" },
  });
  const writesBeforeCompetition = harness.count(PUT_CC_ALIAS);
  const competingResults = await Promise.allSettled([
    harness.executor.apply(competingOn.planId, { confirmed: true }),
    harness.executor.apply(competingOff.planId, { confirmed: true }),
  ]);
  expect(competingResults[0]).toMatchObject({ status: "fulfilled", value: { status: "applied" } });
  expect(competingResults[1]).toMatchObject({ status: "rejected", reason: { code: "target-drift" } });
  expect(harness.count(PUT_CC_ALIAS)).toBe(writesBeforeCompetition + 1);
  expect((await directRequest(fixture, "GET", "claude", { key: MANAGEMENT_KEY })).body)
    .toEqual({ provider: "on", models: { "model/another": "on", "model/unrelated": "on" } });

  const uncertainPlan = await harness.executor.plan(PUT_CC_ALIAS, {
    path: { id: "claude" },
    body: { scope: "provider", value: "off" },
  });
  const dispatchesBeforeUncertain = harness.count(PUT_CC_ALIAS);
  const readsBeforeUncertainApply = harness.targetReadCount();
  const reconciliationsBeforeUncertainApply = harness.reconciliationReadCount();
  harness.loseNextPutResponse();
  const uncertain = await harness.executor.apply(uncertainPlan.planId, { confirmed: true });
  expect(uncertain).toMatchObject({ status: "unknown", plan: { state: "unknown" }, error: { code: "uncertain-outcome" } });
  expect(harness.count(PUT_CC_ALIAS)).toBe(dispatchesBeforeUncertain + 1);
  expect(harness.targetReadCount()).toBe(readsBeforeUncertainApply + 1);
  expect(harness.reconciliationReadCount()).toBe(reconciliationsBeforeUncertainApply);
  expect((await directRequest(fixture, "GET", "claude", { key: MANAGEMENT_KEY })).body)
    .toEqual({ provider: "off", models: { "model/another": "on", "model/unrelated": "on" } });
  await expect(harness.executor.apply(uncertainPlan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-already-applied" });
  expect(harness.count(PUT_CC_ALIAS)).toBe(dispatchesBeforeUncertain + 1);

  const malformed = await directRawPut(fixture, "anthropic", "{");
  expect(malformed.status).toBe(400);
  expect(malformed.body).toEqual({ error: { message: "Invalid JSON body", type: "invalid_request_error", code: "bad_request" } });

  fixture.failAliasWritesWith("fixture persistence failed at /home/fixture/.credentials/cc-alias.json api_key=sk-proj-abcdefghijklmnopqrstuvwxyz123456");
  const failedWritePlan = await harness.executor.plan(PUT_CC_ALIAS, {
    path: { id: "error-fixture" },
    body: { scope: "provider", value: "on" },
  });
  const failedWriteResult = await harness.executor.apply(failedWritePlan.planId, { confirmed: true });
  expect(failedWriteResult).toMatchObject({ status: "unknown", plan: { state: "unknown" }, error: { code: "uncertain-outcome" } });
  const sanitizedWriteError = harness.last(PUT_CC_ALIAS);
  expect(sanitizedWriteError.status).toBe(500);
  expect(sanitizedWriteError.body).toEqual({
    error: {
      message: "SQLiteError: fixture persistence failed at <path> api_key=[REDACTED]",
      type: "server_error",
      code: "internal_server_error",
    },
  });
  expect(JSON.stringify(sanitizedWriteError.body)).not.toContain("/home/fixture");
  expect(JSON.stringify(sanitizedWriteError.body)).not.toContain("sk-proj-");
  expect(fixture.state()).not.toContainEqual({ key: "provider:error-fixture", value: "on" });
  fixture.clearAliasWriteFailure();

  fixture.failCatalogWriteSignal();
  const partialWritePlan = await harness.executor.plan(PUT_CC_ALIAS, {
    path: { id: "error-fixture" },
    body: { scope: "provider", value: "on" },
  });
  const partialWriteResult = await harness.executor.apply(partialWritePlan.planId, { confirmed: true });
  expect(partialWriteResult).toMatchObject({ status: "unknown", plan: { state: "unknown" }, error: { code: "uncertain-outcome" } });
  expect(harness.last(PUT_CC_ALIAS).status).toBe(500);
  expect(fixture.state()).toContainEqual({ key: "provider:error-fixture", value: "on" });
  fixture.clearCatalogWriteSignalFailure();

  fixture.dropStorageForReadFailure();
  const failedRead = await directRequest(fixture, "GET", "anthropic", { key: MANAGEMENT_KEY });
  expect(failedRead.status).toBe(500);
  expect(failedRead.body).toEqual({ error: { message: "SQLiteError: no such table: key_value", type: "server_error", code: "internal_server_error" } });
  fixture.restoreStorageAfterReadFailure();
  expect(fixture.state()).toContainEqual({ key: "provider:claude", value: "off" });

  expect(fixture.state()).toContainEqual({ key: "provider:claude", value: "off" });
  expect(harness.last(PUT_CC_ALIAS).status).toBe(500);

  const finalState = fixture.state();
  const putResult = harness.last(PUT_CC_ALIAS);
  observe(GET_CC_ALIAS, ["anonymous-auth", "authorized-read", "provider-model-isolation"], {
    before,
    after: finalState,
    result: { status: getResult.status, body: getResult.body },
  });
  observe(PUT_CC_ALIAS, ["scope-denial", "schema-validation", "trim-set-clear", "credential-cancellation", "selected-target-drift", "competing-plans", "unrelated-alias-change", "prototype-model-identifiers", "malformed-json", "storage-errors", "lost-response-unknown", "partial-error-unknown"], {
    before,
    after: finalState,
    result: { status: putResult.status, body: putResult.body },
  });
  allAssertionsPassed = true;
});
