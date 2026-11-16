import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash, validateA2aHistoryContract } from "../scripts/generate-contracts.ts";
import { canonicalizeJson } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { A2aHistoryFixture, HISTORY_ID, historyContract, historyDescriptor } from "./fixtures/a2a-history.fixture.ts";

const registry = fixtureRegistry([historyDescriptor()]);
const testId = "test/admin-a2a-history.test.ts";
let observation: { before: unknown; after: unknown; result: { status: number; body: unknown } } | undefined;
const completed = new Set<string>();
test("history qualification rejects broadened query or unsafe lifecycle policy", () => {
  const contract = historyContract();
  expect(() => validateA2aHistoryContract(contract)).not.toThrow();
  expect(() => validateA2aHistoryContract({ ...contract, retry: { allowed: true, maxAttempts: 2, statusCodes: [500] } })).toThrow();
  expect(() => validateA2aHistoryContract({ ...contract, request: { ...contract.request, querySchema: { type: "object", additionalProperties: true } } })).toThrow();
  completed.add("contract");
});
afterAll(async () => {
  if (!observation || ["contract", "pagination", "filters", "invalid", "auth", "failure", "projection"].some(name => !completed.has(name))) return;
  const contract = historyContract();
  const binding = operationEvidenceBinding(HISTORY_ID, contract);
  const caseSha256 = testCaseSourceHash(testId);
  const artifactPath = outcomeArtifactPath(HISTORY_ID);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId: HISTORY_ID, testId, caseSha256, binding, observation })}\n`, { mode: 0o600 });
  testOutcomeHash(HISTORY_ID, testId, caseSha256, binding, contract, artifactPath);
});

const ownerA = createHash("sha256").update("fixture-owner-a").digest("hex").slice(0, 32);
const ownerB = createHash("sha256").update("fixture-owner-b").digest("hex").slice(0, 32);
const rows = [
  ["one", "completed", "alpha", null, "2026-01-01T00:00:00.000Z"],
  ["two", "working", "alpha", ownerA, "2026-01-02T00:00:00.000Z"],
  ["three", "failed", "beta", ownerB, "2026-01-03T00:00:00.000Z"],
  ["four", "completed", "alpha", ownerA, "2026-01-04T00:00:00.000Z"],
  ["five", "cancelled", null, null, "2026-01-05T00:00:00.000Z"],
] as const;
function seed(f: A2aHistoryFixture): void {
  const insert = f.db.prepare("INSERT INTO a2a_tasks (id,state,skill_id,api_key_id,created_at,updated_at,completed_at,input_json,output_json) VALUES (?,?,?,?,?,?,?,?,?)");
  for (const [id, state, skill, owner, date] of rows) insert.run(id, state, skill, owner, date, date, state === "completed" ? date : null, '{"password":"fixture-private-input"}', '{"token":"fixture-private-output"}');
}
async function page(f: A2aHistoryFixture, query: string, credential = "session"): Promise<{ response: Response; body: { tasks: Array<{ id: string }>; total: number; limit: number; offset: number } }> {
  const response = await f.handle(query, credential);
  return { response, body: await response.json() as { tasks: Array<{ id: string }>; total: number; limit: number; offset: number } };
}

test("real pinned SQL paginates independently and enforces owner plus unowned visibility", async () => {
  const f = new A2aHistoryFixture();
  try {
    seed(f);
    const before = f.db.query("SELECT count(*) AS rows FROM a2a_tasks").get();
    const first = await page(f, "?limit=2&offset=0");
    const second = await page(f, "?limit=2&offset=2");
    const third = await page(f, "?limit=2&offset=4");
    const beyond = await page(f, "?limit=2&offset=8");
    expect([first.response.status, second.response.status, third.response.status, beyond.response.status]).toEqual([200, 200, 200, 200]);
    expect([first, second, third, beyond].map(p => [p.body.tasks.map(t => t.id), p.body.total, p.body.limit, p.body.offset])).toEqual([
      [["five", "four"], 5, 2, 0], [["three", "two"], 5, 2, 2], [["one"], 5, 2, 4], [[], 5, 2, 8],
    ]);
    const a1 = await page(f, "?limit=2", "fixture-owner-a");
    const a2 = await page(f, "?limit=2&offset=2", "fixture-owner-a");
    const b = await page(f, "", "fixture-owner-b");
    expect([a1.body.tasks.map(t => t.id), a2.body.tasks.map(t => t.id), a1.body.total, a2.body.total]).toEqual([["five", "four"], ["two", "one"], 4, 4]);
    expect([b.body.tasks.map(t => t.id), b.body.total]).toEqual([["five", "three", "one"], 3]);
    const defaults = await page(f, "");
    expect([defaults.body.limit, defaults.body.offset]).toEqual([100, 0]);
    expect((await page(f, "?limit=501")).body.limit).toBe(500);
    expect((await page(f, "?limit=500")).body.limit).toBe(500);
    const after = f.db.query("SELECT count(*) AS rows FROM a2a_tasks").get();
    expect(after).toEqual(before);
    const projected = registry.require(HISTORY_ID).project(first.body);
    observation = { before, after, result: { status: first.response.status, body: projected } };
    completed.add("pagination");
  } finally { f.close(); }
});

test("inclusive time filters, combined filters and empty results are applied by pinned SQL", async () => {
  const f = new A2aHistoryFixture();
  try {
    seed(f);
    const from = encodeURIComponent("2026-01-02T00:00:00.000Z");
    const to = encodeURIComponent("2026-01-04T00:00:00.000Z");
    expect((await page(f, `?from=${from}&to=${to}`)).body.tasks.map(t => t.id)).toEqual(["four", "three", "two"]);
    expect((await page(f, `?from=${from}`)).body.total).toBe(4);
    expect((await page(f, `?to=${to}`)).body.total).toBe(4);
    expect((await page(f, `?from=${from}&to=${to}&skill=alpha&state=completed`, "fixture-owner-a")).body.tasks.map(t => t.id)).toEqual(["four"]);
    expect((await page(f, "?skill=absent")).body).toEqual({ tasks: [], total: 0, limit: 100, offset: 0 });
    completed.add("filters");
  } finally { f.close(); }
});

test("closed client request and upstream malformed URL parameters fail safely", async () => {
  const adapter = registry.require(HISTORY_ID);
  expect(adapter.validate({})).toEqual({ path: {}, query: {} });
  expect(adapter.validate({ query: { from: "2026-01-02T00:00:00.000Z", state: "working", limit: 501, offset: 0 } })).toBeDefined();
  for (const input of [{ query: { unknown: "x" } }, { body: {} }, { query: { limit: 0 } }, { query: { offset: -1 } }, { query: { state: "unknown" } }, { query: { skill: "" } }, { query: { limit: "2" } }]) expect(() => adapter.validate(input)).toThrow();
  const f = new A2aHistoryFixture();
  try {
    for (const query of ["?from=not-a-date", "?to=2026-13-01T00%3A00%3A00Z", "?skill=", "?state=unknown", "?limit=0", "?limit=-1", "?limit=1.5", "?limit=no", "?offset=-1", "?offset=1.5"]) {
      const response = await f.handle(query, "session");
      expect(response.status).toBe(400);
    }
    completed.add("invalid");
  } finally { f.close(); }
});

test("handler credential decisions are distinct from central management ingress", async () => {
  const f = new A2aHistoryFixture();
  try {
    seed(f);
    expect((await f.handle("", "session")).status).toBe(200);
    expect((await f.handle("", "fixture-owner-a")).status).toBe(200);
    expect([401, 403]).toContain((await f.handle("", "invalid-fixture-secret")).status);
    expect([401, 403]).toContain((await f.handle("", "invalid-fixture-secret", true)).status);
    expect([401, 403]).toContain((await f.handle("", "fixture-owner-a", true)).status);
    expect((await f.handle("", "oma_fixture-read", true)).status).toBe(200);
    expect((await f.handle("", "fixture-manage", true)).status).toBe(200);
    expect((await f.handle("", "session", true)).status).toBe(200);
    expect([401, 403]).toContain((await f.handle("", undefined)).status);
    expect([401, 403]).toContain((await f.handle("", undefined, false, false)).status);
    f.requireApiKey = false;
    expect((await f.handle("", "fixture-owner-a")).status).toBe(200);
    expect((await f.handle("", "oma_fixture-read", true)).status).toBe(200);
    expect((await f.handle("", undefined, false, false)).status).toBe(200);
    completed.add("auth");
  } finally { f.close(); }
});

test("storage errors are not a successful empty history and do not project message text", async () => {
  const f = new A2aHistoryFixture();
  try {
    f.fail = true;
    const response = await f.handle("", "session");
    expect(response.status).toBe(500);
    const body = await response.json();
    // The pinned builder may preserve an innocuous-looking private backend message.
    expect(JSON.stringify(body)).toContain("fixture-private-storage-marker");
    expect(() => registry.require(HISTORY_ID).project(body)).toThrow();
    completed.add("failure");
  } finally { f.close(); }
});

test("provider projection omits non-history columns and injected secrets", async () => {
  const f = new A2aHistoryFixture();
  try {
    seed(f);
    const result = await page(f, "?limit=2");
    const projected = registry.require(HISTORY_ID).project(result.body);
    expect(projected).toEqual(result.body);
    const text = JSON.stringify(projected);
    expect(text).not.toContain("fixture-private");
    expect(text).not.toContain("api_key_id");
    const enriched = { ...result.body, password: "secret", tasks: result.body.tasks.map(task => ({ ...task, input_json: "secret", api_key_id: "secret" })) };
    expect(JSON.stringify(registry.require(HISTORY_ID).project(enriched))).not.toContain("secret");
    completed.add("projection");
  } finally { f.close(); }
});
