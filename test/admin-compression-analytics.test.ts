import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash, validateCompressionAnalyticsContract } from "../scripts/generate-contracts.ts";
import { canonicalizeJson, isSecretOutputField } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { COMPRESSION_ID, CompressionAnalyticsFixture, compressionContract, compressionDescriptor } from "./fixtures/compression-analytics.fixture.ts";

const adapter = fixtureRegistry([compressionDescriptor()]).require(COMPRESSION_ID);
const testId = "test/admin-compression-analytics.test.ts";
const completed = new Set<string>();
let observation: { before: unknown; after: unknown; result: { status: number; body: unknown } } | undefined;
afterAll(async () => {
  if (!observation || ["request", "empty", "schema", "periods", "failure", "auth", "projection", "metric-privacy"].some(name => !completed.has(name))) return;
  const contract = compressionContract();
  const binding = operationEvidenceBinding(COMPRESSION_ID, contract);
  const caseSha256 = testCaseSourceHash(testId);
  const artifactPath = outcomeArtifactPath(COMPRESSION_ID);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId: COMPRESSION_ID, testId, caseSha256, binding, observation })}\n`, { mode: 0o600 });
  testOutcomeHash(COMPRESSION_ID, testId, caseSha256, binding, contract, artifactPath);
});

async function result(f: CompressionAnalyticsFixture, query = ""): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await f.handle("fixture-manage", query);
  return { status: response.status, body: await response.json() as Record<string, unknown> };
}
function columns(f: CompressionAnalyticsFixture): string[] {
  return (f.db.query("PRAGMA table_info(compression_analytics)").all() as Array<{ name: string }>).map(row => row.name);
}
function insert(f: CompressionAnalyticsFixture, timestamp: string, saved: number, skip: string | null = null): void {
  f.db.prepare("INSERT INTO compression_analytics (timestamp, provider, combo_id, request_id, mode, original_tokens, compressed_tokens, tokens_saved, duration_ms, skip_reason, compression_combo_id, receipt_source, actual_prompt_tokens, actual_total_tokens, estimated_usd_saved, validation_fallback, mcp_description_tokens_saved) VALUES (?, ?, ?, ?, ?, 100, ?, ?, 20, ?, ?, ?, 80, 80, 0.01, 1, 3)")
    .run(timestamp, "fixture-private-provider", "fixture-private-combo", "fixture-private-request", "fixture-private-mode", 100 - saved, saved, skip, "fixture-private-compression-combo", "fixture-private-source");
}

test("closed request accepts only documented periods and retains uncertain lifecycle", () => {
  expect(adapter.validate({})).toEqual({ path: {}, query: {} });
  for (const since of ["24h", "7d", "30d", "all"]) expect(adapter.validate({ query: { since } }).query).toEqual({ since });
  for (const input of [{ query: { since: "unknown" } }, { query: { extra: "x" } }, { path: { extra: "x" } }, { body: {} }]) expect(() => adapter.validate(input)).toThrow();
  const contract = compressionContract();
  expect(() => validateCompressionAnalyticsContract(contract)).not.toThrow();
  expect(() => validateCompressionAnalyticsContract({ ...contract, retry: { allowed: true, maxAttempts: 2, statusCodes: [500] } })).toThrow();
  expect(() => validateCompressionAnalyticsContract({ ...contract, request: { ...contract.request, querySchema: { type: "object", additionalProperties: true } } })).toThrow();
  expect(contract.sideEffect).toBe("lifecycle"); expect(contract.confirmation.required).toBe(true);
  expect(contract.retry.allowed).toBe(false); expect(contract.mutationSafety?.reconciliation.kind).toBe("unknown");
  completed.add("request");
});

test("empty SQL result is an actual zero aggregate with a fixed chart", async () => {
  const f = new CompressionAnalyticsFixture();
  try {
    const actual = await result(f);
    expect(actual.status).toBe(200); expect(actual.body.totalRequests).toBe(0); expect(actual.body.totalTokensSaved).toBe(0);
    expect(actual.body.totalSkipped).toBe(0); expect(actual.body.last24h).toHaveLength(24);
    expect((actual.body.last24h as Array<{ count: number }>).every(row => row.count === 0)).toBe(true);
    completed.add("empty");
  } finally { f.close(); }
});

test("first SQL read adds missing columns and later reads leave schema unchanged", async () => {
  const f = new CompressionAnalyticsFixture();
  try {
    const before = columns(f); expect(before).not.toContain("skip_reason"); expect(before).not.toContain("receipt_source");
    expect((await result(f)).status).toBe(200);
    const after = columns(f); expect(after).toContain("skip_reason"); expect(after).toContain("receipt_source"); expect(after.length).toBe(before.length + 18);
    expect((await result(f)).status).toBe(200); expect(columns(f)).toEqual(after);
    completed.add("schema");
  } finally { f.close(); }
});

test("period filters and chart use independent SQL cutoffs; skipped rows stay separate", async () => {
  const f = new CompressionAnalyticsFixture();
  try {
    await result(f); // Materialize the source's lazy columns before inserting extended rows.
    insert(f, "2026-11-16T11:30:00.000Z", 30);
    insert(f, "2026-11-14T12:30:00.000Z", 20);
    insert(f, "2026-11-01T12:30:00.000Z", 10);
    insert(f, "2026-10-01T12:30:00.000Z", 5);
    insert(f, "2026-11-16T10:30:00.000Z", 0, "fixture-private-skip");
    const before = { columns: columns(f), rows: f.db.query("SELECT count(*) AS count FROM compression_analytics").get() };
    const values = [];
    for (const query of ["", "?since=24h", "?since=unknown", "?since=7d", "?since=30d", "?since=all"]) values.push(await result(f, query));
    expect(values.map(value => value.status)).toEqual([200, 200, 200, 200, 200, 200]);
    expect(values.map(value => value.body.totalRequests)).toEqual([1, 1, 1, 2, 3, 4]);
    expect(values.map(value => value.body.totalTokensSaved)).toEqual([30, 30, 30, 50, 60, 65]);
    expect(values.map(value => value.body.totalSkipped)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(values.map(value => value.body.last24h)).toEqual(Array(6).fill(values[0]!.body.last24h));
    expect((values[5]!.body.last24h as Array<{ count: number }>).reduce((sum, row) => sum + row.count, 0)).toBe(1);
    expect(values[0]!.body.validationFallbacks).toBe(1);
    expect(values[0]!.body.mcpDescriptionCompression).toEqual({ snapshots: 1, estimatedTokensSaved: 3 });
    const after = { columns: columns(f), rows: f.db.query("SELECT count(*) AS count FROM compression_analytics").get() };
    expect(after).toEqual(before);
    const projected = adapter.project(values[5]!.body);
    expect(JSON.stringify(projected)).not.toContain("fixture-private");
    observation = { before, after, result: { status: values[5]!.status, body: projected } };
    completed.add("periods");
  } finally { f.close(); }
});

test("SQL failures return generic 500 rather than an incomplete aggregate", async () => {
  const f = new CompressionAnalyticsFixture();
  try {
    f.failDb = true;
    const response = await f.handle("fixture-manage");
    expect(response.status).toBe(500); expect(await response.json()).toEqual({ error: "Internal server error" });
    f.failDb = false;
    expect((await result(f)).status).toBe(200);
    f.db.exec("DROP TABLE compression_analytics");
    const sqlFailure = await f.handle("fixture-manage");
    expect(sqlFailure.status).toBe(500); expect(await sqlFailure.json()).toEqual({ error: "Internal server error" });
    completed.add("failure");
  } finally { f.close(); }
});

test("actual management auth denies before database and does not disclose backend errors", async () => {
  const f = new CompressionAnalyticsFixture();
  try {
    for (const credential of [undefined, "invalid-fixture-secret", "fixture-unscoped"]) {
      const response = await f.handle(credential); expect([401, 403]).toContain(response.status); expect(f.calls).toBe(0);
      expect(JSON.stringify(await response.json())).not.toContain("invalid-fixture-secret");
    }
    const query = await f.handle(undefined, "?api_key=fixture-manage"); expect([401, 403]).toContain(query.status); expect(f.calls).toBe(0);
    const failure = await f.handle("fixture-auth-error", "", false, true); expect(failure.status).toBe(503); expect(f.calls).toBe(0);
    expect(JSON.stringify(await failure.json())).not.toContain("fixture-private-auth-error");
    for (const credential of ["fixture-manage", "fixture-admin", "oma_fixture-read", "session"]) expect((await f.handle(credential)).status).toBe(200);
    expect((await f.handle(undefined, "", false, false)).status).toBe(200);
    completed.add("auth");
  } finally { f.close(); }
});

test("projection removes all private source groupings and nested injected fields", async () => {
  const f = new CompressionAnalyticsFixture();
  try {
    const actual = await result(f);
    const body = { ...actual.body, byProvider: { "fixture-private": 1 }, byCompressionCombo: { "fixture-private": 1 }, bySkipReason: { "fixture-private": 1 }, byMode: { "fixture-private": 1 }, byEngine: { "fixture-private": 1 }, realUsage: { ...(actual.body.realUsage as object), bySource: { "fixture-private": 1 } }, last24h: (actual.body.last24h as object[]).map(row => ({ ...row, private: "fixture-private" })) };
    const projected = adapter.project(body);
    expect(JSON.stringify(projected)).not.toContain("fixture-private");
    if (!projected || typeof projected !== "object" || !("last24h" in projected)) throw new Error("Missing projected chart");
    expect(projected.last24h).toHaveLength(24);
    completed.add("projection");
  } finally { f.close(); }
});

test("numeric metric exception binds exact operation, source and path; explicit secrets win", () => {
  const identity = { operationId: COMPRESSION_ID, sha256: "4159741eb6a3a6f0529bf290d0ec2287c56ff604af7ffb7a1689f36353c40fd5", gitBlobSha: "7006cac6eba75683d773afe1b1a1967607063e0f" };
  expect(isSecretOutputField("tokensSaved", 42, ["last24h"], [], identity)).toBe(false);
  expect(isSecretOutputField("tokensSaved", "private", ["last24h"], [], identity)).toBe(true);
  expect(isSecretOutputField("tokensSaved", 42, ["other"], [], identity)).toBe(true);
  expect(isSecretOutputField("tokensSaved", 42, ["last24h"], ["last24h.tokensSaved"], identity)).toBe(true);
  expect(isSecretOutputField("tokensSaved", 42, ["last24h"], [], { ...identity, sha256: "0".repeat(64) })).toBe(true);
  expect(isSecretOutputField("tokensSaved", 42, ["last24h"], [], { ...identity, operationId: "GET /other" })).toBe(true);
  completed.add("metric-privacy");
});
