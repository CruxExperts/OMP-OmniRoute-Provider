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
import { invokeJsonAdapter, type AdapterResponse, type AdminCredential } from "../src/admin/adapters.ts";
import { createAdminExecutor, type AdminExecutor } from "../src/admin/executor.ts";
import {
  canonicalizeJson,
  getOperation,
  type OperationAdapter,
  type ValidatedOperationInput,
} from "../src/admin/registry.ts";
import { mapRelationInput, projectRelationSnapshot, relationOutcomeMatches } from "../src/admin/relations.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import {
  PROVIDER_CONFIGURATION_OPERATION_IDS,
  PROVIDER_CONFIGURATION_SOURCE_CONTRACTS,
  ProviderConfigurationFixture,
  providerConfigurationDescriptor,
  type ProviderConfigurationOperationId,
} from "./fixtures/provider-configuration.fixture.ts";
import type { JsonValue } from "../src/admin/types.ts";

const TEST_ID = "test/admin-provider-configuration.test.ts";
const PROFILE_ID = "provider-configuration-fixture";
const MANAGEMENT_KEY = "fixture-management-key";
const GET_INTERCEPTION = "GET /api/providers/{id}/interception-rules";
const PUT_INTERCEPTION = "PUT /api/providers/{id}/interception-rules";
const DELETE_INTERCEPTION = "DELETE /api/providers/{id}/interception-rules";
const GET_PARAM_FILTERS = "GET /api/providers/{id}/param-filters";
const PUT_PARAM_FILTERS = "PUT /api/providers/{id}/param-filters";
const DELETE_PARAM_FILTERS = "DELETE /api/providers/{id}/param-filters";

const REQUIRED_CASES: Readonly<Record<ProviderConfigurationOperationId, readonly string[]>> = {
  [GET_INTERCEPTION]: ["provider-scope-and-empty-default", "management-auth-guard", "storage-error"],
  [PUT_INTERCEPTION]: ["trim-collision-and-replacement", "pinned-source-normalization", "management-auth-guard", "source-validation", "malformed-json", "storage-error", "private-only-target-drift", "dispatched-500-unknown"],
  [DELETE_INTERCEPTION]: ["provider-only-delete", "management-auth-guard", "ambiguous-no-replay", "storage-error", "intervening-write", "stored-empty-lost-response", "dispatched-500-unknown"],
  [GET_PARAM_FILTERS]: ["source-defaults-and-provider-scope", "management-auth-guard", "storage-error"],
  [PUT_PARAM_FILTERS]: ["trim-collision-array-order-and-defaults", "pinned-source-normalization", "management-auth-guard", "source-validation", "malformed-json", "storage-error", "dispatched-500-unknown"],
  [DELETE_PARAM_FILTERS]: ["provider-only-delete", "management-auth-guard", "ambiguous-no-replay", "storage-error", "intervening-write", "stored-empty-lost-response", "dispatched-500-unknown"],
};

type Observation = {
  before: unknown;
  after: unknown;
  result: { status: number; body: unknown };
};

type FixtureHarness = {
  executor: AdminExecutor;
  responses: Map<string, AdapterResponse[]>;
};

function buildRegistry() {
  const descriptors = PROVIDER_CONFIGURATION_OPERATION_IDS.map(operationId => {
    const source = getOperation(operationId);
    if (!source) throw new Error(`pinned operation is absent: ${operationId}`);
    const contract = PROVIDER_CONFIGURATION_SOURCE_CONTRACTS[operationId];
    const binding = operationEvidenceBinding(operationId, contract);
    if (binding.handlerSha256 !== source.source.sha256 || binding.handlerGitBlobSha !== source.source.gitBlobSha) {
      throw new Error(`provider-configuration contract source does not match the pinned descriptor: ${operationId}`);
    }
    return providerConfigurationDescriptor(operationId);
  });
  return fixtureRegistry(descriptors);
}

const registry = buildRegistry();
const completedCases = new Map<ProviderConfigurationOperationId, Set<string>>();
const observations = new Map<ProviderConfigurationOperationId, Observation>();
const fixtures: ProviderConfigurationFixture[] = [];
const executors: AdminExecutor[] = [];

function mark(operationId: ProviderConfigurationOperationId, caseId: string): void {
  const cases = completedCases.get(operationId) ?? new Set<string>();
  cases.add(caseId);
  completedCases.set(operationId, cases);
}

function observe(operationId: ProviderConfigurationOperationId, caseId: string, observation: Observation): void {
  observations.set(operationId, structuredClone(observation));
  mark(operationId, caseId);
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("fixture response is not an object");
  return value as Record<string, unknown>;
}

function safeInterceptionState(value: JsonValue): JsonValue {
  const source = object(value);
  const state: Record<string, JsonValue> = {};
  for (const field of ["interceptSearch", "interceptFetch", "fetchBackend"] as const) {
    const entry = source[field];
    if (typeof entry === "boolean" || typeof entry === "string") state[field] = entry;
  }
  state.proxyConfigured = typeof source.fetchProxyUrl === "string";
  if (typeof source.models === "object" && source.models !== null && !Array.isArray(source.models)) {
    const models: Record<string, JsonValue> = {};
    for (const [modelId, value] of Object.entries(source.models)) {
      const rule = object(value);
      const safe: Record<string, JsonValue> = {};
      for (const field of ["interceptSearch", "interceptFetch", "fetchBackend"] as const) {
        const entry = rule[field];
        if (typeof entry === "boolean" || typeof entry === "string") safe[field] = entry;
      }
      safe.proxyConfigured = typeof rule.fetchProxyUrl === "string";
      models[modelId] = safe;
    }
    state.models = models;
  }
  return state;
}

function safeParamState(value: JsonValue): JsonValue {
  return structuredClone(value);
}

