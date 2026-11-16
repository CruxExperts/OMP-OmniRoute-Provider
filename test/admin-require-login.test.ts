import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash, validateRequireLoginContract } from "../scripts/generate-contracts.ts";
import { createAdminExecutor } from "../src/admin/executor.ts";
import { canonicalizeJson, isSecretOutputField, OperationRegistry, projectResponse, redactSourceOutput, type OperationDescriptor } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { REQUIRE_LOGIN_ID, RequireLoginFixture, loginFixtureToken, requireLoginContract, requireLoginDescriptor } from "./fixtures/require-login.fixture.ts";

const TEST_ID = "test/admin-require-login.test.ts";
let observation: { before: unknown; after: unknown; result: { status: number; body: unknown } } | undefined;
let consumerObserved = false;
let branchesObserved = false;
let projectionObserved = false;
afterAll(async () => {
  if (!observation || !consumerObserved || !branchesObserved || !projectionObserved) return;
  const contract = requireLoginContract();
  const binding = operationEvidenceBinding(REQUIRE_LOGIN_ID, contract);
  const caseSha256 = testCaseSourceHash(TEST_ID);
  const path = outcomeArtifactPath(REQUIRE_LOGIN_ID);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), path), `${canonicalizeJson({ operationId: REQUIRE_LOGIN_ID, testId: TEST_ID, caseSha256, binding, observation })}\n`, { mode: 0o600 });
  testOutcomeHash(REQUIRE_LOGIN_ID, TEST_ID, caseSha256, binding, contract, path);
});

/** Overrides eligibility only for this executor fixture, not production. */
function registry(descriptors: readonly OperationDescriptor[]): OperationRegistry {
  const base = fixtureRegistry(descriptors);
  return new class extends OperationRegistry {
    constructor() { super([]); }
    override require(id: string) { return { ...base.require(id), eligibility: { operationId: id, status: "verified" as const, reason: "Synthetic executor fixture only." } }; }
  }();
}

test("password metadata exemptions are exact-source, root-only, boolean and subordinate to explicit secrets", () => {
  const contract = requireLoginContract();
  expect(() => validateRequireLoginContract(contract)).not.toThrow();
  for (const altered of [{ ...contract, sideEffect: "read" }, { ...contract, confirmation: { ...contract.confirmation, required: false } }, { ...contract, retry: { allowed: true, maxAttempts: 2, statusCodes: [500] } }, { ...contract, response: { ...contract.response, schema: null } }, { ...contract, mutationSafety: { ...contract.mutationSafety!, settlement: { responseComplete: { statusCodes: [200] }, definiteRejection: null } } }]) expect(() => validateRequireLoginContract(altered)).toThrow();
  const descriptor = requireLoginDescriptor();
  const identity = { operationId: REQUIRE_LOGIN_ID, sha256: descriptor.source.sha256, gitBlobSha: descriptor.source.gitBlobSha };
  const fields = { hasPassword: true, oidcDisablePasswordLogin: false };
  expect(redactSourceOutput(fields, [], identity)).toEqual(fields);
  expect(redactSourceOutput(fields)).toEqual({ hasPassword: "[redacted]", oidcDisablePasswordLogin: "[redacted]" });
  expect(redactSourceOutput(fields, ["hasPassword"], identity)).toEqual({ hasPassword: "[redacted]", oidcDisablePasswordLogin: false });
  expect(isSecretOutputField("hasPassword", true, ["nested"], [], identity)).toBe(true);
  expect(isSecretOutputField("hasPassword", "private", [], [], identity)).toBe(true);
  expect(isSecretOutputField("hasPassword", true, [], [], { ...identity, operationId: "GET /api/settings" })).toBe(true);
  expect(isSecretOutputField("hasPassword", true, [], [], { ...identity, sha256: "0".repeat(64) })).toBe(true);
  const raw = { authenticated: false, requireLogin: true, hasPassword: true, setupComplete: false, oidcEnabled: false, oidcDisablePasswordLogin: false, nodeVersion: "v24.0.0", nodeCompatible: true, password: "private" };
  expect(projectResponse(descriptor, raw)).toEqual({ authenticated: false, requireLogin: true, hasPassword: true, setupComplete: false, oidcEnabled: false, oidcDisablePasswordLogin: false, nodeVersion: "v24.0.0", nodeCompatible: true });
  expect(() => projectResponse(descriptor, { ...raw, hasPassword: "private" })).toThrow();
  expect(() => projectResponse(descriptor, { ...raw, oidcDisablePasswordLogin: "private" })).toThrow();
  expect(projectResponse({ ...descriptor, operationId: "GET /api/settings" }, raw)).not.toHaveProperty("hasPassword");
  expect(projectResponse({ ...descriptor, secrets: { ...descriptor.secrets, outputFields: [...descriptor.secrets.outputFields, "hasPassword"] } }, raw)).not.toHaveProperty("hasPassword");
  projectionObserved = true;
});

test("actual public GET reads SQLite and can persist onboarding before returning", async () => {
  const f = new RequireLoginFixture();
  try {
    expect(f.isPublic("/api/settings/require-login", "GET")).toBe(true);
    const rows = f.db.query("SELECT key, value FROM key_value WHERE namespace = 'settings' AND key IN ('setupComplete', 'requireLogin') ORDER BY key");
    const before = rows.all();
    expect(before).toEqual([]);
    const response = await f.handle({ initialPassword: "fixture-private-password" });
    const raw = await response.json();
    const body = projectResponse(requireLoginDescriptor(), raw);
    expect(response.status).toBe(200);
    expect(body).toEqual({ authenticated: false, requireLogin: true, hasPassword: true, setupComplete: true, oidcEnabled: false, oidcDisablePasswordLogin: false, nodeVersion: raw.nodeVersion, nodeCompatible: raw.nodeCompatible });
    expect(typeof raw.nodeCompatible).toBe("boolean");
    expect(JSON.stringify(raw)).not.toContain("fixture-private-password");
    const after = rows.all();
    expect(after).toEqual([{ key: "requireLogin", value: "true" }, { key: "setupComplete", value: "true" }]);
    observation = { before, after, result: { status: response.status, body } };
  } finally { f.close(); }
});

