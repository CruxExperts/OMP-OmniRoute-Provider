import { THINKING_EFFORTS, type Api, type Effort, type Model, type ThinkingConfig } from "@oh-my-pi/pi-ai";
import type { ProviderModelConfig } from "@oh-my-pi/pi-coding-agent";
import type { CatalogMetadataSnapshot } from "./catalog-sources.ts";
import { inspectSellerPrice, type PriceInspection, type ScalarCosts, type SellerPricing } from "./pricing.ts";

type JsonRecord = Record<string, unknown>;

export type EndpointApi = "openai-responses" | "openai-completions";

export interface CatalogDiagnostic {
	code: string;
	modelId?: string;
	source?: string;
	detail?: string;
}

export interface CatalogProjection {
	/** Rows accepted from the authoritative /v1/models response, keyed by identity. */
	rows: ReadonlyMap<string, JsonRecord>;
	/** OMP-selectable models. Specialty-only rows are deliberately omitted. */
	models: readonly ProjectedModel[];
	/** Exact pricing projection used for each accepted identity. */
	pricing: ReadonlyMap<string, PriceInspection>;
	diagnostics: readonly CatalogDiagnostic[];
	counts: { known: number; unknown: number; conditional: number; stale: number };
}

export interface CatalogOptions {
	metadata?: unknown;
	externalMetadata?: readonly CatalogMetadataSnapshot[];
	pricing?: SellerPricing;
	pricingCurrent?: boolean;
	now?: number;
	stale?: boolean;
}

export class CatalogError extends Error {
	readonly code: string;
	constructor(code: string, detail?: string) {
		super(detail ? `${code}:${detail}` : code);
		this.name = "CatalogError";
		this.code = code;
	}
}

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 16_384;
const RESPONSE_NAMES: Record<string, true> = {
	responses: true,
	"openai-responses": true,
	"openai-responses-compatible": true,
	openai_responses: true,
	response: true,
};
const CHAT_NAMES: Record<string, true> = {
	chat: true,
	completions: true,
	"chat-completions": true,
	"openai-completions": true,
	"openai-chat-completions": true,
	"openai-chat-completions-compatible": true,
	openai_completions: true,
};
const SPECIALTY_NAMES = /(?:image|audio|embedding|moderation|transcri|speech|video|rerank|search)/i;

