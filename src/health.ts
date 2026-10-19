import type { CatalogProjection, EndpointApi } from "./catalog.ts";

export type HealthState = "unconfigured" | "ready" | "degraded" | "offline" | "unauthorized";

export interface DiscoveryBinding {
	readonly endpoint: string;
	readonly credential: string;
	readonly generation: number;
}

export interface HealthSnapshot {
	state: HealthState;
	generation: number;
	modelCount: number;
	stale: boolean;
	lastError?: string;
}

export interface DiscoveryResult {
	projection: CatalogProjection;
	stale?: boolean;
	enrichment?: Promise<CatalogProjection>;
}

export type DiscoverFn = (binding: DiscoveryBinding, signal: AbortSignal) => Promise<DiscoveryResult>;
export type HealthListener = (snapshot: HealthSnapshot) => void;

export interface RefreshOptions {
	force?: boolean;
}

interface ClassifiedError {
	state: Exclude<HealthState, "unconfigured" | "ready">;
	code: string;
}

function errorCode(error: unknown): string {
	if (error && typeof error === "object") {
		const value = error as { code?: unknown; status?: unknown };
		if (typeof value.code === "string" && /^[a-z][a-z0-9_-]*$/.test(value.code)) return value.code;
		if (typeof value.status === "number" && Number.isInteger(value.status)) return `http_${value.status}`;
	}
	return "request_failed";
}

function classify(error: unknown): ClassifiedError {
	const code = errorCode(error);
	const status = error && typeof error === "object" && typeof (error as { status?: unknown }).status === "number"
		? (error as { status: number }).status : undefined;
	if (status === 401 || status === 403 || code === "http_401" || code === "http_403" || code === "unauthorized") return { state: "unauthorized", code };
	if ((status !== undefined && status >= 500 && status < 600) || [408, 429].includes(status ?? -1) || /^http_5\d\d$/.test(code) || ["request_timeout", "network_error", "connection_refused", "offline", "http_408", "http_429", "timeout", "network", "body-read", "budget-exhausted"].includes(code)) return { state: "offline", code };
	return { state: "degraded", code };
}
function staleProjection(projection: CatalogProjection): CatalogProjection {
	const models = projection.models.map(model =>
		model.name.endsWith(" (stale)") ? model : { ...model, name: `${model.name} (stale)` },
	);
	return { ...projection, models };
}


/**
 * Owns generation cancellation and the only model-discovery single-flight.
 * It deliberately stores successful rows in memory only; a new manager starts
 * without a selectable offline catalog.
 */
export class DiscoveryManager {
	private binding: DiscoveryBinding | undefined;
	private sourceGeneration: number | undefined;
	private generation = 0;
	private stopped = false;
	private flight: Promise<DiscoveryResult | undefined> | undefined;
	private generationController: AbortController | undefined;
	private lastGood: DiscoveryResult | undefined;
	private current: DiscoveryResult | undefined;
	private readonly modelApis = new Map<string, EndpointApi>();
	private lastSuccessAt: number | undefined;
	private snapshot: HealthSnapshot = { state: "unconfigured", generation: 0, modelCount: 0, stale: false };
	private readonly listeners = new Set<HealthListener>();

	constructor(private readonly discover: DiscoverFn, listeners?: Iterable<HealthListener>) {
		if (listeners) for (const listener of listeners) this.listeners.add(listener);
	}

	addListener(listener: HealthListener): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	get status(): HealthSnapshot {
		return { ...this.snapshot };
	}

	get currentBinding(): DiscoveryBinding | undefined {
		return this.binding;
	}

	get currentResult(): DiscoveryResult | undefined {
		return this.current;
	}

	get bindingSignal(): AbortSignal | undefined {
		return this.generationController?.signal;
	}

	getModelApi(id: string): EndpointApi | undefined {
		return this.modelApis.get(id);
	}

