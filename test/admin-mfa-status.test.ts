import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash, validateMfaStatusContract } from "../scripts/generate-contracts.ts";
import { createAdminExecutor } from "../src/admin/executor.ts";
import { canonicalizeJson, OperationRegistry, projectResponse, type OperationDescriptor } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { MFA_STATUS_ID, MfaStatusFixture, mfaStatusContract, mfaStatusDescriptor } from "./fixtures/mfa-status.fixture.ts";

const TEST_ID = "test/admin-mfa-status.test.ts";
let observation: { before: unknown; after: unknown; result: { status: number; body: unknown } } | undefined;
let consumerObserved = false;
afterAll(async () => {
  if (!observation || !consumerObserved) return;
  const contract = mfaStatusContract();
  const binding = operationEvidenceBinding(MFA_STATUS_ID, contract);
  const caseSha256 = testCaseSourceHash(TEST_ID);
  const path = outcomeArtifactPath(MFA_STATUS_ID);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), path), `${canonicalizeJson({ operationId: MFA_STATUS_ID, testId: TEST_ID, caseSha256, binding, observation })}\n`, { mode: 0o600 });
  testOutcomeHash(MFA_STATUS_ID, TEST_ID, caseSha256, binding, contract, path);
});

function fixture() {
  return new MfaStatusFixture({
    isDashboardSession: token => token === "fixture-session",
    verifyAccessToken: token => token === "oma_fixture-read" ? { id: "read", name: "read", scope: "read" } : token === "oma_fixture-admin" ? { id: "admin", name: "admin", scope: "admin" } : null,
    validateApiKey: key => key === "fixture-manage" || key === "fixture-read",
    getApiKeyMetadata: key => key === "fixture-manage" ? { id: "manage", scopes: ["manage"] } : key === "fixture-read" ? { id: "read", scopes: ["read"] } : null,
  });
}
function request(token?: string): Request {
  return new Request("http://fixture.invalid/api/auth/mfa/status", { headers: token ? { authorization: `Bearer ${token}` } : {} });
}
function registry(descriptors: readonly OperationDescriptor[]): OperationRegistry {
  const base = fixtureRegistry(descriptors);
  return new class extends OperationRegistry {
    constructor() { super([]); }
    override require(id: string) { return { ...base.require(id), eligibility: { operationId: id, status: "verified" as const, reason: "Synthetic executor fixture only." } }; }
  }();
}

test("source guard and status projection preserve private state", async () => {
  const f = fixture();
  try {
    const denied = await f.handle(request());
    expect(denied.status).toBe(401);
    expect(f.reads).toBe(0);
    const insufficient = await f.handle(request("fixture-read"));
    expect(insufficient.status).toBe(403);
    const readToken = await f.handle(request("oma_fixture-read"));
    expect(readToken.status).toBe(403);
    expect(f.reads).toBe(0);
    const adminToken = await f.handle(request("oma_fixture-admin"));
    expect(adminToken.status).toBe(200);
    expect(adminToken.headers.get("cache-control")).toBe("no-store");
    expect(f.reads).toBe(1);
    const row = JSON.stringify({ enabled: true, secret: "private-encrypted-seed", backupCodeHashes: ["private-hash-a", "private-hash-b"], enabledAt: "2025-01-01T00:00:00.000Z" });
    f.db.prepare("INSERT INTO key_value (namespace,key,value) VALUES ('dashboardMfa','state',?)").run(row);
    const state = () => {
      const value = f.db.query("SELECT value FROM key_value WHERE namespace = 'dashboardMfa' AND key = 'state'").get();
      if (!value || typeof value !== "object" || !("value" in value) || typeof value.value !== "string") throw new Error("Invalid SQLite row");
      return { rows: 1, unchanged: value.value === row };
    };
    const before = state();
    const response = await f.handle(request("fixture-manage"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const raw = await response.json();
    const body = projectResponse(mfaStatusDescriptor(), raw);
    expect(body).toEqual({ enabled: true, backupCodesRemaining: 2, recoverySwitchSet: false });
    expect(JSON.stringify(body)).not.toContain("private-");
    const after = state();
    expect(after).toEqual(before);
    observation = { before, after, result: { status: response.status, body } };
    f.fail = true;
    const failure = await f.handle(request("fixture-manage"));
    expect(failure.status).toBe(500);
    expect(failure.headers.get("cache-control")).toBe("no-store");
    expect(await failure.text()).not.toContain("private backend failure");
  } finally { f.close(); }
});

test("MFA candidate enforces authorization and lifecycle settlement", () => {
  const contract = mfaStatusContract();
  expect(() => validateMfaStatusContract(contract)).not.toThrow();
  for (const altered of [
    { ...contract, sideEffect: "read" },
    { ...contract, confirmation: { ...contract.confirmation, required: false } },
    { ...contract, retry: { allowed: true, maxAttempts: 2, statusCodes: [500] } },
    { ...contract, mutationSafety: { ...contract.mutationSafety!, settlement: { responseComplete: { statusCodes: [200] }, definiteRejection: null } } },
    { ...contract, auth: { ...contract.auth, domain: "public" } },
  ]) expect(() => validateMfaStatusContract(altered)).toThrow();
  const adapter = fixtureRegistry([mfaStatusDescriptor()]).require(MFA_STATUS_ID);
  expect(adapter.validate({})).toEqual({ path: {}, query: {} });
  expect(() => adapter.validate({ body: {} })).toThrow();
  expect(() => adapter.validate({ query: { token: "fixture-private" } })).toThrow();
  expect(adapter.project({ enabled: true, backupCodesRemaining: 1, recoverySwitchSet: false, secret: "fixture-private", enabledAt: "private-time" })).toEqual({ enabled: true, backupCodesRemaining: 1, recoverySwitchSet: false });
});

test("executor requires confirmation, does not retry, and preserves unknown settlement", async () => {
  const f = fixture();
  try {
    let calls = 0;
    const executor = createAdminExecutor({ registry: registry([mfaStatusDescriptor()]), dispatch: async (operation, context) => {
      calls++;
      expect(context.retryAllowed).toBe(false);
      const credential = context.auth.credential;
      const response = await f.handle(request(credential?.kind === "apiKey" ? credential.value : undefined));
      return { kind: "response", status: response.status, body: await response.json() };
    } });
    const endpoint = "http://127.0.0.1:20128";
    executor.setAdminBinding({ profileId: "omniroute", endpoint });
    executor.bindCredential({ profileId: "omniroute", endpoint, apiKey: "fixture-manage" });
    const plan = await executor.plan(MFA_STATUS_ID, {});
    const result = await executor.apply(plan.planId, { confirmed: true });
    expect(result.status).toBe("unknown");
    expect(calls).toBe(1);
    expect(JSON.stringify(result)).not.toContain("fixture-manage");
    consumerObserved = true;
  } finally { f.close(); }
});
