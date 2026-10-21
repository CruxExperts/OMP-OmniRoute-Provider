import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { loadConfig, resolveEnvironmentBinding, setAdminEnabledConfig, type PluginConfig } from "../config.ts";
import type { OptionalCredentials } from "../credentials.ts";
import type { DiscoveryBinding } from "../health.ts";
import { adapterFor, invokeBinaryAdapter, invokeJsonAdapter, invokeMultipartAdapter, invokeSseAdapter, invokeWebSocketAdapter, isLoopbackHostname, type AdapterInvocation, type MultipartFile } from "./adapters.ts";
import { createAdminExecutor, type AdminExecutor } from "./executor.ts";
import { canonicalizeJson, getOperationRegistry, type OperationAdapter, type OperationDescriptor, type OperationReadCompleteness, type OperationReconciliationRelation, type ReconciliationFieldMapping, type ValidatedOperationInput } from "./registry.ts";
import { assertSafetyReadRequest, assertSafetyReadResponse, mapRelationInput, projectRelationSnapshot, relationOutcomeMatches } from "./relations.ts";
import { createAdminCommandHandler, type AdminUiOptions } from "./ui.ts";
import { registerAdminTools } from "./tools.ts";
import type { AdminDispatch, AdminOperationAuthBinding, AdminRequest } from "./types.ts";

export interface AdminRuntimeOptions {
  readonly pi: ExtensionAPI;
  readonly credentials: OptionalCredentials;
  readonly context: () => ExtensionContext | undefined;
  readonly binding: () => DiscoveryBinding | undefined;
  readonly bindingSignal: () => AbortSignal | undefined;
  readonly stopped: () => boolean;
  readonly onConfig: (config: PluginConfig) => void;
}

export interface AdminRuntime {
  readonly executor: AdminExecutor;
  readonly command: (args: string, context: ExtensionContext) => Promise<void>;
  readonly synchronize: (source?: PluginConfig, explicitHuman?: boolean) => Promise<void>;
  readonly disable: () => Promise<void>;
  readonly shutdown: () => Promise<void>;
}

const TOOL_NAMES = new Set(["omniroute_admin_read", "omniroute_admin_plan"]);
const PROFILE = "omniroute";
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function root(endpoint: string): string { return endpoint.replace(/\/+$/, "").replace(/\/v1$/, ""); }
function sameIdentity(left: AdminOperationAuthBinding, right: AdminOperationAuthBinding): boolean {
  return left.domain === right.domain && left.profileId === right.profileId && left.endpoint === right.endpoint
    && left.epoch === right.epoch && canonicalizeJson(left.authority) === canonicalizeJson(right.authority);
}
function requestFor(adapter: OperationAdapter, endpoint: string, input: ValidatedOperationInput): AdminRequest {
  const path = adapter.buildPath(input);
  const queryParameters = adapter.buildQuery(input);
  const query = queryParameters.map(item => `${item.encodedName}=${item.encodedValue}`).join("&");
  return { operationId: adapter.descriptor.operationId, method: adapter.descriptor.method, operation: adapter.descriptor,
    path, url: `${root(endpoint)}${path}${query ? `?${query}` : ""}`, queryParameters,
    ...(input.body === undefined ? {} : { body: input.body }) };
}
function multipartParts(value: unknown): { files: MultipartFile[]; fields: Record<string, string> } {
  if (!record(value)) throw new Error("multipart body must be an object");
  const files: MultipartFile[] = [];
  const fields: Record<string, string> = {};
  const addFile = (entry: Record<string, unknown>, fallback?: string): void => {
    const field = entry.field ?? fallback;
    if (typeof field !== "string" || typeof entry.path !== "string") throw new Error("multipart file entry is invalid");
    files.push({ field, path: entry.path, ...(typeof entry.filename === "string" ? { filename: entry.filename } : {}), ...(typeof entry.contentType === "string" ? { contentType: entry.contentType } : {}) });
  };
  if (value.files !== undefined) {
    if (!Array.isArray(value.files)) throw new Error("multipart files must be an array");
    for (const entry of value.files) { if (!record(entry)) throw new Error("multipart file entry is invalid"); addFile(entry); }
  }
  const source = record(value.fields) ? value.fields : value;
  for (const [key, child] of Object.entries(source)) {
    if (source === value && ["files", "fields"].includes(key)) continue;
    if (record(child) && Object.hasOwn(child, "path")) addFile(child, key);
    else fields[key] = typeof child === "string" ? child : JSON.stringify(child) ?? "";
  }
  return { files, fields };
}

