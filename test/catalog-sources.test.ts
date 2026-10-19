import { afterEach, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { isRecord } from "@oh-my-pi/pi-utils";
import { getCatalogSourceStatus, loadCatalogMetadata } from "../src/catalog-sources.ts";

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
afterEach(() => {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
});

async function fixturePayload(name: string): Promise<unknown> {
  const parsed: unknown = JSON.parse(await readFile(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
  if (!isRecord(parsed) || parsed.synthetic !== true || !isRecord(parsed.payload)) throw new Error("invalid synthetic catalog fixture");
  return parsed.payload;
}

test("public catalog loaders enforce identity, caching, bounded reads, and shared cancellation", async () => {
  const modelsDevPayload = await fixturePayload("models-dev-catalog.json");
  const openRouterPayload = await fixturePayload("openrouter-catalog.json");
  const modelsDevGate = Promise.withResolvers<void>();
  const modelsDevLateGate = Promise.withResolvers<void>();
  const openRouterGate = Promise.withResolvers<void>();
  let now = 10_000;
  Date.now = () => now;
  let modelsDevRequests = 0;
  let openRouterRequests = 0;
  let modelsDevRequestSignal: AbortSignal | null | undefined;
  let openRouterRequestSignal: AbortSignal | null | undefined;
  let depthPayload: unknown = { data: [] };
  for (let index = 0; index < 25; index++) depthPayload = { nested: depthPayload };
  const lateModelsDevPayload = {
    openai: { id: "openai", models: { "late-aborted": { id: "late-aborted", name: "Late response" } } },
  };
  const mockFetch: typeof fetch = Object.assign(
    async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const headers = new Headers(init?.headers);
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("manual");
      expect(headers.has("authorization")).toBe(false);
      expect(headers.has("cookie")).toBe(false);
      if (url.origin === "https://models.dev") {
        modelsDevRequests++;
        expect(url.pathname).toBe("/api.json");
        expect(url.search).toBe("?type=all");
        if (modelsDevRequests === 1) {
          await modelsDevGate.promise;
          return new Response(JSON.stringify(modelsDevPayload), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (modelsDevRequests === 2) {
          modelsDevRequestSignal = init?.signal;
          await modelsDevLateGate.promise;
          return new Response(JSON.stringify(lateModelsDevPayload), { status: 200, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify(modelsDevPayload), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.origin === "https://openrouter.ai") {
        openRouterRequests++;
        expect(url.pathname).toBe("/api/v1/models");
        expect(url.search).toBe("?output_modalities=all");
        if (openRouterRequests === 1) return new Response(JSON.stringify({ data: [null] }), { status: 200, headers: { "content-type": "application/json" } });
        if (openRouterRequests === 2) {
          openRouterRequestSignal = init?.signal;
          await openRouterGate.promise;
          return new Response(JSON.stringify(openRouterPayload), { status: 200, headers: { "content-type": "application/json" } });
        }
        if (openRouterRequests === 3) return new Response("unavailable", { status: 503 });
        if (openRouterRequests === 5) return new Response(null, { status: 302, headers: { location: "https://unexpected.example/" } });
        if (openRouterRequests === 6) {
          return new Response("{}", { status: 200, headers: { "content-type": "application/json", "content-length": String(8 * 1024 * 1024 + 1) } });
        }
        if (openRouterRequests === 7) return new Response(JSON.stringify(depthPayload), { status: 200, headers: { "content-type": "application/json" } });
        return new Response(JSON.stringify(openRouterPayload), { status: 200, headers: { "content-type": "application/json" } });
      }
      throw new Error("unexpected public catalog target");
    },
    { preconnect: originalFetch.preconnect },
  );
  globalThis.fetch = mockFetch;

  const modelsSignal = new AbortController().signal;
  const firstModelsDev = loadCatalogMetadata("models.dev", modelsSignal);
  const joinedModelsDev = loadCatalogMetadata("models.dev", modelsSignal);
  modelsDevGate.resolve();
  const [modelsDev, joined] = await Promise.all([firstModelsDev, joinedModelsDev]);
  expect(modelsDevRequests).toBe(1);
  expect(joined).toBe(modelsDev);
  expect(modelsDev.entries).toContainEqual(expect.objectContaining({
    owner: "openai",
    id: "crux-fixture-chat",
    sourceOwner: "openai",
    sourceId: "crux-fixture-chat",
    context_length: 8192,
    max_output_tokens: 2048,
    input_modalities: ["image", "text"],
    capabilities: { reasoning: true, supportsTools: true, thinking: { mode: "effort", efforts: ["low", "medium", "high"] } },
  }));
  const conservative = modelsDev.entries.find(entry => entry.sourceId === "crux-fixture-conservative");
  expect(conservative?.capabilities).toMatchObject({ reasoning: false, supportsTools: false });
  expect(modelsDev.entries).toContainEqual(expect.objectContaining({
    owner: "openrouter",
    id: "openrouter/fixture-vendor/synthetic-chat",
    sourceOwner: "openrouter",
    sourceId: "fixture-vendor/synthetic-chat",
  }));
  expect(modelsDev.entries.some(entry => entry.id === "unmatched/model")).toBe(false);
  expect(modelsDev.diagnostics).toContainEqual({ code: "unmapped_provider_groups", detail: "1" });
  expect(modelsDev.digest).toMatch(/^[0-9a-f]{64}$/);

  const rejected = await Promise.allSettled([
    loadCatalogMetadata("openrouter", new AbortController().signal),
    loadCatalogMetadata("openrouter", new AbortController().signal),
  ]);
  expect(openRouterRequests).toBe(1);
  for (const result of rejected) {
    expect(result.status).toBe("rejected");
    if (result.status === "rejected") expect(result.reason).toMatchObject({ code: "invalid-catalog" });
  }
  expect(getCatalogSourceStatus("openrouter")).toMatchObject({ state: "unavailable", errorCode: "invalid-catalog" });

  const cancellingCaller = new AbortController();
  const survivingCaller = new AbortController();
  const cancelledRequest = loadCatalogMetadata("openrouter", cancellingCaller.signal);
  const survivingRequest = loadCatalogMetadata("openrouter", survivingCaller.signal);
  expect(openRouterRequests).toBe(2);
  cancellingCaller.abort();
  await expect(cancelledRequest).rejects.toMatchObject({ code: "aborted" });
  expect(openRouterRequestSignal?.aborted).toBe(false);
  openRouterGate.resolve();
  const openRouter = await survivingRequest;
  expect(openRouter.entries[0]).toMatchObject({
    owner: "openrouter",
    id: "openrouter/fixture-vendor/synthetic-chat",
    sourceOwner: "openrouter",
    sourceId: "fixture-vendor/synthetic-chat",
    context_length: 32768,
    max_output_tokens: 4096,
    input_modalities: ["audio", "image", "text"],
    capabilities: { reasoning: true, supportsTools: true, thinking: { mode: "effort", efforts: ["low", "medium", "high"], defaultLevel: "medium" } },
  });
  expect(openRouter.entries[0]).not.toHaveProperty("cost");
  expect(openRouter.entries[0]).not.toHaveProperty("pricing");
  expect(getCatalogSourceStatus("openrouter")).toMatchObject({ state: "usable", fetchedAt: now, expiresAt: now + 24 * 60 * 60 * 1000 });
  expect(await loadCatalogMetadata("openrouter", new AbortController().signal)).toBe(openRouter);
  expect(openRouterRequests).toBe(2);

  now = openRouter.expiresAt;
  await expect(loadCatalogMetadata("openrouter", new AbortController().signal)).rejects.toMatchObject({ code: "http" });
  expect(getCatalogSourceStatus("openrouter")).toMatchObject({ state: "stale", fetchedAt: openRouter.fetchedAt, errorCode: "http" });
  const refreshed = await loadCatalogMetadata("openrouter", new AbortController().signal);
  expect(openRouterRequests).toBe(4);
  expect(refreshed.fetchedAt).toBe(now);
  expect(getCatalogSourceStatus("openrouter").state).toBe("usable");

  now = refreshed.expiresAt;
  await expect(loadCatalogMetadata("openrouter", new AbortController().signal)).rejects.toMatchObject({ code: "redirect" });
  expect(getCatalogSourceStatus("openrouter").state).toBe("stale");
  await expect(loadCatalogMetadata("openrouter", new AbortController().signal)).rejects.toMatchObject({ code: "payload-too-large" });
  await expect(loadCatalogMetadata("openrouter", new AbortController().signal)).rejects.toMatchObject({ code: "depth-limit" });
  expect(openRouterRequests).toBe(7);

  now = modelsDev.expiresAt;
  const abortFirst = new AbortController();
  const abortSecond = new AbortController();
  const abortedFirst = loadCatalogMetadata("models.dev", abortFirst.signal);
  const abortedSecond = loadCatalogMetadata("models.dev", abortSecond.signal);
  expect(modelsDevRequests).toBe(2);
  const aborted = Promise.allSettled([abortedFirst, abortedSecond]);
  abortFirst.abort();
  abortSecond.abort();
  for (const outcome of await aborted) {
    expect(outcome.status).toBe("rejected");
    if (outcome.status === "rejected") expect(outcome.reason).toMatchObject({ code: "aborted" });
  }
  expect(modelsDevRequestSignal?.aborted).toBe(true);
  const retryAfterAbort = loadCatalogMetadata("models.dev", new AbortController().signal);
  modelsDevLateGate.resolve();
  const revalidatedModelsDev = await retryAfterAbort;
  expect(modelsDevRequests).toBe(3);
  expect(revalidatedModelsDev.entries.some(entry => entry.sourceId === "late-aborted")).toBe(false);
  expect(revalidatedModelsDev.digest).toBe(modelsDev.digest);
  expect(getCatalogSourceStatus("models.dev").state).toBe("usable");
});
