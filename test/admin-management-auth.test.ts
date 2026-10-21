import { afterAll, afterEach, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash } from "../scripts/generate-contracts.ts";
import { invokeJsonAdapter } from "../src/admin/adapters.ts";
import { createAdminExecutor } from "../src/admin/executor.ts";
import { getOperation, type OperationDescriptor } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { ManagementAuthFixture, WHOAMI_OPERATION_ID, whoamiSourceContract, type FixtureAccessRecord, type FixtureAccessScope } from "./fixtures/management-auth.fixture.ts";

const TEST_ID = "test/admin-management-auth.test.ts";
const NOW = "2026-10-19T12:00:00.000Z";
const contract = whoamiSourceContract();
const source = getOperation(WHOAMI_OPERATION_ID);
if (!source) throw new Error("pinned whoami operation missing");
const descriptor: OperationDescriptor = {
  ...source,
  ...contract,
  mediaType: { request: null, response: "application/json" },
  coverage: { status: "invokable", adapterId: "typed.fixture.management.whoami", reason: null },
};
const registry = fixtureRegistry([descriptor]);
const adapter = registry.require(WHOAMI_OPERATION_ID);
const fixtures = new Set<ManagementAuthFixture>();
const observed = new Map<string, { before: unknown; after: unknown; status: number; body: unknown; authorityKind: string }>();

function accessRecord(scope: FixtureAccessScope, overrides: Partial<FixtureAccessRecord> = {}): FixtureAccessRecord {
  return { secret: `oma_fixture_${scope}`, id: `fixture-${scope}`, name: `Fixture ${scope}`, scope, createdAt: "2026-10-18T12:00:00.000Z", lastUsedAt: null, expiresAt: null, revokedAt: null, ...overrides };
}
function fixture(options: ConstructorParameters<typeof ManagementAuthFixture>[0] = {}): ManagementAuthFixture {
  const value = new ManagementAuthFixture({ clock: () => NOW, ...options });
  fixtures.add(value);
  return value;
}
function invocation(target: ManagementAuthFixture, credential?: { kind: "apiKey" | "cookie"; value: string }) {
  return {
    descriptor: { ...adapter.descriptor, adapterId: adapter.adapterId },
    endpoint: target.endpoint,
    resolvedPath: adapter.buildPath(adapter.validate({})),
    queryParameters: [],
    ...(credential ? { credential } : {}),
  };
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fixture response must be an object");
  return value as Record<string, unknown>;
}
function capture(label: string, target: ManagementAuthFixture, before: unknown, status: number, body: unknown, authorityKind: string): void {
  observed.set(label, { before, after: target.snapshot(), status, body, authorityKind });
}

afterEach(() => { for (const target of fixtures) target.stop(); fixtures.clear(); });

for (const scope of ["read", "write", "admin"] as const) {
  test(`whoami discloses only the actual ${scope} scope and safely omits identity fields`, async () => {
    const row = accessRecord(scope);
    const target = fixture({ tokens: [row] });
    const before = target.snapshot();
    const response = await invokeJsonAdapter(invocation(target, { kind: "apiKey", value: row.secret }));
    expect(response.status).toBe(200);
    const raw = record(response.data);
    expect(raw.authenticated).toBe(true);
    expect(raw.viaAccessToken).toBe(true);
    expect(raw.scope).toBe(scope);
    expect(raw.lastUsedAt).toBe(NOW);
    expect(raw.expiresAt).toBeNull();
    const projected = adapter.project(raw);
    expect(projected).toEqual({ authenticated: true, scope });
    expect(target.snapshot().records).toEqual([{ id: row.id, scope, lastUsedAt: NOW, expiresAt: null, revokedAt: null }]);
    capture(`cli-${scope}`, target, before, response.status, projected, "scoped-cli");
  });
}

for (const grant of ["manage", "admin"] as const) {
  test(`a management ${grant} key remains opaque rather than becoming a CLI scope grant`, async () => {
    const target = fixture({ keys: { "fixture-opaque": [grant] } });
    const before = target.snapshot();
    const response = await invokeJsonAdapter(invocation(target, { kind: "apiKey", value: "fixture-opaque" }));
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ authenticated: true, viaAccessToken: false, scope: null });
    const projected = adapter.project(response.data);
    expect(projected).toEqual({ authenticated: true, scope: null });
    capture(`key-${grant}`, target, before, response.status, projected, "server-enforced");
  });
}

test("a valid dashboard session does not assert a scoped CLI grant", async () => {
  const target = fixture({ cookies: ["fixture_dashboard=valid"] });
  const before = target.snapshot();
  const response = await invokeJsonAdapter(invocation(target, { kind: "cookie", value: "fixture_dashboard=valid" }));
  expect(response.status).toBe(200);
  expect(response.data).toEqual({ authenticated: true, viaAccessToken: false, scope: null });
  capture("dashboard", target, before, response.status, adapter.project(response.data), "server-enforced");
});

