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
import { invokeJsonAdapter, type AdminCredential } from "../src/admin/adapters.ts";
import { createAdminExecutor } from "../src/admin/executor.ts";
import { canonicalizeJson, type OperationAdapter } from "../src/admin/registry.ts";
import { assertSafetyReadRequest, assertSafetyReadResponse, mapRelationInput, projectRelationSnapshot } from "../src/admin/relations.ts";
import type { JsonValue } from "../src/admin/types.ts";
import {
  buildModelComboMappingFixtureRegistry,
  MODEL_COMBO_MAPPING_OPERATION_IDS,
  MODEL_COMBO_MAPPING_SOURCE_CONTRACTS,
  ModelComboMappingsHttpFixture,
  modelComboMappingAdapterDescriptor,
  type ModelComboMappingFixtureOperationId,
} from "./fixtures/model-combo-mappings.fixture.ts";
import { createPinnedManagementAuthorization, type PinnedManagementAuthorization } from "./fixtures/pinned-handler.fixture.ts";

const [LIST, CREATE, ITEM, UPDATE, DELETE] = MODEL_COMBO_MAPPING_OPERATION_IDS;
const TEST_ID = "test/admin-model-combo-mappings.test.ts";
const PROFILE_ID = "model-combo-mappings-source-fixture";
const MANAGE_KEY = "fixture-mapping-manage";
const READ_KEY = "fixture-mapping-read";
const SECRET_MARKER = "fixture-combo-private-key-marker";
const FIXED_NOW = "2026-10-20T00:00:00.000Z";
const registry = buildModelComboMappingFixtureRegistry();

type HttpSnapshot = { readonly status: number; readonly body: unknown };
type Outcome = { readonly before: unknown; readonly after: unknown; readonly result: HttpSnapshot };
type Harness = ReturnType<typeof createHarness>;

function sourceAuthorization(): PinnedManagementAuthorization {
  const keys = new Map([[MANAGE_KEY, ["manage"]], [READ_KEY, ["read"]]]);
  return createPinnedManagementAuthorization({
    isDashboardSession: () => false,
    verifyAccessToken: () => null,
    validateApiKey: key => keys.has(key),
    getApiKeyMetadata: key => {
      const scopes = keys.get(key);
      return scopes ? { id: `fixture-${key}`, scopes } : null;
    },
  });
}

function descriptorFor(adapter: OperationAdapter) {
  return { ...modelComboMappingAdapterDescriptor(adapter), adapterId: adapter.adapterId };
}

async function callAdapter(
  adapter: OperationAdapter,
  endpoint: string,
  input: unknown,
  credential?: AdminCredential,
  signal?: AbortSignal,
) {
  const validated = adapter.validate(input);
  return invokeJsonAdapter({
    descriptor: descriptorFor(adapter),
    endpoint,
    ...(credential === undefined ? {} : { credential }),
    resolvedPath: adapter.buildPath(validated),
    queryParameters: adapter.buildQuery(validated),
    ...(validated.body === undefined ? {} : { body: validated.body }),
    ...(signal === undefined ? {} : { signal }),
  });
}