function record(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Stable comparison for duplicate identities; object key order is irrelevant. */
export function canonical(value: unknown): string {
	if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
	if (record(value)) return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
	return JSON.stringify(value) ?? "null";
}

type ProjectedModel = ProviderModelConfig & Pick<Model<Api>, "supportsTools">;
type ModelKind = NonNullable<Model<Api>["kind"]>;

const MODEL_KIND_BY_NAME: Record<string, ModelKind> = {
	chat: "chat", tiny: "tiny", image: "image", tts: "tts", stt: "stt",
	search: "search", judge: "judge", embedding: "embedding", rerank: "rerank", video: "video",
};
const INPUT_MODALITY_NAMES: Record<string, true> = { text: true, image: true };
const EFFORT_ORDER = THINKING_EFFORTS;
const EFFORT_BY_NAME: Record<string, Effort> = {};
for (const effort of EFFORT_ORDER) EFFORT_BY_NAME[effort] = effort;
const THINKING_MODE_BY_NAME: Record<string, ThinkingConfig["mode"]> = {
	effort: "effort", budget: "budget", "google-level": "google-level",
	"anthropic-adaptive": "anthropic-adaptive", "anthropic-budget-effort": "anthropic-budget-effort",
};
const CATALOG_SOURCE_BY_NAME: Record<string, true> = { "models.dev": true, openrouter: true };

function positiveNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function stringList(value: unknown): string[] {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return [];
	return value.flatMap(item => {
		if (typeof item === "string") return [item];
		if (record(item)) {
			for (const key of ["name", "type", "id", "api", "format", "endpoint", "route"]) {
				const candidate = item[key];
				if (typeof candidate === "string") return [candidate];
			}
		}
		return [];
	});
}

function endpointNames(row: JsonRecord): string[] {
	const names: string[] = [];
	for (const key of ["supported_endpoints", "supportedEndpoints", "endpoints", "endpoint", "api_format", "apiFormat", "format", "api"]) {
		const value = row[key];
		if (record(value)) {
			for (const [name, enabled] of Object.entries(value)) if (enabled !== false && enabled !== null) names.push(name);
		} else names.push(...stringList(value));
	}
	return names.map(name => name.trim().toLowerCase()).filter(Boolean);
}

function endpointFor(row: JsonRecord): { api?: EndpointApi; explicit: boolean; specialty: boolean; unsupportedKind?: boolean; kind: ModelKind | undefined } {
	const kindValue = typeof row.kind === "string" && row.kind.length > 0 ? row.kind : undefined;
	const kind = kindValue ? MODEL_KIND_BY_NAME[kindValue] : undefined;
	if (kindValue && !kind) return { explicit: true, specialty: false, unsupportedKind: true, kind: undefined };
	if (kind && kind !== "chat") return { explicit: true, specialty: true, kind };
	const names = endpointNames(row);
	const hasResponses = names.some(name => RESPONSE_NAMES[name] === true || name.includes("responses"));
	const hasChat = names.some(name => CHAT_NAMES[name] === true || (name.includes("chat") && name.includes("completion")));
	if (hasResponses) return { api: "openai-responses", explicit: true, specialty: false, kind };
	if (hasChat) return { api: "openai-completions", explicit: true, specialty: false, kind };
	// Older /v1/models payloads omit endpoint metadata. Preserve the provider's
	// Responses-compatible default, but never infer a specialty model as chat.
	if (names.length === 0) return { api: "openai-responses", explicit: false, specialty: false, kind };
	return { explicit: true, specialty: names.some(name => SPECIALTY_NAMES.test(name)), kind };
}

function catalogRows(metadata: unknown): Map<string, Map<string, JsonRecord>> {
	const result = new Map<string, Map<string, JsonRecord>>();
	if (!record(metadata) || !record(metadata.catalog)) return result;
	for (const [owner, provider] of Object.entries(metadata.catalog)) {
		const entries = record(provider) && Array.isArray(provider.models) ? provider.models : Array.isArray(provider) ? provider : [];
		const rows = new Map<string, JsonRecord>();
		for (const item of entries) {
			if (!record(item) || typeof item.id !== "string" || !item.id.trim()) continue;
			const old = rows.get(item.id);
			if (old && canonical(old) !== canonical(item)) throw new CatalogError("duplicate_identity_conflict");
			rows.set(item.id, item);
		}
		result.set(owner, rows);
	}
	return result;
}

interface ExternalCandidate {
	source: string;
	entry: JsonRecord;
}

function externalRows(snapshots: readonly CatalogMetadataSnapshot[] | undefined, now: number, diagnostics: CatalogDiagnostic[]): Map<string, ExternalCandidate[]> {
	const result = new Map<string, ExternalCandidate[]>();
	for (const snapshot of snapshots ?? []) {
		if (!record(snapshot) || typeof snapshot.source !== "string" || !CATALOG_SOURCE_BY_NAME[snapshot.source]) {
			diagnostics.push({ code: "metadata_snapshot_invalid" });
			continue;
		}
		const source = snapshot.source;
		if (!Number.isFinite(snapshot.fetchedAt) || !Number.isFinite(snapshot.expiresAt) || !/^[0-9a-f]{64}$/i.test(snapshot.digest) || !Array.isArray(snapshot.entries)) {
			diagnostics.push({ code: "metadata_snapshot_invalid", source });
			continue;
		}
		for (const item of snapshot.diagnostics ?? []) {
			diagnostics.push({ code: `metadata_${item.code.slice(0, 64)}`, source, ...(item.detail ? { detail: item.detail.slice(0, 128) } : {}) });
		}
		if (snapshot.expiresAt <= now) {
			diagnostics.push({ code: "metadata_source_stale", source });
			continue;
		}
		for (const entry of snapshot.entries) {
			if (!record(entry) || typeof entry.owner !== "string" || typeof entry.id !== "string" || !entry.owner || !entry.id
				|| typeof entry.sourceOwner !== "string" || !entry.sourceOwner
				|| typeof entry.sourceId !== "string" || !entry.sourceId) {
				diagnostics.push({ code: "metadata_entry_invalid", source });
				continue;
			}
			const openRouterIdentity = source === "openrouter" || (source === "models.dev" && entry.sourceOwner === "openrouter");
			const expectedId = openRouterIdentity && !entry.sourceId.startsWith("openrouter/")
				? `openrouter/${entry.sourceId}`
				: entry.sourceId;
			if (entry.id !== expectedId || (openRouterIdentity && (entry.owner !== "openrouter" || entry.sourceOwner !== "openrouter"))) {
				diagnostics.push({ code: "metadata_entry_invalid", source });
				continue;
			}
			const key = `${entry.owner}\u0000${entry.id}`;
			const candidates = result.get(key) ?? [];
			candidates.push({ source, entry });
			result.set(key, candidates);
		}
	}
	return result;
}

function externalField<T>(
	candidates: readonly ExternalCandidate[],
	field: string,
	valueOf: (entry: JsonRecord) => T | undefined,
	modelId: string,
	diagnostics: CatalogDiagnostic[],
): T | undefined {
	const values = candidates.flatMap(candidate => {
		const value = valueOf(candidate.entry);
		return value === undefined ? [] : [{ source: candidate.source, value }];
	});
	if (values.length === 0) return undefined;
	const distinct = new Map<string, string[]>();
	for (const item of values) {
		const key = canonical(item.value);
		const sources = distinct.get(key) ?? [];
		sources.push(item.source);
		distinct.set(key, sources);
	}
	if (distinct.size > 1) {
		const sources = [...new Set(values.map(item => item.source))].sort().join(",");
		diagnostics.push({ code: "external_field_conflict", modelId, source: sources, detail: field });
		return undefined;
	}
	return values[0]?.value;
}

function normalizedModalities(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const seen = new Set<string>();
	for (const item of value) if (typeof item === "string" && item.length <= 32 && item.trim() === item) seen.add(item);
	return [...seen].sort();
}

function normalizedThinking(value: unknown): ThinkingConfig | undefined {
	if (!record(value) || typeof value.mode !== "string" || !Array.isArray(value.efforts)) return undefined;
	const mode = THINKING_MODE_BY_NAME[value.mode];
	if (!mode) return undefined;
	const supported = new Set<Effort>();
	for (const item of value.efforts) {
		const effort = typeof item === "string" ? EFFORT_BY_NAME[item] : undefined;
		if (effort) supported.add(effort);
	}
	const efforts = EFFORT_ORDER.filter(effort => supported.has(effort));
	if (efforts.length === 0) return undefined;
	const defaultLevel = typeof value.defaultLevel === "string" ? EFFORT_BY_NAME[value.defaultLevel] : undefined;
	const config: ThinkingConfig = {
		mode,
		efforts,
		...(defaultLevel && efforts.includes(defaultLevel) ? { defaultLevel } : {}),
	};
	if (record(value.effortMap)) {
		const effortMap: Partial<Record<Effort, string>> = {};
		for (const effort of efforts) {
			const mapping = value.effortMap[effort];
			if (typeof mapping === "string" && mapping.length > 0 && mapping.length <= 64) effortMap[effort] = mapping;
		}
		if (Object.keys(effortMap).length > 0) config.effortMap = effortMap;
	}
	if (record(value.effortRouting)) {
		const effortRouting: Partial<Record<Effort | "off", string>> = {};
		for (const effort of efforts) {
			const route = value.effortRouting[effort];
			if (typeof route === "string" && route.length > 0 && route.length <= 512) effortRouting[effort] = route;
		}
		const offRoute = value.effortRouting.off;
		if (typeof offRoute === "string" && offRoute.length > 0 && offRoute.length <= 512) effortRouting.off = offRoute;
		if (Object.keys(effortRouting).length > 0) config.effortRouting = effortRouting;
	}
	if (record(value.effortBudgets)) {
		const effortBudgets: Partial<Record<Effort, number>> = {};
		for (const effort of efforts) {
			const budget = positiveNumber(value.effortBudgets[effort]);
			if (budget !== undefined) effortBudgets[effort] = budget;
		}
		if (Object.keys(effortBudgets).length > 0) config.effortBudgets = effortBudgets;
	}
	if (typeof value.supportsDisplay === "boolean") config.supportsDisplay = value.supportsDisplay;
	if (typeof value.prefixBinding === "boolean") config.prefixBinding = value.prefixBinding;
	if (typeof value.suppressWhenOff === "boolean") config.suppressWhenOff = value.suppressWhenOff;
	if (typeof value.requiresEffort === "boolean") config.requiresEffort = value.requiresEffort;
	if (typeof value.unverified === "boolean") config.unverified = value.unverified;
	return config;
}

function booleanTier(
	rows: readonly (JsonRecord | undefined)[],
	fields: readonly string[],
	modelId: string,
	field: string,
	source: string,
	diagnostics: CatalogDiagnostic[],
): boolean | undefined {
	const values = rows.flatMap(row => {
		if (!row) return [];
		return fields.flatMap(key => typeof row[key] === "boolean" ? [row[key]] : []);
	});
	if (values.includes(true) && values.includes(false)) {
		diagnostics.push({ code: "capability_source_conflict", modelId, source, detail: field });
		return false;
	}
	return values.includes(false) ? false : values.includes(true) ? true : undefined;
}

function preferBoolean(
	field: string,
	modelId: string,
	high: boolean | undefined,
	medium: boolean | undefined,
	low: boolean | undefined,
	diagnostics: CatalogDiagnostic[],
): boolean | undefined {
	const selected = high ?? medium ?? low;
	if (selected !== undefined && [medium, low].some(value => value !== undefined && value !== selected)) {
		diagnostics.push({ code: "capability_source_conflict", modelId, detail: field });
	}
	return selected;
}

function preferThinking(
	modelId: string,
	high: ThinkingConfig | undefined,
	medium: ThinkingConfig | undefined,
	low: ThinkingConfig | undefined,
	diagnostics: CatalogDiagnostic[],
): ThinkingConfig | undefined {
	const selected = high ?? medium ?? low;
	if (selected && [medium, low].some(value => value && canonical(value) !== canonical(selected))) {
		diagnostics.push({ code: "capability_source_conflict", modelId, detail: "thinking" });
	}
	return selected;
}

function firstPositive(...values: unknown[]): number | undefined {
	for (const value of values) {
		const positive = positiveNumber(value);
		if (positive !== undefined) return positive;
	}
	return undefined;
}

function providerModel(
	id: string,
	name: string,
	costs: ScalarCosts,
	stale: boolean,
	endpoint: EndpointApi,
	kind: ModelKind | undefined,
	reasoning: boolean,
	thinking: ThinkingConfig | undefined,
	supportsTools: boolean | undefined,
	input: ("text" | "image")[],
	contextWindow: number,
	maxTokens: number,
): ProjectedModel {
	const model: ProjectedModel = {
		id,
		name: stale ? `${name} (stale)` : name,
		api: endpoint,
		reasoning,
		input,
		contextWindow,
		maxTokens,
		cost: costs,
		...(kind ? { kind } : {}),
		...(thinking ? { thinking } : {}),
		...(supportsTools !== undefined ? { supportsTools } : {}),
	};
	return model;
}

/**
 * Project a bounded /v1/models payload. Runtime rows are never manufactured
 * from management catalog entries; metadata can only enrich an exact owner/id.
 */
export function projectCatalog(payload: unknown, options: CatalogOptions = {}): CatalogProjection {
	if (!record(payload) || !Array.isArray(payload.data)) throw new CatalogError("invalid_live_data");
	const diagnostics: CatalogDiagnostic[] = [];
	const metadata = catalogRows(options.metadata);
	const external = externalRows(options.externalMetadata, options.now ?? Date.now(), diagnostics);
	const rows = new Map<string, JsonRecord>();
	const signatures = new Map<string, string>();
	const pricing = new Map<string, PriceInspection>();
	const models: ProjectedModel[] = [];
	const counts = { known: 0, unknown: 0, conditional: 0, stale: 0 };
	let malformed = 0;
	let duplicates = 0;
	for (const raw of payload.data) {
		if (!record(raw) || typeof raw.id !== "string" || !raw.id.trim()) {
			malformed++;
			continue;
		}
		const id = raw.id;
		const signature = canonical(raw);
		const prior = signatures.get(id);
		if (prior !== undefined) {
			if (prior !== signature) throw new CatalogError("duplicate_identity_conflict");
			duplicates++;
			continue;
		}
		signatures.set(id, signature);
		rows.set(id, raw);
		const owner = typeof raw.owned_by === "string" ? raw.owned_by : undefined;
		const catalog = owner ? metadata.get(owner)?.get(id) : undefined;
		const candidates = owner ? external.get(`${owner}\u0000${id}`) ?? [] : [];
		const endpoint = endpointFor(raw);
		if (!endpoint.api) {
			diagnostics.push({
				code: endpoint.unsupportedKind ? "unsupported_model_kind" : endpoint.specialty ? "specialty_only_route" : "unsupported_endpoint",
				modelId: id,
			});
			continue;
		}

		const externalName = externalField(candidates, "name", entry => typeof entry.name === "string" && entry.name.trim() ? entry.name : undefined, id, diagnostics);
		const name = typeof raw.name === "string" && raw.name.trim()
			? raw.name
			: typeof catalog?.name === "string" && catalog.name.trim()
				? catalog.name
				: externalName ?? id;
		const externalContext = externalField(candidates, "context_length", entry => positiveNumber(entry.context_length), id, diagnostics);
		const externalOutput = externalField(candidates, "max_output_tokens", entry => positiveNumber(entry.max_output_tokens), id, diagnostics);
		const contextWindow = firstPositive(raw.context_length, raw.contextWindow, catalog?.context_length, catalog?.contextWindow, externalContext);
		const maxTokens = firstPositive(raw.max_output_tokens, raw.maxTokens, catalog?.max_output_tokens, catalog?.maxTokens, externalOutput);
		const resolvedContext = contextWindow ?? DEFAULT_CONTEXT_WINDOW;
		const resolvedOutput = maxTokens ?? Math.min(DEFAULT_MAX_TOKENS, resolvedContext);
		if (contextWindow === undefined) diagnostics.push({ code: "context_limit_unverified", modelId: id, detail: `conservative default ${DEFAULT_CONTEXT_WINDOW}` });
		if (maxTokens === undefined) diagnostics.push({ code: "output_limit_unverified", modelId: id, detail: `conservative default ${resolvedOutput}` });

		const liveCapabilities = record(raw.capabilities) ? raw.capabilities : undefined;
		const catalogCapabilities = record(catalog?.capabilities) ? catalog.capabilities : undefined;
		const externalReasoning = externalField(candidates, "reasoning", entry => {
			const capabilities = record(entry.capabilities) ? entry.capabilities : undefined;
			return typeof capabilities?.reasoning === "boolean" ? capabilities.reasoning : undefined;
		}, id, diagnostics);
		const externalTools = externalField(candidates, "supportsTools", entry => {
			const capabilities = record(entry.capabilities) ? entry.capabilities : undefined;
			return typeof capabilities?.supportsTools === "boolean" ? capabilities.supportsTools : undefined;
		}, id, diagnostics);
		const liveReasoning = booleanTier([raw, liveCapabilities], ["reasoning", "thinking"], id, "reasoning", "live", diagnostics);
		const catalogReasoning = booleanTier([catalog, catalogCapabilities], ["reasoning", "thinking"], id, "reasoning", "omniroute-catalog", diagnostics);
		const reasoning = preferBoolean("reasoning", id, liveReasoning, catalogReasoning, externalReasoning, diagnostics);
		const liveTools = booleanTier([raw, liveCapabilities], ["supportsTools"], id, "supportsTools", "live", diagnostics);
		const catalogTools = booleanTier([catalog, catalogCapabilities], ["supportsTools"], id, "supportsTools", "omniroute-catalog", diagnostics);
		const supportsTools = preferBoolean("supportsTools", id, liveTools, catalogTools, externalTools, diagnostics);

		const externalThinking = externalField(candidates, "thinking", entry => {
			const capabilities = record(entry.capabilities) ? entry.capabilities : undefined;
			return normalizedThinking(capabilities?.thinking);
		}, id, diagnostics);
		const liveThinking = preferThinking(id, normalizedThinking(raw.thinking), normalizedThinking(liveCapabilities?.thinking), undefined, diagnostics);
		const catalogThinking = preferThinking(id, normalizedThinking(catalog?.thinking), normalizedThinking(catalogCapabilities?.thinking), undefined, diagnostics);
		let thinking = preferThinking(id, liveThinking, catalogThinking, externalThinking, diagnostics);
		let resolvedReasoning = reasoning ?? false;
		if (thinking && reasoning === undefined) resolvedReasoning = true;
		if (reasoning === false && thinking) {
			diagnostics.push({ code: "capability_source_conflict", modelId: id, detail: "reasoning/thinking" });
			thinking = undefined;
		}
		if (reasoning === undefined && !thinking) diagnostics.push({ code: "reasoning_unverified", modelId: id, detail: "reasoning defaults to false" });
		if (!thinking) diagnostics.push({ code: "thinking_tiers_unverified", modelId: id });
		if (supportsTools === undefined) diagnostics.push({ code: "tools_unverified", modelId: id, detail: "supportsTools omitted; host defaults may apply" });

		const externalModalities = externalField(candidates, "input_modalities", entry => normalizedModalities(entry.input_modalities), id, diagnostics);
		const liveModalities = Array.isArray(raw.input_modalities) ? normalizedModalities(raw.input_modalities) : undefined;
		const catalogModalities = Array.isArray(catalog?.input_modalities) ? normalizedModalities(catalog.input_modalities) : undefined;
		const selectedModalities = liveModalities ?? catalogModalities ?? externalModalities;
		const modalitySource = liveModalities !== undefined ? "live" : catalogModalities !== undefined ? "omniroute-catalog" : externalModalities !== undefined ? "external" : "chat-default";
		const unhandledModalities = selectedModalities?.filter(modality => !INPUT_MODALITY_NAMES[modality]) ?? [];
		if (unhandledModalities.length > 0) diagnostics.push({ code: "unsupported_input_modalities", modelId: id, source: modalitySource, detail: unhandledModalities.slice(0, 8).join(",") });
		let input: ("text" | "image")[] = [];
		if (selectedModalities === undefined) input = ["text"];
		else {
			if (selectedModalities.includes("text")) input.push("text");
			if (selectedModalities.includes("image")) input.push("image");
		}
		if (input.length === 0 && modalitySource === "external") {
			diagnostics.push({ code: "external_input_modalities_unusable", modelId: id });
			input = ["text"];
		}
		if (input.length === 0) {
			diagnostics.push({ code: "unsupported_input_modalities", modelId: id, source: modalitySource });
			continue;
		}

		const inspection = inspectSellerPrice(raw, options.pricing, options.pricingCurrent === true, options.now);
		pricing.set(id, inspection);
		counts[inspection.state]++;
		models.push(providerModel(
			id,
			name,
			inspection.cost,
			options.stale === true,
			endpoint.api,
			endpoint.kind,
			resolvedReasoning,
			thinking,
			supportsTools,
			input,
			resolvedContext,
			resolvedOutput,
		));
		if (!endpoint.explicit) diagnostics.push({ code: "endpoint_unverified_default", modelId: id });
	}
	if (payload.data.length > 0 && malformed === payload.data.length) throw new CatalogError("invalid_live_data");
	if (malformed) diagnostics.push({ code: "malformed_rows", detail: String(malformed) });
	if (duplicates) diagnostics.push({ code: "duplicate_rows", detail: String(duplicates) });
	return { rows, models, pricing, diagnostics, counts };
}

export const normalizeCatalog = projectCatalog;
export const toProviderModels = projectCatalog;

export const parseCatalog = projectCatalog;