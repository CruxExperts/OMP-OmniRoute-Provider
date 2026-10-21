import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash } from "../scripts/generate-contracts.ts";
import { createAdminExecutor, type AdminExecutor } from "../src/admin/executor.ts";
import { invokeJsonAdapter } from "../src/admin/adapters.ts";
import { canonicalizeJson, type OperationAdapter } from "../src/admin/registry.ts";
import { mapRelationInput, relationOutcomeMatches } from "../src/admin/relations.ts";
import type { JsonObject, JsonValue } from "../src/admin/types.ts";
import { createPinnedManagementAuthorization, type PinnedManagementAuthorization } from "./fixtures/pinned-handler.fixture.ts";
import {
  COMBO_OPERATION_IDS, COMBO_SOURCE_CONTRACTS, COMBO_TEST_ID, CombosHttpFixture, buildComboFixtureRegistry, comboAdapterDescriptor,
} from "./fixtures/combos.fixture.ts";
import { comboRelationSnapshot, isComboRelationViewId } from "../src/admin/source-combos.ts";

const TEST_ID = COMBO_TEST_ID;
const PROFILE_ID = "combos-pinned-fixture";
const MANAGE_KEY = "fixture-combos-manage";
const READ_KEY = "fixture-combos-read";
const registry = buildComboFixtureRegistry();
type ResponseObservation = { status: number; body: unknown };
type Observation = { before: unknown; after: unknown; result: { status: number; body: unknown } };
type FixturePair = { readonly route: CombosHttpFixture; readonly auth: PinnedManagementAuthorization };
type Harness = { readonly executor: AdminExecutor; readonly route: CombosHttpFixture; readonly dispatchCount: (id: string) => number; readonly lastResponse: (id: string) => ResponseObservation | undefined; readonly loseNextResponse: (id: string) => void; readonly invokeSourceOnly: (id: string, input: unknown) => Promise<void> };
const fixtures: FixturePair[] = [];
const executors: AdminExecutor[] = [];
const observations = new Map<string, Observation>();
const completedCases = new Map<string, Set<string>>();
const REQUIRED_CASES = ["authorized-source-http-semantics", "safe-projection-and-state-observation", "denied-management-boundary"] as const;
const RESET_REQUIRED_CASES = ["visibility-limited-confirmation-and-one-shot-settlement"] as const;
const QUALIFIABLE_READ_OPERATIONS = [
  "GET /api/combos", "GET /api/combos/{id}",
  "GET /api/combos/auto", "GET /api/combos/builder/options", "GET /api/combos/metrics",
] as const;
const SOURCE_QUALIFIABLE_RESET_OPERATIONS = ["DELETE /api/combos/metrics"] as const;
const QUALIFIABLE_OPERATIONS = [...QUALIFIABLE_READ_OPERATIONS, ...SOURCE_QUALIFIABLE_RESET_OPERATIONS] as const;
const HELD_MUTATIONS = [
  "POST /api/combos", "PUT /api/combos/{id}", "PATCH /api/combos/{id}", "DELETE /api/combos/{id}",
  "POST /api/combos/duplicate", "POST /api/combos/reorder", "POST /api/combos/test",
] as const;
let allAssertionsPassed = false;

