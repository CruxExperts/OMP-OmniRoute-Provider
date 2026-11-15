import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash } from "../scripts/generate-contracts.ts";
import { createAdminExecutor } from "../src/admin/executor.ts";
import { canonicalizeJson, getOperation, type OperationDescriptor } from "../src/admin/registry.ts";
import { assertSafetyReadRequest, assertSafetyReadResponse, mapRelationInput, projectRelationSnapshot } from "../src/admin/relations.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { sourceUnpaginatedListProofMatches } from "../src/admin/source-normalization.ts";
import { KEY_GRANTS_PREFLIGHT, keyGrantsPreflightMatches, keyGrantsPreflightSnapshot, normalizeKeyRequest } from "../src/admin/source-keys.ts";
import { requiredOmaScope } from "../src/admin/authorization-policy.ts";
import { sourceRequestIssue } from "../src/admin/source-validation.ts";
import { KEY_OPERATION_IDS, KEY_SOURCE_CONTRACTS, projectCompleteKeyGrants, projectKeyGrant, projectKeyGrantPage } from "./fixtures/keys.fixture.ts";
import { createPinnedKeyHandlers } from "./fixtures/pinned-key-handlers.fixture.ts";
import { createPinnedFixtureDate, loadPinnedAccessTokenAuth } from "./fixtures/pinned-handler.fixture.ts";

// Mutations and the item read remain held pending their independent qualification.
const REQUIRED_CASES: Readonly<Record<typeof KEY_OPERATION_IDS[number], readonly string[]>> = {
  "GET /api/keys": ["complete-grants", "pagination", "auth-denial", "redaction", "handler-error"],
  "POST /api/keys": ["create", "invalid-nonmutation", "auth-denial", "scoped-auth", "expiry", "drift", "cancel", "rotation", "lost-response"],
  "GET /api/keys/{id}": ["read", "missing", "auth-denial", "redaction"],
  "PATCH /api/keys/{id}": ["apply-readback", "invalid-nonmutation", "auth-denial", "scoped-auth", "expiry", "drift", "cancel", "rotation", "lost-response"],
  "DELETE /api/keys/{id}": ["delete-readback", "missing", "auth-denial", "expiry", "drift", "cancel", "rotation", "lost-response"],
};
const HELD_SOURCE_ONLY_OPERATION_IDS = new Set<string>(KEY_OPERATION_IDS.filter(id => id !== "GET /api/keys"));
const completedCases = new Map<string, Set<string>>();
const operationObservations = new Map<string, unknown>();
function completeCase(operationId: string, caseId: string): void {
  const cases = completedCases.get(operationId) ?? new Set<string>();
  cases.add(caseId);
  completedCases.set(operationId, cases);
}

