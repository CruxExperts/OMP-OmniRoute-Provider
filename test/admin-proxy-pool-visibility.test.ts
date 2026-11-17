import { afterAll, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash, validateProxyPoolVisibilityContract } from "../scripts/generate-contracts.ts";
import { canonicalizeJson } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { ProxyVisibilityFixture, VISIBILITY_ID, visibilityContract, visibilityDescriptor } from "./fixtures/proxy-pool-visibility.fixture.ts";

const adapter = fixtureRegistry([visibilityDescriptor()]).require(VISIBILITY_ID);
const complete = new Set<string>();
let observation: { before: unknown; after: unknown; result: { status: number; body: unknown } } | undefined;
const testId = "test/admin-proxy-pool-visibility.test.ts";
afterAll(async () => {
  if (!observation || ["contract", "auth", "scopes", "proxy", "pause", "ranking", "expiry", "error", "projection"].some(k => !complete.has(k))) return;
  const contract = visibilityContract(), binding = operationEvidenceBinding(VISIBILITY_ID, contract);
  const caseSha256 = testCaseSourceHash(testId), artifactPath = outcomeArtifactPath(VISIBILITY_ID);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId: VISIBILITY_ID, testId, caseSha256, binding, observation })}\n`, { mode: 0o600 });
  testOutcomeHash(VISIBILITY_ID, testId, caseSha256, binding, contract, artifactPath);
});

type Body = { scope?: string | null; strategy?: string | null; rankedBy?: string; total?: number; members?: Array<{ id: string | null; rank: number; signal: string; opaque: boolean; memberSetAside: unknown[]; transportEvidence: { failures: number; crossSuccesses: number } }>; pauses?: unknown[]; processMemory: boolean };
async function query(f: ProxyVisibilityFixture, q: string, credential = "oma_fixture-read") { const response = await f.handle(q, credential); return { response, body: await response.json() as Body }; }
function call(module: Record<string, unknown>, name: string, ...args: unknown[]): unknown { return (module[name] as (...values: unknown[]) => unknown)(...args); }
function seed(f: ProxyVisibilityFixture): void {
  const db = f.base.db;
  const add = db.prepare("INSERT INTO proxy_registry (id,name,type,host,port,username,password,notes,status) VALUES (?,?,?,?,?,?,?,?,?)");
  add.run("private-a", "private-name-a", "http", "private-a.invalid", 8080, "private-user", "private-password", "private-notes", "active");
  add.run("private-b", "private-name-b", "http", "private-b.invalid", 8081, "", "", "private-notes", "active");
  add.run("private-dead", "private-dead", "http", "private-dead.invalid", 8082, "", "", "", "dead");
  const assign = db.prepare("INSERT INTO proxy_assignments (proxy_id,scope,scope_id,position) VALUES (?,?,?,?)");
  for (const [scope, id] of [["global", "__global__"], ["provider", "private-provider"], ["account", "private-account"], ["combo", "private-combo"]] as const) {
    assign.run("private-a", scope, id, 0); assign.run("private-b", scope, id, 1); assign.run("private-dead", scope, id, 2);
  }
  db.prepare("INSERT INTO proxy_scope_rotation (scope,scope_id,strategy,cursor) VALUES (?,?,?,?)").run("provider", "private-provider", "sticky", 3);
  call(f.flagDb, "setFeatureFlagOverride", "PROXY_SKIP_RECENTLY_FAILED", "true");
}

test("bounded request and lifecycle policy reject extra input and replay", () => {
  expect(adapter.validate({ query: { scope: "provider", scopeId: "private-provider" } })).toBeDefined();
  expect(adapter.validate({ query: { proxyId: "private-a", freeTierPauses: "1", provider: "opencode" } })).toBeDefined();
  for (const input of [{ query: { extra: "x" } }, { query: { scope: "x".repeat(513) } }, { body: {} }]) expect(() => adapter.validate(input)).toThrow();
  const contract = visibilityContract();
  expect(() => validateProxyPoolVisibilityContract(contract)).not.toThrow();
  expect(() => validateProxyPoolVisibilityContract({ ...contract, retry: { allowed: true, maxAttempts: 2, statusCodes: [500] } })).toThrow();
  expect(() => validateProxyPoolVisibilityContract({ ...contract, request: { ...contract.request, querySchema: { type: "object", additionalProperties: true } } })).toThrow();
  expect(contract.sideEffect).toBe("lifecycle"); expect(contract.confirmation.required).toBe(true);
  expect(contract.retry).toEqual({ allowed: false, maxAttempts: 1, statusCodes: [] });
  expect(contract.mutationSafety?.reconciliation.kind).toBe("unknown");
  complete.add("contract");
});

test("central and handler management domains reject unprivileged credentials", async () => {
  const f = new ProxyVisibilityFixture();
  try {
    for (const [credential, status] of [[undefined, 401], ["fixture-low", 403], ["oma_fixture-invalid", 401], ["fixture-manage", 200], ["oma_fixture-read", 200], ["oma_fixture-admin", 200]] as const) {
      expect((await f.handle("?scope=global", credential)).status).toBe(status);
    }
    complete.add("auth");
  } finally { f.close(); }
});

test("pinned SQLite scope branches, alias, unknown scopes and errors", async () => {
  const f = new ProxyVisibilityFixture();
  try {
    seed(f);
    expect((await query(f, "")).response.status).toBe(400);
    for (const scope of ["provider", "account", "combo", "key", "unknown"]) expect((await query(f, `?scope=${scope}`)).response.status).toBe(400);
    for (const [scope, id, expected] of [["global", "ignored", "global"], ["provider", "private-provider", "provider"], ["account", "private-account", "account"], ["combo", "private-combo", "combo"], ["key", "private-account", "account"]]) {
      const result = await query(f, `?scope=${scope}&scopeId=${id}`);
      expect(result.response.status).toBe(200); expect(result.body.scope).toBe(expected); expect(result.body.total).toBe(2);
      expect(result.body.members?.map(m => m.id)).toEqual(["private-a", "private-b"]);
      if (scope === "provider") expect(result.body.strategy).toBe("sticky");
    }
    const unknown = await query(f, "?scope=unknown&scopeId=private-id");
    expect(unknown.response.status).toBe(200); expect(unknown.body.scope).toBe("unknown"); expect(unknown.body.total).toBe(0);
    expect((await query(f, "?scope=provider&scopeId=not-present")).body.total).toBe(0);
    complete.add("scopes");
  } finally { f.close(); }
});

test("single proxy precedence and opaque unknown shape", async () => {
  const f = new ProxyVisibilityFixture();
  try {
    seed(f);
    const found = await query(f, "?proxyId=private-a&scope=provider");
    expect(found.response.status).toBe(200); expect(found.body.scope).toBeNull(); expect(found.body.total).toBe(1); expect(found.body.members?.[0]?.id).toBe("private-a");
    const missing = await query(f, "?proxyId=unknown-private");
    expect(missing.response.status).toBe(200); expect(missing.body.total).toBe(1); expect(missing.body.members?.[0]).toMatchObject({ id: null, opaque: true, rank: 1 });
    complete.add("proxy");
  } finally { f.close(); }
});

test("free-tier precedence, provider validation and expired pauses", async () => {
  const f = new ProxyVisibilityFixture();
  try {
    const now = Date.now();
    call(f.pauses, "noteOpencodeFreeTierSkip", "opencode-private", now, 120000, "private-model");
    call(f.pauses, "noteOpencodeFreeTierSkip", "opencode-private", now - 10000, 1000, "expired-private-model");
    expect((await query(f, "?freeTierPauses=1&scope=global")).response.status).toBe(400);
    const result = await query(f, "?freeTierPauses=1&provider=opencode-private&proxyId=private-a&scope=global");
    expect(result.response.status).toBe(200); expect(result.body.pauses?.length).toBe(1); expect(result.body.members).toBeUndefined();
    expect((await query(f, "?freeTierPauses=1&provider=other")).body.pauses).toEqual([]);
    expect((await query(f, "?freeTierPauses=0&scope=global")).body.members).toEqual([]);
    const projected = adapter.project(result.body); expect(JSON.stringify(projected)).not.toContain("private");
    expect(projected && typeof projected === "object" && "pauses" in projected && Array.isArray(projected.pauses) && projected.pauses.length).toBe(1);
    complete.add("pause");
  } finally { f.close(); }
});

test("actual refusal and feature-flag owners affect ranking, expiry and closed projection", async () => {
  const f = new ProxyVisibilityFixture();
  try {
    seed(f);
    const before = await query(f, "?scope=global");
    const key = call(f.refusal, "proxyEgressKey", { type: "http", host: "private-a.invalid", port: 8080, username: "private-user", password: "private-password" });
    call(f.refusal, "noteProxyRefusal", key, "proxy_unreachable", Date.now());
    call(f.refusal, "noteProxyMemberRefusal", key, "private-member", "slow", Date.now());
    call(f.refusal, "recordTransportFailure", key, "private-destination", Date.now());
    const ranked = await query(f, "?scope=global");
    expect(ranked.response.status).toBe(200); expect(ranked.body.rankedBy).toBe("health"); expect(ranked.body.members?.map(m => m.id)).toEqual(["private-b", "private-a"]);
    expect(ranked.body.members?.[1]).toMatchObject({ rank: 2, signal: "set-aside", memberSetAside: [{ avoided: true }], transportEvidence: { failures: 1 } });
    const projection = adapter.project(ranked.body), encoded = JSON.stringify(projection);
    for (const secret of ["private", "8080", "display", "reason", "storeInstance", "kind"]) expect(encoded).not.toContain(secret);
    expect(projection && typeof projection === "object" && "total" in projection && projection.total).toBe(2);
    call(f.flagDb, "setFeatureFlagOverride", "PROXY_SKIP_RECENTLY_FAILED", "false");
    const unranked = await query(f, "?scope=global");
    expect(unranked.body.rankedBy).toBe("position"); expect(unranked.body.members?.map(m => m.id)).toEqual(["private-a", "private-b"]);
    observation = { before: adapter.project(before.body), after: adapter.project(ranked.body), result: { status: ranked.response.status, body: projection } };
    complete.add("ranking"); complete.add("projection");
    call(f.refusal, "__resetProxyRefusalMemoryForTesting"); call(f.refusal, "__resetTransportEvidenceForTesting");
    call(f.refusal, "noteProxyRefusal", key, "proxy_unreachable", Date.now() - 86400000);
    call(f.refusal, "recordTransportFailure", key, "private-destination", Date.now() - 86400000);
    expect(call(f.refusal, "__proxyRefusalMemorySizeForTesting")).toBe(1);
    expect(call(f.refusal, "__transportEvidenceSizeForTesting")).toMatchObject({ failures: 1 });
    await query(f, "?scope=global");
    expect(call(f.refusal, "__proxyRefusalMemorySizeForTesting")).toBe(0);
    expect(call(f.refusal, "__transportEvidenceSizeForTesting")).toMatchObject({ failures: 0 });
    complete.add("expiry");
  } finally { f.close(); }
});

test("broken registry returns error rather than successful inventory", async () => {
  const f = new ProxyVisibilityFixture();
  try {
    seed(f); f.base.dropProxyTable();
    const response = await f.handle("?scope=global", "oma_fixture-read");
    expect(response.status).toBe(500); expect(() => adapter.project({ error: "private-storage-error" })).toThrow();
    complete.add("error");
  } finally { f.close(); }
});