async function directRequest(
  fixture: ModelComboMappingsHttpFixture,
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  options: { readonly key?: string; readonly body?: unknown; readonly rawBody?: string } = {},
): Promise<HttpSnapshot> {
  const body = options.rawBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  const response = await fetch(new URL(path, fixture.endpoint), {
    method,
    headers: {
      ...(options.key === undefined ? {} : { authorization: `Bearer ${options.key}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body }),
  });
  let responseBody: unknown;
  try { responseBody = await response.json(); }
  catch { responseBody = null; }
  return { status: response.status, body: responseBody };
}

function recordResponse(
  responses: Map<ModelComboMappingFixtureOperationId, HttpSnapshot[]>,
  operationId: ModelComboMappingFixtureOperationId,
  snapshot: HttpSnapshot,
): void {
  const history = responses.get(operationId) ?? [];
  history.push(structuredClone(snapshot));
  responses.set(operationId, history);
}

function createHarness(fixture: ModelComboMappingsHttpFixture) {
  const responses = new Map<ModelComboMappingFixtureOperationId, HttpSnapshot[]>();
  const dispatchedBodies = new Map<ModelComboMappingFixtureOperationId, JsonValue[]>();
  const lostResponses = new Set<ModelComboMappingFixtureOperationId>();
  let targetReads = 0;
  let reconciliationReads = 0;
  let nextPlanId = 0;
  const executor = createAdminExecutor({
    registry,
    now: () => Date.parse(FIXED_NOW),
    randomId: () => `model-combo-mapping-plan-${++nextPlanId}`,
    readTarget: async context => {
      targetReads += 1;
      const adapter = registry.require(context.readOperation.operationId);
      const validated = adapter.validate(mapRelationInput(context.relation.inputs, context.payload));
      assertSafetyReadRequest(context.readCompleteness, adapter.descriptor, validated);
      const response = await callAdapter(adapter, context.auth.endpoint, validated, context.auth.credential, context.signal);
      if (response.status >= 400) throw Object.assign(new Error("pinned mapping target read failed"), { status: response.status });
      assertSafetyReadResponse(context.readCompleteness, adapter.descriptor, response.data);
      const snapshot = projectRelationSnapshot(context.relation, response.data, context.payload);
      return { snapshot, digest: createHash("sha256").update(canonicalizeJson(snapshot)).digest("hex") };
    },
    reconcile: async () => {
      reconciliationReads += 1;
      return { status: "unknown" };
    },
    dispatch: async (request, context) => {
      const operationId = request.operationId as ModelComboMappingFixtureOperationId;
      const adapter = registry.require(operationId);
      if (request.body !== undefined) {
        const bodies = dispatchedBodies.get(operationId) ?? [];
        bodies.push(structuredClone(request.body));
        dispatchedBodies.set(operationId, bodies);
      }
      const response = await invokeJsonAdapter({
        descriptor: descriptorFor(adapter),
        endpoint: context.auth.endpoint,
        ...(context.auth.credential === undefined ? {} : { credential: context.auth.credential }),
        resolvedPath: request.path,
        queryParameters: request.queryParameters,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const body = response.status >= 400 || response.data === undefined ? response.data ?? null : adapter.project(response.data);
      recordResponse(responses, operationId, { status: response.status, body });
      if (lostResponses.delete(operationId)) {
        throw Object.assign(new Error("fixture transport lost the completed mapping response"), { code: "network-lost-response", uncertain: true });
      }
      if (operationId !== LIST && operationId !== ITEM) {
        return { kind: "response", status: response.status, body: response.data ?? null };
      }
      if (response.status >= 400) throw Object.assign(new Error("pinned mapping handler rejected the request"), { status: response.status });
      return response.data;
    },
  });
  executor.bindCredential({ profileId: PROFILE_ID, endpoint: fixture.endpoint, apiKey: MANAGE_KEY });
  return {
    executor,
    targetReadCount() { return targetReads; },
    reconciliationReadCount() { return reconciliationReads; },
    loseNextResponse(operationId: ModelComboMappingFixtureOperationId) { lostResponses.add(operationId); },
    dispatchCount(operationId: ModelComboMappingFixtureOperationId) { return responses.get(operationId)?.length ?? 0; },
    dispatchedBodies(operationId: ModelComboMappingFixtureOperationId) { return structuredClone(dispatchedBodies.get(operationId) ?? []); },
    last(operationId: ModelComboMappingFixtureOperationId): HttpSnapshot {
      const snapshot = responses.get(operationId)?.at(-1);
      if (!snapshot) throw new Error(`No pinned mapping HTTP response captured for ${operationId}`);
      return snapshot;
    },
  };
}

const completedCases = new Map<ModelComboMappingFixtureOperationId, Set<string>>();
const observations = new Map<ModelComboMappingFixtureOperationId, Outcome>();
const fixtures: ModelComboMappingsHttpFixture[] = [];
const executors: Harness["executor"][] = [];
let allAssertionsPassed = false;

function mark(operationId: ModelComboMappingFixtureOperationId, caseIds: readonly string[]): void {
  const cases = completedCases.get(operationId) ?? new Set<string>();
  for (const caseId of caseIds) cases.add(caseId);
  completedCases.set(operationId, cases);
}

function observe(operationId: ModelComboMappingFixtureOperationId, outcome: Outcome): void {
  const serialized = JSON.stringify(outcome);
  expect(serialized).not.toContain(SECRET_MARKER);
  observations.set(operationId, structuredClone(outcome));
}

function startFixture() {
  const fixture = new ModelComboMappingsHttpFixture({
    auth: sourceAuthorization(),
    comboNames: {
      "combo-known": "Known combo",
      "combo-prefix": "Prefix combo",
      "combo-global": "Global combo",
      "combo-disabled": "Disabled combo",
    },
    initial: [
      { id: "mapping-known", pattern: "openai/gpt-5", comboId: "combo-known", priority: 80, description: "exact model route" },
      { id: "mapping-prefix", pattern: "openai/*", comboId: "combo-prefix", priority: 40, description: "prefix glob route" },
      { id: "mapping-missing-combo", pattern: "unknown/model", comboId: "combo-missing", priority: 20, description: "unknown combo is retained" },
      { id: "mapping-global", pattern: "*", comboId: "combo-global", priority: 0, description: "global fallback" },
      { id: "mapping-disabled", pattern: "openai/gpt-5", comboId: "combo-disabled", priority: 100, enabled: false, description: "disabled high priority" },
    ],
    now: () => FIXED_NOW,
  });
  fixtures.push(fixture);
  return fixture;
}

async function apply(harness: Harness, operationId: ModelComboMappingFixtureOperationId, input: unknown, loseResponse = false) {
  const plan = await harness.executor.plan(operationId, input);
  expect(plan.preview.confirmationRequired).toBe(true);
  if (loseResponse) harness.loseNextResponse(operationId);
  return harness.executor.apply(plan.planId, { confirmed: true });
}

function state(fixture: ModelComboMappingsHttpFixture): JsonValue {
  return structuredClone(fixture.state) as unknown as JsonValue;
}

afterEach(async () => {
  for (const executor of executors.splice(0)) executor.shutdown();
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()));
});

afterAll(async () => {
  const requiredCases: Readonly<Record<ModelComboMappingFixtureOperationId, readonly string[]>> = {
    [LIST]: ["anonymous-auth", "authorized-left-join", "priority-pagination", "secret-free-combo-projection"],
    [CREATE]: ["scope-denial", "malformed-json", "invalid-pattern", "trim-defaults-and-create-omits-join", "raw-pattern-preserved-on-wire", "whitespace-trims-only-in-persisted-state", "sqlite-source-error", "source-complete-external-drift-0-writes", "lost-single-dispatch-unknown", "response-complete-201", "partial-error-unknown"],
    [ITEM]: ["authorized-joined-item", "missing-item", "unknown-combo-has-no-join", "secret-free-combo-projection"],
    [UPDATE]: ["scope-denial", "malformed-json", "partial-update-preserves-state", "unknown-combo-clears-stale-join", "selected-target-drift", "lost-single-dispatch-unknown", "response-complete-200"],
    [DELETE]: ["pinned-source-delete", "not-found-after-delete", "selected-target-drift", "lost-single-dispatch-unknown", "response-complete-200"],
  };
  if (!allAssertionsPassed || !MODEL_COMBO_MAPPING_OPERATION_IDS.every(operationId =>
    requiredCases[operationId].every(caseId => completedCases.get(operationId)?.has(caseId)) && observations.has(operationId))) return;

  const observationDirectory = resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations");
  await mkdir(observationDirectory, { recursive: true, mode: 0o700 });
  const caseSha256 = testCaseSourceHash(TEST_ID);
  for (const operationId of MODEL_COMBO_MAPPING_OPERATION_IDS) {
    const observation = observations.get(operationId);
    if (!observation) return;
    const contract = MODEL_COMBO_MAPPING_SOURCE_CONTRACTS[operationId];
    const binding = operationEvidenceBinding(operationId, contract);
    const artifactPath = outcomeArtifactPath(operationId);
    await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId, testId: TEST_ID, caseSha256, binding, observation })}\n`, { mode: 0o600 });
    testOutcomeHash(operationId, TEST_ID, caseSha256, binding, contract, artifactPath);
  }
});

test("pinned v3.8.52 model-combo mappings use the actual facade and SQLite repository", async () => {
  const fixture = startFixture();
  const harness = createHarness(fixture);
  executors.push(harness.executor);
  expect(MODEL_COMBO_MAPPING_SOURCE_CONTRACTS[LIST].mutationSafety).toBeNull();
  expect(MODEL_COMBO_MAPPING_SOURCE_CONTRACTS[ITEM].mutationSafety).toBeNull();
  expect(MODEL_COMBO_MAPPING_SOURCE_CONTRACTS[CREATE].mutationSafety).toMatchObject({
    preflight: {
      kind: "required",
      observations: [{
        name: "model-combo-mapping-collection",
        read: { operationId: LIST, inputs: [] },
        readCompleteness: {
          kind: "unpaginated-list",
          sourceReason: "The pinned v3.8.52 collection GET omits LIMIT when pagination parameters are absent, so its SQLite query returns every mapping and the total in one response.",
          itemsPath: ["mappings"],
          totalPath: ["total"],
          identityPaths: [["id"]],
        },
      }],
    },
    reconciliation: { kind: "unknown" },
    settlement: { responseComplete: { statusCodes: [201] }, definiteRejection: null },
  });
  for (const [operationId, name] of [[UPDATE, "selected-model-combo-mapping"], [DELETE, "selected-model-combo-delete-target"]] as const) {
    expect(MODEL_COMBO_MAPPING_SOURCE_CONTRACTS[operationId].mutationSafety).toMatchObject({
      preflight: {
        kind: "required",
        observations: [{
          name,
          read: { operationId: ITEM },
          readCompleteness: {
            kind: "single-response",
            sourceReason: "The pinned v3.8.52 item GET selects the requested mapping ID from SQLite and returns its complete mutable state in one response without pagination.",
          },
        }],
      },
      reconciliation: { kind: "unknown" },
      settlement: { responseComplete: { statusCodes: [200] }, definiteRejection: null },
    });
  }
  fixture.database.prepare("UPDATE combos SET data = ? WHERE id = ?").run(
    JSON.stringify({ id: "combo-known", name: "Known combo", models: [], isActive: true, apiKey: SECRET_MARKER }),
    "combo-known",
  );

  const beforeList = state(fixture);
  const anonymousList = await directRequest(fixture, "GET", "/api/model-combo-mappings");
  expect(anonymousList.status).toBe(401);
  const list = await harness.executor.read(LIST, {});
  expect(list.output).toMatchObject({
    total: 5,
    mappings: [
      { id: "mapping-disabled", priority: 100, enabled: false, comboName: "Disabled combo" },
      { id: "mapping-known", priority: 80, enabled: true, comboName: "Known combo" },
      { id: "mapping-prefix", priority: 40, enabled: true, comboName: "Prefix combo" },
      { id: "mapping-missing-combo", priority: 20, enabled: true },
      { id: "mapping-global", priority: 0, enabled: true, comboName: "Global combo" },
    ],
  });
  const paginatedList = await directRequest(fixture, "GET", "/api/model-combo-mappings?limit=2&offset=0", { key: MANAGE_KEY });
  expect(paginatedList.status).toBe(200);
  expect(paginatedList.body).toMatchObject({ total: 5, mappings: [{ id: "mapping-disabled" }, { id: "mapping-known" }] });
  expect(JSON.stringify(list.output)).not.toContain(SECRET_MARKER);
  expect(fixture.state.mappings.map(row => row.id)).toEqual([
    "mapping-disabled", "mapping-global", "mapping-known", "mapping-missing-combo", "mapping-prefix",
  ]);
  const listResponse = harness.last(LIST);
  observe(LIST, { before: beforeList, after: state(fixture), result: listResponse });
  mark(LIST, ["anonymous-auth", "authorized-left-join", "priority-pagination", "secret-free-combo-projection"]);

  expect(await fixture.resolveComboForModel("openai/gpt-5")).toMatchObject({ id: "combo-known", name: "Known combo" });
  expect(await fixture.resolveComboForModel("openai/gpt-4")).toMatchObject({ id: "combo-prefix", name: "Prefix combo" });
  expect(await fixture.resolveComboForModel("anthropic/claude-sonnet")).toMatchObject({ id: "combo-global", name: "Global combo" });
  expect(await fixture.resolveComboForModel("openai/GPT-5")).toMatchObject({ id: "combo-known" });
  expect(await fixture.resolveComboForModel("openai/gpt-5")).toHaveProperty("apiKey", SECRET_MARKER);

  const beforeItem = state(fixture);
  const item = await harness.executor.read(ITEM, { path: { id: "mapping-known" } });
  expect(item.output).toMatchObject({ mapping: { id: "mapping-known", comboId: "combo-known", comboName: "Known combo" } });
  expect(JSON.stringify(item.output)).not.toContain(SECRET_MARKER);
  observe(ITEM, { before: beforeItem, after: state(fixture), result: harness.last(ITEM) });
  const unknownComboItem = await directRequest(fixture, "GET", "/api/model-combo-mappings/mapping-missing-combo", { key: MANAGE_KEY });
  expect(unknownComboItem.status).toBe(200);
  expect(unknownComboItem.body).not.toHaveProperty("mapping.comboName");
  const missingItem = await directRequest(fixture, "GET", "/api/model-combo-mappings/mapping-absent", { key: MANAGE_KEY });
  expect(missingItem.status).toBe(404);
  mark(ITEM, ["authorized-joined-item", "missing-item", "unknown-combo-has-no-join", "secret-free-combo-projection"]);

  const staleCreatePlan = await harness.executor.plan(CREATE, {
    body: { pattern: "external-drift/*", comboId: "combo-known" },
  });
  const writesBeforeCreateDrift = harness.dispatchCount(CREATE);
  const createCollectionDrift = await directRequest(fixture, "PUT", "/api/model-combo-mappings/mapping-known", {
    key: MANAGE_KEY,
    body: { description: "create-plan external edit" },
  });
  expect(createCollectionDrift.status).toBe(200);
  await expect(harness.executor.apply(staleCreatePlan.planId, { confirmed: true })).rejects.toMatchObject({ code: "target-drift" });
  expect(harness.dispatchCount(CREATE)).toBe(writesBeforeCreateDrift);
  mark(CREATE, ["source-complete-external-drift-0-writes"]);

  const createBefore = state(fixture);
  const createReadsBeforeLostApply = harness.targetReadCount();
  const createReconciliationsBeforeLostApply = harness.reconciliationReadCount();
  const lostCreatePlan = await harness.executor.plan(CREATE, {
    body: { pattern: "  vendor/*  ", comboId: "combo-known" },
  });
  expect(lostCreatePlan.preview.confirmationRequired).toBe(true);
  harness.loseNextResponse(CREATE);
  const createResult = await harness.executor.apply(lostCreatePlan.planId, { confirmed: true });
  expect(createResult).toMatchObject({ status: "unknown", plan: { state: "unknown" }, error: { code: "uncertain-outcome" } });
  expect(harness.dispatchCount(CREATE)).toBe(1);
  expect(harness.targetReadCount()).toBe(createReadsBeforeLostApply + 2);
  expect(harness.reconciliationReadCount()).toBe(createReconciliationsBeforeLostApply);
  await expect(harness.executor.apply(lostCreatePlan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-already-applied" });
  expect(harness.dispatchCount(CREATE)).toBe(1);
  expect(harness.dispatchedBodies(CREATE)).toEqual([{
    pattern: "  vendor/*  ",
    comboId: "combo-known",
    priority: 0,
    enabled: true,
    description: "",
  }]);
  const createResponse = harness.last(CREATE);
  expect(createResponse.status).toBe(201);
  expect(createResponse.body).toMatchObject({ mapping: {
    id: "00000000-0000-4000-8000-000000000001",
    pattern: "vendor/*",
    comboId: "combo-known",
    priority: 0,
    enabled: true,
    description: "",
    createdAt: FIXED_NOW,
    updatedAt: FIXED_NOW,
  } });
  expect(createResponse.body).not.toHaveProperty("mapping.comboName");
  expect(JSON.stringify(createResponse.body)).not.toContain(SECRET_MARKER);
  const whitespaceBefore = state(fixture);
  const whitespaceCreateResult = await apply(harness, CREATE, { body: { pattern: "   ", comboId: "combo-known" } });
  expect(whitespaceCreateResult.status).toBe("applied");
  expect(whitespaceCreateResult.plan.state).toBe("applied");
  expect(harness.dispatchCount(CREATE)).toBe(2);
  expect(harness.dispatchedBodies(CREATE).at(-1)).toEqual({
    pattern: "   ",
    comboId: "combo-known",
    priority: 0,
    enabled: true,
    description: "",
  });
  const whitespaceResponse = harness.last(CREATE);
  expect(whitespaceResponse.status).toBe(201);
  expect(whitespaceResponse.body).toMatchObject({ mapping: { pattern: "", priority: 0, enabled: true, description: "" } });
  const whitespaceId = "00000000-0000-4000-8000-000000000002";
  expect(fixture.state.mappings.find(row => row.id === whitespaceId)?.pattern).toBe("");
  const whitespaceItem = await directRequest(fixture, "GET", `/api/model-combo-mappings/${whitespaceId}`, { key: MANAGE_KEY });
  expect(whitespaceItem).toMatchObject({ status: 200, body: { mapping: { id: whitespaceId, pattern: "" } } });
  observe(CREATE, { before: whitespaceBefore, after: state(fixture), result: whitespaceResponse });
  mark(CREATE, ["lost-single-dispatch-unknown", "response-complete-201"]);

  const invalidPattern = await directRequest(fixture, "POST", "/api/model-combo-mappings", {
    key: MANAGE_KEY,
    body: { pattern: "", comboId: "combo-known" },
  });
  expect(invalidPattern.status).toBe(400);
  const oversizedPattern = await directRequest(fixture, "POST", "/api/model-combo-mappings", {
    key: MANAGE_KEY,
    body: { pattern: "x".repeat(501), comboId: "combo-known" },
  });
  expect(oversizedPattern.status).toBe(400);
  const malformedCreate = await directRequest(fixture, "POST", "/api/model-combo-mappings", {
    key: MANAGE_KEY,
    rawBody: "{",
  });
  expect(malformedCreate.status).toBe(400);
  const deniedCreate = await directRequest(fixture, "POST", "/api/model-combo-mappings", {
    key: READ_KEY,
    body: { pattern: "denied/*", comboId: "combo-known" },
  });
  expect(deniedCreate.status).toBe(403);
  const triggerName = "fixture_mapping_storage_failure";
  fixture.database.exec(`CREATE TRIGGER ${triggerName} BEFORE INSERT ON model_combo_mappings
    BEGIN SELECT RAISE(ABORT, '${SECRET_MARKER}'); END`);
  const storageError = await directRequest(fixture, "POST", "/api/model-combo-mappings", {
    key: MANAGE_KEY,
    body: { pattern: "storage-failure/*", comboId: "combo-known" },
  });
  fixture.database.exec(`DROP TRIGGER ${triggerName}`);
  expect(storageError).toEqual({ status: 500, body: { error: "Failed to create model-combo mapping" } });
  expect(JSON.stringify(storageError.body)).not.toContain(SECRET_MARKER);
  const partialFailureTrigger = "fixture_mapping_partial_failure";
  fixture.database.exec(`CREATE TRIGGER ${partialFailureTrigger} AFTER INSERT ON model_combo_mappings
    BEGIN SELECT RAISE(FAIL, '${SECRET_MARKER}'); END`);
  const partialFailure = await apply(harness, CREATE, {
    body: { pattern: "partial-error/*", comboId: "combo-known" },
  });
  fixture.database.exec(`DROP TRIGGER ${partialFailureTrigger}`);
  expect(partialFailure).toMatchObject({ status: "unknown", plan: { state: "unknown" }, error: { code: "uncertain-outcome" } });
  expect(harness.last(CREATE).status).toBe(500);
  expect(fixture.state.mappings.some(row => row.pattern === "partial-error/*")).toBe(true);
  mark(CREATE, ["scope-denial", "malformed-json", "invalid-pattern", "trim-defaults-and-create-omits-join", "raw-pattern-preserved-on-wire", "whitespace-trims-only-in-persisted-state", "sqlite-source-error", "partial-error-unknown"]);

  const stalePlan = await harness.executor.plan(UPDATE, { path: { id: "mapping-known" }, body: { priority: 81 } });
  const externalUpdate = await directRequest(fixture, "PUT", "/api/model-combo-mappings/mapping-known", {
    key: MANAGE_KEY,
    body: { description: "concurrent external edit" },
  });
  expect(externalUpdate.status).toBe(200);
  await expect(harness.executor.apply(stalePlan.planId, { confirmed: true })).rejects.toMatchObject({ code: "target-drift" });
  expect(harness.dispatchCount(UPDATE)).toBe(0);
  const malformedUpdate = await directRequest(fixture, "PUT", "/api/model-combo-mappings/mapping-known", { key: MANAGE_KEY, rawBody: "{" });
  expect(malformedUpdate).toEqual({ status: 500, body: { error: "Failed to update mapping" } });
  const deniedUpdate = await directRequest(fixture, "PUT", "/api/model-combo-mappings/mapping-known", {
    key: READ_KEY,
    body: { priority: 4 },
  });
  expect(deniedUpdate.status).toBe(403);

  const updateBefore = state(fixture);
  const updateReadsBeforeLostApply = harness.targetReadCount();
  const updateReconciliationsBeforeLostApply = harness.reconciliationReadCount();
  const lostUpdatePlan = await harness.executor.plan(UPDATE, {
    path: { id: "mapping-known" },
    body: { priority: 90 },
  });
  expect(lostUpdatePlan.preview.confirmationRequired).toBe(true);
  harness.loseNextResponse(UPDATE);
  const updateResult = await harness.executor.apply(lostUpdatePlan.planId, { confirmed: true });
  expect(updateResult).toMatchObject({ status: "unknown", plan: { state: "unknown" }, error: { code: "uncertain-outcome" } });
  expect(harness.dispatchCount(UPDATE)).toBe(1);
  expect(harness.targetReadCount()).toBe(updateReadsBeforeLostApply + 2);
  expect(harness.reconciliationReadCount()).toBe(updateReconciliationsBeforeLostApply);
  await expect(harness.executor.apply(lostUpdatePlan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-already-applied" });
  expect(harness.dispatchCount(UPDATE)).toBe(1);
  const updateResponse = harness.last(UPDATE);
  expect(updateResponse.status).toBe(200);
  expect(updateResponse.body).toMatchObject({ mapping: {
    id: "mapping-known",
    pattern: "openai/gpt-5",
    comboId: "combo-known",
    priority: 90,
    enabled: true,
    description: "concurrent external edit",
    comboName: "Known combo",
  } });
  observe(UPDATE, { before: updateBefore, after: state(fixture), result: updateResponse });
  const updateReadsBeforeResponseComplete = harness.targetReadCount();
  const responseCompleteUpdate = await apply(harness, UPDATE, {
    path: { id: "mapping-known" },
    body: { priority: 91 },
  });
  expect(responseCompleteUpdate.status).toBe("applied");
  expect(responseCompleteUpdate.plan.state).toBe("applied");
  expect(harness.targetReadCount()).toBe(updateReadsBeforeResponseComplete + 2);
  mark(UPDATE, ["lost-single-dispatch-unknown", "response-complete-200"]);
  const unknownComboUpdate = await directRequest(fixture, "PUT", "/api/model-combo-mappings/mapping-known", {
    key: MANAGE_KEY,
    body: { comboId: "combo-missing" },
  });
  expect(unknownComboUpdate.status).toBe(200);
  const updatedItem = await directRequest(fixture, "GET", "/api/model-combo-mappings/mapping-known", { key: MANAGE_KEY });
  expect(updatedItem.status).toBe(200);
  expect(updatedItem.body).not.toHaveProperty("mapping.comboName");
  expect(JSON.stringify(updateResponse.body)).not.toContain(SECRET_MARKER);
  mark(UPDATE, ["scope-denial", "malformed-json", "partial-update-preserves-state", "unknown-combo-clears-stale-join", "selected-target-drift"]);

  const createdId = "00000000-0000-4000-8000-000000000001";
  const staleDelete = await harness.executor.plan(DELETE, { path: { id: createdId } });
  const externalDeleteDrift = await directRequest(fixture, "PUT", `/api/model-combo-mappings/${createdId}`, {
    key: MANAGE_KEY,
    body: { description: "concurrent delete target edit" },
  });
  expect(externalDeleteDrift.status).toBe(200);
  await expect(harness.executor.apply(staleDelete.planId, { confirmed: true })).rejects.toMatchObject({ code: "target-drift" });
  expect(harness.dispatchCount(DELETE)).toBe(0);
  const deleteBefore = state(fixture);
  const deleteReadsBeforeLostApply = harness.targetReadCount();
  const deleteReconciliationsBeforeLostApply = harness.reconciliationReadCount();
  const lostDeletePlan = await harness.executor.plan(DELETE, { path: { id: createdId } });
  expect(lostDeletePlan.preview.confirmationRequired).toBe(true);
  harness.loseNextResponse(DELETE);
  const deleteResult = await harness.executor.apply(lostDeletePlan.planId, { confirmed: true });
  expect(deleteResult).toMatchObject({ status: "unknown", plan: { state: "unknown" }, error: { code: "uncertain-outcome" } });
  expect(harness.dispatchCount(DELETE)).toBe(1);
  expect(harness.targetReadCount()).toBe(deleteReadsBeforeLostApply + 2);
  expect(harness.reconciliationReadCount()).toBe(deleteReconciliationsBeforeLostApply);
  await expect(harness.executor.apply(lostDeletePlan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-already-applied" });
  expect(harness.dispatchCount(DELETE)).toBe(1);
  const deleteResponse = harness.last(DELETE);
  expect(deleteResponse).toEqual({ status: 200, body: { success: true } });
  expect(fixture.state.mappings.some(row => row.id === createdId)).toBe(false);
  const missingAfterDelete = await directRequest(fixture, "GET", `/api/model-combo-mappings/${createdId}`, { key: MANAGE_KEY });
  expect(missingAfterDelete.status).toBe(404);
  observe(DELETE, { before: deleteBefore, after: state(fixture), result: deleteResponse });
  const responseCompleteDelete = await apply(harness, DELETE, { path: { id: "mapping-prefix" } });
  expect(responseCompleteDelete.status).toBe("applied");
  expect(responseCompleteDelete.plan.state).toBe("applied");
  mark(DELETE, ["pinned-source-delete", "not-found-after-delete", "selected-target-drift", "lost-single-dispatch-unknown", "response-complete-200"]);

  allAssertionsPassed = true;
});
