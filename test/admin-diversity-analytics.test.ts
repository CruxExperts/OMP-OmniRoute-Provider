import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash, validateDiversityAnalyticsContract } from "../scripts/generate-contracts.ts";
import { canonicalizeJson } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { DIVERSITY_ID, DiversityAnalyticsFixture, diversityContract, diversityDescriptor } from "./fixtures/diversity-analytics.fixture.ts";

const adapter = fixtureRegistry([diversityDescriptor()]).require(DIVERSITY_ID);
const testId = "test/admin-diversity-analytics.test.ts";
const completed = new Set<string>();
let observation: { before: unknown; after: unknown; result: { status: number; body: unknown } } | undefined;
afterAll(async () => {
  if (!observation || ["request", "producer", "window", "auth", "error", "projection"].some(name => !completed.has(name))) return;
  const contract = diversityContract();
  const binding = operationEvidenceBinding(DIVERSITY_ID, contract);
  const caseSha256 = testCaseSourceHash(testId);
  const artifactPath = outcomeArtifactPath(DIVERSITY_ID);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId: DIVERSITY_ID, testId, caseSha256, binding, observation })}\n`, { mode: 0o600 });
  testOutcomeHash(DIVERSITY_ID, testId, caseSha256, binding, contract, artifactPath);
});

test("closed request and lifecycle candidate do not authorize replay", () => {
  expect(adapter.validate({})).toEqual({ path: {}, query: {} });
  for (const input of [{ path: { extra: "x" } }, { query: { extra: "x" } }, { body: {} }]) expect(() => adapter.validate(input)).toThrow();
  const contract = diversityContract();
  expect(() => validateDiversityAnalyticsContract(contract)).not.toThrow();
  expect(() => validateDiversityAnalyticsContract({ ...contract, retry: { allowed: true, maxAttempts: 2, statusCodes: [500] } })).toThrow();
  expect(() => validateDiversityAnalyticsContract({ ...contract, request: { ...contract.request, querySchema: { type: "object", additionalProperties: true } } })).toThrow();
  expect(() => validateDiversityAnalyticsContract({ ...contract, response: { ...contract.response, schema: { type: "object", additionalProperties: true } } })).toThrow();
  expect(contract.auth.domain).toBe("management");
  expect(contract.confirmation.required).toBe(true);
  expect(contract.retry.allowed).toBe(false);
  expect(contract.mutationSafety?.reconciliation.kind).toBe("unknown");
  completed.add("request");
});
const f = new DiversityAnalyticsFixture();
const epoch = Date.parse("2026-01-01T00:00:00Z");
beforeEach(() => { f.owner.resetDiversity(); f.now = epoch; });
async function result(): Promise<{ status: number; body: unknown }> {
  const response = await f.handle("fixture-manage");
  return { status: response.status, body: await response.json() };
}
function record(provider: string | undefined, success = true, model: string | null = null): void {
  f.metrics.recordComboRequest("fixture-combo", model, { success, latencyMs: 1, ...(provider === undefined ? {} : { target: { provider, connectionId: "fixture-private-connection" } }) });
}

test("empty report and actual success-only combo producer", async () => {
  expect(await result()).toEqual({ status: 200, body: { score: 1, totalRequests: 0, providers: {}, windowSize: 200, ttlMs: 3_600_000 } });
  record(" alpha ", true, "fixture-private-model"); record("alpha"); record("beta");
  record("ignored", false); record(" "); record(undefined);
  const before = f.owner.getDiversityReport();
  const actual = await result();
  expect(actual).toEqual({ status: 200, body: { score: expect.closeTo(0.9182958340544896), totalRequests: 3, providers: { alpha: { count: 2, share: 2 / 3 }, beta: { count: 1, share: 1 / 3 } }, windowSize: 200, ttlMs: 3_600_000 } });
  const projected = adapter.project(actual.body);
  expect(projected).toEqual({ score: expect.closeTo(0.9182958340544896), totalRequests: 3, windowSize: 200, ttlMs: 3_600_000 });
  const after = f.owner.getDiversityReport();
  expect(after).toEqual(before);
  observation = { before, after, result: { status: actual.status, body: projected } };
  expect(JSON.stringify(actual)).not.toContain("fixture-private");
  completed.add("producer");
});

test("window eviction and TTL boundary filter reads but recording prunes", async () => {
  f.owner.configureDiversity({ windowSize: 2, ttlMs: 100 });
  f.now = epoch + 1; f.owner.recordProviderUsage("first");
  f.now = epoch + 2; f.owner.recordProviderUsage("second");
  f.now = epoch + 3; f.owner.recordProviderUsage("third");
  expect(f.owner.getDiversityReport().providers).toEqual({ second: { count: 1, share: 0.5 }, third: { count: 1, share: 0.5 } });
  f.now = epoch + 102;
  expect(f.owner.getDiversityReport().totalRequests).toBe(2);
  f.now = epoch + 103;
  expect(f.owner.getDiversityReport().totalRequests).toBe(1);
  f.now = epoch + 3;
  expect(f.owner.getDiversityReport().totalRequests).toBe(2);
  f.now = epoch + 104; f.owner.recordProviderUsage("fourth");
  f.now = epoch + 3;
  expect(f.owner.getDiversityReport().providers).toEqual({ fourth: { count: 1, share: 1 } });
  completed.add("window");
});

test("central management authorization protects the handler without a route guard", async () => {
  for (const credential of ["fixture-manage", "fixture-admin", "oma_fixture-read", "session"]) {
    expect((await f.handle(credential)).status).toBe(200); expect(f.calls).toBe(1);
  }
  for (const credential of [undefined, "invalid-fixture-secret", "fixture-unscoped"]) {
    const response = await f.handle(credential);
    expect([401, 403]).toContain(response.status); expect(f.calls).toBe(0);
    expect(JSON.stringify(await response.json())).not.toContain("invalid-fixture-secret");
  }
  const queryCredential = await f.handle(undefined, true, "?api_key=fixture-manage");
  expect([401, 403]).toContain(queryCredential.status); expect(f.calls).toBe(0);
  expect((await f.handle(undefined, false)).status).toBe(200);
  const unavailable = await f.handle("fixture-auth-error");
  expect(unavailable.status).toBe(503); expect(f.calls).toBe(0);
  expect(JSON.stringify(await unavailable.json())).not.toContain("fixture-private-auth-error");
  completed.add("auth");
});

test("caught owner failure uses the real upstream error sanitizer", async () => {
  const secret = ["sk", "fixturecredential123456"].join("-");
  f.failure = new Error(`Failure ${secret} at /home/private/fixture.txt\n    at secret (/home/private/file.ts:2:3)`);
  try {
    const actual = await result();
    expect(actual.status).toBe(500);
    const serialized = JSON.stringify(actual.body);
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("/home/private");
    expect(() => adapter.project(actual.body)).toThrow();
    expect(serialized).not.toContain("at secret");
    completed.add("error");
  } finally { f.failure = undefined; }
});

test("untrusted provider names are not guaranteed safe identifiers", async () => {
  f.now = epoch + 200;
  f.owner.recordProviderUsage("fixture-private-model-and-connection");
  f.owner.recordProviderUsage("__proto__");
  f.owner.recordProviderUsage("constructor");
  const response = await result();
  const body = response.body as { providers: Record<string, unknown> };
  expect(body.providers).toHaveProperty("fixture-private-model-and-connection");
  expect(Object.hasOwn(body.providers, "constructor")).toBe(true);
  expect(Object.hasOwn(body.providers, "__proto__")).toBe(false);
  expect(Object.prototype).not.toHaveProperty("count");
  const projected = adapter.project(response.body);
  expect(projected).toEqual({ score: expect.any(Number), totalRequests: 3, windowSize: 200, ttlMs: 3_600_000 });
  expect(JSON.stringify(projected)).not.toContain("fixture-private");
  expect(JSON.stringify(projected)).not.toContain("constructor");
  const injected = { ...body, score: 0, totalRequests: 1, windowSize: 200, ttlMs: 3_600_000, error: "fixture-private", model: "fixture-private" };
  expect(adapter.project(injected)).toEqual({ score: 0, totalRequests: 1, windowSize: 200, ttlMs: 3_600_000 });
  completed.add("projection");
});
