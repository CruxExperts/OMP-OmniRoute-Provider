import { createHash } from "node:crypto";
import { expect, test } from "bun:test";
import type { Context, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createAdminExecutor } from "../src/admin/executor.ts";
import { createBoundInferenceStream, createSingleDispatchFetch, OMNIROUTE_GUARDED_API } from "../src/inference.ts";
import { canonicalizeJson, getOperationRegistry, type OperationDescriptor, type OperationReconciliationRelation } from "../src/admin/registry.ts";
import type { AdminExecutorOptions, AdminTarget, AdminTargetReader } from "../src/admin/types.ts";
import { invokeBinaryAdapter, invokeJsonAdapter, invokeMultipartAdapter, invokeSseAdapter, invokeWebSocketAdapter } from "../src/admin/adapters.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";

const ADMIN_PROFILE = "omniroute";
const ADMIN_ENDPOINT = "http://127.0.0.1:20128";
const MANAGEMENT_POLICY: OperationDescriptor["auth"]["sourcePolicy"] = {
  status: "qualified",
  source: "omniroute-v3.8.52",
  routeClass: "management",
  localOnly: false,
  handlerGuard: "none",
  bootstrap: "none",
  alternatives: [{ kind: "management-api-key", anyOf: ["manage", "admin"] }],
};
const PUBLIC_POLICY: OperationDescriptor["auth"]["sourcePolicy"] = {
  status: "qualified",
  source: "omniroute-v3.8.52",
  routeClass: "public",
  alternatives: [{ kind: "anonymous" }],
};

function makeTarget(snapshot: string): AdminTarget {
  return { snapshot, digest: createHash("sha256").update(canonicalizeJson(snapshot)).digest("hex") };
}

function adminHarness(
  readTarget: AdminTargetReader = async () => makeTarget("target"),
  mutationOverride?: OperationDescriptor,
  dispatchOverride?: AdminExecutorOptions["dispatch"],
) {
  let dispatches = 0;
  const sourceRegistry = getOperationRegistry();
  const mutationSource = mutationOverride ?? sourceRegistry.getOperation("DELETE /api/cache");
  const readSource = sourceRegistry.getOperation("GET /api/health");
  if (!mutationSource || !readSource) throw new Error("admin fixture descriptor missing");
  const targetRead: OperationDescriptor = {
    ...readSource,
    operationId: "GET /fixture/admin-target",
    pathTemplate: "/fixture/admin-target",
    auth: { ...readSource.auth, domain: "management", sourcePolicy: MANAGEMENT_POLICY },
    sideEffect: "read",
    confirmation: { required: false, reason: "Synthetic ordinary read." },
    request: { ...readSource.request, body: null },
    response: { ...readSource.response, schema: { type: "object", properties: { ok: { type: "boolean" } }, additionalProperties: false, required: [] } },
    coverage: { status: "invokable", adapterId: "typed.fixture.admin-target", reason: null },
    reconciliation: null,
  };
  const relation: OperationReconciliationRelation = {
    targetRead: {
      operationId: targetRead.operationId,
      inputs: [],
      snapshot: { kind: "resource", identity: [], state: [] },
    },
    reconcile: {
      operationId: targetRead.operationId,
      inputs: [],
      outcome: { kind: "matches", identityFields: [], stateFields: [] },
    },
  };
  const mutation: OperationDescriptor = {
    ...mutationSource,
    auth: { ...mutationSource.auth, domain: "management", sourcePolicy: MANAGEMENT_POLICY },
    sideEffect: "mutation",
    confirmation: { required: true, reason: "Synthetic mutation." },
    request: mutationOverride?.request ?? { ...mutationSource.request, body: { required: true, mediaType: "application/json", schema: { type: "object", properties: {}, additionalProperties: false }, contentVariants: [] } },
    response: { ...mutationSource.response, schema: { type: "object", properties: { ok: { type: "boolean" } }, additionalProperties: false, required: [] } },
    coverage: { status: "invokable", adapterId: "typed.fixture.mutation", reason: null },
    reconciliation: relation,
  };
  const descriptors = [mutation, targetRead];
  const registry = fixtureRegistry(descriptors);
  const executor = createAdminExecutor({
    registry,
    readTarget,
    dispatch: async (request, context) => {
      dispatches += 1;
      return dispatchOverride ? dispatchOverride(request, context) : { ok: true };
    },
  });
  executor.bindCredential({ profileId: ADMIN_PROFILE, endpoint: ADMIN_ENDPOINT, apiKey: "fixture-management-key" });
  return { executor, dispatches: () => dispatches };
}