test("authentication-disabled success never proves that an arbitrary key has full access", async () => {
  const target = fixture();
  target.authRequired = false;
  const before = target.snapshot();
  const anonymous = await invokeJsonAdapter(invocation(target));
  expect(anonymous.status).toBe(200);
  expect(anonymous.data).toEqual({ authenticated: true, viaAccessToken: false, scope: null });
  const response = await invokeJsonAdapter(invocation(target, { kind: "apiKey", value: "oma_fixture_unknown" }));
  expect(response.status).toBe(200);
  expect(response.data).toEqual({ authenticated: true, viaAccessToken: false, scope: null });
  capture("auth-disabled", target, before, response.status, adapter.project(response.data), "unproved");
});

const failures: readonly { label: string; expected: number; record?: FixtureAccessRecord; credential?: string; keyScopes?: readonly string[]; unavailable?: boolean }[] = [
  { label: "missing-credential", expected: 401 },
  { label: "invalid-key", expected: 403, credential: "fixture-invalid" },
  { label: "insufficient-key", expected: 403, credential: "fixture-key", keyScopes: ["self:usage"] },
  { label: "narrow-mcp-key", expected: 403, credential: "fixture-key", keyScopes: ["mcp:connect"] },
  { label: "unknown-cli", expected: 401, credential: "oma_fixture_unknown" },
  { label: "expired-cli", expected: 401, record: accessRecord("read", { expiresAt: NOW }), credential: "oma_fixture_read" },
  { label: "revoked-cli", expected: 401, record: accessRecord("read", { revokedAt: "2026-10-19T11:59:59.000Z" }), credential: "oma_fixture_read" },
  { label: "verification-unavailable", expected: 503, record: accessRecord("read"), credential: "oma_fixture_read", unavailable: true },
];
for (const scenario of failures) {
  test(`whoami rejects ${scenario.label} without inventing authority`, async () => {
    const target = fixture({ tokens: scenario.record ? [scenario.record] : [], keys: scenario.keyScopes ? { "fixture-key": scenario.keyScopes } : {} });
    target.failVerification = scenario.unavailable === true;
    const before = target.snapshot();
    const response = await invokeJsonAdapter(invocation(target, scenario.credential ? { kind: "apiKey", value: scenario.credential } : undefined));
    expect(response.status).toBe(scenario.expected);
    expect(record(response.data).authenticated).toBeUndefined();
    expect(target.snapshot()).toEqual(before);
    capture(scenario.label, target, before, response.status, null, "denied");
  });
}

test("query credentials cannot authenticate whoami and undeclared inputs fail before dispatch", async () => {
  const target = fixture({ keys: { "fixture-key": ["manage"] } });
  const before = target.snapshot();
  expect(() => adapter.validate({ query: { api_key: "fixture-key" } })).toThrow();
  expect(() => adapter.validate({ body: {} })).toThrow();
  expect(target.requests).toBe(0);
  const response = await fetch(`${target.endpoint}/api/cli/whoami?api_key=fixture-key`);
  expect(response.status).toBe(401);
  capture("no-query-auth", target, before, response.status, null, "denied");
});

test("the human operation executor exposes only projected whoami metadata", async () => {
  const target = fixture({ keys: { "fixture-key": ["manage"] } });
  const before = target.snapshot();
  const executor = createAdminExecutor({ registry, dispatch: async request => {
    const response = await invokeJsonAdapter({ ...invocation(target, { kind: "apiKey", value: "fixture-key" }), resolvedPath: request.path, queryParameters: request.queryParameters });
    if (response.status >= 400) throw Object.assign(new Error("fixture HTTP authorization denied"), { status: response.status });
    return response.data;
  } });
  executor.bindCredential({ profileId: "management-source-fixture", endpoint: target.endpoint, apiKey: "fixture-key" });
  const response = await executor.read(WHOAMI_OPERATION_ID, {});
  expect(response.output).toEqual({ authenticated: true, scope: null });
  expect(target.requests).toBe(1);
  capture("executor-read", target, before, 200, response.output, "server-enforced");
  executor.shutdown();
});

afterAll(async () => {
  const required = ["cli-read", "cli-write", "cli-admin", "key-manage", "key-admin", "dashboard", "auth-disabled", ...failures.map(scenario => scenario.label), "no-query-auth", "executor-read"];
  if (required.some(label => !observed.has(label))) return;
  const binding = operationEvidenceBinding(WHOAMI_OPERATION_ID, contract);
  const caseSha256 = testCaseSourceHash(TEST_ID);
  const path = outcomeArtifactPath(WHOAMI_OPERATION_ID);
  const cases = required.map(label => ({ label, ...observed.get(label)! }));
  const primary = observed.get("cli-read")!;
  const artifact = {
    operationId: WHOAMI_OPERATION_ID,
    testId: TEST_ID,
    caseSha256,
    binding,
    observation: {
      before: cases.map(({ label, before }) => ({ case: label, state: before })),
      after: cases.map(({ label, after, status, body, authorityKind }) => ({ case: label, state: after, status, body, authorityKind })),
      result: { status: primary.status, body: primary.body },
    },
  };
  await mkdir(resolve(import.meta.dir, "../.agents/state/omp-provider-release/qualification-observations"), { recursive: true });
  await writeFile(resolve(import.meta.dir, "..", path), `${JSON.stringify(artifact, null, 2)}\n`, { mode: 0o600 });
  testOutcomeHash(WHOAMI_OPERATION_ID, TEST_ID, caseSha256, binding, contract, path);
});
