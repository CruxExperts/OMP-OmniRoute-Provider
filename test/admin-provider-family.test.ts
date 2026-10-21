import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  operationEvidenceBinding,
  outcomeArtifactPath,
  testCaseSourceHash,
  testOutcomeHash,
} from "../scripts/generate-contracts.ts";
import { createAdminExecutor } from "../src/admin/executor.ts";
import { invokeJsonAdapter } from "../src/admin/adapters.ts";
import {
  canonicalizeJson,
  getOperation,
  type OperationAdapter,
  type OperationDescriptor,
} from "../src/admin/registry.ts";
import { mapRelationInput, projectRelationSnapshot, relationOutcomeMatches } from "../src/admin/relations.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import {
  PROVIDER_FAMILY_OPERATION_IDS,
  PROVIDER_FAMILY_SOURCE_CONTRACTS,
  ProviderFamilyFixture,
  type ProviderConnectionFixture,
} from "./fixtures/provider-family.fixture.ts";

const PATCH_PROVIDERS = "PATCH /api/providers";
const GET_PROVIDERS = "GET /api/providers";
const POST_PROVIDERS = "POST /api/providers";
const DELETE_PROVIDERS = "DELETE /api/providers";
const FIXTURE_TIME = "2026-10-19T00:00:00.000Z";
const MANAGEMENT_KEY = "fixture-manage";
const PROFILE_ID = "provider-family-fixture";
const TEST_ID = "test/admin-provider-family.test.ts";

function seededConnections(): ProviderConnectionFixture[] {
  return [
    {
      id: "c1", provider: "claude", name: "Claude one", isActive: false, priority: 1,
      updatedAt: "2026-10-17T00:00:00.000Z", apiKey: "abcdefgh-hidden-1234",
      accessToken: "fixture-access-secret", refreshToken: "fixture-refresh-secret", idToken: "fixture-id-secret",
      providerSpecificData: {
        operatorDisabledAt: "2026-10-16T00:00:00.000Z", runtimeKey: "runtime-secret",
        nested: { apiKey: "nested-api-secret" },
      },
    },
    { id: "c2", provider: "claude", name: "Claude two", isActive: true, priority: 1, updatedAt: "2026-10-18T00:00:00.000Z" },
    { id: "c3", provider: "claude", name: "Claude three", isActive: false, priority: 2, updatedAt: FIXTURE_TIME },
    { id: "o1", provider: "openai", name: "OpenAI one", isActive: true, priority: 1, updatedAt: FIXTURE_TIME },
  ];
}

function buildFixtureRegistry() {
  const descriptors = PROVIDER_FAMILY_OPERATION_IDS.map(operationId => {
    const source = getOperation(operationId);
    if (!source) throw new Error(`pinned operation is absent: ${operationId}`);
    const contract = PROVIDER_FAMILY_SOURCE_CONTRACTS[operationId];
    const binding = operationEvidenceBinding(operationId, contract);
    if (binding.handlerSha256 !== source.source.sha256 || binding.handlerGitBlobSha !== source.source.gitBlobSha) {
      throw new Error(`fixture contract source does not match the pinned descriptor: ${operationId}`);
    }
    const name = operationId.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "");
    return {
      ...source,
      ...contract,
      mediaType: {
        request: contract.request.body?.mediaType ?? null,
        response: contract.response.mediaType,
      },
      coverage: { status: "invokable" as const, adapterId: `typed.fixture.${name}`, reason: null },
    } satisfies OperationDescriptor;
  });
  return fixtureRegistry(descriptors);
}

const registry = buildFixtureRegistry();

function descriptorFor(adapter: OperationAdapter) {
  const descriptor = adapter.descriptor;
  return {
    operationId: descriptor.operationId,
    adapterId: adapter.adapterId,
    method: descriptor.method,
    pathTemplate: descriptor.pathTemplate,
    mediaType: descriptor.mediaType,
    request: { pathParameters: descriptor.request.pathParameters, body: descriptor.request.body },
    streaming: descriptor.streaming,
    auth: descriptor.auth,
    coverage: { status: "invokable" as const },
  };
}

async function callFixtureOperation(
  adapter: OperationAdapter,
  endpoint: string,
  apiKey: string,
  input: unknown,
  signal?: AbortSignal,
) {
  const validated = adapter.validate(input);
  const response = await invokeJsonAdapter({
    descriptor: descriptorFor(adapter),
    endpoint,
    credential: { kind: "apiKey", value: apiKey },
    resolvedPath: adapter.buildPath(validated),
    queryParameters: adapter.buildQuery(validated),
    ...(validated.body === undefined ? {} : { body: validated.body }),
    ...(signal === undefined ? {} : { signal }),
  });
  return response.status < 400 && response.data !== undefined
    ? { ...response, data: adapter.project(response.data) }
    : response;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function responseRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new Error("fixture returned a non-object response");
  return value;
}


