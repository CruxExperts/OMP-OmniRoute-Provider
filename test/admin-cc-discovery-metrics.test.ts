import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash } from "../scripts/generate-contracts.ts";
import { canonicalizeJson } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { CC_DISCOVERY_METRICS_ID, CcDiscoveryMetricsFixture, ccDiscoveryMetricsContract, ccDiscoveryMetricsDescriptor } from "./fixtures/cc-discovery-metrics.fixture.ts";

const testId = "test/admin-cc-discovery-metrics.test.ts";
const registry = fixtureRegistry([ccDiscoveryMetricsDescriptor()]);
const cases = new Set<string>();
let observation: { before: unknown; after: unknown; result: { status: number; body: unknown } } | undefined;

afterAll(async () => {
  if (!observation || !["read", "authorization", "store-failure", "schema"].every(name => cases.has(name))) return;
  const contract = ccDiscoveryMetricsContract();
  const binding = operationEvidenceBinding(CC_DISCOVERY_METRICS_ID, contract);
  const caseSha256 = testCaseSourceHash(testId);
  const artifactPath = outcomeArtifactPath(CC_DISCOVERY_METRICS_ID);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId: CC_DISCOVERY_METRICS_ID, testId, caseSha256, binding, observation })}\n`, { mode: 0o600 });
  testOutcomeHash(CC_DISCOVERY_METRICS_ID, testId, caseSha256, binding, contract, artifactPath);
});

function state(fixture: CcDiscoveryMetricsFixture): unknown {
  return {
    schema: fixture.db.query("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all(),
    rows: fixture.db.query("SELECT namespace, key, value FROM key_value ORDER BY namespace, key").all(),
  };
}

test("receipt-verified route reads actual persisted aggregate counters without changing the store", async () => {
  const fixture = new CcDiscoveryMetricsFixture();
  try {
    const initial = await fixture.handle("oma_fixture-read");
    expect(initial.status).toBe(200);
    expect(await initial.json()).toEqual({ aliasRequests: 0, discoveryHits: 0, byModel: {} });
    fixture.alias("alpha/model"); fixture.alias("alpha/model"); fixture.alias("beta"); fixture.alias("");
    fixture.hit(); fixture.hit();
    fixture.db.prepare("INSERT INTO key_value VALUES (?, ?, ?)").run("other", "req:total", "999");
    const before = state(fixture);
    const response = await fixture.handle("oma_fixture-read");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    const body = await response.json();
    expect(body).toEqual({ aliasRequests: 4, discoveryHits: 2, byModel: { "alpha/model": 2, beta: 1 } });
    expect(registry.require(CC_DISCOVERY_METRICS_ID).project(body)).toEqual(body);
    const after = state(fixture);
    expect(after).toEqual(before);
    observation = { before, after, result: { status: response.status, body } };
    cases.add("read");
  } finally { fixture.close(); }
});

test("management authorization and closed request schema protect the read", async () => {
  const fixture = new CcDiscoveryMetricsFixture();
  try {
    fixture.alias("alpha/model");
    const before = state(fixture);
    for (const credential of [undefined, "invalid-fixture-secret", "fixture-unscoped"]) {
      const response = await fixture.handle(credential);
      expect([401, 403]).toContain(response.status);
      const body = await response.json();
      expect(JSON.stringify(body)).not.toContain("invalid-fixture-secret");
      expect(JSON.stringify(body)).not.toContain("alpha/model");
      expect(state(fixture)).toEqual(before);
    }
    for (const credential of ["fixture-manage", "oma_fixture-read"]) {
      const response = await fixture.handle(credential);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ aliasRequests: 1, discoveryHits: 0, byModel: { "alpha/model": 1 } });
    }
    const adapter = registry.require(CC_DISCOVERY_METRICS_ID);
    expect(adapter.validate({})).toEqual({ path: {}, query: {} });
    expect(() => adapter.validate({ query: { extra: "x" } })).toThrow();
    expect(() => adapter.validate({ body: {} })).toThrow();
    expect(state(fixture)).toEqual(before);
    cases.add("authorization");
  } finally { fixture.close(); }
});

test("database errors return indistinguishable zeros, not evidence of an empty store", async () => {
  const fixture = new CcDiscoveryMetricsFixture();
  try {
    fixture.alias("alpha/model"); fixture.hit();
    const before = state(fixture);
    fixture.failOpen = true;
    fixture.alias("ignored"); fixture.hit();
    const failed = await fixture.handle("oma_fixture-read");
    expect(failed.status).toBe(200);
    const failureBody = await failed.json();
    expect(failureBody).toEqual({ aliasRequests: 0, discoveryHits: 0, byModel: {} });
    expect(JSON.stringify(failureBody)).not.toContain("fixture-private-database-error");
    fixture.failOpen = false;
    expect(state(fixture)).toEqual(before);
    const recovered = await fixture.handle("oma_fixture-read");
    expect(await recovered.json()).toEqual({ aliasRequests: 1, discoveryHits: 1, byModel: { "alpha/model": 1 } });
    fixture.db.exec("DROP TABLE key_value");
    const missingTable = await fixture.handle("oma_fixture-read");
    expect(missingTable.status).toBe(200);
    expect(await missingTable.json()).toEqual(failureBody);
    cases.add("store-failure");
  } finally { fixture.close(); }
});

test("store normalizes malformed counters and response projection enforces its schema", async () => {
  const fixture = new CcDiscoveryMetricsFixture();
  try {
    const insert = fixture.db.prepare("INSERT INTO key_value VALUES ('ccDiscoveryMetrics', ?, ?)");
    insert.run("req:total", "-9"); insert.run("discovery:hits", "not-a-number");
    insert.run("req:model:alpha", "12tail"); insert.run("req:model:beta", "-1"); insert.run("unrelated", "999");
    const before = state(fixture);
    const response = await fixture.handle("oma_fixture-read");
    const body = await response.json();
    expect(body).toEqual({ aliasRequests: 0, discoveryHits: 0, byModel: { alpha: 12, beta: 0 } });
    const adapter = registry.require(CC_DISCOVERY_METRICS_ID);
    expect(adapter.project(body)).toEqual(body);
    expect(state(fixture)).toEqual(before);
    expect(() => adapter.project({ aliasRequests: "secret", discoveryHits: 0, byModel: {} })).toThrow();
    const projected = adapter.project({ aliasRequests: 1, discoveryHits: 2, byModel: { alpha: 3, password: 7 } });
    expect(JSON.stringify(projected)).not.toContain("password");
    expect(projected).toEqual({ aliasRequests: 1, discoveryHits: 2, byModel: { alpha: 3 } });
    cases.add("schema");
  } finally { fixture.close(); }
});
