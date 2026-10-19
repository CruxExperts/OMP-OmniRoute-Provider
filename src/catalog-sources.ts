import { THINKING_EFFORTS, type Effort, type ThinkingConfig } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { requestJsonWithDigest, TransportError, type RequestTarget } from "./transport.ts";

export const CATALOG_SOURCE_IDS = ["models.dev", "openrouter"] as const;
export type CatalogSourceId = (typeof CATALOG_SOURCE_IDS)[number];

export interface CatalogCapabilityMetadata {
  reasoning?: boolean;
  supportsTools?: boolean;
  thinking?: ThinkingConfig;
}

/** External metadata is identity-bound and can never introduce a runnable model or cost. */
export interface CatalogMetadataEntry {
  /** Exact OmniRoute `/v1/models` owner proven by the pinned provider/catalog source. */
  owner: string;
  /** Exact live model ID; source prefixes are preserved. */
  id: string;
  /** Canonical source-side identity, kept separate from the live owner. */
  sourceOwner: string;
  sourceId: string;
  name?: string;
  context_length?: number;
  max_output_tokens?: number;
  input_modalities?: readonly string[];
  output_modalities?: readonly string[];
  capabilities?: CatalogCapabilityMetadata;
}

export interface CatalogSourceDiagnostic {
  code: string;
  detail?: string;
}

export interface CatalogMetadataSnapshot {
  source: CatalogSourceId;
  fetchedAt: number;
  expiresAt: number;
  digest: string;
  entries: readonly CatalogMetadataEntry[];
  diagnostics?: readonly CatalogSourceDiagnostic[];
}

export interface CatalogSourceStatus {
  source: CatalogSourceId;
  state: "usable" | "stale" | "unavailable";
  fetchedAt?: number;
  expiresAt?: number;
  errorCode?: string;
}

export class CatalogSourceError extends Error {
  readonly name = "CatalogSourceError";
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

const SOURCE_TARGETS: Record<CatalogSourceId, RequestTarget> = {
  "models.dev": { endpoint: "https://models.dev", path: "/api.json", query: "type=all" },
  openrouter: { endpoint: "https://openrouter.ai", path: "/api/v1/models", query: "output_modalities=all" },
};
const SOURCE_LIMITS = { timeoutMs: 5_000, totalBudgetMs: 5_000, maxBytes: 8 * 1024 * 1024, maxDepth: 24 } as const;
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
const MAX_NORMALIZED_ENTRIES = 100_000;
const EFFORT_ORDER = THINKING_EFFORTS;
const EFFORT_BY_NAME: Record<string, Effort> = {};
for (const effort of EFFORT_ORDER) EFFORT_BY_NAME[effort] = effort;

// These provider IDs are exact entries in the pinned OmniRoute 3.8.51 API-key
// provider registry. No aliases, URL-derived owners, or model-prefix stripping.
const MODELS_DEV_OWNER_MAP: Record<string, string> = {
  anthropic: "anthropic",
  deepseek: "deepseek",
  groq: "groq",
  mistral: "mistral",
  openai: "openai",
  openrouter: "openrouter",
  xai: "xai",
};
// OmniRoute 3.8.51's openrouterCatalog fetches OpenRouter model IDs verbatim;
// its pinned provider definition is exactly id="openrouter" with passthroughModels.
const OPENROUTER_OWNER_MAP: Record<string, string> = { openrouter: "openrouter" };

interface Flight {
  controller: AbortController;
  promise: Promise<CatalogMetadataSnapshot>;
  waiters: number;
  settled: boolean;
}

const snapshots = new Map<CatalogSourceId, CatalogMetadataSnapshot>();
const flights = new Map<CatalogSourceId, Flight>();
const failures = new Map<CatalogSourceId, string>();

const ALLOWED_MODALITIES: Record<string, true> = {
  text: true, image: true, audio: true, video: true, pdf: true, file: true,
  embeddings: true, rerank: true, speech: true, transcription: true, decisions: true,
};

function boundedText(value: unknown, maxLength = 512): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value || value.length > maxLength) return undefined;
  return value;
}

function positiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}

function normalizedModalities(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item === "string" && item.length <= 32 && ALLOWED_MODALITIES[item]) seen.add(item);
  }
  return seen.size > 0 ? [...seen].sort() : [];
}

function effortName(value: unknown): (typeof EFFORT_ORDER)[number] | undefined {
  return typeof value === "string" ? EFFORT_BY_NAME[value] : undefined;
}