function resultFor(harness: FixtureHarness, operationId: string, index = -1): AdapterResponse {
  const response = harness.responses.get(operationId)?.at(index);
  if (!response) throw new Error(`no observed HTTP response for ${operationId}`);
  return response;
}

async function callAdapter(
  adapter: OperationAdapter,
  endpoint: string,
  credential: AdminCredential,
  input: ValidatedOperationInput,
  signal?: AbortSignal,
): Promise<AdapterResponse> {
  return invokeJsonAdapter({
    descriptor: { ...adapter.descriptor, adapterId: adapter.adapterId },
    endpoint,
    credential,
    resolvedPath: adapter.buildPath(input),
    queryParameters: adapter.buildQuery(input),
    ...(input.body === undefined ? {} : { body: input.body }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function setup(fixture: ProviderConfigurationFixture): FixtureHarness {
  const responses = new Map<string, AdapterResponse[]>();
  const executor = createAdminExecutor({
    registry,
    dispatch: async (request, context) => {
      const adapter = registry.require(request.operationId);
      const response = await invokeJsonAdapter({
        descriptor: { ...adapter.descriptor, adapterId: adapter.adapterId },
        endpoint: context.auth.endpoint,
        ...(context.auth.credential === undefined ? {} : { credential: context.auth.credential }),
        resolvedPath: request.path,
        queryParameters: request.queryParameters,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      const observed = responses.get(request.operationId) ?? [];
      observed.push(response);
      responses.set(request.operationId, observed);
      if (request.operationId.startsWith("GET ")) {
        if (response.status >= 400) throw Object.assign(new Error(`fixture HTTP ${response.status}`), { status: response.status });
        return response.data;
      }
      return { kind: "response", status: response.status, body: response.data };
    },
    readTarget: async context => {
      const adapter = registry.require(context.readOperation.operationId);
      const input = mapRelationInput(context.relation.inputs, context.payload);
      const response = await callAdapter(adapter, context.auth.endpoint, context.auth.credential!, input, context.signal);
      if (response.status >= 400) throw Object.assign(new Error(`fixture target read HTTP ${response.status}`), { status: response.status });
      const privateTarget = adapter.projectTarget(response.data);
      const snapshot = projectRelationSnapshot(context.relation, privateTarget, context.payload);
      return {
        snapshot,
        digest: createHash("sha256").update(canonicalizeJson(snapshot)).digest("hex"),
      };
    },
    reconcile: async context => {
      const relation = context.operation.reconciliation;
      if (!relation) return { status: "unknown" };
      const adapter = registry.require(context.readOperation.operationId);
      const input = mapRelationInput(context.relation.inputs, context.payload);
      const response = await callAdapter(adapter, context.auth.endpoint, context.auth.credential!, input, context.signal);
      if (response.status >= 400) return { status: "unknown" };
      const privateTarget = adapter.projectTarget(response.data);
      const observed = projectRelationSnapshot(relation.targetRead, privateTarget, context.payload);
      return relationOutcomeMatches(relation, context.originalTarget, observed, context.payload)
        ? { status: "applied", output: response.data }
        : { status: "unknown" };
    },
  });
  executor.bindCredential({ profileId: PROFILE_ID, endpoint: fixture.endpoint, apiKey: MANAGEMENT_KEY });
  executors.push(executor);
  fixtures.push(fixture);
  return { executor, responses };
}

function completeAllAuthGuards(): void {
  for (const operationId of PROVIDER_CONFIGURATION_OPERATION_IDS) mark(operationId, "management-auth-guard");
}

async function directRequest(
  fixture: ProviderConfigurationFixture,
  operationId: ProviderConfigurationOperationId,
  providerId: string,
  authorization?: string,
  body?: unknown,
): Promise<Response> {
  const method = operationId.slice(0, operationId.indexOf(" "));
  const family = operationId.includes("interception-rules") ? "interception-rules" : "param-filters";
  return fetch(`${fixture.endpoint}/api/providers/${encodeURIComponent(providerId)}/${family}`, {
    method,
    headers: {
      ...(authorization === undefined ? {} : { authorization }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

async function malformedJsonRequest(
  fixture: ProviderConfigurationFixture,
  operationId: ProviderConfigurationOperationId,
  providerId: string,
): Promise<Response> {
  const family = operationId.includes("interception-rules") ? "interception-rules" : "param-filters";
  return fetch(`${fixture.endpoint}/api/providers/${encodeURIComponent(providerId)}/${family}`, {
    method: "PUT",
    headers: { authorization: ["Bearer", MANAGEMENT_KEY].join(" "), "content-type": "application/json" },
    body: "{",
  });
}

async function confirmedApply(executor: AdminExecutor, planId: string, signal?: AbortSignal) {
  return executor.apply(planId, {
    confirmed: true,
    profileId: PROFILE_ID,
    ...(signal === undefined ? {} : { signal }),
  });
}


afterEach(async () => {
  for (const executor of executors.splice(0)) executor.shutdown();
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()));
});

afterAll(async () => {
  const complete = PROVIDER_CONFIGURATION_OPERATION_IDS.every(operationId =>
    REQUIRED_CASES[operationId].every(caseId => completedCases.get(operationId)?.has(caseId))
      && completedCases.get(operationId)?.has("conditional-management-auth"),
  );
  if (!complete || PROVIDER_CONFIGURATION_OPERATION_IDS.some(operationId => !observations.has(operationId))) return;

  const observationDirectory = resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations");
  await mkdir(observationDirectory, { recursive: true, mode: 0o700 });
  for (const operationId of PROVIDER_CONFIGURATION_OPERATION_IDS) {
    const observation = observations.get(operationId);
    if (!observation) return;
    const contract = PROVIDER_CONFIGURATION_SOURCE_CONTRACTS[operationId];
    const binding = operationEvidenceBinding(operationId, contract);
    const caseSha256 = testCaseSourceHash(TEST_ID);
    const artifactPath = outcomeArtifactPath(operationId);
    const artifact = { operationId, testId: TEST_ID, caseSha256, binding, observation };
    await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson(artifact)}\n`, { mode: 0o600 });
    testOutcomeHash(operationId, TEST_ID, caseSha256, binding, PROVIDER_CONFIGURATION_SOURCE_CONTRACTS[operationId], artifactPath);
  }
});

describe("pinned provider configuration management semantics", () => {
  test("all six handlers reject a non-management credential at the real loopback boundary", async () => {
    const fixture = new ProviderConfigurationFixture();
    fixtures.push(fixture);
    for (const operationId of PROVIDER_CONFIGURATION_OPERATION_IDS) {
      const body = operationId.startsWith("PUT ") ? {} : undefined;
      const missing = await directRequest(fixture, operationId, "provider-a", undefined, body);
      expect(missing.status).toBe(401);
      const response = await directRequest(fixture, operationId, "provider-a", "Bearer fixture-runtime-key", body);
      expect(response.status).toBe(403);
    }
    completeAllAuthGuards();
  });

  test("all six configuration handlers retain the server's conditional disabled-auth branch", async () => {
    const fixture = new ProviderConfigurationFixture();
    fixtures.push(fixture);
    fixture.authRequired = false;
    for (const family of ["interception-rules", "param-filters"] as const) {
      const readId = `GET /api/providers/{id}/${family}` as ProviderConfigurationOperationId;
      const putId = `PUT /api/providers/{id}/${family}` as ProviderConfigurationOperationId;
      const deleteId = `DELETE /api/providers/{id}/${family}` as ProviderConfigurationOperationId;
      const initial = await directRequest(fixture, readId, "anonymous-provider");
      expect(initial.status).toBe(200);
      const initialBody = await initial.json();
      const body = family === "interception-rules" ? { interceptSearch: true } : { block: ["temperature"] };
      const updated = await directRequest(fixture, putId, "anonymous-provider", undefined, body);
      expect(updated.status).toBe(200);
      const read = await directRequest(fixture, readId, "anonymous-provider");
      expect(read.status).toBe(200);
      const value = object(await read.json());
      if (family === "interception-rules") expect(value.interceptSearch).toBe(true);
      else expect(value.block).toEqual(["temperature"]);
      const removed = await directRequest(fixture, deleteId, "anonymous-provider");
      expect(removed.status).toBe(200);
      const after = await directRequest(fixture, readId, "anonymous-provider");
      expect(await after.json()).toEqual(initialBody);
      for (const operationId of [readId, putId, deleteId]) mark(operationId, "conditional-management-auth");
    }
    fixture.authRequired = true;
    for (const operationId of PROVIDER_CONFIGURATION_OPERATION_IDS) {
      const body = operationId.startsWith("PUT ") ? {} : undefined;
      expect((await directRequest(fixture, operationId, "anonymous-provider", undefined, body)).status).toBe(401);
    }
  });

  test("interception routes reject padded client IDs while upstream reads stay raw and writes canonicalize", async () => {
    const fixture = new ProviderConfigurationFixture({
      interception: { "provider-a": { interceptSearch: true } },
    });
    const harness = setup(fixture);

    const paddedRead = await directRequest(fixture, GET_INTERCEPTION, " provider-a ", "Bearer fixture-management-key");
    expect(paddedRead.status).toBe(200);
    expect(await paddedRead.json()).toEqual({});
    const paddedPut = await directRequest(fixture, PUT_INTERCEPTION, " provider-a ", "Bearer fixture-management-key", {
      interceptSearch: false,
    });
    expect(paddedPut.status).toBe(200);
    expect(fixture.hasStoredConfiguration("interception-rules", "provider-a")).toBe(true);
    expect(fixture.hasStoredConfiguration("interception-rules", " provider-a ")).toBe(false);
    expect(fixture.interception("provider-a")).toEqual({ interceptSearch: false });

    const countsBeforeClientRejection = PROVIDER_CONFIGURATION_OPERATION_IDS.map(operationId => fixture.count(operationId));
    await expect(harness.executor.read(GET_INTERCEPTION, { path: { id: " provider-a " } }))
      .rejects.toMatchObject({ code: "invalid-input" });
    await expect(harness.executor.plan(PUT_INTERCEPTION, {
      path: { id: " provider-a " },
      body: { interceptSearch: true },
    })).rejects.toMatchObject({ code: "invalid-input" });
    await expect(harness.executor.plan(DELETE_INTERCEPTION, { path: { id: " provider-a " } }))
      .rejects.toMatchObject({ code: "invalid-input" });
    expect(PROVIDER_CONFIGURATION_OPERATION_IDS.map(operationId => fixture.count(operationId)))
      .toEqual(countsBeforeClientRejection);
    expect(harness.responses.size).toBe(0);
  });

  test("both upstream readers hide persisted __proto__ rows and every client operation rejects that identifier", async () => {
    const interceptionSeed = JSON.parse('{"__proto__":{"interceptSearch":true}}') as Record<string, JsonValue>;
    const paramFilterSeed = JSON.parse('{"__proto__":{"block":["temperature"],"allow":[],"autoLearn":true}}') as Record<string, JsonValue>;
    const fixture = new ProviderConfigurationFixture({
      interception: interceptionSeed,
      paramFilters: paramFilterSeed,
    });
    const harness = setup(fixture);

    expect(fixture.hasStoredConfiguration("interception-rules", "__proto__")).toBe(true);
    expect(fixture.hasStoredConfiguration("param-filters", "__proto__")).toBe(true);
    const interception = await directRequest(fixture, GET_INTERCEPTION, "__proto__", "Bearer fixture-management-key");
    expect(interception.status).toBe(200);
    expect(await interception.json()).toEqual({});
    const paramFilters = await directRequest(fixture, GET_PARAM_FILTERS, "__proto__", "Bearer fixture-management-key");
    expect(paramFilters.status).toBe(200);
    expect(await paramFilters.json()).toEqual({ block: [], allow: [], autoLearn: false });

    const countsBeforeClientRejection = PROVIDER_CONFIGURATION_OPERATION_IDS.map(operationId => fixture.count(operationId));
    for (const operationId of PROVIDER_CONFIGURATION_OPERATION_IDS) {
      const method = operationId.slice(0, operationId.indexOf(" "));
      const input = {
        path: { id: "__proto__" },
        ...(method === "PUT" ? { body: operationId.includes("interception-rules") ? { interceptSearch: true } : { block: ["temperature"] } } : {}),
      };
      if (method === "GET") {
        await expect(harness.executor.read(operationId, input)).rejects.toMatchObject({ code: "invalid-input" });
      } else {
        await expect(harness.executor.plan(operationId, input)).rejects.toMatchObject({ code: "invalid-input" });
      }
    }
    expect(PROVIDER_CONFIGURATION_OPERATION_IDS.map(operationId => fixture.count(operationId)))
      .toEqual(countsBeforeClientRejection);
    expect(harness.responses.size).toBe(0);
  });

  test("param-filter provider identifiers retain upstream raw whitespace semantics", async () => {
    const fixture = new ProviderConfigurationFixture();
    const harness = setup(fixture);
    const rawId = " provider-a ";

    const stored = await directRequest(fixture, PUT_PARAM_FILTERS, rawId, "Bearer fixture-management-key", {
      block: ["temperature"],
    });
    expect(stored.status).toBe(200);
    expect(fixture.hasStoredConfiguration("param-filters", rawId)).toBe(true);
    expect(fixture.hasStoredConfiguration("param-filters", "provider-a")).toBe(false);
    const read = await harness.executor.read(GET_PARAM_FILTERS, { path: { id: rawId } });
    expect(read.output).toEqual({ block: ["temperature"], allow: [], autoLearn: false });
    const canonicalRead = await directRequest(fixture, GET_PARAM_FILTERS, "provider-a", "Bearer fixture-management-key");
    expect(canonicalRead.status).toBe(200);
    expect(await canonicalRead.json()).toEqual({ block: [], allow: [], autoLearn: false });
  });

  test("GET interception rules preserves provider-local settings and the absent-row empty response", async () => {
    const fixture = new ProviderConfigurationFixture({
      interception: {
        "provider-a": {
          interceptSearch: true,
          interceptFetch: false,
          fetchBackend: "jina",
          fetchProxyUrl: "https://proxy.example/private-path",
          models: {
            "model/one": { interceptSearch: false, fetchProxyUrl: "https://proxy.example/model-path" },
            ignored: {},
          },
        },
        "provider-b": { interceptSearch: false },
      },
    });
    const harness = setup(fixture);
    const before = {
      configured: safeInterceptionState(fixture.interception("provider-a")),
      otherProvider: safeInterceptionState(fixture.interception("provider-b")),
      missingProvider: safeInterceptionState(fixture.interception("provider-missing")),
    };

    const configured = await harness.executor.read(GET_INTERCEPTION, { path: { id: "provider-a" } });
    const configuredOutput = object(configured.output);
    expect(configuredOutput.interceptSearch).toBe(true);
    expect(configuredOutput.interceptFetch).toBe(false);
    expect(configuredOutput.fetchBackend).toBe("jina");
    expect(configuredOutput).not.toHaveProperty("fetchProxyUrl");
    expect(JSON.stringify(configured.output)).not.toContain("private-path");
    expect(JSON.stringify(configured.output)).not.toContain("model-path");

    const missing = await harness.executor.read(GET_INTERCEPTION, { path: { id: "provider-missing" } });
    expect(missing.output).toEqual({});
    expect(fixture.interception("provider-b")).toEqual({ interceptSearch: false });

    fixture.failNextRead();
    const failed = directRequest(fixture, GET_INTERCEPTION, "provider-a", "Bearer fixture-management-key");
    expect((await failed).status).toBe(500);
    const after = {
      configured: safeInterceptionState(fixture.interception("provider-a")),
      otherProvider: safeInterceptionState(fixture.interception("provider-b")),
      missingProvider: safeInterceptionState(fixture.interception("provider-missing")),
    };
    expect(after).toEqual(before);
    const response = resultFor(harness, GET_INTERCEPTION, 0);
    observe(GET_INTERCEPTION, "provider-scope-and-empty-default", {
      before,
      after,
      result: { status: response.status, body: configured.output },
    });
    mark(GET_INTERCEPTION, "storage-error");
  });

  test("PUT interception rules trims source fields, resolves normalized-key collisions last-write-wins, and replaces only that provider", async () => {
    const fixture = new ProviderConfigurationFixture({
      interception: {
        "provider-a": {
          interceptFetch: false,
          fetchBackend: "tavily",
          fetchProxyUrl: "https://proxy.example/old",
          models: { old: { fetchProxyUrl: "https://proxy.example/old-model-secret" } },
        },
        "provider-b": { interceptSearch: true },
      },
    });
    const harness = setup(fixture);
    const before = {
      providerA: safeInterceptionState(fixture.interception("provider-a")),
      providerB: safeInterceptionState(fixture.interception("provider-b")),
    };
    const plan = await harness.executor.plan(PUT_INTERCEPTION, {
      path: { id: "provider-a" },
      body: {
        interceptSearch: true,
        fetchBackend: "firecrawl",
        fetchProxyUrl: " https://proxy.example/new-route ",
        models: {
          " model/one ": { interceptFetch: false, fetchProxyUrl: " https://proxy.example/model-route " },
          "model/one": { interceptSearch: false },
          empty: {},
        },
      },
    });
    expect(plan.preview.visibilityLimits?.join(" ")).toContain("process-local cache");
    expect(plan.preview.visibilityLimits?.join(" ")).toContain("no atomic conditional write");
    expect(JSON.stringify(plan.preview.payload)).not.toContain("new-route");
    expect(JSON.stringify(plan.preview.projectedTarget)).not.toContain("proxy.example/old");
    expect(JSON.stringify(plan.preview.projectedTarget)).not.toContain("old-model-secret");
    const applied = await confirmedApply(harness.executor, plan.planId);
    expect(applied.status).toBe("applied");
    expect(fixture.interception("provider-a")).toEqual({
      interceptSearch: true,
      fetchBackend: "firecrawl",
      fetchProxyUrl: "https://proxy.example/new-route",
      models: { "model/one": { interceptSearch: false } },
    });
    expect(fixture.interception("provider-b")).toEqual({ interceptSearch: true });
    expect(fixture.count(PUT_INTERCEPTION)).toBe(1);

    const malformed = await malformedJsonRequest(fixture, PUT_INTERCEPTION, "provider-a");
    expect(malformed.status).toBe(400);
    expect(fixture.interception("provider-a")).toEqual({
      interceptSearch: true,
      fetchBackend: "firecrawl",
      fetchProxyUrl: "https://proxy.example/new-route",
      models: { "model/one": { interceptSearch: false } },
    });
    mark(PUT_INTERCEPTION, "malformed-json");

    const sourceNormalized = await directRequest(fixture, PUT_INTERCEPTION, "provider-source", "Bearer fixture-management-key", {
      fetchProxyUrl: " https://proxy.example/source-trimmed ",
      models: {
        " model/source ": { interceptFetch: false, ignoredRuleField: "stripped" },
        "model/source": { interceptSearch: true },
        empty: {},
      },
      ignoredTopLevelField: "stripped",
    });
    expect(sourceNormalized.status).toBe(200);
    expect(fixture.interception("provider-source")).toEqual({
      fetchProxyUrl: "https://proxy.example/source-trimmed",
      models: { "model/source": { interceptSearch: true } },
    });
    mark(PUT_INTERCEPTION, "pinned-source-normalization");

    const invalid = await directRequest(fixture, PUT_INTERCEPTION, "provider-a", "Bearer fixture-management-key", { fetchBackend: "unknown" });
    expect(invalid.status).toBe(400);
    const afterApply = safeInterceptionState(fixture.interception("provider-a"));
    fixture.failNextWrite();
    const failedStorage = await directRequest(fixture, PUT_INTERCEPTION, "provider-a", "Bearer fixture-management-key", {});
    expect(failedStorage.status).toBe(500);
    expect(await failedStorage.text()).not.toContain("access_token=fixture");
    expect(safeInterceptionState(fixture.interception("provider-a"))).toEqual(afterApply);
    const after = {
      providerA: safeInterceptionState(fixture.interception("provider-a")),
      providerB: safeInterceptionState(fixture.interception("provider-b")),
    };
    expect(after.providerB).toEqual(before.providerB);
    expect(after.providerA).toEqual(afterApply);
    const response = resultFor(harness, PUT_INTERCEPTION, 0);
    observe(PUT_INTERCEPTION, "trim-collision-and-replacement", {
      before,
      after,
      result: { status: response.status, body: applied.output },
    });
    mark(PUT_INTERCEPTION, "source-validation");
    mark(PUT_INTERCEPTION, "storage-error");
  });

  test("a private-only proxy change invalidates approval despite identical public target projections", async () => {
    const fixture = new ProviderConfigurationFixture({
      interception: { "provider-a": { interceptSearch: true, fetchProxyUrl: "https://proxy.example/original" } },
    });
    const harness = setup(fixture);
    const path = { id: "provider-a" };
    const before = await harness.executor.read(GET_INTERCEPTION, { path });
    const plan = await harness.executor.plan(PUT_INTERCEPTION, { path, body: { interceptSearch: false } });
    const sourceStrip = await directRequest(fixture, PUT_INTERCEPTION, "provider-a", "Bearer fixture-management-key", {
      interceptSearch: true,
      fetchProxyUrl: "https://proxy.example/original",
      ignoredUpstreamField: "must be stripped",
      models: { "empty-after-strip": { ignoredRuleField: "must also be stripped" } },
    });
    expect(sourceStrip.status).toBe(200);
    expect(fixture.interception("provider-a")).toEqual({
      interceptSearch: true,
      fetchProxyUrl: "https://proxy.example/original",
    });
    const external = await directRequest(fixture, PUT_INTERCEPTION, "provider-a", "Bearer fixture-management-key", {
      interceptSearch: true,
      fetchProxyUrl: "https://proxy.example/replaced",
    });
    expect(external.status).toBe(200);
    const after = await harness.executor.read(GET_INTERCEPTION, { path });
    expect(after.output).toEqual(before.output);
    expect(JSON.stringify(after.output)).not.toContain("proxy.example");
    const writesBeforeApply = fixture.count(PUT_INTERCEPTION);
    await expect(confirmedApply(harness.executor, plan.planId)).rejects.toMatchObject({ code: "target-drift" });
    expect(fixture.count(PUT_INTERCEPTION)).toBe(writesBeforeApply);
    expect(fixture.interception("provider-a")).toEqual({
      interceptSearch: true,
      fetchProxyUrl: "https://proxy.example/replaced",
    });
    mark(PUT_INTERCEPTION, "private-only-target-drift");
  });

  test("DELETE interception rules affects one provider and never replays an ambiguous dispatch", async () => {
    const fixture = new ProviderConfigurationFixture({
      interception: {
        "provider-a": { interceptSearch: true, fetchProxyUrl: "https://proxy.example/a" },
        "provider-b": { interceptFetch: true },
      },
    });
    const harness = setup(fixture);
    const before = {
      providerA: safeInterceptionState(fixture.interception("provider-a")),
      providerB: safeInterceptionState(fixture.interception("provider-b")),
    };
    fixture.failNextWrite();
    const failedStorage = await directRequest(fixture, DELETE_INTERCEPTION, "provider-a", "Bearer fixture-management-key");
    expect(failedStorage.status).toBe(500);
    expect(await failedStorage.text()).not.toContain("access_token=fixture");
    expect(safeInterceptionState(fixture.interception("provider-a"))).toEqual(before.providerA);
    mark(DELETE_INTERCEPTION, "storage-error");

    const plan = await harness.executor.plan(DELETE_INTERCEPTION, { path: { id: "provider-a" } });
    const applied = await confirmedApply(harness.executor, plan.planId);
    expect(applied.status).toBe("applied");
    expect(fixture.interception("provider-a")).toEqual({});
    expect(fixture.interception("provider-b")).toEqual({ interceptFetch: true });
    const response = resultFor(harness, DELETE_INTERCEPTION);
    observe(DELETE_INTERCEPTION, "provider-only-delete", {
      before,
      after: {
        providerA: safeInterceptionState(fixture.interception("provider-a")),
        providerB: safeInterceptionState(fixture.interception("provider-b")),
      },
      result: { status: response.status, body: applied.output },
    });

    const ambiguousDispatchesBefore = fixture.count(DELETE_INTERCEPTION);
    const ambiguousPlan = await harness.executor.plan(DELETE_INTERCEPTION, { path: { id: "provider-b" } });
    const hold = fixture.holdNextDeleteResponse();
    const controller = new AbortController();
    const pending = confirmedApply(harness.executor, ambiguousPlan.planId, controller.signal);
    await hold.received;
    controller.abort();
    const ambiguous = await pending;
    hold.release();
    expect(ambiguous.status).toBe("unknown");
    expect(fixture.count(DELETE_INTERCEPTION) - ambiguousDispatchesBefore).toBe(1);
    expect(fixture.interception("provider-b")).toEqual({});
    mark(DELETE_INTERCEPTION, "ambiguous-no-replay");
  });

  test("GET param filters exposes source defaults and does not mix provider rows", async () => {
    const fixture = new ProviderConfigurationFixture({
      paramFilters: {
        "provider-a": { block: [" temperature "], allow: [" safe-param"], autoLearn: true, models: { "model/one": { block: [" top_p "] }, empty: {} } },
        "provider-b": { block: ["frequency_penalty"], allow: [], autoLearn: false },
      },
    });

    const harness = setup(fixture);
    const before = {
      providerA: safeParamState(fixture.paramFilters("provider-a")),
      providerB: safeParamState(fixture.paramFilters("provider-b")),
      missingProvider: safeParamState(fixture.paramFilters("provider-missing")),
    };
    const configured = await harness.executor.read(GET_PARAM_FILTERS, { path: { id: "provider-a" } });
    expect(configured.output).toEqual({
      block: [" temperature "],
      allow: [" safe-param"],
      autoLearn: true,
      models: { "model/one": { block: [" top_p "] } },
    });
    const missing = await harness.executor.read(GET_PARAM_FILTERS, { path: { id: "provider-missing" } });
    expect(missing.output).toEqual({ block: [], allow: [], autoLearn: false });
    expect(fixture.paramFilters("provider-b")).toEqual({ block: ["frequency_penalty"], allow: [], autoLearn: false });

    fixture.failNextRead();
    const failed = await directRequest(fixture, GET_PARAM_FILTERS, "provider-a", "Bearer fixture-management-key");
    expect(failed.status).toBe(500);
    expect(await failed.text()).not.toContain("fixture_saved_key_value");
    const after = {
      providerA: safeParamState(fixture.paramFilters("provider-a")),
      providerB: safeParamState(fixture.paramFilters("provider-b")),
      missingProvider: safeParamState(fixture.paramFilters("provider-missing")),
    };
    expect(after).toEqual(before);
    const response = resultFor(harness, GET_PARAM_FILTERS, 0);
    observe(GET_PARAM_FILTERS, "source-defaults-and-provider-scope", {
      before,
      after,
      result: { status: response.status, body: configured.output },
    });
    mark(GET_PARAM_FILTERS, "storage-error");
  });

  test("PUT param filters trims list values and keys, preserves array order/duplicates, and applies source defaults", async () => {
    const fixture = new ProviderConfigurationFixture({
      paramFilters: {
        "provider-a": { block: ["old"], allow: ["kept"], autoLearn: true },
        "provider-b": { block: ["unrelated"], allow: [], autoLearn: false },
      },
    });
    const harness = setup(fixture);
    const before = {
      providerA: safeParamState(fixture.paramFilters("provider-a")),
      providerB: safeParamState(fixture.paramFilters("provider-b")),
    };
    const plan = await harness.executor.plan(PUT_PARAM_FILTERS, {
      path: { id: "provider-a" },
      body: {
        block: [" temperature ", "top_p", "temperature"],
        models: {
          " model/one ": { block: [" max_tokens ", "top_p"] },
          "model/one": { allow: [" stop "] },
          empty: {},
        },
      },
    });
    const applied = await confirmedApply(harness.executor, plan.planId);
    expect(applied.status).toBe("applied");
    expect(fixture.paramFilters("provider-a")).toEqual({
      block: ["temperature", "top_p", "temperature"],
      allow: [],
      autoLearn: false,
      models: { "model/one": { allow: ["stop"] } },
    });
    expect(fixture.paramFilters("provider-b")).toEqual(before.providerB);
    expect(fixture.count(PUT_PARAM_FILTERS)).toBe(1);

    const malformed = await malformedJsonRequest(fixture, PUT_PARAM_FILTERS, "provider-a");
    expect(malformed.status).toBe(400);
    expect(fixture.paramFilters("provider-a")).toEqual({
      block: ["temperature", "top_p", "temperature"],
      allow: [],
      autoLearn: false,
      models: { "model/one": { allow: ["stop"] } },
    });
    mark(PUT_PARAM_FILTERS, "malformed-json");

    const sourceNormalized = await directRequest(fixture, PUT_PARAM_FILTERS, "provider-source", "Bearer fixture-management-key", {
      block: [" source_name ", "top_p", "source_name "],
      models: {
        " model/source ": { block: ["temperature"], ignoredRuleField: "stripped" },
        "model/source": { allow: [" stop "] },
        empty: {},
      },
      ignoredTopLevelField: "stripped",
    });
    expect(sourceNormalized.status).toBe(200);
    expect(fixture.paramFilters("provider-source")).toEqual({
      block: ["source_name", "top_p", "source_name"],
      allow: [],
      autoLearn: false,
      models: { "model/source": { allow: ["stop"] } },
    });
    mark(PUT_PARAM_FILTERS, "pinned-source-normalization");

    const invalid = await directRequest(fixture, PUT_PARAM_FILTERS, "provider-a", "Bearer fixture-management-key", { block: ["  "] });
    expect(invalid.status).toBe(400);
    const afterApply = safeParamState(fixture.paramFilters("provider-a"));
    fixture.failNextWrite();
    const failedStorage = await directRequest(fixture, PUT_PARAM_FILTERS, "provider-a", "Bearer fixture-management-key", {});
    expect(failedStorage.status).toBe(500);
    expect(await failedStorage.text()).not.toContain("access_token=fixture");
    expect(safeParamState(fixture.paramFilters("provider-a"))).toEqual(afterApply);
    const after = {
      providerA: safeParamState(fixture.paramFilters("provider-a")),
      providerB: safeParamState(fixture.paramFilters("provider-b")),
    };
    expect(after.providerB).toEqual(before.providerB);
    expect(after.providerA).toEqual(afterApply);
    const response = resultFor(harness, PUT_PARAM_FILTERS, 0);
    observe(PUT_PARAM_FILTERS, "trim-collision-array-order-and-defaults", {
      before,
      after,
      result: { status: response.status, body: applied.output },
    });
    mark(PUT_PARAM_FILTERS, "source-validation");
    mark(PUT_PARAM_FILTERS, "storage-error");
  });

  test("DELETE param filters removes only the selected provider and never replays an ambiguous dispatch", async () => {
    const fixture = new ProviderConfigurationFixture({
      paramFilters: {
        "provider-a": { block: ["temperature"], allow: [], autoLearn: false },
        "provider-b": { block: [], allow: ["safe-param"], autoLearn: true },
      },
    });
    const harness = setup(fixture);
    const before = {
      providerA: safeParamState(fixture.paramFilters("provider-a")),
      providerB: safeParamState(fixture.paramFilters("provider-b")),
    };
    fixture.failNextWrite();
    const failedStorage = await directRequest(fixture, DELETE_PARAM_FILTERS, "provider-a", "Bearer fixture-management-key");
    expect(failedStorage.status).toBe(500);
    expect(await failedStorage.text()).not.toContain("access_token=fixture");
    expect(safeParamState(fixture.paramFilters("provider-a"))).toEqual(before.providerA);
    mark(DELETE_PARAM_FILTERS, "storage-error");

    const plan = await harness.executor.plan(DELETE_PARAM_FILTERS, { path: { id: "provider-a" } });
    const applied = await confirmedApply(harness.executor, plan.planId);
    expect(applied.status).toBe("applied");
    expect(fixture.paramFilters("provider-a")).toEqual({ block: [], allow: [], autoLearn: false });
    expect(fixture.paramFilters("provider-b")).toEqual(before.providerB);
    const response = resultFor(harness, DELETE_PARAM_FILTERS);
    observe(DELETE_PARAM_FILTERS, "provider-only-delete", {
      before,
      after: {
        providerA: safeParamState(fixture.paramFilters("provider-a")),
        providerB: safeParamState(fixture.paramFilters("provider-b")),
      },
      result: { status: response.status, body: applied.output },
    });

    const ambiguousDispatchesBefore = fixture.count(DELETE_PARAM_FILTERS);
    const ambiguousPlan = await harness.executor.plan(DELETE_PARAM_FILTERS, { path: { id: "provider-b" } });
    const hold = fixture.holdNextDeleteResponse();
    const controller = new AbortController();
    const pending = confirmedApply(harness.executor, ambiguousPlan.planId, controller.signal);
    await hold.received;
    controller.abort();
    const ambiguous = await pending;
    hold.release();
    expect(ambiguous.status).toBe("unknown");
    expect(fixture.count(DELETE_PARAM_FILTERS) - ambiguousDispatchesBefore).toBe(1);
    expect(fixture.paramFilters("provider-b")).toEqual({ block: [], allow: [], autoLearn: false });
    mark(DELETE_PARAM_FILTERS, "ambiguous-no-replay");
  });

  test("an intervening source write invalidates prepared DELETE in both families before dispatch", async () => {
    const fixture = new ProviderConfigurationFixture({
      interception: { "provider-a": { interceptSearch: true, fetchProxyUrl: "https://proxy.example/original" } },
      paramFilters: { "provider-b": { block: ["old"], allow: [], autoLearn: false } },
    });
    const harness = setup(fixture);
    const interceptionPlan = await harness.executor.plan(DELETE_INTERCEPTION, { path: { id: "provider-a" } });
    const paramPlan = await harness.executor.plan(DELETE_PARAM_FILTERS, { path: { id: "provider-b" } });
    const publicBefore = await harness.executor.read(GET_INTERCEPTION, { path: { id: "provider-a" } });

    const changedInterception = await directRequest(fixture, PUT_INTERCEPTION, "provider-a", "Bearer fixture-management-key", {
      interceptSearch: true,
      fetchProxyUrl: "https://proxy.example/private-replacement",
    });
    const changedFilters = await directRequest(fixture, PUT_PARAM_FILTERS, "provider-b", "Bearer fixture-management-key", {
      block: ["new"],
    });
    expect(changedInterception.status).toBe(200);
    expect(changedFilters.status).toBe(200);
    const publicAfter = await harness.executor.read(GET_INTERCEPTION, { path: { id: "provider-a" } });
    expect(publicAfter.output).toEqual(publicBefore.output);
    const deletesBefore = [fixture.count(DELETE_INTERCEPTION), fixture.count(DELETE_PARAM_FILTERS)];

    await expect(confirmedApply(harness.executor, interceptionPlan.planId)).rejects.toMatchObject({ code: "target-drift" });
    await expect(confirmedApply(harness.executor, paramPlan.planId)).rejects.toMatchObject({ code: "target-drift" });
    expect([fixture.count(DELETE_INTERCEPTION), fixture.count(DELETE_PARAM_FILTERS)]).toEqual(deletesBefore);
    expect(fixture.interception("provider-a")).toEqual({
      interceptSearch: true,
      fetchProxyUrl: "https://proxy.example/private-replacement",
    });
    expect(fixture.paramFilters("provider-b")).toEqual({ block: ["new"], allow: [], autoLearn: false });
    mark(DELETE_INTERCEPTION, "intervening-write");
    mark(DELETE_PARAM_FILTERS, "intervening-write");
  });

  test("out-of-band SQLite changes remain hidden by both pinned GET caches", async () => {
    const fixture = new ProviderConfigurationFixture({
      interception: { "provider-a": { interceptSearch: true } },
      paramFilters: { "provider-b": { block: ["old"], allow: [], autoLearn: false } },
    });
    const harness = setup(fixture);
    const interceptionBefore = await harness.executor.read(GET_INTERCEPTION, { path: { id: "provider-a" } });
    const filtersBefore = await harness.executor.read(GET_PARAM_FILTERS, { path: { id: "provider-b" } });
    fixture.writeConfigurationOutsideSourceCache("interception-rules", "provider-a", { interceptSearch: false });
    fixture.writeConfigurationOutsideSourceCache("param-filters", "provider-b", { block: ["new"], allow: [], autoLearn: false });

    const interceptionAfter = await harness.executor.read(GET_INTERCEPTION, { path: { id: "provider-a" } });
    const filtersAfter = await harness.executor.read(GET_PARAM_FILTERS, { path: { id: "provider-b" } });
    expect(interceptionAfter.output).toEqual(interceptionBefore.output);
    expect(filtersAfter.output).toEqual(filtersBefore.output);
    expect(interceptionAfter.output).toEqual({ interceptSearch: true });
    expect(filtersAfter.output).toEqual({ block: ["old"], allow: [], autoLearn: false });
  });

  test("stored empty rows look absent through GET, so lost DELETE responses remain unknown without replay", async () => {
    const fixture = new ProviderConfigurationFixture({
      interception: { "provider-a": {} },
      paramFilters: { "provider-b": { block: [], allow: [], autoLearn: false } },
    });
    const harness = setup(fixture);
    for (const [deleteId, readId, family, providerId] of [
      [DELETE_INTERCEPTION, GET_INTERCEPTION, "interception-rules", "provider-a"],
      [DELETE_PARAM_FILTERS, GET_PARAM_FILTERS, "param-filters", "provider-b"],
    ] as const) {
      expect(fixture.hasStoredConfiguration(family, providerId)).toBe(true);
      const stored = await harness.executor.read(readId, { path: { id: providerId } });
      const absent = await harness.executor.read(readId, { path: { id: "provider-missing" } });
      expect(stored.output).toEqual(absent.output);
      const plan = await harness.executor.plan(deleteId, { path: { id: providerId } });
      const before = fixture.count(deleteId);
      const hold = fixture.holdNextDeleteResponse();
      const controller = new AbortController();
      const pending = confirmedApply(harness.executor, plan.planId, controller.signal);
      await hold.received;
      controller.abort();
      const result = await pending;
      hold.release();
      expect(result.status).toBe("unknown");
      expect(fixture.count(deleteId) - before).toBe(1);
      expect(fixture.hasStoredConfiguration(family, providerId)).toBe(false);
      mark(deleteId, "stored-empty-lost-response");
    }
  });

  test("a source 500 after dispatch leaves each configuration mutation unknown", async () => {
    const fixture = new ProviderConfigurationFixture({
      interception: { "provider-a": { interceptSearch: true } },
      paramFilters: { "provider-b": { block: ["old"], allow: [], autoLearn: false } },
    });
    const harness = setup(fixture);
    const beforeInterception = fixture.interception("provider-a");
    const beforeFilters = fixture.paramFilters("provider-b");
    for (const [operationId, providerId, body] of [
      [PUT_INTERCEPTION, "provider-a", { interceptSearch: false }],
      [DELETE_INTERCEPTION, "provider-a", undefined],
      [PUT_PARAM_FILTERS, "provider-b", { block: ["new"] }],
      [DELETE_PARAM_FILTERS, "provider-b", undefined],
    ] as const) {
      const plan = await harness.executor.plan(operationId, {
        path: { id: providerId },
        ...(body === undefined ? {} : { body }),
      });
      const beforeCount = fixture.count(operationId);
      fixture.failNextWrite();
      const result = await confirmedApply(harness.executor, plan.planId);
      expect(result.status).toBe("unknown");
      expect(fixture.count(operationId) - beforeCount).toBe(1);
      expect(fixture.interception("provider-a")).toEqual(beforeInterception);
      expect(fixture.paramFilters("provider-b")).toEqual(beforeFilters);
      mark(operationId, "dispatched-500-unknown");
    }
  });
});
