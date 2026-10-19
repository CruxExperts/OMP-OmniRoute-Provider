import { streamSimple, type Api, type AssistantMessageEventStream, type Context, type Model, type SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { EndpointApi } from "./catalog.ts";

export const OMNIROUTE_GUARDED_API = "omniroute-native-guard" as Api;

export interface InferenceBinding {
  readonly endpoint: string;
  readonly credential: string;
  readonly generation: number;
}

export interface BoundInferenceOptions {
  expectedEndpoint: string;
  expectedGeneration: number;
  currentBinding(): InferenceBinding | undefined;
  currentModelApi(id: string): EndpointApi | undefined;
  currentSignal(): AbortSignal | undefined;
  stopped(): boolean;
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
    if (model.api !== OMNIROUTE_GUARDED_API) {
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
    const apiRoot = endpointApiRoot(binding.endpoint).toString().replace(/\/$/, "");
    const composed = composeAbortSignals(streamOptions?.signal, generationSignal);
    let stream: AssistantMessageEventStream;
    try {
      const nativeModel = materializeNativeModel(model, nativeApi, apiRoot, binding.generation);
      stream = streamSimple(nativeModel, context, {
        ...streamOptions,
        signal: composed.signal,
        apiKey: binding.credential,
        fetch: createSingleDispatchFetch(binding.endpoint, nativeApi, streamOptions?.fetch ?? globalThis.fetch, () => {
          const current = options.currentBinding();
          return !options.stopped() &&
            !generationSignal.aborted &&
            options.currentSignal() === generationSignal &&
            current !== undefined &&
            current.endpoint === binding.endpoint &&
            current.generation === binding.generation &&
            options.currentModelApi(model.id) === nativeApi;
        }, binding.credential),
        statefulResponses: false,
        preferWebsockets: false,
      });
    } catch (error) {
      composed.cleanup();
      throw error;
    }
    void stream.result().then(composed.cleanup, composed.cleanup);
    return stream;
  };
}
