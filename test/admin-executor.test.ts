import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import { createAdminExecutor, type AdminExecutor } from "../src/admin/executor.ts";
import { requiredOmaScope } from "../src/admin/authorization-policy.ts";
import type {
  AdminAuthDomain,
  AdminExecutorOptions,
  AdminOperationAuthBinding,
  AdminTarget,
  AdminTargetReader,
} from "../src/admin/types.ts";
import {
  canonicalizeJson,
  getOperationRegistry,
  type OperationRegistry,
  type OperationDescriptor,
  type OperationReconciliationRelation,
  type JsonSchema,
} from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { ManagementAuthFixture, WHOAMI_OPERATION_ID, whoamiSourceContract, type FixtureAccessRecord, type FixtureAccessScope } from "./fixtures/management-auth.fixture.ts";

const MUTATION = "DELETE /api/cache";
const MUTATION_INPUT = { body: {} };
const PROFILE_ID = "omniroute";
const ENDPOINT = "http://127.0.0.1:20128";
test("OMA scope minima follow the pinned method/path rules and true segment boundaries", () => {
  expect(requiredOmaScope("GET", "/api/providers")).toBe("read");
  expect(requiredOmaScope("POST", "/api/providers")).toBe("admin");
  expect(requiredOmaScope("PATCH", "/api/providers/provider-1")).toBe("admin");
  expect(requiredOmaScope("GET", "/api/cli/tokens/token-1")).toBe("admin");
  expect(requiredOmaScope("GET", "/api/oauth/callback")).toBe("admin");
  expect(requiredOmaScope("HEAD", "/api/auth/session")).toBe("admin");
  expect(requiredOmaScope("OPTIONS", "/api/policy/roles")).toBe("admin");
  expect(requiredOmaScope("GET", "/api/services/status")).toBe("admin");
  expect(requiredOmaScope("GET", "/api/mcp/sessions")).toBe("admin");
  expect(requiredOmaScope("DELETE", "/api/cli-tools/apply/job-1")).toBe("admin");
  expect(requiredOmaScope("GET", "/api/cli-tools/apply")).toBe("read");
  expect(requiredOmaScope("delete", "/api/providers-archive")).toBe("write");
  expect(requiredOmaScope("POST", "/api/cli-tools/applyment")).toBe("write");
  expect(requiredOmaScope("POST", "/api/authz")).toBe("write");
});

interface FixtureDomains {
  readonly mutationOperationId?: string;
  readonly mutation?: Exclude<AdminAuthDomain, "unknown">;
  readonly target?: Exclude<AdminAuthDomain, "unknown">;
  readonly reconciliation?: Exclude<AdminAuthDomain, "unknown">;
  readonly reconciliationEnabled?: boolean;
  readonly mutationBodySchema?: JsonSchema;
}
function fixtureAuthorizationPolicy(
  domain: Exclude<AdminAuthDomain, "unknown">,
  omaMinimumScope?: "read" | "write" | "admin",
): OperationDescriptor["auth"]["sourcePolicy"] {
  if (domain === "management") return {
    status: "qualified",
    source: "omniroute-v3.8.52",
    routeClass: "management",
    localOnly: false,
    handlerGuard: "none",
    bootstrap: "none",
    alternatives: [
      { kind: "management-api-key", anyOf: ["manage", "admin"] },
      ...(omaMinimumScope === undefined ? [] : [{ kind: "oma-access-token" as const, minimumScope: omaMinimumScope }]),
    ],
  };
  if (domain === "runtime") return {
    status: "qualified",
    source: "omniroute-v3.8.52",
    routeClass: "client-api",
    localOnly: false,
    alternatives: [{ kind: "runtime-api-key", sourceScopes: ["fixture:runtime"] }],
  };
  if (domain === "metadata") return {
    status: "qualified",
    source: "omniroute-v3.8.52",
    routeClass: "client-api",
    localOnly: false,
    alternatives: [{ kind: "metadata-api-key", sourceScopes: ["fixture:metadata"] }],
  };
  if (domain === "public") return {
    status: "qualified",
    source: "omniroute-v3.8.52",
    routeClass: "public",
    alternatives: [{ kind: "anonymous" }],
  };
  return {
    status: "qualified",
    source: "omniroute-v3.8.52",
    routeClass: "local",
    localOnly: true,
    alternatives: [{ kind: "trusted-local", loopbackOnly: true }],
  };
}

