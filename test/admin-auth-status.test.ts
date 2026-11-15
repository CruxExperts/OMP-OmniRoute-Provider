import { expect, test } from "bun:test";
import { validateAuthStatusContract } from "../scripts/generate-contracts.ts";
import { createAdminExecutor } from "../src/admin/executor.ts";
import type { AdminOperationAuthBinding } from "../src/admin/types.ts";
import { OperationRegistry, projectResponse, type OperationDescriptor } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { AUTH_STATUS_ID, AuthStatusFixture, authStatusContract, authStatusDescriptor, signFixtureToken } from "./fixtures/auth-status.fixture.ts";

/** Synthetic executor authority only: unknown effects remain ineligible in production. */
function statusExecutorRegistry(descriptors: readonly OperationDescriptor[]): OperationRegistry {
  const registry = fixtureRegistry(descriptors);
  return new class extends OperationRegistry {
    constructor() { super([]); }
    override require(operationId: string) {
      const adapter = registry.require(operationId);
      return { ...adapter, eligibility: { operationId, status: "verified" as const, reason: "Synthetic executor fixture only." } };
    }
  }();
}

async function expectStatus(response: Response, authenticated: boolean): Promise<void> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  const body = await response.json();
  expect(body).toEqual({ authenticated });
  expect(projectResponse(authStatusDescriptor(), body)).toEqual({ authenticated });
}

test("status handler rejects absent secret, absent cookie, invalid JWT and expired or unclaimed sessions", async () => {
  const fixture = new AuthStatusFixture();
  try {
    const now = Math.floor(Date.now() / 1000);
    const token = signFixtureToken({ authenticated: true, iat: now, jti: "fixture-id", exp: now + 3600 });
    await expectStatus(await fixture.handle(), false);
    await expectStatus(await fixture.handle(token, null), false);
    await expectStatus(await fixture.handle(token, "wrong-fixture-secret"), false);
    const parts = token.split(".");
    const signature = parts[2]!;
    await expectStatus(await fixture.handle(`${parts[0]}.${parts[1]}.${signature[0] === "A" ? "B" : "A"}${signature.slice(1)}`), false);
    await expectStatus(await fixture.handle(signFixtureToken({ authenticated: true, iat: now - 100, exp: now - 1 })), false);
    await expectStatus(await fixture.handle(signFixtureToken({ authenticated: false, exp: now + 3600 })), false);
    expect(fixture.reads).toBe(0);
    await expectStatus(await fixture.handle(token), true);
    expect(fixture.reads).toBe(1);
    expect(fixture.isPublic("/api/auth/status", "GET")).toBe(true);
    expect(fixture.isPublic("/api/auth/status-extra", "GET")).toBe(false);
  } finally { fixture.close(); }
});

test("source cache controls revoked and password-change visibility, expiry and failures", async () => {
  const fixture = new AuthStatusFixture();
  try {
    const now = Math.floor(Date.now() / 1000);
    const token = signFixtureToken({ authenticated: true, iat: now, jti: "fixture-id", exp: now + 3600 });
    await expectStatus(await fixture.handle(token), true);
    expect(fixture.reads).toBe(1);
    fixture.set("revokedDashboardSessions", [{ jti: "fixture-id", exp: now + 3600 }]);
    await expectStatus(await fixture.handle(token), true);
    expect(fixture.reads).toBe(1);
    fixture.clearCache();
    await expectStatus(await fixture.handle(token), false);
    expect(fixture.reads).toBe(2);
    fixture.set("revokedDashboardSessions", []);
    fixture.set("sessionsValidAfter", now + 1);
    fixture.now += 5001;
    await expectStatus(await fixture.handle(token), false);
    expect(fixture.reads).toBe(3);
    fixture.set("sessionsValidAfter", now);
    fixture.clearCache();
    await expectStatus(await fixture.handle(token), true);
    fixture.fail = true;
    await expectStatus(await fixture.handle(token), true);
    fixture.clearCache();
    await expectStatus(await fixture.handle(token), false);
    fixture.fail = false;
    await expectStatus(await fixture.handle(token), true);
  } finally { fixture.close(); }
});

