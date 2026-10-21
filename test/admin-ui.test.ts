import { unlink } from "node:fs/promises";
import { expect, test } from "bun:test";
import { ADMIN_ADAPTER_LIMITS, adapterFor, invokeJsonAdapter, invokeMultipartAdapter, invokeWebSocketAdapter, isLoopbackHostname, validateAdminEndpoint, writeProtectedFile } from "../src/admin/adapters.ts";
import { createAdminExecutor } from "../src/admin/executor.ts";
import { getOperation, projectResponse, type OperationDescriptor } from "../src/admin/registry.ts";
import { createAdminCommandHandler } from "../src/admin/ui.ts";
import type { AdminPlanHandle } from "../src/admin/types.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";

const jsonDescriptor = {
  operationId: "GET /api/models",
  adapterId: "typed.get.api.models",
  method: "GET" as const,
  pathTemplate: "/api/models",
  mediaType: { request: "application/json", response: "application/json" },
  streaming: { mode: "json" as const, framing: "json" },
  auth: { domain: "management" },
};

test("loopback validation is explicit and rejects endpoint credentials", () => {
  expect(isLoopbackHostname("127.0.0.1")).toBe(true);
  expect(isLoopbackHostname("remote.example")).toBe(false);
  expect(isLoopbackHostname("127.evil.example")).toBe(false);
  expect(() => validateAdminEndpoint("https://user:pass@remote.example")).toThrow();
  expect(() => validateAdminEndpoint("https://remote.example", true)).toThrow();
  expect(validateAdminEndpoint("http://127.0.0.1:20128", true).hostname).toBe("127.0.0.1");
});

test("WebSocket handshake carries the bound credential in headers", async () => {
  let headers: Record<string, string> | undefined;
  const socket = {
    onopen: null as (() => void) | null,
    onmessage: null,
    onerror: null,
    onclose: null as ((event: { code: number }) => void) | null,
    send() {},
    close() {},
  };
  const result = invokeWebSocketAdapter({
    descriptor: { ...jsonDescriptor, streaming: { mode: "websocket" as const, framing: "message" } },
    endpoint: "http://127.0.0.1:20128",
    credential: { kind: "apiKey", value: "fixture-management-key" },
    resolvedPath: "/api/models",
    queryParameters: [],
  }, (_url, options) => {
    headers = options.headers;
    queueMicrotask(() => { socket.onopen?.(); socket.onclose?.({ code: 1000 }); });
    return socket as unknown as WebSocket;
  });
  await expect(result).resolves.toMatchObject({ status: 200 });
  expect(headers?.authorization).toBe("Bearer fixture-management-key");
});

test("operation protocol selection remains dedicated", () => {
  expect(adapterFor(jsonDescriptor)).toBe("json");
  expect(adapterFor({ ...jsonDescriptor, mediaType: { request: "application/json", response: "text/event-stream" }, streaming: { mode: "sse" as const, framing: "event-stream" } })).toBe("sse");
  expect(adapterFor({ ...jsonDescriptor, mediaType: { request: "application/json", response: "application/octet-stream" }, streaming: { mode: "binary" as const, framing: "bytes" } })).toBe("binary");
  expect(adapterFor({ ...jsonDescriptor, mediaType: { request: "application/json", response: "application/octet-stream" } })).toBe("unavailable");
  expect(adapterFor({ ...jsonDescriptor, pathTemplate: "/api/oauth/login" })).toBe("json");
});

