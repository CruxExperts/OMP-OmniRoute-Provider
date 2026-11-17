import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash, validateAuthCsrfContract } from "../scripts/generate-contracts.ts";
import { canonicalizeJson, projectResponse } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { AUTH_CSRF_ID, AuthCsrfFixture, authCsrfContract, authCsrfDescriptor } from "./fixtures/auth-csrf.fixture.ts";

const fixture = new AuthCsrfFixture();
let observation: { before: unknown; after: unknown; result: { status: number; body: unknown } } | undefined;
let issuerChecked = false;
let contractChecked = false;
afterAll(async () => {
  if (!observation || !issuerChecked || !contractChecked) return;
  const testId = "test/admin-auth-csrf.test.ts";
  const contract = authCsrfContract();
  const binding = operationEvidenceBinding(AUTH_CSRF_ID, contract);
  const caseSha256 = testCaseSourceHash(testId);
  const artifactPath = outcomeArtifactPath(AUTH_CSRF_ID);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId: AUTH_CSRF_ID, testId, caseSha256, binding, observation })}\n`, { mode: 0o600 });
  testOutcomeHash(AUTH_CSRF_ID, testId, caseSha256, binding, contract, artifactPath);
});
test("candidate contract preserves closed input and no replay", () => {
  const contract = authCsrfContract();
  const adapter = fixtureRegistry([authCsrfDescriptor()]).require(AUTH_CSRF_ID);
  expect(adapter.eligibility.status).toBe("verified");
  expect(adapter.validate({})).toEqual({ path: {}, query: {} });
  for (const input of [{ path: { extra: "x" } }, { query: { token: "x" } }, { body: {} }]) expect(() => adapter.validate(input)).toThrow();
  expect(() => validateAuthCsrfContract(contract)).not.toThrow();
  expect(() => validateAuthCsrfContract({ ...contract, retry: { allowed: true, maxAttempts: 2, statusCodes: [500] } })).toThrow();
  const policy = contract.auth.sourcePolicy;
  if (policy.status !== "qualified" || policy.routeClass !== "management") throw new Error("Expected qualified management policy");
  expect(() => validateAuthCsrfContract({ ...contract, auth: { ...contract.auth, sourcePolicy: { ...policy, alternatives: policy.alternatives.map(alternative => alternative.kind === "oma-access-token" ? { ...alternative, minimumScope: "read" } : alternative) } } })).toThrow();
  expect(() => validateAuthCsrfContract({ ...contract, response: { ...contract.response, schema: { type: "object", additionalProperties: true } } })).toThrow();
  contractChecked = true;
});


test("actual issuer binds the session, secret and expiry without random input", () => {
  const program = `
import { strict as assert } from 'node:assert';
import { createHash, createHmac } from 'node:crypto';
import { AuthCsrfFixture } from './test/fixtures/auth-csrf.fixture.ts';
const fixture = new AuthCsrfFixture();
const secret = 'fixture-only-secret';
const request = session => new Request('http://fixture.invalid/api/auth/csrf', { headers: { cookie: 'auth_token=' + session } });
process.env.JWT_SECRET = secret;
const now = Date.parse('2026-01-01T00:00:00Z');
const result = fixture.issue(request('first-session'), now);
assert.ok(result);
const expiry = Math.floor(now / 1000) + 600;
const hash = createHash('sha256').update('first-session').digest('base64url');
const mac = createHmac('sha256', secret).update('omniroute-dashboard-csrf-v1\\n' + expiry + '\\n' + hash).digest('base64url');
assert.ok(result.token === 'v1.' + expiry + '.' + mac);
assert.ok(result.expiresAt === new Date(expiry * 1000).toISOString());
assert.ok(fixture.issue(request('first-session'), now + 999)?.token === result.token);
assert.ok(fixture.issue(request('first-session'), now + 1000)?.token !== result.token);
assert.ok(fixture.issue(request('second-session'), now)?.token !== result.token);
process.env.JWT_SECRET = 'different-fixture-secret';
assert.ok(fixture.issue(request('first-session'), now)?.token !== result.token);
process.env.JWT_SECRET = ' ';
assert.equal(fixture.issue(request('first-session'), now), null);
delete process.env.JWT_SECRET;
assert.equal(fixture.issue(request('first-session'), now), null);
process.env.JWT_SECRET = secret;
assert.equal(fixture.issue(new Request('http://fixture.invalid'), now), null);
`;
  const result = spawnSync(process.execPath, ["-e", program], { cwd: process.cwd(), encoding: "utf8" });
  expect(result.status).toBe(0);
  issuerChecked = true;
});

test("management pipeline and handler guard protect the actual issuer", async () => {
  for (const credential of [undefined, "invalid-fixture-secret"]) {
    expect([401, 403]).toContain((await fixture.handle(credential)).status);
  }
  for (const credential of ["oma_fixture-read", "oma_fixture-write"]) expect((await fixture.handle(credential)).status).toBe(403);
  expect((await fixture.handle("fixture-auth-error")).status).toBe(503);
  for (const credential of ["fixture-manage", "fixture-admin", "oma_fixture-admin"]) {
    const response = await fixture.handle(credential);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.has("set-cookie")).toBe(false);
    expect(JSON.stringify(await response.json()) === JSON.stringify({ token: null, expiresAt: null })).toBe(true);
  }
  const before = { handlerCalls: fixture.calls };
  const response = await fixture.handle("session");
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.has("set-cookie")).toBe(false);
  const body = await response.json() as { token: unknown; expiresAt: unknown };
  expect(Object.keys(body).sort()).toEqual(["expiresAt", "token"]);
  expect(typeof body.token).toBe("string");
  expect(typeof body.expiresAt).toBe("string");
  expect(projectResponse(authCsrfDescriptor(), body)).toEqual({ issued: true });
  expect(fixtureRegistry([authCsrfDescriptor()]).require(AUTH_CSRF_ID).projectTarget(body)).toEqual({ issued: true });
  expect(projectResponse(authCsrfDescriptor(), { token: null, expiresAt: null })).toEqual({ issued: false });
  expect(() => projectResponse(authCsrfDescriptor(), { ...body, privateField: true })).toThrow();
  expect(() => projectResponse(authCsrfDescriptor(), { token: "invalid", expiresAt: null })).toThrow();
  const after = { handlerCalls: fixture.calls };
  const disabled = await fixture.handle(undefined, false);
  expect(disabled.status).toBe(200);
  expect(JSON.stringify(await disabled.json()) === JSON.stringify({ token: null, expiresAt: null })).toBe(true);
  observation = { before, after, result: { status: response.status, body: projectResponse(authCsrfDescriptor(), body) } };
});
