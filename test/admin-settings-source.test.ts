import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash } from "../scripts/generate-contracts.ts";
import { invokeJsonAdapter } from "../src/admin/adapters.ts";
import { createAdminExecutor } from "../src/admin/executor.ts";
import { dispatchResult } from "../src/admin/runtime.ts";
import { canonicalizeJson } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { createPinnedReasoningRulesFixture, createPinnedSettingsFixture } from "./fixtures/pinned-settings.fixture.ts";
import { REASONING_RULES_GET_ID, reasoningRulesGetContract, reasoningRulesGetDescriptor, SETTINGS_GET_ID, settingsGetContract, settingsGetDescriptor } from "./fixtures/settings.fixture.ts";

const testId = "test/admin-settings-source.test.ts";
const cases = new Set<string>();
let observation: { before: unknown; after: unknown; result: { status: number; body: unknown } } | undefined;

afterAll(async () => {
  if (!observation || !["defaults-and-persistence", "auth-and-input", "failure", "redaction", "initial-password-write"].every(item => cases.has(item))) return;
  const contract = settingsGetContract();
  const binding = operationEvidenceBinding(SETTINGS_GET_ID, contract);
  const caseSha256 = testCaseSourceHash(testId);
  const artifactPath = outcomeArtifactPath(SETTINGS_GET_ID);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId: SETTINGS_GET_ID, testId, caseSha256, binding, observation })}\n`, { mode: 0o600 });
  testOutcomeHash(SETTINGS_GET_ID, testId, caseSha256, binding, contract, artifactPath);
});

test("settings GET reads default and externally changed SQLite values with revision headers", async () => {
  const fixture = createPinnedSettingsFixture();
  const adapter = fixtureRegistry([settingsGetDescriptor()]).require(SETTINGS_GET_ID);
  try {
    const first = await fixture.handle("oma_fixture-read");
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(first.headers.get("etag")).toBe("0");
    const initial = await first.json() as Record<string, unknown>;
    expect(initial.cloudEnabled).toBe(false);
    expect(initial.settingsRevision).toBe(0);
    expect(adapter.project(initial)).toEqual({ cloudEnabled: false });
    const insert = fixture.db.prepare("INSERT OR REPLACE INTO key_value (namespace, key, value) VALUES ('settings', ?, ?)");
    expect(initial.cloudConfigured).toBe(true);
    expect(initial.radarAdminUrl).toBeNull();
    insert.run("cloudEnabled", "true");
    insert.run("_settingsRevision", "7");
    insert.run("password", JSON.stringify("private-password"));
    insert.run("oidcClientSecret", JSON.stringify("private-secret"));
    const changed = await fixture.handle("oma_fixture-read", "?ignored=1");
    expect(changed.status).toBe(200);
    expect(changed.headers.get("cache-control")).toBe("no-store");
    expect(changed.headers.get("etag")).toBe("7");
    const value = await changed.json() as Record<string, unknown>;
    expect(value.cloudEnabled).toBe(true);
    expect(value.settingsRevision).toBe(7);
    expect(value.password).toBeUndefined();
    expect(adapter.project(value)).toEqual({ cloudEnabled: true });
    expect(JSON.stringify(adapter.project(value))).not.toMatch(/private|radar|secret/i);
    insert.run("cloudEnabled", "false");
    const disabled = await fixture.handle("oma_fixture-read");
    expect(adapter.project(await disabled.json())).toEqual({ cloudEnabled: false });
    fixture.db.prepare("DELETE FROM key_value WHERE namespace = 'settings' AND key = 'cloudEnabled'").run();
    const absent = await fixture.handle("oma_fixture-read");
    expect(adapter.project(await absent.json())).toEqual({ cloudEnabled: false });
    insert.run("cloudEnabled", JSON.stringify("not-a-boolean"));
    const malformed = await fixture.handle("oma_fixture-read");
    expect((await malformed.json() as Record<string, unknown>).cloudEnabled).toBe("not-a-boolean");
    expect(() => adapter.project({ cloudEnabled: "not-a-boolean", radarAdminUrl: "private-radar" })).toThrow();
    observation = { before: { cloudEnabled: false }, after: { cloudEnabled: false }, result: { status: changed.status, body: { cloudEnabled: true } } };
    cases.add("defaults-and-persistence");
    cases.add("redaction");
  } finally { fixture.close(); }
});

test("settings read has a bounded input view and denies invalid credentials", async () => {
  const fixture = createPinnedSettingsFixture();
  try {
    const adapter = fixtureRegistry([settingsGetDescriptor()]).require(SETTINGS_GET_ID);
    expect(adapter.validate({})).toEqual({ path: {}, query: {} });
    expect(() => adapter.validate({ query: { extra: "x" } })).toThrow();
    expect(() => adapter.validate({ body: {} })).toThrow();
    const denied = await fixture.handle("invalid");
    expect([401, 403]).toContain(denied.status);
    expect(JSON.stringify(await denied.json())).not.toContain("private");
    const allowed = await fixture.handle("oma_fixture-read");
    expect(allowed.status).toBe(200);
    cases.add("auth-and-input");
  } finally { fixture.close(); }
});

test("settings GET returns a generic failure without backend details", async () => {
  const fixture = createPinnedSettingsFixture();
  try {
    fixture.setFailure(true);
    const response = await fixture.handle("oma_fixture-read");
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to load settings" });
    cases.add("failure");
  } finally { fixture.close(); }
});

test("headless first settings GET persists onboarding state and cannot be an ordinary read", async () => {
  const fixture = createPinnedSettingsFixture();
  try {
    const contract = settingsGetContract();
    expect(contract.sideEffect).toBe("unknown");
    expect(contract.confirmation.required).toBe(true);
    expect(settingsGetDescriptor().sideEffect).toBe("unknown");
    const rows = fixture.db.query("SELECT key, value FROM key_value WHERE namespace = 'settings' AND key IN ('setupComplete', 'requireLogin') ORDER BY key");
    expect(rows.all()).toEqual([]);
    const request = new Request("http://fixture.invalid/api/settings", { headers: { authorization: "Bearer oma_fixture-read" } });
    // dispatch serializes the callback with every other pinned authorization fixture.
    const response = await fixture.authorization.dispatch(request, { centralAuthRequired: true, handlerAuthRequired: true }, async forwarded => {
      const prior = process.env.INITIAL_PASSWORD;
      process.env.INITIAL_PASSWORD = "fixture-initial-password";
      try { return await fixture.get(forwarded); }
      finally {
        if (prior === undefined) delete process.env.INITIAL_PASSWORD;
        else process.env.INITIAL_PASSWORD = prior;
      }
    });
    expect(response.status).toBe(200);
    expect(rows.all()).toEqual([{ key: "requireLogin", value: "true" }, { key: "setupComplete", value: "true" }]);
    const body = await response.json() as Record<string, unknown>;
    expect(body.setupComplete).toBe(true);
    expect(body.requireLogin).toBe(true);
    cases.add("initial-password-write");
  } finally { fixture.close(); }
});

const reasoningCases = new Set<string>();
let reasoningObservation: { before: unknown; after: unknown; result: { status: number; body: unknown } } | undefined;
afterAll(async () => {
  if (!reasoningObservation || !["read", "authorization", "cache", "failure", "http-failure-consumer"].every(item => reasoningCases.has(item))) return;
  const contract = reasoningRulesGetContract();
  const binding = operationEvidenceBinding(REASONING_RULES_GET_ID, contract);
  const caseSha256 = testCaseSourceHash(testId);
  const artifactPath = outcomeArtifactPath(REASONING_RULES_GET_ID);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId: REASONING_RULES_GET_ID, testId, caseSha256, binding, observation: reasoningObservation })}\n`, { mode: 0o600 });
  testOutcomeHash(REASONING_RULES_GET_ID, testId, caseSha256, binding, contract, artifactPath);
});

