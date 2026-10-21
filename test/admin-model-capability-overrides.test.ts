import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  operationEvidenceBinding,
  outcomeArtifactPath,
  testCaseSourceHash,
  testOutcomeHash,
} from "../scripts/generate-contracts.ts";
import { invokeJsonAdapter, type AdapterResponse } from "../src/admin/adapters.ts";
import { createAdminExecutor, type AdminExecutor } from "../src/admin/executor.ts";
import {
  canonicalizeJson,
  getOperation,
} from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import {
  MODEL_CAPABILITY_OVERRIDE_OPERATION_IDS,
  MODEL_CAPABILITY_OVERRIDE_SOURCE_CONTRACTS,
  ModelCapabilityOverridesFixture,
  modelCapabilityOverrideDescriptor,
  type ModelCapabilityOverrideOperationId,
  type ModelCapabilityOverridesFixtureOptions,
  type PublicModelCapabilityOverrideFixture,
} from "./fixtures/model-capability-overrides.fixture.ts";

const GET_OVERRIDES = "GET /api/model-capability-overrides";
const PATCH_OVERRIDES = "PATCH /api/model-capability-overrides";
const DELETE_OVERRIDES = "DELETE /api/model-capability-overrides";
const TEST_ID = "test/admin-model-capability-overrides.test.ts";
const PROFILE_ID = "model-capability-overrides-fixture";
const MANAGEMENT_KEY = "fixture-management-key";
const ADMIN_KEY = "fixture-admin-key";
const LIMITED_KEY = "fixture-read-key";
const OMA_READ = "oma_fixture_read_override";
const OMA_WRITE = "oma_fixture_write_override";
const SESSION_COOKIE = "auth_token=opaque-fixture-session";
const WINNER_NODE_ID = "openai-compatible-chat-00000000-0000-4000-8000-000000000001";
const SECOND_NODE_ID = "openai-compatible-chat-00000000-0000-4000-8000-000000000002";
const ANTHROPIC_NODE_ID = "anthropic-compatible-chat-00000000-0000-4000-8000-000000000003";
const RESERVED_NODE_ID = "openai-compatible-chat-00000000-0000-4000-8000-000000000004";
const NO_PREFIX_NODE_ID = "openai-compatible-chat-00000000-0000-4000-8000-000000000005";

const REQUIRED_CASES: Readonly<Record<ModelCapabilityOverrideOperationId, readonly string[]>> = {
  [GET_OVERRIDES]: ["prefix-list-order-and-uuid-suppression", "management-authorization-boundaries", "opaque-cookie-session", "auth-disabled-central-and-handler"],
  [PATCH_OVERRIDES]: ["json-body-coercion-and-context-storage", "reasoning-effort-parser-boundaries", "prefix-winner-reserved-and-raw-id-boundaries", "management-authorization-boundaries", "auth-disabled-central-and-handler", "confirmed-uncertain-single-attempt"],
  [DELETE_OVERRIDES]: ["independent-table-delete-and-absent-noop", "management-authorization-boundaries", "auth-disabled-central-and-handler", "confirmed-uncertain-single-attempt"],
};

interface SemanticObservation {
  readonly before: unknown;
  readonly after: unknown;
  readonly result: { readonly status: number; readonly body: unknown };
}

interface RawRequestOptions {
  readonly operationId: ModelCapabilityOverrideOperationId;
  readonly token?: string;
  readonly cookie?: string;
  readonly trustedLocal?: boolean;
  readonly trustedPeerOnly?: boolean;
  readonly spoofedSubject?: boolean;
  readonly origin?: string;
  readonly fetchSite?: string;
  readonly urlCredential?: string;
  readonly body?: unknown;
  readonly malformedBody?: string;
  readonly query?: { readonly target?: string; readonly key?: string };
}

interface ExecutorHarness {
  readonly executor: AdminExecutor;
  response(operationId: ModelCapabilityOverrideOperationId): AdapterResponse;
  dispatchCount(operationId: ModelCapabilityOverrideOperationId): number;
  loseNextResponse(operationId: ModelCapabilityOverrideOperationId): void;
}

const nodes = [
  { id: WINNER_NODE_ID, type: "openai-compatible", prefix: "shared" },
  { id: SECOND_NODE_ID, type: "openai-compatible", prefix: "shared" },
  { id: ANTHROPIC_NODE_ID, type: "anthropic-compatible", prefix: "shared" },
  { id: RESERVED_NODE_ID, type: "openai-compatible", prefix: "cx" },
  { id: NO_PREFIX_NODE_ID, type: "openai-compatible", prefix: null },
] as const;

