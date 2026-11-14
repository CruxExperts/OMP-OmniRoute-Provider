import { expect, test } from "bun:test";
import { createPinnedHealthFixture } from "./fixtures/pinned-health.fixture.ts";

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