afterAll(async () => {
  const operationId = "GET /api/keys";
  const observation = operationObservations.get(operationId);
  if (!observation || !REQUIRED_CASES[operationId].every(caseId => completedCases.get(operationId)?.has(caseId))) return;
  const testId = "test/admin-keys.test.ts";
  const contract = KEY_SOURCE_CONTRACTS[operationId];
  const binding = operationEvidenceBinding(operationId, contract);
  const caseSha256 = testCaseSourceHash(testId);
  const artifactPath = outcomeArtifactPath(operationId);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId, testId, caseSha256, binding, observation })}\n`, { mode: 0o600 });
  testOutcomeHash(operationId, testId, caseSha256, binding, contract, artifactPath);
});

test("key inventory reports a storage failure", async () => {
  const fixture = createPinnedKeyHandlers();
  try {
    fixture.dropKeyTable();
    expect((await fixture.request("GET", "/api/keys", { token: "fixture-manage" })).status).toBe(500);
    completeCase("GET /api/keys", "handler-error");
  } finally { fixture.close(); }
});

function createHarness(fixture: { request: (method: "GET" | "POST" | "PATCH" | "DELETE", path: string, options?: { token?: string; body?: unknown; privatePolicy?: boolean }) => Promise<{ status: number; data: unknown }> }, now: () => number) {
  const descriptors: OperationDescriptor[] = KEY_OPERATION_IDS.map(operationId => {
    const source = getOperation(operationId);
    if (!source) throw new Error(`Missing source key operation: ${operationId}`);
    const contract = KEY_SOURCE_CONTRACTS[operationId];
    return { ...source, ...contract, mediaType: { request: contract.request.body?.mediaType ?? null, response: contract.response.mediaType }, coverage: { status: "invokable", adapterId: `typed.fixture.${operationId.toLowerCase().replace(/[^a-z0-9]+/g, ".")}`, reason: null } };
  });
  const registry = fixtureRegistry(descriptors);
  const counts = new Map<string, number>();
  let lost = false;
  const executor = createAdminExecutor({ registry, now,
    dispatch: async (request, context) => {
      const adapter = registry.require(request.operationId);
      const method = adapter.descriptor.method;
      if (method !== "GET" && method !== "POST" && method !== "PATCH" && method !== "DELETE") throw new Error("Unexpected key method");
      if (context.auth.credential?.kind !== "apiKey") throw new Error("Fixture requires a bound API key");
      const response = await fixture.request(method, request.path, { token: context.auth.credential.value, ...(request.body === undefined ? {} : { body: request.body }) });
      counts.set(request.operationId, (counts.get(request.operationId) ?? 0) + 1);
      if (response.status >= 400) throw Object.assign(new Error("Key request rejected"), { status: response.status });
      if (lost) { lost = false; throw Object.assign(new Error("lost key response"), { code: "network-lost-response", uncertain: true }); }
      return adapter.risk === "read" ? response.data : { kind: "response", status: response.status, body: response.data };
    },
    readTarget: async context => {
      const adapter = registry.require(context.relation.operationId);
      const input = adapter.validate(mapRelationInput(context.relation.inputs, context.payload));
      assertSafetyReadRequest(context.readCompleteness, adapter.descriptor, input);
      if (context.auth.credential?.kind !== "apiKey") throw new Error("Fixture requires a bound API key");
      const response = await fixture.request("GET", "/api/keys", { token: context.auth.credential.value, privatePolicy: true });
      assertSafetyReadResponse(context.readCompleteness, adapter.descriptor, response.data);
      const snapshot = projectRelationSnapshot(context.relation, adapter.projectTarget(response.data), context.payload);
      return { snapshot, digest: createHash("sha256").update(canonicalizeJson(snapshot)).digest("hex") };
    },
    reconcile: async () => ({ status: "unknown" }),
  });
  executor.setAdminBinding({ profileId: "keys-fixture", endpoint: "http://127.0.0.1:3190" }, true);
  executor.bindCredential({ profileId: "keys-fixture", endpoint: "http://127.0.0.1:3190", apiKey: "fixture-manage" });
  return { executor, dispatchCount: (id: string) => counts.get(id) ?? 0, loseNext: () => { lost = true; } };
}
test("key executor applies create, update and delete exactly once", async () => {
  const fixture = createPinnedKeyHandlers();
  const harness = createHarness(fixture, () => 1000);
  try {
    const create = await harness.executor.plan("POST /api/keys", { body: { name: "planned", allowedCombos: ["Alpha"] } });
    const result = await harness.executor.apply(create.planId, { confirmed: true });
    expect(result.status).toBe("unknown");
    const inventory = projectCompleteKeyGrants((await fixture.request("GET", "/api/keys", { token: "fixture-manage" })).data);
    expect(inventory.total).toBe(1);
    const grant = inventory.keys[0];
    if (!grant) throw new Error("Created grant missing");
    const update = await harness.executor.plan("PATCH /api/keys/{id}", { path: { id: grant.id }, body: { allowedCombos: ["Beta"] } });
    expect((await harness.executor.apply(update.planId, { confirmed: true })).status).toBe("unknown");
    expect((await fixture.request("GET", `/api/keys/${grant.id}`, { token: "fixture-manage" })).data).toEqual({ id: grant.id, allowedCombos: ["Beta"] });
    const deletion = await harness.executor.plan("DELETE /api/keys/{id}", { path: { id: grant.id } });
    expect((await harness.executor.apply(deletion.planId, { confirmed: true })).status).toBe("unknown");
    expect((await fixture.request("GET", `/api/keys/${grant.id}`, { token: "fixture-manage" })).status).toBe(404);
    for (const id of ["POST /api/keys", "PATCH /api/keys/{id}", "DELETE /api/keys/{id}"]) expect(harness.dispatchCount(id)).toBe(1);
  } finally { harness.executor.shutdown(); fixture.close(); }
});
test("key executor binds policy drift and refuses replay after uncertainty", async () => {
  const fixture = createPinnedKeyHandlers();
  let now = 1000;
  const harness = createHarness(fixture, () => now);
  try {
    const created = await fixture.request("POST", "/api/keys", { token: "fixture-manage", body: { name: "target", allowedCombos: ["Alpha"] } });
    const grant = projectKeyGrant(created.data);
    const path = `/api/keys/${encodeURIComponent(grant.id)}`;
    const input = { path: { id: grant.id }, body: { allowedCombos: ["Beta"] } };
    const stale = await harness.executor.plan("PATCH /api/keys/{id}", input);
    expect((await fixture.request("PATCH", path, { token: "fixture-manage", body: { allowedCombos: ["Changed"] } })).status).toBe(200);
    await expect(harness.executor.apply(stale.planId, { confirmed: true })).rejects.toMatchObject({ code: "target-drift" });
    expect(harness.dispatchCount("PATCH /api/keys/{id}")).toBe(0);
    const policyDrift = await harness.executor.plan("PATCH /api/keys/{id}", input);
    expect((await fixture.request("PATCH", path, { token: "fixture-manage", body: { noLog: true } })).status).toBe(200);
    await expect(harness.executor.apply(policyDrift.planId, { confirmed: true })).rejects.toMatchObject({ code: "target-drift" });
    const cancelled = await harness.executor.plan("PATCH /api/keys/{id}", input);
    const abort = new AbortController(); abort.abort();
    await expect(harness.executor.apply(cancelled.planId, { confirmed: true, signal: abort.signal })).rejects.toMatchObject({ code: "plan-invalidated" });
    const expired = await harness.executor.plan("PATCH /api/keys/{id}", input);
    now = expired.expiresAt;
    await expect(harness.executor.apply(expired.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-expired" });
    const rotated = await harness.executor.plan("PATCH /api/keys/{id}", input);
    harness.executor.bindCredential({ profileId: "keys-fixture", endpoint: "http://127.0.0.1:3190", apiKey: "rotated-fixture" });
    await expect(harness.executor.apply(rotated.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-invalidated" });
    harness.executor.bindCredential({ profileId: "keys-fixture", endpoint: "http://127.0.0.1:3190", apiKey: "fixture-manage" });
    const lost = await harness.executor.plan("PATCH /api/keys/{id}", input);
    harness.loseNext();
    const outcome = await harness.executor.apply(lost.planId, { confirmed: true });
    expect(outcome.status).toBe("unknown");
    expect(harness.dispatchCount("PATCH /api/keys/{id}")).toBe(1);
    expect((await fixture.request("GET", path, { token: "fixture-manage" })).data).toEqual({ id: grant.id, allowedCombos: ["Beta"] });
  } finally { harness.executor.shutdown(); fixture.close(); }
});
test("key source refinements reject unsafe combinations", () => {
  expect(sourceRequestIssue("omniroute-v3.8.53.keys.create", { name: "x", modelAccessMode: "all", allowedModels: ["a"] })?.field).toBe("allowedModels");
  expect(sourceRequestIssue("omniroute-v3.8.53.keys.update", { connectionAccessMode: "restricted", allowedConnections: [] })?.field).toBe("allowedConnections");
  expect(sourceRequestIssue("omniroute-v3.8.53.keys.create", { name: "x", scopes: ["lease:exclusive"] })?.field).toBe("allowedConnections");
  expect(sourceRequestIssue("omniroute-v3.8.53.keys.update", { allowedCombos: ["x"] })).toBeUndefined();
  expect(normalizeKeyRequest("omniroute-v3.8.53.keys.update", { name: " name ", allowedCombos: [" Alpha "], dailyUsageLimitUsd: "4.5" })).toEqual({ name: "name", allowedCombos: ["Alpha"], dailyUsageLimitUsd: 4.5 });
  expect(requiredOmaScope("GET", "/api/keys/id")).toBe("read");
  expect(requiredOmaScope("PATCH", "/api/keys/id")).toBe("admin");
  expect(requiredOmaScope("GET", "/api/keys/id/reveal")).toBe("admin");
  expect(requiredOmaScope("PATCH", "/api/keys-other")).toBe("write");
  expect(requiredOmaScope("PATCH", "/api/settings/require-login/")).toBe("admin");
  expect(requiredOmaScope("PATCH", "/api/settings/proxies")).toBe("write");
  const pinnedScope = loadPinnedAccessTokenAuth(() => null).inferRequiredScope;
  for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PATCH", "DELETE"]) for (const path of ["/api/keys", "/api/keys/id", "/api/keys/id/reveal", "/api/keys-other", "/api/settings", "/api/settings/", "/api/settings/require-login", "/api/settings/system-prompt", "/api/settings/proxies", "/api/providers-archive"]) {
    expect(requiredOmaScope(method, path)).toBe(pinnedScope(method, path));
  }
  expect(normalizeKeyRequest("omniroute-v3.8.53.keys.create", { name: " ", dailyUsageLimitUsd: false })).toEqual({ name: " ", dailyUsageLimitUsd: 0 });
});

describe("pinned API key grant projection", () => {
  test("rejects incomplete or duplicate inventories and removes all other fields", () => {
    expect(projectKeyGrant({ id: "one", allowedCombos: ["a"], key: "private", keyHash: "private" })).toEqual({ id: "one", allowedCombos: ["a"] });
    expect(() => projectCompleteKeyGrants({ keys: [], total: 1 })).toThrow("Incomplete");
    expect(() => projectCompleteKeyGrants({ keys: [{ id: "x", allowedCombos: [] }, { id: "x", allowedCombos: [] }], total: 2 })).toThrow("Incomplete");
    expect(() => projectKeyGrant({ id: "x", allowedCombos: [1] })).toThrow();
    expect(HELD_SOURCE_ONLY_OPERATION_IDS.size).toBe(4);
    expect(Object.keys(REQUIRED_CASES).sort()).toEqual([...KEY_OPERATION_IDS].sort());
    const proof = { kind: "unpaginated-list", itemsPath: ["keys"], totalPath: ["total"], identityPaths: [["id"]] };
    expect(sourceUnpaginatedListProofMatches("GET /api/keys", proof, "DELETE /api/combos/{id}")).toBe(true);
    expect(sourceUnpaginatedListProofMatches("GET /api/keys", proof, "POST /api/combos/import")).toBe(true);
    expect(sourceUnpaginatedListProofMatches("GET /api/keys", proof, "POST /api/providers")).toBe(false);
    expect(sourceUnpaginatedListProofMatches("GET /api/keys", { ...proof, totalPath: ["wrong"] })).toBe(false);
    expect(keyGrantsPreflightMatches(KEY_GRANTS_PREFLIGHT, "DELETE /api/combos/{id}", "GET /api/keys")).toBe(true);
    expect(keyGrantsPreflightMatches(KEY_GRANTS_PREFLIGHT, "DELETE /api/keys/{id}", "GET /api/keys")).toBe(false);
    expect(keyGrantsPreflightSnapshot({ total: 1, keys: [{ id: "x", allowedCombos: ["Alpha"], key: "never-copy" }] })).toEqual({ kind: "collection", entries: [{ identity: { id: "x" }, state: { allowedCombos: ["Alpha"] } }] });
    expect(() => keyGrantsPreflightSnapshot({ total: 2, keys: [{ id: "x", allowedCombos: [] }] })).toThrow();
    expect(keyGrantsPreflightSnapshot({ total: 0, keys: [] })).toEqual({ kind: "collection", entries: [] });
    expect(() => keyGrantsPreflightSnapshot({ total: 2, keys: [{ id: "x", allowedCombos: [] }, { id: "x", allowedCombos: [] }] })).toThrow();
    expect(() => keyGrantsPreflightSnapshot({ total: 1, keys: [{ id: "x", allowedCombos: [null] }] })).toThrow();
  });

  test("source handlers create, enumerate, update, and delete disposable SQLite grants", async () => {
    const ids = ["00000000-0000-4000-8000-000000000001", "00000000-0000-4000-8000-000000000002"];
    const fixture = createPinnedKeyHandlers(undefined, {
      uuid: () => { const id = ids.shift(); if (!id) throw new Error("Unexpected key UUID request"); return id; },
      date: createPinnedFixtureDate("2026-01-01T00:00:00.000Z"),
    });
    const token = "fixture-manage";
    try {
      const first = await fixture.request("POST", "/api/keys", { token, body: { name: "first", allowedCombos: ["Alpha", "combo/*"] } });
      expect(first.status).toBe(201);
      const grant = projectKeyGrant(first.data);
      expect(grant.id).toBe("00000000-0000-4000-8000-000000000001");
      expect(grant.allowedCombos).toEqual(["Alpha", "combo/*"]);
      expect(Object.keys(grant).sort()).toEqual(["allowedCombos", "id"]);
      const second = await fixture.request("POST", "/api/keys", { token, body: { name: "second", allowedCombos: ["Beta"] } });
      expect(second.status).toBe(201);
      const secondGrant = projectKeyGrant(second.data);
      expect(secondGrant.id).toBe("00000000-0000-4000-8000-000000000002");
      const beforeRead = projectCompleteKeyGrants((await fixture.request("GET", "/api/keys", { token })).data);
      const all = await fixture.request("GET", "/api/keys", { token });
      expect(all.status).toBe(200);
      const inventory = projectCompleteKeyGrants(all.data);
      expect(inventory.total).toBe(2);
      expect(inventory.keys).toContainEqual(grant);
      expect(inventory.keys).toEqual([grant, secondGrant]);
      expect(inventory.keys).toContainEqual(secondGrant);
      const snapshot = keyGrantsPreflightSnapshot(all.data);
      expect(snapshot).toEqual({ kind: "collection", entries: [
        { identity: { id: grant.id }, state: { allowedCombos: ["Alpha", "combo/*"] } },
        { identity: { id: secondGrant.id }, state: { allowedCombos: ["Beta"] } },
      ].sort((a, b) => a.identity.id.localeCompare(b.identity.id)) });
      const page = await fixture.request("GET", "/api/keys?limit=1junk&offset=1tail", { token });
      expect(page.status).toBe(200);
      const pageData = projectKeyGrantPage(page.data);
      expect(pageData.keys).toHaveLength(1);
      expect(pageData.total).toBe(2);
      const ignoredOffset = await fixture.request("GET", "/api/keys?limit=0&offset=1", { token });
      expect(projectKeyGrantPage(ignoredOffset.data).keys).toHaveLength(2);
      const invalidOffset = await fixture.request("GET", "/api/keys?limit=1&offset=invalid", { token });
      expect(projectKeyGrantPage(invalidOffset.data).keys).toHaveLength(1);
      const negativeLimit = await fixture.request("GET", "/api/keys?limit=-1&offset=1", { token });
      expect(projectKeyGrantPage(negativeLimit.data).keys).toHaveLength(2);
      const path = `/api/keys/${encodeURIComponent(grant.id)}`;
      expect((await fixture.request("GET", path, { token })).data).toEqual(grant);
      const patch = await fixture.request("PATCH", path, { token, body: { allowedCombos: ["Beta"] } });
      expect(patch.status).toBe(200);
      const updated = await fixture.request("GET", path, { token });
      expect(updated.data).toEqual({ id: grant.id, allowedCombos: ["Beta"] });
      expect((await fixture.request("DELETE", path, { token })).status).toBe(200);
      const missing = await fixture.request("GET", path, { token });
      expect(missing.status).toBe(404);
      expect((await fixture.request("DELETE", path, { token })).status).toBe(404);
      expect(projectCompleteKeyGrants((await fixture.request("GET", "/api/keys", { token })).data).keys).toEqual([secondGrant]);
      for (const [operationId, caseId] of [["POST /api/keys", "create"], ["GET /api/keys", "complete-grants"], ["GET /api/keys", "pagination"], ["GET /api/keys", "redaction"], ["GET /api/keys/{id}", "read"], ["GET /api/keys/{id}", "missing"], ["GET /api/keys/{id}", "redaction"], ["PATCH /api/keys/{id}", "apply-readback"], ["DELETE /api/keys/{id}", "delete-readback"], ["DELETE /api/keys/{id}", "missing"]] as const) completeCase(operationId, caseId);
      operationObservations.set("GET /api/keys", { before: beforeRead, after: inventory, result: { status: all.status, body: inventory } });
      operationObservations.set("POST /api/keys", grant);
      operationObservations.set("GET /api/keys/{id}", grant);
      operationObservations.set("PATCH /api/keys/{id}", updated.data);
      operationObservations.set("DELETE /api/keys/{id}", { status: missing.status, data: missing.data });
    } finally { fixture.close(); }
  });

  test("source validation and management authorization do not mutate grants", async () => {
    const fixture = createPinnedKeyHandlers();
    const token = "fixture-manage";
    try {
      const created = await fixture.request("POST", "/api/keys", { token, body: { name: "target", allowedCombos: ["Alpha"] } });
      expect(created.status).toBe(201);
      const grant = projectKeyGrant(created.data);
      const path = `/api/keys/${encodeURIComponent(grant.id)}`;
      expect((await fixture.request("POST", "/api/keys", { token, body: { name: "" } })).status).toBe(400);
      expect((await fixture.request("PATCH", path, { token, body: { allowedCombos: [3] } })).status).toBe(400);
      expect((await fixture.request("PATCH", path, { token, rawBody: "{" })).status).toBe(400);
      for (const [method, target] of [["GET", "/api/keys"], ["POST", "/api/keys"], ["GET", path], ["PATCH", path], ["DELETE", path]] as const) {
        const body = method === "POST" ? { name: "denied" } : method === "PATCH" ? { allowedCombos: [] } : undefined;
        const denied = await fixture.request(method, target, { token: "fixture-low", ...(body === undefined ? {} : { body }) });
        expect([401, 403]).toContain(denied.status);
      }
      expect((await fixture.request("GET", path, { token })).data).toEqual(grant);
      expect(projectCompleteKeyGrants((await fixture.request("GET", "/api/keys", { token })).data).total).toBe(1);
      expect((await fixture.request("GET", "/api/keys/not-a-key", { token })).status).toBe(404);
      expect((await fixture.request("GET", path, { token: "oma_fixture_read" })).status).toBe(200);
      expect((await fixture.request("PATCH", path, { token: "oma_fixture_read", body: { allowedCombos: [] } })).status).toBe(403);
      expect((await fixture.request("PATCH", path, { token: "oma_fixture_admin", body: { allowedCombos: ["Alpha"] } })).status).toBe(200);
      const anonymousRead = await fixture.request("GET", "/api/keys", { authRequired: false });
      expect(anonymousRead.status).toBe(200);
      const anonymousScoped = await fixture.request("POST", "/api/keys", { authRequired: false, body: { name: "blocked", scopes: ["manage"] } });
      expect([401, 403]).toContain(anonymousScoped.status);
      const anonymousPatch = await fixture.request("PATCH", path, { authRequired: false, body: { scopes: ["manage"] } });
      expect([401, 403]).toContain(anonymousPatch.status);
      completeCase("POST /api/keys", "scoped-auth");
      completeCase("PATCH /api/keys/{id}", "scoped-auth");
      const privileged = await fixture.request("POST", "/api/keys", { token, body: { name: "privileged", scopes: ["manage"], allowedCombos: [] } });
      expect(privileged.status).toBe(201);
      expect(projectKeyGrant(privileged.data).allowedCombos).toEqual([]);
      expect((await fixture.request("PATCH", path, { token, body: { scopes: ["manage"] } })).status).toBe(200);
      for (const operationId of KEY_OPERATION_IDS) completeCase(operationId, "auth-denial");
      completeCase("POST /api/keys", "invalid-nonmutation");
      completeCase("PATCH /api/keys/{id}", "invalid-nonmutation");
      expect(KEY_OPERATION_IDS.every(operationId => HELD_SOURCE_ONLY_OPERATION_IDS.has(operationId) || (REQUIRED_CASES[operationId].every(caseId => completedCases.get(operationId)?.has(caseId)) && operationObservations.has(operationId)))).toBe(true);
    } finally { fixture.close(); }
  });
});