test("valid session cache miss can durably complete onboarding and cannot be an ordinary read", async () => {
  const fixture = new AuthStatusFixture();
  try {
    const now = Math.floor(Date.now() / 1000);
    const token = signFixtureToken({ authenticated: true, iat: now, jti: "fixture-id", exp: now + 3600 });
    const rows = fixture.db.query("SELECT key, value FROM key_value WHERE namespace = 'settings' AND key IN ('setupComplete', 'requireLogin') ORDER BY key");
    expect(rows.all()).toEqual([]);
    await expectStatus(await fixture.handle(token, undefined, "fixture-onboarding-password"), true);
    expect(rows.all()).toEqual([{ key: "requireLogin", value: "true" }, { key: "setupComplete", value: "true" }]);
    expect(authStatusContract().sideEffect).toBe("lifecycle");
    expect(authStatusContract().confirmation.required).toBe(true);
    expect(authStatusContract().retry.allowed).toBe(false);
  } finally { fixture.close(); }
});
test("auth status admission preserves lifecycle and uncertain settlement", () => {
  const contract = authStatusContract();
  expect(() => validateAuthStatusContract(contract)).not.toThrow();
  for (const changed of [
    { ...contract, sideEffect: "read" },
    { ...contract, confirmation: { ...contract.confirmation, required: false } },
    { ...contract, retry: { allowed: true, maxAttempts: 2, statusCodes: [500] } },
    { ...contract, mutationSafety: { ...contract.mutationSafety!, settlement: { responseComplete: { statusCodes: [200] }, definiteRejection: null } } },
    { ...contract, auth: { ...contract.auth, sourcePolicy: { ...contract.auth.sourcePolicy, optionalSessionCookie: undefined } } },
  ]) expect(() => validateAuthStatusContract(changed)).toThrow();
});


test("candidate projection is bounded and forbids caller-supplied cookies or arbitrary input", () => {
  const adapter = fixtureRegistry([authStatusDescriptor()]).require(AUTH_STATUS_ID);
  expect(adapter.validate({})).toEqual({ path: {}, query: {} });
  expect(() => adapter.validate({ cookie: "fixture-private-cookie" })).toThrow();
  expect(() => adapter.validate({ query: { token: "fixture-private-token" } })).toThrow();
  expect(() => adapter.validate({ body: {} })).toThrow();
  expect(adapter.project({ authenticated: true, token: "fixture-private-token" })).toEqual({ authenticated: true });
  expect(() => adapter.project({ authenticated: "true" })).toThrow();
});

