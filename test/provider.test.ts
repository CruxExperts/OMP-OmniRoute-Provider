import { expect, test } from "bun:test";
import { CatalogError, projectCatalog, type CatalogProjection } from "../src/catalog.ts";
import { DiscoveryManager } from "../src/health.ts";

test("runtime identities are exact and endpoint modalities stay truthful", () => {
	const projection = projectCatalog({ data: [
		{ id: "responses", owned_by: "openai", supported_endpoints: ["chat", "responses"], capabilities: { reasoning: true } },
		{ id: "chat", owned_by: "openai", supported_endpoints: ["chat"] },
		{ id: "images", owned_by: "openai", supported_endpoints: ["images"] },
		{ id: "default" },
	] });
	expect(projection.models.map(model => [model.id, model.api])).toEqual([
		["responses", "openai-responses"],
		["chat", "openai-completions"],
		["default", "openai-responses"],
	]);
	expect(projection.diagnostics.map(item => item.code)).toContain("specialty_only_route");
	expect(projection.diagnostics.map(item => item.code)).toContain("endpoint_unverified_default");
});

test("duplicate identity conflicts fail while property-order duplicates deduplicate", () => {
	const same = projectCatalog({ data: [{ id: "same", owned_by: "a" }, { owned_by: "a", id: "same" }] });
	expect(same.models.map(model => model.id)).toEqual(["same"]);
	expect(() => projectCatalog({ data: [{ id: "same", owned_by: "a" }, { id: "same", owned_by: "b" }] })).toThrow(CatalogError);
	expect(() => projectCatalog({ data: null })).toThrow("invalid_live_data");
});

test("catalog metadata enriches only exact owner and id", () => {
	const projection = projectCatalog(
		{ data: [{ id: "model", owned_by: "owner", context_length: -1 }] },
		{ metadata: { catalog: { owner: { models: [{ id: "model", context_length: 64000, max_output_tokens: 2000 }] }, other: { models: [{ id: "model", context_length: 1 }] } } } },
	);
	expect(projection.models[0]?.contextWindow).toBe(64000);
	expect(projection.models[0]?.maxTokens).toBe(2000);
});

test("discovery is single-flight and retains same-generation rows", async () => {
	let calls = 0;
	let fail = false;
	const signals: AbortSignal[] = [];
	const manager = new DiscoveryManager(async (_binding, signal) => {
		calls++;
		signals.push(signal);
		if (signal.aborted) throw Object.assign(new Error("aborted"), { code: "aborted" });
		if (fail) throw Object.assign(new Error("offline"), { code: "timeout" });
		return { projection: projectCatalog({ data: [{ id: "live" }] }) };
	});
	manager.setBinding("https://one.example", "key", 1);
	const [first, second] = await Promise.all([manager.refresh(), manager.refresh()]);
	expect(first).toBe(second);
	expect(calls).toBe(1);
	fail = true;
	const stale = await manager.refresh({ force: true });
	expect(stale?.stale).toBe(true);
	const callsAfterStale = calls;
	await manager.refresh();
	expect(calls).toBe(callsAfterStale + 1);
	expect(signals.every(signal => signal === signals[0])).toBe(true);
	expect(stale?.projection.models[0]?.id).toBe("live");
	manager.setBinding("https://two.example", "other", 2);
	expect(signals[0]?.aborted).toBe(true);
	expect(manager.currentResult).toBeUndefined();
	expect(manager.getModelApi("live")).toBeUndefined();
	expect(manager.status.modelCount).toBe(0);
});

test("late discovery from an old endpoint generation is discarded", async () => {
	const oldWait = Promise.withResolvers<void>();
	let oldSignal: AbortSignal | undefined;
	const manager = new DiscoveryManager(async (binding, signal) => {
		if (binding.endpoint.includes("one")) {
			oldSignal = signal;
			await oldWait.promise;
			return { projection: projectCatalog({ data: [{ id: "old" }] }) };
		}
		return { projection: projectCatalog({ data: [{ id: "new" }] }) };
	});
	expect(manager.setBinding("https://one.example", "old-key", 1)).toBe(true);
	const old = manager.refresh();
	expect(manager.setBinding("https://two.example", "new-key", 2)).toBe(true);
	expect(oldSignal?.aborted).toBe(true);
	oldWait.resolve();
	expect(await old).toBeUndefined();
	const fresh = await manager.refresh();
	expect(fresh?.projection.models[0]?.id).toBe("new");
});

test("automatic discovery reuses the successful snapshot while forced callers join one flight", async () => {
	let calls = 0;
	const forcedFlight = Promise.withResolvers<{ projection: CatalogProjection }>();
	const manager = new DiscoveryManager(async () => {
		calls++;
		if (calls === 2) return forcedFlight.promise;
		return { projection: projectCatalog({ data: [{ id: `live-${calls}` }] }) };
	});
	manager.setBinding("https://one.example", "key", 900);
	const first = await manager.refresh();
	expect(await manager.refresh()).toBe(first);
	expect(calls).toBe(1);

	const forced = manager.refresh({ force: true });
	const joined = manager.refresh({ force: true });
	expect(calls).toBe(2);
	forcedFlight.resolve({ projection: projectCatalog({ data: [{ id: "forced" }] }) });
	const [forcedResult, joinedResult] = await Promise.all([forced, joined]);
	expect(forcedResult).toBe(joinedResult);
	expect(manager.status.stale).toBe(false);
});

