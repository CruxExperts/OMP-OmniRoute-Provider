import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import ts from "typescript";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash, validateAuthCsrfContract } from "../scripts/generate-contracts.ts";
import { canonicalizeJson, projectResponse } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { AUTH_CSRF_ID, AuthCsrfFixture, authCsrfContract, authCsrfDescriptor } from "./fixtures/auth-csrf.fixture.ts";
import { readPinnedSource } from "./fixtures/pinned-handler.fixture.ts";

const fixture = new AuthCsrfFixture();
let observation: { before: unknown; after: unknown; result: { status: number; body: unknown } } | undefined;
let issuerChecked = false;
let contractChecked = false;
let schemaChecked = false;
afterAll(async () => {
  if (!observation || !issuerChecked || !contractChecked || !schemaChecked) return;
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

test("CSRF schema conditions bind ingress and distinct effect domains", () => {
  type Clause = {
    if: { properties: { operationId?: { const?: string; enum?: string[] } } };
    then: { required?: string[]; properties?: { binding?: { required: string[] }; effectEvidence?: { properties: { artifact: { pattern: string } } }; qualification?: { required: string[]; properties?: { binding: { required: string[] } } } } };
    else?: { not?: { required: string[] }; properties?: { qualification: { not: { required: string[] } } } };
  };
  const eligibility = JSON.parse(readFileSync(resolve(process.cwd(), "contracts/release-eligibility.schema.json"), "utf8")) as { $defs: { operation: { allOf: Clause[] }; effectEvidence: { properties: { artifact: { pattern: string } } } } };
  const operations = JSON.parse(readFileSync(resolve(process.cwd(), "contracts/operations.schema.json"), "utf8")) as { $defs: { operation: { allOf: Clause[] } } };
  const conditions = eligibility.$defs.operation.allOf;
  const csrf = conditions.find(row => row.if.properties.operationId?.const === AUTH_CSRF_ID)!;
  const deprecated = conditions.find(row => row.if.properties.operationId?.const === "GET /api/providers/deprecated")!;
  const effect = conditions.find(row => row.then.required?.includes("effectEvidence") && row.else)!;
  const ingress = conditions.find(row => row.then.required?.includes("ingressEvidence") && row.else)!;
  const receiptConditions = operations.$defs.operation.allOf;
  const receipt = receiptConditions.find(row => row.if.properties.operationId?.const === AUTH_CSRF_ID)!;
  const receiptEffect = receiptConditions.find(row => row.then.properties?.qualification?.required?.includes("effectSha256") && row.else)!;
  const receiptIngress = receiptConditions.find(row => row.then.properties?.qualification?.required?.includes("ingressSha256") && row.else)!;
  expect(effect.if.properties.operationId?.enum).toContain(AUTH_CSRF_ID);
  expect(effect.if.properties.operationId?.enum).toContain("GET /api/providers/deprecated");
  expect(effect.if.properties.operationId?.enum).not.toContain("GET /api/health");
  expect(effect.else?.not?.required).toContain("effectEvidence");
  expect(ingress.if.properties.operationId?.enum).toContain(AUTH_CSRF_ID);
  expect(ingress.else?.not?.required).toContain("ingressEvidence");
  expect(csrf.then.required).toEqual(expect.arrayContaining(["effectEvidence", "lifecycleEvidence", "ingressEvidence"]));
  expect(csrf.then.properties?.binding?.required).toContain("databaseInitializationRequired");
  expect(receipt.then.required).toContain("databaseInitializationRequired");
  expect(receipt.then.properties?.qualification?.required).toEqual(expect.arrayContaining(["effectSha256", "lifecycleSha256", "ingressSha256"]));
  expect(receipt.then.properties?.qualification?.properties?.binding.required).toContain("databaseInitializationRequired");
  for (const condition of [receiptEffect, receiptIngress]) expect(condition.if.properties.operationId?.enum).toContain(AUTH_CSRF_ID);
  expect(receiptEffect.else?.properties?.qualification.not.required).toContain("effectSha256");
  expect(receiptIngress.else?.properties?.qualification.not.required).toContain("ingressSha256");
  const csrfPath = `provenance/qualification/csrf-lifecycle-${"0".repeat(64)}.json`;
  const sweepPath = `provenance/qualification/deprecated-provider-sweep-${"0".repeat(64)}.json`;
  const union = new RegExp(eligibility.$defs.effectEvidence.properties.artifact.pattern);
  const csrfPattern = new RegExp(csrf.then.properties!.effectEvidence!.properties.artifact.pattern);
  const sweepPattern = new RegExp(deprecated.then.properties!.effectEvidence!.properties.artifact.pattern);
  expect([union.test(csrfPath), union.test(sweepPath)]).toEqual([true, true]);
  expect([csrfPattern.test(csrfPath), csrfPattern.test(sweepPath), sweepPattern.test(sweepPath), sweepPattern.test(csrfPath)]).toEqual([true, false, true, false]);
  schemaChecked = true;
});


test("actual issuer binds the session, secret and expiry without random input", () => {
  // Authenticate source in this process, which has already loaded the pinned tree.
  // The child receives only compiled issuer modules, not the management fixture graph.
  const [constants, issuer] = ["src/shared/constants/dashboardCsrf.ts", "src/server/authz/csrf.ts"].map(path =>
    ts.transpileModule(readPinnedSource(path), { fileName: path, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText,
  );
  const program = `
import { strict as assert } from 'node:assert';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
const load = (source, require) => { const module = { exports: {} }; new Function('require', 'module', 'exports', source)(require, module, module.exports); return module.exports; };
const constants = load(${JSON.stringify(constants)}, specifier => { throw new Error('Unexpected constant dependency: ' + specifier); });
const issuer = load(${JSON.stringify(issuer)}, specifier => {
  if (specifier === 'node:crypto') return { createHash, createHmac, timingSafeEqual };
  if (specifier === '@/shared/constants/dashboardCsrf') return constants;
  throw new Error('Unexpected issuer dependency: ' + specifier);
});
const fixture = { issue: issuer.issueDashboardCsrfToken };
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
  const result = spawnSync(process.execPath, ["-e", program], { cwd: process.cwd(), encoding: "utf8", timeout: 30_000 });
  expect({ status: result.status, signal: result.signal, error: result.error?.message, stderr: result.stderr }).toEqual({ status: 0, signal: null, error: undefined, stderr: "" });
  issuerChecked = true;
}, 45_000);

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
