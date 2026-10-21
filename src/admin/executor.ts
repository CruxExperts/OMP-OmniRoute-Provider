import { createHash, randomBytes } from "node:crypto";
import type {
  AdminApplyAuthorization,
  AdminApplyResult,
  AdminAuthIdentity,
  AdminAuthorizationAuthority,
  AdminAuthorizationSummary,
  AdminCredentialBinding,
  AdminCredentialInput,
  AdminDispatch,
  AdminDispatchContext,
  AdminErrorCode,
  AdminExecutorOptions,
  AdminOperationAuthBinding,
  AdminPlanHandle,
  AdminPreview,
  AdminReadResult,
  AdminReconcileContext,
  AdminReconcileResult,
  AdminRequest,
  AdminRisk,
  AdminTarget,
  AdminTargetReader,
  JsonObject,
  JsonValue,
  OMAAuthorityEvidence,
} from "./types.ts";
import { AdminError, escapeControls, safeError } from "./types.ts";
import {
  canonicalizeJson,
  getOperationRegistry,
  redactSourceOutput,
  RegistryError,
  type ManagementAuthorizationAlternative,
  type OMAAccessTokenScope,
  type OperationAdapter,
  type OperationDescriptor,
  type OperationReconciliationRelation,
  type OperationReadCompleteness,
  type OperationMutationSafety,
  type OperationRegistry,
  type OperationSourceAuthorizationPolicy,
  type ValidatedOperationInput,
} from "./registry.ts";
import { requiredOmaScope } from "./authorization-policy.ts";
import { assertSafetyReadRequest, mapRelationInput } from "./relations.ts";
import { sourceUnpaginatedListProofMatches } from "./source-normalization.ts";

export interface AdminPlanOptions {
  readonly profileId?: string;
  readonly endpoint?: string;
  readonly confirmed?: boolean;
  readonly confirm?: boolean;
  readonly headless?: boolean;
  readonly signal?: AbortSignal;
}

export interface AdminExecutor {
  setAdminBinding(input: { profileId: string; endpoint: string }, explicitHuman?: boolean): void;
  clearAdminBinding(): void;
  bindCredential(input: AdminCredentialInput): AdminCredentialBinding;
  getCredentialBinding(): AdminCredentialBinding | undefined;
  clearCredential(): void;
  logout(): void;
  disable(): void;
  shutdown(): void;
  clearSession(): void;
  clear(): void;
  getPlan(planId: string): AdminPlanHandle | undefined;
  read(operationId: string, input: unknown, options?: AdminPlanOptions): Promise<AdminReadResult>;
  plan(operationId: string, input: unknown, options?: AdminPlanOptions): Promise<AdminPlanHandle>;
  preview(operationId: string, input: unknown, options?: AdminPlanOptions): Promise<AdminPlanHandle>;
  apply(planId: string, authorization: AdminApplyAuthorization): Promise<AdminApplyResult>;
  invalidatePlans(): void;
}

interface InternalCredential {
  readonly profileId: string;
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly cookie?: string;
  readonly epoch: number;
  readonly enabled: boolean;
}

interface InternalAdminBinding {
  readonly profileId: string;
  readonly endpoint: string;
  readonly enabled: boolean;
}

interface InternalPlan {
  readonly planId: string;
  readonly operation: OperationAdapter;
  readonly input: ValidatedOperationInput;
  readonly payloadDigest: string;
  readonly targetDigest: string | null;
  readonly auth: AdminAuthIdentity;
  readonly authAuthority: AdminAuthorizationAuthority;
  readonly targetAuth: AdminAuthIdentity | null;
  readonly mutationSafety: OperationMutationSafety;
  readonly observations: readonly PlannedObservation[];
  readonly postconditions: readonly PlannedPostcondition[];
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly preview: AdminPreview;
  state: AdminPlanHandle["state"];
}

interface PlannedObservation {
  readonly name: string;
  readonly relation: OperationReconciliationRelation["targetRead"];
  readonly readCompleteness: OperationReadCompleteness;
  readonly readOperation: OperationAdapter;
  readonly target: AdminTarget;
  readonly auth: AdminAuthIdentity;
  readonly authority: AdminAuthorizationAuthority;
}
interface PlannedPostcondition {
  readonly name: string;
  readonly relation: OperationReconciliationRelation;
  readonly readCompleteness: OperationReadCompleteness;
  readonly readOperation: OperationAdapter;
  readonly targetReadOperation: OperationAdapter;
  readonly targetAuth: AdminAuthIdentity;
  readonly targetAuthority: AdminAuthorizationAuthority;
  readonly target: AdminTarget;
  readonly auth: AdminAuthIdentity;
  readonly authority: AdminAuthorizationAuthority;
}

interface OperationSelection {
  readonly profileId: string;
  readonly endpoint: string;
}

interface LinkedSignal {
  readonly signal?: AbortSignal;
  dispose(): void;
}

const DEFAULT_PLAN_TTL_MS = 60_000;
const MAX_PLAN_TTL_MS = 300_000;
const SAFE_READ_METHODS: Readonly<Record<string, true>> = { GET: true, HEAD: true, OPTIONS: true };
const RELATION_READ_METHODS: Readonly<Record<string, true>> = { GET: true, HEAD: true };
const LOOPBACK_HOSTS: Readonly<Record<string, true>> = { localhost: true, "127.0.0.1": true, "::1": true, "[::1]": true };
const MAX_PREVIEW_BYTES = 7_000;
const MAX_PREVIEW_DEPTH = 32;
const SHA256_DIGEST = /^[a-f0-9]{64}$/;
const OMA_SCOPE_RANK: Readonly<Record<OMAAccessTokenScope, number>> = { read: 0, write: 1, admin: 2 };

function throwIfAborted(signal: AbortSignal | undefined, operationId?: string): void {
  if (signal?.aborted) throw new AdminError("plan-invalidated", "operation was cancelled", { correlationId: correlationId(), ...(operationId === undefined ? {} : { operationId }) });
}

function linkSignals(...signals: (AbortSignal | undefined)[]): LinkedSignal {
  const sources = [...new Set(signals.filter((signal): signal is AbortSignal => signal !== undefined))];
  if (sources.length === 0) return { dispose() {} };
  if (sources.length === 1) {
    const signal = sources[0];
    return signal === undefined ? { dispose() {} } : { signal, dispose() {} };
  }
  const controller = new AbortController();
  const listeners = new Map<AbortSignal, () => void>();
  for (const source of sources) {
    const abort = () => controller.abort(source.reason);
    if (source.aborted) {
      abort();
      break;
    }
    source.addEventListener("abort", abort, { once: true });
    listeners.set(source, abort);
  }
  return {
    signal: controller.signal,
    dispose() {
      for (const [source, listener] of listeners) source.removeEventListener("abort", listener);
      listeners.clear();
    },
  };
}

function withAuth<T>(
  auth: AdminOperationAuthBinding,
  signals: readonly (AbortSignal | undefined)[],
  operationId: string,
  action: (boundAuth: AdminOperationAuthBinding, signal?: AbortSignal) => Promise<T>,
): Promise<T> {
  const linked = linkSignals(auth.signal, ...signals);
  const boundAuth: AdminOperationAuthBinding = {
    ...auth,
    ...(linked.signal === undefined ? {} : { signal: linked.signal }),
  };
  return (async () => {
    try {
      throwIfAborted(linked.signal, operationId);
      const result = await action(boundAuth, linked.signal);
      throwIfAborted(linked.signal, operationId);
      return result;
    } finally {
      linked.dispose();
    }
  })();
}

function previewDepth(value: unknown, depth = 0): number {
  if (depth > MAX_PREVIEW_DEPTH) return depth;
  if (!value || typeof value !== "object") return depth;
  const children = Array.isArray(value) ? value : Object.values(value as Record<string, unknown>);
  return children.reduce((maximum, child) => Math.max(maximum, previewDepth(child, depth + 1)), depth);
}

function privateEndpoint(endpoint: string): string {
  if (!endpoint || /[\u0000-\u001f\u007f]/.test(endpoint)) throw new AdminError("invalid-endpoint", "endpoint is invalid", { correlationId: correlationId() });
  let parsed: URL;
  try { parsed = new URL(endpoint); } catch { throw new AdminError("invalid-endpoint", "endpoint is invalid", { correlationId: correlationId() }); }
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new AdminError("invalid-endpoint", "endpoint is invalid", { correlationId: correlationId() });
  return parsed.toString().replace(/\/$/, "");
}