test("source generations are compared independently from manager epochs", () => {
	const manager = new DiscoveryManager(async () => ({ projection: projectCatalog({ data: [] }) }));
	expect(manager.setBinding("https://one.example", "key", 900)).toBe(true);
	expect(manager.currentBinding?.generation).not.toBe(900);
	expect(manager.setBinding("https://one.example", "key", 900)).toBe(false);
	expect(manager.setBinding("https://one.example", "key", 901)).toBe(true);
});

test("binding reports checking until delayed discovery succeeds, with separate live and chat counts", async () => {
	const delayed = Promise.withResolvers<{ projection: CatalogProjection }>();
	const states: Array<{ state: string; raw: number; chat: number }> = [];
	const manager = new DiscoveryManager(async () => delayed.promise, [snapshot => {
		states.push({ state: snapshot.state, raw: snapshot.rawModelCount, chat: snapshot.modelCount });
	}]);
	manager.setBinding("https://gateway.example", "key", 1);
	const flight = manager.refresh();
	expect(manager.status.state).toBe("checking");
	expect(states).toEqual([{ state: "checking", raw: 0, chat: 0 }]);
	delayed.resolve({ projection: projectCatalog({ data: [
		{ id: "chat", supported_endpoints: ["chat"] },
		{ id: "image", supported_endpoints: ["images"] },
	] }) });
	await flight;
	expect(manager.status).toMatchObject({ state: "ready", modelCount: 1, rawModelCount: 2 });
	expect(states.map(value => value.state)).toEqual(["checking", "ready"]);
});

test("unauthorized discovery clears runnable authority while valid empty catalogs remain successful", async () => {
	let unauthorizedStatus = 401;
	let unauthorized = false;
	let empty = false;
	const manager = new DiscoveryManager(async () => {
		if (unauthorized) throw Object.assign(new Error("unauthorized"), { status: unauthorizedStatus });
		return { projection: projectCatalog({ data: empty ? [] : [{ id: "live" }] }) };
	});
	manager.setBinding("https://one.example", "key", 4);
	await manager.refresh();
	expect(manager.getModelApi("live")).toBe("openai-responses");
	empty = true;
	await manager.refresh({ force: true });
	expect(manager.status.state).toBe("no-models");
	expect(manager.currentResult?.projection.models).toEqual([]);
	expect(manager.getModelApi("live")).toBeUndefined();
	empty = false;
	await manager.refresh({ force: true });
	unauthorized = true;
	await expect(manager.refresh({ force: true })).rejects.toMatchObject({ status: 401 });
	expect(manager.status.state).toBe("unauthorized");
	expect(manager.status.modelCount).toBe(0);
	expect(manager.currentResult).toBeUndefined();
	expect(manager.getModelApi("live")).toBeUndefined();
	unauthorizedStatus = 403;
	await expect(manager.refresh({ force: true })).rejects.toMatchObject({ status: 403 });
	expect(manager.status.state).toBe("unauthorized");
});

test("malformed-only live catalogs are rejected instead of treated as empty", () => {
	expect(() => projectCatalog({ data: [null, {}, { id: "" }] })).toThrow("invalid_live_data");
	const mixed = projectCatalog({ data: [null, { id: "live" }] });
	expect(mixed.models.map(model => model.id)).toEqual(["live"]);
	expect(mixed.diagnostics).toContainEqual({ code: "malformed_rows", detail: "1" });
});

test("transient 5xx failures retain stale rows but permanent discovery errors clear runnable authority", async () => {
	let failure: "server" | "malformed" | "client" | "duplicate" | undefined;
	const manager = new DiscoveryManager(async () => {
		if (failure === "server") throw Object.assign(new Error("server unavailable"), { status: 503 });
		if (failure === "malformed") return { projection: projectCatalog({ data: [null] }) };
		if (failure === "client") throw Object.assign(new Error("invalid request"), { status: 422 });
		if (failure === "duplicate") {
			return { projection: projectCatalog({ data: [{ id: "duplicate" }, { id: "duplicate", name: "conflict" }] }) };
		}
		return { projection: projectCatalog({ data: [{ id: "live" }] }) };
	});
	manager.setBinding("https://one.example", "key", 6);
	await manager.refresh();
	failure = "server";
	const stale = await manager.refresh({ force: true });
	expect(stale?.stale).toBe(true);
	expect(manager.status.state).toBe("offline");
	expect(manager.getModelApi("live")).toBe("openai-responses");
	failure = "malformed";
	await expect(manager.refresh({ force: true })).rejects.toMatchObject({ code: "invalid_live_data" });
	expect(manager.status.state).toBe("degraded");
	expect(manager.status.stale).toBe(false);
	expect(manager.currentResult).toBeUndefined();
	expect(manager.getModelApi("live")).toBeUndefined();

	failure = undefined;
	await manager.refresh({ force: true });
	failure = "client";
	await expect(manager.refresh({ force: true })).rejects.toMatchObject({ status: 422 });
	expect(manager.status.state).toBe("degraded");
	expect(manager.currentResult).toBeUndefined();
	expect(manager.getModelApi("live")).toBeUndefined();

	failure = undefined;
	await manager.refresh({ force: true });
	failure = "duplicate";
	await expect(manager.refresh({ force: true })).rejects.toMatchObject({ code: "duplicate_identity_conflict" });
	expect(manager.status.state).toBe("degraded");
	expect(manager.currentResult).toBeUndefined();
	expect(manager.getModelApi("live")).toBeUndefined();

});

