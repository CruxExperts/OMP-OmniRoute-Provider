import { expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createBoundInferenceStream, OMNIROUTE_GUARDED_API, parseReconnectSettings } from "../src/inference.ts";

const endpoint = "https://gateway.example";
const model = buildModel({ id: "live", name: "live", api: OMNIROUTE_GUARDED_API, provider: "omniroute", baseUrl: `${endpoint}/v1`, reasoning: false, input: ["text"], contextWindow: 4096, maxTokens: 512, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } });
const context = { messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hello" }], timestamp: 1 }], tools: [] };
const chunk = (delta: object, finish: string | null = null) => `data: ${JSON.stringify({ id: "chatcmpl-1", object: "chat.completion.chunk", created: 1, model: "live", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const success = () => new Response(`${chunk({ content: "recovered" })}${chunk({}, "stop")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
function fixture(fetcher: typeof fetch, settings = { maxAttempts: 5, delayMs: 1 }) {
  let binding = { endpoint, credential: "key", generation: 1 };
  let api: "openai-completions" | undefined = "openai-completions";
  const generation = new AbortController();
  const stream = createBoundInferenceStream({ expectedEndpoint: endpoint, expectedGeneration: 1, currentBinding: () => binding, currentModelApi: () => api, currentSignal: () => generation.signal, stopped: () => false, reconnectSettings: () => settings });
  return { run: (signal?: AbortSignal) => stream(model, context, { fetch: fetcher, ...(signal ? { signal } : {}) }), changeBinding: () => { binding = { ...binding, credential: "rotated" }; }, changeModel: () => { api = undefined; }, generation };
}
function fetchMock(fn: (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => Promise<Response>): typeof fetch {
  return Object.assign(fn, { preconnect: globalThis.fetch.preconnect });
}

test("reconnect settings enforce independent safe defaults and bounds", () => {
  expect(parseReconnectSettings({})).toEqual({ maxAttempts: 5, delayMs: 30000 });
  expect(parseReconnectSettings({ reconnectMaxAttempts: 1, reconnectDelayMs: 300000 })).toEqual({ maxAttempts: 1, delayMs: 300000 });
  expect(parseReconnectSettings({ reconnectMaxAttempts: 21, reconnectDelayMs: 0 })).toEqual({ maxAttempts: 5, delayMs: 30000 });
  expect(parseReconnectSettings({ reconnectMaxAttempts: "5", reconnectDelayMs: 1.5 })).toEqual({ maxAttempts: 5, delayMs: 30000 });
});

test("transient failures retry with fresh requests and bounded exhaustion", async () => {
  const signals: AbortSignal[] = [];
  const fetcher = fetchMock(async (_input, init) => {
    signals.push(init!.signal!);
    if (signals.length < 3) throw new Error("ECONNREFUSED");
    return success();
  });
  const result = await fixture(fetcher).run().result();
  expect(result.stopReason).toBe("stop");
  expect(result.content).toContainEqual({ type: "text", text: "recovered" });
  expect(signals.length).toBe(3);
  expect(new Set(signals).size).toBe(3);
  let calls = 0;
  const exhausted = await fixture(fetchMock(async () => { calls++; return new Response("unavailable", { status: 503 }); }), { maxAttempts: 3, delayMs: 1 }).run().result();
  expect(calls).toBe(3);
  expect(exhausted.stopReason).toBe("error");
  expect(exhausted.errorMessage).toContain("attempts exhausted (3)");
});

test("permanent failures and cancellation do not retry", async () => {
  let calls = 0;
  const permanent = await fixture(fetchMock(async () => { calls++; return new Response("unauthorized", { status: 401 }); })).run().result();
  expect(permanent.stopReason).toBe("error");
  expect(calls).toBe(1);
  const first = Promise.withResolvers<void>();
  const controller = new AbortController();
  calls = 0;
  const pending = fixture(fetchMock(async () => { calls++; first.resolve(); throw new Error("ECONNRESET"); }), { maxAttempts: 5, delayMs: 30000 }).run(controller.signal).result();
  await first.promise;
  controller.abort();
  expect((await pending).stopReason).toBe("aborted");
  expect(calls).toBe(1);
});

test("partial text and completed tool calls from a failed attempt never escape", async () => {
  let calls = 0;
  const fetcher = fetchMock(async () => {
    if (++calls > 1) return success();
    const encoder = new TextEncoder();
    let pulled = false;
    return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
      if (pulled) { controller.error(new Error("socket closed")); return; }
      pulled = true;
      controller.enqueue(encoder.encode(chunk({ content: "discard me" }) + chunk({ tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "write", arguments: "{}" } }] })));
    } }), { headers: { "content-type": "text/event-stream" } });
  });
  const events = [];
  const stream = fixture(fetcher).run();
  for await (const event of stream) events.push(event);
  expect(calls).toBe(2);
  expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
  expect(JSON.stringify(events)).not.toContain("discard me");
  expect(JSON.stringify(events)).not.toContain("call-1");
});