function validProfileId(profileId: string): boolean {
  return profileId.length > 0 && !/[\u0000-\u001f\u007f]/.test(profileId);
}


function credentialValueValid(value: string): boolean {
  return value.length > 0 && !/[\u0000-\u001f\u007f]/.test(value);
}

function correlationId(): string {
  return `c-${randomBytes(8).toString("hex")}`;
}

function planId(): string {
  return `p-${randomBytes(16).toString("hex")}`;
}

function digest(value: unknown): string {
  return createHash("sha256").update(canonicalizeJson(value)).digest("hex");
}

function nowDefault(): number {
  return Date.now();
}

function boundedPlanTtl(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PLAN_TTL_MS;
  return Math.min(MAX_PLAN_TTL_MS, Math.max(1_000, Math.floor(value)));
}

function errorResult(error: AdminError): { code: AdminErrorCode; status?: number; operationId?: string; correlationId: string } {
  return error.toJSON();
}

function isSensitive(key: string, descriptor: OperationDescriptor): boolean {
  return descriptor.secrets.inputFields.some((field) => field.toLowerCase() === key.toLowerCase())
    || descriptor.secrets.outputFields.some((field) => field.toLowerCase() === key.toLowerCase())
    || /(?:secret|password|token|credential|authorization|cookie|api[-_]?key)/i.test(key);
}

function redactInput(value: unknown, descriptor: OperationDescriptor, key?: string): unknown {
  if (key && isSensitive(key, descriptor)) return "[redacted]";
  if (key === "body" && (descriptor.sideEffect === "secret" || descriptor.secrets.inputFields.length > 0) && (typeof value !== "object" || value === null)) return "[redacted]";
  if (Array.isArray(value)) return value.map((item) => redactInput(item, descriptor));
  if (value && typeof value === "object") {
    const output: JsonObject = {};
    for (const [field, child] of Object.entries(value as Record<string, unknown>)) {
      const redacted = redactInput(child, descriptor, field);
      if (redacted !== undefined) output[field] = redacted as JsonValue;
    }
    return output;
  }
  return typeof value === "string" ? escapeControls(value) : value;
}

function safeBinding(binding: InternalCredential): AdminCredentialBinding {
  return {
    profileId: binding.profileId,
    endpoint: binding.endpoint,
    epoch: binding.epoch,
    credentialKind: binding.apiKey === undefined ? "cookie" : "apiKey",
    authority: binding.apiKey?.startsWith("oma_") === true ? "oma-scope-unverified" : "server-enforced",
    enabled: binding.enabled,
  };
}

function identityOf(auth: AdminOperationAuthBinding): AdminAuthIdentity {
  return { domain: auth.domain, profileId: auth.profileId, endpoint: auth.endpoint, epoch: auth.epoch };
}

function sameIdentity(left: AdminAuthIdentity, right: AdminAuthIdentity): boolean {
  return left.domain === right.domain && left.profileId === right.profileId && left.endpoint === right.endpoint && left.epoch === right.epoch;
}
function sameAuthority(left: AdminAuthorizationAuthority, right: AdminAuthorizationAuthority): boolean {
  return canonicalizeJson(left) === canonicalizeJson(right);
}

function endpointIsLoopback(endpoint: string): boolean {
  return LOOPBACK_HOSTS[new URL(endpoint).hostname] === true;
}

function scopeSatisfies(actual: OMAAccessTokenScope, minimum: OMAAccessTokenScope): boolean {
  return OMA_SCOPE_RANK[actual] >= OMA_SCOPE_RANK[minimum];
}

function authorizationSummary(authority: AdminAuthorizationAuthority): AdminAuthorizationSummary {
  switch (authority.kind) {
    case "uncredentialed":
      return { kind: "not-required", message: "This source-qualified operation requires no credential." };
    case "server-enforced":
      return { kind: "server-enforced", message: "The server enforces credential permissions; this preview did not preflight them." };
    case "oma-access-token":
      return {
        kind: "oma-scope-observed",
        scope: authority.scope,
        message: "The OMA CLI token scope was observed from the qualified whoami operation for this preview.",
      };
    case "oma-whoami-bootstrap":
      return { kind: "oma-scope-bootstrap", message: "This exact whoami request observes OMA CLI token scope; no scope is assumed before it." };
  }
}



function requestFor(adapter: OperationAdapter, endpoint: string, input: ValidatedOperationInput): AdminRequest {
  const path = adapter.buildPath(input);
  const queryParameters = adapter.buildQuery(input);
  const queryString = queryParameters.map(({ encodedName, encodedValue }) => `${encodedName}=${encodedValue}`).join("&");
  const url = `${endpoint}${path}${queryString ? `?${queryString}` : ""}`;
  return {
    operationId: adapter.descriptor.operationId,
    method: adapter.descriptor.method,
    url,
    path,
    queryParameters,
    operation: adapter.descriptor,
    ...(input.body === undefined ? {} : { body: input.body }),
  };
}

function consequence(descriptor: OperationDescriptor, risk: AdminRisk, relation: OperationReconciliationRelation | null, input?: ValidatedOperationInput): string {
  if (risk === "read") return "Read-only operation; response is projected through the closed allowlist.";
  if (descriptor.operationId === "DELETE /api/combos/metrics") {
    const selected = typeof input?.query.combo === "string" && input.query.combo.length > 0;
    return selected
      ? "Resets the selected combo's production, shadow, and persisted-skip counters. The source returns HTTP 200 but supplies no complete success proof, so the outcome remains unknown after one dispatch."
      : "Resets all production, shadow, and persisted-skip counters and stops the metrics cleanup interval until module reload. The source returns HTTP 200 but supplies no complete success proof, so the outcome remains unknown after one dispatch.";
  }
  if (relation === null) {
    return `${descriptor.confirmation.reason} This operation has no verified reconciliation read; at most one dispatch will be attempted, and an ambiguous outcome remains unknown without replay.`;
  }
  if (risk === "gated-read") return "Nominal read is gated because the pinned source declares possible side effects.";
  return descriptor.confirmation.reason;
}

export class AdminExecutorImpl implements AdminExecutor {
  readonly #dispatch: AdminDispatch;
  readonly #readTarget: AdminTargetReader | undefined;
  readonly #reconcile: AdminExecutorOptions["reconcile"];
  readonly #resolveAuth: AdminExecutorOptions["resolveAuth"];
  readonly #registry: OperationRegistry;
  readonly #planTtlMs: number;
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #plans = new Map<string, InternalPlan>();
  #applyQueue: Promise<void> = Promise.resolve();
  #credential: InternalCredential | undefined;
  #adminBinding: InternalAdminBinding | undefined;
  #managementEpoch = 0;
  #managementController = new AbortController();
  #stopped = false;
  #credentialBindingBlocked = false;

  constructor(options: AdminExecutorOptions) {
    this.#dispatch = options.dispatch;
    this.#readTarget = options.readTarget;
    this.#reconcile = options.reconcile;
    this.#resolveAuth = options.resolveAuth;
    this.#registry = options.registry ?? getOperationRegistry();
    this.#planTtlMs = boundedPlanTtl(options.planTtlMs);
    this.#now = options.now ?? nowDefault;
    this.#randomId = options.randomId ?? planId;
  }