/** Loaded only for an enabled operation surface or an explicit administration command. */
export function createAdminRuntime(options: AdminRuntimeOptions): AdminRuntime {
  const registry = getOperationRegistry();
  let enabled = false;
  let closed = false;
  let managedCredential = false;
  let toolsPublished = false;
  let syncFlight: Promise<void> | undefined;
  let toolFlight: Promise<void> = Promise.resolve();
  const isEnabled = (): boolean => enabled && !closed && !options.stopped();
  const effective = (config: PluginConfig) => resolveEnvironmentBinding(config) ?? config.active;
  const resolveAuth = async (operation: OperationDescriptor, target: { profileId: string; endpoint: string }): Promise<AdminOperationAuthBinding | undefined> => {
    if (!isEnabled() || target.profileId !== PROFILE) return undefined;
    const config = await loadConfig();
    const active = effective(config);
    if (!config.adminEnabled || config.pending || !active || active.endpoint !== target.endpoint) return undefined;
    const base = { domain: operation.auth.domain, profileId: PROFILE, endpoint: active.endpoint };
    if (operation.auth.domain === "public") {
      return { ...base, domain: "public", epoch: 0, authority: { kind: "uncredentialed", boundary: "public" } };
    }
    if (operation.auth.domain === "runtime") {
      const binding = options.binding();
      const signal = options.bindingSignal();
      if (!binding || binding.endpoint !== active.endpoint || !signal || signal.aborted) return undefined;
      return {
        ...base,
        domain: "runtime",
        epoch: binding.generation,
        authority: { kind: "server-enforced", credentialKind: "apiKey" },
        credential: { kind: "apiKey", value: binding.credential },
        signal,
      };
    }
    if (operation.auth.domain === "metadata") {
      const environment = process.env.OMP_OMNIROUTE_METADATA_API_KEY?.trim();
      const credential = await options.credentials.resolve("metadata", active, options.context()?.modelRegistry.authStorage,
        environment ? { kind: "apiKey", value: environment } : undefined);
      if (!credential || credential.kind !== "apiKey") return undefined;
      return {
        ...base,
        domain: "metadata",
        epoch: options.credentials.getEpoch("metadata"),
        authority: { kind: "server-enforced", credentialKind: "apiKey" },
        credential,
        signal: options.credentials.getSignal("metadata"),
      };
    }
    if (operation.auth.domain === "local") {
      return { ...base, domain: "local", epoch: 0, authority: { kind: "uncredentialed", boundary: "loopback" } };
    }
    return undefined;
  };

  const dispatch: AdminDispatch = async (request, context) => {
    const adapter = registry.require(request.operationId);
    if (adapter.eligibility.status !== "verified" || adapter.descriptor !== request.operation) throw new Error("operation is not an eligible closed descriptor");
    const descriptor = { ...adapter.descriptor, adapterId: adapter.adapterId };
    let authorized = false;
    const authorize = async (): Promise<void> => {
      await synchronize();
      if (!isEnabled() || context.signal?.aborted || context.auth.signal?.aborted) throw new Error("operation authority is no longer active");
      if (context.auth.domain === "management") {
        const binding = executor.getCredentialBinding();
        const authority = context.auth.authority;
        if (authority.kind === "uncredentialed") {
          const policy = adapter.descriptor.auth.sourcePolicy;
          const trustedLocal = authority.boundary === "loopback" && policy.status === "qualified"
            && policy.routeClass === "management"
            && policy.alternatives.some(alternative => alternative.kind === "trusted-local" && alternative.loopbackOnly)
            && isLoopbackHostname(new URL(context.auth.endpoint).hostname);
          if (!trustedLocal || binding?.enabled) throw new Error("management authority changed");
        } else {
          const omaAuthority = authority.kind === "oma-access-token" || authority.kind === "oma-whoami-bootstrap";
          const expectedCredentialKind = authority.kind === "server-enforced" ? authority.credentialKind : "apiKey";
          if (!binding?.enabled || binding.profileId !== context.auth.profileId || binding.endpoint !== context.auth.endpoint
            || binding.epoch !== context.auth.epoch || binding.credentialKind !== expectedCredentialKind
            || (binding.authority === "oma-scope-unverified") !== omaAuthority) {
            throw new Error("management authority changed");
          }
        }
      } else {
        const current = await resolveAuth(adapter.descriptor, context.auth);
        if (!current || !sameIdentity(current, context.auth) || current.signal?.aborted) throw new Error("operation authority changed");
      }
      authorized = true;
    };
    const invocation: AdapterInvocation = { descriptor, endpoint: root(context.auth.endpoint), resolvedPath: request.path, queryParameters: request.queryParameters,
      ...(context.auth.credential ? { credential: context.auth.credential } : {}), ...(request.body === undefined ? {} : { body: request.body }),
      ...(context.signal ? { signal: context.signal } : {}),
      ...(context.auth.authority.kind === "uncredentialed" && context.auth.authority.boundary === "loopback" ? { requireLoopback: true } : {}),
      authorize };
    const kind = adapterFor(descriptor);
    if (kind === "unavailable") throw new Error("no qualified transport adapter exists");
    if (kind === "operator-required") return { status: "operator-required", reason: "external-consent" };
    try {
      let result;
      if (kind === "binary") result = await invokeBinaryAdapter(invocation);
      else if (kind === "sse") result = await invokeSseAdapter(invocation);
      else if (kind === "websocket") result = await invokeWebSocketAdapter(invocation);
      else if (kind === "multipart") { const parts = multipartParts(request.body); result = await invokeMultipartAdapter(invocation, parts.files, parts.fields); }
      else result = await invokeJsonAdapter(invocation);
      if (adapter.risk !== "read") return { kind: "response", status: result.status, body: result.data };
      if (result.status >= 400) throw Object.assign(new Error("operation request failed"), { status: result.status });
      return result.data;
    } catch (error) {
      if (authorized && adapter.risk !== "read") {
        throw Object.assign(new Error("operation outcome could not be observed"), { code: "network-lost-response", uncertain: true });
      }
      throw error;
    }
  };
  const readSafetySnapshot = async (
    adapter: OperationAdapter,
    relation: OperationReconciliationRelation["targetRead"],
    mappings: readonly ReconciliationFieldMapping[],
    proof: OperationReadCompleteness,
    payload: ValidatedOperationInput,
    auth: AdminOperationAuthBinding,
    signal?: AbortSignal,
  ) => {
    const input = adapter.validate(mapRelationInput(mappings, payload));
    assertSafetyReadRequest(proof, adapter.descriptor, input);
    const response = await dispatch(requestFor(adapter, auth.endpoint, input), { auth, retryAllowed: false, maxAttempts: 1, ...(signal ? { signal } : {}) });
    assertSafetyReadResponse(proof, adapter.descriptor, response);
    return projectRelationSnapshot(relation, adapter.projectTarget(response), payload);
  };
  const executor = createAdminExecutor({ registry, dispatch, resolveAuth,
    readTarget: async target => {
      const adapter = registry.require(target.readOperation.operationId);
      const snapshot = await readSafetySnapshot(adapter, target.relation, target.relation.inputs,
        target.readCompleteness, target.payload, target.auth, target.signal);
      return { digest: createHash("sha256").update(canonicalizeJson(snapshot)).digest("hex"), snapshot };
    },
    reconcile: async context => {
      const relation = context.fullRelation;
      const adapter = registry.require(context.readOperation.operationId);
      const snapshot = await readSafetySnapshot(adapter, { ...relation.targetRead, operationId: context.relation.operationId },
        context.relation.inputs, context.readCompleteness, context.payload, context.auth, context.signal);
      return relationOutcomeMatches(relation, context.originalTarget, snapshot, context.payload) ? { status: "applied" } : { status: "unknown" };
    },
  });
  const ui: AdminUiOptions = { executor, profileId: PROFILE };
  const publishTools = (activate: boolean): Promise<void> => {
    toolFlight = toolFlight.catch(() => undefined).then(async () => {
      // OMP action methods are unavailable while an extension is loading and
      // after its session closes. The next session synchronization publishes.
      if (!options.context()) return;
      if (!isEnabled()) {
        const current = options.pi.getActiveTools();
        const next = current.filter(name => !TOOL_NAMES.has(name));
        if (next.length !== current.length) await options.pi.setActiveTools(next);
        toolsPublished = false;
        return;
      }
      if (toolsPublished && !activate) return;
      const current = options.pi.getActiveTools();
      const existing = new Set(options.pi.getAllTools().map(tool => tool.name));
      const names = registerAdminTools(options.pi, { executor, ui, syncBinding: synchronize, isEnabled });
      const allowed = new Set(names);
      const next = current.filter(name => !TOOL_NAMES.has(name) || allowed.has(name));
      for (const name of names) if ((activate || !existing.has(name)) && !next.includes(name)) next.push(name);
      if (next.length !== current.length || next.some((name, index) => current[index] !== name)) await options.pi.setActiveTools(next);
      toolsPublished = true;
    });
    return toolFlight;
  };
  async function synchronize(source?: PluginConfig, explicitHuman = false): Promise<void> {
    if (syncFlight) return syncFlight;
    const flight = (async () => {
      const config = source ?? await loadConfig();
      options.onConfig(config);
      const active = effective(config);
      if (closed || options.stopped() || !config.adminEnabled || config.pending || !active) {
        if (enabled) executor.disable();
        enabled = false;
        delete ui.endpoint;
        await publishTools(false);
        return;
      }
      enabled = true;
      ui.endpoint = active.endpoint;
      executor.setAdminBinding({ profileId: PROFILE, endpoint: active.endpoint }, explicitHuman);
      const apiKey = process.env.OMP_OMNIROUTE_ADMIN_API_KEY?.trim();
      const cookie = process.env.OMP_OMNIROUTE_ADMIN_COOKIE?.trim();
      const saved = apiKey || cookie ? undefined : await options.credentials.resolve("admin", active, options.context()?.modelRegistry.authStorage);
      if (apiKey || cookie || saved) {
        executor.bindCredential({ profileId: PROFILE, endpoint: active.endpoint, ...(apiKey ? { apiKey } : {}), ...(cookie ? { cookie } : {}),
          ...(saved ? saved.kind === "cookie" ? { cookie: saved.value } : { apiKey: saved.value } : {}) });
        managedCredential = true;
      } else if (managedCredential) {
        executor.clearCredential();
        managedCredential = false;
      }
      await publishTools(explicitHuman);
    })();
    syncFlight = flight;
    try { await flight; }
    catch (error) {
      enabled = false;
      executor.disable();
      delete ui.endpoint;
      try { await publishTools(false); } catch { /* Preserve the binding failure. */ }
      throw error;
    }
    finally { if (syncFlight === flight) syncFlight = undefined; }
  }
  ui.resolveEffectiveEndpoint = async () => { const active = effective(await loadConfig()); return active ? { endpoint: active.endpoint } : undefined; };
  ui.syncBinding = synchronize;
  ui.onEnable = async endpoint => {
    const current = await loadConfig();
    if (effective(current)?.endpoint !== endpoint) throw new Error("operations require the exact active endpoint");
    const next = await setAdminEnabledConfig(true, current.revision === undefined ? undefined : { expectedRevision: current.revision });
    await synchronize(next, true);
    return { endpoint };
  };
  ui.onDisable = async () => {
    const current = await loadConfig();
    const next = await setAdminEnabledConfig(false, current.revision === undefined ? undefined : { expectedRevision: current.revision });
    await synchronize(next);
  };
  return {
    executor,
    command: createAdminCommandHandler(ui),
    synchronize,
    async disable(): Promise<void> { enabled = false; executor.disable(); delete ui.endpoint; await publishTools(false); },
    async shutdown(): Promise<void> { closed = true; enabled = false; executor.shutdown(); delete ui.endpoint; await publishTools(false); },
  };
}