function seedCapabilities() {
  return [
    { provider: WINNER_NODE_ID, modelId: "winner-model", key: "max_input_tokens", value: 4096, refreshedAt: "2026-10-18T22:00:00.000Z" },
    { provider: SECOND_NODE_ID, modelId: "hidden-loser-model", key: "max_output_tokens", value: 1024, refreshedAt: "2026-10-18T23:00:00.000Z" },
    { provider: ANTHROPIC_NODE_ID, modelId: "hidden-anthropic-model", key: "max_output_tokens", value: 2048, refreshedAt: "2026-10-18T21:00:00.000Z" },
    { provider: RESERVED_NODE_ID, modelId: "hidden-reserved-model", key: "max_output_tokens", value: 3072, refreshedAt: "2026-10-18T20:00:00.000Z" },
    { provider: NO_PREFIX_NODE_ID, modelId: "hidden-no-prefix-model", key: "max_output_tokens", value: 4096, refreshedAt: "2026-10-18T19:00:00.000Z" },
    { provider: "openai", modelId: "builtin-model", key: "max_output_tokens", value: 8192, refreshedAt: "2026-10-18T18:00:00.000Z" },
  ] as const;
}

function createFixture(options: ModelCapabilityOverridesFixtureOptions = {}): ModelCapabilityOverridesFixture {
  const fixtureOptions: ModelCapabilityOverridesFixtureOptions = {
    nodes: options.nodes ?? nodes,
    reservedPrefixes: options.reservedPrefixes ?? ["cx"],
    capabilities: options.capabilities ?? seedCapabilities(),
    contexts: options.contexts ?? [
      { provider: "openai", modelId: "builtin-model", realContext: 16384, source: "manual", refreshedAt: "2026-10-18T23:30:00.000Z" },
    ],
    apiKeys: options.apiKeys ?? [
      { key: MANAGEMENT_KEY, scopes: ["manage"] },
      { key: ADMIN_KEY, scopes: ["admin"] },
      { key: LIMITED_KEY, scopes: ["read"] },
    ],
    omaTokens: options.omaTokens ?? [
      { token: OMA_READ, scope: "read" },
      { token: OMA_WRITE, scope: "write" },
    ],
    dashboardCookies: options.dashboardCookies ?? [SESSION_COOKIE],
    ...(options.centralAuthRequired === undefined ? {} : { centralAuthRequired: options.centralAuthRequired }),
    ...(options.authRequired === undefined ? {} : { authRequired: options.authRequired }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  };
  const fixture = new ModelCapabilityOverridesFixture(fixtureOptions);
  fixtures.push(fixture);
  return fixture;
}

const registry = fixtureRegistry(MODEL_CAPABILITY_OVERRIDE_OPERATION_IDS.map(operationId => {
  const source = getOperation(operationId);
  if (!source) throw new Error(`pinned operation is absent: ${operationId}`);
  const contract = MODEL_CAPABILITY_OVERRIDE_SOURCE_CONTRACTS[operationId];
  const binding = operationEvidenceBinding(operationId, contract);
  if (binding.handlerSha256 !== source.source.sha256 || binding.handlerGitBlobSha !== source.source.gitBlobSha) {
    throw new Error(`capability override contract is not bound to pinned handler bytes: ${operationId}`);
  }
  return modelCapabilityOverrideDescriptor(operationId);
}));

const completedCases = new Map<ModelCapabilityOverrideOperationId, Set<string>>();
const observations = new Map<ModelCapabilityOverrideOperationId, SemanticObservation>();
const fixtures: ModelCapabilityOverridesFixture[] = [];
const executors: AdminExecutor[] = [];

function mark(operationId: ModelCapabilityOverrideOperationId, caseId: string): void {
  const cases = completedCases.get(operationId) ?? new Set<string>();
  cases.add(caseId);
  completedCases.set(operationId, cases);
}

function observe(
  operationId: ModelCapabilityOverrideOperationId,
  caseId: string,
  observation: SemanticObservation,
): void {
  observations.set(operationId, structuredClone(observation));
  mark(operationId, caseId);
}

function overrideRows(value: unknown): PublicModelCapabilityOverrideFixture[] {
  if (typeof value !== "object" || value === null || Array.isArray(value) || !("overrides" in value)) {
    throw new Error("loopback response omitted the overrides collection");
  }
  if (!Array.isArray(value.overrides)) throw new Error("loopback overrides value is not an array");
  return value.overrides as PublicModelCapabilityOverrideFixture[];
}

function queryInput(target: string, key: string): { query: { target: string; key: string } } {
  return { query: { target, key } };
}

async function rawRequest(fixture: ModelCapabilityOverridesFixture, options: RawRequestOptions): Promise<Response> {
  const url = new URL(`${fixture.endpoint}/api/model-capability-overrides`);
  if (options.query?.target !== undefined) url.searchParams.set("target", options.query.target);
  if (options.query?.key !== undefined) url.searchParams.set("key", options.query.key);
  if (options.urlCredential !== undefined) url.searchParams.set("token", options.urlCredential);
  const headers = new Headers();
  if (options.token !== undefined) headers.set("authorization", `Bearer ${options.token}`);
  if (options.cookie !== undefined) headers.set("cookie", options.cookie);
  if (options.trustedLocal || options.trustedPeerOnly) headers.set("x-omniroute-peer-locality", "loopback");
  if (options.spoofedSubject) {
    headers.set("x-omniroute-auth-kind", "management_key");
    headers.set("x-omniroute-auth-id", "forged-cli");
    headers.set("x-omniroute-auth-label", "local-cli-token");
    headers.set("x-omniroute-auth-scopes", "admin");
  }
  if (options.origin !== undefined) headers.set("origin", options.origin);
  if (options.fetchSite !== undefined) headers.set("sec-fetch-site", options.fetchSite);
  if (options.trustedLocal) headers.set("x-omniroute-internal-service-token", "fixture-internal-service-token");
  const body = options.malformedBody ?? (options.body === undefined ? undefined : JSON.stringify(options.body));
  return fetch(url, { method: options.operationId.slice(0, options.operationId.indexOf(" ")), headers, ...(body === undefined ? {} : { body }) });
}


function setupExecutor(fixture: ModelCapabilityOverridesFixture): ExecutorHarness {
  const responses = new Map<ModelCapabilityOverrideOperationId, AdapterResponse[]>();
  const dispatches = new Map<ModelCapabilityOverrideOperationId, number>();
  const executor = createAdminExecutor({
    registry,
    dispatch: async (request, context) => {
      const operationId = request.operationId as ModelCapabilityOverrideOperationId;
      dispatches.set(operationId, (dispatches.get(operationId) ?? 0) + 1);
      const adapter = registry.require(operationId);
      const response = await invokeJsonAdapter({
        descriptor: { ...adapter.descriptor, adapterId: adapter.adapterId },
        endpoint: context.auth.endpoint,
        ...(context.auth.credential === undefined ? {} : { credential: context.auth.credential }),
        resolvedPath: request.path,
        queryParameters: request.queryParameters,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const entries = responses.get(operationId) ?? [];
      entries.push(response);
      responses.set(operationId, entries);
      if (response.status >= 400) throw Object.assign(new Error(`fixture returned HTTP ${response.status}`), { status: response.status });
      if (lostResponses.delete(operationId)) {
        throw Object.assign(new Error("fixture committed the mutation but lost its response"), { code: "network-lost-response", uncertain: true });
      }
      return response.data;
    },
  });
  executor.setAdminBinding({ profileId: PROFILE_ID, endpoint: fixture.endpoint }, true);
  executor.bindCredential({ profileId: PROFILE_ID, endpoint: fixture.endpoint, apiKey: MANAGEMENT_KEY });
  executors.push(executor);
  return {
    executor,
    response(operationId) {
      const response = responses.get(operationId)?.at(-1);
      if (!response) throw new Error(`no loopback response was observed for ${operationId}`);
      return response;
    },
    dispatchCount: operationId => dispatches.get(operationId) ?? 0,
    loseNextResponse: operationId => { lostResponses.add(operationId); },
  };
}

const lostResponses = new Set<ModelCapabilityOverrideOperationId>();

function lastRows(harness: ExecutorHarness, operationId: ModelCapabilityOverrideOperationId): PublicModelCapabilityOverrideFixture[] {
  return overrideRows(harness.response(operationId).data);
}

function ensureJsonResponse(response: Response, expectedStatus: number): Promise<unknown> {
  expect(response.status).toBe(expectedStatus);
  expect(response.headers.get("content-type")).toContain("application/json");
  return response.json();
}

afterEach(() => {
  for (const executor of executors.splice(0)) executor.shutdown();
  for (const fixture of fixtures.splice(0)) fixture.close();
  lostResponses.clear();
});

afterAll(async () => {
  const complete = MODEL_CAPABILITY_OVERRIDE_OPERATION_IDS.every(operationId =>
    REQUIRED_CASES[operationId].every(caseId => completedCases.get(operationId)?.has(caseId)),
  );
  if (!complete) return;
  const observationDirectory = resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations");
  await mkdir(observationDirectory, { recursive: true, mode: 0o700 });
  for (const operationId of MODEL_CAPABILITY_OVERRIDE_OPERATION_IDS) {
    const observation = observations.get(operationId);
    if (!observation) return;
    const binding = operationEvidenceBinding(operationId, MODEL_CAPABILITY_OVERRIDE_SOURCE_CONTRACTS[operationId]);
    const caseSha256 = testCaseSourceHash(TEST_ID);
    const artifactPath = outcomeArtifactPath(operationId);
    const artifact = { operationId, testId: TEST_ID, caseSha256, binding, observation };
    await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson(artifact)}\n`, { mode: 0o600 });
    testOutcomeHash(operationId, TEST_ID, caseSha256, binding, MODEL_CAPABILITY_OVERRIDE_SOURCE_CONTRACTS[operationId], artifactPath);
  }
});

describe("pinned `/api/model-capability-overrides` operation semantics", () => {
  test("GET projects newest-first public prefixes and suppresses losing or UUID node identities", async () => {
    const fixture = createFixture();
    const harness = setupExecutor(fixture);
    const before = fixture.publicState();

    const result = await harness.executor.read(GET_OVERRIDES, {});
    const rows = overrideRows(result.output);
    expect(harness.response(GET_OVERRIDES).status).toBe(200);
    expect(rows.map(row => `${row.target}#${row.key}`)).toEqual([
      "openai/builtin-model#context_length",
      "shared/winner-model#max_input_tokens",
      "openai/builtin-model#max_output_tokens",
    ]);
    expect(rows.some(row => row.target.includes("hidden-loser-model"))).toBe(false);
    expect(rows.some(row => row.target.includes("hidden-anthropic-model"))).toBe(false);
    expect(rows.some(row => row.target.includes("hidden-reserved-model"))).toBe(false);
    expect(rows.some(row => row.target.includes("hidden-no-prefix-model"))).toBe(false);
    expect(rows.filter(row => row.target === "openai/builtin-model").map(row => row.key)).toContain("context_length");
    const serialized = JSON.stringify(result.output);
    for (const internalId of [WINNER_NODE_ID, SECOND_NODE_ID, ANTHROPIC_NODE_ID, RESERVED_NODE_ID, NO_PREFIX_NODE_ID]) {
      expect(serialized).not.toContain(internalId);
    }
    observe(GET_OVERRIDES, "prefix-list-order-and-uuid-suppression", {
      before,
      after: fixture.publicState(),
      result: { status: harness.response(GET_OVERRIDES).status, body: result.output },
    });
  });

  test("PATCH uses a JSON body, source coercion, stripped unknown fields, and manual context storage", async () => {
    const fixture = createFixture({ capabilities: [], contexts: [] });
    const harness = setupExecutor(fixture);
    const before = fixture.publicState();
    const plan = await harness.executor.plan(PATCH_OVERRIDES, {
      body: { target: " shared/context-model ", key: "context_length", value: "0x1000", ignored: "not persisted" },
    });

    expect(plan.risk).toBe("mutation");
    expect(plan.preview.confirmationRequired).toBe(true);
    expect(plan.targetDigest).toBeNull();
    expect(plan.preview.consequence).toContain("one attempt");
    expect(fixture.context("openai-compatible-chat-00000000-0000-4000-8000-000000000001", "context-model")).toBeUndefined();
    expect(fixture.cacheInvalidations).toBe(0);

    const applied = await harness.executor.apply(plan.planId, { confirmed: true });
    expect(applied.status).toBe("applied");
    expect(harness.dispatchCount(PATCH_OVERRIDES)).toBe(1);
    expect(fixture.context("openai-compatible-chat-00000000-0000-4000-8000-000000000001", "context-model")).toMatchObject({
      realContext: 4096,
      source: "manual",
    });
    expect(fixture.capability("openai-compatible-chat-00000000-0000-4000-8000-000000000001", "context-model", "max_input_tokens")).toBeUndefined();
    expect(fixture.cacheInvalidations).toBe(1);
    expect(lastRows(harness, PATCH_OVERRIDES).some(row => row.target === "shared/context-model" && row.key === "context_length" && row.value === 4096)).toBe(true);
    expect(fixture.lastPatchWireBody).toEqual({
      target: " shared/context-model ",
      key: "context_length",
      value: 4096,
    });

    const boolPlan = await harness.executor.plan(PATCH_OVERRIDES, {
      body: { target: "openai/boolean-coercion", key: "max_input_tokens", value: true },
    });
    await harness.executor.apply(boolPlan.planId, { confirmed: true });
    expect(fixture.capability("openai", "boolean-coercion", "max_input_tokens")?.value).toBe(1);

    const arrayPlan = await harness.executor.plan(PATCH_OVERRIDES, {
      body: { target: "openai/array-coercion", key: "max_output_tokens", value: ["7"] },
    });
    await harness.executor.apply(arrayPlan.planId, { confirmed: true });
    expect(fixture.capability("openai", "array-coercion", "max_output_tokens")?.value).toBe(7);
    expect(fixture.cacheInvalidations).toBe(3);

    for (const value of [0, -1, 1.25, null, "Infinity", "not-a-number", {}]) {
      const response = await rawRequest(fixture, {
        operationId: PATCH_OVERRIDES,
        token: MANAGEMENT_KEY,
        body: { target: "openai/rejected", key: "max_input_tokens", value },
      });
      await ensureJsonResponse(response, 400);
    }
    const malformed = await rawRequest(fixture, {
      operationId: PATCH_OVERRIDES,
      token: MANAGEMENT_KEY,
      malformedBody: "{not-json",
    });
    const malformedBody = await ensureJsonResponse(malformed, 400);
    expect(malformedBody).toEqual({ error: "Invalid JSON body" });
    expect(fixture.capability("openai", "rejected", "max_input_tokens")).toBeUndefined();

    const lastResponse = harness.response(PATCH_OVERRIDES);
    observe(PATCH_OVERRIDES, "json-body-coercion-and-context-storage", {
      before,
      after: fixture.publicState(),
      result: { status: lastResponse.status, body: lastResponse.data },
    });
  });

  test("PATCH reasoning efforts preserves source order and rejects unsupported, duplicate, and non-English separators", async () => {
    const fixture = createFixture({ capabilities: [], contexts: [] });
    const harness = setupExecutor(fixture);
    const before = fixture.publicState();
    const valid = await harness.executor.plan(PATCH_OVERRIDES, {
      body: { target: "openai/reasoning-model", key: "reasoning_efforts", value: " NONE,\u2009LOW , max ", ignored: true },
    });
    await harness.executor.apply(valid.planId, { confirmed: true });
    expect(fixture.lastPatchWireBody).toEqual({
      target: "openai/reasoning-model",
      key: "reasoning_efforts",
      value: "none,low,max",
    });
    expect(fixture.capability("openai", "reasoning-model", "reasoning_efforts")?.value).toEqual(["none", "low", "max"]);
    expect(lastRows(harness, PATCH_OVERRIDES).find(row => row.target === "openai/reasoning-model")?.value).toEqual(["none", "low", "max"]);

    for (const value of ["bogus", "low,LOW", "low，high", "low,,high", ["low", "high"]]) {
      const response = await rawRequest(fixture, {
        operationId: PATCH_OVERRIDES,
        token: MANAGEMENT_KEY,
        body: { target: "openai/reasoning-rejected", key: "reasoning_efforts", value },
      });
      await ensureJsonResponse(response, 400);
    }
    const unsupportedResponse = await rawRequest(fixture, {
      operationId: PATCH_OVERRIDES,
      token: MANAGEMENT_KEY,
      body: { target: "openai/reasoning-rejected", key: "reasoning_efforts", value: "ultra,wat" },
    });
    await ensureJsonResponse(unsupportedResponse, 400);
    const reasoningResponse = harness.response(PATCH_OVERRIDES);
    expect(fixture.capability("openai", "reasoning-rejected", "reasoning_efforts")).toBeUndefined();
    observe(PATCH_OVERRIDES, "reasoning-effort-parser-boundaries", {
      before,
      after: fixture.publicState(),
      result: { status: reasoningResponse.status, body: reasoningResponse.data },
    });
    mark(PATCH_OVERRIDES, "reasoning-effort-parser-boundaries");
  });

  test("PATCH resolves source prefix winners, maps reserved aliases, rejects raw node IDs, and accepts an unconfigured provider", async () => {
    const fixture = createFixture({ capabilities: [], contexts: [] });
    const harness = setupExecutor(fixture);
    const winnerPlan = await harness.executor.plan(PATCH_OVERRIDES, {
      body: { target: " shared/winner ", key: "max_output_tokens", value: "128" },
    });
    await harness.executor.apply(winnerPlan.planId, { confirmed: true });
    expect(fixture.capability(WINNER_NODE_ID, "winner", "max_output_tokens")?.value).toBe(128);
    expect(fixture.capability(SECOND_NODE_ID, "winner", "max_output_tokens")).toBeUndefined();
    expect(fixture.capability(ANTHROPIC_NODE_ID, "winner", "max_output_tokens")).toBeUndefined();

    const reservedPlan = await harness.executor.plan(PATCH_OVERRIDES, {
      body: { target: "cx/reserved-alias-model", key: "max_input_tokens", value: 64 },
    });
    await harness.executor.apply(reservedPlan.planId, { confirmed: true });
    expect(fixture.capability("codex", "reserved-alias-model", "max_input_tokens")?.value).toBe(64);
    expect(fixture.capability(RESERVED_NODE_ID, "reserved-alias-model", "max_input_tokens")).toBeUndefined();

    for (const target of [
      `${WINNER_NODE_ID}/raw-id-model`,
      `${SECOND_NODE_ID}/loser-id-model`,
    ]) {
      const response = await rawRequest(fixture, {
        operationId: PATCH_OVERRIDES,
        token: MANAGEMENT_KEY,
        body: { target, key: "max_input_tokens", value: 10 },
      });
      const body = await ensureJsonResponse(response, 400);
      expect(JSON.stringify(body)).toContain("Invalid or ambiguous model capability override target");
    }
    const unconfigured = await rawRequest(fixture, {
      operationId: PATCH_OVERRIDES,
      token: MANAGEMENT_KEY,
      body: { target: "unconfigured/model", key: "max_input_tokens", value: 10 },
    });
    expect(unconfigured.status).toBe(200);
    expect(fixture.capability("unconfigured", "model", "max_input_tokens")?.value).toBe(10);
    const whitespacePrefixFixture = createFixture({
      nodes: [{ id: WINNER_NODE_ID, type: "openai-compatible", prefix: " spaced " }],
      reservedPrefixes: [],
      capabilities: [],
      contexts: [],
    });
    const whitespacePrefixResponse = await rawRequest(whitespacePrefixFixture, {
      operationId: PATCH_OVERRIDES,
      token: MANAGEMENT_KEY,
      body: { target: "spaced/model", key: "max_input_tokens", value: 10 },
    });
    expect(JSON.stringify(await ensureJsonResponse(whitespacePrefixResponse, 400))).toContain("Invalid or ambiguous model capability override target");
    const listed = lastRows(harness, PATCH_OVERRIDES);
    expect(listed.some(row => row.target === "shared/winner" && row.value === 128)).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(WINNER_NODE_ID);
    mark(PATCH_OVERRIDES, "prefix-winner-reserved-and-raw-id-boundaries");
  });

  test("DELETE selects the context or capability table independently and absent rows are no-op successes", async () => {
    const fixture = createFixture({
      capabilities: [{ provider: "openai", modelId: "two-table-model", key: "max_output_tokens", value: 512, refreshedAt: "2026-10-18T12:00:00.000Z" }],
      contexts: [{ provider: "openai", modelId: "two-table-model", realContext: 8192, source: "manual", refreshedAt: "2026-10-18T13:00:00.000Z" }],
    });
    const harness = setupExecutor(fixture);
    const before = fixture.publicState();
    const invalidationsBefore = fixture.cacheInvalidations;
    const contextPlan = await harness.executor.plan(DELETE_OVERRIDES, queryInput("openai/two-table-model", "context_length"));
    expect(contextPlan.risk).toBe("mutation");
    expect(contextPlan.preview.confirmationRequired).toBe(true);
    await harness.executor.apply(contextPlan.planId, { confirmed: true });
    expect(fixture.context("openai", "two-table-model")).toBeUndefined();
    expect(fixture.capability("openai", "two-table-model", "max_output_tokens")?.value).toBe(512);
    expect(fixture.cacheInvalidations).toBe(invalidationsBefore + 1);

    const capabilityPlan = await harness.executor.plan(DELETE_OVERRIDES, queryInput("openai/two-table-model", "max_output_tokens"));
    await harness.executor.apply(capabilityPlan.planId, { confirmed: true });
    expect(fixture.capability("openai", "two-table-model", "max_output_tokens")).toBeUndefined();
    expect(fixture.cacheInvalidations).toBe(invalidationsBefore + 2);

    const afterRemoving = fixture.cacheInvalidations;
    const absentPlan = await harness.executor.plan(DELETE_OVERRIDES, queryInput("openai/absent-model", "max_output_tokens"));
    const absent = await harness.executor.apply(absentPlan.planId, { confirmed: true });
    expect(absent.status).toBe("applied");
    expect(fixture.cacheInvalidations).toBe(afterRemoving);
    expect(lastRows(harness, DELETE_OVERRIDES).some(row => row.target === "openai/two-table-model")).toBe(false);

    for (const query of [{ target: "openai/two-table-model", key: "max_token" }, { target: "", key: "max_output_tokens" }, { target: "bad-target", key: "max_output_tokens" }]) {
      const response = await rawRequest(fixture, { operationId: DELETE_OVERRIDES, token: MANAGEMENT_KEY, query });
      await ensureJsonResponse(response, 400);
    }
    const observed = harness.response(DELETE_OVERRIDES);
    observe(DELETE_OVERRIDES, "independent-table-delete-and-absent-noop", {
      before,
      after: fixture.publicState(),
      result: { status: observed.status, body: observed.data },
    });
  });

  test("uncertain PATCH and DELETE outcomes never dispatch a second mutation or invent reconciliation", async () => {
    const patchFixture = createFixture({ capabilities: [], contexts: [] });
    const patchHarness = setupExecutor(patchFixture);
    const patchPlan = await patchHarness.executor.plan(PATCH_OVERRIDES, {
      body: { target: "openai/committed-unknown", key: "context_length", value: 4096 },
    });
    patchHarness.loseNextResponse(PATCH_OVERRIDES);
    const patchResult = await patchHarness.executor.apply(patchPlan.planId, { confirmed: true });
    expect(patchResult.status).toBe("unknown");
    expect(patchResult.plan.state).toBe("unknown");
    expect(patchHarness.dispatchCount(PATCH_OVERRIDES)).toBe(1);
    expect(patchFixture.context("openai", "committed-unknown")?.realContext).toBe(4096);
    expect(patchFixture.count(GET_OVERRIDES)).toBe(0);
    await expect(patchHarness.executor.apply(patchPlan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-already-applied" });
    expect(patchHarness.dispatchCount(PATCH_OVERRIDES)).toBe(1);
    mark(PATCH_OVERRIDES, "confirmed-uncertain-single-attempt");

    const deleteFixture = createFixture({
      capabilities: [{ provider: "openai", modelId: "delete-committed-unknown", key: "max_output_tokens", value: 32, refreshedAt: "2026-10-18T00:00:00.000Z" }],
      contexts: [],
    });
    const deleteHarness = setupExecutor(deleteFixture);
    const deletePlan = await deleteHarness.executor.plan(DELETE_OVERRIDES, queryInput("openai/delete-committed-unknown", "max_output_tokens"));
    deleteHarness.loseNextResponse(DELETE_OVERRIDES);
    const deleteResult = await deleteHarness.executor.apply(deletePlan.planId, { confirmed: true });
    expect(deleteResult.status).toBe("unknown");
    expect(deleteResult.plan.state).toBe("unknown");
    expect(deleteHarness.dispatchCount(DELETE_OVERRIDES)).toBe(1);
    expect(deleteFixture.capability("openai", "delete-committed-unknown", "max_output_tokens")).toBeUndefined();
    expect(deleteFixture.count(GET_OVERRIDES)).toBe(0);
    await expect(deleteHarness.executor.apply(deletePlan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-already-applied" });
    expect(deleteHarness.dispatchCount(DELETE_OVERRIDES)).toBe(1);
    mark(DELETE_OVERRIDES, "confirmed-uncertain-single-attempt");
  });

  test("all three operations retain the management guard, status/media branches, and exact OMA minima", async () => {
    const fixture = createFixture({ capabilities: [], contexts: [] });
    for (const operationId of MODEL_CAPABILITY_OVERRIDE_OPERATION_IDS) {
      const method = operationId.slice(0, operationId.indexOf(" "));

      const body = method === "PATCH"
        ? { target: "openai/auth-matrix", key: "max_input_tokens", value: 8 }
        : undefined;
      const query = method === "DELETE" ? { target: "openai/auth-matrix", key: "max_output_tokens" } : undefined;
      const requestOptions: RawRequestOptions = {
        operationId,
        ...(body === undefined ? {} : { body }),
        ...(query === undefined ? {} : { query }),
      };
      const beforeDeniedRequest = fixture.publicState();
      const unauthenticated = await rawRequest(fixture, { operationId });
      const unauthenticatedBody = await ensureJsonResponse(unauthenticated, 401) as {
        error: { code: string; message: string; correlation_id: string };
      };
      expect(registry.require(operationId).project(unauthenticatedBody)).toMatchObject({
        error: { code: "AUTH_001", message: "Authentication required" },
      });
      expect(unauthenticatedBody.error.correlation_id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
      expect(fixture.publicState()).toEqual(beforeDeniedRequest);
      const narrowKey = await rawRequest(fixture, { ...requestOptions, token: LIMITED_KEY });
      await ensureJsonResponse(narrowKey, 403);
      const invalidKey = await rawRequest(fixture, { ...requestOptions, token: "not-a-management-key" });
      await ensureJsonResponse(invalidKey, 403);
      const invalidOma = await rawRequest(fixture, { ...requestOptions, token: "oma_expired_fixture_token" });
      await ensureJsonResponse(invalidOma, 401);
      const peerStampOnly = await rawRequest(fixture, { ...requestOptions, trustedPeerOnly: true });
      await ensureJsonResponse(peerStampOnly, 401);
      const spoofedSubject = await rawRequest(fixture, { ...requestOptions, spoofedSubject: true });
      const spoofedSubjectBody = await ensureJsonResponse(spoofedSubject, 401) as {
        error: { code: string; message: string; correlation_id: string };
      };
      expect(spoofedSubjectBody.error).toMatchObject({ code: "AUTH_001", message: "Authentication required" });
      expect(spoofedSubjectBody.error.correlation_id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
      if (operationId === GET_OVERRIDES) {
        const urlCredential = await rawRequest(fixture, { operationId, urlCredential: MANAGEMENT_KEY });
        const urlCredentialBody = await ensureJsonResponse(urlCredential, 401) as { error: { message: string } };
        expect(urlCredentialBody.error.message).toBe("Authentication required");
      }
      fixture.setAuthBackendUnavailable(true);
      const backendFailure = await rawRequest(fixture, { ...requestOptions, token: MANAGEMENT_KEY });
      await ensureJsonResponse(backendFailure, 503);
      fixture.setAuthBackendUnavailable(false);
      const trustedLocal = await rawRequest(fixture, { ...requestOptions, trustedLocal: true });
      await ensureJsonResponse(trustedLocal, 200);
      const authorized = await rawRequest(fixture, { ...requestOptions, token: MANAGEMENT_KEY });
      await ensureJsonResponse(authorized, 200);
      mark(operationId, "management-authorization-boundaries");
    }

    await ensureJsonResponse(await rawRequest(fixture, { operationId: GET_OVERRIDES, token: ADMIN_KEY }), 200);
    await ensureJsonResponse(await rawRequest(fixture, { operationId: GET_OVERRIDES, cookie: SESSION_COOKIE }), 200);
    mark(GET_OVERRIDES, "opaque-cookie-session");
    const stateBeforeCrossOriginWrite = fixture.publicState();
    const crossOriginWrite = await rawRequest(fixture, {
      operationId: PATCH_OVERRIDES,
      cookie: SESSION_COOKIE,
      origin: "https://attacker.invalid",
      fetchSite: "same-origin",
      body: { target: "openai/cross-origin", key: "max_input_tokens", value: 32 },
    });
    const crossOriginBody = await ensureJsonResponse(crossOriginWrite, 403) as { error: { code: string; message: string } };
    expect(crossOriginBody.error).toMatchObject({ code: "INVALID_ORIGIN" });
    expect(crossOriginBody.error.message).toContain("dashboard CSRF token");
    expect(fixture.publicState()).toEqual(stateBeforeCrossOriginWrite);
    await ensureJsonResponse(await rawRequest(fixture, { operationId: GET_OVERRIDES, token: OMA_READ }), 200);
    for (const operationId of [PATCH_OVERRIDES, DELETE_OVERRIDES] as const) {
      const body = operationId === PATCH_OVERRIDES
        ? { target: "openai/oma-scope", key: "max_input_tokens", value: 2 }
        : undefined;
      const query = operationId === DELETE_OVERRIDES ? { target: "openai/oma-scope", key: "max_input_tokens" } : undefined;
      const requestOptions: RawRequestOptions = {
        operationId,
        ...(body === undefined ? {} : { body }),
        ...(query === undefined ? {} : { query }),
      };
      await ensureJsonResponse(await rawRequest(fixture, { ...requestOptions, token: OMA_READ }), 403);
      await ensureJsonResponse(await rawRequest(fixture, { ...requestOptions, token: OMA_WRITE }), 200);
    }

    for (const operationId of MODEL_CAPABILITY_OVERRIDE_OPERATION_IDS) {
      for (const partialAuthDisable of [
        { centralAuthRequired: false },
        { authRequired: false },
      ] as const) {
        const partiallyDisabledFixture = createFixture({
          ...partialAuthDisable,
          capabilities: [],
          contexts: [],
        });
        const stillProtected = await rawRequest(partiallyDisabledFixture, { operationId });
        await ensureJsonResponse(stillProtected, 401);
      }
      const unauthenticatedFixture = createFixture({
        centralAuthRequired: false,
        authRequired: false,
        capabilities: [],
        contexts: [],
      });
      const input: RawRequestOptions = operationId === PATCH_OVERRIDES
        ? { operationId, body: { target: "openai/auth-disabled", key: "max_input_tokens", value: 16 } }
        : operationId === DELETE_OVERRIDES
          ? { operationId, query: { target: "openai/auth-disabled", key: "max_input_tokens" } }
          : { operationId };
      const response = await rawRequest(unauthenticatedFixture, input);
      await ensureJsonResponse(response, 200);
      mark(operationId, "auth-disabled-central-and-handler");
    }
  });

});