test("read rejects a mutation even when a caller claims confirmation", async () => {
  const harness = adminHarness();
  await expect(harness.executor.read("DELETE /api/cache", { body: {} }, { confirmed: true })).rejects.toMatchObject({ code: "confirmation-required" });
  expect(harness.dispatches()).toBe(0);
});

test("missing eligibility evidence rejects an otherwise schema-valid read before dispatch", async () => {
  let dispatches = 0;
  const executor = createAdminExecutor({ dispatch: async () => { dispatches += 1; return {}; } });
  executor.bindCredential({ profileId: "omniroute", endpoint: "http://127.0.0.1:20128", apiKey: "fixture-management-key" });
  await expect(executor.read("GET /api/cache", {})).rejects.toMatchObject({ code: "operation-unavailable" });
  await expect(executor.read("GET /not-in-inventory", {})).rejects.toMatchObject({ code: "unknown-operation" });
  expect(dispatches).toBe(0);
});

test("barrier-synchronized concurrent applies dispatch exactly once", async () => {
  let release!: () => void;
  let reads = 0;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const harness = adminHarness(async () => {
    reads += 1;
    if (reads > 1) await barrier;
    return makeTarget("target");
  });
  const plan = await harness.executor.plan("DELETE /api/cache", { body: {} });
  const first = harness.executor.apply(plan.planId, { confirmed: true });
  const second = harness.executor.apply(plan.planId, { confirmed: true });
  release();
  const settled = await Promise.allSettled([first, second]);
  expect(settled.filter(item => item.status === "fulfilled")).toHaveLength(1);
  expect(harness.dispatches()).toBe(1);
});

test("unchanged credential rebinding preserves a pending plan and its management epoch", async () => {
  const harness = adminHarness();
  const plan = await harness.executor.plan("DELETE /api/cache", { body: {} });
  const before = harness.executor.getCredentialBinding();
  const after = harness.executor.bindCredential({ profileId: ADMIN_PROFILE, endpoint: ADMIN_ENDPOINT, apiKey: "fixture-management-key" });
  expect(after.epoch).toBe(before!.epoch);
  expect(harness.executor.getPlan(plan.planId)?.state).toBe("pending");
});

test("public operations require explicit endpoint activation but no management credential", async () => {
  let dispatches = 0;
  let observedAuth: unknown;
  const source = getOperationRegistry().getOperation("GET /api/health");
  if (!source) throw new Error("public operation fixture missing");
  const descriptor: OperationDescriptor = {
    ...source,
    auth: { ...source.auth, domain: "public", sourcePolicy: PUBLIC_POLICY },
    sideEffect: "read",
    confirmation: { required: false, reason: "Synthetic public read." },
    request: { ...source.request, body: null },
    response: { ...source.response, schema: { type: "object", properties: {}, required: [], additionalProperties: false } },
    coverage: { status: "invokable", adapterId: "typed.fixture.public", reason: null },
  };
  const registry = fixtureRegistry([descriptor]);
  const executor = createAdminExecutor({
    registry,
    dispatch: async (_request, context) => {
      dispatches += 1;
      observedAuth = context.auth;
      return {};
    },
  });
  const selection = { profileId: ADMIN_PROFILE, endpoint: ADMIN_ENDPOINT };
  await expect(executor.read("GET /api/health", {}, selection)).rejects.toMatchObject({ code: "credential-disabled" });
  expect(dispatches).toBe(0);
  executor.setAdminBinding(selection, true);
  await expect(executor.read("GET /api/health", {}, { ...selection, endpoint: "http://127.0.0.1:20129" })).rejects.toMatchObject({ code: "credential-mismatch" });
  expect(dispatches).toBe(0);
  await executor.read("GET /api/health", {}, selection);
  expect(observedAuth).toMatchObject({ domain: "public", profileId: ADMIN_PROFILE, endpoint: ADMIN_ENDPOINT, epoch: 0 });
  expect(observedAuth).not.toHaveProperty("credential");
  executor.disable();
  await expect(executor.read("GET /api/health", {}, selection)).rejects.toMatchObject({ code: "credential-disabled" });
  expect(dispatches).toBe(1);
});