interface SetupOptions extends FixtureDomains {
  readonly now?: () => number;
  readonly dispatch?: AdminExecutorOptions["dispatch"];
  readonly readTarget?: AdminTargetReader;
  readonly reconcile?: AdminExecutorOptions["reconcile"];
  readonly resolveAuth?: AdminExecutorOptions["resolveAuth"];
}
interface ExecutorHarness {
  readonly executor: AdminExecutor;
  calls(): number;
}

function makeTarget(snapshot: AdminTarget["snapshot"]): AdminTarget {
  return {
    snapshot,
    digest: createHash("sha256").update(canonicalizeJson(snapshot)).digest("hex"),
  };
}

function makeRegistry(domains: FixtureDomains = {}): OperationRegistry {
  const sourceRegistry = getOperationRegistry();
  const mutationSource = sourceRegistry.getOperation(domains.mutationOperationId ?? MUTATION);
  const readSource = sourceRegistry.getOperation("GET /api/health");
  const whoamiSource = sourceRegistry.getOperation(WHOAMI_OPERATION_ID);
  if (!mutationSource || !readSource || !whoamiSource) throw new Error("executor fixture operation is missing");

  const makeRead = (operationId: string, pathTemplate: string, domain: Exclude<AdminAuthDomain, "unknown">): OperationDescriptor => ({
    ...readSource,
    operationId,
    pathTemplate,
    auth: { ...readSource.auth, domain, sourcePolicy: fixtureAuthorizationPolicy(domain, domain === "management" ? "read" : undefined) },
    secrets: operationId === "GET /fixture/target"
      ? { ...readSource.secrets, outputFields: [...new Set([...readSource.secrets.outputFields, "fetchProxyUrl"])] }
      : readSource.secrets,
    sideEffect: "read",
    confirmation: { required: false, reason: "Synthetic ordinary read." },
    request: { ...readSource.request, body: null },
    response: { ...readSource.response, schema: { type: "object", properties: { ok: { type: "boolean" } }, additionalProperties: false, required: [] } },
    coverage: { status: "invokable", adapterId: `typed.fixture.${operationId.replace(/[^A-Za-z0-9]+/g, ".")}`, reason: null },
    reconciliation: null,
  });
  const targetRead = makeRead("GET /fixture/target", "/fixture/target", domains.target ?? "management");
  const reconciliationRead = makeRead("GET /fixture/reconcile", "/fixture/reconcile", domains.reconciliation ?? "management");
  const relation: OperationReconciliationRelation = {
    targetRead: {
      operationId: targetRead.operationId,
      inputs: [],
      snapshot: { kind: "resource", identity: [], state: [] },
    },
    reconcile: {
      operationId: reconciliationRead.operationId,
      inputs: [],
      outcome: { kind: "matches", identityFields: [], stateFields: [] },
    },
  };
  const whoami: OperationDescriptor = {
    ...whoamiSource,
    ...whoamiSourceContract(),
    coverage: { status: "invokable", adapterId: "typed.fixture.whoami", reason: null },
  };
  const mutationBody = domains.mutationBodySchema === undefined
    ? mutationSource.request.body ?? {
      required: true,
      mediaType: "application/json",
      schema: { type: "object", properties: {}, additionalProperties: false },
      contentVariants: [],
    }
    : {
      required: true,
      mediaType: "application/json",
      schema: domains.mutationBodySchema,
      contentVariants: [],
    };
  const mutation: OperationDescriptor = {
    ...mutationSource,
    auth: {
      ...mutationSource.auth,
      domain: domains.mutation ?? "management",
      sourcePolicy: fixtureAuthorizationPolicy(
        domains.mutation ?? "management",
        domains.mutation === undefined || domains.mutation === "management"
          ? requiredOmaScope(mutationSource.method, mutationSource.pathTemplate)
          : undefined,
      ),
    },
    sideEffect: "mutation",
    confirmation: { required: true, reason: "Synthetic mutation." },
    request: { ...mutationSource.request, body: mutationBody },
    response: { ...mutationSource.response, schema: { type: "object", properties: { ok: { type: "boolean" } }, additionalProperties: false, required: [] } },
    coverage: { status: "invokable", adapterId: "typed.fixture.mutation", reason: null },
    reconciliation: domains.reconciliationEnabled === false ? null : relation,
  };
  const descriptors = [mutation, targetRead, reconciliationRead, whoami];
  return fixtureRegistry(descriptors);
}

