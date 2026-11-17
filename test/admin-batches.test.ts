import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash, validateBatchLifecycleObservation, validateBatchListContract, validateBatchListObservation } from "../scripts/generate-contracts.ts";
import { createAdminExecutor } from "../src/admin/executor.ts";
import { canonicalizeJson, getOperation, type OperationDescriptor } from "../src/admin/registry.ts";
import { operationRequiresIngressEvidence } from "../src/admin/eligibility.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { BatchFixture, batchListContract, batchReadPolicy, projectBatchItem, projectBatchList, validateBatchListQuery } from "./fixtures/batches.fixture.ts";

const operationId = "GET /api/batches", testId = "test/admin-batches.test.ts";
const source = getOperation(operationId)!;
const descriptor: OperationDescriptor = { ...source, ...batchListContract(), databaseInitializationRequired: true, mediaType: { request: null, response: "application/json" }, coverage: { status: "invokable", adapterId: "typed.fixture.batch", reason: null } };
const adapter = fixtureRegistry([descriptor]).require(operationId);
const complete = new Set<string>();
let observation: { before: unknown; after: unknown; result: { status: number; body: unknown } } | undefined;
afterAll(async () => {
  if (!observation || ["owner", "ingress", "limit", "projection", "contract", "evidence", "lifecycle", "executor"].some(name => !complete.has(name))) return;
  const contract = batchListContract(), binding = operationEvidenceBinding(operationId, contract);
  const caseSha256 = testCaseSourceHash(testId), artifactPath = outcomeArtifactPath(operationId);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId, testId, caseSha256, binding, observation })}\n`, { mode: 0o600 });
  testOutcomeHash(operationId, testId, caseSha256, binding, contract, artifactPath);
});

const expected = {
  id: "batch_a2", status: "completed", requestCountsTotal: 3, requestCountsCompleted: 2, requestCountsFailed: 1,
  createdAt: 20, inProgressAt: null, expiresAt: null, finalizingAt: null, completedAt: null, failedAt: null,
  expiredAt: null, cancellingAt: null, cancelledAt: null,
};
function seeded(): BatchFixture {
  const f = new BatchFixture();
  f.seed("batch_a1", "owner-a", 10);
  f.seed("batch_a2", "owner-a", 20);
  f.seed("batch_a3", "owner-a", 20);
  f.seed("batch_b", "owner-b", 30);
  f.seed("batch_null", null, 40);
  return f;
}
async function list(f: BatchFixture, key?: string, query = "", session = false) {
  const response = await f.list(f.request(query, key, session));
  return { status: response.status, body: await response.json() as { batches: Array<Record<string, unknown>> } };
}
async function item(f: BatchFixture, id: string, key?: string, session = false) {
  const response = await f.item(f.request("", key, session), { params: { id } });
  return { status: response.status, body: await response.json() as unknown };
}

test("actual handler and database enforce key owner and operator alternatives", async () => {
  const f = seeded();
  try {
    expect((await list(f, "owner-a")).body.batches.map(x => x.id)).toEqual(["batch_a3", "batch_a2", "batch_a1"]);
    expect((await list(f, "owner-b")).body.batches.map(x => x.id)).toEqual(["batch_b"]);
    expect((await list(f, "owner-a", "", true)).body.batches.map(x => x.id)).toEqual(["batch_a3", "batch_a2", "batch_a1"]);
    for (const [key, session] of [["manager", false], [undefined, true]] as const) {
      expect((await list(f, key, "", session)).body.batches.map(x => x.id)).toEqual(["batch_null", "batch_b", "batch_a3", "batch_a2", "batch_a1"]);
      expect((await item(f, "batch_null", key, session)).status).toBe(200);
    }
    const foreign = await item(f, "batch_b", "owner-a"), absent = await item(f, "batch_missing", "owner-a");
    expect(foreign).toEqual(absent);
    expect(foreign.status).toBe(404);
    expect((await item(f, "batch_null", "owner-a")).status).toBe(404);
    expect((await list(f)).status).toBe(401);
    expect((await list(f, "unknown", "", true)).status).toBe(401);
    expect((await list(f, "revoked", "", true)).status).toBe(401);
    // Detail's invalid-key/session combination differs: source ignores rejected key when session exists.
    expect((await item(f, "batch_b", "revoked", true)).status).toBe(200);
    complete.add("owner");
  } finally { f.close(); }
});

test("management ingress is separate from direct owner handler policy", async () => {
  const f = seeded();
  try {
    expect((await f.dispatch(f.request("", "owner-a"))).status).not.toBe(200);
    expect((await f.dispatch(f.request("", "manager"))).status).toBe(200);
    expect((await f.dispatch(f.request())).status).not.toBe(200);
    complete.add("ingress");
  } finally { f.close(); }
});

test("route ordering and integer parsing are not a pagination or cap guarantee", async () => {
  const f = seeded();
  try {
    const before = f.db.query("SELECT count(*) AS rows, sum(api_key_id = 'owner-a') AS ownerRows FROM batches").get();
    const observed = await list(f, "owner-a", "?limit=2");
    const after = f.db.query("SELECT count(*) AS rows, sum(api_key_id = 'owner-a') AS ownerRows FROM batches").get();
    expect(before).toEqual({ rows: 5, ownerRows: 3 }); expect(after).toEqual(before);
    expect(observed.status).toBe(200);
    observation = { before, after, result: { status: observed.status, body: adapter.project(observed.body) } };
    validateBatchListObservation(before, after, observed.status, observation.result.body);
    expect(() => validateBatchListObservation(before, { rows: 4, ownerRows: 3 }, observed.status, observation!.result.body)).toThrow();
    expect(() => validateBatchListObservation(before, after, observed.status, { batches: [] })).toThrow();
    expect(() => validateBatchListObservation(before, after, observed.status, { batches: [{ ...expected, id: "batch_b" }] })).toThrow();
    expect(() => validateBatchListObservation(before, after, 500, observation!.result.body)).toThrow();
    expect(adapter.validate({ query: { limit: 1 } }).query).toEqual({ limit: 1 });
    expect(adapter.validate({ query: { limit: 100 } }).query).toEqual({ limit: 100 });
    for (const input of [{ query: { limit: 0 } }, { query: { limit: 101 } }, { query: { after: "batch_a3" } }, { body: {} }]) expect(() => adapter.validate(input)).toThrow();
    expect((await list(f, "owner-a", "?limit=2")).body.batches.map(x => x.id)).toEqual(["batch_a3", "batch_a2"]);
    expect((await list(f, "owner-a", "?limit=1&after=batch_a3")).body.batches.map(x => x.id)).toEqual(["batch_a3"]);
    expect((await list(f, "owner-a", "?limit=0")).body.batches).toEqual([]);
    expect((await list(f, "owner-a", "?limit=-1")).body.batches).toHaveLength(3);
    for (const bad of ["x", "1.5", "9007199254740992"]) expect((await list(f, "owner-a", `?limit=${bad}`)).status).toBe(400);
    for (let i = 0; i < 103; i++) f.seed(`batch_z${String(i).padStart(3, "0")}`, "owner-a", 100);
    expect((await list(f, "owner-a")).body.batches).toHaveLength(100);
    expect((await list(f, "owner-a", "?limit=101")).body.batches).toHaveLength(101);
    expect(() => projectBatchList(({}))).toThrow();
    expect(batchReadPolicy).toEqual({ maximumListLimit: 100, maximumRawResponseBytes: 8 * 1024 * 1024, listCompleteness: "unknown", initialization: "confirmation-required", settlement: "unknown", replay: false });
    expect(validateBatchListQuery({ limit: 100 })).toEqual({ limit: 100 });
    for (const query of [{ limit: 0 }, { limit: -1 }, { limit: 101 }, { limit: 1.5 }, { limit: "2" }, { after: "batch_a3" }]) expect(() => validateBatchListQuery(query)).toThrow();
    expect(() => projectBatchList({ batches: new Array(101).fill({}) })).toThrow();
    complete.add("limit");
  } finally { f.close(); }
});

test("finite client projection omits source private fields and rejects malformed records", async () => {
  const f = seeded();
  try {
    const raw = await item(f, "batch_a2", "owner-a");
    expect(raw.status).toBe(200);
    expect(projectBatchItem(raw.body)).toEqual({ batch: expected });
    const view = projectBatchList((await list(f, "owner-a", "?limit=2")).body);
    expect(view.batches[1]).toEqual(expected);
    expect(() => adapter.project({ batches: new Array(101).fill(expected) })).toThrow();
    expect(() => adapter.project({ batches: [{ ...expected, status: "unknown" }] })).toThrow();
    expect(() => adapter.project({ batches: [{ ...expected, requestCountsTotal: 2 ** 40 }] })).toThrow();
    for (const text of ["private-input-path", "private-output-path", "private-metadata", "private-error", "owner-a", "apiKeyId"]) expect(JSON.stringify(view)).not.toContain(text);
    for (const batch of [{ ...expected, id: "" }, { ...expected, status: "unknown" }, { ...expected, createdAt: -1 }, { ...expected, requestCountsTotal: 2 ** 40 }, { ...expected, completedAt: "yesterday" }, null]) expect(() => projectBatchItem({ batch })).toThrow();
    expect(() => projectBatchItem({})).toThrow();
    expect(adapter.project((await list(f, "owner-a", "?limit=2")).body)).toEqual(view);
    complete.add("projection");
  } finally { f.close(); }
});

test("batch list candidate retains the handler scope and bounded incomplete view", () => {
  const contract = batchListContract();
  expect(contract.auth.sourcePolicy).toMatchObject({ routeClass: "management", handlerGuard: "none", handlerScope: "batch-list-resolve-scope" });
  expect(contract.request.querySchema).toMatchObject({ properties: { limit: { minimum: 1, maximum: 100 } }, additionalProperties: false });
  expect(contract.response.schema).toMatchObject({ properties: { batches: { maxItems: 100 } }, additionalProperties: false });
  expect(contract.pagination).toEqual({ mode: "none", parameters: [] });
  expect(contract.confirmation.required).toBe(true);
  expect(contract.retry.allowed).toBe(false);
  validateBatchListContract(contract);
  expect(() => validateBatchListContract({ ...contract, request: { ...contract.request, querySchema: { type: "object", additionalProperties: true } } })).toThrow();
  expect(() => validateBatchListContract({ ...contract, auth: { ...contract.auth, sourcePolicy: { ...contract.auth.sourcePolicy, handlerScope: undefined } } })).toThrow();
  expect(() => validateBatchListContract({ ...contract, response: { ...contract.response, schema: { type: "object", additionalProperties: true } } })).toThrow();
  expect(() => validateBatchListContract({ ...contract, retry: { allowed: true, maxAttempts: 2, statusCodes: [500] } })).toThrow();
  expect(() => validateBatchListContract({ ...contract, confirmation: { ...contract.confirmation, required: false } })).toThrow();
  complete.add("contract");
});

test("batch list requires its own ingress and lifecycle evidence domains", () => {
  expect(operationRequiresIngressEvidence("GET /api/batches")).toBe(true);
  expect(operationRequiresIngressEvidence("GET /api/batches/{id}")).toBe(false);
  const schema = JSON.parse(readFileSync(new URL("../contracts/release-eligibility.schema.json", import.meta.url), "utf8")) as { $defs: { operation: { allOf: Array<{ if: { properties: { operationId?: { const?: string } } }; then: { properties?: { effectEvidence?: { properties: { artifact: { pattern: string } } } } } }> } } };
  const clause = schema.$defs.operation.allOf.find(row => row.if.properties.operationId?.const === "GET /api/batches");
  const pattern = new RegExp(clause!.then.properties!.effectEvidence!.properties.artifact.pattern);
  expect(pattern.test(`provenance/qualification/batch-lifecycle-${"0".repeat(64)}.json`)).toBe(true);
  expect(pattern.test(`provenance/qualification/concurrency-lifecycle-${"0".repeat(64)}.json`)).toBe(false);
  expect(() => validateBatchLifecycleObservation({}, {})).toThrow();
  complete.add("evidence");
});

test("native batch receipt must match independently observed cold and warm outcomes", () => {
  const row = { idValid: true, status: "completed", createdAt: 20 };
  const digest = "1".repeat(64);
  const sources = { "src/app/api/batches/route.ts": "656711e21613d8a4c9f865117ae6011d9799e0d5e9eb5f7831560c0990210468", "src/app/api/batches/[id]/route.ts": digest, "src/app/api/v1/_helpers/apiKeyScope.ts": "d4b51c6415b6293b7801ee0b61eb2364ea0878db967db1e69bc6fce76da93463", "src/lib/db/batches.ts": "b7f2dd6f7bec9d6d48e6c82128bc4179df332b83eacf58f7a393eb65efc86276", "src/lib/db/migrations/028_create_files_and_batches.sql": "eb8407bed7d8585481aec17992ee5316eb204638470cf9ae95f6da1db7d68616", "src/lib/db/caseMapping.ts": digest, "src/lib/api/queryIntegerParam.ts": digest, "src/shared/constants/anonymousOwner.ts": digest, "src/shared/utils/cors.ts": digest, "src/server/cors/origins.ts": digest, "src/lib/db/core.ts": digest };
  Object.assign(sources, { "src/lib/db/files.ts": "0ab194070d59024e372885cac10258164f367de0d902d044d5af1bb399544708", "src/shared/constants/batch.ts": "083380ed3a9f268556990da30dad7c2a11b30665f3056c6dc6507e97a1648bd0", "src/lib/db/apiKeys.ts": "4e9bc2be404d6c74e1fbf9fc1d62b03853a84eead453ce70e2fc8cadd33673eb", "src/shared/utils/apiKey.ts": "da784cd366e9a5bff8eb54b2ad33b9e96a8d6dc33f18d145388128a20a56a813" });
  const { ["src/app/api/batches/[id]/route.ts"]: _detail, ...executed } = sources;
  const observation = {
    status: "research-observed", qualification: false,
    boundary: "Pinned batch list route, database and scope policy in isolated cold and warm native core processes; no HTTP ingress or job dispatch.",
    inputSha256: { fixture: digest },
    identity: { batchClosure: { sources, executed } },
    cold: { databaseExistedBefore: false, databaseExistsAfter: true, driver: "node:sqlite", first: [], populated: [row], rows: 1 },
    warm: { databaseExistedBefore: true, databaseExistsAfter: true, driver: "node:sqlite", first: [row], populated: [row], rows: 1 },
  };
  validateBatchLifecycleObservation(observation, structuredClone(observation));
  expect(() => validateBatchLifecycleObservation(observation, {})).toThrow();
  expect(() => validateBatchLifecycleObservation({ ...observation, warm: { ...observation.warm, rows: 0 } }, observation)).toThrow();
  expect(() => validateBatchLifecycleObservation({ ...observation, inputSha256: "bad" }, observation)).toThrow();
  const drifted = { ...observation, identity: { batchClosure: { ...observation.identity.batchClosure, sources: { ...sources, "src/lib/db/files.ts": digest } } } };
  expect(() => validateBatchLifecycleObservation(drifted, drifted)).toThrow();
  expect(() => validateBatchLifecycleObservation({ ...observation, qualification: true }, observation)).toThrow();
  complete.add("lifecycle");
});

test("batch executor admits only a bound dashboard cookie", async () => {
  const authDescriptor: OperationDescriptor = { ...descriptor, sideEffect: "read", confirmation: { required: false, reason: "Synthetic authorization test only." }, mutationSafety: null, response: { ...descriptor.response, schema: { type: "object", properties: { ok: { type: "boolean" } }, additionalProperties: false }, variants: [] } };
  const seen: unknown[] = [];
  const executor = createAdminExecutor({ registry: fixtureRegistry([authDescriptor]), dispatch: async (_request, context) => { seen.push(context.auth.credential); return { ok: true }; } });
  const profileId = "omniroute", endpoint = "http://127.0.0.1:20128";
  executor.setAdminBinding({ profileId, endpoint });
  await expect(executor.read(operationId, {}, { profileId, endpoint })).rejects.toMatchObject({ code: "credential-required" });
  for (const apiKey of ["oma_fixture_read", "ordinary-key", "management-key", "revoked-key"]) {
    executor.bindCredential({ profileId, endpoint, apiKey });
    await expect(executor.read(operationId, {})).rejects.toMatchObject({ code: "credential-required" });
  }
  expect(() => executor.bindCredential({ profileId, endpoint, apiKey: "key", cookie: "session=fixture" })).toThrow();
  expect(seen).toEqual([]);
  executor.bindCredential({ profileId, endpoint, cookie: "session=fixture" });
  await executor.read(operationId, {});
  expect(seen).toEqual([{ kind: "cookie", value: "session=fixture" }]);
  complete.add("executor");
});
