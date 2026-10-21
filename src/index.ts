import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@oh-my-pi/pi-coding-agent";
import { getPluginSettings } from "@oh-my-pi/pi-coding-agent/extensibility/plugins/loader";
import { DISPLAY_NAME, PACKAGE_NAME, PROVIDER_LIST_NAME } from "./identity.ts";
import { OptionalCredentials } from "./credentials.ts";
import { createSetupWizard } from "./setup.ts";
import { clearPendingCandidate, registerNativeLogin, recoverPendingAfterPersistence, resolveRuntimeCredential, resolveStartupRuntimeCredential } from "./auth.ts";
import { allowsEnvironmentOptionalCredentials, type PluginConfig, loadConfig, resolveEnvironmentBinding, updateConfig } from "./config.ts";
import { projectCatalog, type CatalogOptions, type CatalogProjection } from "./catalog.ts";
import { loadCatalogMetadata, getCatalogSourceStatus, type CatalogMetadataSnapshot } from "./catalog-sources.ts";
import { DiscoveryManager, type DiscoveryBinding, type HealthSnapshot } from "./health.ts";
import { readSellerPricing, PRICING_WARNING, type SellerPricing } from "./pricing.ts";
import { requestJson, TransportError } from "./transport.ts";
import type { AdminRuntime } from "./admin/runtime.ts";
import { createBoundInferenceStream, OMNIROUTE_GUARDED_API } from "./inference.ts";

const PROVIDER_ID = "omniroute";
const RUNTIME_ENV = "OMP_OMNIROUTE_API_KEY";
const METADATA_ENV = "OMP_OMNIROUTE_METADATA_API_KEY";
const PRICING_ENV = "OMP_OMNIROUTE_PRICING_FILE";
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_JSON_DEPTH = 24;

type ContextLike = ExtensionContext;


function safeDetail(error: unknown): string {
	if (error instanceof TransportError) return error.code;
	if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z][a-z0-9_-]*$/.test(error.code)) return error.code;
	return "request_failed";
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}


function endpointRoot(endpoint: string): string {
	return endpoint.replace(/\/+$/, "").replace(/\/v1$/, "");
}

function modelsUrl(endpoint: string): string {
	return `${endpointRoot(endpoint)}/v1/models`;
}

function baseApi(endpoint: string): string {
	return `${endpointRoot(endpoint)}/v1`;
}

function providerConfig(
	oauth: NonNullable<ProviderConfig["oauth"]>,
	endpoint?: string,
	models: NonNullable<ProviderConfig["models"]> = [],
	apiKeyEnvironment?: string,
	streamSimple?: ProviderConfig["streamSimple"],
): ProviderConfig {
	const result: ProviderConfig = { oauth, models };
	if (endpoint) {
		result.baseUrl = baseApi(endpoint);
		result.api = OMNIROUTE_GUARDED_API;
		result.authHeader = true;
		if (apiKeyEnvironment) result.apiKey = apiKeyEnvironment;
		if (streamSimple) result.streamSimple = streamSimple;
	}
	return result;
}

function notify(context: ExtensionContext | undefined, text: string, type: "info" | "warning" | "error" = "info"): void {
	if (!context) return;
	const safe = text.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 2000);
	if (context.hasUI) context.ui.notify(safe, type);
	else process.stderr.write(`${safe}\n`);
}
function envBinding(config: PluginConfig): { endpoint: string; credential: string; generation: number } | undefined {
	const binding = resolveEnvironmentBinding(config);
	if (!binding) return undefined;
	return { endpoint: binding.endpoint, credential: binding.credential.value, generation: binding.generation };
}