	/**
	 * Replace the endpoint/auth source generation. The return value reports a
	 * real source-binding invalidation, not a comparison with our private epoch.
	 */
	setBinding(endpoint: string | undefined, credential: string | undefined, generation?: number): boolean {
		const normalizedEndpoint = endpoint?.trim();
		const normalizedCredential = credential?.trim();
		const changed = normalizedEndpoint !== this.binding?.endpoint || normalizedCredential !== this.binding?.credential;
		const sourceGenerationChanged = generation !== this.sourceGeneration;
		if (!changed && !sourceGenerationChanged) return false;

		this.invalidateGeneration();
		this.sourceGeneration = generation;
		this.generation++;
		this.lastGood = undefined;
		this.setCurrentResult(undefined);
		this.lastSuccessAt = undefined;

		if (!normalizedEndpoint || !normalizedCredential) {
			this.binding = undefined;
			this.setSnapshot({ state: "unconfigured", generation: this.generation, modelCount: 0, stale: false }, true);
			return true;
		}

		this.binding = Object.freeze({ endpoint: normalizedEndpoint, credential: normalizedCredential, generation: this.generation });
		if (!this.stopped) this.generationController = new AbortController();
		this.setSnapshot({ state: "degraded", generation: this.generation, modelCount: 0, stale: false }, true);
		return true;
	}

	/** Clear the binding and all source-owned rows on reset/reconfiguration. */
	reset(): void {
		this.invalidateGeneration();
		this.sourceGeneration = undefined;
		this.binding = undefined;
		this.lastGood = undefined;
		this.setCurrentResult(undefined);
		this.lastSuccessAt = undefined;
		this.generation++;
		this.setSnapshot({ state: "unconfigured", generation: this.generation, modelCount: 0, stale: false }, true);
	}

	async refresh(options: RefreshOptions = {}): Promise<DiscoveryResult | undefined> {
		if (this.stopped) return undefined;
		if (this.flight) return this.flight;
		const binding = this.binding;
		const generation = this.generation;
		const signal = this.generationController?.signal;
		if (!binding || !signal || signal.aborted) {
			this.setSnapshot({ state: "unconfigured", generation, modelCount: 0, stale: false });
			return undefined;
		}

		if (
			!options.force &&
			this.current &&
			!this.current.stale &&
			this.lastSuccessAt !== undefined &&
			Date.now() - this.lastSuccessAt < 30_000
		) return this.current;

		let discovery: Promise<DiscoveryResult>;
		try {
			discovery = this.discover(binding, signal);
		} catch (error) {
			discovery = Promise.reject(error);
		}
		const request = discovery.then(result => {
			if (!this.isCurrentGeneration(generation, binding, signal)) return undefined;
			const accepted: DiscoveryResult = { ...result, stale: false };
			this.setCurrentResult(accepted);
			this.lastGood = accepted;
			this.lastSuccessAt = Date.now();
			this.setSnapshot({ state: "ready", generation, modelCount: accepted.projection.models.length, stale: false }, true);
			if (accepted.enrichment) this.trackEnrichment(generation, binding, signal, accepted.projection, accepted.enrichment);
			return accepted;
		}).catch(error => {
			if (!this.isCurrentGeneration(generation, binding, signal)) return undefined;
			const failure = classify(error);
			if (failure.state === "unauthorized") {
				this.setCurrentResult(undefined);
				this.lastGood = undefined;
				this.lastSuccessAt = undefined;
				this.setSnapshot({ state: "unauthorized", generation, modelCount: 0, stale: false, lastError: failure.code }, true);
				throw error;
			}

			if (failure.state === "offline" && this.lastGood) {
				const retained: DiscoveryResult = { ...this.lastGood, projection: staleProjection(this.lastGood.projection), stale: true };
				this.setCurrentResult(retained);
				this.setSnapshot({ state: failure.state, generation, modelCount: retained.projection.models.length, stale: true, lastError: failure.code }, true);
				return retained;
			}

			this.setCurrentResult(undefined);
			this.lastGood = undefined;
			this.lastSuccessAt = undefined;
			this.setSnapshot({ state: failure.state, generation, modelCount: 0, stale: false, lastError: failure.code }, true);
			throw error;
		}).finally(() => {
			if (this.flight === request) this.flight = undefined;
		});
		this.flight = request;
		return request;
	}

