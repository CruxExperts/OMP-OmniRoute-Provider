import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { projectCatalog } from "./catalog.ts";
import {
  ENDPOINT_EXAMPLE,
  ENDPOINT_INPUT_HELP,
  ConfigError,
  commitPendingConfig,
  type PendingBinding,
  type PluginConfig,
  isEnvironmentRuntimeSelected,
  loadConfig,
  normalizeEndpointInput,
  resolveEnvironmentEndpointPrefill,
  resolveEnvironmentBinding,
  savePendingConfig,
} from "./config.ts";
import { requestJson, TransportError } from "./transport.ts";

export const PROVIDER_ID = "omniroute";

export type AuthErrorCode =
  | "cancelled"
  | "invalid-input"
  | "unauthorized"
  | "validation-failed"
  | "verification-unavailable"
  | "invalid-response"
  | "invalid-catalog"
  | "network-failure"
  /** @deprecated Environment-bound login errors are no longer emitted. */
  | "environment-bound"
  | "persistence-failed";

export class AuthError extends Error {
  readonly name = "AuthError";
  constructor(readonly code: AuthErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
  }
}

export interface OAuthPromptOptions {
  message: string;
  secret?: boolean;
  placeholder?: string;
  initialValue?: string;
}

export interface OAuthLoginCallbacks {
  signal?: AbortSignal;
  onPrompt(options: OAuthPromptOptions): Promise<string | undefined | null> | string | undefined | null;
  onConfirm?(options: { message: string; detail?: string }): Promise<boolean> | boolean;
  onMessage?(message: string, kind?: "info" | "warning" | "error"): Promise<void> | void;
}

export interface NativeLoginOptions {
  providerName?: string;
  onSetupComplete?: (endpoint: string, credential: string) => Promise<void> | void;
  load?: () => Promise<PluginConfig>;
  request?: typeof requestJson;
}

export interface NativeLoginProvider {
  name: string;
  login(callbacks: OAuthLoginCallbacks): Promise<string>;
}

export interface ModelRegistryCredentialReader {
  getApiKeyForProvider(name: string): Promise<string | undefined> | string | undefined;
  authStorage?: { credentials: Pick<AuthStorage["credentials"], "get"> };
}

type StartupAuthStorage = {
  credentials: Pick<AuthStorage["credentials"], "get">;
  keys: Pick<AuthStorage["keys"], "peek">;
  close(): void;
};

function readNativeApiKey(credentials: Pick<AuthStorage["credentials"], "get">): string | undefined {
  const stored = credentials.get(PROVIDER_ID);
  return stored?.type === "api_key" && stored.key.trim() !== "" ? stored.key : undefined;
}

function awaitWithSignal<T>(
  operation: Promise<T>,
  signal: AbortSignal,
  onLateValue?: (value: T) => void,
  cancellationMessage = "native credential lookup cancelled",
): Promise<T> {
  const { promise, resolve, reject } = Promise.withResolvers<T>();
  let settled = false;
  const cleanup = (): void => signal.removeEventListener("abort", onAbort);
  const onAbort = (): void => {
    if (settled) return;
    settled = true;
    cleanup();
    reject(new AuthError("cancelled", cancellationMessage));
  };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  operation.then(
    value => {
      if (settled) {
        onLateValue?.(value);
        return;
      }
      settled = true;
      cleanup();
      resolve(value);
    },
    error => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    },
  );
  return promise;
}

/** Resolve the startup key without rotating it, using the selected source. */
export async function resolveStartupRuntimeCredential(
  discover: () => Promise<StartupAuthStorage>,
  signal: AbortSignal,
  config: Pick<PluginConfig, "runtimeSource">,
): Promise<string | undefined> {
  if (signal.aborted) throw new AuthError("cancelled", "native credential lookup cancelled");

  let storage: StartupAuthStorage | undefined;
  let closed = false;
  const close = (opened: StartupAuthStorage): void => {
    if (closed) return;
    closed = true;
    opened.close();
  };

  try {
    storage = await awaitWithSignal(discover(), signal, lateStorage => {
      try {
        close(lateStorage);
      } catch {
        // The cancelled caller has already settled; late close failures are contained.
      }
    });
    if (signal.aborted) throw new AuthError("cancelled", "native credential lookup cancelled");
    const lookup = config.runtimeSource === "native"
      ? Promise.resolve(readNativeApiKey(storage.credentials))
      : storage.keys.peek(PROVIDER_ID);
    const value = await awaitWithSignal(lookup, signal);
    if (signal.aborted) throw new AuthError("cancelled", "native credential lookup cancelled");
    return typeof value === "string" && value.trim() !== "" ? value : undefined;
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (signal.aborted) throw new AuthError("cancelled", "native credential lookup cancelled");
    throw new AuthError("persistence-failed", "unable to read native OmniRoute credentials");
  } finally {
    if (storage) {
      try {
        close(storage);
      } catch {
        if (!signal.aborted) throw new AuthError("persistence-failed", "unable to close native credential storage");
      }
    }
  }
}