test("binding and model drift stop retries", async () => {
  for (const change of ["changeBinding", "changeModel"] as const) {
    const seen = Promise.withResolvers<void>();
    let calls = 0;
    const state = fixture(fetchMock(async () => { calls++; seen.resolve(); throw new Error("ECONNREFUSED"); }), { maxAttempts: 5, delayMs: 10 });
    const pending = state.run().result();
    await seen.promise;
    state[change]();
    expect((await pending).errorMessage).toContain("binding is no longer active");
    expect(calls).toBe(1);
  }
});

test("structured connection errors wait between attempts and publish successful tools once", async () => {
  const started: number[] = [];
  const state = fixture(fetchMock(async () => {
    started.push(performance.now());
    if (started.length === 1) throw Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
    return new Response(`${chunk({ tool_calls: [{ index: 0, id: "successful-call", type: "function", function: { name: "write", arguments: "{}" } }] })}${chunk({}, "tool_calls")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  }), { maxAttempts: 2, delayMs: 20 });
  const events = [];
  for await (const event of state.run()) events.push(event);
  expect(started).toHaveLength(2);
  expect(started[1]! - started[0]!).toBeGreaterThanOrEqual(19);
  expect(events.map(event => event.type)).toEqual(["start", "toolcall_start", "toolcall_delta", "toolcall_end", "done"]);
  const final = events.at(-1);
  expect(final?.type).toBe("done");
  if (final?.type === "done") {
    expect(final.message.stopReason).toBe("toolUse");
    expect(final.message.content.filter(block => block.type === "toolCall")).toEqual([
      expect.objectContaining({ id: "successful-call", name: "write", arguments: {} }),
    ]);
  }
});

test("native fetch reconnects after a loopback listener disappears", async () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => success() });
  const url = server.url.toString();
  await server.stop(true);
  let calls = 0;
  const result = await fixture(fetchMock(async (_input, init) => {
    calls++;
    if (calls === 1) return globalThis.fetch(url, init);
    return success();
  }), { maxAttempts: 2, delayMs: 1 }).run().result();
  expect(calls).toBe(2);
  expect(result.stopReason).toBe("stop");
});

test("truncated SSE response is discarded before a fresh generation", async () => {
  let calls = 0;
  const result = await fixture(fetchMock(async () => ++calls === 1
    ? new Response(chunk({ content: "truncated" }), { headers: { "content-type": "text/event-stream" } })
    : success())).run().result();
  expect(calls).toBe(2);
  expect(result.content).toEqual([{ type: "text", text: "recovered" }]);
});

test("receiving drains independently while the host consumer is paused", async () => {
  const received = Promise.withResolvers<void>();
  const encoder = new TextEncoder();
  let pulls = 0;
  const stream = fixture(fetchMock(async () => new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulls++ < 1000) controller.enqueue(encoder.encode(chunk({ content: `${pulls}: received chunk\n` })));
      else {
        controller.enqueue(encoder.encode(`${chunk({}, "stop")}data: [DONE]\n\n`));
        controller.close();
        received.resolve();
      }
    },
  }), { headers: { "content-type": "text/event-stream" } }))).run();
  // No host iteration while the connector drains and assembles the response.
  await received.promise;
  const events = [];
  for await (const event of stream) events.push(event);
  expect(pulls).toBe(1001);
  expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
  expect((await stream.result()).content).toEqual([{ type: "text", text: Array.from({ length: 1000 }, (_, i) => `${i + 1}: received chunk\n`).join("") }]);
});
