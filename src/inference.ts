import { createAssistantMessageEventStream, streamSimple, type Api, type AssistantMessageEventStream, type AssistantMessageEvent, type Context, type Model, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { EndpointApi } from "./catalog.ts";

export const OMNIROUTE_GUARDED_API = "omniroute-native-guard" as Api;

export interface InferenceBinding {
  readonly endpoint: string;
  readonly credential: string;
  readonly generation: number;
}

export interface BoundInferenceOptions {
  expectedApi?: Api;
  expectedEndpoint: string;
  expectedGeneration: number;
  currentBinding(): InferenceBinding | undefined;
  currentModelApi(id: string): EndpointApi | undefined;
  currentSignal(): AbortSignal | undefined;
  stopped(): boolean;
  reconnectSettings?(): ReconnectSettings;
}

export interface ReconnectSettings {
  maxAttempts: number;
  delayMs: number;
}

export function parseReconnectSettings(settings: Record<string, unknown>): ReconnectSettings {
  const integer = (value: unknown, max: number, fallback: number): number =>
    typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max ? value : fallback;
  return { maxAttempts: integer(settings.reconnectMaxAttempts, 20, 5), delayMs: integer(settings.reconnectDelayMs, 300000, 30000) };
}

function retryableFailure(status: number | undefined, message: string | undefined): boolean {
  if (status !== undefined) return status === 408 || status === 500 || status === 502 || status === 503 || status === 504;
  return /(?:ECONNREFUSED|ConnectionRefused|ECONNRESET|ETIMEDOUT|UND_ERR_(?:SOCKET|CONNECT_TIMEOUT|HEADERS_TIMEOUT|BODY_TIMEOUT)|EPIPE|ENOTFOUND|EAI_AGAIN|socket (?:closed|hang up)|connection (?:refused|reset|closed|failed)|fetch failed|network[_ ]error|unexpected (?:eof|end)|stream (?:closed before|ended without)|terminated)/i.test(message ?? "");
}

function reconnectWait(ms: number, signal: AbortSignal): Promise<void> {
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  if (signal.aborted) { reject(signal.reason); return promise; }
  const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
  const abort = () => { clearTimeout(timer); reject(signal.reason); };
  signal.addEventListener("abort", abort, { once: true });
  return promise;
}

function endpointApiRoot(endpoint: string): URL {
  const url = new URL(endpoint);
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    hasUrlUserInfo(endpoint) ||
    url.username ||
    url.password ||
    endpoint.includes("?") ||
    endpoint.includes("#") ||
    url.search ||
    url.hash
  ) throw inferenceError("inference endpoint contains forbidden URL components", "inference-target-mismatch");
  const path = url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "");
  url.pathname = `${path}/v1/`;
  return url;
}

function inferenceError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

function hasUrlUserInfo(value: string): boolean {
  const schemeEnd = value.indexOf("://");
  if (schemeEnd < 0) return false;
  const authority = value.slice(schemeEnd + 3).split(/[/?#]/, 1)[0] ?? "";
  return authority.includes("@");
}

function composeAbortSignals(...signals: Array<AbortSignal | undefined>): { signal: AbortSignal; cleanup(): void } {
  const controller = new AbortController();
  const active = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  let cleaned = false;
  function abort(event: Event): void {
    if (!controller.signal.aborted) controller.abort((event.target as AbortSignal).reason);
  }
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    for (const signal of active) signal.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", cleanup);
  };
  controller.signal.addEventListener("abort", cleanup, { once: true });
  for (const signal of active) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    signal.addEventListener("abort", abort, { once: true });
  }


  return { signal: controller.signal, cleanup };
}

interface NativeModelCacheEntry {
  api: EndpointApi;
  baseUrl: string;
  generation: number;
  compatConfig: Model<Api>["compatConfig"];
  model: Model<Api>;
}

const nativeModelCache = new WeakMap<Model<Api>, NativeModelCacheEntry>();