test("reasoning rules GET reads and orders persisted rules without changing SQLite", async () => {
  const fixture = createPinnedReasoningRulesFixture();
  try {
    fixture.db.exec(`INSERT INTO reasoning_routing_rules (id, name, scope, priority, request_tags, created_at, updated_at)
      VALUES ('low', 'Low', 'global', 1, '[" Test ","test","",3]', '2026-01-01', '2026-01-01'),
             ('high', 'High', 'global', 9, '[]', '2026-01-02', '2026-01-02')`);
    const before = fixture.db.query("SELECT * FROM reasoning_routing_rules ORDER BY id").all();
    const response = await fixture.handle("oma_fixture-read");
    expect(response.status).toBe(200);
    const body = await response.json() as { rules: Array<Record<string, unknown>> };
    expect(body.rules.map(rule => rule.id)).toEqual(["high", "low"]);
    expect(body.rules[1]).toMatchObject({ name: "Low", enabled: true, requestTags: ["test"], scope: "global", targetModel: null, budgetTokens: null });
    const after = fixture.db.query("SELECT * FROM reasoning_routing_rules ORDER BY id").all();
    expect(after).toEqual(before);
    const adapter = fixtureRegistry([reasoningRulesGetDescriptor()]).require(REASONING_RULES_GET_ID);
    const projected = adapter.project(body) as { rules: Array<Record<string, unknown>> };
    expect(projected.rules.map(rule => rule.id)).toEqual(["high", "low"]);
    expect(projected.rules[1]).toMatchObject({ name: "Low", enabled: true, requestTags: ["test"], scope: "global", targetModel: null });
    for (const rule of projected.rules) {
      expect(rule).not.toHaveProperty("apiKeyId");
      expect(rule).not.toHaveProperty("budgetTokens");
    }
    const withSensitiveFields = { rules: body.rules.map(rule => ({ ...rule, apiKeyId: "fixture-key-id", budgetTokens: 1234 })) };
    const sensitiveProjection = adapter.project(withSensitiveFields) as { rules: Array<Record<string, unknown>> };
    for (const rule of sensitiveProjection.rules) {
      expect(rule).not.toHaveProperty("apiKeyId");
      expect(rule).not.toHaveProperty("budgetTokens");
    }
    const unexpectedProjection = adapter.project({ rules: [{ ...body.rules[0], password: "fixture-secret", unexpected: "not-allowed" }] }) as { rules: Array<Record<string, unknown>> };
    expect(unexpectedProjection.rules[0]).not.toHaveProperty("password");
    expect(unexpectedProjection.rules[0]).not.toHaveProperty("unexpected");
    expect(() => adapter.project({ rules: [{ ...body.rules[0], priority: "invalid" }] })).toThrow();
    expect(() => adapter.project({ rules: [{ id: "incomplete" }] })).toThrow();
    const state = { ruleIds: (before as Array<{ id: string }>).map(rule => rule.id) };
    reasoningObservation = { before: state, after: { ruleIds: (after as Array<{ id: string }>).map(rule => rule.id) }, result: { status: response.status, body: projected } };
    reasoningCases.add("read");
  } finally { fixture.close(); }
});