interface PendingCandidate {
  endpoint: string;
  generation: number;
  key: string;
}

let pendingCandidate: PendingCandidate | undefined;

/** Forget the in-memory candidate so it cannot be reused after cancellation or shutdown. */
export function clearPendingCandidate(): void {
  pendingCandidate = undefined;
}


function promptValue(value: string | undefined | null, label: string): string {
  if (value === undefined || value === null) throw new AuthError("cancelled", `${label} prompt cancelled`);
  const trimmed = value.trim();
  if (!trimmed) throw new AuthError("invalid-input", `${label} is required`);
  return trimmed;
}

function checkCancelled(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AuthError("cancelled", "OmniRoute sign-in cancelled");
}

function loginStep<T>(value: Promise<T> | T, signal?: AbortSignal): Promise<T> {
  if (!signal) return Promise.resolve(value);
  return awaitWithSignal(Promise.resolve(value), signal, undefined, "OmniRoute sign-in cancelled");
}

function isRemoteHttp(endpoint: string): boolean {
  const url = new URL(endpoint);
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const octets = host.split(".");
  const loopbackV4 = octets.length === 4 && octets.every((part) => /^(?:0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255) && Number(octets[0]) === 127;
  const local = host === "localhost" || host === "localhost.localdomain" || host === "::1" || loopbackV4;
  return url.protocol === "http:" && !local;
}

async function confirmInsecure(callbacks: OAuthLoginCallbacks, endpoint: string): Promise<boolean> {
  if (!callbacks.onConfirm) return false;
  const result = await loginStep(callbacks.onConfirm({
    message: "Allow insecure remote HTTP for this OmniRoute endpoint?",
    detail: `${endpoint} sends the API key without TLS. The choice is saved for this profile.`,
  }), callbacks.signal);
  return result === true;
}


async function validateCandidate(endpoint: string, key: string, request: typeof requestJson, signal?: AbortSignal): Promise<{ raw: number; usable: number }> {
  checkCancelled(signal);
  // Persisted endpoints may include a /v1 suffix. Resolve protected and live
  // paths from the same gateway root used by runtime discovery.
  const root = endpoint.replace(/\/+$/, "").replace(/\/v1$/, "");
  try {
    // /v1/models can be public. This protected route validates every regular
    // and master API key in pinned OmniRoute 3.8.52 without an inference call.
    const proof = await request({ endpoint: root, path: "/api/cloud/auth", method: "POST" }, key,
      { totalBudgetMs: 10_000, maxBytes: 8 * 1024 * 1024, maxDepth: 24 }, signal);
    checkCancelled(signal);
    if (!proof || typeof proof !== "object" || Array.isArray(proof)
      || !Array.isArray((proof as { connections?: unknown }).connections)
      || !(proof as { modelAliases?: unknown }).modelAliases
      || typeof (proof as { modelAliases?: unknown }).modelAliases !== "object"
      || Array.isArray((proof as { modelAliases?: unknown }).modelAliases)) {
      throw new AuthError("invalid-response", "OmniRoute key verification returned an unexpected response");
    }
    // Do not retain or display the protected response: it may contain
    // connection metadata or masked credential fragments.
  } catch (error) {
    if (error instanceof AuthError) throw error;
    if (signal?.aborted || error instanceof TransportError && error.code === "aborted") throw new AuthError("cancelled", "OmniRoute sign-in cancelled");
    if (error instanceof TransportError && (error.status === 401 || error.status === 403)) throw new AuthError("unauthorized", "OmniRoute rejected this API key");
    if (error instanceof TransportError && (error.status === 404 || error.status === 405 || error.code === "redirect")) throw new AuthError("verification-unavailable", "OmniRoute key verification route is unavailable");
    if (error instanceof TransportError && ["timeout", "budget-exhausted"].includes(error.code)) throw new AuthError("network-failure", "OmniRoute key verification timed out");
    if (error instanceof TransportError && error.code === "tls") throw new AuthError("network-failure", "OmniRoute key verification TLS connection failed");
    if (error instanceof TransportError && ["network", "body-read"].includes(error.code)) throw new AuthError("network-failure", "OmniRoute key verification network connection failed");
    throw new AuthError("invalid-response", "OmniRoute key verification failed");
  }
  checkCancelled(signal);
  try {
    const catalog = await request({ endpoint: root, path: "/v1/models" }, key,
      { totalBudgetMs: 10_000, maxBytes: 8 * 1024 * 1024, maxDepth: 24 }, signal,
      { safeRead: true, maxRetries: 1 });
    checkCancelled(signal);
    const projection = projectCatalog(catalog);
    return { raw: projection.rows.size, usable: projection.models.length };
  } catch (error) {
    if (signal?.aborted || error instanceof TransportError && error.code === "aborted") throw new AuthError("cancelled", "OmniRoute sign-in cancelled");
    if (error instanceof TransportError && (error.status === 401 || error.status === 403)) throw new AuthError("unauthorized", "OmniRoute rejected model access for this API key");
    if (error instanceof TransportError && ["timeout", "budget-exhausted"].includes(error.code)) throw new AuthError("network-failure", "OmniRoute model catalog timed out");
    if (error instanceof TransportError && error.code === "tls") throw new AuthError("network-failure", "OmniRoute model catalog TLS connection failed");
    if (error instanceof TransportError && ["network", "body-read"].includes(error.code)) throw new AuthError("network-failure", "OmniRoute model catalog network connection failed");
    throw new AuthError("invalid-catalog", "OmniRoute live model catalog could not be validated");
  }
}

/**
 * Create the native OMP login adapter. No credential is persisted here: OMP's
 * AuthStorage owns the returned API key. The profile only receives a pending
 * endpoint marker, allowing refresh to commit it after native persistence.
 */
export function registerNativeLogin(options: NativeLoginOptions = {}): NativeLoginProvider {
  const name = options.providerName ?? PROVIDER_ID;
  const request = options.request ?? requestJson;
  const load = options.load ?? loadConfig;
  return {
    name,
    async login(callbacks: OAuthLoginCallbacks): Promise<string> {
      // A new attempt invalidates any unresolved candidate from an earlier
      // attempt. The candidate is retained only until native AuthStorage has
      // persisted it and recovery either commits or fails closed.
      clearPendingCandidate();
      checkCancelled(callbacks.signal);
      let config: PluginConfig;
      try {
        config = await load();
      } catch (error) {
        if (error instanceof ConfigError) throw new AuthError("persistence-failed", "unable to load OmniRoute profile configuration", { cause: error });
        throw error;
      }
      if (isEnvironmentRuntimeSelected(config)) {
        const approved = await loginStep(callbacks.onConfirm?.({
          message: "Use a native OmniRoute profile connection instead of the environment connection?",
          detail: "This OMP profile will use the endpoint and runtime key you enter. Environment variables remain unchanged; a missing native credential will fail closed.",
        }), callbacks.signal);
        checkCancelled(callbacks.signal);
        if (approved !== true) throw new AuthError("cancelled", "native connection switch was not approved");
      }
      const environmentEndpoint = resolveEnvironmentEndpointPrefill(config);
      const existingEndpoint = config.runtimeSource === "native"
        ? config.pending?.endpoint ?? config.active?.endpoint ?? config.setupDraft
        : environmentEndpoint ?? config.pending?.endpoint ?? config.setupDraft ?? config.active?.endpoint;
      const endpointPromptOptions: OAuthPromptOptions = {
        message: `OmniRoute base URL (${ENDPOINT_INPUT_HELP})`,
        placeholder: ENDPOINT_EXAMPLE,
      };
      if (existingEndpoint !== undefined) endpointPromptOptions.initialValue = existingEndpoint;
      const endpointPrompt = await loginStep(callbacks.onPrompt(endpointPromptOptions), callbacks.signal);
      checkCancelled(callbacks.signal);
      const enteredEndpoint = promptValue(endpointPrompt, "base URL");
      let endpoint: string;
      try {
        // Parse with insecure HTTP enabled first so a remote-HTTP candidate can
        // receive the explicit interactive warning rather than failing silently.
        endpoint = normalizeEndpointInput(enteredEndpoint, true);
      } catch (error) {
        throw new AuthError("invalid-input", "invalid OmniRoute base URL", { cause: error });
      }
      let allowInsecureHttp = config.allowInsecureHttp;
      if (isRemoteHttp(endpoint) && !allowInsecureHttp) {
        if (!(await confirmInsecure(callbacks, endpoint))) throw new AuthError("cancelled", "insecure transport was not approved");
        checkCancelled(callbacks.signal);
        allowInsecureHttp = true;
      }
      const keyPrompt = await loginStep(callbacks.onPrompt({ message: "OmniRoute API key", secret: true }), callbacks.signal);
      checkCancelled(callbacks.signal);
      const key = promptValue(keyPrompt, "API key");
      await loginStep(callbacks.onMessage?.("Checking OmniRoute API key and live models…", "info"), callbacks.signal);
      checkCancelled(callbacks.signal);
      const validation = await validateCandidate(endpoint, key, request, callbacks.signal);
      checkCancelled(callbacks.signal);
      const pending: PendingBinding = {
        endpoint,
        generation: (config.active?.generation ?? 0) + 1,
        status: "validated",
      };
      try {
        checkCancelled(callbacks.signal);
        await savePendingConfig(
          { ...config, runtimeSource: "native", allowInsecureHttp, pending },
          { expectedRevision: config.revision ?? null },
        );
      } catch (error) {
        throw new AuthError("persistence-failed", "unable to stage OmniRoute endpoint", { cause: error });
      }
      pendingCandidate = { endpoint: pending.endpoint, generation: pending.generation, key };
      try {
        await options.onSetupComplete?.(pending.endpoint, key);
        checkCancelled(callbacks.signal);
        try {
          await callbacks.onMessage?.(validation.usable === 0
            ? `API key verified; ${validation.raw} live model rows, no chat-compatible models. Connection staged for native persistence.`
            : `API key verified; ${validation.usable} chat-compatible models from ${validation.raw} live rows. Connection staged for native persistence.`, "info");
        } catch {
          // A host progress-display failure cannot invalidate a staged,
          // verified candidate whose native persistence may already be underway.
        }
        checkCancelled(callbacks.signal);
        return key;
      } catch (error) {
        clearPendingCandidate();
        throw error;
      }
    },
  };
}

/** Resolve OMP credentials using the caller's source-selection snapshot. */
export async function resolveRuntimeCredential(
  modelRegistry: ModelRegistryCredentialReader,
  config: Pick<PluginConfig, "allowInsecureHttp" | "runtimeSource">,
): Promise<string | undefined> {
  const env = resolveEnvironmentBinding(config);
  if (env) return env.credential.value;
  if (config.runtimeSource === "native") {
    const credentials = modelRegistry.authStorage?.credentials;
    return credentials ? readNativeApiKey(credentials) : undefined;
  }
  const value = await modelRegistry.getApiKeyForProvider(PROVIDER_ID);
  if (typeof value !== "string" || value.trim() === "") return undefined;
  return value;
}

export async function recoverPendingAfterPersistence(
  modelRegistry: ModelRegistryCredentialReader,
  candidateKey?: string,
): Promise<PluginConfig | undefined> {
  const candidate = pendingCandidate;
  if (!candidate || (candidateKey !== undefined && candidate.key !== candidateKey)) {
    clearPendingCandidate();
    return undefined;
  }
  try {
    const config = await loadConfig();
    if (resolveEnvironmentBinding(config)) return undefined;
    const pending = config.pending;
    if (!pending || pending.endpoint !== candidate.endpoint || pending.generation !== candidate.generation) return undefined;
    const persisted = await resolveRuntimeCredential(modelRegistry, config);
    if (persisted !== candidate.key) return undefined;
    return await commitPendingConfig(
      pending,
      config.revision === undefined ? undefined : { expectedRevision: config.revision },
    );
  } finally {
    // A candidate is single-use. Failed or successful recovery must require a
    // fresh native login rather than allowing a later refresh to self-compare.
    clearPendingCandidate();
  }
}

export function nativeLoginConfig(options: NativeLoginOptions = {}): { oauth: NativeLoginProvider } {
  return { oauth: registerNativeLogin(options) };
}
