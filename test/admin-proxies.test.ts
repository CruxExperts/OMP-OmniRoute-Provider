import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash } from "../scripts/generate-contracts.ts";
import { createPinnedProxyHandlers } from "./fixtures/pinned-proxy-handlers.fixture.ts";
import { buildProxyFixtureRegistry, HELD_SOURCE_ONLY_OPERATION_IDS, PROXY_OPERATION_IDS } from "./fixtures/proxies.fixture.ts";
import { sourcePreflightReadInput, sourceUnpaginatedListProofMatches } from "../src/admin/source-normalization.ts";
import { assertSafetyReadRequest, assertSafetyReadResponse, mapRelationInput, projectRelationSnapshot } from "../src/admin/relations.ts";
import { canonicalizeJson, getOperation, type OperationDescriptor } from "../src/admin/registry.ts";
import { createAdminExecutor } from "../src/admin/executor.ts";
import { createHash } from "node:crypto";
import { PROXY_USAGE_PREFLIGHT, proxyUsagePreflightInput, proxyUsagePreflightMatches, proxyUsagePreflightSnapshot, validateProxyRequest } from "../src/admin/source-proxies.ts";

const admin = { token: "oma_fixture-admin" };
const collection = "/api/settings/proxies";
const assignments = `${collection}/assignments`;

const assignmentReadId = "GET /api/settings/proxies/assignments";
const assignmentCases = new Set<string>();
let assignmentObservation: { before: unknown; after: unknown; result: { status: number; body: unknown } } | undefined;

