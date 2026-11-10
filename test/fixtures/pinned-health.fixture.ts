import * as perfHooks from "node:perf_hooks";
import { loadPinnedModule, type PinnedExports } from "./pinned-handler.fixture.ts";

type Lifecycle = PinnedExports & {
  markServerStarting(): void;
  markServerReady(): void;
  markServerStopping(): void;
};
type Probe = PinnedExports & { GET(): Response; HEAD(): Response };

/** Executes receipt-verified upstream handlers and their actual lifecycle and lag modules.
 * This fixture exercises handlers directly; it does not establish Next's ingress policy.
 */
export function createPinnedHealthFixture() {
  const lifecycle = loadPinnedModule("src/lib/serverLifecycle.ts", specifier => {
    throw new Error(`Unexpected lifecycle dependency: ${specifier}`);
  }) as Lifecycle;
  const lag = loadPinnedModule("src/lib/healthzLag.ts", specifier => {
    if (specifier === "node:perf_hooks") return perfHooks;
    throw new Error(`Unexpected health-lag dependency: ${specifier}`);
  });
  const health = loadPinnedModule("src/app/healthz/route.ts", specifier => {
    if (specifier === "@/lib/serverLifecycle") return lifecycle;
    if (specifier === "@/lib/healthzLag") return lag;
    throw new Error(`Unexpected health dependency: ${specifier}`);
  }) as Probe;
  const live = loadPinnedModule("src/app/livez/route.ts", specifier => {
    throw new Error(`Unexpected liveness dependency: ${specifier}`);
  }) as Probe;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
    const path = new URL(request.url).pathname;
    const probe = path === "/healthz" ? health : path === "/livez" ? live : undefined;
    if (!probe || (request.method !== "GET" && request.method !== "HEAD")) return new Response(null, { status: 404 });
    return probe[request.method]();
  } });
  return { lifecycle, endpoint: server.url.origin, stop: () => server.stop(true) };
}