function setup(options: SetupOptions = {}): ExecutorHarness {
  let calls = 0;
  const executor = createAdminExecutor({
    ...(options.now === undefined ? {} : { now: options.now }),
    readTarget: options.readTarget ?? (async () => makeTarget("target-a")),
    dispatch: async (request, context) => {
      calls += 1;
      return options.dispatch ? options.dispatch(request, context) : { ok: true, unknown: "withheld" };
    },
    ...(options.reconcile === undefined ? {} : { reconcile: options.reconcile }),
    ...(options.resolveAuth === undefined ? {} : { resolveAuth: options.resolveAuth }),
    registry: makeRegistry(options),
  });
  executor.bindCredential({ profileId: PROFILE_ID, endpoint: ENDPOINT, apiKey: "management-secret" });
  return { executor, calls: () => calls };
}
function accessTokenRecord(secret: string, scope: FixtureAccessScope): FixtureAccessRecord {
  return {
    secret,
    id: `fixture-${scope}`,
    name: `Fixture ${scope}`,
    scope,
    createdAt: "2026-10-18T12:00:00.000Z",
    lastUsedAt: null,
    expiresAt: null,
    revokedAt: null,
  };
}

function dispatchUsingWhoamiFixture(fixture: ManagementAuthFixture, counts: { whoami: number; mutation: number }): NonNullable<AdminExecutorOptions["dispatch"]> {
  return async (request, context) => {
    if (request.operationId !== WHOAMI_OPERATION_ID) {
      counts.mutation += 1;
      return { ok: true };
    }
    counts.whoami += 1;
    const credential = context.auth.credential;
    const response = await fetch(request.url, {
      method: request.method,
      headers: credential?.kind === "apiKey" ? { authorization: `Bearer ${credential.value}` } : {},
    });
    if (!response.ok) throw Object.assign(new Error("qualified whoami fixture denied the request"), { status: response.status });
    return response.json();
  };
}

test("OMA mutation plans observe exact whoami scope and bind it through apply", async () => {
  const secret = "oma_fixture_admin";
  const fixture = new ManagementAuthFixture({ tokens: [accessTokenRecord(secret, "admin")] });
  const counts = { whoami: 0, mutation: 0 };
  const configured = setup({ dispatch: dispatchUsingWhoamiFixture(fixture, counts) });
  configured.executor.bindCredential({ profileId: PROFILE_ID, endpoint: fixture.endpoint, apiKey: secret });
  try {
    const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
    expect(plan.preview.authorization).toMatchObject({ kind: "oma-scope-observed", scope: "admin" });
    expect(counts.mutation).toBe(0);
    expect((await configured.executor.apply(plan.planId, { confirmed: true })).status).toBe("applied");
    expect(counts.whoami).toBeGreaterThan(0);
    expect(counts.mutation).toBe(1);
  } finally {
    fixture.stop();
  }
});