test("logout blocks automatic credential rebinding until explicit human enable", () => {
  const harness = adminHarness();
  harness.executor.logout();
  expect(() => harness.executor.bindCredential({ profileId: ADMIN_PROFILE, endpoint: ADMIN_ENDPOINT, apiKey: "fixture-management-key" })).toThrow();
  harness.executor.setAdminBinding({ profileId: ADMIN_PROFILE, endpoint: ADMIN_ENDPOINT }, true);
  expect(harness.executor.bindCredential({ profileId: ADMIN_PROFILE, endpoint: ADMIN_ENDPOINT, apiKey: "fixture-management-key" }).enabled).toBe(true);
});

test("inference dispatch pins the selected protocol, rejects redirects, and suppresses replay", async () => {
  let calls = 0;
  const baseFetch: typeof fetch = Object.assign(async () => {
    calls += 1;
    return new Response(null, { status: 302, headers: { location: "https://other.example/v1/responses" } });
  }, { preconnect: globalThis.fetch.preconnect });
  const guarded = createSingleDispatchFetch("https://gateway.example", "openai-responses", baseFetch);
  expect(guarded.preconnect).toBe(baseFetch.preconnect);
  await expect(guarded("https://gateway.example/v1/responses", { method: "POST" })).rejects.toMatchObject({ code: "inference-redirect" });
  await expect(guarded("https://gateway.example/v1/responses", { method: "POST" })).rejects.toMatchObject({ code: "inference-replay-suppressed" });
  expect(calls).toBe(1);
});

test("inference target guard rejects every non-exact route before network dispatch", async () => {
  let calls = 0;
  const baseFetch: typeof fetch = Object.assign(async () => {
    calls += 1;
    return new Response(null, { status: 200 });
  }, { preconnect: globalThis.fetch.preconnect });
  const invalidTargets = [
    ["openai-responses", "https://gateway.example/v1/responses/extra", "POST"],
    ["openai-responses", "https://gateway.example/v1/responses?query=1", "POST"],
    ["openai-responses", "https://user@gateway.example/v1/responses", "POST"],
    ["openai-responses", "https://@gateway.example/v1/responses", "POST"],
    ["openai-responses", "http://gateway.example/v1/responses", "POST"],
    ["openai-responses", "https://other.example/v1/responses", "POST"],
    ["openai-responses", "https://gateway.example/v1/chat/completions", "POST"],
    ["openai-responses", "https://gateway.example/v1/responses", "GET"],
    ["openai-responses", "https://gateway.example/v1/responses?", "POST"],
    ["openai-responses", "https://gateway.example/v1/responses#", "POST"],
    ["openai-completions", "https://gateway.example/v1/chat/completions/extra", "POST"],
    ["openai-completions", "https://gateway.example/v1/chat/completions#fragment", "POST"],
    ["openai-completions", "https://gateway.example/v1/responses", "POST"],
  ] as const;
  for (const [api, target, method] of invalidTargets) {
    const guarded = createSingleDispatchFetch("https://gateway.example", api, baseFetch);
    await expect(guarded(target, { method })).rejects.toMatchObject({ code: "inference-target-mismatch" });
  }
  expect(() => createSingleDispatchFetch("https://gateway.example/proxy?", "openai-responses", baseFetch)).toThrow("inference endpoint contains forbidden URL components");
  expect(() => createSingleDispatchFetch("https://gateway.example/proxy#", "openai-responses", baseFetch)).toThrow("inference endpoint contains forbidden URL components");
  const disabled = createSingleDispatchFetch("https://gateway.example", "openai-responses", baseFetch, () => false);
  await expect(disabled("https://gateway.example/v1/responses", { method: "POST" })).rejects.toMatchObject({ code: "inference-binding-invalid" });
  expect(calls).toBe(0);
});

