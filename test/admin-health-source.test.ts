import { expect, test } from "bun:test";
import { createPinnedHealthFixture, LIVEZ_IDS, livezContract } from "./fixtures/pinned-health.fixture.ts";

test("pinned livez exports implement distinct GET and HEAD response contracts without handler authorization", async () => {
  const fixture = createPinnedHealthFixture();
  try {
    expect(fixture.live.dynamic).toBe("force-dynamic");
    for (const id of LIVEZ_IDS) {
      const contract = livezContract(id);
      const method = id === "GET /livez" ? "GET" : "HEAD";
      expect(contract.request.pathParameters).toEqual([]);
      expect(contract.request.parameters).toEqual([]);
      expect(contract.request.body).toBeNull();
      expect(contract.request.pathSchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
      expect(contract.request.querySchema).toEqual({ type: "object", properties: {}, additionalProperties: false });
      expect(contract.auth.sourcePolicy).toEqual({ status: "unknown" });
      expect(contract.sideEffect).toBe("read");
      expect(contract.confirmation.required).toBe(false);
      expect(contract.response.statusCodes).toEqual(["200"]);
      expect(contract.response.mediaType).toBe("text/plain");
      expect(contract.response.schema).toEqual(method === "GET" ? { type: "string", enum: ["ok\n"] } : null);

      expect(contract.streaming).toEqual({ mode: "text", framing: "text/plain" });
      expect(contract.response.variants).toEqual([{ statusCode: "200", content: [{ mediaType: "text/plain", schema: method === "GET" ? { type: "string", enum: ["ok\n"] } : null }], headers: {
        "cache-control": { required: true, schema: { type: "string", enum: ["no-store"] } },
        "content-length": { required: true, schema: { type: "string", enum: ["3"] } },
        "content-type": { required: true, schema: { type: "string", enum: ["text/plain; charset=utf-8"] } },
      } }]);
      // Invoke the source export itself: a transport can suppress a mistakenly populated HEAD body.
      const response = fixture.live[method]();
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-length")).toBe("3");
      if (method === "HEAD") expect(response.body).toBeNull();
      expect(await response.text()).toBe(method === "GET" ? "ok\n" : "");
    }
  } finally {
    fixture.stop();
  }
});

test("receipt-verified probes expose lifecycle status and body independently of method", async () => {
  const lifecycleGlobal = globalThis as typeof globalThis & { __omnirouteServerLifecycle?: "starting" | "ready" | "stopping" };
  const previous = lifecycleGlobal.__omnirouteServerLifecycle;
  const fixture = createPinnedHealthFixture();
  try {
    for (const [phase, setPhase, status, body] of [
      ["starting", fixture.lifecycle.markServerStarting, 503, "starting\n"],
      ["ready", fixture.lifecycle.markServerReady, 200, "ok\n"],
      ["stopping", fixture.lifecycle.markServerStopping, 503, "stopping\n"],
    ] as const) {
      setPhase();
      for (const method of ["GET", "HEAD"] as const) {
        for (const path of ["/healthz", "/livez"] as const) {
          const response = await fetch(`${fixture.endpoint}${path}`, { method });
          const expectedBody = path === "/livez" ? "ok\n" : body;
          expect(response.status).toBe(path === "/livez" ? 200 : status);
          expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8");
          expect(response.headers.get("cache-control")).toBe("no-store");
          expect(response.headers.get("content-length")).toBe(String(expectedBody.length));
          expect(await response.text()).toBe(method === "HEAD" ? "" : expectedBody);
        }
      }
      expect(lifecycleGlobal.__omnirouteServerLifecycle).toBe(phase);
    }
    fixture.lifecycle.markServerReady();
    const stopped = await fetch(`${fixture.endpoint}/healthz`);
    expect(stopped.status).toBe(503);
    expect(await stopped.text()).toBe("stopping\n");
  } finally {
    fixture.stop();
    if (previous === undefined) delete lifecycleGlobal.__omnirouteServerLifecycle;
    else lifecycleGlobal.__omnirouteServerLifecycle = previous;
  }
});