test("reasoning rules read enforces management authorization and bounded input", async () => {
  const fixture = createPinnedReasoningRulesFixture();
  try {
    const adapter = fixtureRegistry([reasoningRulesGetDescriptor()]).require(REASONING_RULES_GET_ID);
    expect(adapter.validate({})).toEqual({ path: {}, query: {} });
    expect(() => adapter.validate({ query: { extra: "x" } })).toThrow();
    expect(() => adapter.validate({ body: {} })).toThrow();
    for (const token of [undefined, "invalid", "fixture-unscoped"]) expect([401, 403]).toContain((await fixture.handle(token)).status);
    for (const token of ["oma_fixture-read", "fixture-manage", "fixture-session"]) expect((await fixture.handle(token)).status).toBe(200);
    reasoningCases.add("authorization");
  } finally { fixture.close(); }
});

test("reasoning rules cache can be stale until invalidated and store errors escape the handler", async () => {
  const fixture = createPinnedReasoningRulesFixture();
  try {
    expect(await (await fixture.handle("fixture-manage")).json()).toEqual({ rules: [] });
    fixture.db.exec("INSERT INTO reasoning_routing_rules (id, name, scope, created_at, updated_at) VALUES ('one', 'One', 'global', '2026-01-01', '2026-01-01')");
    expect(await (await fixture.handle("fixture-manage")).json()).toEqual({ rules: [] });
    fixture.invalidate();
    expect((await (await fixture.handle("fixture-manage")).json() as { rules: unknown[] }).rules).toHaveLength(1);
    reasoningCases.add("cache");
    fixture.invalidate();
    fixture.setFailure(true);
    await expect(fixture.handle("fixture-manage")).rejects.toThrow("fixture-private-database-error");
    reasoningCases.add("failure");
  } finally { fixture.close(); }
});

test("reasoning rules empty HTTP 500 fails before projection without a retry or write", async () => {
  const fixture = createPinnedReasoningRulesFixture();
  fixture.db.exec("INSERT INTO reasoning_routing_rules (id, name, scope, created_at, updated_at) VALUES ('one', 'One', 'global', '2026-01-01', '2026-01-01')");
  const before = fixture.db.query("SELECT * FROM reasoning_routing_rules ORDER BY id").all();
  fixture.setFailure(true);
  let requests = 0;
  let methods: string[] = [];
  // Replay the independently observed Next ingress response, not a JSON error.
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    requests += 1;
    methods.push(request.method);
    try { return await fixture.handle("fixture-manage"); }
    catch { return new Response(null, { status: 500 }); }
  } });
  const endpoint = `http://127.0.0.1:${server.port}`;
  const registry = fixtureRegistry([reasoningRulesGetDescriptor()]);
  const executor = createAdminExecutor({ registry, dispatch: async (request, context) => {
    const adapter = registry.require(request.operationId);
    const result = await invokeJsonAdapter({ descriptor: { ...adapter.descriptor, adapterId: adapter.adapterId },
      endpoint: context.auth.endpoint, resolvedPath: request.path, queryParameters: request.queryParameters,
      ...(context.auth.credential ? { credential: context.auth.credential } : {}) });
    return dispatchResult(result, adapter.risk);
  } });
  executor.bindCredential({ profileId: "reasoning-fixture", endpoint, apiKey: "fixture-manage" });
  try {
    let failure: unknown;
    try { await executor.read(REASONING_RULES_GET_ID, {}); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(Error);
    expect(failure).toMatchObject({ message: "operation request failed", status: 500 });
    expect(String(failure)).not.toContain("JSON");
    expect(String(failure)).not.toContain("fixture-private-database-error");
    expect(requests).toBe(1);
    expect(methods).toEqual(["GET"]);
    expect(fixture.db.query("SELECT * FROM reasoning_routing_rules ORDER BY id").all()).toEqual(before);
    reasoningCases.add("http-failure-consumer");
  } finally { executor.shutdown(); server.stop(true); fixture.close(); }
});
