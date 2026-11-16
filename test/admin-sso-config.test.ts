import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash, validateSsoConfigContract } from "../scripts/generate-contracts.ts";
import { createAdminExecutor } from "../src/admin/executor.ts";
import { canonicalizeJson, OperationRegistry, projectResponse, type OperationDescriptor } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { SSO_CONFIG_ID, SsoConfigFixture, ssoConfigContract, ssoConfigDescriptor } from "./fixtures/sso-config.fixture.ts";

const TEST_ID = "test/admin-sso-config.test.ts";
let observation: { before: unknown; after: unknown; result: { status: number; body: unknown } } | undefined;
let consumerObserved = false;
let safetyObserved = false;
afterAll(async () => {
  if (!observation || !consumerObserved || !safetyObserved) return;
  const contract = ssoConfigContract();
  const binding = operationEvidenceBinding(SSO_CONFIG_ID, contract);
  const caseSha256 = testCaseSourceHash(TEST_ID);
  const path = outcomeArtifactPath(SSO_CONFIG_ID);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), path), `${canonicalizeJson({ operationId: SSO_CONFIG_ID, testId: TEST_ID, caseSha256, binding, observation })}\n`, { mode: 0o600 });
  testOutcomeHash(SSO_CONFIG_ID, TEST_ID, caseSha256, binding, contract, path);
});

const enabled = { enabled: true, authorityHost: "https://login.example.test", tenantId: "tenant.example", clientId: "fixture-client", audience: "api://fixture-audience", issuer: "https://login.example.test/tenant.example/v2.0", scope: "api://fixture-audience/.default" };
function registry(descriptors: readonly OperationDescriptor[]): OperationRegistry {
  const base = fixtureRegistry(descriptors);
  return new class extends OperationRegistry {
    constructor() { super([]); }
    override require(id: string) { return { ...base.require(id), eligibility: { operationId: id, status: "verified" as const, reason: "Synthetic executor fixture only." } }; }
  }();
}
test("pinned source normalizes settings and never emits graph data", async () => {
  const f = new SsoConfigFixture();
  try {
    expect(f.isPublic("/api/auth/sso/config", "GET")).toBe(true);
    expect(f.isPublic("/api/auth/sso/login", "GET")).toBe(false);
    expect(await (await f.handle()).json()).toEqual({ enabled: false });
    for (const [key, value] of Object.entries({ entraSsoEnabled: true, entraTenantId: " tenant.example ", entraClientId: " fixture-client ", entraApiAudience: " api://fixture-audience ", entraAuthorityHost: " https://login.example.test/// ", entraGraphClientSecret: "fixture-private-secret", entraGroupMappings: [{ groupId: "fixture-private-group", keyGroupId: "fixture-private-key" }] })) f.set(key, value);
    f.clearCache();
    const rows = () => f.db.query("SELECT key, value FROM key_value WHERE namespace = 'settings' AND key LIKE 'entra%' ORDER BY key").all();
    const seeded = rows();
    const snapshot = JSON.stringify(seeded);
    const before = { rows: seeded.length, unchanged: true };
    const response = await f.handle();
    const raw = await response.json();
    const body = projectResponse(ssoConfigDescriptor(), raw);
    expect(response.status).toBe(200);
    expect(body).toEqual(enabled);
    expect(JSON.stringify(raw)).not.toContain("fixture-private");
    const afterRows = rows();
    const after = { rows: afterRows.length, unchanged: JSON.stringify(afterRows) === snapshot };
    expect(after).toEqual(before);
    f.set("entraApiAudience", "");
    expect(projectResponse(ssoConfigDescriptor(), await (await f.handle()).json())).toEqual(enabled);
    f.now += 5001;
    expect(await (await f.handle()).json()).toEqual({ enabled: false });
    f.set("entraApiAudience", "api://fixture-audience"); f.clearCache();
    f.set("entraAuthorityHost", "http://remote.example"); f.clearCache();
    expect((await (await f.handle()).json()).authorityHost).toBe("https://login.microsoftonline.com");
    f.set("entraAuthorityHost", "https://login.example.test"); f.set("entraClientId", ""); f.clearCache();
    expect(projectResponse(ssoConfigDescriptor(), await (await f.handle()).json())).toEqual({ ...enabled, clientId: "" });
    f.set("entraClientId", "fixture-client"); f.set("entraAuthorityHost", "http://localhost:43179///"); f.clearCache();
    expect(projectResponse(ssoConfigDescriptor(), await (await f.handle()).json())).toEqual({ ...enabled, authorityHost: "http://localhost:43179", issuer: "http://localhost:43179/tenant.example/v2.0" });
    f.set("entraApiAudience", ""); f.clearCache();
    expect(await (await f.handle()).json()).toEqual({ enabled: false });
    f.fail = true; f.clearCache();
    const failure = await f.handle();
    expect(failure.status).toBe(200);
    expect(await failure.json()).toEqual({ enabled: false });
    observation = { before, after, result: { status: response.status, body } };
  } finally { f.close(); }
});