test("apply command remains human-only when the confirmation form is cancelled", async () => {
  let applyCalls = 0;
  const cancelledPlan: AdminPlanHandle = {
    planId: "p-missing",
    operationId: "DELETE /api/cache",
    auth: { domain: "management", profileId: "omniroute", endpoint: "http://127.0.0.1:20128", epoch: 1 },
    targetAuth: null,
    payloadDigest: "payload-digest",
    targetDigest: null,
    risk: "destructive",
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    state: "pending",
    preview: {
      operationId: "DELETE /api/cache",
      method: "DELETE",
      pathTemplate: "/api/cache",
      target: { profileId: "omniroute", endpoint: "http://127.0.0.1:20128" },
      risk: "destructive",
      sideEffect: "destructive",
      confirmationRequired: true,
      authorization: { kind: "server-enforced", message: "The server enforces credential permissions; this preview did not preflight them." },
      payload: { path: {}, query: {}, body: {} },
      consequence: "At most one dispatch; uncertain outcomes are never replayed.",
      resolvedPath: "/api/cache",
      queryParameters: [],
      planDigest: "plan-digest",
    },
  };
  const executor = {
    apply: async () => { applyCalls += 1; return { status: "applied" as const }; },
    getCredentialBinding: () => ({
      profileId: "omniroute",
      endpoint: "http://127.0.0.1:20128",
      epoch: 1,
      credentialKind: "apiKey",
      authority: "server-enforced",
      enabled: true,
    }),
    getPlan: (planId: string) => planId === cancelledPlan.planId ? cancelledPlan : undefined,
    logout: () => undefined,
    disable: () => undefined,
  };
  const handler = createAdminCommandHandler({ executor: executor as never, endpoint: "http://127.0.0.1:20128" });
  const context = {
    hasUI: true,
    ui: {
      custom: async () => undefined,
      confirm: async () => true,
      notify: () => undefined,
    },
  };
  await handler("apply p-missing", context as never);
  expect(applyCalls).toBe(0);
});

test("browse executes only ordinary reads and displays the executor-projected response", async () => {
  const contract = await Bun.file(new URL("../contracts/operations.json", import.meta.url)).json() as { operations: OperationDescriptor[] };
  const source = contract.operations.find(operation => operation.operationId === "GET /api/health");
  if (!source) throw new Error("read fixture source is missing");
  const descriptor: OperationDescriptor = {
    ...source,
    operationId: "GET /fixture/admin-ui-read",
    method: "GET",
    pathTemplate: "/fixture/admin-ui-read",
    auth: {
      ...source.auth,
      domain: "public",
      sourcePolicy: { status: "qualified", source: "omniroute-v3.8.52", routeClass: "public", alternatives: [{ kind: "anonymous" }] },
    },
    request: { ...source.request, body: null },
    response: { ...source.response, schema: {
      type: "object", properties: { status: { type: "string" } }, required: ["status"], additionalProperties: false,
    } },
    sideEffect: "read",
    confirmation: { required: false, reason: "Synthetic ordinary read." },
    coverage: { status: "invokable", adapterId: "typed.fixture.admin.ui.read", reason: null },
    reconciliation: null,
  };
  const registry = fixtureRegistry([descriptor]);
  let dispatchCalls = 0;
  const executor = createAdminExecutor({
    registry,
    dispatch: async () => {
      dispatchCalls += 1;
      return { status: "ready", apiKey: "withheld by response projection" };
    },
  });
  executor.setAdminBinding({ profileId: "omniroute", endpoint: "http://127.0.0.1:20128" });
  const answers = [descriptor.operationId, "{}"];
  const notifications: string[] = [];
  let confirmations = 0;
  const handler = createAdminCommandHandler({
    executor,
    registry,
    endpoint: "http://127.0.0.1:20128",
  });

  await handler(descriptor.operationId, {
    hasUI: true,
    ui: {
      custom: async () => answers.shift(),
      confirm: async () => { confirmations += 1; return true; },
      notify: (message: string) => notifications.push(message),
    },
  } as never);

  expect(dispatchCalls).toBe(1);
  expect(confirmations).toBe(0);
  expect(notifications.at(-1)).toContain(`read result for ${descriptor.operationId}`);
  expect(notifications.at(-1)).toContain('"status": "ready"');
  expect(notifications.at(-1)).not.toContain("withheld by response projection");
  expect(notifications.at(-1)).not.toContain("apiKey");
});

test("protected export refuses an existing destination", async () => {
  const path = `/tmp/cruxomni-omp-client-admin-ui-${process.pid}`;
  await Bun.write(path, "existing");
  await expect(writeProtectedFile(path, new Uint8Array([1]))).rejects.toThrow();
  await unlink(path);
});

