import { expect, test } from "bun:test";
import { projectResponse } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { CACHE_METRICS_IDS, CacheMetricsFixture, cacheMetricsDescriptor } from "./fixtures/cache-metrics.fixture.ts";

const registry = fixtureRegistry(CACHE_METRICS_IDS.map(cacheMetricsDescriptor));

test("pinned cache metrics handlers aggregate history and deprecated reset leaves it unchanged", async () => {
  const fixture = new CacheMetricsFixture();
  try {
    fixture.db.exec("INSERT INTO usage_history VALUES ('alpha', NULL, 100, 50, 10), ('alpha', 'round-robin', 40, 0, 0), ('beta', 'round-robin', 200, 100, 0)");
    for (const id of CACHE_METRICS_IDS) {
      const adapter = registry.require(id);
      expect(adapter.validate({})).toEqual({ path: {}, query: {} });
      expect(() => adapter.validate({ query: { extra: "x" } })).toThrow();
      expect(() => adapter.validate({ body: {} })).toThrow();
      const response = await fixture.handle(id.startsWith("GET") ? "GET" : "DELETE", "fixture-manage");
      expect(response.status).toBe(200);
      const value = await response.json() as Record<string, unknown>;
      const projected = adapter.project(value) as Record<string, unknown>;
      expect(projected).toMatchObject({ totalRequests: 3, requestsWithCacheControl: 2, totalInputTokens: 300, totalCachedTokens: 150, totalCacheCreationTokens: 10, tokensSaved: 150, estimatedCostSaved: 0,
        byProvider: { alpha: { requests: 1, totalRequests: 2, cachedRequests: 1, inputTokens: 100, cachedTokens: 50, cacheCreationTokens: 10 }, beta: { requests: 1, totalRequests: 1, cachedRequests: 1, inputTokens: 200, cachedTokens: 100, cacheCreationTokens: 0 } },
        byStrategy: { direct: { requests: 1, inputTokens: 100, cachedTokens: 50, cacheCreationTokens: 10 }, "round-robin": { requests: 1, inputTokens: 200, cachedTokens: 100, cacheCreationTokens: 0 } } });
      expect(fixture.db.query("SELECT count(*) AS count FROM usage_history").get()).toEqual({ count: 3 });
      const injected = { ...value, byProvider: { ...(value.byProvider as object), password: { requests: 1, totalRequests: 1, cachedRequests: 1, inputTokens: 1, cachedTokens: 1, cacheCreationTokens: 1 } } };
      expect(JSON.stringify(adapter.project(injected))).not.toContain('"password"');
    }
  } finally { fixture.close(); }
});

test("pinned handler denies credentials and distinguishes open failure from query fallback", async () => {
  const fixture = new CacheMetricsFixture();
  try {
    for (const id of CACHE_METRICS_IDS) {
      const method = id.startsWith("GET") ? "GET" : "DELETE";
      const denied = await fixture.handle(method, "invalid-fixture-secret");
      expect([401, 403]).toContain(denied.status);
      const deniedBody = await denied.json();
      expect(JSON.stringify(registry.require(id).project(deniedBody))).not.toContain("invalid-fixture-secret");
      fixture.failOpen = true;
      const failed = await fixture.handle(method, "fixture-manage");
      expect(failed.status).toBe(500);
      const error = registry.require(id).project(await failed.json());
      expect(error).toEqual({ error: method === "GET" ? "Failed to load cache metrics" : "Failed to reset cache metrics" });
      expect(JSON.stringify(error)).not.toContain("fixture-private-backend-error");
      fixture.failOpen = false;
    }
    fixture.db.exec("DROP TABLE usage_history");
    const fallback = await fixture.handle("GET", "fixture-manage");
    expect(fallback.status).toBe(200);
    expect(registry.require(CACHE_METRICS_IDS[0]).project(await fallback.json())).toMatchObject({ totalRequests: 0, totalCachedTokens: 0, byProvider: {}, byStrategy: {} });
  } finally { fixture.close(); }
});

test("numeric metric projection is schema-bound and never overrides declared secrets", () => {
  const source = cacheMetricsDescriptor(CACHE_METRICS_IDS[0]);
  const descriptor = { ...source, operationId: "GET /fixture/unrelated", secrets: { inputFields: [], outputFields: ["tokensSaved"] },
    response: { ...source.response, schema: { type: "object", properties: {
      inputTokens: { type: "number" }, totalCachedTokens: { type: "string" }, tokensSaved: { type: "number" },
      accessToken: { type: "number" }, password: { type: "number" },
    }, additionalProperties: false } } };
  expect(projectResponse(descriptor, { inputTokens: 12, totalCachedTokens: "credential", tokensSaved: 9, accessToken: 123, password: 456 }))
    .toEqual({ inputTokens: 12 });
});
