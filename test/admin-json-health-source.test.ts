import { expect, spyOn, test } from "bun:test";
import { projectResponse } from "../src/admin/registry.ts";
import { JSON_HEALTH_IDS, jsonHealthContract, jsonHealthDescriptor, PinnedJsonHealthFixture } from "./fixtures/pinned-health.fixture.ts";

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
      expect(descriptor.coverage.status).toBe("unqualified");
      expect(jsonHealthContract(id).auth.sourcePolicy).toEqual({ status: "unknown" });
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
});

test("health projections do not disclose injected fields or backend errors", () => {
  const live = jsonHealthDescriptor(JSON_HEALTH_IDS[0]);
  const projected = projectResponse(live, { status: "ok", timestamp: "2026-01-01T00:00:00.000Z", apiKey: "fixture-private-secret" });
  expect(projected).toEqual({ status: "ok", timestamp: "2026-01-01T00:00:00.000Z" });
  const ping = jsonHealthDescriptor(JSON_HEALTH_IDS[1]);
  expect(() => projectResponse(ping, { status: "error", error: "fixture-private-backend-error" })).toThrow();
  expect(() => projectResponse(ping, { status: "error", error: "db_query_failed", apiKey: "fixture-private-secret" })).toThrow();
});
