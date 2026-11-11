import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash } from "../scripts/generate-contracts.ts";
import { canonicalizeJson, projectResponse } from "../src/admin/registry.ts";
import { buildLivenessFixtureRegistry, JSON_HEALTH_IDS, jsonHealthContract, jsonHealthDescriptor, LIVENESS_ID, LIVENESS_TEST_ID, PinnedJsonHealthFixture, startPinnedLivenessHttp } from "./fixtures/pinned-health.fixture.ts";

let livenessObservation: { before: null; after: null; result: { status: number; body: unknown } } | undefined;
let databaseIndependenceObserved = false;
let safeProjectionObserved = false;
let healthRoutesObserved = false;
let unexpectedPingFailureObserved = false;

afterAll(async () => {
  if (!livenessObservation || !databaseIndependenceObserved || !safeProjectionObserved || !healthRoutesObserved || !unexpectedPingFailureObserved) return;
  const contract = jsonHealthContract(LIVENESS_ID);
  const binding = operationEvidenceBinding(LIVENESS_ID, contract);
  const caseSha256 = testCaseSourceHash(LIVENESS_TEST_ID);
  const artifactPath = outcomeArtifactPath(LIVENESS_ID);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId: LIVENESS_ID, testId: LIVENESS_TEST_ID, caseSha256, binding, observation: livenessObservation })}\n`, { mode: 0o600 });
  testOutcomeHash(LIVENESS_ID, LIVENESS_TEST_ID, caseSha256, binding, contract, artifactPath);
});

test("pinned liveness adapter and independent handler HTTP response agree", async () => {
  const adapter = buildLivenessFixtureRegistry().lookup(LIVENESS_ID);
  if (!adapter) throw new Error("Fixture liveness adapter missing");
  const input = adapter.validate({});
  expect(adapter.buildPath(input)).toBe("/api/health");
  expect(adapter.buildQuery(input)).toEqual([]);
  expect(() => adapter.validate({ query: { unexpected: "value" } })).toThrow();
  const fixture = startPinnedLivenessHttp();
  let observed: typeof livenessObservation;
  try {
    const before = Date.now();
    const response = await fetch(`${fixture.endpoint}${adapter.buildPath(input)}`);
    const after = Date.now();
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toMatch(/^application\/json\b/);
    expect(response.headers.get("cache-control")).toBe("no-store, no-cache, must-revalidate");
    const body = await response.json() as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(["status", "timestamp"]);
    expect(body.status).toBe("ok");
    expectTimestamp(body.timestamp, before, after);
    expect(adapter.project(body)).toEqual(body);
    expect(adapter.project({ ...body, apiKey: "fixture-private-secret" })).toEqual(body);
    observed = { before: null, after: null, result: { status: response.status, body: { ...body, timestamp: "2026-01-01T00:00:00.000Z" } } };
  } finally {
    fixture.stop();
  }
  livenessObservation = observed;
});

function expectTimestamp(value: unknown, before: number, after: number): void {
  expect(typeof value).toBe("string");
  const timestamp = Date.parse(value as string);
  expect(Number.isFinite(timestamp)).toBe(true);
  expect(timestamp).toBeGreaterThanOrEqual(before);
  expect(timestamp).toBeLessThanOrEqual(after);
}

test("pinned JSON health routes report liveness and SQLite responsiveness without claiming ingress qualification", async () => {
  const fixture = new PinnedJsonHealthFixture();
  try {
    for (const id of JSON_HEALTH_IDS) {
      const descriptor = jsonHealthDescriptor(id);
      const before = Date.now();
      const response = await fixture.handle(id);
      const after = Date.now();
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store, no-cache, must-revalidate");
      const body = await response.json() as Record<string, unknown>;
      expect(body.status).toBe("ok");
      expectTimestamp(body.timestamp, before, after);
      if (id === JSON_HEALTH_IDS[0]) {
        expect(Object.keys(body).sort()).toEqual(["status", "timestamp"]);
      } else {
        expect(Object.keys(body).sort()).toEqual(["latencyMs", "status", "timestamp"]);
        expect(typeof body.latencyMs).toBe("number");
        expect(body.latencyMs as number).toBeGreaterThanOrEqual(0);
      }
      expect(projectResponse(descriptor, body)).toEqual(body);
    }
    expect(fixture.db.query("SELECT 1 AS ok").get()).toEqual({ ok: 1 });
  } finally {
    fixture.close();
  }
  healthRoutesObserved = true;
});

test("pinned ping reports database failure without exposing backend details; liveness stays independent", async () => {
  const fixture = new PinnedJsonHealthFixture();
  let closed = false;
  try {
    fixture.failOpen = true;
    const response = await fixture.handle(JSON_HEALTH_IDS[1]);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ status: "error", error: "db_query_failed" });
    const projected = projectResponse(jsonHealthDescriptor(JSON_HEALTH_IDS[1]), body);
    expect(projected).toEqual(body);
    expect(JSON.stringify(projected)).not.toContain("fixture-private-backend-error");
    const health = await fixture.handle(JSON_HEALTH_IDS[0]);
    expect(health.status).toBe(200);
    expect((await health.json() as { status: string }).status).toBe("ok");

    fixture.failOpen = false;
    fixture.db.close();
    closed = true;
    const responseAfterClose = await fixture.handle(JSON_HEALTH_IDS[1]);
    expect(responseAfterClose.status).toBe(503);
    expect(await responseAfterClose.json()).toEqual({ status: "error", error: "db_query_failed" });
  } finally {
    if (!closed) fixture.close();
  }
  databaseIndependenceObserved = true;
});

test("pinned ping returns its fixed failure body for an unexpected backend throw", async () => {
  const fixture = new PinnedJsonHealthFixture();
  const logger = spyOn(console, "error").mockImplementation(() => {});
  try {
    fixture.throwFromPing = true;
    const response = await fixture.handle(JSON_HEALTH_IDS[1]);
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).toEqual({ status: "error", error: "ping_failed" });
    expect(projectResponse(jsonHealthDescriptor(JSON_HEALTH_IDS[1]), body)).toEqual(body);
    expect(logger).toHaveBeenCalled();
  } finally {
    logger.mockRestore();
    fixture.close();
  }
  unexpectedPingFailureObserved = true;
});

test("health projections do not disclose injected fields or backend errors", () => {
  const live = jsonHealthDescriptor(JSON_HEALTH_IDS[0]);
  const projected = projectResponse(live, { status: "ok", timestamp: "2026-01-01T00:00:00.000Z", apiKey: "fixture-private-secret" });
  expect(projected).toEqual({ status: "ok", timestamp: "2026-01-01T00:00:00.000Z" });
  const ping = jsonHealthDescriptor(JSON_HEALTH_IDS[1]);
  expect(() => projectResponse(ping, { status: "error", error: "fixture-private-backend-error" })).toThrow();
  expect(() => projectResponse(ping, { status: "error", error: "db_query_failed", apiKey: "fixture-private-secret" })).toThrow();
  safeProjectionObserved = true;
});
