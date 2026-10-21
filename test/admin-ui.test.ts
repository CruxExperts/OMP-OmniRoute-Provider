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

let sourceReadDescriptor: Promise<OperationDescriptor> | undefined;
async function publicReadDescriptor(operationId: string, pathTemplate: string, qualified = true): Promise<OperationDescriptor> {
  sourceReadDescriptor ??= Bun.file(new URL("../contracts/operations.json", import.meta.url)).json().then((document: { operations: OperationDescriptor[] }) => {
    const source = document.operations.find(operation => operation.operationId === "GET /api/health");
    if (!source) throw new Error("read fixture source is missing");
    return source;
  });
  const source = await sourceReadDescriptor;
  return {
    ...source,
    operationId,
    method: "GET",
    pathTemplate,
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
    coverage: qualified
      ? { status: "invokable", adapterId: `typed.fixture.${operationId.toLowerCase().replace(/[^a-z0-9]+/g, ".")}`, reason: null }
      : { status: "unqualified", adapterId: null, reason: "Fixture is intentionally unqualified." },
    reconciliation: null,
  };
}

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

test("apply confirmation renders the observed target and visibility limits with secret fields redacted", async () => {
  const descriptor = getOperation("DELETE /api/combos/metrics");
  if (!descriptor) throw new Error("combo metrics reset descriptor is missing");
  const displayDescriptor = {
    ...descriptor,
    secrets: { ...descriptor.secrets, outputFields: [...descriptor.secrets.outputFields, "providers.connections.lastError"] },
  };
  const registry = fixtureRegistry([displayDescriptor]);
  const plan: AdminPlanHandle = {
    planId: "p-visible-target",
    operationId: descriptor.operationId,
    auth: { domain: "management", profileId: "omniroute", endpoint: "http://127.0.0.1:20128", epoch: 1 },
    targetAuth: { domain: "management", profileId: "omniroute", endpoint: "http://127.0.0.1:20128", epoch: 1 },
    payloadDigest: "payload-digest",
    targetDigest: "target-digest",
    risk: "mutation",
    createdAt: 0,
    expiresAt: Number.MAX_SAFE_INTEGER,
    state: "pending",
    preview: {
      operationId: descriptor.operationId,
      method: "DELETE",
      pathTemplate: descriptor.pathTemplate,
      target: { profileId: "omniroute", endpoint: "http://127.0.0.1:20128" },
      risk: "mutation",
      sideEffect: "mutation",
      confirmationRequired: true,
      authorization: { kind: "server-enforced", message: "The server enforces credential permissions; this preview did not preflight them." },
      payload: { path: {}, query: { combo: "Probe" } },
      projectedTarget: {
        kind: "collection",
        entries: [{ identity: { scope: "selected", comboName: "Probe" }, state: {
          metrics: { totalRequests: 2, accessToken: "fixture-private-token" },
          providers: [{ connections: [{ id: "fixture-connection", lastError: "fixture-private-diagnostic", status: "ready" }] }],
          health: { lastError: "fixture-public-diagnostic" },
        } }],
      },
      visibilityLimits: ["Standalone persisted-skip counters are hidden from this GET."],
      consequence: "Resets the selected combo's visible and hidden counters.",
      resolvedPath: "/api/combos/metrics",
      queryParameters: [],
      planDigest: "plan-digest",
    },
  };
  const messages: string[] = [];
  let applyCalls = 0;
  const executor = {
    apply: async () => { applyCalls += 1; return { status: "unknown" as const, plan }; },
    getCredentialBinding: () => ({ profileId: "omniroute", endpoint: "http://127.0.0.1:20128", epoch: 1, credentialKind: "apiKey", authority: "server-enforced", enabled: true }),
    getPlan: (planId: string) => planId === plan.planId ? plan : undefined,
  };
  const handler = createAdminCommandHandler({ executor: executor as never, registry, endpoint: "http://127.0.0.1:20128" });
  const context = {
    hasUI: true,
    ui: {
      custom: async () => "APPLY",
      confirm: async (_title: string, body: string) => { messages.push(body); return true; },
      notify: (message: string) => { messages.push(message); },
    },
  };
  await handler("apply p-visible-target", context as never);
  const display = messages.join("\n");
  expect(display).toContain("observedTarget");
  expect(display).toContain("visibilityLimits");
  expect(display).toContain("scope");
  expect(display).toContain("[redacted]");
  expect(display).not.toContain("fixture-private-token");
  expect(display).not.toContain("fixture-private-diagnostic");
  expect(display).toContain("fixture-public-diagnostic");
  expect(applyCalls).toBe(1);
});