function mark(operationId: string, caseId: string): void {
  const cases = completedCases.get(operationId) ?? new Set<string>(); cases.add(caseId); completedCases.set(operationId, cases);
}
function observe(operationId: string, before: unknown, after: unknown, result: ResponseObservation): void {
  observations.set(operationId, structuredClone({ before, after, result }));
}
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
function startFixture(): FixturePair {
  const auth = sourceAuthorization();
  const route = CombosHttpFixture.start({ auth, seeds: [
    { id: "seed-update", name: "Update", models: ["fixture/chat"], strategy: "priority", sortOrder: 0, version: 2,
      config: { maxRetries: 2, reasoningTokenBufferEnabled: true, apiKey: "must-not-project" } },
    { id: "seed-delete", name: "Delete", models: ["fixture/chat"], strategy: "priority", sortOrder: 1, version: 2 },
    { id: "seed-auto", name: "auto/best-coding", models: ["fixture/chat"], strategy: "priority", sortOrder: 2, version: 2 },
    { id: "seed-probe", name: "Probe", models: ["fixture/chat", "fixture/text-embedding"], strategy: "priority", sortOrder: 3, version: 2 },
    { id: "seed-quota", name: "Quota protected", models: ["quota/reference"], strategy: "priority", sortOrder: 4, version: 2 },
  ] });
  const pair = { route, auth }; fixtures.push(pair); return pair;
}
function credential(value: unknown): { kind: "apiKey"; value: string } {
  if (value === null || typeof value !== "object" || !("kind" in value) || value.kind !== "apiKey" || !("value" in value) || typeof value.value !== "string") throw new Error("combo qualification fixture requires a bound management API key");
  return { kind: "apiKey", value: value.value };
}
async function callAdapter(adapter: OperationAdapter, endpoint: string, input: unknown, signal?: AbortSignal) {
  const validated = adapter.validate(input);
  return invokeJsonAdapter({ descriptor: comboAdapterDescriptor(adapter), endpoint, credential: { kind: "apiKey", value: MANAGE_KEY },
    resolvedPath: adapter.buildPath(validated), queryParameters: adapter.buildQuery(validated), ...(validated.body === undefined ? {} : { body: validated.body }), ...(signal === undefined ? {} : { signal }) });
}
function createHarness(pair: FixturePair): Harness {
  const counts = new Map<string, number>(); const responses = new Map<string, ResponseObservation>(); const lost = new Set<string>();
  const executor = createAdminExecutor({ registry,
    dispatch: async (request, context) => {
      const adapter = registry.require(request.operationId);
      const response = await invokeJsonAdapter({ descriptor: comboAdapterDescriptor(adapter), endpoint: context.auth.endpoint, credential: credential(context.auth.credential),
        resolvedPath: request.path, queryParameters: request.queryParameters, ...(request.body === undefined ? {} : { body: request.body }), ...(context.signal === undefined ? {} : { signal: context.signal }) });
      counts.set(request.operationId, (counts.get(request.operationId) ?? 0) + 1);
      const body = response.status >= 400 || response.data === undefined ? response.data ?? null : adapter.project(response.data);
      responses.set(request.operationId, { status: response.status, body });
      if (response.status >= 400) throw Object.assign(new Error("combo fixture returned an HTTP error"), { status: response.status });
      if (lost.delete(request.operationId)) throw Object.assign(new Error("fixture committed mutation but lost response"), { code: "network-lost-response", uncertain: true });
      return adapter.risk === "read" ? response.data : { kind: "response", status: response.status, body: response.data };
    },
    readTarget: async context => {
      const relation = context.relation;
      const view = relation.sourceView;
      if (!isComboRelationViewId(view)) throw new Error("combo target relation is not bound to a source view");
      if (context.readCompleteness.kind !== "single-response" || !context.readCompleteness.sourceReason) {
        throw new Error("combo target read has no source-bound completeness proof");
      }
      const adapter = registry.require(relation.operationId);
      const input = mapRelationInput(relation.inputs, context.payload);
      const response = await callAdapter(adapter, context.auth.endpoint, input, context.signal);
      if (response.status >= 400) throw Object.assign(new Error("combo target read failed"), { status: response.status });
      const snapshot = comboRelationSnapshot(view, context.payload, response.data);
      return { snapshot, digest: createHash("sha256").update(canonicalizeJson(snapshot)).digest("hex") };
    },
    reconcile: async context => {
      const relation = context.fullRelation; const view = relation.targetRead.sourceView;
      if (relation.reconcile.operationId !== context.readOperation.operationId || !isComboRelationViewId(view)) return { status: "unknown" };
      const adapter = registry.require(context.readOperation.operationId);
      const input = mapRelationInput(context.relation.inputs, context.payload, context.request.body);
      const response = await callAdapter(adapter, context.auth.endpoint, input, context.signal);
      if (response.status >= 400) return { status: "unknown" };
      const observed = comboRelationSnapshot(view, context.payload, response.data);
      return relationOutcomeMatches(relation, context.originalTarget, observed, context.payload) ? { status: "applied", output: response.data } : { status: "unknown" };
    },
  });
  executors.push(executor);
  executor.setAdminBinding({ profileId: PROFILE_ID, endpoint: pair.route.endpoint }, true);
  executor.bindCredential({ profileId: PROFILE_ID, endpoint: pair.route.endpoint, apiKey: MANAGE_KEY });
  return { executor, route: pair.route, dispatchCount: id => counts.get(id) ?? 0, lastResponse: id => responses.get(id), loseNextResponse: id => { lost.add(id); },
    invokeSourceOnly: async (id, input) => {
      const adapter = registry.require(id);
      const response = await callAdapter(adapter, pair.route.endpoint, input);
      const body = response.status >= 400 || response.data === undefined ? response.data ?? null : adapter.project(response.data);
      responses.set(id, { status: response.status, body });
      expect(response.status).toBeGreaterThanOrEqual(200);
      expect(response.status).toBeLessThan(300);
    },
  };
}
async function directRequest(route: CombosHttpFixture, operationId: string, options: { readonly bearer?: string; readonly body?: unknown } = {}): Promise<Response> {
  const split = operationId.indexOf(" "); const method = operationId.slice(0, split); let path = operationId.slice(split + 1);
  if (path === "/api/combos/{id}") path = "/api/combos/seed-update";
  const url = new URL(path, route.endpoint);
  const headers = new Headers(); if (options.bearer !== undefined) headers.set("authorization", `Bearer ${options.bearer}`);
  if (options.body !== undefined) headers.set("content-type", "application/json");
  return fetch(url, { method, headers, ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }) });
}
function latest(harness: Harness, operationId: string): ResponseObservation {
  const response = harness.lastResponse(operationId); if (!response) throw new Error(`missing observed response for ${operationId}`); return response;
}
function markObserved(harness: Harness, operationId: string, before: JsonValue): void {
  const response = latest(harness, operationId);
  const after = harness.route.state;
  expect(JSON.stringify(response.body)).not.toContain("fixture-provider-secret");
  expect(JSON.stringify(response.body)).not.toContain("must-not-project");
  expect(JSON.stringify(after)).not.toContain("fixture-provider-secret");
  expect(JSON.stringify(after)).not.toContain("must-not-project");
  observe(operationId, before, after, response);
  mark(operationId, "safe-projection-and-state-observation");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function persistedCombos(route: CombosHttpFixture): JsonObject[] {
  const state = route.state;
  if (!isJsonObject(state) || !Array.isArray(state.combos)) {
    throw new Error("Combo fixture state omitted persisted rows");
  }
  return state.combos.filter(isJsonObject);
}
function persistedCombo(route: CombosHttpFixture, id: string): JsonObject {
  const row = persistedCombos(route).find(value => value.id === id);
  if (!row) throw new Error(`Persisted combo is missing: ${id}`);
  return row;
}
async function apply(harness: Harness, operationId: string, input: unknown, loseResponse = false) {
  if (registry.require(operationId).descriptor.mutationSafety?.preflight.kind === "unavailable") {
    expect(registry.getEligibility(operationId).status).toBe("unavailable");
    await expect(harness.executor.plan(operationId, input)).rejects.toMatchObject({ code: "operation-unavailable" });
    expect(harness.dispatchCount(operationId)).toBe(0);
    await harness.invokeSourceOnly(operationId, input);
    return { status: "source-only" as const };
  }
  const plan = await harness.executor.plan(operationId, input);
  expect(plan.preview.confirmationRequired).toBe(true);
  if (loseResponse) harness.loseNextResponse(operationId);
  return harness.executor.apply(plan.planId, { confirmed: true });
}

afterEach(async () => {
  for (const executor of executors.splice(0)) executor.shutdown();
  await Promise.all(fixtures.splice(0).map(async pair => { pair.route.close(); }));
});
afterAll(async () => {
  const complete = allAssertionsPassed && QUALIFIABLE_OPERATIONS.every(operationId => {
    const requiredCases = operationId === "DELETE /api/combos/metrics" ? [...REQUIRED_CASES, ...RESET_REQUIRED_CASES] : REQUIRED_CASES;
    return requiredCases.every(caseId => completedCases.get(operationId)?.has(caseId)) && observations.has(operationId);
  });
  if (!complete) return;
  const directory = resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const operationId of QUALIFIABLE_OPERATIONS) {
    const observation = observations.get(operationId); if (!observation) return;
    const binding = operationEvidenceBinding(operationId, COMBO_SOURCE_CONTRACTS[operationId]);
    const caseSha256 = testCaseSourceHash(TEST_ID); const artifactPath = outcomeArtifactPath(operationId);
    await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId, testId: TEST_ID, caseSha256, binding, observation })}\n`, { mode: 0o600 });
    testOutcomeHash(operationId, TEST_ID, caseSha256, binding, COMBO_SOURCE_CONTRACTS[operationId], artifactPath);
  }
});

describe("pinned OmniRoute v3.8.52 combo operation semantics", () => {
  test("exercises source handlers while holding mutations without complete preflight observations", async () => {
    const processDateNow = Date.now;
    const pair = startFixture(); const harness = createHarness(pair);
    for (const id of QUALIFIABLE_OPERATIONS) expect(registry.getEligibility(id).status).toBe("verified");
    for (const id of HELD_MUTATIONS) expect(registry.getEligibility(id).status).toBe("unavailable");
    expect(Date.now).toBe(processDateNow);
    const beforeRead = pair.route.state;
    const unauthorized = await Promise.all(COMBO_OPERATION_IDS.map(id => directRequest(pair.route, id)));
    expect(unauthorized.every(response => response.status === 401)).toBe(true);
    for (const operationId of COMBO_OPERATION_IDS) mark(operationId, "denied-management-boundary");
    const readDenied = await directRequest(pair.route, "POST /api/combos", { bearer: READ_KEY, body: { name: "denied", models: ["fixture/chat"] } });
    expect(readDenied.status).toBe(403);

    const list = await harness.executor.read("GET /api/combos", {});
    expect(JSON.stringify(list.output)).not.toContain("must-not-project");
    expect(isRecord(list.output) && Array.isArray(list.output.combos) && list.output.combos.length >= 5).toBe(true);
    mark("GET /api/combos", "authorized-source-http-semantics");
    const listResponse = latest(harness, "GET /api/combos");
    observe("GET /api/combos", beforeRead, pair.route.state, listResponse);
    markObserved(harness, "GET /api/combos", beforeRead);

    const item = await harness.executor.read("GET /api/combos/{id}", { path: { id: "seed-update" } });
    expect(item.output).toBeTruthy();
    expect(item.output).toMatchObject({ config: { maxRetries: 2, reasoningTokenBufferEnabled: true } });
    expect(JSON.stringify(item.output)).not.toContain("must-not-project");
    mark("GET /api/combos/{id}", "authorized-source-http-semantics");
    markObserved(harness, "GET /api/combos/{id}", pair.route.state);

    let before = pair.route.state;
    const created = await apply(harness, "POST /api/combos", { body: { name: "Created", models: ["fixture/new"], dimensions: "1536" } });
    expect(created.status).toBe("source-only"); expect(harness.dispatchCount("POST /api/combos")).toBe(0);
    const createdRow = persistedCombos(pair.route).find(row => row.name === "Created");
    expect(createdRow).toMatchObject({
      id: "00000000-0000-4000-8000-000100000001",
      version: 2,
      sortOrder: 5,
      strategy: "priority",
      dimensions: "1536",
      createdAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
    });
    expect(Array.isArray(createdRow?.models) && createdRow.models[0]).toMatchObject({ kind: "model", model: "fixture/new", providerId: "fixture" });
    expect(isRecord(pair.route.state) && isRecord(pair.route.state.effects) && pair.route.state.effects.cacheInvalidations).toEqual(["combos"]);
    expect(isRecord(pair.route.state) && isRecord(pair.route.state.effects) && pair.route.state.effects.backupReasons).toEqual(["pre-write"]);
    mark("POST /api/combos", "authorized-source-http-semantics");
    markObserved(harness, "POST /api/combos", before);

    before = pair.route.state;
    const patched = await apply(harness, "PATCH /api/combos/{id}", { path: { id: "seed-update" }, body: { description: null, models: ["fixture/updated"], dimensions: "2048" } });
    expect(patched.status).toBe("source-only"); expect(harness.dispatchCount("PATCH /api/combos/{id}")).toBe(0);
    const patchedRow = persistedCombo(pair.route, "seed-update");
    expect(patchedRow).not.toHaveProperty("description");
    expect(patchedRow).toMatchObject({ version: 2, config: { maxRetries: 2 }, dimensions: "2048", models: [{ kind: "model", model: "fixture/updated", providerId: "fixture" }] });
    expect(isRecord(pair.route.state) && isRecord(pair.route.state.effects) && pair.route.state.effects.sessionHistoryClears).toEqual(["Update"]);
    expect(isRecord(pair.route.state) && isRecord(pair.route.state.effects) && pair.route.state.effects.cacheInvalidations).toEqual(["combos", "combos"]);
    expect(isRecord(pair.route.state) && isRecord(pair.route.state.effects) && pair.route.state.effects.backupReasons).toEqual(["pre-write", "pre-write"]);
    mark("PATCH /api/combos/{id}", "authorized-source-http-semantics");
    markObserved(harness, "PATCH /api/combos/{id}", before);

    before = pair.route.state;
    const put = await apply(harness, "PUT /api/combos/{id}", { path: { id: "seed-update" }, body: { isHidden: true, dimensions: null } });
    expect(put.status).toBe("source-only");
    expect(persistedCombo(pair.route, "seed-update")).toMatchObject({ isHidden: true, config: { maxRetries: 2 }, version: 2 });
    expect(persistedCombo(pair.route, "seed-update")).not.toHaveProperty("dimensions");
    mark("PUT /api/combos/{id}", "authorized-source-http-semantics");
    markObserved(harness, "PUT /api/combos/{id}", before);

    before = pair.route.state;
    const deleted = await apply(harness, "DELETE /api/combos/{id}", { path: { id: "seed-delete" } });
    expect(deleted.status).toBe("source-only"); expect(harness.dispatchCount("DELETE /api/combos/{id}")).toBe(0);
    expect(persistedCombos(pair.route).some(row => row.id === "seed-delete")).toBe(false);
    const deletedState = pair.route.state;
    expect(isRecord(deletedState) && deletedState.proxyAssignments).toEqual([]);
    expect(isRecord(deletedState) && deletedState.proxyRotations).toEqual([]);
    expect(isRecord(deletedState) && isRecord(deletedState.effects) && deletedState.effects.reasoningCacheInvalidations).toEqual([1]);
    expect(isRecord(deletedState) && isRecord(deletedState.effects) && deletedState.effects.proxyRegistryGenerationBumps).toEqual([1]);
    mark("DELETE /api/combos/{id}", "authorized-source-http-semantics");
    markObserved(harness, "DELETE /api/combos/{id}", before);

    before = pair.route.state;
    const auto = await harness.executor.read("GET /api/combos/auto", {});
    expect(isRecord(auto.output) && Array.isArray(auto.output.combos)).toBe(true);
    const autoCombos = isRecord(auto.output) && Array.isArray(auto.output.combos) ? auto.output.combos.filter(isRecord) : [];
    const autoCandidate = autoCombos.find(row => row.id === "auto");
    expect(autoCandidate).toBeTruthy();
    expect(autoCandidate).toMatchObject({ candidateCount: 1, candidatePool: ["fixture"] });
    const materializedAuto = await harness.executor.read("GET /api/combos/auto", { query: { id: "auto" } });
    expect(isRecord(materializedAuto.output)).toBe(true);
    const materializedAutoBody = isRecord(materializedAuto.output) ? materializedAuto.output : {};
    expect(materializedAutoBody).toMatchObject({ id: "auto", name: "auto", strategy: "auto", isActive: true, type: "auto", candidateCount: 1 });
    expect(materializedAutoBody.max_output_tokens).toBe(4096);
    expect(Array.isArray(materializedAutoBody.models) && materializedAutoBody.models[0]).toMatchObject({
      kind: "model", model: "fixture/chat", providerId: "fixture", connectionId: null, allowedConnectionIds: ["fixture-connection"],
    });
    expect(typeof (Array.isArray(materializedAutoBody.models) && isRecord(materializedAutoBody.models[0]) ? materializedAutoBody.models[0].weight : undefined)).toBe("number");
    const autoAdapter = registry.require("GET /api/combos/auto");
    const invalidAuto = await callAdapter(autoAdapter, pair.route.endpoint, { query: { id: "not-an-auto-combo" } });
    expect(invalidAuto.status).toBe(400);
    expect(invalidAuto.data).toMatchObject({ error: 'Not an auto combo id: "not-an-auto-combo"' });
    const unknownAuto = await callAdapter(autoAdapter, pair.route.endpoint, { query: { id: "auto/not-a-built-in-template" } });
    expect(unknownAuto.status).toBe(404);
    expect(unknownAuto.data).toMatchObject({ error: 'Unknown auto combo: "auto/not-a-built-in-template"' });
    mark("GET /api/combos/auto", "authorized-source-http-semantics");
    markObserved(harness, "GET /api/combos/auto", before);

    before = pair.route.state;
    const builder = await harness.executor.read("GET /api/combos/builder/options", {});
    expect(isRecord(builder.output) && Array.isArray(builder.output.providers)).toBe(true);
    const provider = isRecord(builder.output) && Array.isArray(builder.output.providers) ? builder.output.providers.find(row => isRecord(row) && row.providerId === "fixture") : undefined;
    expect(provider).toMatchObject({ providerId: "fixture", modelCount: 1, models: [{ id: "chat", qualifiedModel: "fixture/chat", source: "imported", outputTokenLimit: 4_096 }] });
    const projectedConnections = isRecord(provider) && Array.isArray(provider.connections) ? provider.connections.filter(isRecord) : [];
    expect(projectedConnections).toHaveLength(1);
    expect(projectedConnections[0]).not.toHaveProperty("lastError");
    expect(JSON.stringify(builder.output)).not.toContain("fixture-provider-secret");
    const builderAdapter = registry.require("GET /api/combos/builder/options");
    const rawBuilder = await callAdapter(builderAdapter, pair.route.endpoint, {});
    expect(rawBuilder.status).toBe(200);
    expect(isRecord(rawBuilder.data) && Array.isArray(rawBuilder.data.providers)).toBe(true);
    const rawProvider = isRecord(rawBuilder.data) && Array.isArray(rawBuilder.data.providers)
      ? rawBuilder.data.providers.find(row => isRecord(row) && row.providerId === "fixture") : undefined;
    const rawConnections = isRecord(rawProvider) && Array.isArray(rawProvider.connections) ? rawProvider.connections.filter(isRecord) : [];
    expect(rawConnections[0]?.lastError).toBe("fixture-provider-secret");
    expect(builderAdapter.projectTarget(rawBuilder.data)).toEqual(rawBuilder.data);
    expect(JSON.stringify(latest(harness, "GET /api/combos/builder/options").body)).not.toContain("fixture-provider-secret");
    expect(isRecord(builder.output) && builder.output.generatedAt).toBe("2026-10-20T00:00:00.000Z");
    mark("GET /api/combos/builder/options", "authorized-source-http-semantics");
    markObserved(harness, "GET /api/combos/builder/options", before);

    before = pair.route.state;
    const duplicate = await apply(harness, "POST /api/combos/duplicate", { body: { name: "auto/best-coding" } });
    expect(duplicate.status).toBe("source-only");
    const duplicateRow = persistedCombos(pair.route).find(row => row.name === "static-best-coding");
    expect(duplicateRow).toMatchObject({
      name: "static-best-coding",
      strategy: "priority",
      config: { sourceAutoCombo: "auto/best-coding" },
      models: [{ kind: "model", model: "fixture/chat", providerId: "fixture" }],
    });
    mark("POST /api/combos/duplicate", "authorized-source-http-semantics");
    markObserved(harness, "POST /api/combos/duplicate", before);

    const reorderIds = persistedCombos(pair.route).map(row => {
      if (typeof row.id !== "string") throw new Error("Persisted combo row omitted its source id");
      return row.id;
    }).reverse();
    before = pair.route.state;
    const reordered = await apply(harness, "POST /api/combos/reorder", { body: { comboIds: reorderIds } });
    expect(reordered.status).toBe("source-only");
    expect(persistedCombos(pair.route).map(row => row.sortOrder)).toEqual(persistedCombos(pair.route).map((_row, index) => index + 1));
    expect(persistedCombos(pair.route).map(row => row.id)).toEqual(reorderIds);
    mark("POST /api/combos/reorder", "authorized-source-http-semantics");
    markObserved(harness, "POST /api/combos/reorder", before);

    before = pair.route.state;
    const tested = await apply(harness, "POST /api/combos/test", { body: { comboName: "Probe" } });
    expect(tested.status).toBe("source-only");
    const successProbe = latest(harness, "POST /api/combos/test");
    expect(successProbe.status).toBe(200);
    expect(isRecord(successProbe.body) && successProbe.body.testedAt).toBe("2026-10-20T00:00:00.000Z");
    expect(isRecord(successProbe.body) && Array.isArray(successProbe.body.results)).toBe(true);
    const successfulResults = isRecord(successProbe.body) && Array.isArray(successProbe.body.results)
      ? successProbe.body.results.filter(isRecord) : [];
    expect(successfulResults).toHaveLength(2);
    expect(successfulResults.find(result => result.model === "fixture/chat")).toMatchObject({ status: "ok", responseText: "pong" });
    expect(successfulResults.find(result => result.model === "fixture/text-embedding")).toMatchObject({ status: "ok", responseText: "[Embedding generated successfully]" });
    expect(pair.route.counts["POST /v1/chat/completions"]).toBe(1);
    expect(pair.route.counts["POST /v1/embeddings"]).toBe(1);

    pair.route.rejectNextProbe("fixture/chat");
    const mixedProbe = await apply(harness, "POST /api/combos/test", { body: { comboName: "Probe" } });
    expect(mixedProbe.status).toBe("source-only");
    const failedProbe = latest(harness, "POST /api/combos/test");
    expect(failedProbe.status).toBe(200);
    expect(isRecord(failedProbe.body) && failedProbe.body.resolvedBy).toBe("fixture/text-embedding");
    expect(isRecord(failedProbe.body) && Array.isArray(failedProbe.body.results)).toBe(true);
    const mixedResults = isRecord(failedProbe.body) && Array.isArray(failedProbe.body.results)
      ? failedProbe.body.results.filter(isRecord) : [];
    expect(mixedResults.find(result => result.model === "fixture/chat")).toMatchObject({ status: "error", statusCode: 503, error: "fixture upstream rejected probe" });
    expect(mixedResults.find(result => result.model === "fixture/text-embedding")).toMatchObject({ status: "ok", responseText: "[Embedding generated successfully]" });
    expect(JSON.stringify(failedProbe.body)).not.toContain("must-not-project");
    expect(pair.route.counts["POST /v1/chat/completions"]).toBe(2);
    expect(pair.route.counts["POST /v1/embeddings"]).toBe(2);
    mark("POST /api/combos/test", "authorized-source-http-semantics");
    markObserved(harness, "POST /api/combos/test", before);

    before = pair.route.state;
    const metrics = await harness.executor.read("GET /api/combos/metrics", { query: { combo: "Probe" } });
    expect(isRecord(metrics.output) && isRecord(metrics.output.metrics)).toBe(true);
    expect(isRecord(metrics.output) && isRecord(metrics.output.metrics) && metrics.output.metrics.totalRequests).toBe(1);
    expect(isRecord(metrics.output) && isRecord(metrics.output.metrics) && metrics.output.metrics.intentCounts).toEqual({ coding: 1 });
    expect(isRecord(metrics.output) && isRecord(metrics.output.metrics) && metrics.output.metrics.lastUsedAt).toBe("2026-10-20T00:00:00.000Z");
    mark("GET /api/combos/metrics", "authorized-source-http-semantics");
    markObserved(harness, "GET /api/combos/metrics", before);

    before = pair.route.state;
    const reset = await apply(harness, "DELETE /api/combos/metrics", { query: { combo: "Probe" } });
    expect(reset.status).toBe("unknown");
    const afterReset = await harness.executor.read("GET /api/combos/metrics", { query: { combo: "Probe" } });
    expect(afterReset.output).toMatchObject({ metrics: null, message: "No metrics for this combo yet" });
    expect(harness.dispatchCount("DELETE /api/combos/metrics")).toBe(1);
    mark("DELETE /api/combos/metrics", "authorized-source-http-semantics");
    markObserved(harness, "DELETE /api/combos/metrics", before);

    const invalid = await directRequest(pair.route, "POST /api/combos", { bearer: MANAGE_KEY, body: { name: "invalid", models: [] } });
    expect(invalid.status).toBe(400);
    const rawSourceCreate = await directRequest(pair.route, "POST /api/combos", {
      bearer: MANAGE_KEY,
      body: { name: "  Source Normalized  ", models: ["fixture/source-model"] },
    });
    expect(rawSourceCreate.status).toBe(201);
    const sourceCreated = await rawSourceCreate.json() as { name: string; models: Array<Record<string, unknown>> };
    expect(sourceCreated.name).toBe("Source Normalized");
    expect(sourceCreated.models[0]).toMatchObject({ kind: "model", model: "fixture/source-model", providerId: "fixture" });
    expect(COMBO_OPERATION_IDS.every(id => observations.has(id))).toBe(true);
    allAssertionsPassed = true;
  });

  test("metrics reset confirms exposed scope while disclosing and preserving hidden-state uncertainty", async () => {
    const pair = startFixture();
    const harness = createHarness(pair);
    pair.route.recordHiddenPersistedSkipBypass("hidden-metrics");
    expect(pair.route.hiddenPersistedSkipBypasses("hidden-metrics")).toBe(1);
    const selected = await harness.executor.read("GET /api/combos/metrics", { query: { combo: "hidden-metrics" } });
    const all = await harness.executor.read("GET /api/combos/metrics", {});
    expect(selected.output).toMatchObject({ metrics: null });
    expect(all.output).toMatchObject({ metrics: expect.any(Object) });

    const selectedPlan = await harness.executor.plan("DELETE /api/combos/metrics", { query: { combo: "hidden-metrics" } });
    expect(selectedPlan.preview.projectedTarget).toMatchObject({
      kind: "collection",
      entries: [{ identity: { scope: "selected", comboName: "hidden-metrics" }, state: { metrics: null } }],
    });
    expect(selectedPlan.preview.visibilityLimits?.join(" ")).toContain("persisted-skip");
    expect(selectedPlan.preview.consequence).toContain("selected combo's production, shadow, and persisted-skip counters");
    pair.route.recordHiddenPersistedSkipBypass("hidden-metrics");
    expect(pair.route.hiddenPersistedSkipBypasses("hidden-metrics")).toBe(2);
    const selectedResult = await harness.executor.apply(selectedPlan.planId, { confirmed: true });
    expect(selectedResult.status).toBe("unknown");
    expect(harness.dispatchCount("DELETE /api/combos/metrics")).toBe(1);
    expect(pair.route.hiddenPersistedSkipBypasses("hidden-metrics")).toBe(0);

    pair.route.recordComboMetrics("drift-metrics");
    const driftPlan = await harness.executor.plan("DELETE /api/combos/metrics", { query: { combo: "drift-metrics" } });
    pair.route.recordComboMetrics("drift-metrics");
    await expect(harness.executor.apply(driftPlan.planId, { confirmed: true })).rejects.toMatchObject({ code: "target-drift" });
    expect(harness.dispatchCount("DELETE /api/combos/metrics")).toBe(1);

    for (const name of ["totalRequests", "byModel", "__proto__"]) pair.route.recordComboMetrics(name);
    const byModelPlan = await harness.executor.plan("DELETE /api/combos/metrics", { query: { combo: "byModel" } });
    expect(byModelPlan.preview.projectedTarget).toMatchObject({
      entries: [{ identity: { scope: "selected", comboName: "byModel" }, state: { metrics: { byModel: { "fixture/chat": { requests: 1 } } } } }],
    });
    const totalRequestsPlan = await harness.executor.plan("DELETE /api/combos/metrics", { query: { combo: "totalRequests" } });
    expect(totalRequestsPlan.preview.projectedTarget).toMatchObject({
      entries: [{ identity: { scope: "selected", comboName: "totalRequests" }, state: { metrics: { totalRequests: 1 } } }],
    });
    const protoPlan = await harness.executor.plan("DELETE /api/combos/metrics", { query: { combo: "__proto__" } });
    expect(protoPlan.preview.projectedTarget).toMatchObject({
      entries: [{ identity: { scope: "selected", comboName: "__proto__" }, state: { metrics: { totalRequests: 1 } } }],
    });
    const allPlan = await harness.executor.plan("DELETE /api/combos/metrics", {});
    expect(allPlan.preview.projectedTarget).toMatchObject({
      entries: [{ identity: { scope: "all" }, state: { metrics: { totalRequests: { totalRequests: 1 }, byModel: { totalRequests: 1 } } } }],
    });
    expect(allPlan.targetDigest).not.toBe(totalRequestsPlan.targetDigest);
    expect(allPlan.preview.consequence).toContain("stops the metrics cleanup interval until module reload");
    expect(allPlan.preview.visibilityLimits?.join(" ")).toContain("cleanup interval until module reload");
    expect(allPlan.preview.visibilityLimits?.join(" ")).toContain("__proto__");
    const allWithSpecialNames = await harness.executor.read("GET /api/combos/metrics", {});
    expect(Object.hasOwn((allWithSpecialNames.output as { metrics: Record<string, unknown> }).metrics, "__proto__")).toBe(false);
    pair.route.recordHiddenPersistedSkipBypass("hidden-only-all");
    harness.loseNextResponse("DELETE /api/combos/metrics");
    const allResult = await harness.executor.apply(allPlan.planId, { confirmed: true });
    expect(allResult.status).toBe("unknown");
    expect(harness.dispatchCount("DELETE /api/combos/metrics")).toBe(2);
    expect(pair.route.hiddenPersistedSkipBypasses("hidden-only-all")).toBe(0);
    mark("DELETE /api/combos/metrics", "visibility-limited-confirmation-and-one-shot-settlement");
  });
});