test("write-scoped OMA tokens cannot mutate a provider path with a provider ID segment", async () => {
  const operationId = "DELETE /api/providers/{id}";
  const secret = "oma_fixture_provider_write";
  const fixture = new ManagementAuthFixture({ tokens: [accessTokenRecord(secret, "write")] });
  const counts = { whoami: 0, mutation: 0 };
  const configured = setup({
    mutationOperationId: operationId,
    dispatch: dispatchUsingWhoamiFixture(fixture, counts),
  });
  configured.executor.bindCredential({ profileId: PROFILE_ID, endpoint: fixture.endpoint, apiKey: secret });
  try {
    await expect(configured.executor.plan(operationId, { path: { id: "fixture-provider" }, body: {} }))
      .rejects.toMatchObject({ code: "missing-scope" });
    expect(counts.whoami).toBe(1);
    expect(counts.mutation).toBe(0);
  } finally {
    fixture.stop();
  }
});

test("insufficient or changed OMA scopes fail closed before a mutation dispatch", async () => {
  const lowScopeSecret = "oma_fixture_read";
  const lowScopeFixture = new ManagementAuthFixture({ tokens: [accessTokenRecord(lowScopeSecret, "read")] });
  const lowScopeCounts = { whoami: 0, mutation: 0 };
  const lowScope = setup({ dispatch: dispatchUsingWhoamiFixture(lowScopeFixture, lowScopeCounts) });
  lowScope.executor.bindCredential({ profileId: PROFILE_ID, endpoint: lowScopeFixture.endpoint, apiKey: lowScopeSecret });
  try {
    await expect(lowScope.executor.plan(MUTATION, MUTATION_INPUT)).rejects.toMatchObject({ code: "missing-scope" });
    expect(lowScopeCounts.whoami).toBe(1);
    expect(lowScopeCounts.mutation).toBe(0);
  } finally {
    lowScopeFixture.stop();
  }

  const rotatedSecret = "oma_fixture_admin_rotation";
  const rotatedFixture = new ManagementAuthFixture({ tokens: [accessTokenRecord(rotatedSecret, "admin")] });
  const rotatedCounts = { whoami: 0, mutation: 0 };
  const rotated = setup({ dispatch: dispatchUsingWhoamiFixture(rotatedFixture, rotatedCounts) });
  rotated.executor.bindCredential({ profileId: PROFILE_ID, endpoint: rotatedFixture.endpoint, apiKey: rotatedSecret });
  try {
    const plan = await rotated.executor.plan(MUTATION, MUTATION_INPUT);
    rotatedFixture.setScope(rotatedSecret, "write");
    await expect(rotated.executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "credential-mismatch" });
    expect(rotatedCounts.mutation).toBe(0);
  } finally {
    rotatedFixture.stop();
  }
});

function domainAuth(operationDomain: AdminAuthDomain, profileId: string, endpoint: string, epoch = 1): AdminOperationAuthBinding | undefined {
  if (operationDomain !== "runtime" && operationDomain !== "metadata" && operationDomain !== "local") return undefined;
  if (operationDomain === "local") {
    return { domain: operationDomain, profileId, endpoint, epoch, authority: { kind: "uncredentialed", boundary: "loopback" } };
  }
  return {
    domain: operationDomain,
    profileId,
    endpoint,
    epoch,
    authority: { kind: "server-enforced", credentialKind: "apiKey" },
    credential: { kind: "apiKey", value: `${operationDomain}-secret` },
  };
}

test("denied and headless applies perform zero dispatches", async () => {
  const denied = setup();
  const plan = await denied.executor.plan(MUTATION, MUTATION_INPUT);
  const result = await denied.executor.apply(plan.planId, { confirmed: false });
  expect(result.status).toBe("denied");
  expect(denied.calls()).toBe(0);

  const headless = setup();
  const headlessPlan = await headless.executor.plan(MUTATION, MUTATION_INPUT);
  const headlessResult = await headless.executor.apply(headlessPlan.planId, { confirmed: true, headless: true });
  expect(headlessResult.status).toBe("denied");
  expect(headless.calls()).toBe(0);
});