test("browse executes only ordinary reads and displays the executor-projected response", async () => {
  const descriptor = await publicReadDescriptor("GET /fixture/admin-ui-read", "/fixture/admin-ui-read");
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
  const answers = ["{}"];
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

test("search selects a matching category and operation through the native chooser", async () => {
  const descriptor = await publicReadDescriptor("GET /api/combos/summary", "/api/combos/summary");
  const registry = fixtureRegistry([descriptor]);
  let dispatchCalls = 0;
  const executor = createAdminExecutor({ registry, dispatch: async () => { dispatchCalls += 1; return { status: "ok" }; } });
  executor.setAdminBinding({ profileId: "omniroute", endpoint: "http://127.0.0.1:20128" });
  const chooserCalls: { title: string; options: Array<string | { label: string; description?: string }> }[] = [];
  const customAnswers = ["{}"];
  const handler = createAdminCommandHandler({ executor, registry });

  await handler("/api/combos", {
    hasUI: true,
    ui: {
      select: async (title: string, options: Array<string | { label: string; description?: string }>) => {
        chooserCalls.push({ title, options });
        return typeof options[0] === "string" ? options[0] : options[0]?.label;
      },
      custom: async () => customAnswers.shift(),
      notify: () => undefined,
    },
  } as never);

  expect(chooserCalls).toHaveLength(2);
  expect(chooserCalls[0]?.title).toBe("Administration category");
  expect(chooserCalls[0]?.options.map(option => typeof option === "string" ? option : option.label)).toContain("api/combos");
  expect(chooserCalls[1]?.options.map(option => typeof option === "string" ? option : option.label)).toContain(descriptor.operationId);
  expect(dispatchCalls).toBe(1);
});

test("native operation chooser exposes the complete matching category beyond 40 items", async () => {
  const descriptors = await Promise.all(Array.from({ length: 41 }, (_, index) => {
    const suffix = String(index).padStart(2, "0");
    return publicReadDescriptor(`GET /api/combos/operation-${suffix}`, `/api/combos/operation-${suffix}`);
  }));
  const registry = fixtureRegistry(descriptors);
  let dispatchCalls = 0;
  const executor = createAdminExecutor({ registry, dispatch: async () => { dispatchCalls += 1; return { status: "ok" }; } });
  executor.setAdminBinding({ profileId: "omniroute", endpoint: "http://127.0.0.1:20128" });
  let operationLabels: string[] = [];
  const handler = createAdminCommandHandler({ executor, registry });

  await handler("", {
    hasUI: true,
    ui: {
      select: async (title: string, options: Array<string | { label: string; description?: string }>) => {
        const labels = options.map(option => typeof option === "string" ? option : option.label);
        if (title.startsWith("Operations in ")) {
          operationLabels = labels;
          return labels.at(-1);
        }
        return labels[0];
      },
      custom: async () => "{}",
      notify: () => undefined,
    },
  } as never);

  expect(operationLabels).toHaveLength(41);
  expect(operationLabels.at(-1)).toBe("GET /api/combos/operation-40");
  expect(dispatchCalls).toBe(1);
});

test("search cancellation stops before input collection or dispatch", async () => {
  const descriptor = await publicReadDescriptor("GET /api/combos/summary", "/api/combos/summary");
  const registry = fixtureRegistry([descriptor]);
  let inputPrompts = 0;
  let dispatchCalls = 0;
  const executor = createAdminExecutor({ registry, dispatch: async () => { dispatchCalls += 1; return { status: "ok" }; } });
  const handler = createAdminCommandHandler({ executor, registry });

  await handler("/api/combos", {
    hasUI: true,
    ui: {
      select: async () => undefined,
      custom: async () => { inputPrompts += 1; return "{}"; },
      notify: () => undefined,
    },
  } as never);

  expect(inputPrompts).toBe(0);
  expect(dispatchCalls).toBe(0);
});

test("exact unqualified operation IDs remain blocked without prompting", async () => {
  const descriptor = await publicReadDescriptor("GET /api/combos/unqualified", "/api/combos/unqualified", false);
  const registry = fixtureRegistry([descriptor]);
  let inputPrompts = 0;
  let dispatchCalls = 0;
  const executor = createAdminExecutor({ registry, dispatch: async () => { dispatchCalls += 1; return { status: "ok" }; } });
  const notifications: string[] = [];
  const handler = createAdminCommandHandler({ executor, registry });

  await handler(descriptor.operationId, {
    hasUI: true,
    ui: {
      select: async () => { throw new Error("exact operation ID must not open a chooser"); },
      custom: async () => { inputPrompts += 1; return "{}"; },
      notify: (message: string) => notifications.push(message),
    },
  } as never);

  expect(inputPrompts).toBe(0);
  expect(dispatchCalls).toBe(0);
  expect(notifications.some(message => message.includes("non-invokable"))).toBe(true);
});

test("search rejects control characters before opening a chooser", async () => {
  const descriptor = await publicReadDescriptor("GET /api/combos/summary", "/api/combos/summary");
  const registry = fixtureRegistry([descriptor]);
  let selectorCalls = 0;
  const notifications: string[] = [];
  const handler = createAdminCommandHandler({ executor: createAdminExecutor({ registry, dispatch: async () => ({ status: "ok" }) }), registry });

  await handler("/api/combos\u001b[31m", {
    hasUI: true,
    ui: {
      select: async () => { selectorCalls += 1; return undefined; },
      custom: async () => "{}",
      notify: (message: string) => notifications.push(message),
    },
  } as never);

  expect(selectorCalls).toBe(0);
  expect(notifications.some(message => message.includes("control characters"))).toBe(true);
  expect(notifications.join(" ")).not.toContain("\u001b");
});

test("chooser descriptions render descriptor control characters as visible escapes", async () => {
  const descriptor = await publicReadDescriptor("GET /api/combos/terminal", "/api/combos/\u001b[31m");
  const registry = fixtureRegistry([descriptor]);
  const optionDescriptions: string[] = [];
  const handler = createAdminCommandHandler({ executor: createAdminExecutor({ registry, dispatch: async () => ({ status: "ok" }) }), registry });

  await handler("/api/combos", {
    hasUI: true,
    ui: {
      select: async (title: string, options: Array<string | { label: string; description?: string }>) => {
        if (title !== "Administration category") {
          optionDescriptions.push(...options.flatMap(option => typeof option === "string" || !option.description ? [] : [option.description]));
        }
        return title === "Administration category" ? "api/combos" : undefined;
      },
      custom: async () => { throw new Error("cancelled chooser must not prompt for operation input"); },
      notify: () => undefined,
    },
  } as never);

  expect(optionDescriptions).toHaveLength(1);
  expect(optionDescriptions[0]).toContain("\\u001b");
  expect(optionDescriptions[0]).not.toContain("\u001b");
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