test("optional status cookie is endpoint-bound, ephemeral and never forwarded to other public routes", async () => {
  const endpoint = "http://127.0.0.1:20128";
  const secret = "fixture-dashboard-cookie-secret";
  const status = authStatusDescriptor();
  const other = { ...status, operationId: "GET /fixture/public", pathTemplate: "/fixture/public",
    auth: { ...status.auth, sourcePolicy: { status: "qualified" as const, source: "omniroute-v3.8.53" as const, routeClass: "public" as const, alternatives: [{ kind: "anonymous" as const }] as const } } };
  const seen: AdminOperationAuthBinding[] = [];
  const executor = createAdminExecutor({ registry: statusExecutorRegistry([status, other]), dispatch: async (request, context) => {
    if (request.operationId === AUTH_STATUS_ID) await executor.authorize(request, context.auth);
    seen.push(context.auth);
    expect(context.retryAllowed).toBe(false);
    return { kind: "response", status: 200, body: { authenticated: false } };
  } });
  executor.setAdminBinding({ profileId: "omniroute", endpoint });
  const anonymous = await executor.plan(AUTH_STATUS_ID, {});
  expect((await executor.apply(anonymous.planId, { confirmed: true })).status).toBe("unknown");
  expect(seen.at(-1)?.credential).toBeUndefined();
  executor.bindCredential({ profileId: "omniroute", endpoint, cookie: secret });
  const plan = await executor.plan(AUTH_STATUS_ID, {});
  expect(JSON.stringify(plan)).not.toContain(secret);
  const result = await executor.apply(plan.planId, { confirmed: true });
  expect(result.status).toBe("unknown");
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(seen.at(-1)?.credential).toEqual({ kind: "cookie", value: secret });
  const otherPlan = await executor.plan(other.operationId, {});
  await executor.apply(otherPlan.planId, { confirmed: true });
  expect(seen.at(-1)?.credential).toBeUndefined();
  executor.bindCredential({ profileId: "omniroute", endpoint, apiKey: "fixture-api-secret" });
  const apiPlan = await executor.plan(AUTH_STATUS_ID, {});
  await executor.apply(apiPlan.planId, { confirmed: true });
  expect(seen.at(-1)?.credential).toBeUndefined();
  await expect(executor.plan(AUTH_STATUS_ID, {}, { profileId: "different", endpoint })).rejects.toMatchObject({ code: "credential-mismatch" });
  await expect(executor.plan(AUTH_STATUS_ID, {}, { profileId: "omniroute", endpoint: "http://127.0.0.1:20129" })).rejects.toMatchObject({ code: "credential-mismatch" });
});