test("late enrichment cannot replace a newer live projection from the same generation", async () => {
	const enrichmentFlight = Promise.withResolvers<CatalogProjection>();
	const enrichment = enrichmentFlight.promise;
	let calls = 0;
	const manager = new DiscoveryManager(async () => {
		calls++;
		if (calls === 1) return { projection: projectCatalog({ data: [{ id: "first" }] }), enrichment };
		return { projection: projectCatalog({ data: [{ id: "latest" }] }) };
	});
	manager.setBinding("https://one.example", "key", 7);
	await manager.refresh();
	const latest = await manager.refresh({ force: true });
	enrichmentFlight.resolve(projectCatalog({ data: [{ id: "enriched-old" }] }));
	await Promise.resolve();
	expect(manager.currentResult).toBe(latest);
	expect(manager.getModelApi("first")).toBeUndefined();
	expect(manager.getModelApi("enriched-old")).toBeUndefined();
	expect(manager.getModelApi("latest")).toBe("openai-responses");
});

test("optional enrichment failures stay diagnostic and do not mark live discovery offline", async () => {
	const enrichmentFlight = Promise.withResolvers<CatalogProjection>();
	const enrichment = enrichmentFlight.promise;
	const manager = new DiscoveryManager(async () => ({ projection: projectCatalog({ data: [{ id: "live" }] }), enrichment }));
	manager.setBinding("https://one.example", "key", 8);
	await manager.refresh();
	enrichmentFlight.reject(new Error("private upstream detail"));
	await Promise.resolve();
	expect(manager.status.state).toBe("ready");
	expect(manager.status.stale).toBe(false);
	expect(manager.currentResult?.projection.diagnostics).toContainEqual({ code: "optional_enrichment_failed" });
	expect(manager.currentResult?.projection.diagnostics.some(item => item.detail?.includes("private"))).toBe(false);
});

test("snapshot listeners observe same-health model authority changes", async () => {
	let notifications = 0;
	let calls = 0;
	const manager = new DiscoveryManager(async () => {
		calls++;
		return { projection: projectCatalog({ data: [{ id: `model-${calls}` }] }) };
	}, [() => { notifications++; }]);
	manager.setBinding("https://one.example", "key", 9);
	await manager.refresh();
	const before = notifications;
	await manager.refresh({ force: true });
	expect(manager.status.state).toBe("ready");
	expect(notifications).toBeGreaterThan(before);
	expect(manager.currentResult?.projection.models[0]?.id).toBe("model-2");
});

test("reset aborts the active generation and clears current authority immediately", async () => {
	const delayed = Promise.withResolvers<CatalogProjection>();
	let signal: AbortSignal | undefined;
	const manager = new DiscoveryManager(async (_binding, currentSignal) => {
		signal = currentSignal;
		return { projection: await delayed.promise };
	});
	manager.setBinding("https://one.example", "key", 11);
	const pending = manager.refresh();
	manager.reset();
	expect(signal?.aborted).toBe(true);
	expect(manager.currentBinding).toBeUndefined();
	expect(manager.currentResult).toBeUndefined();
	delayed.resolve(projectCatalog({ data: [{ id: "late" }] }));
	expect(await pending).toBeUndefined();
});

test("shutdown aborts active discovery and resume does not restore old model authority", async () => {
	const delayed = Promise.withResolvers<{ projection: CatalogProjection }>();
	let calls = 0;
	let signal: AbortSignal | undefined;
	const manager = new DiscoveryManager(async (_binding, currentSignal) => {
		calls++;
		if (calls === 1) return { projection: projectCatalog({ data: [{ id: "live" }] }) };
		signal = currentSignal;
		return delayed.promise;
	});
	manager.setBinding("https://one.example", "key", 10);
	await manager.refresh();
	const pending = manager.refresh({ force: true });
	manager.shutdown();
	expect(signal?.aborted).toBe(true);
	expect(manager.currentResult).toBeUndefined();
	expect(manager.getModelApi("live")).toBeUndefined();
	delayed.resolve({ projection: projectCatalog({ data: [{ id: "late" }] }) });
	expect(await pending).toBeUndefined();
	manager.resume();
	expect(await manager.refresh()).toBeUndefined();
});
