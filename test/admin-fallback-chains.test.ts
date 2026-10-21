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
import { invokeJsonAdapter } from "../src/admin/adapters.ts";
import { createAdminExecutor, type AdminExecutor } from "../src/admin/executor.ts";
import { canonicalizeJson, type OperationAdapter } from "../src/admin/registry.ts";
import { mapRelationInput } from "../src/admin/relations.ts";
import type { JsonValue } from "../src/admin/types.ts";
import {
  FALLBACK_CHAIN_DELETE,
  FALLBACK_CHAIN_GET,
  FALLBACK_CHAIN_POST,
  FALLBACK_CHAIN_OPERATION_IDS,
  FALLBACK_CHAIN_SOURCE_CONTRACTS,
  FallbackChainsHttpFixture,
  buildFallbackChainFixtureRegistry,
  fallbackChainAdapterDescriptor,
} from "./fixtures/fallback-chains.fixture.ts";
import {
  FALLBACK_CHAIN_RELATION_VIEW_BINDING,
  FALLBACK_CHAIN_REQUEST_VALIDATOR_BINDINGS,
  fallbackChainHookMatchesOperation,
  fallbackChainTargetSnapshot,
  normalizeFallbackChain,
  normalizeFallbackChainPayload,
} from "../src/admin/source-fallback-chains.ts";
import { ManagementAuthFixture, type FixtureAccessRecord, type FixtureAccessScope } from "./fixtures/management-auth.fixture.ts";

const TEST_ID = "test/admin-fallback-chains.test.ts";
const PROFILE_ID = "fallback-chains-fixture";
const MANAGE_KEY = "fixture-fallback-manage";
const NOW = "2026-10-19T12:00:00.000Z";
const registry = buildFallbackChainFixtureRegistry();

const REQUIRED_CASES: Readonly<Record<typeof FALLBACK_CHAIN_OPERATION_IDS[number], readonly string[]>> = {
  [FALLBACK_CHAIN_GET]: ["model-map-read-and-projection", "authorization-boundaries", "handler-error", "swallowed-initial-db-load-failure"],
  [FALLBACK_CHAIN_POST]: ["human-confirmed-replacement", "source-validation-and-defaults", "authorization-boundaries", "invalid-json", "create-when-absent-lost-response", "swallowed-storage-save-failure", "closed-hook-bindings-and-target-snapshot", "unobservable-model-rejected"],
  [FALLBACK_CHAIN_DELETE]: ["existing-and-absent-removal", "authorization-boundaries", "invalid-json-and-handler-error", "swallowed-storage-delete-failure", "closed-hook-bindings-and-target-snapshot", "unobservable-model-rejected"],
};

type Observation = { before: unknown; after: unknown; result: { status: number; body: unknown } };
type FixturePair = { readonly route: FallbackChainsHttpFixture; readonly auth: ManagementAuthFixture };
type AdapterAuth = { readonly endpoint: string; readonly credential?: { readonly kind: string; readonly value: string } };
type ExecutorHarness = {
  readonly executor: AdminExecutor;
  readonly route: FallbackChainsHttpFixture;
  readonly auth: ManagementAuthFixture;
  readonly dispatchCount: (operationId: string) => number;
  readonly lastResponse: (operationId: string) => { status: number; body: unknown } | undefined;
  readonly loseNextResponse: (operationId: string) => void;
};

const fixtures: FixturePair[] = [];
const executors: AdminExecutor[] = [];
const completedCases = new Map<string, Set<string>>();
const observations = new Map<string, Observation>();

function mark(operationId: string, caseId: string): void {
  const cases = completedCases.get(operationId) ?? new Set<string>();
  cases.add(caseId);
  completedCases.set(operationId, cases);
}

function observe(operationId: string, caseIds: readonly string[], observation: Observation): void {
  for (const caseId of caseIds) mark(operationId, caseId);
  observations.set(operationId, structuredClone(observation));
}

