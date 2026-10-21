import type {
  OperationDescriptor,
  OperationReconciliationRelation,
  OperationRegistry,
  ValidatedOperationInput,
} from "./registry.ts";

export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type AdminMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";
export type AdminAuthDomain = "public" | "runtime" | "metadata" | "management" | "local" | "unknown";
export type AdminSideEffect = "read" | "unknown" | "mutation" | "secret" | "lifecycle" | "destructive";
export type AdminRisk = "read" | "gated-read" | "mutation" | "secret" | "lifecycle" | "destructive";

/** Secret-free binding identity suitable for plan handles and audit display. */
export interface AdminAuthIdentity {
  readonly domain: Exclude<AdminAuthDomain, "unknown">;
  readonly profileId: string;
  readonly endpoint: string;
  readonly epoch: number;
}

export interface OMAAuthorityEvidence {
  readonly operationId: "GET /api/cli/whoami";
  readonly releaseCommit: string;
  readonly sourceSha256: string;
  readonly testId: string;
  readonly caseSha256: string;
  readonly outcomeSha256: string;
}

/** The difference between server-enforced credentials and a scope actually observed from a qualified OMA token. */
export type AdminAuthorizationAuthority =
  | { readonly kind: "server-enforced"; readonly credentialKind: "apiKey" | "cookie" }
  | { readonly kind: "uncredentialed"; readonly boundary: "public" | "loopback" }
  | { readonly kind: "oma-access-token"; readonly scope: "read" | "write" | "admin"; readonly evidence: OMAAuthorityEvidence }
  | { readonly kind: "oma-whoami-bootstrap"; readonly evidence: OMAAuthorityEvidence };

/** Resolved operation authority; credential and cancellation state are transient only. */
export interface AdminOperationAuthBinding extends AdminAuthIdentity {
  readonly authority: AdminAuthorizationAuthority;
  readonly credential?: { readonly kind: "apiKey" | "cookie"; readonly value: string };
  readonly signal?: AbortSignal;
}

/** Safe view of the executor-owned management credential binding. */
export interface AdminCredentialBinding {
  readonly profileId: string;
  readonly endpoint: string;
  readonly epoch: number;
  readonly credentialKind: "apiKey" | "cookie";
  readonly authority: "server-enforced" | "oma-scope-unverified";
  readonly enabled: boolean;
}

export interface AdminCredentialInput {
  readonly profileId: string;
  readonly endpoint: string;
  readonly apiKey?: string;
  readonly cookie?: string;
}
export type AdminAuthorizationSummary =
  | { readonly kind: "not-required"; readonly message: "This source-qualified operation requires no credential." }
  | { readonly kind: "server-enforced"; readonly message: "The server enforces credential permissions; this preview did not preflight them." }
  | { readonly kind: "oma-scope-observed"; readonly scope: "read" | "write" | "admin"; readonly message: "The OMA CLI token scope was observed from the qualified whoami operation for this preview." }
  | { readonly kind: "oma-scope-bootstrap"; readonly message: "This exact whoami request observes OMA CLI token scope; no scope is assumed before it." };

export interface AdminTarget {
  readonly digest: string;
  readonly snapshot: JsonValue;
}

export interface AdminPlanHandle {
  readonly planId: string;
  readonly operationId: string;
  readonly auth: AdminAuthIdentity;
  readonly targetAuth: AdminAuthIdentity | null;
  readonly payloadDigest: string;
  readonly targetDigest: string | null;
  readonly risk: AdminRisk;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly state: "pending" | "applying" | "applied" | "operator-required" | "unknown" | "expired" | "invalidated";
  readonly preview: AdminPreview;
}


export interface AdminPreview {
  readonly operationId: string;
  readonly method: AdminMethod;
  readonly pathTemplate: string;
  readonly target: { readonly profileId: string; readonly endpoint: string };
  readonly risk: AdminRisk;
  readonly confirmationRequired: boolean;
  readonly sideEffect: AdminSideEffect;
  readonly authorization: AdminAuthorizationSummary;
  readonly payload: ValidatedOperationInput;
  readonly projectedTarget?: unknown;
  readonly consequence: string;
  readonly resolvedPath: string;
  readonly queryParameters: readonly AdminQueryParameter[];
  readonly planDigest: string;
}

/** Percent-encoded name/value components, serialized by the closed OpenAPI query contract. */
export interface AdminQueryParameter {
  readonly encodedName: string;
  readonly encodedValue: string;
}



export interface AdminRequest {
  readonly operationId: string;
  readonly method: AdminMethod;
  readonly url: string;
  readonly path: string;
  readonly queryParameters: readonly AdminQueryParameter[];
  readonly body?: JsonValue;
  readonly operation: OperationDescriptor;
}

export interface AdminDispatchContext {
  readonly auth: AdminOperationAuthBinding;
  readonly retryAllowed: boolean;
  readonly maxAttempts: number;
  readonly signal?: AbortSignal;
}

