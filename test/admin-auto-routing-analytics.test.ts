import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash, validateAutoRoutingAnalyticsContract } from "../scripts/generate-contracts.ts";
import { canonicalizeJson } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { ANALYTICS_ID, AutoRoutingAnalyticsFixture, analyticsContract, analyticsDescriptor } from "./fixtures/auto-routing-analytics.fixture.ts";

const adapter = fixtureRegistry([analyticsDescriptor()]).require(ANALYTICS_ID);
const testId = "test/admin-auto-routing-analytics.test.ts";
const completed = new Set<string>();
let observation: { before: unknown; after: unknown; result: { status: number; body: unknown } } | undefined;
afterAll(async () => {
  if (!observation || ["request", "empty", "aggregation", "cap", "failures", "auth", "projection"].some(name => !completed.has(name))) return;
  const contract = analyticsContract();
  const binding = operationEvidenceBinding(ANALYTICS_ID, contract);
  const caseSha256 = testCaseSourceHash(testId);
  const artifactPath = outcomeArtifactPath(ANALYTICS_ID);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId: ANALYTICS_ID, testId, caseSha256, binding, observation })}\n`, { mode: 0o600 });
  testOutcomeHash(ANALYTICS_ID, testId, caseSha256, binding, contract, artifactPath);
});

const zero = { totalRequests: 0, variantBreakdown: {}, topProviders: [] };
function insert(f: AutoRoutingAnalyticsFixture, model: string, provider: string | null, type: string | null = null): void {
  f.db.prepare("INSERT INTO call_logs VALUES (?, ?, ?, ?, ?, ?)").run(model, type, provider, "fixture-private-error", "fixture-private-key", "fixture-private-body");
}
async function result(f: AutoRoutingAnalyticsFixture): Promise<{ status: number; body: unknown }> {
  const response = await f.handle("fixture-manage");
  return { status: response.status, body: await response.json() };
}

test("closed client request retains uncertain initialization and forbids replay", () => {
  expect(adapter.validate({})).toEqual({ path: {}, query: {} });
  for (const input of [{ query: { extra: "x" } }, { path: { extra: "x" } }, { body: {} }]) expect(() => adapter.validate(input)).toThrow();
  const contract = analyticsContract();
  expect(contract.sideEffect).toBe("lifecycle");
  expect(contract.confirmation.required).toBe(true);
  expect(() => validateAutoRoutingAnalyticsContract(contract)).not.toThrow();
  expect(() => validateAutoRoutingAnalyticsContract({ ...contract, retry: { allowed: true, maxAttempts: 2, statusCodes: [500] } })).toThrow();
  expect(() => validateAutoRoutingAnalyticsContract({ ...contract, request: { ...contract.request, querySchema: { type: "object", additionalProperties: true } } })).toThrow();
  expect(contract.retry.allowed).toBe(false);
  expect(contract.mutationSafety?.reconciliation.kind).toBe("unknown");
  completed.add("request");
});

test("empty source produces the actual zero shape", async () => {
  const f = new AutoRoutingAnalyticsFixture();
  try { expect(await result(f)).toEqual({ status: 200, body: zero }); expect(f.calls).toBe(3); completed.add("empty"); }
  finally { f.close(); }
});

test("actual pinned SQL counts logical auto calls and excludes private columns", async () => {
  const f = new AutoRoutingAnalyticsFixture();
  try {
    insert(f, "auto", "alpha"); insert(f, "auto", "alpha");
    insert(f, "auto/fast", "beta"); insert(f, "auto/fast", " ");
    insert(f, "auto/smart", null); insert(f, "auto/fast", "alpha", "upstream_http_attempt");
    insert(f, "other", "alpha"); insert(f, "automatic", "alpha");
    const before = f.db.query("SELECT count(*) AS rows FROM call_logs").get();
    const actual = await result(f);
    const after = f.db.query("SELECT count(*) AS rows FROM call_logs").get();
    expect(after).toEqual(before);
    expect(actual).toEqual({ status: 200, body: { totalRequests: 5, variantBreakdown: { default: 2, fast: 2, smart: 1 }, topProviders: [{ provider: "alpha", count: 2 }, { provider: "beta", count: 1 }] } });
    expect(adapter.project(actual.body)).toEqual(actual.body);
    expect(JSON.stringify(actual.body)).not.toContain("fixture-private");
    observation = { before, after, result: { status: actual.status, body: adapter.project(actual.body) } };
    completed.add("aggregation");
  } finally { f.close(); }
});

test("provider list is descending and limited to ten without imposing tie ordering", async () => {
  const f = new AutoRoutingAnalyticsFixture();
  try {
    for (let i = 0; i < 11; i++) for (let n = 0; n < 12 - i; n++) insert(f, "auto/cap", `p${i}`);
    const actual = await result(f);
    const body = actual.body as { totalRequests: number; topProviders: Array<{ provider: string; count: number }> };
    expect(actual.status).toBe(200); expect(body.totalRequests).toBe(77);
    expect(body.topProviders).toEqual(Array.from({ length: 10 }, (_, i) => ({ provider: `p${i}`, count: 12 - i })));
    insert(f, "auto/cap", "p10");
    const tied = (await result(f)).body as { topProviders: Array<{ provider: string; count: number }> };
    expect(tied.topProviders).toHaveLength(10);
    expect(tied.topProviders.map(row => row.count)).toEqual([12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
    const last = tied.topProviders[9];
    expect(last).toBeDefined();
    if (!last) throw new Error("Missing tenth provider");
    expect(["p9", "p10"]).toContain(last.provider);
    completed.add("cap");
  } finally { f.close(); }
});

test("each independent backend failure is caught as zero-shaped 200, not evidence of empty data", async () => {
  const f = new AutoRoutingAnalyticsFixture();
  try {
    insert(f, "auto", "alpha");
    for (const call of [1, 2, 3]) {
      f.failAt = call;
      const actual = await result(f);
      expect(f.calls).toBe(call);
      expect(actual).toEqual({ status: 200, body: zero });
      expect(JSON.stringify(actual)).not.toContain("fixture-private");
      expect(f.db.query("SELECT count(*) AS rows FROM call_logs").get()).toEqual({ rows: 1 });
    }
    f.failAt = 0; expect((await result(f)).body).not.toEqual(zero);
    completed.add("failures");
  } finally { f.close(); }
});

test("actual management dispatcher separates allowed and denied credentials", async () => {
  const f = new AutoRoutingAnalyticsFixture();
  try {
    for (const credential of ["fixture-manage", "fixture-admin", "oma_fixture-read", "session"]) expect((await f.handle(credential)).status).toBe(200);
    for (const credential of [undefined, "invalid-fixture-secret", "fixture-unscoped"]) {
      const response = await f.handle(credential);
      expect([401, 403]).toContain(response.status); expect(f.calls).toBe(0);
      expect(JSON.stringify(await response.json())).not.toContain("invalid-fixture-secret");
    }
    expect((await f.handle(undefined, false, false)).status).toBe(200);
    const urlToken = await f.handle(undefined, true, true, "?api_key=fixture-manage");
    expect([401, 403]).toContain(urlToken.status); expect(f.calls).toBe(0);
    const failure = await f.handle("fixture-auth-error", false, true);
    expect(failure.status).toBe(503); expect(f.calls).toBe(0);
    expect(JSON.stringify(await failure.json())).not.toContain("fixture-private-auth-error");
    completed.add("auth");
  } finally { f.close(); }
});

test("projection drops injected private fields from aggregates and rows", () => {
  const value = { totalRequests: 1, variantBreakdown: { fast: 1 }, topProviders: [{ provider: "alpha", count: 1, api_key_id: "fixture-private" }], error_summary: "fixture-private" };
  expect(adapter.project(value)).toEqual({ totalRequests: 1, variantBreakdown: { fast: 1 }, topProviders: [{ provider: "alpha", count: 1 }] });
  completed.add("projection");
});