test("fresh enablement confirms the exact endpoint before persisting or binding", async () => {
  let enabledEndpoint: string | undefined;
  let confirms = 0;
  const executor = { getCredentialBinding: () => undefined, logout: () => undefined, disable: () => undefined };
  const handler = createAdminCommandHandler({
    executor: executor as never,
    resolveEffectiveEndpoint: async () => undefined,
    onEnable: async endpoint => {
      enabledEndpoint = endpoint;
      return { endpoint };
    },
  });
  const context = {
    hasUI: true,
    ui: {
      custom: async () => "http://127.0.0.1:20128",
      confirm: async (_title: string, detail: string) => {
        confirms += 1;
        expect(detail).toContain("http://127.0.0.1:20128");
        return true;
      },
      notify: () => undefined,
    },
  };
  await handler("enable", context as never);
  expect(confirms).toBe(1);
  expect(enabledEndpoint).toBe("http://127.0.0.1:20128");
});

test("multipart dispatch turns dedicated file entries into blobs, never path fields", async () => {
  const path = `/tmp/cruxomni-omp-client-admin-multipart-${process.pid}`;
  await Bun.write(path, "payload");
  const originalFetch = globalThis.fetch;
  let form: FormData | undefined;
  try {
    const mockFetch: typeof fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        form = init?.body as FormData;
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } });
      },
      { preconnect: originalFetch.preconnect },
    );
    globalThis.fetch = mockFetch;
    await invokeMultipartAdapter({
      descriptor: { ...jsonDescriptor, mediaType: { request: "multipart/form-data", response: "application/json" } },
      endpoint: "http://127.0.0.1:20128",
      resolvedPath: jsonDescriptor.pathTemplate,
      queryParameters: [],
      body: { files: [{ field: "archive", path }], fields: { note: "hello" } },
    }, [{ field: "archive", path }], { note: "hello" });
    expect(form?.get("note")).toBe("hello");
    expect(form?.get("archive")).toBeInstanceOf(Blob);
    expect(form?.get("path")).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    await unlink(path);
  }
});

test("local schema refs constrain validation and projection while external refs fail closed", () => {
  const descriptor = getOperation("GET /api/agent-skills/coverage");
  if (!descriptor) throw new Error("reference descriptor missing");
  const local: OperationDescriptor = {
    ...descriptor,
    auth: {
      ...descriptor.auth,
      domain: "public",
      sourcePolicy: { status: "qualified", source: "omniroute-v3.8.52", routeClass: "public", alternatives: [{ kind: "anonymous" }] },
    },
    sideEffect: "read",
    coverage: { status: "invokable", adapterId: "fixture.local-refs", reason: null },
    request: { ...descriptor.request, pathSchema: { $ref: "#/$defs/methodCounts" } },
    response: { ...descriptor.response, schema: { $ref: "#/$defs/contentVariant" } },
  };
  const registry = fixtureRegistry([local]);
  expect(() => registry.validateOperation(local.operationId, {})).toThrow();
  expect(registry.project(local.operationId, {
    mediaType: "application/json", schema: { type: "string" }, unknown: "withheld",
  })).toEqual({ mediaType: "application/json", schema: { type: "string" } });
  expect(() => projectResponse({ ...descriptor, response: { ...descriptor.response, schema: { $ref: "https://example.invalid/schema" } } }, {})).toThrow();
});

test("stalled response bodies are cancelled by the combined deadline", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = ADMIN_ADAPTER_LIMITS.timeoutMs;
  let cancelled = false;
  (ADMIN_ADAPTER_LIMITS as unknown as { timeoutMs: number }).timeoutMs = 10;
  try {
    const mockFetch: typeof fetch = Object.assign(
      async (_input: Parameters<typeof fetch>[0]) => new Response(new ReadableStream<Uint8Array>({
        start() { /* intentionally leaves the reader pending */ },
        cancel() { cancelled = true; },
      }), { status: 200, headers: { "content-type": "application/json" } }),
      { preconnect: originalFetch.preconnect },
    );
    globalThis.fetch = mockFetch;
    await expect(invokeJsonAdapter({ descriptor: jsonDescriptor, endpoint: "http://127.0.0.1:20128", resolvedPath: "/api/models", queryParameters: [] })).rejects.toMatchObject({ code: "timeout" });
    expect(cancelled).toBe(true);
  } finally {
    globalThis.fetch = originalFetch;
    (ADMIN_ADAPTER_LIMITS as unknown as { timeoutMs: number }).timeoutMs = originalTimeout;
  }
});