afterAll(async () => {
  if (!assignmentObservation || !["complete-inventory", "filtering", "auth-denial", "handler-error", "missing-table-fallback"].every(value => assignmentCases.has(value))) return;
  const descriptor = buildProxyFixtureRegistry().require(assignmentReadId).descriptor;
  const { request, auth, response, secrets, sideEffect, pagination, streaming, confirmation, retry, reconciliation, mutationSafety } = descriptor;
  const contract = { request, auth, response, secrets, sideEffect, pagination, streaming, confirmation, retry, reconciliation, mutationSafety };
  const testId = "test/admin-proxies.test.ts";
  const binding = operationEvidenceBinding(assignmentReadId, contract);
  const caseSha256 = testCaseSourceHash(testId);
  const artifactPath = outcomeArtifactPath(assignmentReadId);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId: assignmentReadId, testId, caseSha256, binding, observation: assignmentObservation })}\n`, { mode: 0o600 });
  testOutcomeHash(assignmentReadId, testId, caseSha256, binding, contract, artifactPath);
});

test("proxy assignment inventory reports a storage failure", async () => {
  const fixture = createPinnedProxyHandlers();
  try {
    fixture.breakAssignmentSchema();
    const response = await fixture.request("GET", assignments, admin);
    expect(response.status).toBe(500);
    const source = getOperation(assignmentReadId);
    if (!source) throw new Error("Missing assignment descriptor");
    const proof = { kind: "unpaginated-list" as const, sourceReason: "The route normally returns its assignment inventory without pagination.", itemsPath: ["items"], totalPath: ["total"], identityPaths: [["id"]] };
    expect(() => assertSafetyReadResponse(proof, { ...source, pagination: { mode: "none", parameters: [] } }, response.data)).toThrow();
    assignmentCases.add("handler-error");
  } finally { fixture.close(); }
});

test("missing assignment table is reported as an empty inventory by the source", async () => {
  const fixture = createPinnedProxyHandlers();
  try {
    fixture.dropAssignmentTable();
    const response = await fixture.request("GET", assignments, { ...admin, assignmentProof: true });
    expect(response).toEqual({ status: 200, data: { items: [], total: 0 } });
    assignmentCases.add("missing-table-fallback");
    // This response is indistinguishable from an empty healthy table: it must
    // not be treated as proof that dependent assignments cannot exist.
  } finally { fixture.close(); }
});

test("pinned proxy handlers persist and project CRUD and complete assignment state", async () => {
  const fixture = createPinnedProxyHandlers();
  try {
    expect(HELD_SOURCE_ONLY_OPERATION_IDS.size).toBe(PROXY_OPERATION_IDS.length - 1);
    expect((await fixture.request("GET", assignments)).status).toBe(401);
    expect((await fixture.request("GET", assignments, { token: "fixture-low" })).status).toBe(403);
    assignmentCases.add("auth-denial");
    expect((await fixture.request("PUT", assignments, { token: "oma_fixture-read", body: { scope: "global", proxyId: null } })).status).toBe(403);
    expect((await fixture.request("GET", collection)).status).toBe(401);
    expect((await fixture.request("POST", collection, { body: { name: "denied" } })).status).toBe(401);
    expect((await fixture.request("POST", collection, { ...admin, rawBody: "{" })).status).toBe(400);
    expect((await fixture.request("POST", collection, { ...admin, body: { name: "bad", host: "fixture.invalid", port: 0 } })).status).toBe(400);
    const empty = await fixture.request("GET", collection, admin);
    expect(empty.data).toEqual({ items: [], total: 0 });
    const created = await fixture.request("POST", collection, { ...admin, body: { name: "fixture proxy", host: "fixture.invalid", port: 8080, username: "fixture-user", password: "fixture-secret", notes: "private-marker" } });
    expect(created.status).toBe(201);
    if (!created.data || !("id" in created.data) || typeof created.data.id !== "string") throw new Error("Missing created proxy ID");
    const id = created.data.id;
    expect(JSON.stringify(created.data)).not.toContain("fixture-secret");
    expect(JSON.stringify(created.data)).not.toContain("fixture.invalid");
    expect((await fixture.request("GET", `${collection}?id=${encodeURIComponent(id)}`, admin)).data).toEqual(created.data);
    expect((await fixture.request("GET", assignments, admin)).data).toEqual({ items: [], total: 0 });
    expect((await fixture.request("PUT", assignments, { ...admin, body: { scope: "combo", proxyId: id } })).status).toBe(400);
    expect((await fixture.request("PUT", assignments, { ...admin, body: { scope: "combo", scopeId: "combo-a", proxyId: "missing" } })).status).toBe(404);
    expect((await fixture.request("GET", assignments, admin)).data).toEqual({ items: [], total: 0 });
    const assigned = await fixture.request("PUT", assignments, { ...admin, body: { scope: "combo", scopeId: "combo-a", proxyId: id } });
    expect((await fixture.request("PUT", assignments, { ...admin, rawBody: "{" })).status).toBe(400);
    expect((await fixture.request("PUT", assignments, { ...admin, body: { scope: "other", scopeId: "combo-a", proxyId: id } })).status).toBe(400);
    expect((await fixture.request("PUT", assignments, { ...admin, body: { scope: "combo", scopeId: "combo-a", proxyId: id, unexpected: true } })).status).toBe(400);
    expect(assigned.status).toBe(200);
    const beforeRead = await fixture.request("GET", assignments, { ...admin, assignmentProof: true });
    const proofRead = await fixture.request("GET", assignments, { ...admin, assignmentProof: true });
    expect(proofRead.status).toBe(200);
    const sourceDescriptor = getOperation("GET /api/settings/proxies/assignments");
    if (!sourceDescriptor) throw new Error("Missing assignment operation");
    const descriptor = { ...sourceDescriptor, pagination: { mode: "none" as const, parameters: [] } };
    const proof = { kind: "unpaginated-list" as const, sourceReason: "Source returns all matching assignments without pagination.", itemsPath: ["items"], totalPath: ["total"], identityPaths: [["id"]] };
    expect(() => assertSafetyReadResponse(proof, descriptor, proofRead.data)).not.toThrow();
    expect(beforeRead.data).toEqual(proofRead.data);
    assignmentObservation = { before: beforeRead.data, after: proofRead.data, result: { status: proofRead.status, body: proofRead.data } };
    assignmentCases.add("complete-inventory");
    expect(assigned.data).toEqual({ success: true, assignment: { scope: "combo", scopeId: "combo-a", proxyId: id } });
    expect((await fixture.request("GET", `${collection}?id=${encodeURIComponent(id)}&whereUsed=1`, admin)).data).toEqual({
      count: 1, assignmentCount: 1, accountReferenceCount: 0,
      assignments: [{ scope: "combo", scopeId: "combo-a", proxyId: id }], accountReferences: [],
    });
    for (const query of ["", "?scope=combo", "?scope=combo&scopeId=combo-a", `?proxyId=${encodeURIComponent(id)}`]) {
      expect((await fixture.request("GET", assignments + query, admin)).data).toEqual({ items: [{ scope: "combo", scopeId: "combo-a", proxyId: id }], total: 1 });
    }
    expect((await fixture.request("GET", `${assignments}?scope=combo&scopeId=other`, admin)).data).toEqual({ items: [], total: 0 });
    assignmentCases.add("filtering");
    expect((await fixture.request("DELETE", `${collection}?id=${encodeURIComponent(id)}`, admin)).status).toBe(409);
    const updated = await fixture.request("PATCH", collection, { ...admin, body: { id, name: "updated fixture" } });
    expect(updated.status).toBe(200);
    expect(updated.data).toEqual({ id, name: "updated fixture", type: "http", status: "active" });
    expect((await fixture.request("PATCH", collection, { ...admin, body: { id: "missing", name: "absent" } })).status).toBe(404);
    expect((await fixture.request("GET", `${assignments}?proxyId=${encodeURIComponent(id)}&scope=provider`, admin)).data).toEqual({ items: [{ scope: "combo", scopeId: "combo-a", proxyId: id }], total: 1 });
    const second = await fixture.request("POST", collection, { ...admin, body: { name: "second fixture", host: "other.invalid", port: 8081 } });
    expect(second.status).toBe(201);
    if (!second.data || !("id" in second.data) || typeof second.data.id !== "string") throw new Error("Missing second proxy ID");
    const secondId = second.data.id;
    expect((await fixture.request("PUT", assignments, { ...admin, body: { scope: "combo", scopeId: "combo-a", proxyId: secondId } })).status).toBe(200);
    expect((await fixture.request("GET", `${assignments}?scope=combo&scopeId=combo-a`, admin)).data).toEqual({ items: [{ scope: "combo", scopeId: "combo-a", proxyId: secondId }], total: 1 });
    expect((await fixture.request("GET", `${collection}?id=${encodeURIComponent(id)}&whereUsed=1`, admin)).data).toEqual({ count: 0, assignmentCount: 0, accountReferenceCount: 0, assignments: [], accountReferences: [] });
    const clear = await fixture.request("PUT", assignments, { ...admin, body: { scope: "combo", scopeId: "combo-a", proxyId: null } });
    expect(clear.data).toEqual({ success: true, assignment: null });
    expect((await fixture.request("GET", assignments, admin)).data).toEqual({ items: [], total: 0 });
    expect((await fixture.request("DELETE", `${collection}?id=${encodeURIComponent(id)}`, admin)).status).toBe(200);
    expect((await fixture.request("DELETE", `${collection}?id=${encodeURIComponent(secondId)}`, admin)).status).toBe(200);
    expect((await fixture.request("GET", collection, admin)).data).toEqual({ items: [], total: 0 });
    expect((await fixture.request("GET", `${collection}?id=${encodeURIComponent(id)}`, admin)).status).toBe(404);
  } finally { fixture.close(); }
});

test("proxy completeness proof is exact and rejects missing or duplicate assignment identities", () => {
  const source = getOperation("GET /api/settings/proxies/assignments");
  if (!source) throw new Error("Missing pinned assignment descriptor");
  const descriptor: OperationDescriptor = { ...source, pagination: { mode: "none", parameters: [] } };
  const proof = { kind: "unpaginated-list" as const, sourceReason: "Source returns all matching assignments without pagination.", itemsPath: ["items"], totalPath: ["total"], identityPaths: [["id"]] };
  expect(sourceUnpaginatedListProofMatches(descriptor.operationId, proof, "PUT /api/settings/proxies/assignments")).toBe(true);
  expect(sourceUnpaginatedListProofMatches(descriptor.operationId, proof, "POST /api/keys")).toBe(false);
  expect(sourceUnpaginatedListProofMatches(descriptor.operationId, { ...proof, identityPaths: [["scope"]] })).toBe(false);
  expect(sourceUnpaginatedListProofMatches("GET /api/settings/proxies", proof, "DELETE /api/settings/proxies")).toBe(true);
  expect(sourceUnpaginatedListProofMatches("GET /api/settings/proxies", proof, "DELETE /api/keys/{id}")).toBe(false);
  expect(() => assertSafetyReadRequest(proof, descriptor, { path: {}, query: {} })).not.toThrow();
  expect(() => assertSafetyReadRequest(proof, descriptor, { path: {}, query: { scope: "combo" } })).toThrow();
  expect(() => assertSafetyReadResponse(proof, descriptor, { items: [{ id: 1, scope: "global", scopeId: null, proxyId: "p" }], total: 1 })).not.toThrow();
  for (const items of [[{}], [{ id: null }], [{ id: 0 }], [{ id: 1.5 }], [{ id: 1 }, { id: 1 }]]) {
    expect(() => assertSafetyReadResponse(proof, descriptor, { items, total: items.length })).toThrow();
  }
  expect(() => assertSafetyReadResponse(proof, descriptor, { items: [{ id: 1 }], total: 2 })).toThrow();
});

test("delete usage preflight binds only the exact operation and rejects incomplete account evidence", () => {
  const payload = { path: {}, query: { id: "proxy-1" } };
  expect(proxyUsagePreflightMatches(PROXY_USAGE_PREFLIGHT, "DELETE /api/settings/proxies", "GET /api/settings/proxies")).toBe(true);
  expect(proxyUsagePreflightMatches(PROXY_USAGE_PREFLIGHT, "PATCH /api/settings/proxies", "GET /api/settings/proxies")).toBe(false);
  expect(proxyUsagePreflightInput(PROXY_USAGE_PREFLIGHT, payload, { path: {}, query: {} })).toEqual({ path: {}, query: { id: "proxy-1", whereUsed: "1" } });
  const source = { count: 2, assignmentCount: 1, accountReferenceCount: 1, assignments: [{ scope: "combo", scopeId: "c", proxyId: "proxy-1" }], accountReferences: [{ connectionId: "conn", provider: "p", accountCount: 1 }] };
  expect(proxyUsagePreflightSnapshot(payload, source)).toEqual({ kind: "resource", entries: [{ identity: { id: "proxy-1" }, state: { count: 2, assignments: source.assignments, accountReferences: source.accountReferences } }] });
  expect(() => proxyUsagePreflightSnapshot(payload, { ...source, count: 1 })).toThrow();
  expect(() => proxyUsagePreflightSnapshot(payload, { ...source, assignments: [{ scope: "combo", scopeId: "c", proxyId: "different" }] })).toThrow();
});

test("proxy source validators enforce scoped assignments and strict source fields", () => {
  expect(validateProxyRequest("omniroute-v3.8.53.proxies.assign", { scope: "combo", scopeId: "  ", proxyId: "p" })).toBeDefined();
  expect(validateProxyRequest("omniroute-v3.8.53.proxies.assign", { scope: "global", scopeId: null, proxyId: null })).toBeUndefined();
  expect(validateProxyRequest("omniroute-v3.8.53.proxies.assign", { scope: "combo", scopeId: "c", proxyId: "p", extra: 1 })).toBeDefined();
  expect(validateProxyRequest("omniroute-v3.8.53.proxies.create", { name: " x ", host: "example.invalid", port: "8080" })).toBeUndefined();
  expect(validateProxyRequest("omniroute-v3.8.53.proxies.update", { id: "p", port: 0 })).toBeDefined();
});

test("synthetic executor uses pinned proxy state for preflight, dispatch and unknown outcomes", async () => {
  const fixture = createPinnedProxyHandlers();
  const registry = buildProxyFixtureRegistry();
  let now = 1_000_000;
  let serial = 0;
  let lost = false;
  let writes = 0;
  const executor = createAdminExecutor({
    registry, now: () => now, randomId: () => `proxy-plan-${++serial}`, planTtlMs: 1000,
    readTarget: async context => {
      const adapter = registry.require(context.readOperation.operationId);
      const input = adapter.validate(sourcePreflightReadInput(context.relation.sourceView, context.payload, mapRelationInput(context.relation.inputs, context.payload)));
      assertSafetyReadRequest(context.readCompleteness, adapter.descriptor, input);
      const query = adapter.buildQuery(input).map(value => `${value.encodedName}=${value.encodedValue}`).join("&");
      const path = adapter.buildPath(input) + (query ? `?${query}` : "");
      const result = await fixture.request("GET", path, { token: "fixture-manage", assignmentProof: true, proxyProof: true });
      if (result.status >= 400) throw new Error("Proxy target read rejected");
      assertSafetyReadResponse(context.readCompleteness, adapter.descriptor, result.data);
      const snapshot = projectRelationSnapshot(context.relation, result.data, context.payload);
      return { snapshot, digest: createHash("sha256").update(canonicalizeJson(snapshot)).digest("hex") };
    },
    dispatch: async request => {
      if (!["GET", "POST", "PATCH", "DELETE", "PUT"].includes(request.method)) throw new Error("Unexpected proxy method");
      const method = request.method as "GET" | "POST" | "PATCH" | "DELETE" | "PUT";
      const query = request.queryParameters.map(value => `${value.encodedName}=${value.encodedValue}`).join("&");
      const result = await fixture.request(method, request.path + (query ? `?${query}` : ""), { token: "fixture-manage", ...(request.body === undefined ? {} : { body: request.body }), assignmentProof: true, proxyProof: method === "GET" });
      if (method !== "GET") {
        writes++;
        if (lost) { lost = false; throw Object.assign(new Error("completed response lost"), { uncertain: true }); }
        return { kind: "response", status: result.status, body: result.data };
      }
      if (result.status >= 400) throw new Error("Proxy read rejected");
      return result.data;
    },
  });
  executor.bindCredential({ profileId: "proxy-fixture", endpoint: "http://127.0.0.1:3190", apiKey: "fixture-manage" });
  try {
    const create = await executor.plan("POST /api/settings/proxies", { body: { name: "executor proxy", host: "fixture.invalid", port: 8123 } });
    const created = await executor.apply(create.planId, { confirmed: true });
    expect(created.status).toBe("applied");
    const list = await fixture.request("GET", collection, admin);
    if (!list.data || !("items" in list.data) || !Array.isArray(list.data.items) || list.data.items.length !== 1) throw new Error("Expected created proxy");
    const row = list.data.items[0];
    if (!row || typeof row !== "object" || !("id" in row) || typeof row.id !== "string") throw new Error("Missing proxy ID");
    const id = row.id;
    const assign = await executor.plan("PUT /api/settings/proxies/assignments", { body: { scope: "combo", scopeId: "executor-combo", proxyId: id } });
    expect(JSON.stringify(assign.preview)).not.toContain("fixture.invalid");
    expect((await executor.apply(assign.planId, { confirmed: true })).status).toBe("applied");
    expect((await fixture.request("GET", `${assignments}?scope=combo&scopeId=executor-combo`, admin)).data).toEqual({ items: [{ scope: "combo", scopeId: "executor-combo", proxyId: id }], total: 1 });
    const writesBeforeSafetyCases = writes;
    const stale = await executor.plan("PATCH /api/settings/proxies", { body: { id, name: "planned" } });
    await fixture.request("PATCH", collection, { ...admin, body: { id, name: "external change" } });
    await expect(executor.apply(stale.planId, { confirmed: true })).rejects.toMatchObject({ code: "target-drift" });
    const expiring = await executor.plan("PATCH /api/settings/proxies", { body: { id, name: "expired" } });
    now += 1001;
    await expect(executor.apply(expiring.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-expired" });
    const cancelled = await executor.plan("PATCH /api/settings/proxies", { body: { id, name: "cancelled" } });
    const controller = new AbortController(); controller.abort();
    await expect(executor.apply(cancelled.planId, { confirmed: true, signal: controller.signal })).rejects.toMatchObject({ code: "plan-invalidated" });
    expect(writes).toBe(writesBeforeSafetyCases);
    const rotated = await executor.plan("PATCH /api/settings/proxies", { body: { id, name: "rotated" } });
    const writesBeforeRotation = writes;
    executor.bindCredential({ profileId: "proxy-fixture", endpoint: "http://127.0.0.1:3190", apiKey: "fixture-manage-rotated" });
    await expect(executor.apply(rotated.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-invalidated" });
    expect(writes).toBe(writesBeforeRotation);
    const uncertain = await executor.plan("PATCH /api/settings/proxies", { body: { id, name: "lost response" } });
    const before = writes; lost = true;
    expect(await executor.apply(uncertain.planId, { confirmed: true })).toMatchObject({ status: "unknown", plan: { state: "unknown" } });
    expect(writes).toBe(before + 1);
    expect((await fixture.request("GET", `${collection}?id=${encodeURIComponent(id)}`, admin)).data).toMatchObject({ name: "lost response" });
    const clear = await executor.plan("PUT /api/settings/proxies/assignments", { body: { scope: "combo", scopeId: "executor-combo", proxyId: null } });
    expect((await executor.apply(clear.planId, { confirmed: true })).status).toBe("applied");
    const remove = await executor.plan("DELETE /api/settings/proxies", { query: { id } });
    expect((await executor.apply(remove.planId, { confirmed: true })).status).toBe("applied");
    expect((await fixture.request("GET", collection, admin)).data).toEqual({ items: [], total: 0 });
  } finally { executor.shutdown(); fixture.close(); }
});
