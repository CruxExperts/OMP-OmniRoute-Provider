import { afterAll, afterEach, expect, test } from "bun:test";
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
import { canonicalizeJson, getOperation, type OperationAdapter, type OperationDescriptor } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import {
  PROVIDER_NODES_OPERATION_ID,
  PROVIDER_NODES_SOURCE_CONTRACT,
  type ProviderNodeFixture,
} from "./fixtures/provider-nodes.fixture.ts";
import { ProviderNodesFixture } from "./fixtures/pinned-provider-nodes.fixture.ts";

const TEST_ID = "test/admin-provider-nodes.test.ts";
const PROFILE_ID = "provider-nodes-source-fixture";
const MANAGEMENT_KEY = "fixture-provider-nodes-manage";
const READ_KEY = "fixture-provider-nodes-read";
const FIXED_TIME = "2026-10-20T12:00:00.000Z";

const REQUIRED_CASES = [
  "empty-and-full-projection",
  "offset-pagination-and-boundaries",
  "management-authorization",
  "conditional-auth-disabled",
  "handler-error",
  "pagination-invalid-shape",
] as const;

type Observation = { before: unknown; after: unknown; result: { status: number; body: unknown } };
type HttpResult = { status: number; body: unknown };
type JsonRecord = Record<string, unknown>;

const operationSource = getOperation(PROVIDER_NODES_OPERATION_ID);
if (!operationSource) throw new Error(`pinned operation is absent: ${PROVIDER_NODES_OPERATION_ID}`);
const operationBinding = operationEvidenceBinding(PROVIDER_NODES_OPERATION_ID, PROVIDER_NODES_SOURCE_CONTRACT);
if (operationBinding.handlerSha256 !== operationSource.source.sha256
  || operationBinding.handlerGitBlobSha !== operationSource.source.gitBlobSha) {
  throw new Error("provider-nodes fixture contract does not match the pinned handler");
}
const registry = fixtureRegistry([{
  ...operationSource,
  ...PROVIDER_NODES_SOURCE_CONTRACT,
  mediaType: { request: null, response: PROVIDER_NODES_SOURCE_CONTRACT.response.mediaType },
  coverage: {
    status: "invokable",
    adapterId: "typed.fixture.get.api.provider.nodes",
    reason: null,
  },
} satisfies OperationDescriptor]);

const fixtures: ProviderNodesFixture[] = [];
const executors: AdminExecutor[] = [];
const completedCases = new Set<string>();
let observation: Observation | undefined;

function record(operationId: string, caseIds: readonly string[], value: Observation): void {
  if (operationId !== PROVIDER_NODES_OPERATION_ID) throw new Error("provider-nodes observation has the wrong operation ID");
  for (const caseId of caseIds) completedCases.add(caseId);
  observation ??= structuredClone(value);
}

function object(value: unknown): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("expected a JSON object");
  return value as JsonRecord;
}

function descriptorFor(adapter: OperationAdapter) {
  return { ...adapter.descriptor, adapterId: adapter.adapterId };
}

function createHarness(fixture: ProviderNodesFixture, key: string | null = MANAGEMENT_KEY) {
  let response: HttpResult | undefined;
  const executor = createAdminExecutor({
    registry,
    dispatch: async (request, context) => {
      const adapter = registry.require(request.operationId);
      const result = await invokeJsonAdapter({
        descriptor: descriptorFor(adapter),
        endpoint: context.auth.endpoint,
        ...(context.auth.credential === undefined ? {} : { credential: context.auth.credential }),
        resolvedPath: request.path,
        queryParameters: request.queryParameters,
        ...(request.body === undefined ? {} : { body: request.body }),
        ...(context.signal === undefined ? {} : { signal: context.signal }),
      });
      response = { status: result.status, body: result.data ?? null };
      if (result.status >= 400) throw Object.assign(new Error("pinned provider-nodes handler returned an HTTP error"), { status: result.status });
      return result.data;
    },
  });
  executors.push(executor);
  executor.setAdminBinding({ profileId: PROFILE_ID, endpoint: fixture.endpoint }, true);
  if (key !== null) executor.bindCredential({ profileId: PROFILE_ID, endpoint: fixture.endpoint, apiKey: key });
  return { executor, response: () => response };
}