test("selected Responses and Chat Completions targets reach a loopback fixture with a configured prefix", async () => {
  const received: string[] = [];
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      received.push(`${request.method} ${new URL(request.url).pathname}`);
      return Response.json({ ok: true });
    },
  });
  try {
    const origin = `http://127.0.0.1:${server.port}`;
    const responses = createSingleDispatchFetch(`${origin}/proxy`, "openai-responses");
    const completions = createSingleDispatchFetch(`${origin}/proxy`, "openai-completions");
    await responses(`${origin}/proxy/v1/responses`, { method: "POST" });
    await completions(`${origin}/proxy/v1/chat/completions`, { method: "POST" });
    expect(received).toEqual([
      "POST /proxy/v1/responses",
      "POST /proxy/v1/chat/completions",
    ]);
  } finally {
    server.stop();
  }
});

test("inference rejects native API rows, missing current mappings, and aborted generations before streaming", () => {
  const binding = { endpoint: "https://gateway.example", credential: "fixture-runtime-key", generation: 2 };
  const generation = new AbortController();
  let api: "openai-responses" | "openai-completions" | undefined = "openai-responses";
  const stream = createBoundInferenceStream({
    expectedEndpoint: binding.endpoint,
    expectedGeneration: binding.generation,
    currentBinding: () => binding,
    currentModelApi: id => id === "live-model" ? api : undefined,
    currentSignal: () => generation.signal,
    stopped: () => false,
  });
  const guardedModel = { id: "live-model", api: OMNIROUTE_GUARDED_API } as never;
  const nativeModel = { id: "live-model", api: "openai-responses" } as never;
  expect(() => stream(nativeModel, { messages: [], tools: [] } as never)).toThrow();
  api = undefined;
  expect(() => stream(guardedModel, { messages: [], tools: [] } as never)).toThrow();
  api = "openai-responses";
  generation.abort();
  expect(() => stream(guardedModel, { messages: [], tools: [] } as never)).toThrow();
});