export default async function registerOmniRouteProvider(pi: ExtensionAPI): Promise<void> {
	let context: ContextLike | undefined;
	let stopped = false;
	let config: PluginConfig;
	try {
		config = await loadConfig();
	} catch (error) {
		const reason = safeDetail(error);
		const diagnosticCommand: Parameters<ExtensionAPI["registerCommand"]>[1] = {
			description: `${DISPLAY_NAME} configuration diagnostics`,
			handler: async (_args, ctx) => notify(ctx, `${DISPLAY_NAME}: configuration blocked (${reason}). Repair the private omniroute/config.json in this OMP profile, then restart. No credentials or requests were sent.`, "warning"),
		};
		pi.registerCommand("omniroute", diagnosticCommand);
		pi.registerCommand("cruxomni", diagnosticCommand);
		return;
	}
	let pricing: SellerPricing | undefined;
	const optionalCredentials = new OptionalCredentials();
	let metadataState = "not configured";
	let pricingCurrent = false;
	let latestProjection: CatalogProjection | undefined;
	let transitionNotifications = true;
	let pendingCandidateKey: string | undefined;
	let pendingCandidateEndpoint: string | undefined;
	let runtimeEndpoint: string | undefined;
	let runtimeEnvironment = false;
	let providerRegistered = false;
	let publishedProjection: CatalogProjection | undefined;
	let publishedGeneration = -1;
	let publishedEndpoint: string | undefined;
	let startupSignal: AbortSignal | undefined;
	let startupAborter: AbortController | undefined;
	let bindingSyncFlight: Promise<{ pendingValidated: boolean }> | undefined;
	let credentialRevision = 0;
	let observedAuthStorage: ContextLike["modelRegistry"]["authStorage"] | undefined;
	let observedNativeKey: string | undefined;
	let unsubscribeCredentials: (() => void) | undefined;
	let lastNotifiedState: HealthSnapshot["state"] | undefined;
	const contextWaiters = new Set<(value: ContextLike | undefined) => void>();
	const setContext = (value: ContextLike | undefined): void => {
		context = value;
		for (const receive of contextWaiters) receive(value);
		contextWaiters.clear();
	};
	const metadataContext = (signal: AbortSignal): Promise<ContextLike | undefined> => {
		if (signal.aborted || context) return Promise.resolve(signal.aborted ? undefined : context);
		const { promise, resolve } = Promise.withResolvers<ContextLike | undefined>();
		const receive = (value: ContextLike | undefined): void => {
			signal.removeEventListener("abort", abort);
			contextWaiters.delete(receive);
			resolve(value);
		};
		const abort = (): void => receive(undefined);
		contextWaiters.add(receive);
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		return promise;
	};
	const replaceProvider = (next: ProviderConfig, invalidate = false): void => {
		if (!providerRegistered || invalidate) pi.unregisterProvider(PROVIDER_ID);
		pi.registerProvider(PROVIDER_ID, next);
		providerRegistered = true;
	};

	const onSetupComplete = async (endpoint: string, candidateKey: string): Promise<void> => {
		if (stopped) return;
		// Activation still requires the native store to contain this candidate;
		// the shared refresh leaves an unpersisted candidate auth-only.
		pendingCandidateEndpoint = endpoint;
		pendingCandidateKey = candidateKey;
		manager.reset();
		await refresh(context, false);
	};
	const nativeLogin = registerNativeLogin({ providerName: PROVIDER_LIST_NAME, onSetupComplete });
	const oauth: NonNullable<ProviderConfig["oauth"]> = {
		name: nativeLogin.name,
		login: callbacks => nativeLogin.login({
			onPrompt: async options => callbacks.onPrompt({
				message: options.message,
				...(options.placeholder === undefined ? {} : { placeholder: options.placeholder }),
				...(options.secret === undefined ? {} : { secret: options.secret }),
			}),
			onConfirm: async options => {
				const answer = await callbacks.onPrompt({
					message: `${options.message}${options.detail ? `\n${options.detail}` : ""}`,
					placeholder: "yes/no",
				});
				return /^(?:y|yes)$/i.test(answer.trim());
			},
			onMessage: message => callbacks.onProgress?.(message),
		}),
	};

	const loadPricing = async (file: string | undefined): Promise<void> => {
		pricingCurrent = false;
		if (!file) return;
		try {
			pricing = await readSellerPricing(file);
			pricingCurrent = true;
		} catch {
			// Keep the last parsed view for inspection, but never use it for
			// numeric totals while the current file is unavailable.
		}
	};
	const catalogStatus = (): string => {
		const sources = config.catalogSources ?? [];
		if (sources.length === 0) return "disabled";
		const now = Date.now();
		return sources.map(source => {
			const status = getCatalogSourceStatus(source);
			const age = status.fetchedAt === undefined ? "" : `; age=${Math.max(0, Math.floor((now - status.fetchedAt) / 1_000))}s`;
			return `${source}=${status.state}${age}${status.errorCode ? `; detail=${status.errorCode}` : ""}`;
		}).join(", ");
	};
	const discover = async (binding: DiscoveryBinding, signal: AbortSignal) => {
		const sourceConfig = config;
		const source = runtimeEnvironment ? resolveEnvironmentBinding(sourceConfig) : sourceConfig.pending ?? sourceConfig.active;
		const metadataBinding = source?.endpoint === binding.endpoint
			? { endpoint: binding.endpoint, generation: source.generation }
			: undefined;
		const pricingFile = sourceConfig.pricingFile ?? process.env[PRICING_ENV]?.trim();
		const environmentMetadataKey = (): string | undefined => metadataBinding && allowsEnvironmentOptionalCredentials(sourceConfig, binding.endpoint)
			? process.env[METADATA_ENV]?.trim()
			: undefined;
		const initialEnvironmentMetadataKey = environmentMetadataKey();
		const rememberedMetadata = sourceConfig.optionalCredentials?.metadata?.state === "ready";
		const sessionMetadata = metadataBinding !== undefined && optionalCredentials.hasSession("metadata", metadataBinding);
		const requestSignal = startupSignal ? AbortSignal.any([signal, startupSignal]) : signal;
		const limits = { totalBudgetMs: 10_000, maxBytes: MAX_BODY_BYTES, maxDepth: MAX_JSON_DEPTH };
		const retry = { maxRetries: 1, safeRead: true, retryStatuses: [429, 502, 503, 504] as const };
		const live = await requestJson(modelsUrl(binding.endpoint), binding.credential, limits, requestSignal, retry);
		const projection = projectCatalog(live);
		const catalogSources = sourceConfig.catalogSources ?? [];
		if (!pricingFile && !initialEnvironmentMetadataKey && !rememberedMetadata && !sessionMetadata && catalogSources.length === 0) return { projection };
		const enrichment = (async (): Promise<CatalogProjection> => {
			const optionalSignal = AbortSignal.any([signal, AbortSignal.timeout(5_000)]);
			let pricingError = false;
			let metadataError: string | undefined;
			let availability = "not configured";
			let metadataIsCurrent = (): boolean => true;
			const catalogsPromise = Promise.all(catalogSources.map(source =>
				loadCatalogMetadata(source, optionalSignal).catch(() => undefined)));
			const pricingPromise = pricingFile
				? readSellerPricing(pricingFile).catch(() => { pricingError = true; return undefined; })
				: Promise.resolve(undefined);
			const metadataPromise = (async (): Promise<unknown> => {
				if (!environmentMetadataKey() && !rememberedMetadata && !sessionMetadata) return undefined;
				availability = "checking";
				if (manager.currentBinding?.generation === binding.generation) metadataState = availability;
				try {
					const environmentMetadata = environmentMetadataKey();
					const owner = environmentMetadata ? undefined : await metadataContext(optionalSignal);
					const credential = metadataBinding
						? await optionalCredentials.resolve("metadata", metadataBinding, owner?.modelRegistry.authStorage,
							environmentMetadata ? { kind: "apiKey", value: environmentMetadata } : undefined)
						: undefined;
					const key = credential?.value;
					if (!key) {
						metadataError = "metadata_credentials_unavailable";
						availability = "unavailable";
						return undefined;
					}
					const epoch = optionalCredentials.getEpoch("metadata");
					const credentialSignal = optionalCredentials.getSignal("metadata");
					metadataIsCurrent = () => !stopped && !credentialSignal.aborted
						&& optionalCredentials.getEpoch("metadata") === epoch
						&& environmentMetadataKey() === environmentMetadata;
					const metadataSignal = AbortSignal.any([optionalSignal, credentialSignal]);
					const value = await requestJson(`${endpointRoot(binding.endpoint)}/api/models/catalog`, key,
						{ ...limits, totalBudgetMs: 5_000 }, metadataSignal, retry);
					if (!metadataIsCurrent()) throw new TransportError("aborted", "metadata credential changed");
					availability = "available";
					return value;
				} catch (error) {
					metadataError = "metadata_unavailable";
					availability = "unavailable";
					return undefined;
				}
			})();
			const [loadedPricing, loadedMetadata, catalogs] = await Promise.all([pricingPromise, metadataPromise, catalogsPromise]);
			const enabledCatalogSources = catalogSources.length === 0
				? catalogSources
				: (await loadConfig()).catalogSources ?? [];
			if (signal.aborted) throw new TransportError("aborted", "enrichment binding cancelled");
			const metadata = metadataIsCurrent() ? loadedMetadata : undefined;
			if (loadedMetadata !== undefined && metadata === undefined) {
				metadataError = "metadata_credentials_changed";
				availability = "unavailable";
			}
			const externalMetadata = catalogs.filter((snapshot): snapshot is CatalogMetadataSnapshot =>
				snapshot !== undefined && enabledCatalogSources.includes(snapshot.source));
			const options: CatalogOptions = {
				pricingCurrent: loadedPricing !== undefined,
				externalMetadata,
				...(loadedPricing === undefined ? {} : { pricing: loadedPricing }),
			};
			let enriched: CatalogProjection;
			try {
				enriched = projectCatalog(live, { ...options, ...(metadata === undefined ? {} : { metadata }) });
			} catch {
				metadataError = "metadata_invalid";
				availability = "unavailable";
				enriched = projectCatalog(live, options);
			}
			const diagnostics = [...enriched.diagnostics];
			for (let index = 0; index < catalogSources.length; index++) {
				const source = catalogSources[index]!;
				if (enabledCatalogSources.includes(source) && !catalogs[index]) {
					diagnostics.push({ code: "external_catalog_unavailable", detail: source });
				}
			}
			if (pricingError) diagnostics.push({ code: "pricing_unavailable" });
			if (metadataError) diagnostics.push({ code: metadataError });
			if (manager.currentBinding?.generation === binding.generation && manager.currentResult?.projection === projection) {
				if (loadedPricing) pricing = loadedPricing;
				pricingCurrent = loadedPricing !== undefined;
				metadataState = availability;
			}
			return { ...enriched, diagnostics };
		})();
		return { projection, enrichment };
	};

	const manager = new DiscoveryManager(discover, [snapshot => {
		publishCurrent();
		const changed = snapshot.state !== lastNotifiedState;
		lastNotifiedState = snapshot.state;
		if (!changed || !transitionNotifications || stopped || snapshot.state === "unconfigured") return;
		const kind = snapshot.state === "ready" ? "info" : snapshot.state === "unauthorized" ? "warning" : "error";
		notify(context, `omniroute: state ${snapshot.state}; models=${snapshot.modelCount}${snapshot.lastError ? `; detail=${snapshot.lastError}` : ""}`, kind);
	}]);
	const runtimeProviderConfig = (
		endpoint?: string,
		models?: CatalogProjection["models"],
	): ProviderConfig => providerConfig(
		oauth,
		endpoint,
		models?.map(model => ({ ...model, api: OMNIROUTE_GUARDED_API })),
		runtimeEnvironment ? RUNTIME_ENV : undefined,
		endpoint ? createBoundInferenceStream({
			expectedEndpoint: endpoint,
			expectedGeneration: manager.currentBinding?.generation ?? manager.status.generation,
			currentBinding: () => manager.currentBinding,
			currentModelApi: id => manager.getModelApi(id),
			currentSignal: () => manager.bindingSignal,
			stopped: () => stopped,
		}) : undefined,
	);
	// Cut over any previous package registration before startup discovery.
	replaceProvider(providerConfig(oauth));
	let administration: AdminRuntime | undefined;
	let administrationFlight: Promise<AdminRuntime | undefined> | undefined;
	let administrationEpoch = 0;
	let administrationRetirement: Promise<void> = Promise.resolve();
	const ensureAdministration = (): Promise<AdminRuntime | undefined> => {
		if (stopped) return Promise.resolve(undefined);
		if (administration) return Promise.resolve(administration);
		if (administrationFlight) return administrationFlight;
		const epoch = administrationEpoch;
		const flight = administrationRetirement.then(() => import("./admin/runtime.ts")).then(async ({ createAdminRuntime }) => {
			if (stopped || epoch !== administrationEpoch) return undefined;
			const created = createAdminRuntime({
				pi,
				credentials: optionalCredentials,
				context: () => context,
				binding: () => manager.currentBinding,
				bindingSignal: () => manager.bindingSignal,
				stopped: () => stopped,
				onConfig: current => { config = current; },
			});
			try {
				await created.synchronize();
				if (stopped || epoch !== administrationEpoch) {
					await created.shutdown();
					return undefined;
				}
				administration = created;
				return created;
			} catch (error) {
				try { await created.shutdown(); } catch { /* Preserve the synchronization failure. */ }
				throw error;
			}
		});
		administrationFlight = flight;
		void flight.finally(() => { if (administrationFlight === flight) administrationFlight = undefined; }).catch(() => undefined);
		return flight;
	};
	const synchronizeAdministration = async (source: PluginConfig): Promise<void> => {
		if (administration) await administration.synchronize(source);
		else if (source.adminEnabled) await ensureAdministration();
	};
	const administrationCommand: Parameters<ExtensionAPI["registerCommand"]>[1] = {
		description: "Inspect, enable, and human-confirm optional OmniRoute operations",
		handler: async (args, ctx) => {
			setContext(ctx);
			try {
				const source = await loadConfig();
				config = source;
				const command = args.trim().split(/\s+/, 1)[0] ?? "";
				if (command === "status" || command === "help" || (!source.adminEnabled && command !== "enable")) {
					if (administration) await administration.synchronize(source);
					notify(ctx, `omniroute operations: ${source.adminEnabled ? "enabled" : "disabled"}; /omniroute-admin enable, disable, or search; mutations require an interactive human confirmation`);
					return;
				}
				const runtime = await ensureAdministration();
				if (runtime) await runtime.command(args, ctx);
			} catch (error) {
				notify(ctx, `omniroute operations unavailable (${safeDetail(error)}); no request was sent`, "warning");
			}
		},
	};
	pi.registerCommand("omniroute-admin", administrationCommand);
	pi.registerCommand("cruxomni-admin", administrationCommand);
	function publishCurrent(): void {
		if (stopped) return;
		const binding = manager.currentBinding;
		const pending = !runtimeEnvironment && config.pending;
		const projection = pending || !binding ? undefined : manager.currentResult?.projection;
		const endpoint = pending ? undefined : binding?.endpoint ?? runtimeEndpoint;
		const generation = manager.status.generation;
		latestProjection = projection;
		if (projection === publishedProjection && endpoint === publishedEndpoint && generation === publishedGeneration) return;
		publishedProjection = projection;
		publishedEndpoint = endpoint;
		publishedGeneration = generation;
		replaceProvider(runtimeProviderConfig(endpoint, projection?.models), !projection?.models.length);
	}

	function observeCredentials(ctx: ContextLike): void {
		const storage = ctx.modelRegistry.authStorage;
		if (storage === observedAuthStorage) return;
		unsubscribeCredentials?.();
		observedAuthStorage = storage;
		const nativeKey = (): string | undefined => {
			const saved = storage.credentials.get(PROVIDER_ID);
			return saved?.type === "api_key" ? saved.key : undefined;
		};
		observedNativeKey = nativeKey();
		let optionalReconciliation = Promise.resolve();
		const reconcileOptional = async (): Promise<void> => {
			if (stopped || observedAuthStorage !== storage) return;
			const loaded = await loadConfig();
			const active = resolveEnvironmentBinding(loaded) ?? loaded.active;
			if (active) {
				const environment = allowsEnvironmentOptionalCredentials(loaded, active.endpoint)
					? process.env[METADATA_ENV]?.trim()
					: undefined;
				await optionalCredentials.resolve("metadata", active, storage,
					environment ? { kind: "apiKey", value: environment } : undefined);
			}
			if (administration) await administration.synchronize();
		};
		unsubscribeCredentials = storage.credentials.onGeneration(() => {
			if (stopped) return;
			// Optional-store changes revoke only their own authority. They must
			// never cancel chat streams or invalidate the runtime discovery cache.
			optionalReconciliation = optionalReconciliation.then(reconcileOptional, reconcileOptional);
			void optionalReconciliation.catch(async () => {
				optionalCredentials.clear();
				await administration?.disable();
			}).catch(() => undefined);
			const next = nativeKey();
			if (next === observedNativeKey) return;
			observedNativeKey = next;
			if (stopped || runtimeEnvironment) return;
			credentialRevision++;
			manager.reset();
			// A replacement cancels streams immediately. Resolve the new native
			// credential only after an older binding synchronization has settled.
			const settled = bindingSyncFlight ?? Promise.resolve();
			void settled.then(() => refresh(context, false), () => refresh(context, false));
		});
	}

	async function synchronizeBinding(ctx: ContextLike | undefined): Promise<{ pendingValidated: boolean }> {
		const revision = credentialRevision;
		let validConfiguration = false;
		try {
			const previousActiveGeneration = config.active?.generation;
			const loaded = await loadConfig();
			config = loaded;
			await synchronizeAdministration(config);
			const environment = envBinding(config);
			const pending = environment ? undefined : config.pending;
			const active = environment ?? config.active;
			runtimeEnvironment = environment !== undefined;
			runtimeEndpoint = pending ? undefined : active?.endpoint;
			validConfiguration = true;
			if (environment) {
				if (manager.setBinding(environment.endpoint, environment.credential, environment.generation)) {
					metadataState = "not configured";
					pricingCurrent = false;
				}
			} else if (pending || manager.currentBinding?.endpoint !== active?.endpoint || previousActiveGeneration !== active?.generation) {
				manager.reset();
				metadataState = "not configured";
				pricingCurrent = false;
			}
			publishCurrent();
			if ((!active && !pending) || (pending && (!pendingCandidateKey || pendingCandidateEndpoint !== pending.endpoint))) {
				manager.setBinding(undefined, undefined);
				publishCurrent();
				return { pendingValidated: false };
			}
			const credential = environment?.credential ?? (ctx
				? await resolveRuntimeCredential(ctx.modelRegistry, loaded)
				: await resolveStartupRuntimeCredential(
					() => pi.pi.discoverAuthStorage(),
					startupSignal ?? AbortSignal.timeout(10_000),
					loaded,
				));
			const confirmed = await loadConfig();
			if (stopped || revision !== credentialRevision || loaded.revision !== confirmed.revision) {
				validConfiguration = false;
				throw Object.assign(new Error("binding changed during credential resolution"), { code: "binding_changed" });
			}
			config = confirmed;
			if (pending) {
				const candidateKey = pendingCandidateKey;
				if (!candidateKey || credential !== candidateKey || pendingCandidateEndpoint !== pending.endpoint) {
					manager.reset();
					publishCurrent();
					return { pendingValidated: false };
				}
				manager.setBinding(pending.endpoint, credential, pending.generation);
				const validation = await manager.refresh({ force: true });
				if (!validation || validation.stale || revision !== credentialRevision) {
					throw Object.assign(new Error("pending validation did not return a current live catalog"), { code: "pending_validation_failed" });
				}
				if (ctx) {
					await recoverPendingAfterPersistence(ctx.modelRegistry, candidateKey);
				} else {
					manager.reset();
					publishCurrent();
					return { pendingValidated: false };
				}
				config = await loadConfig();
				if (config.pending || !config.active || config.active.endpoint !== manager.currentBinding?.endpoint || revision !== credentialRevision) {
					throw Object.assign(new Error("pending binding changed during validation"), { code: "binding_changed" });
				}
				pendingCandidateKey = undefined;
				pendingCandidateEndpoint = undefined;
				runtimeEndpoint = config.active.endpoint;
				publishCurrent();
				return { pendingValidated: true };
			}
			const changed = manager.setBinding(active?.endpoint, credential, active?.generation);
			if (changed) {
				metadataState = "not configured";
				pricingCurrent = false;
			}
			publishCurrent();
			return { pendingValidated: false };
		} catch (error) {
			if (!stopped && revision === credentialRevision) {
				if (!validConfiguration) {
					runtimeEndpoint = undefined;
					runtimeEnvironment = false;
				}
				metadataState = "unavailable";
				pricingCurrent = false;
				manager.reset();
				await administration?.disable();
				publishCurrent();
			}
			throw error;
		}
	}

	async function refresh(ctx: ContextLike | undefined, manual: boolean): Promise<void> {
		if (stopped) return;
		if (ctx) {
			setContext(ctx);
			observeCredentials(ctx);
		}
		let synchronized: { pendingValidated: boolean };
		try {
			if (!bindingSyncFlight) {
				const flight = synchronizeBinding(ctx);
				bindingSyncFlight = flight;
				const clear = (): void => { if (bindingSyncFlight === flight) bindingSyncFlight = undefined; };
				void flight.then(clear, clear);
			}
			synchronized = await bindingSyncFlight;
		} catch (error) {
			if (manual) notify(ctx, `omniroute: binding unavailable (${safeDetail(error)})`, "warning");
			return;
		}
		if (stopped) return;
		if (!manager.currentBinding) {
			if (manual) notify(ctx, config.pending
					? "omniroute: setup is pending native persistence; sign in again if the previous process was interrupted, then /omniroute refresh"
					: "omniroute: setup required; use native sign-in, then /omniroute refresh", "info");
			return;
		}
		try {
			if (!synchronized.pendingValidated) await manager.refresh({ force: manual });
			const result = manager.currentResult;
			if (manual && result) notify(ctx, `omniroute: refreshed ${result.projection.models.length} live models${result.stale ? " (stale same-generation rows)" : ""}`, result.stale ? "warning" : "info");
		} catch (error) {
			if (manual) notify(ctx, `omniroute: refresh failed; no new catalog accepted (${safeDetail(error)})`, "warning");
		}
		await synchronizeAdministration(config);
	}

	const setup = createSetupWizard({
		credentials: optionalCredentials,
		refresh: ctx => refresh(ctx, true),
		status: () => `${manager.status.state}; models=${manager.status.modelCount}; metadata=${metadataState}; catalogs=${catalogStatus()}`,
		synchronizeAdmin: async ctx => {
			setContext(ctx);
			await synchronizeAdministration(await loadConfig());
		},
	});
	const providerCommand: Parameters<ExtensionAPI["registerCommand"]>[1] = {
		description: "Refresh or inspect OmniRoute provider state",
		handler: async (args, ctx) => {
			setContext(ctx);
			observeCredentials(ctx);
			const commandParts = args.trim().split(/\s+/);
			const command = commandParts[0] ?? "status";
			const typed = ctx;
			if (command === "setup") await setup(typed);
			else if (command === "refresh") await refresh(typed, true);
			else if (command === "pricing") {
				const file = config.pricingFile ?? process.env[PRICING_ENV]?.trim();
				await loadPricing(file);
				const modelId = commandParts[1];
				const inspection = modelId ? latestProjection?.pricing.get(modelId) : undefined;
				if (modelId && !inspection) notify(ctx, "omniroute: model_not_in_live_catalog", "warning");
				else if (inspection) notify(ctx, `omniroute pricing ${modelId}: ${inspection.state}; fields=${JSON.stringify(inspection.fields)}; cost=${JSON.stringify(inspection.cost)}; reasons=${inspection.reasons.join(",")}; ${PRICING_WARNING}`);
				else notify(ctx, `omniroute pricing: ${pricingCurrent ? "current file" : "unavailable"}; ${PRICING_WARNING}`);
			} else {
				const status: HealthSnapshot = manager.status;
				notify(ctx, `omniroute: ${status.state}; models=${status.modelCount}${status.stale ? "; stale same-generation rows" : ""}${status.lastError ? `; detail=${status.lastError}` : ""}; catalogs=${catalogStatus()}`);
			}
		},
	};
	pi.registerCommand("omniroute", providerCommand);
	pi.registerCommand("cruxomni", providerCommand);
	const pricingCommand: Parameters<ExtensionAPI["registerCommand"]>[1] = {
		description: "Inspect source-backed OmniRoute pricing",
		handler: async (args, ctx) => {
			const file = config.pricingFile ?? process.env[PRICING_ENV]?.trim();
			await loadPricing(file);
			const modelId = args.trim();
			const inspection = modelId ? latestProjection?.pricing.get(modelId) : undefined;
			if (modelId && !inspection) notify(ctx, "omniroute: model_not_in_live_catalog", "warning");
			else if (inspection) notify(ctx, `omniroute pricing ${modelId}: ${inspection.state}; fields=${JSON.stringify(inspection.fields)}; cost=${JSON.stringify(inspection.cost)}; reasons=${inspection.reasons.join(",")}; ${PRICING_WARNING}`);
			else notify(ctx, `omniroute pricing: ${pricingCurrent ? "current file" : "unavailable"}; ${PRICING_WARNING}`);
		},
	};
	pi.registerCommand("omniroute-pricing", pricingCommand);
	pi.registerCommand("cruxomni-pricing", pricingCommand);

	pi.on("session_start", async (_event, ctx) => {
		if (bindingSyncFlight) await bindingSyncFlight.catch(() => undefined);
		stopped = false;
		setContext(ctx);
		transitionNotifications = false;
		manager.resume();
		await refresh(ctx, false);
		const settings = typeof ctx.cwd === "string" ? await getPluginSettings(PACKAGE_NAME, ctx.cwd).catch(() => ({} as Record<string, unknown>)) : {};
		transitionNotifications = settings.notifyTransitions !== false;
		if (ctx.mode === "tui" && settings.showSetupInvitation !== false && !config.invitationDismissed && !config.active && !config.pending && !envBinding(config)) {
			notify(ctx, `${DISPLAY_NAME}: connect your gateway with /omniroute setup. You can open setup at any time.`);
			try { config = await updateConfig(current => ({ ...current, invitationDismissed: true })); } catch { /* A conflict never forces setup or overwrites another writer. */ }
		}
	});
	pi.on("session_shutdown", async () => {
		stopped = true;
		credentialRevision++;
		startupAborter?.abort();
		unsubscribeCredentials?.();
		unsubscribeCredentials = undefined;
		observedAuthStorage = undefined;
		observedNativeKey = undefined;
		latestProjection = undefined;
		publishedProjection = undefined;
		publishedEndpoint = undefined;
		publishedGeneration = -1;
		pendingCandidateKey = undefined;
		pendingCandidateEndpoint = undefined;
		clearPendingCandidate();
		transitionNotifications = false;
		setContext(undefined);
		manager.shutdown();
		optionalCredentials.clear();
		administrationEpoch++;
		const retired = administration;
		const retiredFlight = administrationFlight;
		administration = undefined;
		administrationFlight = undefined;
		const retirement = administrationRetirement.then(async () => {
			await retired?.shutdown();
			await retiredFlight?.catch(() => undefined);
		});
		administrationRetirement = retirement.catch(() => undefined);
		await retirement;
		pi.unregisterProvider(PROVIDER_ID);
		providerRegistered = false;
	});
	const controller = new AbortController();
	startupAborter = controller;
	startupSignal = controller.signal;
	const deadline = setTimeout(() => controller.abort(), 10_000);
	try {
		await refresh(undefined, false);
	} finally {
		clearTimeout(deadline);
		startupAborter = undefined;
		startupSignal = undefined;
	}
}

export { registerOmniRouteProvider };