function materializeNativeModel(model: Model<Api>, api: EndpointApi, baseUrl: string, generation: number): Model<Api> {
  const cached = nativeModelCache.get(model);
  if (
    cached?.api === api &&
    cached.baseUrl === baseUrl &&
    cached.generation === generation &&
    cached.compatConfig === model.compatConfig
  ) return cached.model;
  const nativeModel = buildModel<Api>({
    ...model,
    api,
    baseUrl,
    compat: model.compatConfig,
  });
  nativeModelCache.set(model, { api, baseUrl, generation, compatConfig: model.compatConfig, model: nativeModel });
  return nativeModel;
}

export function createSingleDispatchFetch(
  endpoint: string,
  api: EndpointApi,
  baseFetch: typeof fetch = globalThis.fetch,
  canDispatch?: () => boolean,
  boundCredential?: string,
): typeof fetch {
  const root = endpointApiRoot(endpoint);
  const targetPath = `${root.pathname}${api === "openai-responses" ? "responses" : "chat/completions"}`;
  let attempts = 0;
  const guarded: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    attempts++;
    if (attempts > 1) throw inferenceError("inference replay suppressed", "inference-replay-suppressed");
    const rawUrl = input instanceof Request ? input.url : String(input);
    if (hasUrlUserInfo(rawUrl)) throw inferenceError("inference target contains URL credentials", "inference-target-mismatch");
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw inferenceError("inference target changed", "inference-target-mismatch");
    }
    const method = (init?.method ?? (input instanceof Request ? input.method : "GET")).toUpperCase();
    if (
      method !== "POST" ||
      url.origin !== root.origin ||
      url.username ||
      url.password ||
      rawUrl.includes("?") ||
      rawUrl.includes("#") ||
      url.search ||
      url.hash ||
      url.pathname !== targetPath
    ) throw inferenceError("inference target changed", "inference-target-mismatch");
    if (init?.signal?.aborted || (input instanceof Request && input.signal.aborted)) {
      throw inferenceError("inference aborted", "aborted");
    }
    if (canDispatch && !canDispatch()) throw inferenceError("OmniRoute inference binding is no longer active", "inference-binding-invalid");

    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
    if (boundCredential !== undefined) headers.set("authorization", `Bearer ${boundCredential}`);
    const response = await baseFetch(input, { ...init, headers, redirect: "manual" });
    if (response.status >= 300 && response.status < 400) {
      try { await response.body?.cancel(); } catch { /* best effort */ }
      throw inferenceError("inference redirect rejected", "inference-redirect");
    }
    return response;
  }, { preconnect: baseFetch.preconnect });
  return guarded;
}