export interface AdminReconcileContext {
  readonly auth: AdminOperationAuthBinding;
  readonly operation: OperationDescriptor;
  readonly request: AdminRequest;
  readonly payload: ValidatedOperationInput;
  readonly relation: OperationReconciliationRelation["reconcile"];
  readonly readOperation: OperationDescriptor;
  readonly originalTarget: JsonValue;
  readonly originalError: unknown;
  readonly signal?: AbortSignal;
}

export type AdminReconcileResult =
  | { readonly status: "applied"; readonly output?: unknown }
  | { readonly status: "unknown" };

export type AdminDispatch = (request: AdminRequest, context: AdminDispatchContext) => Promise<unknown>;
export type AdminTargetReader = (context: {
  readonly auth: AdminOperationAuthBinding;
  readonly operation: OperationDescriptor;
  readonly payload: ValidatedOperationInput;
  readonly relation: OperationReconciliationRelation["targetRead"];
  readonly readOperation: OperationDescriptor;
  readonly signal?: AbortSignal;
}) => Promise<AdminTarget>;
export type AdminReconciler = (context: AdminReconcileContext) => Promise<AdminReconcileResult>;

export interface AdminExecutorOptions {
  readonly dispatch: AdminDispatch;
  readonly readTarget?: AdminTargetReader;
  readonly reconcile?: AdminReconciler;
  readonly resolveAuth?: (
    operation: OperationDescriptor,
    context: { readonly profileId: string; readonly endpoint: string; readonly signal?: AbortSignal },
  ) => AdminOperationAuthBinding | undefined | Promise<AdminOperationAuthBinding | undefined>;
  readonly registry?: OperationRegistry;
  readonly planTtlMs?: number;
  readonly now?: () => number;
  readonly randomId?: () => string;
}

export interface AdminApplyAuthorization {
  /** Human confirmation; aliases are accepted for adapters that use confirm. */
  readonly confirmed?: boolean;
  readonly confirm?: boolean;
  /** A headless caller is never allowed to apply, even when yolo is set. */
  readonly headless?: boolean;
  readonly profileId?: string;
  readonly endpoint?: string;
  readonly targetDigest?: string;
  readonly signal?: AbortSignal;
}

export type AdminErrorCode =
  | "unknown-operation"
  | "non-invokable"
  | "operation-unavailable"
  | "invalid-input"
  | "credential-required"
  | "credential-disabled"
  | "credential-mismatch"
  | "missing-scope"
  | "invalid-endpoint"
  | "plan-not-found"
  | "plan-expired"
  | "plan-invalidated"
  | "plan-already-applied"
  | "plan-in-progress"
  | "confirmation-required"
  | "headless-denied"
  | "target-drift"
  | "preview-too-large"
  | "dispatch-failed"
  | "unauthorized"
  | "uncertain-outcome"
  | "reconciliation-failed"
  | "shutdown";

export interface AdminErrorDetails {
  readonly status?: number;
  readonly operationId?: string;
  readonly correlationId: string;
}

export class AdminError extends Error {
  readonly code: AdminErrorCode;
  readonly status: number | undefined;
  readonly operationId: string | undefined;
  readonly correlationId: string;

  constructor(code: AdminErrorCode, message: string, details: AdminErrorDetails) {
    super(escapeControls(message));
    this.name = "AdminError";
    this.code = code;
    this.status = details.status;
    this.operationId = details.operationId;
    this.correlationId = sanitizeCorrelation(details.correlationId);
  }

  toJSON(): AdminErrorResult {
    return {
      code: this.code,
      correlationId: this.correlationId,
      ...(this.status === undefined ? {} : { status: this.status }),
      ...(this.operationId === undefined ? {} : { operationId: this.operationId }),
    };
  }
}

export interface AdminErrorResult {
  readonly code: AdminErrorCode;
  readonly status?: number;
  readonly operationId?: string;
  readonly correlationId: string;
}

export interface AdminApplyResult {
  readonly status: "applied" | "denied" | "operator-required" | "unknown";
  readonly plan: AdminPlanHandle;
  readonly output?: unknown;
  readonly error?: AdminErrorResult;
}

export interface AdminReadResult {
  readonly operationId: string;
  readonly output: unknown;
  readonly correlationId: string;
}

export function escapeControls(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function sanitizeCorrelation(value: string): string {
  const cleaned = value.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64);
  return cleaned || "redacted";
}

export function safeError(error: unknown): { status?: number; uncertain: boolean } {
  if (error instanceof AdminError) {
    return { ...(error.status === undefined ? {} : { status: error.status }), uncertain: error.code === "uncertain-outcome" };
  }
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    const status = typeof record.status === "number" && Number.isFinite(record.status) ? record.status : undefined;
    const code = typeof record.code === "string" ? record.code : "";
    const networkFailure = status === undefined && ["aborted", "cancelled", "network", "request_failed", "timeout"].includes(code);
    return { ...(status === undefined ? {} : { status }), uncertain: record.uncertain === true || code === "network-lost-response" || networkFailure };
  }
  return { uncertain: false };
}