  setAdminBinding(input: { profileId: string; endpoint: string }, explicitHuman = false): void {
    if (this.#stopped) throw this.#error("shutdown", "administration is shut down");
    if (this.#credentialBindingBlocked && !explicitHuman) throw this.#error("credential-disabled", "administration requires an explicit human enable action");
    if (!validProfileId(input.profileId)) throw this.#error("credential-mismatch", "management binding is invalid");
    const next = { profileId: input.profileId, endpoint: privateEndpoint(input.endpoint), enabled: true };
    const current = this.#adminBinding;
    if (explicitHuman) this.#credentialBindingBlocked = false;
    if (current?.enabled && current.profileId === next.profileId && current.endpoint === next.endpoint) return;
    this.#invalidateManagementPlans();
    this.#renewManagementSignal();
    this.#adminBinding = next;
  }

  clearAdminBinding(): void {
    this.#invalidateManagementPlans();
    this.#renewManagementSignal();
    this.#adminBinding = undefined;
  }

  bindCredential(input: AdminCredentialInput): AdminCredentialBinding {
    if (this.#stopped) throw this.#error("shutdown", "administration is shut down");
    if (this.#credentialBindingBlocked) throw this.#error("credential-disabled", "credential rebinding requires an explicit human enable action");
    if (!validProfileId(input.profileId) || /[\u0000-\u001f\u007f]/.test(input.apiKey ?? "") || /[\u0000-\u001f\u007f]/.test(input.cookie ?? "")) {
      throw this.#error("credential-required", "credential binding is invalid");
    }
    const endpoint = privateEndpoint(input.endpoint);
    if ((input.apiKey === undefined) === (input.cookie === undefined)
      || (input.apiKey !== undefined && !credentialValueValid(input.apiKey))
      || (input.cookie !== undefined && !credentialValueValid(input.cookie))) {
      throw this.#error("credential-required", "one management credential is required");
    }
    const current = this.#credential;
    if (current?.enabled && current.profileId === input.profileId && current.endpoint === endpoint
      && current.apiKey === input.apiKey && current.cookie === input.cookie) {
      this.setAdminBinding({ profileId: current.profileId, endpoint: current.endpoint });
      return safeBinding(current);
    }

    this.#invalidateManagementPlans();
    this.#advanceManagementEpoch();
    this.#credential = {
      profileId: input.profileId,
      endpoint,
      ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
      ...(input.cookie === undefined ? {} : { cookie: input.cookie }),
      epoch: this.#managementEpoch,
      enabled: true,
    };
    this.setAdminBinding({ profileId: input.profileId, endpoint });
    return safeBinding(this.#credential);
  }

  getCredentialBinding(): AdminCredentialBinding | undefined {
    return this.#credential ? safeBinding(this.#credential) : undefined;
  }

  clearCredential(): void {
    if (!this.#credential) return;
    this.#invalidateManagementPlans();
    this.#advanceManagementEpoch();
    this.#credential = undefined;
  }

  logout(): void {
    this.#advanceManagementEpoch();
    this.invalidatePlans();
    this.#credential = undefined;
    this.#adminBinding = undefined;
    this.#credentialBindingBlocked = true;
  }

  clearSession(): void {
    this.logout();
  }

  clear(): void {
    this.logout();
  }

  disable(): void {
    this.#advanceManagementEpoch();
    this.invalidatePlans();
    if (this.#credential) {
      this.#credential = {
        profileId: this.#credential.profileId,
        endpoint: this.#credential.endpoint,
        epoch: this.#managementEpoch,
        enabled: false,
      };
    }
    if (this.#adminBinding) this.#adminBinding = { ...this.#adminBinding, enabled: false };
    this.#credentialBindingBlocked = true;
  }

  shutdown(): void {
    this.#advanceManagementEpoch();
    this.#stopped = true;
    this.invalidatePlans();
    this.#credential = undefined;
    this.#adminBinding = undefined;
  }

  invalidatePlans(): void {
    for (const plan of this.#plans.values()) {
      if (plan.state === "pending" || plan.state === "applying") plan.state = "invalidated";
    }
  }
  #invalidateManagementPlans(): void {
    for (const plan of this.#plans.values()) {
      if ((plan.state === "pending" || plan.state === "applying")
        && (plan.auth.domain === "management" || plan.targetAuth?.domain === "management")) {
        plan.state = "invalidated";
      }
    }
  }

  getPlan(planIdValue: string): AdminPlanHandle | undefined {
    const plan = this.#plans.get(planIdValue);
    if (!plan) return undefined;
    if (plan.state === "pending" && this.#now() >= plan.expiresAt) plan.state = "expired";
    return this.#handle(plan);
  }

  async read(operationId: string, input: unknown, options: AdminPlanOptions = {}): Promise<AdminReadResult> {
    throwIfAborted(options.signal, operationId);
    if (this.#stopped) throw this.#error("shutdown", "administration is shut down", operationId);
    const adapter = this.#requireAdapter(operationId);
    const descriptor = adapter.descriptor;
    if (adapter.risk !== "read" || descriptor.confirmation.required || descriptor.sideEffect !== "read" || SAFE_READ_METHODS[descriptor.method] !== true) {
      throw this.#error("confirmation-required", "operation requires a human-confirmed plan", operationId);
    }
    const validated = this.#validate(adapter, input);
    const selection = this.#selection(options);
    this.#assertEligible(adapter);
    const request = requestFor(adapter, selection.endpoint, validated);
    const auth = await this.#resolveOperationAuth(descriptor, selection, request, options.signal);
    return withAuth(auth, [options.signal], operationId, async (boundAuth, signal) => {
      this.#assertEligible(adapter);
      const context = this.#dispatchContext(boundAuth, descriptor, this.#retryAllowed(adapter), signal);
      const output = await this.#dispatch(request, context);
      return { operationId, output: adapter.project(output), correlationId: correlationId() };
    });
  }

  async plan(operationId: string, input: unknown, options: AdminPlanOptions = {}): Promise<AdminPlanHandle> {
    throwIfAborted(options.signal, operationId);
    if (this.#stopped) throw this.#error("shutdown", "administration is shut down", operationId);
    const adapter = this.#requireAdapter(operationId);
    if (adapter.risk === "read") throw this.#error("confirmation-required", "ordinary reads must use the read operation", operationId);
    const validated = this.#validate(adapter, input);
    const selection = this.#selection(options);
    const mutationSafety = this.#safetyForPlan(adapter);
    this.#assertEligible(adapter);
    const request = requestFor(adapter, selection.endpoint, validated);
    const auth = await this.#resolveOperationAuth(adapter.descriptor, selection, request, options.signal);
    const observations: PlannedObservation[] = [];
    const postconditions: PlannedPostcondition[] = [];
    if (mutationSafety.preflight.kind === "unavailable") throw this.#error("operation-unavailable", mutationSafety.preflight.reason, operationId);
    if (mutationSafety.preflight.kind === "required") {
      for (const observation of mutationSafety.preflight.observations) {
        const readOperation = this.#requireRelationRead(observation.read.operationId, operationId, observation.readCompleteness);
        const result = await this.#readRelationTarget(adapter, validated, observation.read, observation.readCompleteness, readOperation, selection, auth, options.signal);
        observations.push({ name: observation.name, relation: observation.read, readCompleteness: observation.readCompleteness, readOperation, target: result.target,
          auth: identityOf(result.auth), authority: result.auth.authority });
      }
    }
    if (mutationSafety.reconciliation.kind === "complete") {
      for (const postcondition of mutationSafety.reconciliation.postconditions) {
        const targetReadOperation = this.#requireRelationRead(postcondition.relation.targetRead.operationId, operationId, postcondition.readCompleteness);
        const readOperation = this.#requireRelationRead(postcondition.relation.reconcile.operationId, operationId, postcondition.readCompleteness);
        const result = await this.#readRelationTarget(adapter, validated, postcondition.relation.targetRead, postcondition.readCompleteness, targetReadOperation, selection, auth, options.signal);
        const readInput = readOperation.validate(mapRelationInput(postcondition.relation.reconcile.inputs, validated));
        const readAuth = await this.#resolveOperationAuth(readOperation.descriptor, selection, requestFor(readOperation, selection.endpoint, readInput), options.signal);
        postconditions.push({ name: postcondition.name, relation: postcondition.relation, readCompleteness: postcondition.readCompleteness, readOperation, targetReadOperation,
          target: result.target, auth: identityOf(readAuth), authority: readAuth.authority,
          targetAuth: identityOf(result.auth), targetAuthority: result.auth.authority });
      }
    }
    const targetDigest = observations.length === 0 ? null : digest(observations.map(item => [item.name, item.target.digest]));
    const targetSnapshot = observations[0]?.target.snapshot;
    const targetAuthIdentity = observations[0]?.auth ?? null;
    const targetReadOperation = observations[0]?.readOperation;
    const currentOperationAuth = await this.#resolveOperationAuth(adapter.descriptor, selection, request, options.signal);
    this.#assertAuthUnchanged(auth, currentOperationAuth, adapter.descriptor);
    for (const item of observations) {
      const readInput = item.readOperation.validate(mapRelationInput(item.relation.inputs, validated));
      const readRequest = requestFor(item.readOperation, selection.endpoint, readInput);
      const currentAuth = await this.#resolveOperationAuth(item.readOperation.descriptor, selection, readRequest, options.signal);
      this.#assertPlannedAuth(item.auth, item.authority, currentAuth, item.readOperation.descriptor);
    }
    for (const item of postconditions) {
      const targetInput = item.targetReadOperation.validate(mapRelationInput(item.relation.targetRead.inputs, validated));
      const targetRequest = requestFor(item.targetReadOperation, selection.endpoint, targetInput);
      const targetAuth = await this.#resolveOperationAuth(item.targetReadOperation.descriptor, selection, targetRequest, options.signal);
      this.#assertPlannedAuth(item.targetAuth, item.targetAuthority, targetAuth, item.targetReadOperation.descriptor);
      const readInput = item.readOperation.validate(mapRelationInput(item.relation.reconcile.inputs, validated));
      const readRequest = requestFor(item.readOperation, selection.endpoint, readInput);
      const currentAuth = await this.#resolveOperationAuth(item.readOperation.descriptor, selection, readRequest, options.signal);
      this.#assertPlannedAuth(item.auth, item.authority, currentAuth, item.readOperation.descriptor);
    }
    const relation = adapter.descriptor.reconciliation;

    throwIfAborted(options.signal, operationId);
    const createdAt = this.#now();
    const payloadDigest = digest(validated);
    const previewPayload = redactInput(validated, adapter.descriptor) as ValidatedOperationInput;
    const previewBase = {
      operationId,
      method: adapter.descriptor.method,
      pathTemplate: adapter.descriptor.pathTemplate,
      target: { profileId: auth.profileId, endpoint: auth.endpoint },
      risk: adapter.risk,
      sideEffect: adapter.descriptor.sideEffect,
      confirmationRequired: true,
      authorization: authorizationSummary(auth.authority),
      payload: previewPayload,
      ...(targetSnapshot === undefined ? {} : { projectedTarget: redactSourceOutput(targetSnapshot, (targetReadOperation?.descriptor ?? adapter.descriptor).secrets.outputFields) }),
      ...(mutationSafety.preflight.kind === "required" && mutationSafety.preflight.visibilityLimits !== undefined
        ? { visibilityLimits: mutationSafety.preflight.visibilityLimits.map(escapeControls) }
        : {}),
      consequence: consequence(adapter.descriptor, adapter.risk, relation, validated),
      resolvedPath: request.path,
      queryParameters: request.queryParameters,
    };
    if (previewDepth(previewBase) > MAX_PREVIEW_DEPTH || new TextEncoder().encode(canonicalizeJson(previewBase)).byteLength > MAX_PREVIEW_BYTES) {
      throw this.#error("preview-too-large", "complete redacted preview exceeds the approval limit", operationId);
    }
    const preview: AdminPreview = { ...previewBase, planDigest: digest(previewBase) };
    const internal: InternalPlan = {
      planId: this.#randomId(),
      operation: adapter,
      input: validated,
      payloadDigest,
      targetDigest,
      auth: identityOf(auth),
      authAuthority: auth.authority,
      targetAuth: targetAuthIdentity,
      mutationSafety, observations, postconditions,
      createdAt,
      expiresAt: createdAt + this.#planTtlMs,
      preview,
      state: "pending",
    };
    this.#plans.set(internal.planId, internal);
    return this.#handle(internal);
  }

  async preview(operationId: string, input: unknown, options: AdminPlanOptions = {}): Promise<AdminPlanHandle> {
    return this.plan(operationId, input, options);
  }

  async apply(planIdValue: string, authorization: AdminApplyAuthorization): Promise<AdminApplyResult> {
    const queuedPlan = this.#plans.get(planIdValue);
    if (!queuedPlan) throw this.#error("plan-not-found", "plan is not available");
    const operationId = queuedPlan.operation.descriptor.operationId;
    return this.#serializeApply(operationId, authorization.signal, () => this.#applyUnlocked(planIdValue, authorization));
  }

  async #serializeApply<T>(operationId: string, signal: AbortSignal | undefined, action: () => Promise<T>): Promise<T> {
    const predecessor = this.#applyQueue;
    let release!: () => void;
    this.#applyQueue = new Promise<void>(resolve => { release = resolve; });
    let entered = false;
    let removeAbortListener: (() => void) | undefined;
    try {
      if (signal) {
        throwIfAborted(signal, operationId);
        const aborted = new Promise<never>((_resolve, reject) => {
          const onAbort = () => reject(this.#error("plan-invalidated", "operation was cancelled", operationId));
          signal.addEventListener("abort", onAbort, { once: true });
          removeAbortListener = () => signal.removeEventListener("abort", onAbort);
        });
        await Promise.race([predecessor, aborted]);
      } else {
        await predecessor;
      }
      removeAbortListener?.();
      removeAbortListener = undefined;
      throwIfAborted(signal, operationId);
      entered = true;
      return await action();
    } finally {
      removeAbortListener?.();
      if (entered) release();
      else void predecessor.then(release, release);
    }
  }

  async #applyUnlocked(planIdValue: string, authorization: AdminApplyAuthorization): Promise<AdminApplyResult> {
    const plan = this.#plans.get(planIdValue);
    if (!plan) throw this.#error("plan-not-found", "plan is not available");
    const operationId = plan.operation.descriptor.operationId;
    if (this.#stopped) throw this.#error("shutdown", "administration is shut down", operationId);
    const currentTime = this.#now();
    if (currentTime >= plan.expiresAt && plan.state === "pending") plan.state = "expired";
    if (plan.state === "expired") throw this.#error("plan-expired", "plan has expired", operationId);
    if (plan.state === "invalidated") throw this.#error("plan-invalidated", "plan is no longer valid", operationId);
    if (plan.state === "applying") throw this.#error("plan-in-progress", "plan application is already in progress", operationId);
    if (plan.state === "applied" || plan.state === "operator-required" || plan.state === "unknown") throw this.#error("plan-already-applied", "plan reached a terminal state", operationId);
    const confirmed = authorization.confirmed === true || authorization.confirm === true;
    if (authorization.headless === true) return this.#denied(plan, "headless-denied", "headless execution is denied");
    if (!confirmed) return this.#denied(plan, "confirmation-required", "human confirmation is required");
    if (this.#stopped) throw this.#error("shutdown", "administration is shut down", operationId);
    this.#assertEligible(plan.operation);
    if (authorization.profileId !== undefined && authorization.profileId !== plan.auth.profileId) throw this.#error("credential-mismatch", "profile changed", operationId);
    if (authorization.endpoint !== undefined && privateEndpoint(authorization.endpoint) !== plan.auth.endpoint) throw this.#error("credential-mismatch", "endpoint changed", operationId);
    if (authorization.targetDigest !== undefined && authorization.targetDigest !== plan.targetDigest) throw this.#error("target-drift", "target changed since preview", operationId);
    throwIfAborted(authorization.signal, operationId);

    plan.state = "applying";
    let dispatched = false;
    try {
      if (this.#now() >= plan.expiresAt) throw this.#error("plan-expired", "plan has expired", operationId);
      const selection = { profileId: plan.auth.profileId, endpoint: plan.auth.endpoint };
      const request = requestFor(plan.operation, selection.endpoint, plan.input);
      const initialAuth = await this.#resolveOperationAuth(plan.operation.descriptor, selection, request, authorization.signal);
      this.#assertApplyingPlan(plan);
      this.#assertPlannedAuth(plan.auth, plan.authAuthority, initialAuth, plan.operation.descriptor);

      const currentTargetSignals: (AbortSignal | undefined)[] = [];
      const currentDigests: [string, string][] = [];
      for (const item of plan.observations) {
        const current = await this.#readRelationTarget(plan.operation, plan.input, item.relation, item.readCompleteness, item.readOperation,
          selection, initialAuth, authorization.signal);
        this.#assertApplyingPlan(plan);
        this.#assertPlannedAuth(item.auth, item.authority, current.auth, item.readOperation.descriptor);
        if (current.target.digest !== item.target.digest) throw this.#error("target-drift", `preflight observation ${item.name} changed since preview`, operationId);
        currentDigests.push([item.name, current.target.digest]);
        currentTargetSignals.push(current.auth.signal);
        const latestAuth = await this.#resolveOperationAuth(item.readOperation.descriptor, selection, current.request, authorization.signal);
        this.#assertApplyingPlan(plan);
        this.#assertPlannedAuth(item.auth, item.authority, latestAuth, item.readOperation.descriptor);
        currentTargetSignals.push(latestAuth.signal);
      }
      for (const item of plan.postconditions) {
        const targetInput = item.targetReadOperation.validate(mapRelationInput(item.relation.targetRead.inputs, plan.input));
        const targetAuth = await this.#resolveOperationAuth(item.targetReadOperation.descriptor, selection,
          requestFor(item.targetReadOperation, selection.endpoint, targetInput), authorization.signal);
        this.#assertApplyingPlan(plan);
        this.#assertPlannedAuth(item.targetAuth, item.targetAuthority, targetAuth, item.targetReadOperation.descriptor);
        currentTargetSignals.push(targetAuth.signal);
        const readInput = item.readOperation.validate(mapRelationInput(item.relation.reconcile.inputs, plan.input));
        const readAuth = await this.#resolveOperationAuth(item.readOperation.descriptor, selection,
          requestFor(item.readOperation, selection.endpoint, readInput), authorization.signal);
        this.#assertApplyingPlan(plan);
        this.#assertPlannedAuth(item.auth, item.authority, readAuth, item.readOperation.descriptor);
        currentTargetSignals.push(readAuth.signal);
      }
      if (plan.observations.length > 0 && digest(currentDigests) !== plan.targetDigest) {
        throw this.#error("target-drift", "preflight observation set changed since preview", operationId);
      }
      for (const item of plan.observations) {
        const readInput = item.readOperation.validate(mapRelationInput(item.relation.inputs, plan.input));
        const latestAuth = await this.#resolveOperationAuth(item.readOperation.descriptor, selection,
          requestFor(item.readOperation, selection.endpoint, readInput), authorization.signal);
        this.#assertApplyingPlan(plan);
        this.#assertPlannedAuth(item.auth, item.authority, latestAuth, item.readOperation.descriptor);
        currentTargetSignals.push(latestAuth.signal);
      }
      const latestOperationAuth = await this.#resolveOperationAuth(plan.operation.descriptor, selection, request, authorization.signal);
      this.#assertApplyingPlan(plan);
      this.#assertPlannedAuth(plan.auth, plan.authAuthority, latestOperationAuth, plan.operation.descriptor);

      throwIfAborted(authorization.signal, operationId);
      if (this.#stopped || this.#now() >= plan.expiresAt) throw this.#error(this.#stopped ? "shutdown" : "plan-expired", this.#stopped ? "administration is shut down" : "plan has expired", operationId);
      const finalAuth = await this.#resolveOperationAuth(plan.operation.descriptor, selection, request, authorization.signal);
      this.#assertApplyingPlan(plan);
      this.#assertPlannedAuth(plan.auth, plan.authAuthority, finalAuth, plan.operation.descriptor);
      this.#assertEligible(plan.operation);

      // Mark before dispatch: an uncertain result must never cause a second mutation attempt.
      plan.state = "applied";
      dispatched = true;
      return await withAuth(finalAuth, [...currentTargetSignals, authorization.signal], operationId, async (boundAuth, signal) => {
        const result = await this.#dispatch(request, this.#dispatchContext(boundAuth, plan.operation.descriptor, this.#retryAllowed(plan.operation), signal));
        if (result && typeof result === "object" && "status" in result && result.status === "operator-required") {
          plan.state = "operator-required";
          return { status: "operator-required", plan: this.#handle(plan), output: result };
        }
        if (result && typeof result === "object" && "kind" in result && result.kind === "response"
          && "status" in result && typeof result.status === "number" && "body" in result) {
          if (plan.mutationSafety.settlement.responseComplete.statusCodes.includes(result.status)) {
            const output = plan.operation.project(result.body);
            return { status: "applied", plan: this.#handle(plan), output };
          }
        }
        plan.state = "unknown";
        const reconciled = await this.#reconcileOutcome(plan, request, result, authorization.signal);
        if (reconciled.status === "applied") {
          plan.state = "applied";
          return { status: "applied", plan: this.#handle(plan) };
        }
        return { status: "unknown", plan: this.#handle(plan), error: errorResult(this.#error("uncertain-outcome", "mutation outcome is uncertain", operationId)) };
      });
    } catch (error) {
      if (!dispatched) {
        const failure = safeError(error);
        if (failure.status === 401 || failure.status === 403) {
          plan.state = "invalidated";
          throw this.#error("unauthorized", "administration request was not authorized", operationId, failure.status);
        }
        if (this.#isPlanInvalidated(plan)) {
          throw this.#error("plan-invalidated", "plan is no longer valid", operationId);
        }
        plan.state = error instanceof AdminError && ["credential-mismatch", "credential-disabled", "missing-scope", "unauthorized", "target-drift", "plan-invalidated", "plan-expired", "shutdown"].includes(error.code)
          ? "invalidated"
          : "pending";
        if (plan.state === "pending" && this.#now() >= plan.expiresAt) plan.state = "expired";
        throw error;
      }
      plan.state = "unknown";
      const reconciled = await this.#reconcileOutcome(plan, requestFor(plan.operation, plan.auth.endpoint, plan.input), error, authorization.signal);
      if (reconciled.status === "applied") {
        plan.state = "applied";
        return { status: "applied", plan: this.#handle(plan) };
      }
      return { status: "unknown", plan: this.#handle(plan), error: errorResult(this.#error("uncertain-outcome", "mutation outcome is uncertain", operationId)) };
    }
  }

  #requireAdapter(operationId: string): OperationAdapter {
    try { return this.#registry.require(operationId); } catch (error) {
      if (error instanceof RegistryError) {
        const code = error.code === "invalid-inventory" || error.code === "non-invokable" ? "operation-unavailable" : error.code;
        throw this.#error(code, "operation is not invokable", operationId);
      }
      throw error;
    }
  }

  #assertApplyingPlan(plan: InternalPlan): void {
    if (plan.state !== "applying") {
      throw this.#error("plan-invalidated", "plan is no longer valid", plan.operation.descriptor.operationId);
    }
  }

  #isPlanInvalidated(plan: InternalPlan): boolean {
    return plan.state === "invalidated";
  }

  #requireRelationRead(operationId: string, ownerOperationId: string, proof: OperationReadCompleteness): OperationAdapter {
    const adapter = this.#requireAdapter(operationId);
    this.#assertEligible(adapter);
    const descriptor = adapter.descriptor;
    if (adapter.risk !== "read" || descriptor.sideEffect !== "read" || descriptor.confirmation.required || RELATION_READ_METHODS[descriptor.method] !== true) {
      throw this.#error("operation-unavailable", "reconciliation relation must name a verified ordinary GET or HEAD read", ownerOperationId);
    }
    try {
      assertSafetyReadRequest(proof, descriptor, { path: {}, query: {} });
      if (proof.kind === "unpaginated-list" && !sourceUnpaginatedListProofMatches(operationId, proof, ownerOperationId)) throw new Error("unbound safety list proof");
    }
    catch { throw this.#error("operation-unavailable", "relation read has no source-qualified complete pagination proof", ownerOperationId); }
    return adapter;
  }

  #assertEligible(adapter: OperationAdapter): void {
    if (adapter.eligibility.status !== "verified") {
      throw this.#error("operation-unavailable", adapter.eligibility.reason, adapter.descriptor.operationId);
    }
  }

  #validate(adapter: OperationAdapter, input: unknown): ValidatedOperationInput {
    try { return adapter.validate(input); } catch (error) {
      if (error instanceof RegistryError && error.code === "invalid-input") {
        throw this.#error("invalid-input", "operation input is invalid", adapter.descriptor.operationId);
      }
      throw error;
    }
  }

  #selection(options: Pick<AdminPlanOptions, "profileId" | "endpoint">, fallback?: OperationSelection): OperationSelection {
    const profileId = options.profileId ?? fallback?.profileId ?? this.#adminBinding?.profileId;
    const endpointInput = options.endpoint ?? fallback?.endpoint ?? this.#adminBinding?.endpoint;
    if (!profileId || endpointInput === undefined || !validProfileId(profileId)) {
      throw this.#error("credential-required", "an operation profile and endpoint are required");
    }
    return { profileId, endpoint: privateEndpoint(endpointInput) };
  }

  async #resolveOperationAuth(
    descriptor: OperationDescriptor,
    selection: OperationSelection,
    request: AdminRequest,
    signal?: AbortSignal,
  ): Promise<AdminOperationAuthBinding> {
    if (request.operationId !== descriptor.operationId || request.operation !== descriptor) {
      throw this.#error("operation-unavailable", "authorization request does not match its source-qualified operation", descriptor.operationId);
    }
    throwIfAborted(signal, descriptor.operationId);
    if (this.#stopped) throw this.#error("shutdown", "administration is shut down", descriptor.operationId);
    const activation = this.#adminBinding;
    if (!activation?.enabled || this.#credentialBindingBlocked) throw this.#error("credential-disabled", "optional operations are not enabled", descriptor.operationId);
    if (activation.profileId !== selection.profileId || activation.endpoint !== selection.endpoint) throw this.#error("credential-mismatch", "operation activation changed", descriptor.operationId);
    const domain = descriptor.auth.domain;
    if (domain === "unknown") throw this.#error("credential-required", "operation authentication domain is unknown", descriptor.operationId);

    const policy = this.#sourcePolicy(descriptor);
    const loopback = endpointIsLoopback(selection.endpoint);
    if ("localOnly" in policy && policy.localOnly && !loopback) {
      throw this.#error("invalid-endpoint", "source-qualified operation requires a loopback endpoint", descriptor.operationId);
    }

    if (domain === "public") {
      if (policy.routeClass !== "public") throw this.#error("operation-unavailable", "public authentication contract is inconsistent", descriptor.operationId);
      return {
        domain,
        profileId: selection.profileId,
        endpoint: selection.endpoint,
        epoch: 0,
        authority: { kind: "uncredentialed", boundary: "public" },
      };
    }

    if (domain === "management") {
      if (policy.routeClass !== "management") throw this.#error("operation-unavailable", "management authentication contract is inconsistent", descriptor.operationId);
      const binding = this.#adminBinding;
      const credential = this.#credential;
      if (!binding?.enabled) throw this.#error("credential-disabled", "administration is not enabled", descriptor.operationId);
      if (binding.profileId !== selection.profileId || binding.endpoint !== selection.endpoint) {
        throw this.#error("credential-mismatch", "management binding changed", descriptor.operationId);
      }
      if (!credential?.enabled) {
        if (loopback && policy.alternatives.some(alternative => alternative.kind === "trusted-local" && alternative.loopbackOnly)) {
          return {
            domain,
            profileId: selection.profileId,
            endpoint: selection.endpoint,
            epoch: this.#managementEpoch,
            authority: { kind: "uncredentialed", boundary: "loopback" },
            signal: this.#managementController.signal,
          };
        }
        throw this.#error("credential-required", "management credential is required", descriptor.operationId);
      }
      if (credential.profileId !== selection.profileId || credential.endpoint !== selection.endpoint
        || credential.epoch !== this.#managementEpoch) {
        throw this.#error("credential-mismatch", "management binding changed", descriptor.operationId);
      }

      if (credential.apiKey?.startsWith("oma_") === true) {
        const requiredScope = requiredOmaScope(request.method, request.path);
        if (request.method === "GET" && request.path === "/api/cli/whoami"
          && descriptor.operationId === "GET /api/cli/whoami" && policy.bootstrap === "oma-whoami"
          && policy.alternatives.some(alternative => alternative.kind === "oma-whoami-bootstrap" && alternative.operationId === "GET /api/cli/whoami")) {
          const evidence = this.#omaAuthorityEvidence(this.#requireAdapter(descriptor.operationId));
          return {
            domain,
            profileId: credential.profileId,
            endpoint: credential.endpoint,
            epoch: credential.epoch,
            authority: { kind: "oma-whoami-bootstrap", evidence },
            credential: { kind: "apiKey", value: credential.apiKey },
            signal: this.#managementController.signal,
          };
        }
        if (!policy.alternatives.some(
          (alternative): alternative is Extract<ManagementAuthorizationAlternative, { readonly kind: "oma-access-token" }> =>
            alternative.kind === "oma-access-token" && alternative.minimumScope === requiredScope,
        )) {
          throw this.#error("operation-unavailable", "OMA source policy does not match the pinned method/path minimum", descriptor.operationId);
        }
        const observed = await this.#observeOmaScope(descriptor, selection, credential, signal);
        if (!scopeSatisfies(observed.scope, requiredScope)) {
          throw this.#error("missing-scope", "OMA access token scope is insufficient for this operation", descriptor.operationId);
        }
        return {
          domain,
          profileId: credential.profileId,
          endpoint: credential.endpoint,
          epoch: credential.epoch,
          authority: { kind: "oma-access-token", scope: observed.scope, evidence: observed.evidence },
          credential: { kind: "apiKey", value: credential.apiKey },
          signal: this.#managementController.signal,
        };
      }

      let resolvedCredential: AdminOperationAuthBinding["credential"];
      if (credential.apiKey !== undefined) {
        const acceptsManagementKey = policy.alternatives.some(alternative => alternative.kind === "management-api-key");
        const acceptsMcpKey = policy.alternatives.some(
          alternative => alternative.kind === "mcp-connect" && alternative.handlerOptIn && descriptor.pathTemplate.startsWith(alternative.pathPrefix),
        );
        if (!acceptsManagementKey && !acceptsMcpKey) throw this.#error("credential-required", "source-qualified policy does not accept this management API key", descriptor.operationId);
        resolvedCredential = { kind: "apiKey", value: credential.apiKey };
      } else if (credential.cookie !== undefined) {
        if (!policy.alternatives.some(alternative => alternative.kind === "dashboard-session")) {
          throw this.#error("credential-required", "source-qualified policy does not accept a dashboard session", descriptor.operationId);
        }
        resolvedCredential = { kind: "cookie", value: credential.cookie };
      } else {
        throw this.#error("credential-required", "management credential is unavailable", descriptor.operationId);
      }
      return {
        domain,
        profileId: credential.profileId,
        endpoint: credential.endpoint,
        epoch: credential.epoch,
        authority: {
          kind: "server-enforced",
          credentialKind: resolvedCredential.kind,
        },
        credential: resolvedCredential,
        signal: this.#managementController.signal,
      };
    }

    if (domain === "local") {
      if (policy.routeClass !== "local" || !loopback || !policy.alternatives.some(alternative => alternative.kind === "trusted-local" && alternative.loopbackOnly)) {
        throw this.#error("invalid-endpoint", "local operation requires its source-qualified loopback boundary", descriptor.operationId);
      }
      return {
        domain,
        profileId: selection.profileId,
        endpoint: selection.endpoint,
        epoch: 0,
        authority: { kind: "uncredentialed", boundary: "loopback" },
        signal: this.#managementController.signal,
      };
    }

    const requiredAlternative = domain === "runtime" ? "runtime-api-key" : "metadata-api-key";
    if ((policy.routeClass !== "client-api" && policy.routeClass !== "management")
      || !policy.alternatives.some(alternative => alternative.kind === requiredAlternative)) {
      throw this.#error("operation-unavailable", "source-qualified API key policy is unavailable", descriptor.operationId);
    }
    if (!this.#resolveAuth) throw this.#error("credential-required", "operation authentication resolver is unavailable", descriptor.operationId);
    let resolved: AdminOperationAuthBinding | undefined;
    try {
      resolved = await this.#resolveAuth(descriptor, {
        ...selection,
        ...(signal === undefined ? {} : { signal }),
      });
    } catch {
      throwIfAborted(signal, descriptor.operationId);
      throw this.#error("credential-required", "operation authentication is unavailable", descriptor.operationId);
    }
    throwIfAborted(signal, descriptor.operationId);
    if (typeof resolved !== "object" || resolved === null) throw this.#error("credential-required", "operation authentication is unavailable", descriptor.operationId);
    if (resolved.domain !== domain || resolved.profileId !== selection.profileId || !validProfileId(resolved.profileId)) {
      throw this.#error("credential-mismatch", "operation authentication binding changed", descriptor.operationId);
    }
    let endpoint: string;
    try { endpoint = privateEndpoint(resolved.endpoint); } catch { throw this.#error("invalid-endpoint", "operation authentication endpoint is invalid", descriptor.operationId); }
    if (endpoint !== selection.endpoint) throw this.#error("credential-mismatch", "operation authentication endpoint changed", descriptor.operationId);
    if (!Number.isSafeInteger(resolved.epoch) || resolved.epoch < 0) throw this.#error("credential-mismatch", "operation authentication epoch is invalid", descriptor.operationId);
    if (resolved.authority.kind !== "server-enforced" || resolved.authority.credentialKind !== "apiKey") {
      throw this.#error("credential-mismatch", "API key authority binding is invalid", descriptor.operationId);
    }

    if (resolved.credential === undefined || resolved.credential.kind !== "apiKey"
      || !credentialValueValid(resolved.credential.value)) {
      throw this.#error("credential-required", "operation requires its own API key", descriptor.operationId);
    }
    return {
      domain,
      profileId: resolved.profileId,
      endpoint,
      epoch: resolved.epoch,
      authority: resolved.authority,
      credential: { kind: "apiKey", value: resolved.credential.value },
      ...(resolved.signal === undefined ? {} : { signal: resolved.signal }),
    };
  }

  #sourcePolicy(descriptor: OperationDescriptor): Exclude<OperationSourceAuthorizationPolicy, { readonly status: "unknown" }> {
    const policy = descriptor.auth.sourcePolicy;
    if (policy.status !== "qualified") throw this.#error("operation-unavailable", "operation has no source-qualified authorization contract", descriptor.operationId);
    return policy;
  }

  #omaAuthorityEvidence(adapter: OperationAdapter): OMAAuthorityEvidence {
    const receipt = adapter.descriptor.qualification;
    if (adapter.eligibility.status !== "verified" || !receipt || adapter.descriptor.operationId !== "GET /api/cli/whoami") {
      throw this.#error("operation-unavailable", "qualified OMA whoami evidence is unavailable", "GET /api/cli/whoami");
    }
    return {
      operationId: adapter.descriptor.operationId,
      releaseCommit: receipt.releaseCommit,
      sourceSha256: receipt.binding.handlerSha256,
      testId: receipt.test.id,
      caseSha256: receipt.test.caseSha256,
      outcomeSha256: receipt.test.outcomeSha256,
    };
  }

  async #observeOmaScope(
    descriptor: OperationDescriptor,
    selection: OperationSelection,
    credential: InternalCredential,
    signal?: AbortSignal,
  ): Promise<{ readonly scope: OMAAccessTokenScope; readonly evidence: OMAAuthorityEvidence }> {
    const operationId = "GET /api/cli/whoami";
    const whoami = this.#requireAdapter(operationId);
    const policy = this.#sourcePolicy(whoami.descriptor);
    if (policy.routeClass !== "management" || policy.bootstrap !== "oma-whoami"
      || !policy.alternatives.some(alternative => alternative.kind === "oma-whoami-bootstrap" && alternative.operationId === operationId)) {
      throw this.#error("operation-unavailable", "source-qualified OMA whoami bootstrap is unavailable", descriptor.operationId);
    }
    this.#assertEligible(whoami);
    if (!credential.apiKey?.startsWith("oma_")) throw this.#error("credential-mismatch", "OMA access token binding changed", descriptor.operationId);

    const evidence = this.#omaAuthorityEvidence(whoami);
    const auth: AdminOperationAuthBinding = {
      domain: "management",
      profileId: credential.profileId,
      endpoint: credential.endpoint,
      epoch: credential.epoch,
      authority: { kind: "oma-whoami-bootstrap", evidence },
      credential: { kind: "apiKey", value: credential.apiKey },
      signal: this.#managementController.signal,
    };
    const request = requestFor(whoami, selection.endpoint, this.#validate(whoami, {}));
    let raw: unknown;
    try {
      raw = await withAuth(auth, [signal], operationId, async (boundAuth, combinedSignal) => {
        return this.#dispatch(request, this.#dispatchContext(boundAuth, whoami.descriptor, this.#retryAllowed(whoami), combinedSignal));
      });
    } catch (error) {
      throwIfAborted(signal, descriptor.operationId);
      if (error instanceof AdminError) throw error;
      const failure = safeError(error);
      if (failure.status === 401 || failure.status === 403) {
        throw this.#error("unauthorized", "OMA access token could not authenticate to qualified whoami", descriptor.operationId, failure.status);
      }
      throw this.#error("credential-required", "OMA token scope could not be observed from qualified whoami", descriptor.operationId, failure.status);
    }

    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      throw this.#error("missing-scope", "qualified whoami did not return an authenticated OMA token identity", descriptor.operationId);
    }
    let projected: unknown;
    try { projected = whoami.project(raw); } catch {
      throw this.#error("missing-scope", "qualified whoami response did not satisfy its source contract", descriptor.operationId);
    }
    if (typeof projected !== "object" || projected === null || Array.isArray(projected)) {
      throw this.#error("missing-scope", "qualified whoami response did not satisfy its source contract", descriptor.operationId);
    }
    const response = raw as { readonly authenticated?: unknown; readonly viaAccessToken?: unknown; readonly scope?: unknown };
    if (response.authenticated !== true || response.viaAccessToken !== true
      || (response.scope !== "read" && response.scope !== "write" && response.scope !== "admin")) {
      throw this.#error("missing-scope", "qualified whoami did not prove a valid OMA token scope", descriptor.operationId);
    }
    return { scope: response.scope, evidence };
  }

  #assertAuthUnchanged(before: AdminOperationAuthBinding, after: AdminOperationAuthBinding, descriptor: OperationDescriptor): void {
    if (!sameIdentity(identityOf(before), identityOf(after)) || !sameAuthority(before.authority, after.authority)) {
      throw this.#error("credential-mismatch", "operation authentication changed during verification", descriptor.operationId);
    }
  }

  #assertPlannedAuth(
    identity: AdminAuthIdentity,
    authority: AdminAuthorizationAuthority,
    current: AdminOperationAuthBinding,
    descriptor: OperationDescriptor,
  ): void {
    if (!sameIdentity(identity, identityOf(current)) || !sameAuthority(authority, current.authority)) {
      throw this.#error("credential-mismatch", "operation authentication changed since preview", descriptor.operationId);
    }
  }

  #safetyForPlan(adapter: OperationAdapter): OperationMutationSafety {
    const safety = adapter.descriptor.mutationSafety;
    if (!safety || !safety.preflight || !safety.reconciliation || !safety.settlement
      || !Array.isArray(safety.settlement.responseComplete?.statusCodes)) {
      throw this.#error("operation-unavailable", "verified mutation safety contract is missing", adapter.descriptor.operationId);
    }
    if (safety.preflight.kind === "required" && (!Array.isArray(safety.preflight.observations) || safety.preflight.observations.length === 0)) {
      throw this.#error("operation-unavailable", "required preflight observations are missing", adapter.descriptor.operationId);
    }
    if (!["required", "not-applicable", "unavailable"].includes(safety.preflight.kind)
      || !["complete", "unknown"].includes(safety.reconciliation.kind)) {
      throw this.#error("operation-unavailable", "mutation safety decision is invalid", adapter.descriptor.operationId);
    }
    const invalidVisibilityLimits = safety.preflight.kind === "required" && safety.preflight.visibilityLimits !== undefined
      && (!Array.isArray(safety.preflight.visibilityLimits) || safety.preflight.visibilityLimits.length < 1
        || safety.preflight.visibilityLimits.length > 16
        || safety.preflight.visibilityLimits.some(limit => typeof limit !== "string" || limit.trim().length === 0
          || limit.length > 500 || /[\u0000-\u001f\u007f]/.test(limit)));
    if (safety.preflight.kind === "required" && (safety.preflight.observations.length > 16
      || new Set(safety.preflight.observations.map(item => item.name)).size !== safety.preflight.observations.length
      || safety.preflight.observations.some(item => !item.name || !item.read?.operationId
        || !["single-response", "unpaginated-list"].includes(item.readCompleteness?.kind) || !item.readCompleteness.sourceReason)
      || invalidVisibilityLimits)) {
      throw this.#error("operation-unavailable", "required preflight observations are invalid", adapter.descriptor.operationId);
    }
    if (safety.preflight.kind === "not-applicable" && !safety.preflight.sourceReason) {
      throw this.#error("operation-unavailable", "preflight exception has no source reason", adapter.descriptor.operationId);
    }
    if (safety.reconciliation.kind === "complete" && (!Array.isArray(safety.reconciliation.postconditions) || safety.reconciliation.postconditions.length === 0)) {
      throw this.#error("operation-unavailable", "complete reconciliation has no postconditions", adapter.descriptor.operationId);
    }
    if (safety.reconciliation.kind === "complete" && (safety.reconciliation.postconditions.length > 16
      || new Set(safety.reconciliation.postconditions.map(item => item.name)).size !== safety.reconciliation.postconditions.length
      || safety.reconciliation.postconditions.some(item => !item.name || !item.relation?.reconcile?.operationId
        || !["single-response", "unpaginated-list"].includes(item.readCompleteness?.kind) || !item.readCompleteness.sourceReason))) {
      throw this.#error("operation-unavailable", "complete reconciliation postconditions are invalid", adapter.descriptor.operationId);
    }
    if (new Set(safety.settlement.responseComplete.statusCodes).size !== safety.settlement.responseComplete.statusCodes.length
      || safety.settlement.responseComplete.statusCodes.some(status => !Number.isInteger(status) || status < 200 || status > 299
        || !adapter.descriptor.response.statusCodes.includes(String(status)))) {
      throw this.#error("operation-unavailable", "response settlement status is not source declared", adapter.descriptor.operationId);
    }
    if (safety.settlement.definiteRejection !== null) {
      throw this.#error("operation-unavailable", "definite rejection source classifier is unavailable", adapter.descriptor.operationId);
    }
    return safety;
  }

  async #readRelationTarget(
    operation: OperationAdapter,
    payload: ValidatedOperationInput,
    relation: OperationReconciliationRelation["targetRead"],
    readCompleteness: OperationReadCompleteness,
    readOperation: OperationAdapter,
    selection: OperationSelection,
    mutationAuth: AdminOperationAuthBinding,
    signal?: AbortSignal,
  ): Promise<{ target: AdminTarget; auth: AdminOperationAuthBinding; request: AdminRequest }> {
    if (!this.#readTarget) throw this.#error("target-drift", "reconciliation target reader is unavailable", operation.descriptor.operationId);
    this.#assertEligible(readOperation);
    const readInput = readOperation.validate(mapRelationInput(relation.inputs, payload));
    assertSafetyReadRequest(readCompleteness, readOperation.descriptor, readInput);
    const request = requestFor(readOperation, selection.endpoint, readInput);
    const auth = await this.#resolveOperationAuth(readOperation.descriptor, selection, request, signal);
    return withAuth(auth, [mutationAuth.signal, signal], operation.descriptor.operationId, async (boundAuth, combinedSignal) => {
      const result = await this.#readTarget?.({
        auth: boundAuth,
        operation: operation.descriptor,
        payload,
        relation,
        readCompleteness,
        readOperation: readOperation.descriptor,
        ...(combinedSignal === undefined ? {} : { signal: combinedSignal }),
      });
      if (!result || typeof result.digest !== "string" || !SHA256_DIGEST.test(result.digest)) {
        throw this.#error("target-drift", "reconciliation target digest is invalid", operation.descriptor.operationId);
      }
      let computedDigest: string;
      try { computedDigest = digest(result.snapshot); } catch {
        throw this.#error("target-drift", "reconciliation target snapshot is invalid", operation.descriptor.operationId);
      }
      if (computedDigest !== result.digest) throw this.#error("target-drift", "reconciliation target snapshot digest does not match", operation.descriptor.operationId);
      return { target: { digest: result.digest, snapshot: result.snapshot }, auth, request };
    });
  }