function sourceTargetReadOperation(operation: OperationAdapter["descriptor"]) {
  const relation = operation.reconciliation;
  const targetRead = relation?.targetRead;
  if (!targetRead || targetRead.operationId !== GET_PROVIDERS || relation?.reconcile.operationId !== GET_PROVIDERS) {
    throw new Error(`${operation.operationId} does not name the pinned provider collection snapshot`);
  }
  return targetRead;
}

function credentialValue(auth: { readonly credential?: { readonly kind: string; readonly value: string } }): string {
  if (auth.credential?.kind !== "apiKey") throw new Error("fixture requires its bound management API key");
  return auth.credential.value;
}

function createProviderAdminHarness(
  fixture: ProviderFamilyFixture,
  key = MANAGEMENT_KEY,
) {
  const dispatchCounts = new Map<string, number>();
  const lastResponses = new Map<string, { status: number; body: unknown }>();
  let reconciliationReads = 0;
  let reconciliationMatches = false;
  let loseNextResponseFor: string | undefined;

  const executor = createAdminExecutor({
    registry,
    dispatch: async (request, context) => {
      const adapter = registry.require(request.operationId);
      const response = await invokeJsonAdapter({
        descriptor: descriptorFor(adapter),
        endpoint: context.auth.endpoint,
        credential: { kind: "apiKey", value: credentialValue(context.auth) },
        resolvedPath: request.path,
        queryParameters: request.queryParameters,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      dispatchCounts.set(request.operationId, (dispatchCounts.get(request.operationId) ?? 0) + 1);
      if (response.status >= 400) {
        throw Object.assign(new Error("provider fixture returned an HTTP error"), { status: response.status });
      }
      const body = response.data === undefined ? null : adapter.project(response.data);
      lastResponses.set(request.operationId, { status: response.status, body });
      if (request.operationId === PATCH_PROVIDERS && fixture.consumeLostPatchResponse()) {
        throw Object.assign(new Error("fixture lost the PATCH response after commit"), { code: "network-lost-response", uncertain: true });
      }
      if (loseNextResponseFor === request.operationId) {
        loseNextResponseFor = undefined;
        throw Object.assign(new Error("fixture lost the response after commit"), { code: "network-lost-response", uncertain: true });
      }
      return response.data;
    },
    readTarget: async context => {
      const targetRead = sourceTargetReadOperation(context.operation);
      const readAdapter = registry.require(targetRead.operationId);
      const input = mapRelationInput(targetRead.inputs, context.payload);
      const response = await callFixtureOperation(readAdapter, context.auth.endpoint, credentialValue(context.auth), input, context.signal);
      if (response.status >= 400) throw Object.assign(new Error("provider target snapshot was denied"), { status: response.status });
      const snapshot = projectRelationSnapshot(targetRead, response.data, context.payload);
      return {
        digest: createHash("sha256").update(canonicalizeJson(snapshot)).digest("hex"),
        snapshot,
      };
    },
    reconcile: async context => {
      const relation = context.operation.reconciliation;
      if (!relation || relation.reconcile.operationId !== context.readOperation.operationId) {
        reconciliationMatches = false;
        return { status: "unknown" };
      }
      sourceTargetReadOperation(context.operation);
      const readAdapter = registry.require(context.readOperation.operationId);
      const input = mapRelationInput(context.relation.inputs, context.payload, context.request.body);
      const response = await callFixtureOperation(readAdapter, context.auth.endpoint, credentialValue(context.auth), input, context.signal);
      if (response.status >= 400) {
        reconciliationMatches = false;
        return { status: "unknown" };
      }
      reconciliationReads += 1;
      const observed = projectRelationSnapshot(relation.targetRead, response.data, context.payload);
      reconciliationMatches = relationOutcomeMatches(relation, context.originalTarget, observed, context.payload);
      return reconciliationMatches
        ? { status: "applied", output: response.data }
        : { status: "unknown" };
    },
  });
  executors.push(executor);
  executor.setAdminBinding({ profileId: PROFILE_ID, endpoint: fixture.endpoint }, true);
  executor.bindCredential({ profileId: PROFILE_ID, endpoint: fixture.endpoint, apiKey: key });
  return {
    executor,
    dispatchCount: (operationId: string) => dispatchCounts.get(operationId) ?? 0,
    patchDispatches: () => dispatchCounts.get(PATCH_PROVIDERS) ?? 0,
    deleteDispatches: () => dispatchCounts.get(DELETE_PROVIDERS) ?? 0,
    postDispatches: () => dispatchCounts.get(POST_PROVIDERS) ?? 0,
    reconciliationReads: () => reconciliationReads,
    reconciliationMatches: () => reconciliationMatches,
    lastResponse: (operationId: string) => lastResponses.get(operationId),
    lastPatchResponse: () => lastResponses.get(PATCH_PROVIDERS)?.body,
    loseNextResponse: (operationId: string) => { loseNextResponseFor = operationId; },
  };
}

type SemanticObservation = {
  before: unknown;
  after: unknown;
  result: { status: number; body: unknown };
};

const REQUIRED_CASES: Readonly<Record<typeof PROVIDER_FAMILY_OPERATION_IDS[number], readonly string[]>> = {
  [GET_PROVIDERS]: ["filter-pagination-projection", "auth-denial", "handler-error", "conditional-management-auth"],
  [POST_PROVIDERS]: ["human-create-redaction", "source-refinement-validation", "conditional-create", "conditional-management-auth"],
  [PATCH_PROVIDERS]: ["human-apply", "duplicate-order", "validation-auth", "target-drift", "cancel", "reconcile", "partial-commit", "conditional-management-auth"],
  [DELETE_PROVIDERS]: ["human-delete", "validation", "conditional-management-auth"],
};

const completedCases = new Map<string, Set<string>>();
const operationObservations = new Map<string, SemanticObservation>();
const fixtures: ProviderFamilyFixture[] = [];
const executors: ReturnType<typeof createAdminExecutor>[] = [];

function completeCase(operationId: string, caseId: string): void {
  const cases = completedCases.get(operationId) ?? new Set<string>();
  cases.add(caseId);
  completedCases.set(operationId, cases);
}

function observeOperation(operationId: string, caseId: string, observation: SemanticObservation): void {
  operationObservations.set(operationId, structuredClone(observation));
  completeCase(operationId, caseId);
}

function publicProviderState(fixture: ProviderFamilyFixture): Array<{ id: string; provider: string; isActive: boolean }> {
  return fixture.state.map(({ id, provider, isActive }) => ({ id, provider, isActive })).sort((left, right) => left.id.localeCompare(right.id));
}

afterEach(async () => {
  for (const executor of executors.splice(0)) executor.shutdown();
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()));
});