function nodeSeed(id: string, changes: Partial<ProviderNodeFixture> = {}): ProviderNodeFixture {
  return {
    id,
    type: "openai-compatible",
    name: `Fixture ${id}`,
    prefix: `fixture-${id}`,
    apiType: "openai",
    baseUrl: `https://user-${id}:url-password-${id}@private-${id}.internal:9443/private/${id}?token=url-token-${id}`,
    chatPath: `/private/${id}/chat/completions`,
    modelsPath: `/private/${id}/models`,
    iconUrl: `https://assets.example/${id}.svg`,
    customHeaders: { "x-private-key": `header-secret-${id}`, "x-public-label": `fixture-${id}` },
    dailyQuotaResetTimezone: "America/Chicago",
    dailyQuotaResetHour: 4,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
    ...changes,
  };
}

async function rawGet(
  fixture: ProviderNodesFixture,
  options: { readonly query?: Record<string, string>; readonly key?: string } = {},
): Promise<HttpResult> {
  const url = new URL("/api/provider-nodes", fixture.endpoint);
  for (const [name, value] of Object.entries(options.query ?? {})) url.searchParams.set(name, value);
  const response = await fetch(url, {
    headers: options.key === undefined ? {} : { authorization: `Bearer ${options.key}` },
  });
  let body: unknown;
  try { body = await response.json(); } catch { body = null; }
  return { status: response.status, body };
}

function safeState(nodes: readonly JsonRecord[]): Array<{ id: unknown; type: unknown; name: unknown }> {
  return nodes.map(({ id, type, name }) => ({ id, type, name }));
}

afterEach(async () => {
  for (const executor of executors.splice(0)) executor.shutdown();
  await Promise.all(fixtures.splice(0).map(fixture => fixture.close()));
});