test("SSO projection fails closed on unsafe metadata and lifecycle contract drift", async () => {
  const contract = ssoConfigContract();
  expect(() => validateSsoConfigContract(contract)).not.toThrow();
  for (const altered of [{ ...contract, sideEffect: "read" }, { ...contract, confirmation: { ...contract.confirmation, required: false } }, { ...contract, retry: { allowed: true, maxAttempts: 2, statusCodes: [500] } }, { ...contract, response: { ...contract.response, schema: null } }]) expect(() => validateSsoConfigContract(altered)).toThrow();
  const adapter = fixtureRegistry([ssoConfigDescriptor()]).require(SSO_CONFIG_ID);
  expect(adapter.validate({})).toEqual({ path: {}, query: {} });
  expect(() => adapter.validate({ body: {} })).toThrow();
  expect(adapter.project({ enabled: false })).toEqual({ enabled: false });
  const f = new SsoConfigFixture();
  try {
    for (const [key, value] of Object.entries({ entraSsoEnabled: true, entraTenantId: "tenant.example", entraClientId: "fixture-client", entraApiAudience: "api://fixture-audience" })) f.set(key, value);
    for (const authority of ["https://fixture-private:password@login.example.test", "https://login.example.test?fixture-private=1", "https://login.example.test/#fixture-private"]) {
      f.set("entraAuthorityHost", authority); f.clearCache();
      const raw = await (await f.handle()).json();
      let message = "";
      try { adapter.project(raw); } catch (error) { message = String(error); }
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("fixture-private");
      expect(() => adapter.project({ ...enabled, issuer: "https://unrelated.invalid/tenant.example/v2.0" })).toThrow();
      expect(() => adapter.project({ ...enabled, scope: "api://fixture-audience/other" })).toThrow();
    }
    f.set("entraAuthorityHost", "https://login.example.test");
    for (const audience of ["https://fixture-private:pass@api.example.test", "https://api.example.test?fixture-private=1", "https://api.example.test/#fixture-private", "https://api.example.test/fixture-private%0d%0a", "https://api.example.test/fixture-private%3fquery", "https://api.example.test/fixture-private%23fragment", "https://api.example.test:99999/fixture-private"]) {
      f.set("entraApiAudience", audience); f.clearCache();
      const raw = await (await f.handle()).json();
      let message = "";
      try { adapter.project(raw); } catch (error) { message = String(error); }
      expect(message.length).toBeGreaterThan(0);
      expect(message).not.toContain("fixture-private");
    }
    for (const audience of ["api://12345678-1234-1234-1234-123456789abc", "fixture-audience", "urn:fixture:audience"]) {
      f.set("entraApiAudience", audience); f.clearCache();
      const raw = await (await f.handle()).json();
      expect(adapter.project(raw)).toEqual({ ...enabled, audience, scope: `${audience}/.default` });
    }
    safetyObserved = true;
  } finally { f.close(); }
});

test("public executor dispatches without credentials and leaves lifecycle unsettled", async () => {
  const f = new SsoConfigFixture();
  try {
    let calls = 0;
    let completed = 0;
    const dispatchAuth: unknown[] = [];
    const executor = createAdminExecutor({ registry: registry([ssoConfigDescriptor()]), dispatch: async (operation, context) => {
      calls++;
      dispatchAuth.push({ retryAllowed: context.retryAllowed, credential: context.auth.credential });
      const response = await f.handle();
      const body = await response.json();
      completed++;
      return { kind: "response", status: response.status, body };
    } });
    const endpoint = "http://127.0.0.1:20128";
    executor.setAdminBinding({ profileId: "omniroute", endpoint });
    executor.bindCredential({ profileId: "omniroute", endpoint, cookie: "fixture-private-cookie" });
    const cookiePlan = await executor.plan(SSO_CONFIG_ID, {});
    const cookieResult = await executor.apply(cookiePlan.planId, { confirmed: true });
    expect(cookieResult.status).toBe("unknown");
    expect(cookieResult.output).toEqual({ enabled: false });
    executor.bindCredential({ profileId: "omniroute", endpoint, apiKey: "fixture-private-key" });
    const plan = await executor.plan(SSO_CONFIG_ID, {});
    const result = await executor.apply(plan.planId, { confirmed: true });
    expect(result.status).toBe("unknown"); expect(calls).toBe(2);
    expect(completed).toBe(2);
    expect(dispatchAuth).toEqual([{ retryAllowed: false, credential: undefined }, { retryAllowed: false, credential: undefined }]);
    expect(result.output).toEqual({ enabled: false });
    expect(JSON.stringify(result)).not.toContain("fixture-private-key");
    consumerObserved = true;
  } finally { f.close(); }
});
