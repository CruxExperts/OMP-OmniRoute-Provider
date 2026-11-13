import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash } from "../scripts/generate-contracts.ts";
import { canonicalizeJson } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { createPinnedSettingsFixture } from "./fixtures/pinned-settings.fixture.ts";
import { SETTINGS_GET_ID, settingsGetContract, settingsGetDescriptor } from "./fixtures/settings.fixture.ts";

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