export function createBoundInferenceStream(options: BoundInferenceOptions) {
  return (model: Model<Api>, context: Context, streamOptions?: SimpleStreamOptions): AssistantMessageEventStream => {
    if (model.api !== (options.expectedApi ?? OMNIROUTE_GUARDED_API)) {
      throw inferenceError("model does not use the guarded OmniRoute API", "inference-model-invalid");
    }
    const binding = options.currentBinding();
    const generationSignal = options.currentSignal();
    if (
      options.stopped() ||
      !binding ||
      binding.endpoint !== options.expectedEndpoint ||
      binding.generation !== options.expectedGeneration ||
      !generationSignal ||
      generationSignal.aborted
    ) throw inferenceError("OmniRoute inference binding is no longer active", "inference-binding-invalid");
    if (streamOptions?.signal?.aborted) throw inferenceError("inference aborted", "aborted");

    const nativeApi = options.currentModelApi(model.id);
    if (!nativeApi) throw inferenceError("model is not in the validated live catalog", "inference-model-invalid");
    const isCurrent = () => {
      const current = options.currentBinding();
      return !options.stopped() && !generationSignal.aborted && options.currentSignal() === generationSignal && current !== undefined && current.endpoint === binding.endpoint && current.generation === binding.generation && current.credential === binding.credential && options.currentModelApi(model.id) === nativeApi;
    };
    const settings = options.reconnectSettings?.() ?? { maxAttempts: 5, delayMs: 30000 };
    const outer = createAssistantMessageEventStream();
    const composed = composeAbortSignals(streamOptions?.signal, generationSignal);
    void (async () => {
      try {
        for (let attempt = 1; attempt <= settings.maxAttempts; attempt++) {
          if (!isCurrent() || composed.signal.aborted) throw inferenceError("OmniRoute inference binding is no longer active", "inference-binding-invalid");
          const attemptSignal = composeAbortSignals(composed.signal);
          let status: number | undefined;
          let transportMessage: string | undefined;
          const baseFetch = streamOptions?.fetch ?? globalThis.fetch;
          const observedFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            try {
              const response = await baseFetch(input, init);
              if (!response.ok) status = response.status;
              return response;
            } catch (error) {
              const details: string[] = [];
              for (let cause: unknown = error, depth = 0; cause && typeof cause === "object" && depth < 4; depth++) {
                if ("message" in cause && typeof cause.message === "string") details.push(cause.message);
                if ("code" in cause && typeof cause.code === "string") details.push(cause.code);
                cause = "cause" in cause ? cause.cause : undefined;
              }
              transportMessage = details.join(" ");
              throw error;
            }
          }, { preconnect: baseFetch.preconnect });
          const nativeModel = materializeNativeModel(model, nativeApi, endpointApiRoot(binding.endpoint).toString().replace(/\/$/, ""), binding.generation);
          let terminal: Extract<AssistantMessageEvent, { type: "done" | "error" }> | undefined;
          try {
            const inner = streamSimple(nativeModel, context, {
              ...streamOptions, signal: attemptSignal.signal, apiKey: binding.credential,
              fetch: createSingleDispatchFetch(binding.endpoint, nativeApi, observedFetch, isCurrent, binding.credential),
              statefulResponses: false, preferWebsockets: false, maxHttpAttempts: 1, acceptEmptyResponse: true,
            });
            for await (const event of inner) {
              if (event.type === "done" || event.type === "error") { terminal = event; break; }
            }
            if (!terminal) throw inferenceError("inference stream ended without a result", "inference-stream-ended");
          } catch (error) {
            attemptSignal.cleanup();
            const message = error instanceof Error ? error.message : "";
            if (!composed.signal.aborted && isCurrent() && retryableFailure(status, transportMessage || message)) {
              if (attempt < settings.maxAttempts) {
                await reconnectWait(settings.delayMs, composed.signal);
                continue;
              }
              throw inferenceError(`OmniRoute inference reconnect attempts exhausted (${settings.maxAttempts})`, "inference-attempts-exhausted");
            }
            throw error;
          } finally { attemptSignal.cleanup(); }
          if (terminal.type === "done") {
            if (!isCurrent() || composed.signal.aborted) throw inferenceError("OmniRoute inference binding is no longer active", "inference-binding-invalid");
            outer.push(terminal);
            return;
          }
          const recoverable = !composed.signal.aborted && isCurrent() && retryableFailure(status ?? terminal.error.errorStatus, transportMessage || terminal.error.errorMessage);
          if (recoverable && attempt < settings.maxAttempts) {
            try { await reconnectWait(settings.delayMs, composed.signal); } catch { /* handled below */ }
            if (!composed.signal.aborted && isCurrent()) continue;
          }
          const error = { ...terminal.error, content: [] };
          if (composed.signal.aborted) { error.stopReason = "aborted"; error.errorMessage = "OmniRoute inference cancelled"; delete error.errorId; delete error.errorStatus; }
          else if (!isCurrent()) { error.errorMessage = "OmniRoute inference binding is no longer active"; delete error.errorId; delete error.errorStatus; }
          else if (recoverable) { error.errorMessage = `OmniRoute inference reconnect attempts exhausted (${settings.maxAttempts}); last failure category: ${status ? "gateway" : "transport"}`; delete error.errorId; delete error.errorStatus; }
          if (composed.signal.aborted || !isCurrent() || recoverable) delete error.errorClassificationMessage;
          outer.push({ type: "error", reason: error.stopReason === "aborted" ? "aborted" : "error", error });
          return;
        }
      } catch (error) { outer.fail(error); }
      finally { composed.cleanup(); }
    })();
    return outer;
  };
}