afterAll(async () => {
  if (!REQUIRED_CASES.every(caseId => completedCases.has(caseId)) || !observation) return;
  const directory = resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const caseSha256 = testCaseSourceHash(TEST_ID);
  const artifactPath = outcomeArtifactPath(PROVIDER_NODES_OPERATION_ID);
  const artifact = {
    operationId: PROVIDER_NODES_OPERATION_ID,
    testId: TEST_ID,
    caseSha256,
    binding: operationBinding,
    observation,
  };
  await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson(artifact)}\n`, { mode: 0o600 });
  testOutcomeHash(PROVIDER_NODES_OPERATION_ID, TEST_ID, caseSha256, operationBinding, PROVIDER_NODES_SOURCE_CONTRACT, artifactPath);
});

test("provider-nodes GET exposes the complete source response with credential-sensitive fields removed", async () => {
  const emptyFixture = new ProviderNodesFixture([]);
  fixtures.push(emptyFixture);
  const emptyHarness = createHarness(emptyFixture);
  const empty = await emptyHarness.executor.read(PROVIDER_NODES_OPERATION_ID, {});
  expect(empty.output).toEqual({ nodes: [], total: 0, ccCompatibleProviderEnabled: true });
  expect(Object.keys(object(empty.output)).sort()).toEqual(["ccCompatibleProviderEnabled", "nodes", "total"]);

  const fixture = new ProviderNodesFixture([
    nodeSeed("node-b"),
    nodeSeed("node-a"),
    nodeSeed("node-c"),
  ]);
  fixtures.push(fixture);
  const before = safeState(await fixture.state());
  const harness = createHarness(fixture);
  const result = await harness.executor.read(PROVIDER_NODES_OPERATION_ID, {});
  const body = object(result.output);
  expect(Object.keys(body).sort()).toEqual(["ccCompatibleProviderEnabled", "nodes", "total"]);
  expect(body.total).toBe(3);
  expect(body.ccCompatibleProviderEnabled).toBe(true);
  const nodes = body.nodes as unknown[];
  expect(nodes.map(value => object(value).id)).toEqual(["node-a", "node-b", "node-c"]);
  const first = object(nodes[0]);
  expect(first).toMatchObject({ id: "node-a", type: "openai-compatible", name: "Fixture node-a", prefix: "fixture-node-a", apiType: "openai", iconUrl: "https://assets.example/node-a.svg" });
  expect(first).not.toHaveProperty("customHeaders");
  expect(first).not.toHaveProperty("baseUrl");
  expect(first).not.toHaveProperty("chatPath");
  expect(first).not.toHaveProperty("modelsPath");
  const rawSource = object(harness.response()?.body);
  const rawNode = object((rawSource.nodes as unknown[])[0]);
  expect(rawNode.customHeaders).toEqual({ "x-private-key": "header-secret-node-a", "x-public-label": "fixture-node-a" });
  expect(rawNode.baseUrl).toContain("user-node-a:url-password-node-a@");
  expect(rawNode.baseUrl).toContain("url-token-node-a");
  expect(rawNode.chatPath).toBe("/private/node-a/chat/completions");
  const privateTarget = registry.require(PROVIDER_NODES_OPERATION_ID).projectTarget(rawSource);
  expect(privateTarget).toEqual(rawSource);
  const outputText = JSON.stringify(result.output);
  for (const secret of ["header-secret-node-a", "url-password-node-a", "url-token-node-a", "private-node-a.internal", "/private/node-a/"]) {
    expect(outputText).not.toContain(secret);
  }
  record(PROVIDER_NODES_OPERATION_ID, ["empty-and-full-projection"], {
    before,
    after: safeState(await fixture.state()),
    result: { status: harness.response()?.status ?? 0, body: result.output },
  });
});

test("provider-nodes GET uses stable offset pages and preserves the source's pagination boundaries", async () => {
  const fixture = new ProviderNodesFixture([nodeSeed("node-c"), nodeSeed("node-a"), nodeSeed("node-b")]);
  fixtures.push(fixture);
  const harness = createHarness(fixture);
  const page = await harness.executor.read(PROVIDER_NODES_OPERATION_ID, { query: { limit: 1, offset: 1 } });
  expect(page.output).toMatchObject({ total: 3, nodes: [{ id: "node-b" }] });
  const boundary = await harness.executor.read(PROVIDER_NODES_OPERATION_ID, { query: { limit: 1, offset: 3 } });
  expect(boundary.output).toEqual({ nodes: [], total: 3, ccCompatibleProviderEnabled: true });
  const zeroLimit = await harness.executor.read(PROVIDER_NODES_OPERATION_ID, { query: { limit: 0, offset: 0 } });
  expect(object(zeroLimit.output).nodes).toHaveLength(3);
  await expect(harness.executor.read(PROVIDER_NODES_OPERATION_ID, { query: { limit: "1" } }))
    .rejects.toMatchObject({ code: "invalid-input" });
  record(PROVIDER_NODES_OPERATION_ID, ["offset-pagination-and-boundaries"], {
    before: [],
    after: safeState(await fixture.state()),
    result: { status: harness.response()?.status ?? 0, body: page.output },
  });
});

test("provider-nodes GET uses central management authorization and returns the source's handler error", async () => {
  const fixture = new ProviderNodesFixture([nodeSeed("node-a")]);
  fixtures.push(fixture);
  const authorized = createHarness(fixture);
  expect((await authorized.executor.read(PROVIDER_NODES_OPERATION_ID, {})).output).toMatchObject({ total: 1 });
  const anonymous = createHarness(fixture, null);
  const invalid = createHarness(fixture, "fixture-provider-nodes-invalid");
  const wrongScope = createHarness(fixture, READ_KEY);

  expect((await rawGet(fixture)).status).toBe(401);
  expect((await rawGet(fixture, { key: "fixture-provider-nodes-invalid" })).status).toBe(403);
  expect((await rawGet(fixture, { key: READ_KEY })).status).toBe(403);
  await expect(anonymous.executor.read(PROVIDER_NODES_OPERATION_ID, {})).rejects.toMatchObject({ status: 401 });
  expect(anonymous.response()?.status).toBe(401);
  await expect(invalid.executor.read(PROVIDER_NODES_OPERATION_ID, {})).rejects.toMatchObject({ status: 403 });
  expect(invalid.response()?.status).toBe(403);
  await expect(wrongScope.executor.read(PROVIDER_NODES_OPERATION_ID, {})).rejects.toMatchObject({ status: 403 });
  expect(wrongScope.response()?.status).toBe(403);
  completedCases.add("management-authorization");

  fixture.centralAuthRequired = false;
  expect((await anonymous.executor.read(PROVIDER_NODES_OPERATION_ID, {})).output).toMatchObject({ total: 1 });
  expect(anonymous.response()?.status).toBe(200);
  fixture.centralAuthRequired = true;
  completedCases.add("conditional-auth-disabled");

  fixture.failList();
  const failed = createHarness(fixture);
  await expect(failed.executor.read(PROVIDER_NODES_OPERATION_ID, {})).rejects.toMatchObject({ status: 500 });
  expect(failed.response()).toEqual({ status: 500, body: { error: "Failed to fetch provider nodes" } });
  completedCases.add("handler-error");
});

test("provider-nodes GET returns 400 for source pagination values outside its real schema", async () => {
  const fixture = new ProviderNodesFixture([nodeSeed("node-a")]);
  fixtures.push(fixture);
  for (const query of [
    { limit: "201" },
    { offset: "-1" },
    { offset: "1.5" },
    { limit: "not-a-number" },
  ]) {
    expect((await rawGet(fixture, { query, key: MANAGEMENT_KEY })).status).toBe(400);
  }
  completedCases.add("pagination-invalid-shape");
});