test("cookie rotation, clear and cancellation invalidate status authority", async () => {
  const endpoint = "http://127.0.0.1:20128";
  let calls = 0;
  let captured: AdminOperationAuthBinding | undefined;
  const executor = createAdminExecutor({ registry: statusExecutorRegistry([authStatusDescriptor()]), dispatch: async (_request, context) => {
    calls++;
    captured = context.auth;
    executor.clearCredential();
    expect(context.signal?.aborted).toBe(true);
    return { kind: "response", status: 200, body: { authenticated: true } };
  } });
  executor.bindCredential({ profileId: "omniroute", endpoint, cookie: "first-cookie" });
  const rotated = await executor.plan(AUTH_STATUS_ID, {});
  executor.bindCredential({ profileId: "omniroute", endpoint, cookie: "second-cookie" });
  await expect(executor.apply(rotated.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-invalidated" });
  const cleared = await executor.plan(AUTH_STATUS_ID, {});
  executor.clearCredential();
  await expect(executor.apply(cleared.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-invalidated" });
  executor.bindCredential({ profileId: "omniroute", endpoint, cookie: "third-cookie" });
  const active = await executor.plan(AUTH_STATUS_ID, {});
  expect((await executor.apply(active.planId, { confirmed: true })).status).toBe("unknown");
  expect(captured?.signal?.aborted).toBe(true);
  expect(calls).toBe(1);
});

test("optional cookie capability rejects altered source and ungated descriptors", () => {
  const descriptor = authStatusDescriptor();
  expect(() => fixtureRegistry([{ ...descriptor, operationId: "GET /fixture/other", pathTemplate: "/fixture/other" }])).toThrow();
  expect(() => fixtureRegistry([{ ...descriptor, source: { ...descriptor.source, sha256: "0".repeat(64) } }])).toThrow();
  expect(() => fixtureRegistry([{ ...descriptor, sideEffect: "read" }])).toThrow();
  expect(() => fixtureRegistry([{ ...descriptor, confirmation: { required: false, reason: "incorrect" } }])).toThrow();
  expect(() => fixtureRegistry([{ ...descriptor, retry: { allowed: false, maxAttempts: 1, statusCodes: [503] } }])).toThrow();
  expect(() => fixtureRegistry([{ ...descriptor, sideEffect: "read", confirmation: { required: false, reason: "incorrect" } }])).toThrow();
  expect(() => fixtureRegistry([{ ...descriptor, retry: { allowed: true, maxAttempts: 2, statusCodes: [503] } }])).toThrow();
});

test("logout, disable and activation drift invalidate pending optional-cookie plans", async () => {
  const endpoint = "http://127.0.0.1:20128";
  for (const action of ["logout", "disable", "drift"] as const) {
    let calls = 0;
    const executor = createAdminExecutor({ registry: statusExecutorRegistry([authStatusDescriptor()]), dispatch: async () => { calls++; return {}; } });
    executor.bindCredential({ profileId: "omniroute", endpoint, cookie: "fixture-cookie" });
    const plan = await executor.plan(AUTH_STATUS_ID, {});
    if (action === "drift") executor.setAdminBinding({ profileId: "omniroute", endpoint: "http://127.0.0.1:20129" });
    else executor[action]();
    await expect(executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-invalidated" });
    expect(calls).toBe(0);
  }
});

test("status dispatch failures do not leak cookies or retry", async () => {
  const secret = "private-fixture-cookie";
  let calls = 0;
  const executor = createAdminExecutor({ registry: statusExecutorRegistry([authStatusDescriptor()]), dispatch: async () => {
    calls++;
    throw new Error(secret);
  } });
  executor.bindCredential({ profileId: "omniroute", endpoint: "http://127.0.0.1:20128", cookie: secret });
  const plan = await executor.plan(AUTH_STATUS_ID, {});
  const cancelled = new AbortController();
  cancelled.abort();
  await expect(executor.apply(plan.planId, { confirmed: true, signal: cancelled.signal })).rejects.toThrow();
  expect(calls).toBe(0);
  const result = await executor.apply(plan.planId, { confirmed: true });
  expect(result.status).toBe("unknown");
  expect(JSON.stringify(result)).not.toContain(secret);
  expect(calls).toBe(1);
});

test("pre-dispatch authorization rejects unowned, modified and unqualified requests", async () => {
  const endpoint = "http://127.0.0.1:20128";
  const registry = statusExecutorRegistry([authStatusDescriptor()]);
  let calls = 0;
  const executor = createAdminExecutor({ registry, dispatch: async (request, context) => {
    calls++;
    await executor.authorize(request, context.auth);
    await expect(executor.authorize({ ...request, operationId: "GET /fixture/missing" }, context.auth)).rejects.toMatchObject({ code: "unknown-operation" });
    await expect(executor.authorize({ ...request, operation: { ...request.operation, auth: { ...request.operation.auth, sourcePolicy: { status: "unknown" } } } }, context.auth)).rejects.toMatchObject({ code: "operation-unavailable" });
    await expect(executor.authorize({ ...request, path: "/api/other" }, context.auth)).rejects.toMatchObject({ code: "operation-unavailable" });
    await expect(executor.authorize({ ...request, url: `${endpoint}/api/other` }, context.auth)).rejects.toMatchObject({ code: "operation-unavailable" });
    const unqualifiedRegistry = fixtureRegistry([authStatusDescriptor()]);
    const unqualified = createAdminExecutor({ registry: unqualifiedRegistry, dispatch: async () => { throw new Error("unexpected dispatch"); } });
    unqualified.bindCredential({ profileId: "omniroute", endpoint, cookie: "fixture-cookie" });
    await expect(unqualified.authorize({ ...request, operation: unqualifiedRegistry.require(AUTH_STATUS_ID).descriptor }, context.auth)).rejects.toMatchObject({ code: "operation-unavailable" });
    return { kind: "response", status: 200, body: { authenticated: true } };
  } });
  executor.bindCredential({ profileId: "omniroute", endpoint, cookie: "fixture-cookie" });
  const plan = await executor.plan(AUTH_STATUS_ID, {});
  expect((await executor.apply(plan.planId, { confirmed: true })).status).toBe("unknown");
  expect(calls).toBe(1);
});