test("bound native streaming sends one prefixed request and reports caller or binding cancellation", async () => {
  for (const api of ["openai-responses", "openai-completions"] as const) {
    let requests = 0;
    const requestSeen = Promise.withResolvers<{
      path: string;
      model: string | undefined;
      authorization: string | null;
      temperature: number | undefined;
      outputLimit: number | undefined;
      optionHeader: string | null;
    }>();
    const server = Bun.serve({
      port: 0,
      async fetch(request) {
        requests++;
        const body = await request.json() as {
          model?: string;
          temperature?: number;
          max_tokens?: number;
          max_completion_tokens?: number;
          max_output_tokens?: number;
        };
        requestSeen.resolve({
          path: new URL(request.url).pathname,
          model: body.model,
          authorization: request.headers.get("authorization"),
          temperature: body.temperature,
          outputLimit: body.max_tokens ?? body.max_completion_tokens ?? body.max_output_tokens,
          optionHeader: request.headers.get("x-fixture-option"),
        });
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(": fixture stream ready\n\n"));
          },
        }), {
          headers: { "content-type": "text/event-stream" },
        });
      },
    });
    const endpoint = `http://127.0.0.1:${server.port}/proxy`;
    const binding = { endpoint, credential: "fixture-runtime-key", generation: 12 };
    const generation = new AbortController();
    const caller = new AbortController();
    try {
      const stream = createBoundInferenceStream({
        expectedEndpoint: endpoint,
        expectedGeneration: binding.generation,
        currentBinding: () => binding,
        currentModelApi: id => id === "live-model" ? api : undefined,
        currentSignal: () => generation.signal,
        stopped: () => false,
      });
      const model = buildModel({
        id: "live-model",
        name: "live-model",
        api: OMNIROUTE_GUARDED_API,
        provider: "omniroute",
        baseUrl: `${endpoint}/v1`,
        reasoning: false,
        preferWebsockets: true,
        input: ["text"],
        contextWindow: 4096,
        maxTokens: 512,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        headers: { Authorization: "Bearer model-override" },
      });
      expect(model.compat).toBeUndefined();
      const context: Context = {
        messages: [{ role: "user", content: [{ type: "text", text: "fixture request" }], timestamp: Date.now() }],
        tools: [],
      };
      const responseReceived = Promise.withResolvers<void>();
      const baseFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const response = await globalThis.fetch(input, init);
        responseReceived.resolve();
        return response;
      }, { preconnect: globalThis.fetch.preconnect });
      const streamOptions: SimpleStreamOptions = {
        temperature: 0.25,
        signal: caller.signal,
        maxTokens: 64,
        headers: { Authorization: "Bearer caller-override", "x-fixture-option": "preserved" },
        fetch: baseFetch,
        preferWebsockets: true,
      };
      const active = stream(model, context, streamOptions);
      const terminal = active.result().then(
        message => ({ kind: "terminal" as const, message }),
        error => ({ kind: "rejected" as const, error }),
      );
      const first = await Promise.race([
        requestSeen.promise.then(value => ({ kind: "request" as const, value })),
        terminal,
      ]);
      if (first.kind !== "request") {
        throw new Error(first.kind === "terminal"
          ? `stream terminated before dispatch: ${first.message.stopReason}/${first.message.errorMessage ?? ""}`
          : `stream rejected before dispatch: ${String(first.error)}`);
      }
      const received = first.value;
      expect(received.path).toBe(`/proxy/v1/${api === "openai-responses" ? "responses" : "chat/completions"}`);
      expect(received.model).toBe("live-model");
      expect(received.authorization).toBe("Bearer fixture-runtime-key");
      if (api === "openai-completions") {
        expect(received.temperature).toBe(0.25);
        expect(received.outputLimit).toBe(64);
      }
      expect(received.optionHeader).toBe("preserved");
      expect(requests).toBe(1);
      const response = await Promise.race([
        responseReceived.promise.then(() => ({ kind: "response" as const })),
        terminal,
      ]);
      if (response.kind !== "response") {
        throw new Error(response.kind === "terminal"
          ? `stream terminated before response headers: ${response.message.stopReason}/${response.message.errorMessage ?? ""}`
          : `stream rejected before response headers: ${String(response.error)}`);
      }
      if (api === "openai-responses") caller.abort();
      else generation.abort();
      const final = await terminal;
      if (final.kind !== "terminal") throw new Error(`stream rejected after cancellation: ${String(final.error)}`);
      expect(final.message.stopReason).toBe("aborted");
      expect(requests).toBe(1);
    } finally {
      generation.abort();
      server.stop();
    }
  }
});

test("disablement while final target observation is pending prevents dispatch", async () => {
  let release!: () => void;
  let reads = 0;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const harness = adminHarness(async () => {
    reads += 1;
    if (reads > 1) await barrier;
    return makeTarget("target");
  });
  const plan = await harness.executor.plan("DELETE /api/cache", { body: {} });
  const applying = harness.executor.apply(plan.planId, { confirmed: true });
  harness.executor.disable();
  release();
  await expect(applying).rejects.toMatchObject({ code: "plan-invalidated" });
  expect(harness.dispatches()).toBe(0);
});