function accessToken(scope: FixtureAccessScope): FixtureAccessRecord {
  return {
    secret: `oma_fixture_${scope}`,
    id: `fallback-${scope}`,
    name: `Fallback ${scope}`,
    scope,
    createdAt: "2026-10-18T12:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  };
}

function startFixture(options: {
  readonly persisted?: Readonly<Record<string, unknown>>;
  readonly authRequired?: boolean;
  readonly includeReadToken?: boolean;
  readonly includeWriteToken?: boolean;
} = {}): FixturePair {
  const tokens = [
    ...(options.includeReadToken ? [accessToken("read")] : []),
    ...(options.includeWriteToken ? [accessToken("write")] : []),
  ];
  const auth = new ManagementAuthFixture({
    clock: () => NOW,
    keys: {
      [MANAGE_KEY]: ["manage"],
      "fixture-fallback-admin": ["admin"],
      "fixture-fallback-narrow": ["self:usage"],
    },
    tokens,
    cookies: ["auth_token=fixture-dashboard-session"],
  });
  if (options.authRequired === false) auth.authRequired = false;
  const route = new FallbackChainsHttpFixture({
    auth,
    apiKeys: {
      [MANAGE_KEY]: ["manage"],
      "fixture-fallback-admin": ["admin"],
      "fixture-fallback-narrow": ["self:usage"],
    },
    accessTokens: tokens,
    ...(options.persisted === undefined ? {} : { persisted: options.persisted }),
    loopbackCliToken: "fixture-loopback-cli-token",
    dashboardCookies: ["auth_token=fixture-dashboard-session"],
  });
  const pair = { route, auth };
  fixtures.push(pair);
  return pair;
}

function fixtureCredential(context: AdapterAuth): { kind: "apiKey"; value: string } {
  if (context.credential?.kind !== "apiKey") throw new Error("fallback-chain fixture requires its bound management credential");
  return { kind: "apiKey", value: context.credential.value };
}

async function callAdapter(
  adapter: OperationAdapter,
  endpoint: string,
  credential: { kind: "apiKey" | "cookie"; value: string },
  input: unknown,
  signal?: AbortSignal,
) {
  const validated = adapter.validate(input);
  return invokeJsonAdapter({
    descriptor: fallbackChainAdapterDescriptor(adapter),
    endpoint,
    credential,
    resolvedPath: adapter.buildPath(validated),
    queryParameters: adapter.buildQuery(validated),
    ...(validated.body === undefined ? {} : { body: validated.body }),
    ...(signal === undefined ? {} : { signal }),
  });
}

function createHarness(pair: FixturePair): ExecutorHarness {
  const dispatches = new Map<string, number>();
  const lastResponses = new Map<string, { status: number; body: unknown }>();
  const lostResponses = new Set<string>();
  const executor = createAdminExecutor({
    registry,
    dispatch: async (request, context) => {
      const adapter = registry.require(request.operationId);
      const response = await invokeJsonAdapter({
        descriptor: fallbackChainAdapterDescriptor(adapter),
        endpoint: context.auth.endpoint,
        credential: fixtureCredential(context.auth),
        resolvedPath: request.path,
        queryParameters: request.queryParameters,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      dispatches.set(request.operationId, (dispatches.get(request.operationId) ?? 0) + 1);
      const body = response.status >= 400 || response.data === undefined ? response.data ?? null : adapter.project(response.data);
      lastResponses.set(request.operationId, { status: response.status, body });
      if (response.status >= 400 && request.operationId === FALLBACK_CHAIN_GET) {
        throw Object.assign(new Error("fallback-chain fixture returned an HTTP error"), { status: response.status });
      }
      if (lostResponses.delete(request.operationId)) {
        throw Object.assign(new Error("fixture committed the mutation but lost its response"), { code: "network-lost-response", uncertain: true });
      }
      return request.operationId === FALLBACK_CHAIN_GET
        ? response.data
        : { kind: "response", status: response.status, body: response.data };
    },
    readTarget: async context => {
      const relation = context.relation;
      if (relation.operationId !== FALLBACK_CHAIN_GET) throw new Error("fallback-chain mutation has no exact collection target read");
      const readAdapter = registry.require(relation.operationId);
      const input = mapRelationInput(relation.inputs, context.payload);
      const response = await callAdapter(readAdapter, context.auth.endpoint, fixtureCredential(context.auth), input, context.signal);
      if (response.status >= 400) throw Object.assign(new Error("fallback-chain target read was denied"), { status: response.status });
      const snapshot = fallbackChainTargetSnapshot(context.payload, response.data);
      return { digest: createHash("sha256").update(canonicalizeJson(snapshot)).digest("hex"), snapshot };
    },
  });
  executors.push(executor);
  executor.setAdminBinding({ profileId: PROFILE_ID, endpoint: pair.route.endpoint }, true);
  executor.bindCredential({ profileId: PROFILE_ID, endpoint: pair.route.endpoint, apiKey: MANAGE_KEY });
  return {
    executor,
    route: pair.route,
    auth: pair.auth,
    dispatchCount: operationId => dispatches.get(operationId) ?? 0,
    loseNextResponse: operationId => { lostResponses.add(operationId); },
    lastResponse: operationId => lastResponses.get(operationId),
  };
}

async function directRequest(
  route: FallbackChainsHttpFixture,
  method: "GET" | "POST" | "DELETE",
  options: {
    readonly body?: string;
    readonly bearer?: string;
    readonly cookie?: string;
    readonly loopbackToken?: string;
    readonly origin?: string;
    readonly fetchSite?: string;
    readonly urlCredential?: string;
    readonly spoofedSubject?: boolean;
  } = {},
): Promise<Response> {
  const headers = new Headers();
  if (options.body !== undefined) headers.set("content-type", "application/json");
  if (options.bearer !== undefined) headers.set("authorization", `Bearer ${options.bearer}`);
  if (options.cookie !== undefined) headers.set("cookie", options.cookie);
  if (options.loopbackToken !== undefined) headers.set("x-omniroute-cli-token", options.loopbackToken);
  if (options.origin !== undefined) headers.set("origin", options.origin);
  if (options.fetchSite !== undefined) headers.set("sec-fetch-site", options.fetchSite);
  if (options.spoofedSubject) {
    headers.set("x-omniroute-auth-kind", "management_key");
    headers.set("x-omniroute-auth-label", "local-cli-token");
    headers.set("x-omniroute-peer-locality", "loopback");
  }
  const url = new URL(`${route.endpoint}/api/fallback/chains`);
  if (options.urlCredential !== undefined) url.searchParams.set("token", options.urlCredential);
  return fetch(url, {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  });
}


function safeState(pair: FixturePair): JsonValue {
  return { runtime: pair.route.state.runtime, durable: pair.route.state.durable };
}

function mutationBody(model: string, chain?: unknown): string {
  return JSON.stringify(chain === undefined ? { model } : { model, chain });
}


afterEach(async () => {
  for (const executor of executors.splice(0)) executor.shutdown();
  await Promise.all(fixtures.splice(0).map(async pair => {
    await pair.route.close();
    pair.auth.stop();
  }));
});

afterAll(async () => {
  const complete = FALLBACK_CHAIN_OPERATION_IDS.every(operationId =>
    REQUIRED_CASES[operationId].every(caseId => completedCases.get(operationId)?.has(caseId)),
  );
  if (!complete) return;
  const observationDirectory = resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations");
  await mkdir(observationDirectory, { recursive: true, mode: 0o700 });
  for (const operationId of FALLBACK_CHAIN_OPERATION_IDS) {
    const observation = observations.get(operationId);
    if (!observation) return;
    const binding = operationEvidenceBinding(operationId, FALLBACK_CHAIN_SOURCE_CONTRACTS[operationId]);
    const caseSha256 = testCaseSourceHash(TEST_ID);
    const artifactPath = outcomeArtifactPath(operationId);
    const artifact = { operationId, testId: TEST_ID, caseSha256, binding, observation };
    await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson(artifact)}\n`, { mode: 0o600 });
    testOutcomeHash(operationId, TEST_ID, caseSha256, binding, FALLBACK_CHAIN_SOURCE_CONTRACTS[operationId], artifactPath);
  }
});

describe("pinned OmniRoute fallback-chain operations", () => {
  test("unobservable reserved model is rejected before writes while source GET hides the persisted key", async () => {
    const pair = startFixture();
    const harness = createHarness(pair);
    for (const operationId of [FALLBACK_CHAIN_POST, FALLBACK_CHAIN_DELETE] as const) {
      for (const model of ["__proto__", " __proto__ "]) {
        await expect(harness.executor.plan(operationId, {
          body: { model, ...(operationId === FALLBACK_CHAIN_POST ? { chain: [{ provider: "fixture" }] } : {}) },
        })).rejects.toMatchObject({ code: "invalid-input" });
      }
      expect(harness.dispatchCount(operationId)).toBe(0);
      mark(operationId, "unobservable-model-rejected");
    }
    const response = await directRequest(pair.route, "POST", {
      bearer: MANAGE_KEY,
      body: mutationBody("__proto__", [{ provider: "fixture" }]),
    });
    expect(response.status).toBe(200);
    expect(Object.hasOwn(pair.route.durableSnapshot, "__proto__")).toBe(true);
    const observed = await directRequest(pair.route, "GET", { bearer: MANAGE_KEY });
    expect(observed.status).toBe(200);
    expect(Object.hasOwn(await observed.json(), "__proto__")).toBe(false);
    expect(() => fallbackChainTargetSnapshot({ path: {}, query: {}, body: { model: "__proto__" } }, {})).toThrow("cannot be observed");
  });

  test("GET loads the model-keyed map and exposes only source fields", async () => {
    const pair = startFixture({
      persisted: {
        "fixture/model-a": [
          { provider: "second", priority: 2, enabled: false, apiKey: "must-not-project" },
          { provider: "first", priority: 0, enabled: true, nested: { token: "must-not-project-either" } },
        ],
        "fixture/model-b": [{ provider: "only", priority: 1, enabled: true }],
      },
    });
    const before = safeState(pair);
    const harness = createHarness(pair);
    const result = await harness.executor.read(FALLBACK_CHAIN_GET, {});
    expect(result.output).toEqual({
      "fixture/model-a": [
        { provider: "second", priority: 2, enabled: false },
        { provider: "first", priority: 0, enabled: true },
      ],
      "fixture/model-b": [{ provider: "only", priority: 1, enabled: true }],
    });
    expect(JSON.stringify(result.output)).not.toContain("must-not-project");
    expect(pair.route.counts.get).toBe(1);
    expect(pair.route.counts.loads).toBe(1);
    const response = harness.lastResponse(FALLBACK_CHAIN_GET);
    if (!response) throw new Error("GET did not record the observed response");
    expect(response.status).toBe(200);
    observe(FALLBACK_CHAIN_GET, ["model-map-read-and-projection"], {
      before,
      after: safeState(pair),
      result: { status: response.status, body: response.body },
    });
  });

  test("GET distinguishes configured credentials from the auth-disabled branch and retains handler errors", async () => {
    const configured = startFixture({ includeReadToken: true });
    const missing = await directRequest(configured.route, "GET");
    expect(missing.status).toBe(401);
    const missingBody = await missing.json() as { error: { code: string; message: string; correlation_id: string } };
    expect(missingBody.error).toMatchObject({ code: "AUTH_001", message: "Authentication required" });
    expect(missingBody.error.correlation_id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
    const narrow = await directRequest(configured.route, "GET", { bearer: "fixture-fallback-narrow" });
    expect(narrow.status).toBe(403);
    const narrowBody = await narrow.json() as { error: { code: string; message: string; correlation_id: string } };
    expect(narrowBody.error).toMatchObject({ code: "AUTH_001", message: "Invalid management token" });
    expect(narrowBody.error.correlation_id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
    const omaRead = await directRequest(configured.route, "GET", { bearer: "oma_fixture_read" });
    expect(omaRead.status).toBe(200);
    const admin = await directRequest(configured.route, "GET", { bearer: "fixture-fallback-admin" });
    expect(admin.status).toBe(200);
    const dashboard = await directRequest(configured.route, "GET", { cookie: "auth_token=fixture-dashboard-session" });
    expect(dashboard.status).toBe(200);
    const spoofedSubject = await directRequest(configured.route, "GET", { spoofedSubject: true });
    expect(spoofedSubject.status).toBe(401);
    const queryCredential = await directRequest(configured.route, "GET", { urlCredential: MANAGE_KEY });
    expect(queryCredential.status).toBe(401);
    const crossOriginWrite = await directRequest(configured.route, "POST", {
      cookie: "auth_token=fixture-dashboard-session",
      origin: "https://attacker.invalid",
      fetchSite: "same-origin",
      body: mutationBody("fixture/csrf-denied", [{ provider: "must-not-write" }]),
    });
    expect(crossOriginWrite.status).toBe(403);
    expect(await crossOriginWrite.json()).toMatchObject({ error: { code: "INVALID_ORIGIN" } });
    expect(configured.route.state.runtime).not.toHaveProperty("fixture/csrf-denied");
    const local = await directRequest(configured.route, "GET", { loopbackToken: "fixture-loopback-cli-token" });
    expect(local.status).toBe(200);

    const backendUnavailable = startFixture({ includeReadToken: true });
    backendUnavailable.auth.failVerification = true;
    const unavailable = await directRequest(backendUnavailable.route, "GET", { bearer: "oma_fixture_read" });
    expect(unavailable.status).toBe(503);
    const unavailableBody = await unavailable.json() as { error: { code: string; message: string; correlation_id: string } };
    expect(unavailableBody.error).toMatchObject({ code: "AUTH_BACKEND_UNAVAILABLE", message: "Service temporarily unavailable" });
    expect(unavailableBody.error.correlation_id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);

    const open = startFixture({ authRequired: false });
    const noCredential = await directRequest(open.route, "GET");
    expect(noCredential.status).toBe(200);
    expect(await noCredential.json()).toEqual({});

    const failure = startFixture();
    const harness = createHarness(failure);
    failure.route.failNextRoute("GET");
    await expect(harness.executor.read(FALLBACK_CHAIN_GET, {})).rejects.toMatchObject({ status: 500 });
    expect(failure.route.counts.get).toBe(1);
    mark(FALLBACK_CHAIN_GET, "authorization-boundaries");
    mark(FALLBACK_CHAIN_GET, "handler-error");
  });
  test("GET preserves the source's swallowed initial database-load failure without retry", async () => {
    const pair = startFixture({
      persisted: { "fixture/not-loaded": [{ provider: "durable", priority: 1, enabled: true }] },
    });
    pair.route.failNextDatabaseLoad();
    const harness = createHarness(pair);
    const first = await harness.executor.read(FALLBACK_CHAIN_GET, {});
    const second = await harness.executor.read(FALLBACK_CHAIN_GET, {});
    expect(first.output).toEqual({});
    expect(second.output).toEqual({});
    expect(pair.route.counts.get).toBe(2);
    expect(pair.route.counts.loads).toBe(1);
    expect(pair.route.state.runtime).toEqual({});
    expect(pair.route.state.durable).toEqual({
      "fixture/not-loaded": [{ provider: "durable", priority: 1, enabled: true }],
    });
    mark(FALLBACK_CHAIN_GET, "swallowed-initial-db-load-failure");
  });


  test("POST requires human apply and persists a trimmed, sorted replacement with source defaults", async () => {
    const pair = startFixture({
      persisted: { "fixture/model": [{ provider: "old", priority: 4, enabled: true }] },
    });
    const harness = createHarness(pair);
    const before = safeState(pair);
    const input = {
      body: {
        model: " fixture/model ",
        chain: [
          { provider: "later", priority: 8, enabled: false, ignored: "not stored" },
          { provider: "defaulted" },
          { provider: "earlier", priority: 2 },
        ],
      },
    };
    const plan = await harness.executor.plan(FALLBACK_CHAIN_POST, input);
    expect(plan.preview.visibilityLimits?.join(" ")).toContain("silently fail persistence");
    expect(plan.preview.visibilityLimits?.join(" ")).toContain("in-memory fallback map");
    expect(plan.preview.confirmationRequired).toBe(true);
    expect(harness.dispatchCount(FALLBACK_CHAIN_POST)).toBe(0);
    expect(pair.route.state.runtime).toEqual({
      "fixture/model": [{ provider: "old", priority: 4, enabled: true }],
    });

    const applied = await harness.executor.apply(plan.planId, { confirmed: true });
    expect(applied.status).toBe("unknown");
    const expected = [
      { provider: "defaulted", priority: 0, enabled: true },
      { provider: "earlier", priority: 2, enabled: true },
      { provider: "later", priority: 8, enabled: false },
    ];
    expect(pair.route.state.runtime).toEqual({ "fixture/model": expected });
    expect(pair.route.state.durable).toEqual({ "fixture/model": expected });
    expect(harness.dispatchCount(FALLBACK_CHAIN_POST)).toBe(1);
    expect(harness.dispatchCount(FALLBACK_CHAIN_POST)).toBe(1);

    const createPlan = await harness.executor.plan(FALLBACK_CHAIN_POST, {
      body: { model: " fixture/new-model ", chain: [{ provider: " later ", priority: 5 }, { provider: "first" }] },
    });
    harness.loseNextResponse(FALLBACK_CHAIN_POST);
    const reconciled = await harness.executor.apply(createPlan.planId, { confirmed: true });
    expect(reconciled.status).toBe("unknown");
    const created = [
      { provider: "first", priority: 0, enabled: true },
      { provider: "later", priority: 5, enabled: true },
    ];
    expect(pair.route.state.runtime).toEqual({ "fixture/model": expected, "fixture/new-model": created });
    expect(pair.route.state.durable).toEqual({ "fixture/model": expected, "fixture/new-model": created });
    expect(harness.dispatchCount(FALLBACK_CHAIN_POST)).toBe(2);
    expect(pair.route.counts.get).toBe(4);

    const response = harness.lastResponse(FALLBACK_CHAIN_POST);
    if (!response) throw new Error("POST did not record the observed response");
    expect(response).toEqual({ status: 200, body: { success: true, model: "fixture/new-model" } });
    observe(FALLBACK_CHAIN_POST, ["human-confirmed-replacement", "create-when-absent-lost-response"], {
      before,
      after: safeState(pair),
      result: {
        status: response.status,
        body: {
          responseLostAfterCommit: true,
          executorOutcome: reconciled.status,
          durableOutcome: "unproven-by-runtime-get",
          reconciliationReads: 0,
          dispatches: harness.dispatchCount(FALLBACK_CHAIN_POST),
          observedMutationResponse: response.body,
        },
      },
    });
  });

  test("pinned POST source validation trims model/provider, defaults omitted fields and rejects invalid priorities", async () => {
    const raw = {
      model: "  fixture/validated  ",
      extra: "outer properties are ignored by the route parser",
      chain: [
        { provider: " late ", priority: 9, enabled: false, discarded: true },
        { provider: " defaulted " },
        { provider: " early ", priority: 1 },
      ],
    };
    const pair = startFixture();
    const valid = await directRequest(pair.route, "POST", { bearer: MANAGE_KEY, body: JSON.stringify(raw) });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toEqual({ success: true, model: "fixture/validated" });
    expect((pair.route.state.runtime as Record<string, JsonValue>)["fixture/validated"]).toEqual([
      { provider: "defaulted", priority: 0, enabled: true },
      { provider: "early", priority: 1, enabled: true },
      { provider: "late", priority: 9, enabled: false },
    ]);

    const invalid = await directRequest(pair.route, "POST", {
      bearer: MANAGE_KEY,
      body: JSON.stringify({ model: "fixture/validated", chain: [{ provider: " ", priority: 101 }, { provider: "valid", priority: 0 }] }),
    });
    expect(invalid.status).toBe(400);
    const validationBody = await invalid.json() as { error: { details: readonly { field: string }[] } };
    expect(validationBody.error.details.map(issue => issue.field)).toEqual(["chain.0.provider", "chain.0.priority", "chain.1.priority"]);

    const before = safeState(pair);
    const invalidJson = await directRequest(pair.route, "POST", { bearer: MANAGE_KEY, body: "{" });
    expect(invalidJson.status).toBe(400);
    const invalidBody = await directRequest(pair.route, "POST", {
      bearer: MANAGE_KEY,
      body: JSON.stringify({ model: "fixture/validated", chain: [{ provider: " ", priority: 101 }] }),
    });
    expect(invalidBody.status).toBe(400);
    pair.route.failNextRoute("POST");
    const handlerFailure = await directRequest(pair.route, "POST", {
      bearer: MANAGE_KEY,
      body: mutationBody("fixture/validated", [{ provider: "valid" }]),
    });
    expect(handlerFailure.status).toBe(500);
    expect(await handlerFailure.json()).toEqual({ error: "Failed to register fallback chain" });
    expect(safeState(pair)).toEqual(before);
    expect(pair.route.counts.post).toBe(5);
    mark(FALLBACK_CHAIN_POST, "source-validation-and-defaults");
    mark(FALLBACK_CHAIN_POST, "invalid-json");
  });

  test("POST HTTP 200 and matching runtime GET stay unknown when the pinned policy swallows a persistence save failure", async () => {
    const pair = startFixture({
      persisted: { "fixture/save-failure": [{ provider: "old", priority: 1, enabled: true }] },
    });
    const harness = createHarness(pair);
    const before = safeState(pair);
    pair.route.failNextDatabaseSave();
    const plan = await harness.executor.plan(FALLBACK_CHAIN_POST, {
      body: { model: "fixture/save-failure", chain: [{ provider: "replacement" }] },
    });
    const result = await harness.executor.apply(plan.planId, { confirmed: true });
    expect(result.status).toBe("unknown");
    expect(harness.lastResponse(FALLBACK_CHAIN_POST)).toEqual({
      status: 200, body: { success: true, model: "fixture/save-failure" },
    });
    const runtimeGet = await harness.executor.read(FALLBACK_CHAIN_GET, {});
    expect(runtimeGet.output).toEqual({ "fixture/save-failure": [{ provider: "replacement", priority: 0, enabled: true }] });
    expect(pair.route.state.durable).toEqual({ "fixture/save-failure": [{ provider: "old", priority: 1, enabled: true }] });
    expect(harness.dispatchCount(FALLBACK_CHAIN_POST)).toBe(1);
    const response = harness.lastResponse(FALLBACK_CHAIN_POST);
    if (!response) throw new Error("POST did not record the observed response");
    observe(FALLBACK_CHAIN_POST, ["swallowed-storage-save-failure"], {
      before,
      after: safeState(pair),
      result: { status: response.status, body: { observedMutationResponse: response.body, executorOutcome: result.status,
        runtimeGet: runtimeGet.output, durableOutcome: "diverged", dispatches: harness.dispatchCount(FALLBACK_CHAIN_POST) } },
    });
  });

  test("POST uses the exact OMA write scope; authentication-disabled access is conditional", async () => {
    const configured = startFixture({ includeReadToken: true, includeWriteToken: true });
    const before = safeState(configured);
    const denied = await directRequest(configured.route, "POST", {
      bearer: "oma_fixture_read",
      body: mutationBody("fixture/denied", [{ provider: "provider" }]),
    });
    expect(denied.status).toBe(403);
    const deniedBody = await denied.json() as { error: { code: string; message: string; correlation_id: string } };
    expect(deniedBody.error).toMatchObject({
      code: "AUTH_SCOPE",
      message: "Access token scope 'read' is insufficient; 'write' required.",
    });
    expect(deniedBody.error.correlation_id).toMatch(/^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i);
    expect(safeState(configured)).toEqual(before);
    const allowed = await directRequest(configured.route, "POST", {
      bearer: "oma_fixture_write",
      body: mutationBody("fixture/allowed", [{ provider: "provider" }]),
    });
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ success: true, model: "fixture/allowed" });

    const open = startFixture({ authRequired: false });
    const accepted = await directRequest(open.route, "POST", {
      body: mutationBody("fixture/auth-disabled", [{ provider: "provider" }]),
    });
    expect(accepted.status).toBe(200);
    expect(open.route.state.runtime).toEqual({ "fixture/auth-disabled": [{ provider: "provider", priority: 0, enabled: true }] });
    mark(FALLBACK_CHAIN_POST, "authorization-boundaries");
  });

  test("DELETE removes existing and absent model keys only after human confirmation", async () => {
    const pair = startFixture({
      persisted: {
        "fixture/remove": [{ provider: "first", priority: 1, enabled: true }],
        "fixture/storage-failure": [{ provider: "durable", priority: 4, enabled: true }],
        "fixture/other": [{ provider: "keep", priority: 3, enabled: false }],
      },
    });
    const harness = createHarness(pair);
    const before = safeState(pair);
    const firstPlan = await harness.executor.plan(FALLBACK_CHAIN_DELETE, { body: { model: " fixture/remove " } });
    expect(firstPlan.preview.confirmationRequired).toBe(true);
    expect(harness.dispatchCount(FALLBACK_CHAIN_DELETE)).toBe(0);
    const firstResult = await harness.executor.apply(firstPlan.planId, { confirmed: true });
    expect(firstResult.status).toBe("unknown");
    expect(harness.lastResponse(FALLBACK_CHAIN_DELETE)).toEqual({
      status: 200,
      body: { success: true, removed: true },
    });
    expect(pair.route.state.runtime).toEqual({
      "fixture/other": [{ provider: "keep", priority: 3, enabled: false }],
      "fixture/storage-failure": [{ provider: "durable", priority: 4, enabled: true }],
    });
    expect(pair.route.state.durable).toEqual({
      "fixture/other": [{ provider: "keep", priority: 3, enabled: false }],
      "fixture/storage-failure": [{ provider: "durable", priority: 4, enabled: true }],
    });

    const missingPlan = await harness.executor.plan(FALLBACK_CHAIN_DELETE, { body: { model: "fixture/missing" } });
    const missingResult = await harness.executor.apply(missingPlan.planId, { confirmed: true });
    expect(missingResult.status).toBe("unknown");
    expect(harness.lastResponse(FALLBACK_CHAIN_DELETE)).toEqual({ status: 200, body: { success: true, removed: false } });
    expect(harness.dispatchCount(FALLBACK_CHAIN_DELETE)).toBe(2);
    expect(pair.route.state.runtime).toEqual({
      "fixture/other": [{ provider: "keep", priority: 3, enabled: false }],
      "fixture/storage-failure": [{ provider: "durable", priority: 4, enabled: true }],
    });
    expect(pair.route.state.durable).toEqual({
      "fixture/other": [{ provider: "keep", priority: 3, enabled: false }],
      "fixture/storage-failure": [{ provider: "durable", priority: 4, enabled: true }],
    });
    pair.route.failNextDatabaseDelete();
    const storagePlan = await harness.executor.plan(FALLBACK_CHAIN_DELETE, { body: { model: "fixture/storage-failure" } });
    const storageResult = await harness.executor.apply(storagePlan.planId, { confirmed: true });
    expect(storageResult.status).toBe("unknown");
    const runtimeGet = await harness.executor.read(FALLBACK_CHAIN_GET, {});
    expect(runtimeGet.output).toEqual({ "fixture/other": [{ provider: "keep", priority: 3, enabled: false }] });
    expect(pair.route.state.runtime).toEqual({
      "fixture/other": [{ provider: "keep", priority: 3, enabled: false }],
    });
    expect(pair.route.state.durable).toEqual({
      "fixture/other": [{ provider: "keep", priority: 3, enabled: false }],
      "fixture/storage-failure": [{ provider: "durable", priority: 4, enabled: true }],
    });
    expect(harness.dispatchCount(FALLBACK_CHAIN_DELETE)).toBe(3);
    const response = harness.lastResponse(FALLBACK_CHAIN_DELETE);
    if (!response) throw new Error("DELETE did not record the observed response");
    observe(FALLBACK_CHAIN_DELETE, ["existing-and-absent-removal", "swallowed-storage-delete-failure"], {
      before,
      after: safeState(pair),
      result: { status: response.status, body: { observedMutationResponse: response.body, executorOutcome: storageResult.status,
        runtimeGet: runtimeGet.output, durableOutcome: "diverged", dispatches: harness.dispatchCount(FALLBACK_CHAIN_DELETE) } },
    });
  });

  test("DELETE enforces exact OMA write scope and preserves source error statuses", async () => {
    const configured = startFixture({
      persisted: { "fixture/protected": [{ provider: "keep", priority: 1, enabled: true }] },
      includeReadToken: true,
      includeWriteToken: true,
    });
    const before = safeState(configured);
    const denied = await directRequest(configured.route, "DELETE", {
      bearer: "oma_fixture_read",
      body: mutationBody("fixture/protected"),
    });
    expect(denied.status).toBe(403);
    expect(safeState(configured)).toEqual(before);
    const writeToken = await directRequest(configured.route, "DELETE", {
      bearer: "oma_fixture_write",
      body: mutationBody("fixture/protected"),
    });
    expect(writeToken.status).toBe(200);
    expect(await writeToken.json()).toEqual({ success: true, removed: true });

    const failurePair = startFixture({
      persisted: { "fixture/failure": [{ provider: "still-here", priority: 1, enabled: true }] },
    });
    const beforeError = safeState(failurePair);
    const invalid = await directRequest(failurePair.route, "DELETE", { bearer: MANAGE_KEY, body: "not-json" });
    expect(invalid.status).toBe(400);
    failurePair.route.failNextRoute("DELETE");
    const handlerFailure = await directRequest(failurePair.route, "DELETE", {
      bearer: MANAGE_KEY,
      body: mutationBody("fixture/failure"),
    });
    expect(handlerFailure.status).toBe(500);
    expect(await handlerFailure.json()).toEqual({ error: "Failed to remove fallback chain" });
    expect(safeState(failurePair)).toEqual(beforeError);
    expect(failurePair.route.counts.delete).toBe(2);
    mark(FALLBACK_CHAIN_DELETE, "authorization-boundaries");
    mark(FALLBACK_CHAIN_DELETE, "invalid-json-and-handler-error");
  });

  test("source hooks reject adjacent operations and select the exact body-keyed map entry", () => {
    const post = registry.require(FALLBACK_CHAIN_POST).descriptor;
    const remove = registry.require(FALLBACK_CHAIN_DELETE).descriptor;
    const read = registry.require(FALLBACK_CHAIN_GET).descriptor;
    const registerId = "omniroute-v3.8.52.fallback-chains.register";
    const removeId = "omniroute-v3.8.52.fallback-chains.remove";
    const relationId = "omniroute-v3.8.52.fallback-chains.reconciliation";
    expect(FALLBACK_CHAIN_RELATION_VIEW_BINDING.id).toBe(relationId);
    expect(FALLBACK_CHAIN_RELATION_VIEW_BINDING.operations).toEqual([FALLBACK_CHAIN_POST, FALLBACK_CHAIN_DELETE]);

    expect(FALLBACK_CHAIN_REQUEST_VALIDATOR_BINDINGS[registerId].operations).toEqual([FALLBACK_CHAIN_POST]);
    expect(FALLBACK_CHAIN_REQUEST_VALIDATOR_BINDINGS[removeId].operations).toEqual([FALLBACK_CHAIN_DELETE]);
    expect(fallbackChainHookMatchesOperation(registerId, post)).toBe(true);
    expect(fallbackChainHookMatchesOperation(registerId, remove)).toBe(false);
    expect(fallbackChainHookMatchesOperation(registerId, {
      ...post,
      pathTemplate: "/api/fallback/chains/other",
    })).toBe(false);
    expect(fallbackChainHookMatchesOperation(removeId, remove)).toBe(true);
    expect(fallbackChainHookMatchesOperation(relationId, post)).toBe(true);
    expect(fallbackChainHookMatchesOperation(relationId, remove)).toBe(true);
    expect(fallbackChainHookMatchesOperation(relationId, read)).toBe(false);

    const postSafety = post.mutationSafety;
    const deleteSafety = remove.mutationSafety;
    if (postSafety?.preflight.kind !== "required" || deleteSafety?.preflight.kind !== "required") {
      throw new Error("fallback mutation preflight contract is missing");
    }
    expect(post.reconciliation?.targetRead.sourceView).toBe(relationId);
    expect(remove.reconciliation?.targetRead.sourceView).toBe(relationId);
    expect(read.mutationSafety).toBeNull();
    expect(postSafety.preflight.observations[0]?.read.operationId).toBe(FALLBACK_CHAIN_GET);
    expect(postSafety.preflight.observations[0]?.read.sourceView).toBe(relationId);
    expect(deleteSafety.preflight.observations[0]?.read.sourceView).toBe(relationId);
    expect(postSafety.reconciliation).toEqual({ kind: "unknown" });
    expect(deleteSafety.reconciliation).toEqual({ kind: "unknown" });
    expect(postSafety.settlement.responseComplete.statusCodes).toEqual([]);
    expect(deleteSafety.settlement.responseComplete.statusCodes).toEqual([]);

    const payload = registry.require(FALLBACK_CHAIN_POST).validate({
      body: { model: " fixture/model ", chain: [{ provider: "later", priority: 4 }, { provider: "first" }] },
    });
    expect(normalizeFallbackChainPayload(FALLBACK_CHAIN_POST, payload).body).toEqual({
      model: "fixture/model",
      chain: [
        { provider: "first", priority: 0, enabled: true },
        { provider: "later", priority: 4, enabled: true },
      ],
    });
    expect(fallbackChainTargetSnapshot(payload, {
      "fixture/model": [{ provider: "selected", priority: 3, enabled: false }],
      "fixture/other": [{ provider: "not-selected", priority: 0, enabled: true }],
    })).toEqual({
      kind: "resource",
      entries: [{
        identity: { model: "fixture/model" },
        state: { chain: [{ provider: "selected", priority: 3, enabled: false }] },
      }],
    });
    expect(fallbackChainTargetSnapshot(payload, {
      "fixture/other": [{ provider: "not-selected", priority: 0, enabled: true }],
    })).toEqual({
      kind: "resource",
      entries: [{ identity: { model: "fixture/model" }, state: {}, absent: true }],
    });
    expect(() => fallbackChainTargetSnapshot(payload, { "fixture/model": { provider: "not-an-array" } })).toThrow();
    mark(FALLBACK_CHAIN_POST, "closed-hook-bindings-and-target-snapshot");
    mark(FALLBACK_CHAIN_DELETE, "closed-hook-bindings-and-target-snapshot");
  });

  test("management auth contracts retain opaque alternatives and the exact path-sensitive OMA scopes", () => {
    const alternativesFor = (operationId: typeof FALLBACK_CHAIN_OPERATION_IDS[number]) => {
      const policy = registry.require(operationId).descriptor.auth.sourcePolicy;
      if (policy.status !== "qualified" || policy.routeClass !== "management") throw new Error("fallback-chain auth policy is not source-qualified management auth");
      return policy.alternatives;
    };
    for (const operationId of FALLBACK_CHAIN_OPERATION_IDS) {
      const alternatives = alternativesFor(operationId);
      expect(alternatives).toContainEqual({ kind: "auth-disabled", when: "central-and-handler-auth-not-required" });
      expect(alternatives).toContainEqual({ kind: "management-api-key", anyOf: ["manage", "admin"] });
      expect(alternatives).toContainEqual({ kind: "dashboard-session" });
      expect(alternatives).toContainEqual({ kind: "trusted-local", loopbackOnly: true });
    }
    expect(alternativesFor(FALLBACK_CHAIN_GET)).toContainEqual({
      kind: "oma-access-token", minimumScope: "read",
    });
    expect(alternativesFor(FALLBACK_CHAIN_POST)).toContainEqual({
      kind: "oma-access-token", minimumScope: "write",
    });
    expect(alternativesFor(FALLBACK_CHAIN_DELETE)).toContainEqual({
      kind: "oma-access-token", minimumScope: "write",
    });
  });
});