	shutdown(): void {
		if (this.stopped && !this.binding && !this.current && !this.flight) return;
		this.stopped = true;
		this.invalidateGeneration();
		this.sourceGeneration = undefined;
		this.binding = undefined;
		this.lastGood = undefined;
		this.setCurrentResult(undefined);
		this.lastSuccessAt = undefined;
		this.generation++;
		this.setSnapshot({ state: "unconfigured", generation: this.generation, modelCount: 0, stale: false }, true);
	}

	resume(): void {
		if (!this.stopped) return;
		this.stopped = false;
		if (this.binding) this.generationController = new AbortController();
	}

	private invalidateGeneration(): void {
		this.generationController?.abort();
		this.generationController = undefined;
		this.flight = undefined;
	}

	private setCurrentResult(result: DiscoveryResult | undefined): void {
		this.current = result;
		this.modelApis.clear();
		if (!result) return;
		for (const model of result.projection.models) {
			const api = model.api === "openai-responses" ? "openai-responses"
				: model.api === "openai-completions" ? "openai-completions" : undefined;
			if (api) this.modelApis.set(model.id, api);
		}
	}

	private isCurrentGeneration(generation: number, binding: DiscoveryBinding, signal: AbortSignal): boolean {
		const current = this.binding;
		return !this.stopped &&
			!signal.aborted &&
			generation === this.generation &&
			current !== undefined &&
			current.generation === generation &&
			current.endpoint === binding.endpoint &&
			current.credential === binding.credential;
	}

	private trackEnrichment(
		generation: number,
		binding: DiscoveryBinding,
		signal: AbortSignal,
		sourceProjection: CatalogProjection,
		enrichment: Promise<CatalogProjection>,
	): void {
		void enrichment.then(projection => {
			const current = this.current;
			if (
				!this.isCurrentGeneration(generation, binding, signal) ||
				!current ||
				current.projection !== sourceProjection ||
				current.stale
			) return;
			const enriched: DiscoveryResult = { ...current, projection };
			this.setCurrentResult(enriched);
			this.lastGood = enriched;
			this.setSnapshot({ ...this.snapshot, modelCount: projection.models.length }, true);
		}, () => {
			const current = this.current;
			if (
				!this.isCurrentGeneration(generation, binding, signal) ||
				!current ||
				current.projection !== sourceProjection ||
				current.stale
			) return;
			const diagnosticProjection: CatalogProjection = {
				...sourceProjection,
				diagnostics: [...sourceProjection.diagnostics.slice(0, 63), { code: "optional_enrichment_failed" }],
			};
			const diagnosticResult: DiscoveryResult = { ...current, projection: diagnosticProjection };
			this.setCurrentResult(diagnosticResult);
			this.lastGood = diagnosticResult;
			this.setSnapshot({ ...this.snapshot, modelCount: diagnosticProjection.models.length }, true);
		});
	}

	private setSnapshot(snapshot: HealthSnapshot, authorityChanged = false): void {
		const previous = this.snapshot;
		const changed = previous.state !== snapshot.state ||
			previous.generation !== snapshot.generation ||
			previous.modelCount !== snapshot.modelCount ||
			previous.stale !== snapshot.stale ||
			previous.lastError !== snapshot.lastError;
		this.snapshot = snapshot;
		if (!changed && !authorityChanged) return;
		for (const listener of this.listeners) {
			try { listener({ ...snapshot }); } catch { /* diagnostics must not break discovery */ }
		}
	}
}

export { DiscoveryManager as ProviderHealth };

export function createDiscoveryManager(discover: DiscoverFn, listener?: HealthListener): DiscoveryManager {
	return new DiscoveryManager(discover, listener ? [listener] : undefined);
}