test("complete approval previews reject unseen long suffixes", async () => {
  const base = getOperationRegistry().getOperation("DELETE /api/cache");
  if (!base) throw new Error("fixture descriptor missing");
  const descriptor: OperationDescriptor = {
    ...base,
    operationId: "POST /fixture/preview",
    method: "POST",
    pathTemplate: "/fixture/preview",
    request: {
      ...base.request,
      body: {
        contentVariants: [],
        required: true,
        mediaType: "application/json",
        schema: { type: "object", properties: { note: { type: "string" } }, required: ["note"], additionalProperties: false },
      },
    },
  };
  const harness = adminHarness(async () => makeTarget("target"), descriptor);
  await expect(harness.executor.plan(descriptor.operationId, { body: { note: `visible${"x".repeat(8_100)}hidden-suffix` } })).rejects.toMatchObject({ code: "preview-too-large" });
});

test("registry and every dispatch adapter reject traversal or a tampered resolved path", async () => {
  const source = getOperationRegistry().getOperation("DELETE /api/keys/{id}");
  if (!source) throw new Error("path fixture descriptor missing");
  const descriptor: OperationDescriptor = {
    ...source,
    auth: { ...source.auth, domain: "management", sourcePolicy: MANAGEMENT_POLICY },
    sideEffect: "mutation",
    confirmation: { required: true, reason: "Synthetic path mutation." },
    request: { ...source.request, body: { required: true, mediaType: "application/json", schema: { type: "object", properties: {}, additionalProperties: false }, contentVariants: [] } },
    coverage: { status: "invokable", adapterId: "typed.fixture.path-mutation", reason: null },
    reconciliation: null,
  };
  const adapter = fixtureRegistry([descriptor]).require(descriptor.operationId);
  for (const id of [".", "..", "%2e%2e", "%252e%252e", "%2f", "%5c"]) {
    expect(() => adapter.buildPath(adapter.validate({ path: { id }, body: {} }))).toThrow();
  }
  expect(adapter.buildPath(adapter.validate({ path: { id: "模型" }, body: {} }))).toContain("%E6%A8%A1%E5%9E%8B");
  const invocation = { descriptor: { ...adapter.descriptor, adapterId: adapter.adapterId }, endpoint: "http://127.0.0.1:20128", credential: { kind: "apiKey" as const, value: "fixture-management-key" }, resolvedPath: "/api/cache", queryParameters: [], body: {} };
  await expect(invokeJsonAdapter(invocation)).rejects.toMatchObject({ code: "invalid_path" });
  await expect(invokeSseAdapter(invocation)).rejects.toMatchObject({ code: "invalid_path" });
  await expect(invokeBinaryAdapter(invocation)).rejects.toMatchObject({ code: "invalid_path" });
  await expect(invokeMultipartAdapter(invocation, [], {})).rejects.toMatchObject({ code: "invalid_path" });
  let opened = false;
  await expect(invokeWebSocketAdapter(invocation, () => { opened = true; throw new Error("must not open"); })).rejects.toMatchObject({ code: "invalid_path" });
  expect(opened).toBe(false);
});

test("operator-required dispatch is terminal and is never reported as applied", async () => {
  const harness = adminHarness(
    async () => makeTarget("target"),
    undefined,
    async () => ({ status: "operator-required", reason: "external-consent", message: "operator action required" }),
  );
  const plan = await harness.executor.plan("DELETE /api/cache", { body: {} });
  const result = await harness.executor.apply(plan.planId, { confirmed: true });
  expect(result.status).toBe("operator-required");
  expect(harness.executor.getPlan(plan.planId)?.state).toBe("operator-required");
  await expect(harness.executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-already-applied" });
});