function thinkingEfforts(values: unknown, defaultLevel?: unknown): ThinkingConfig | undefined {
  if (!Array.isArray(values)) return undefined;
  const supported = new Set<(typeof EFFORT_ORDER)[number]>();
  for (const value of values) {
    const effort = effortName(value);
    if (effort) supported.add(effort);
  }
  const efforts = EFFORT_ORDER.filter(effort => supported.has(effort));
  if (efforts.length === 0) return undefined;
  const defaultEffort = effortName(defaultLevel);
  return { mode: "effort", efforts, ...(defaultEffort && efforts.includes(defaultEffort) ? { defaultLevel: defaultEffort } : {}) };
}

function capabilitiesFromModelsDev(row: Record<string, unknown>): CatalogCapabilityMetadata | undefined {
  const result: CatalogCapabilityMetadata = {};
  if (typeof row.reasoning === "boolean") result.reasoning = row.reasoning;
  if (typeof row.tool_call === "boolean") result.supportsTools = row.tool_call;
  if (Array.isArray(row.reasoning_options)) {
    const options = row.reasoning_options.filter(isRecord);
    const effortOption = options.find(option => option.type === "effort");
    const thinking = thinkingEfforts(effortOption?.values);
    if (thinking) {
      result.thinking = thinking;
      if (result.reasoning !== false) result.reasoning = true;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function capabilitiesFromOpenRouter(row: Record<string, unknown>): CatalogCapabilityMetadata | undefined {
  const result: CatalogCapabilityMetadata = {};
  const parameters = Array.isArray(row.supported_parameters) ? row.supported_parameters : [];
  if (typeof row.supportsTools === "boolean") result.supportsTools = row.supportsTools;
  if (parameters.includes("tools") && result.supportsTools !== false) result.supportsTools = true;
  if (typeof row.reasoning === "boolean") result.reasoning = row.reasoning;
  const reasoning = isRecord(row.reasoning) ? row.reasoning : undefined;
  const efforts = thinkingEfforts(reasoning?.supported_efforts, reasoning?.default_effort);
  if (efforts) {
    if (result.reasoning !== false) result.reasoning = true;
    result.thinking = efforts;
  } else if ((parameters.includes("reasoning") || parameters.includes("reasoning_effort")) && result.reasoning !== false) {
    result.reasoning = true;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// Pinned OmniRoute v3.8.51 `catalogOpenrouter.ts` applies this exact ID rule.
function openRouterLiveId(sourceId: string): string {
  return sourceId.startsWith("openrouter/") ? sourceId : `openrouter/${sourceId}`;
}

function exactEntry(
  sourceOwner: string,
  sourceId: string,
  owner: string | undefined,
  id: string,
  fields: Omit<CatalogMetadataEntry, "owner" | "id" | "sourceOwner" | "sourceId">,
): CatalogMetadataEntry | undefined {
  if (!owner) return undefined;
  return {
    owner,
    id,
    sourceOwner,
    sourceId,
    ...fields,
  };
}

function appendExactEntry(entries: Map<string, CatalogMetadataEntry>, entry: CatalogMetadataEntry): void {
  const key = `${entry.owner}\u0000${entry.id}`;
  const previous = entries.get(key);
  if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) {
    throw new CatalogSourceError("duplicate-identity-conflict", "source contains conflicting duplicate model identities");
  }
  entries.set(key, entry);
  if (entries.size > MAX_NORMALIZED_ENTRIES) throw new CatalogSourceError("invalid-catalog", "source contains too many model entries");
}

function parseModelsDev(payload: unknown): { entries: CatalogMetadataEntry[]; diagnostics: CatalogSourceDiagnostic[] } {
  if (!isRecord(payload)) throw new CatalogSourceError("invalid-catalog", "Models.dev payload is not a provider map");
  const entries = new Map<string, CatalogMetadataEntry>();
  const diagnostics: CatalogSourceDiagnostic[] = [];
  let malformed = 0;
  let unmappedProviders = 0;
  let mappedRows = 0;
  for (const [sourceOwner, providerValue] of Object.entries(payload)) {
    if (!isRecord(providerValue) || providerValue.id !== sourceOwner || !isRecord(providerValue.models)) {
      malformed++;
      continue;
    }
    const owner = MODELS_DEV_OWNER_MAP[sourceOwner];
    if (!owner) {
      unmappedProviders++;
      continue;
    }
    for (const [sourceId, modelValue] of Object.entries(providerValue.models)) {
      if (!isRecord(modelValue) || modelValue.id !== sourceId) {
        malformed++;
        continue;
      }
      mappedRows++;
      const modalities = isRecord(modelValue.modalities) ? modelValue.modalities : undefined;
      const limit = isRecord(modelValue.limit) ? modelValue.limit : undefined;
      const name = boundedText(modelValue.name, 256);
      const contextLength = positiveInteger(limit?.context);
      const maxOutputTokens = positiveInteger(limit?.output);
      const inputModalities = normalizedModalities(modalities?.input);
      const outputModalities = normalizedModalities(modalities?.output);
      const capabilities = capabilitiesFromModelsDev(modelValue);
      const liveId = owner === "openrouter" ? openRouterLiveId(sourceId) : sourceId;
      const entry = exactEntry(sourceOwner, sourceId, owner, liveId, {
        ...(name ? { name } : {}),
        ...(contextLength ? { context_length: contextLength } : {}),
        ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
        ...(inputModalities !== undefined ? { input_modalities: inputModalities } : {}),
        ...(outputModalities !== undefined ? { output_modalities: outputModalities } : {}),
        ...(capabilities ? { capabilities } : {}),
      });
      if (entry) appendExactEntry(entries, entry);
    }
  }
  if (malformed > 0 && mappedRows === 0 && Object.keys(payload).length > 0) {
    throw new CatalogSourceError("invalid-catalog", "Models.dev payload has no valid mapped rows");
  }
  if (malformed) diagnostics.push({ code: "malformed_rows", detail: String(malformed) });
  if (unmappedProviders) diagnostics.push({ code: "unmapped_provider_groups", detail: String(unmappedProviders) });
  return { entries: [...entries.values()], diagnostics };
}

function parseOpenRouter(payload: unknown): { entries: CatalogMetadataEntry[]; diagnostics: CatalogSourceDiagnostic[] } {
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new CatalogSourceError("invalid-catalog", "OpenRouter payload has no model list");
  const entries = new Map<string, CatalogMetadataEntry>();
  const diagnostics: CatalogSourceDiagnostic[] = [];
  let malformed = 0;
  let mappedRows = 0;
  for (const row of payload.data) {
    if (!isRecord(row)) {
      malformed++;
      continue;
    }
    const sourceId = boundedText(row.id);
    if (!sourceId) {
      malformed++;
      continue;
    }
    mappedRows++;
    const owner = OPENROUTER_OWNER_MAP.openrouter;
    const architecture = isRecord(row.architecture) ? row.architecture : undefined;
    const provider = isRecord(row.top_provider) ? row.top_provider : undefined;
    const name = boundedText(row.name, 256);
    const contextLength = positiveInteger(row.context_length);
    const maxOutputTokens = positiveInteger(provider?.max_completion_tokens);
    const inputModalities = normalizedModalities(architecture?.input_modalities);
    const outputModalities = normalizedModalities(architecture?.output_modalities);
    const capabilities = capabilitiesFromOpenRouter(row);
    const entry = exactEntry("openrouter", sourceId, owner, openRouterLiveId(sourceId), {
      ...(name ? { name } : {}),
      ...(contextLength ? { context_length: contextLength } : {}),
      ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
      ...(inputModalities !== undefined ? { input_modalities: inputModalities } : {}),
      ...(outputModalities !== undefined ? { output_modalities: outputModalities } : {}),
      ...(capabilities ? { capabilities } : {}),
    });
    if (entry) appendExactEntry(entries, entry);
  }
  if (malformed > 0 && mappedRows === 0 && payload.data.length > 0) {
    throw new CatalogSourceError("invalid-catalog", "OpenRouter payload has no valid model rows");
  }
  if (malformed) diagnostics.push({ code: "malformed_rows", detail: String(malformed) });
  return { entries: [...entries.values()], diagnostics };
}

function freezeEntry(entry: CatalogMetadataEntry): CatalogMetadataEntry {
  const thinking = entry.capabilities?.thinking;
  const capabilities = entry.capabilities
    ? Object.freeze({
        ...entry.capabilities,
        ...(thinking ? { thinking: Object.freeze({ ...thinking, efforts: Object.freeze([...thinking.efforts]) }) } : {}),
      })
    : undefined;
  return Object.freeze({
    ...entry,
    ...(entry.input_modalities ? { input_modalities: Object.freeze([...entry.input_modalities]) } : {}),
    ...(entry.output_modalities ? { output_modalities: Object.freeze([...entry.output_modalities]) } : {}),
    ...(capabilities ? { capabilities } : {}),
  });
}

function parseSnapshot(source: CatalogSourceId, payload: unknown, fetchedAt: number, digest: string): CatalogMetadataSnapshot {
  const parsed = source === "models.dev" ? parseModelsDev(payload) : parseOpenRouter(payload);
  const entries = Object.freeze(parsed.entries.map(freezeEntry));
  const diagnostics = parsed.diagnostics.map(item => Object.freeze({ ...item }));
  return Object.freeze({
    source,
    fetchedAt,
    expiresAt: fetchedAt + CACHE_TTL_MS,
    digest,
    entries,
    ...(diagnostics.length > 0 ? { diagnostics: Object.freeze(diagnostics) } : {}),
  });
}

async function requestPublicCatalog(source: CatalogSourceId, signal: AbortSignal): Promise<{ payload: unknown; digest: string }> {
  const request = await requestJsonWithDigest({ ...SOURCE_TARGETS[source], credentials: "omit" }, undefined, SOURCE_LIMITS, signal);
  return { payload: request.value, digest: request.sha256 };
}

function failureCode(error: unknown): string {
  if (error instanceof CatalogSourceError) return error.code;
  if (error instanceof TransportError) return error.code;
  return "source-failure";
}

function createFlight(source: CatalogSourceId): Flight {
  const controller = new AbortController();
  const deferred = Promise.withResolvers<CatalogMetadataSnapshot>();
  const flight: Flight = { controller, promise: deferred.promise, waiters: 0, settled: false };
  flights.set(source, flight);
  void flight.promise.catch(() => undefined);
  void (async () => {
    try {
      const response = await requestPublicCatalog(source, controller.signal);
      const snapshot = parseSnapshot(source, response.payload, Date.now(), response.digest);
      snapshots.set(source, snapshot);
      failures.delete(source);
      deferred.resolve(snapshot);
    } catch (error) {
      failures.set(source, failureCode(error));
      deferred.reject(error instanceof CatalogSourceError ? error : new CatalogSourceError(failureCode(error), "optional catalog source is unavailable", { cause: error }));
    } finally {
      flight.settled = true;
      if (flights.get(source) === flight) flights.delete(source);
    }
  })();
  return flight;
}

function waitForFlight(flight: Flight, signal: AbortSignal): Promise<CatalogMetadataSnapshot> {
  if (signal.aborted) return Promise.reject(new CatalogSourceError("aborted", "catalog request cancelled"));
  const deferred = Promise.withResolvers<CatalogMetadataSnapshot>();
  flight.waiters++;
  let finished = false;
  const release = (): void => {
    signal.removeEventListener("abort", onAbort);
    flight.waiters--;
    if (flight.waiters === 0 && !flight.settled) flight.controller.abort();
  };
  const onAbort = (): void => {
    if (finished) return;
    finished = true;
    release();
    deferred.reject(new CatalogSourceError("aborted", "catalog request cancelled"));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  flight.promise.then(snapshot => {
    if (finished) return;
    finished = true;
    release();
    deferred.resolve(snapshot);
  }, error => {
    if (finished) return;
    finished = true;
    release();
    deferred.reject(error);
  });
  return deferred.promise;
}

export async function loadCatalogMetadata(source: CatalogSourceId, signal: AbortSignal): Promise<CatalogMetadataSnapshot> {
  if (signal.aborted) throw new CatalogSourceError("aborted", "catalog request cancelled");
  if (!CATALOG_SOURCE_IDS.includes(source)) throw new CatalogSourceError("invalid-source", "unknown catalog source");
  const cached = snapshots.get(source);
  if (cached && cached.expiresAt > Date.now()) return cached;
  const flight = flights.get(source) ?? createFlight(source);
  try {
    return await waitForFlight(flight, signal);
  } catch (error) {
    if (!(error instanceof CatalogSourceError) || error.code !== "aborted" || signal.aborted || !flight.controller.signal.aborted) throw error;
    await flight.promise.then(() => undefined, () => undefined);
    return loadCatalogMetadata(source, signal);
  }
}

/** Read-only status lookup; this function never starts or refreshes a request. */
export function getCatalogSourceStatus(source: CatalogSourceId): CatalogSourceStatus {
  const snapshot = snapshots.get(source);
  const errorCode = failures.get(source);
  if (snapshot) {
    const state = snapshot.expiresAt > Date.now() ? "usable" : "stale";
    return {
      source,
      state,
      fetchedAt: snapshot.fetchedAt,
      expiresAt: snapshot.expiresAt,
      ...(errorCode ? { errorCode } : {}),
    };
  }
  return { source, state: "unavailable", errorCode: errorCode ?? "not-loaded" };
}