afterAll(async () => {
  const complete = PROVIDER_FAMILY_OPERATION_IDS.every(operationId =>
    REQUIRED_CASES[operationId].every(caseId => completedCases.get(operationId)?.has(caseId)),
  );
  if (!complete) return;
  const observationDirectory = resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations");
  await mkdir(observationDirectory, { recursive: true, mode: 0o700 });
  for (const operationId of PROVIDER_FAMILY_OPERATION_IDS) {
    const observation = operationObservations.get(operationId);
    if (!observation) return;
    const binding = operationEvidenceBinding(operationId, PROVIDER_FAMILY_SOURCE_CONTRACTS[operationId]);
    const caseSha256 = testCaseSourceHash(TEST_ID);
    const artifactPath = outcomeArtifactPath(operationId);
    const artifact = { operationId, testId: TEST_ID, caseSha256, binding, observation };
    await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson(artifact)}\n`, { mode: 0o600 });
    testOutcomeHash(operationId, TEST_ID, caseSha256, binding, PROVIDER_FAMILY_SOURCE_CONTRACTS[operationId], artifactPath);
  }
});



describe("pinned `/api/providers` family semantics", () => {
  test("provider collection handlers admit anonymous requests only under the source's disabled-auth setting", async () => {
    const fixture = new ProviderFamilyFixture(seededConnections(), { clock: () => FIXTURE_TIME });
    fixtures.push(fixture);
    const scenarios = [
      { operationId: GET_PROVIDERS, input: {}, status: 200 },
      { operationId: POST_PROVIDERS, input: { body: { provider: "openai", name: "Anonymous fixture", apiKey: "fixture-source-only-key" } }, status: 201 },
      { operationId: PATCH_PROVIDERS, input: { body: { ids: ["c1"], isActive: true } }, status: 200 },
      { operationId: DELETE_PROVIDERS, input: { body: { ids: ["c2"] } }, status: 200 },
    ];
    const before = publicProviderState(fixture);
    const request = async (scenario: typeof scenarios[number]) => {
      const adapter = registry.require(scenario.operationId);
      const input = adapter.validate(scenario.input);
      return invokeJsonAdapter({
        descriptor: descriptorFor(adapter),
        endpoint: fixture.endpoint,
        resolvedPath: adapter.buildPath(input),
        queryParameters: adapter.buildQuery(input),
        ...(input.body === undefined ? {} : { body: input.body }),
      });
    };
    for (const scenario of scenarios) expect((await request(scenario)).status).toBe(401);
    expect(publicProviderState(fixture)).toEqual(before);
    fixture.authRequired = false;
    for (const scenario of scenarios) {
      const response = await request(scenario);
      expect(response.status).toBe(scenario.status);
      if (scenario.operationId === GET_PROVIDERS) expect(responseRecord(response.data).total).toBe(4);
    }
    expect(fixture.state.find(connection => connection.id === "c1")?.isActive).toBe(true);
    expect(fixture.state.some(connection => connection.id === "c2")).toBe(false);
    expect(fixture.state.some(connection => connection.name === "Anonymous fixture" && connection.provider === "openai")).toBe(true);
    fixture.authRequired = true;
    for (const scenario of scenarios) expect((await request(scenario)).status).toBe(401);
    for (const operationId of PROVIDER_FAMILY_OPERATION_IDS) completeCase(operationId, "conditional-management-auth");
  });

  test("GET applies the handler's provider filter and offset pagination before projecting secret-free rows", async () => {
    const fixture = new ProviderFamilyFixture(seededConnections(), { clock: () => FIXTURE_TIME });
    fixtures.push(fixture);
    const harness = createProviderAdminHarness(fixture);
    const before = publicProviderState(fixture);

    const result = await harness.executor.read(GET_PROVIDERS, {
      query: { provider: " claude ", limit: 1, offset: 1 },
    });
    const body = responseRecord(result.output);
    expect(body.total).toBe(3);
    expect(body.connections).toHaveLength(1);
    const connection = responseRecord((body.connections as unknown[])[0]);
    expect(connection.id).toBe("c1");
    expect(connection.provider).toBe("claude");
    expect(connection.isActive).toBe(false);
    expect(connection.syncedModelsAt).toBe(null);
    expect(connection.rateLimitAutoProtected).toBe(false);
    expect(connection).not.toHaveProperty("apiKey");
    expect(connection).not.toHaveProperty("accessToken");
    expect(connection).not.toHaveProperty("refreshToken");
    expect(connection).not.toHaveProperty("idToken");
    expect(connection).not.toHaveProperty("providerSpecificData");
    expect(JSON.stringify(result.output)).not.toContain("nested-api-secret");
    expect(JSON.stringify(result.output)).not.toContain("runtime-secret");
    expect(JSON.stringify(result.output)).not.toContain("abcdefgh-hidden-1234");
    const selectedResponse = harness.lastResponse(GET_PROVIDERS);
    if (!selectedResponse) throw new Error("GET did not record its observed HTTP response");
    expect(selectedResponse.status).toBe(200);

    const noMatches = await harness.executor.read(GET_PROVIDERS, {
      query: { provider: "not-a-provider", limit: 1, offset: 0 },
    });
    expect(noMatches.output).toEqual({ connections: [], total: 0 });
    observeOperation(GET_PROVIDERS, "filter-pagination-projection", {
      before,
      after: publicProviderState(fixture),
      result: { status: selectedResponse.status, body: selectedResponse.body },
    });
  });

  test("PATCH preparation does not mutate; confirmed apply updates exact IDs and reports partial misses", async () => {
    const fixture = new ProviderFamilyFixture(seededConnections(), { clock: () => FIXTURE_TIME });
    fixtures.push(fixture);
    const harness = createProviderAdminHarness(fixture);
    const before = publicProviderState(fixture);
    const plan = await harness.executor.plan(PATCH_PROVIDERS, {
      body: { ids: [" c1 ", "missing", "c3"], isActive: true },
    });

    expect(plan.risk).toBe("mutation");
    expect(plan.preview.confirmationRequired).toBe(true);
    expect(harness.patchDispatches()).toBe(0);
    expect(publicProviderState(fixture)).toEqual(before);

    const result = await harness.executor.apply(plan.planId, { confirmed: true });
    expect(result.status).toBe("applied");
    expect(harness.patchDispatches()).toBe(1);
    expect(harness.lastPatchResponse()).toEqual({
      message: "Activated 2 connection(s)", updated: 2, notFound: ["missing"],
    });
    expect(fixture.state.map(connection => [connection.id, connection.isActive])).toEqual([
      ["c1", true], ["c2", true], ["c3", true], ["o1", true],
    ]);
    expect(fixture.state.find(connection => connection.id === "c1")?.providerSpecificData).not.toHaveProperty("operatorDisabledAt");
    const response = harness.lastResponse(PATCH_PROVIDERS);
    if (!response) throw new Error("PATCH did not record its observed HTTP response");
    observeOperation(PATCH_PROVIDERS, "human-apply", {
      before,
      after: publicProviderState(fixture),
      result: { status: response.status, body: response.body },
    });
  });

  test("PATCH trims IDs, preserves duplicate request order, and binds the ordered payload separately from selected resources", async () => {
    const fixture = new ProviderFamilyFixture(seededConnections(), { clock: () => FIXTURE_TIME });
    fixtures.push(fixture);
    const harness = createProviderAdminHarness(fixture);
    const firstPlan = await harness.executor.plan(PATCH_PROVIDERS, {
      body: { ids: [" c1 ", "c2", "c1"], isActive: true },
    });
    const reorderedPlan = await harness.executor.plan(PATCH_PROVIDERS, {
      body: { ids: ["c2", "c1", "c1"], isActive: true },
    });

    expect(firstPlan.payloadDigest).not.toBe(reorderedPlan.payloadDigest);
    expect(firstPlan.targetDigest).toBe(reorderedPlan.targetDigest);
    expect(harness.patchDispatches()).toBe(0);
    expect(fixture.state.map(connection => [connection.id, connection.isActive])).toEqual([
      ["c1", false], ["c2", true], ["c3", false], ["o1", true],
    ]);

    const result = await harness.executor.apply(firstPlan.planId, { confirmed: true });
    expect(result.status).toBe("applied");
    expect(harness.lastPatchResponse()).toEqual({
      message: "Activated 3 connection(s)", updated: 3, notFound: [],
    });
    expect(fixture.counts.updates).toBe(3);
    expect(fixture.state.map(connection => [connection.id, connection.isActive])).toEqual([
      ["c1", true], ["c2", true], ["c3", false], ["o1", true],
    ]);
    completeCase(PATCH_PROVIDERS, "duplicate-order");
  });

  test("invalid bodies and a management token without manage scope return errors without changing state", async () => {
    const fixture = new ProviderFamilyFixture(seededConnections(), { clock: () => FIXTURE_TIME });
    fixtures.push(fixture);
    const before = fixture.state;
    const invalid = await fetch(`${fixture.endpoint}/api/providers`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${MANAGEMENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ ids: [], isActive: true }),
    });
    expect(invalid.status).toBe(400);

    const denied = await fetch(`${fixture.endpoint}/api/providers`, {
      method: "PATCH",
      headers: { authorization: "Bearer fixture-no-manage", "content-type": "application/json" },
      body: JSON.stringify({ ids: ["c1"], isActive: true }),
    });
    expect(denied.status).toBe(403);
    expect(fixture.counts.patch).toBe(1);
    const deniedList = await fetch(`${fixture.endpoint}/api/providers`, {
      headers: { authorization: "Bearer fixture-no-manage" },
    });
    expect(deniedList.status).toBe(403);
    expect(fixture.counts.get).toBe(0);
    expect(fixture.state).toEqual(before);

    const missingAuthentication = await fetch(`${fixture.endpoint}/api/providers`);
    expect(missingAuthentication.status).toBe(401);
    expect(fixture.state).toEqual(before);
    completeCase(PATCH_PROVIDERS, "validation-auth");
    completeCase(GET_PROVIDERS, "auth-denial");
  });

  test("a target snapshot drift rejects apply before PATCH dispatch", async () => {
    const fixture = new ProviderFamilyFixture(seededConnections(), { clock: () => FIXTURE_TIME });
    fixtures.push(fixture);
    const harness = createProviderAdminHarness(fixture);
    const plan = await harness.executor.plan(PATCH_PROVIDERS, {
      body: { ids: ["c1"], isActive: true },
    });
    fixture.setActive("c1", true);

    const applyError = await harness.executor.apply(plan.planId, { confirmed: true }).catch(error => error);
    expect(applyError).toMatchObject({ code: "target-drift" });
    expect(harness.patchDispatches()).toBe(0);
    expect(fixture.state.find(connection => connection.id === "c1")?.isActive).toBe(true);
    completeCase(PATCH_PROVIDERS, "target-drift");
  });

  test("an already-cancelled human apply sends no write", async () => {
    const fixture = new ProviderFamilyFixture(seededConnections(), { clock: () => FIXTURE_TIME });
    fixtures.push(fixture);
    const harness = createProviderAdminHarness(fixture);
    const plan = await harness.executor.plan(PATCH_PROVIDERS, {
      body: { ids: ["c1"], isActive: true },
    });
    const controller = new AbortController();
    controller.abort();

    const cancelError = await harness.executor.apply(plan.planId, { confirmed: true, signal: controller.signal }).catch(error => error);
    expect(cancelError).toMatchObject({ code: "plan-invalidated" });
    expect(harness.patchDispatches()).toBe(0);
    expect(fixture.state.find(connection => connection.id === "c1")?.isActive).toBe(false);
    completeCase(PATCH_PROVIDERS, "cancel");
  });

  test("a lost PATCH response is confirmed through the closed collection read without replaying the mutation", async () => {
    const fixture = new ProviderFamilyFixture(seededConnections(), { clock: () => FIXTURE_TIME });
    fixtures.push(fixture);
    const harness = createProviderAdminHarness(fixture);
    const plan = await harness.executor.plan(PATCH_PROVIDERS, {
      body: { ids: ["c1"], isActive: true },
    });
    fixture.loseNextPatchResponse();

    const result = await harness.executor.apply(plan.planId, { confirmed: true });
    expect(result.status).toBe("applied");
    expect(harness.patchDispatches()).toBe(1);
    expect(harness.reconciliationReads()).toBe(1);
    expect(harness.reconciliationMatches()).toBe(true);
    expect(fixture.state.find(connection => connection.id === "c1")?.isActive).toBe(true);
    expect(fixture.state.some(connection => connection.id === "missing")).toBe(false);
    completeCase(PATCH_PROVIDERS, "reconcile");
  });

  test("sequential update failure can return 500 after earlier IDs have committed without replay", async () => {
    const fixture = new ProviderFamilyFixture(seededConnections(), { clock: () => FIXTURE_TIME });
    fixtures.push(fixture);
    fixture.setActive("c1", true);
    const harness = createProviderAdminHarness(fixture);
    const plan = await harness.executor.plan(PATCH_PROVIDERS, {
      body: { ids: ["c1", "c2"], isActive: false },
    });
    fixture.failUpdateAt("c2");

    const applyError = await harness.executor.apply(plan.planId, { confirmed: true }).catch(error => error);
    expect(applyError).toMatchObject({ code: "dispatch-failed", status: 500 });
    expect(harness.patchDispatches()).toBe(1);
    expect(fixture.counts.updates).toBe(1);
    expect(fixture.state.map(connection => [connection.id, connection.isActive])).toEqual([
      ["c1", false], ["c2", true], ["c3", false], ["o1", true],
    ]);
    completeCase(PATCH_PROVIDERS, "partial-commit");
  });

  test("collection GET exposes the source's server error status rather than a success-shaped fallback", async () => {
    const fixture = new ProviderFamilyFixture(seededConnections());
    fixtures.push(fixture);
    const getAdapter = registry.require(GET_PROVIDERS);
    fixture.failNextList();

    const response = await callFixtureOperation(getAdapter, fixture.endpoint, MANAGEMENT_KEY, {});
    expect(response.status).toBe(500);
    expect(response.data).toEqual({ error: "Failed to fetch providers" });
    completeCase(GET_PROVIDERS, "handler-error");
  });
  test("POST creates an OpenAI connection only after human apply and projects no stored credential fields", async () => {
    const fixture = new ProviderFamilyFixture(seededConnections(), { clock: () => FIXTURE_TIME });
    fixtures.push(fixture);
    const harness = createProviderAdminHarness(fixture);

    const createBody = {
      provider: "openai",
      name: "Fixture OpenAI",
      apiKey: "created-api-key-secret",
      providerSpecificData: { region: "us-east-1", runtimeKey: "provider-runtime-secret" },
    };
    const before = publicProviderState(fixture);
    const unauthenticated = await fetch(`${fixture.endpoint}/api/providers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(createBody),
    });
    expect(unauthenticated.status).toBe(401);
    const denied = await fetch(`${fixture.endpoint}/api/providers`, {
      method: "POST",
      headers: { authorization: "Bearer fixture-no-manage", "content-type": "application/json" },
      body: JSON.stringify(createBody),
    });
    expect(denied.status).toBe(403);
    const missingApiKey = await fetch(`${fixture.endpoint}/api/providers`, {
      method: "POST",
      headers: { authorization: `Bearer ${MANAGEMENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", name: "Missing API key" }),
    });
    expect(missingApiKey.status).toBe(400);
    const invalidProvider = await fetch(`${fixture.endpoint}/api/providers`, {
      method: "POST",
      headers: { authorization: `Bearer ${MANAGEMENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ ...createBody, provider: "not-a-provider" }),
    });
    expect(invalidProvider.status).toBe(400);
    const removedOpenCodeNoAuth = await fetch(`${fixture.endpoint}/api/providers`, {
      method: "POST",
      headers: { authorization: `Bearer ${MANAGEMENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "opencode", name: "Retired no-auth entry", apiKey: "fixture-key" }),
    });
    expect(removedOpenCodeNoAuth.status).toBe(400);
    const inheritedNoAuthName = await fetch(`${fixture.endpoint}/api/providers`, {
      method: "POST",
      headers: { authorization: `Bearer ${MANAGEMENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "constructor", name: "Prototype provider", apiKey: "fixture-key" }),
    });
    expect(inheritedNoAuthName.status).toBe(400);
    const unsupportedNoCredential = await fetch(`${fixture.endpoint}/api/providers`, {
      method: "POST",
      headers: { authorization: `Bearer ${MANAGEMENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", name: "Unsupported keyless intent", apiKey: "fixture-key", allowNoCredential: true }),
    });
    expect(unsupportedNoCredential.status).toBe(400);
    const encryptedEnvelope = await fetch(`${fixture.endpoint}/api/providers`, {
      method: "POST",
      headers: { authorization: `Bearer ${MANAGEMENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "openai", name: "Encrypted envelope", apiKey: "enc:v1:stored-envelope" }),
    });
    expect(encryptedEnvelope.status).toBe(400);
    const legacyCloudflareAccountId = await fetch(`${fixture.endpoint}/api/providers`, {
      method: "POST",
      headers: { authorization: `Bearer ${MANAGEMENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ provider: "cloudflare-ai", name: "Legacy account field", apiKey: "fixture-key", accountId: "legacy-id" }),
    });
    expect(legacyCloudflareAccountId.status).toBe(400);
    expect(publicProviderState(fixture)).toEqual(before);

    const plan = await harness.executor.plan(POST_PROVIDERS, { body: createBody });
    expect(plan.risk).toBe("mutation");
    expect(plan.preview.confirmationRequired).toBe(true);
    expect(harness.postDispatches()).toBe(0);
    expect(JSON.stringify(plan.preview)).not.toContain("created-api-key-secret");
    expect(JSON.stringify(plan.preview)).not.toContain("provider-runtime-secret");
    const result = await harness.executor.apply(plan.planId, { confirmed: true });
    expect(result.status).toBe("applied");
    expect(harness.postDispatches()).toBe(1);
    const body = responseRecord(result.output);
    const connection = responseRecord(body.connection);
    expect(connection.provider).toBe("openai");
    expect(connection.name).toBe("Fixture OpenAI");
    expect(connection.isActive).toBe(false);
    expect(connection).not.toHaveProperty("apiKey");
    expect(connection).not.toHaveProperty("providerSpecificData");
    expect(JSON.stringify(result.output)).not.toContain("created-api-key-secret");
    expect(JSON.stringify(result.output)).not.toContain("provider-runtime-secret");
    expect(fixture.state).toHaveLength(5);
    expect(fixture.state.find(row => row.id === connection.id)?.apiKey).toBe("created-api-key-secret");
    const response = harness.lastResponse(POST_PROVIDERS);
    if (!response) throw new Error("POST did not record its observed HTTP response");
    observeOperation(POST_PROVIDERS, "human-create-redaction", {
      before,
      after: publicProviderState(fixture),
      result: { status: response.status, body: response.body },
    });
  });

  test("source-dependent create refinements reject invalid plans before any HTTP mutation", async () => {
    const fixture = new ProviderFamilyFixture(seededConnections(), { clock: () => FIXTURE_TIME });
    fixtures.push(fixture);
    const harness = createProviderAdminHarness(fixture);
    const before = publicProviderState(fixture);
    for (const body of [
      { provider: "openai", name: "Blank key", apiKey: " \t " },
      { provider: "opencode", name: "OpenCode no longer keyless" },
      { provider: "openai", name: "Unsupported no-credential intent", apiKey: "fixture-key", allowNoCredential: true },
      { provider: "openai", name: "Encrypted envelope", apiKey: "enc:v1:stored-envelope" },
      { provider: "google-pse-search", name: "Missing search engine", apiKey: "fixture-key", providerSpecificData: { cx: " " } },
      { provider: "ghe-copilot", name: "Unsafe enterprise URL", apiKey: "fixture-key", providerSpecificData: { gheUrl: "http://enterprise.example" } },
      { provider: "openai", name: "Invalid timeout", apiKey: "fixture-key", providerSpecificData: { timeoutMs: 86_400_001 } },
      { provider: "openai", name: "Invalid cache setting", apiKey: "fixture-key", providerSpecificData: { cache: { supportsPromptCaching: "yes" } } },
    ]) await expect(harness.executor.plan(POST_PROVIDERS, { body })).rejects.toMatchObject({ code: "invalid-input" });
    expect(harness.postDispatches()).toBe(0);
    expect(publicProviderState(fixture)).toEqual(before);
    completeCase(POST_PROVIDERS, "source-refinement-validation");
  });

  test("keyless and conditionally configured providers persist only their human-approved request", async () => {
    const fixture = new ProviderFamilyFixture(seededConnections(), { clock: () => FIXTURE_TIME });
    fixtures.push(fixture);
    const harness = createProviderAdminHarness(fixture);
    for (const body of [
      { provider: "cloudflare-playground", name: "Keyless provider", allowNoCredential: true },
      { provider: "google-pse-search", name: "Search provider", apiKey: "fixture-search-key", providerSpecificData: { cx: "fixture-engine" } },
      { provider: "ghe-copilot", name: "Enterprise provider", apiKey: "fixture-enterprise-key", providerSpecificData: { gheUrl: "https://enterprise.example" } },
      { provider: "cloudflare-ai", name: "Cloudflare AI provider", apiKey: "fixture-cloudflare-key", providerSpecificData: { accountId: "fixture-account" } },
    ]) {
      const plan = await harness.executor.plan(POST_PROVIDERS, { body });
      const result = await harness.executor.apply(plan.planId, { confirmed: true });
      expect(result.status).toBe("applied");
      const connection = responseRecord(responseRecord(result.output).connection);
      expect(connection.provider).toBe(body.provider);
      expect(connection.name).toBe(body.name);
      expect(connection.isActive).toBe(false);
      const stored = fixture.state.find(row => row.id === connection.id);
      expect(stored?.apiKey).toBe(body.apiKey);
      expect(stored?.providerSpecificData).toEqual(body.providerSpecificData);
      expect(connection).not.toHaveProperty("apiKey");
      expect(connection).not.toHaveProperty("providerSpecificData");
    }

    const conflictingNode = await fetch(`${fixture.endpoint}/api/providers`, {
      method: "POST",
      headers: { authorization: `Bearer ${MANAGEMENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({
        provider: "openai-compatible-fixture-alias",
        name: "Conflicting node alias",
        providerSpecificData: { prefix: "caller-controlled-prefix" },
      }),
    });
    expect(conflictingNode.status).toBe(400);

    const compatibleBody = {
      provider: "openai-compatible-fixture-alias",
      name: "Resolved compatible node",
      providerSpecificData: {
        baseUrl: " https://compatible.example/v1/// ",
        custom: "preserved",
      },
    };
    const compatiblePlan = await harness.executor.plan(POST_PROVIDERS, { body: compatibleBody });
    const compatibleResult = await harness.executor.apply(compatiblePlan.planId, { confirmed: true });
    expect(compatibleResult.status).toBe("applied");
    const compatibleConnection = responseRecord(responseRecord(compatibleResult.output).connection);
    const compatibleStored = fixture.state.find(row => row.id === compatibleConnection.id);
    expect(compatibleStored?.providerSpecificData).toEqual({
      baseUrl: "https://compatible.example/v1/",
      custom: "preserved",
      prefix: "fixture-openai",
      apiType: "openai",
      nodeName: "Fixture OpenAI node",
      chatPath: "/chat/completions",
      modelsPath: "/models",
      customHeaders: { "x-fixture-node": "canonical" },
    });
    expect(harness.postDispatches()).toBe(5);
    completeCase(POST_PROVIDERS, "conditional-create");
  });

  test("DELETE removes only requested existing connections after human apply and ignores missing IDs", async () => {
    const fixture = new ProviderFamilyFixture(seededConnections(), { clock: () => FIXTURE_TIME });
    fixtures.push(fixture);
    const harness = createProviderAdminHarness(fixture);
    const before = publicProviderState(fixture);
    const denied = await fetch(`${fixture.endpoint}/api/providers`, {
      method: "DELETE",
      headers: { authorization: "Bearer fixture-no-manage", "content-type": "application/json" },
      body: JSON.stringify({ ids: ["c1"] }),
    });
    expect(denied.status).toBe(403);
    expect(publicProviderState(fixture)).toEqual(before);

    const plan = await harness.executor.plan(DELETE_PROVIDERS, { body: { ids: ["c1", "missing"] } });
    expect(plan.preview.confirmationRequired).toBe(true);
    expect(harness.deleteDispatches()).toBe(0);
    const result = await harness.executor.apply(plan.planId, { confirmed: true });
    expect(result.status).toBe("applied");
    expect(result.output).toEqual({ message: "Deleted 1 connection(s)", deleted: 1 });
    expect(harness.deleteDispatches()).toBe(1);
    expect(fixture.state.map(connection => connection.id)).toEqual(["c2", "c3", "o1"]);
    const response = harness.lastResponse(DELETE_PROVIDERS);
    if (!response) throw new Error("DELETE did not record its observed HTTP response");
    observeOperation(DELETE_PROVIDERS, "human-delete", {
      before,
      after: publicProviderState(fixture),
      result: { status: response.status, body: response.body },
    });
  });

  test("DELETE rejects empty or oversized batches without deleting any connection", async () => {
    const fixture = new ProviderFamilyFixture(seededConnections(), { clock: () => FIXTURE_TIME });
    fixtures.push(fixture);
    const before = fixture.state;
    const empty = await fetch(`${fixture.endpoint}/api/providers`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${MANAGEMENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ ids: [] }),
    });
    expect(empty.status).toBe(400);
    const oversized = await fetch(`${fixture.endpoint}/api/providers`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${MANAGEMENT_KEY}`, "content-type": "application/json" },
      body: JSON.stringify({ ids: Array.from({ length: 101 }, (_, index) => `c${index}`) }),
    });
    expect(oversized.status).toBe(400);
    const nullBody = await fetch(`${fixture.endpoint}/api/providers`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${MANAGEMENT_KEY}`, "content-type": "application/json" },
      body: "null",
    });
    expect(nullBody.status).toBe(400);
    expect(fixture.state).toEqual(before);
    completeCase(DELETE_PROVIDERS, "validation");
  });


});