  #dispatchContext(auth: AdminOperationAuthBinding, descriptor: OperationDescriptor, retryAllowed: boolean, signal?: AbortSignal): AdminDispatchContext {
    const canRetry = retryAllowed && descriptor.retry.allowed;
    return {
      auth,
      retryAllowed: canRetry,
      maxAttempts: canRetry ? Math.min(2, descriptor.retry.maxAttempts) : 1,
      ...(signal === undefined ? {} : { signal }),
    };
  }

  #retryAllowed(adapter: OperationAdapter): boolean {
    return adapter.risk === "read" && SAFE_READ_METHODS[adapter.descriptor.method] === true;
  }

  async #reconcileOutcome(
    plan: InternalPlan,
    request: AdminRequest,
    originalError: unknown,
    signal?: AbortSignal,
  ): Promise<AdminReconcileResult> {
    const reconcile = this.#reconcile;
    if (!reconcile || plan.mutationSafety.reconciliation.kind !== "complete" || plan.postconditions.length === 0) return { status: "unknown" };
    try {
      const selection = { profileId: plan.auth.profileId, endpoint: plan.auth.endpoint };
      const operationAuth = await this.#resolveOperationAuth(plan.operation.descriptor, selection, request, signal);
      this.#assertPlannedAuth(plan.auth, plan.authAuthority, operationAuth, plan.operation.descriptor);
      const observedAuth: { item: PlannedPostcondition; signal?: AbortSignal }[] = [];
      for (const item of plan.postconditions) {
        this.#assertEligible(item.readOperation);
        const readInput = item.readOperation.validate(mapRelationInput(item.relation.reconcile.inputs, plan.input));
        assertSafetyReadRequest(item.readCompleteness, item.readOperation.descriptor, readInput);
        const readRequest = requestFor(item.readOperation, selection.endpoint, readInput);
        const auth = await this.#resolveOperationAuth(item.readOperation.descriptor, selection, readRequest, signal);
        this.#assertPlannedAuth(item.auth, item.authority, auth, item.readOperation.descriptor);
        observedAuth.push({ item, ...(auth.signal === undefined ? {} : { signal: auth.signal }) });
        const result = await withAuth(auth, [operationAuth.signal, signal], plan.operation.descriptor.operationId, async (boundAuth, combinedSignal) => {
          const context: AdminReconcileContext = {
            auth: boundAuth,
            operation: plan.operation.descriptor,
            request,
            payload: plan.input,
            relation: item.relation.reconcile,
            fullRelation: item.relation,
            readCompleteness: item.readCompleteness,
            readOperation: item.readOperation.descriptor,
            originalTarget: item.target.snapshot,
            originalError,
            ...(combinedSignal === undefined ? {} : { signal: combinedSignal }),
          };
          return reconcile(context);
        });
        if (result.status !== "applied") return { status: "unknown" };
      }
      for (const { item, signal: observedSignal } of observedAuth) {
        throwIfAborted(observedSignal, plan.operation.descriptor.operationId);
        const readInput = item.readOperation.validate(mapRelationInput(item.relation.reconcile.inputs, plan.input));
        const latestAuth = await this.#resolveOperationAuth(item.readOperation.descriptor, selection,
          requestFor(item.readOperation, selection.endpoint, readInput), signal);
        this.#assertPlannedAuth(item.auth, item.authority, latestAuth, item.readOperation.descriptor);
      }
      for (const { signal: observedSignal } of observedAuth) throwIfAborted(observedSignal, plan.operation.descriptor.operationId);
      throwIfAborted(operationAuth.signal, plan.operation.descriptor.operationId);
      const latestOperationAuth = await this.#resolveOperationAuth(plan.operation.descriptor, selection, request, signal);
      this.#assertPlannedAuth(plan.auth, plan.authAuthority, latestOperationAuth, plan.operation.descriptor);
      throwIfAborted(operationAuth.signal, plan.operation.descriptor.operationId);
      return { status: "applied" };
    } catch {
      return { status: "unknown" };
    }
  }

  #handle(plan: InternalPlan): AdminPlanHandle {
    return {
      planId: plan.planId,
      operationId: plan.operation.descriptor.operationId,
      auth: { ...plan.auth },
      targetAuth: plan.targetAuth === null ? null : { ...plan.targetAuth },
      payloadDigest: plan.payloadDigest,
      targetDigest: plan.targetDigest,
      risk: plan.operation.risk,
      createdAt: plan.createdAt,
      expiresAt: plan.expiresAt,
      state: plan.state,
      preview: structuredClone(plan.preview),
    };
  }

  #denied(plan: InternalPlan, code: AdminErrorCode, message: string): AdminApplyResult {
    const error = this.#error(code, message, plan.operation.descriptor.operationId);
    return { status: "denied", plan: this.#handle(plan), error: errorResult(error) };
  }

  #advanceManagementEpoch(): void {
    this.#managementEpoch += 1;
    this.#managementController.abort();
    this.#managementController = new AbortController();
  }

  #renewManagementSignal(): void {
    this.#managementController.abort();
    this.#managementController = new AbortController();
  }

  #error(code: AdminErrorCode, message: string, operationId?: string, status?: number): AdminError {
    return new AdminError(code, message, {
      correlationId: correlationId(),
      ...(operationId === undefined ? {} : { operationId }),
      ...(status === undefined ? {} : { status }),
    });
  }
}

export function createAdminExecutor(options: AdminExecutorOptions): AdminExecutor {
  return new AdminExecutorImpl(options);
}