test("source session verification, flag precedence, caching and masked errors remain distinct", async () => {
  const f = new RequireLoginFixture();
  try {
    const now = Math.floor(Date.now() / 1000);
    const token = loginFixtureToken({ authenticated: true, iat: now, jti: "fixture-id", exp: now + 3600 });
    f.set("password", "fixture-private-password"); f.set("requireLogin", false); f.set("oidcEnabled", true);
    let raw = await (await f.handle({ cookie: token })).json();
    expect(raw).toMatchObject({ authenticated: true, hasPassword: true, requireLogin: false, oidcEnabled: true, oidcDisablePasswordLogin: false });
    expect((await (await f.handle({ cookie: "invalid" })).json()).authenticated).toBe(false);
    expect((await (await f.handle({ cookie: token, secret: null })).json()).authenticated).toBe(false);
    expect((await (await f.handle({ cookie: loginFixtureToken({ authenticated: true, exp: now - 1 }) })).json()).authenticated).toBe(false);
    f.set("revokedDashboardSessions", [{ jti: "fixture-id", exp: now + 3600 }]);
    expect((await (await f.handle({ cookie: token })).json()).authenticated).toBe(true);
    f.now += 5001;
    expect((await (await f.handle({ cookie: token })).json()).authenticated).toBe(false);
    f.setFlag("yes");
    expect((await (await f.handle()).json()).oidcDisablePasswordLogin).toBe(false);
    f.now += 1001;
    expect((await (await f.handle()).json()).oidcDisablePasswordLogin).toBe(true);
    f.setFlag("false"); f.clearCache();
    expect((await (await f.handle({ flagEnv: "1" })).json()).oidcDisablePasswordLogin).toBe(false);
    expect((await (await f.handle({ flagEnv: "true" })).json()).oidcDisablePasswordLogin).toBe(true);
    expect((await (await f.handle({ oidcEnv: "true" })).json()).oidcDisablePasswordLogin).toBe(true);
    f.set("oidcDisablePasswordLogin", true);
    expect((await (await f.handle()).json()).oidcDisablePasswordLogin).toBe(true);
    f.set("oidcEnabled", false);
    expect((await (await f.handle({ flagEnv: "true" })).json()).oidcDisablePasswordLogin).toBe(false);
    f.clearCache(); f.fail = true;
    const failure = await f.handle();
    raw = await failure.json();
    expect(failure.status).toBe(200);
    expect(raw).toMatchObject({ authenticated: false, requireLogin: true, hasPassword: true, setupComplete: true, oidcEnabled: false, oidcDisablePasswordLogin: false });
    expect(JSON.stringify(raw)).not.toContain("fixture-private");
    branchesObserved = true;
  } finally { f.close(); }
});

test("bounded public dispatch requires confirmation, never forwards credentials or retries", async () => {
  const contract = requireLoginContract();
  expect(contract.sideEffect).toBe("lifecycle");
  expect(contract.confirmation.required).toBe(true);
  expect(contract.retry).toEqual({ allowed: false, maxAttempts: 1, statusCodes: [] });
  expect(contract.mutationSafety?.settlement.responseComplete.statusCodes).toEqual([]);
  const adapter = fixtureRegistry([requireLoginDescriptor()]).require(REQUIRE_LOGIN_ID);
  expect(adapter.validate({})).toEqual({ path: {}, query: {} });
  expect(() => adapter.validate({ body: {} })).toThrow();
  expect(() => adapter.validate({ query: { token: "private" } })).toThrow();
  expect(() => adapter.project({ authenticated: "true" })).toThrow();
  const f = new RequireLoginFixture();
  try {
    let calls = 0;
    const auth: unknown[] = [];
    const executor = createAdminExecutor({ registry: registry([requireLoginDescriptor()]), dispatch: async (_operation, context) => {
      calls++; auth.push({ credential: context.auth.credential, retryAllowed: context.retryAllowed });
      const response = await f.handle();
      return { kind: "response", status: response.status, body: await response.json() };
    } });
    const endpoint = "http://127.0.0.1:20128";
    executor.setAdminBinding({ profileId: "omniroute", endpoint });
    const denied = await executor.plan(REQUIRE_LOGIN_ID, {});
    expect((await executor.apply(denied.planId, { confirmed: false })).status).toBe("denied");
    expect(calls).toBe(0);
    executor.bindCredential({ profileId: "omniroute", endpoint, cookie: "fixture-private-cookie" });
    const first = await executor.plan(REQUIRE_LOGIN_ID, {});
    const result = await executor.apply(first.planId, { confirmed: true });
    expect(result.status).toBe("unknown");
    executor.bindCredential({ profileId: "omniroute", endpoint, apiKey: "fixture-private-api-key" });
    const second = await executor.plan(REQUIRE_LOGIN_ID, {});
    expect((await executor.apply(second.planId, { confirmed: true })).status).toBe("unknown");
    expect(calls).toBe(2);
    expect(auth).toEqual([{ credential: undefined, retryAllowed: false }, { credential: undefined, retryAllowed: false }]);
    expect(JSON.stringify(result)).not.toContain("fixture-private");
    consumerObserved = true;
  } finally { f.close(); }
});