test("expired plans are rejected before dispatch", async () => {
  let clock = 0;
  const configured = setup({ now: () => clock });
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  clock = plan.expiresAt;
  await expect(configured.executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-expired" });
  expect(configured.calls()).toBe(0);
});

test("mutation preview exposes only the redacted change while apply dispatches the sealed body", async () => {
  const body = { name: "Updated provider", password: "fixture-private-password" };
  let dispatchedBody: unknown;
  const configured = setup({
    mutationBodySchema: {
      type: "object",
      properties: { name: { type: "string" }, password: { type: "string" } },
      required: ["name", "password"],
      additionalProperties: false,
    },
    dispatch: async request => {
      dispatchedBody = request.body;
      return { ok: true };
    },
  });
  const plan = await configured.executor.plan(MUTATION, { body });
  expect(plan.preview.payload).toEqual({
    path: {},
    query: {},
    body: { name: "Updated provider", password: "[redacted]" },
  });
  expect(JSON.stringify(plan.preview)).not.toContain("fixture-private-password");
  expect((await configured.executor.apply(plan.planId, { confirmed: true })).status).toBe("applied");
  expect(dispatchedBody).toEqual(body);
});

test("target drift and management credential changes invalidate a dependent plan", async () => {
  let target = "target-a";
  const configured = setup({ readTarget: async () => makeTarget(target) });
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  target = "target-b";
  await expect(configured.executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "target-drift" });
  expect(configured.calls()).toBe(0);

  const changed = setup();
  const changedPlan = await changed.executor.plan(MUTATION, MUTATION_INPUT);
  changed.executor.bindCredential({ profileId: PROFILE_ID, endpoint: ENDPOINT, apiKey: "new-secret" });
  await expect(changed.executor.apply(changedPlan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-invalidated" });
});

test("pre-dispatch target-read 403 invalidates approval without replay", async () => {
  let targetReads = 0;
  let denied = true;
  const configured = setup({
    readTarget: async () => {
      targetReads += 1;
      if (targetReads === 2 && denied) throw Object.assign(new Error("fixture authorization denied"), { status: 403 });
      return makeTarget("target-a");
    },
  });
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  await expect(configured.executor.apply(plan.planId, { confirmed: true }))
    .rejects.toMatchObject({ code: "unauthorized", status: 403 });
  expect(configured.executor.getPlan(plan.planId)?.state).toBe("invalidated");

  denied = false;
  await expect(configured.executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-invalidated" });
  expect(targetReads).toBe(2);
  expect(configured.calls()).toBe(0);
});
test("secret target fields stay private while exact target digests still detect drift", async () => {
  let fetchProxyUrl = "https://user:password-a@proxy.example/?api_key=opaque-a";
  const configured = setup({ readTarget: async () => makeTarget({ id: "provider-1", fetchProxyUrl }) });
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  expect(plan.preview.projectedTarget).toEqual({ id: "provider-1", fetchProxyUrl: "[redacted]" });
  expect(JSON.stringify(plan)).not.toContain("password-a");
  expect(JSON.stringify(plan)).not.toContain("opaque-a");
  const handle = configured.executor.getPlan(plan.planId);
  expect(JSON.stringify(handle)).not.toContain("password-a");
  expect(JSON.stringify(handle)).not.toContain("opaque-a");

  fetchProxyUrl = "https://user:password-b@proxy.example/?api_key=opaque-b";
  await expect(configured.executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "target-drift" });
  expect(configured.calls()).toBe(0);
});

test("duplicate applies never replay a write", async () => {
  const configured = setup();
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  expect((await configured.executor.apply(plan.planId, { confirmed: true })).status).toBe("applied");
  await expect(configured.executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-already-applied" });
  expect(configured.calls()).toBe(1);
});

test("lost responses reconcile once and remain unknown", async () => {
  let reconcileCalls = 0;
  const configured = setup({
    dispatch: async () => { throw Object.assign(new Error("remote secret detail"), { uncertain: true }); },
    reconcile: async () => { reconcileCalls += 1; return { status: "unknown" }; },
  });
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  const result = await configured.executor.apply(plan.planId, { confirmed: true });
  expect(result.status).toBe("unknown");
  expect(configured.executor.getPlan(plan.planId)?.state).toBe("unknown");
  expect(configured.calls()).toBe(1);
  expect(reconcileCalls).toBe(1);
  await expect(configured.executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-already-applied" });
});

test("plan identities and errors never expose credential values", async () => {
  const configured = setup({ dispatch: async () => { throw Object.assign(new Error("apiKey=management-secret"), { status: 500 }); } });
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  expect(plan.auth).toEqual({ domain: "management", profileId: PROFILE_ID, endpoint: ENDPOINT, epoch: 1 });
  expect(JSON.stringify(plan)).not.toContain("management-secret");
  await expect(configured.executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "dispatch-failed", status: 500 });
});
test("a post-dispatch cancellation remains unknown and is never replayed", async () => {
  let configured!: ExecutorHarness;
  let dispatchSignalAborted = false;
  configured = setup({
    dispatch: async (_request, context) => {
      configured.executor.disable();
      dispatchSignalAborted = context.signal?.aborted === true;
      throw Object.assign(new Error("connection aborted after dispatch"), { code: "aborted" });
    },
  });
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  const result = await configured.executor.apply(plan.planId, { confirmed: true });
  expect(dispatchSignalAborted).toBe(true);
  expect(result.status).toBe("unknown");
  expect(configured.executor.getPlan(plan.planId)?.state).toBe("unknown");
  expect(configured.calls()).toBe(1);
});

test("a known rejected dispatch does not leave an applied plan state", async () => {
  const configured = setup({ dispatch: async () => { throw Object.assign(new Error("request rejected"), { status: 400 }); } });
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  await expect(configured.executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "dispatch-failed", status: 400 });
  expect(configured.executor.getPlan(plan.planId)?.state).not.toBe("applied");
  expect(configured.calls()).toBe(1);
});
test("management permission remains server-enforced and is stated in the plan preview", async () => {
  const configured = setup();
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  expect(plan.preview.authorization).toMatchObject({ kind: "server-enforced" });
  expect(configured.calls()).toBe(0);
  expect((await configured.executor.apply(plan.planId, { confirmed: true })).status).toBe("applied");
  expect(configured.calls()).toBe(1);
});


test("runtime mutations use their own credential instead of the management key", async () => {
  let observed: unknown;
  const configured = setup({
    mutation: "runtime",
    resolveAuth: async (operation, context) => domainAuth(operation.auth.domain, context.profileId, context.endpoint, 7),
    dispatch: async (_request, context) => { observed = context.auth; return { ok: true }; },
  });
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  expect(plan.auth).toEqual({ domain: "runtime", profileId: PROFILE_ID, endpoint: ENDPOINT, epoch: 7 });
  await configured.executor.apply(plan.planId, { confirmed: true });
  expect(observed).toMatchObject({ domain: "runtime", epoch: 7, credential: { kind: "apiKey", value: "runtime-secret" } });
  expect(JSON.stringify(observed)).not.toContain("management-secret");
});
test("runtime and metadata resolvers must supply their own API key", async () => {
  const runtime = setup({
    mutation: "runtime",
    resolveAuth: async (_operation, context) => ({
      domain: "runtime",
      profileId: context.profileId,
      endpoint: context.endpoint,
      epoch: 2,
      authority: { kind: "server-enforced", credentialKind: "apiKey" },
    }),
  });
  await expect(runtime.executor.plan(MUTATION, MUTATION_INPUT)).rejects.toMatchObject({ code: "credential-required" });
  expect(runtime.calls()).toBe(0);

  const metadata = setup({
    mutation: "runtime",
    target: "metadata",
    resolveAuth: async (operation, context) => operation.auth.domain === "runtime"
      ? domainAuth(operation.auth.domain, context.profileId, context.endpoint, 3)
      : {
          domain: "metadata",
          profileId: context.profileId,
          endpoint: context.endpoint,
          epoch: 4,
          authority: { kind: "server-enforced", credentialKind: "apiKey" },
        },
  });
  await expect(metadata.executor.plan(MUTATION, MUTATION_INPUT)).rejects.toMatchObject({ code: "credential-required" });
  expect(metadata.calls()).toBe(0);
});

test("management credential rotation preserves a plan bound only to runtime auth", async () => {
  const configured = setup({
    mutation: "runtime",
    target: "runtime",
    reconciliation: "runtime",
    resolveAuth: async (operation, context) => domainAuth(operation.auth.domain, context.profileId, context.endpoint, 9),
  });
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  configured.executor.bindCredential({ profileId: PROFILE_ID, endpoint: ENDPOINT, apiKey: "replacement-management-secret" });
  expect(configured.executor.getPlan(plan.planId)?.state).toBe("pending");
  expect((await configured.executor.apply(plan.planId, { confirmed: true })).status).toBe("applied");
  expect(configured.calls()).toBe(1);
});


test("target and reconciliation reads resolve their own domains and epochs", async () => {
  const observed: { target?: unknown; reconciliation?: unknown } = {};
  const configured = setup({
    mutation: "runtime",
    target: "metadata",
    reconciliation: "local",
    resolveAuth: async (operation, context) => {
      const epoch = operation.auth.domain === "runtime" ? 3 : operation.auth.domain === "metadata" ? 5 : 8;
      return domainAuth(operation.auth.domain, context.profileId, context.endpoint, epoch);
    },
    readTarget: async (context) => {
      observed.target = context.auth;
      return makeTarget("target-a");
    },
    dispatch: async () => { throw Object.assign(new Error("lost reply"), { uncertain: true }); },
    reconcile: async (context) => {
      observed.reconciliation = context.auth;
      return { status: "applied", output: {} };
    },
  });
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  expect(plan.auth).toMatchObject({ domain: "runtime", epoch: 3 });
  expect(plan.targetAuth).toMatchObject({ domain: "metadata", epoch: 5 });
  expect(observed.target).toMatchObject({ domain: "metadata", credential: { value: "metadata-secret" } });
  const result = await configured.executor.apply(plan.planId, { confirmed: true });
  expect(observed.reconciliation).toMatchObject({ domain: "local", epoch: 0, authority: { kind: "uncredentialed", boundary: "loopback" } });
  expect(result.status).toBe("applied");
});

test("target-auth epoch rotation after the awaited target read prevents dispatch", async () => {
  let targetEpoch = 1;
  let reads = 0;
  const configured = setup({
    mutation: "runtime",
    target: "metadata",
    resolveAuth: async (operation, context) => domainAuth(operation.auth.domain, context.profileId, context.endpoint, operation.auth.domain === "runtime" ? 4 : targetEpoch),
    readTarget: async () => {
      reads += 1;
      if (reads === 2) targetEpoch = 2;
      return makeTarget("target-a");
    },
  });
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  await expect(configured.executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "credential-mismatch" });
  expect(configured.calls()).toBe(0);
});

test("an explicit non-reconcilable relation produces unknown after one lost dispatch", async () => {
  let reconcileCalls = 0;
  const configured = setup({
    reconciliationEnabled: false,
    dispatch: async () => { throw Object.assign(new Error("lost reply"), { uncertain: true }); },
    reconcile: async () => { reconcileCalls += 1; return { status: "applied" }; },
  });
  const plan = await configured.executor.plan(MUTATION, MUTATION_INPUT);
  expect(plan.targetDigest).toBeNull();
  const result = await configured.executor.apply(plan.planId, { confirmed: true });
  expect(result.status).toBe("unknown");
  expect(configured.calls()).toBe(1);
  expect(reconcileCalls).toBe(0);
});
