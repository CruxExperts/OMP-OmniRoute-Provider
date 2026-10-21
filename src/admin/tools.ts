import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getOperationRegistry, type OperationAdapter } from "./registry.ts";
import type { AdminExecutor } from "./executor.ts";
import { clearAdminUiSession, rememberAdminPlan, type AdminUiOptions, runAdminApply } from "./ui.ts";

const DEFAULT_PROFILE = "omniroute";

type ToolContext = ExtensionContext;

export interface AdminToolsOptions {
  readonly executor: AdminExecutor;
  readonly ui: AdminUiOptions;
  readonly profileId?: string;
  endpoint?: string;
  readonly syncBinding?: () => Promise<void>;
  readonly isEnabled: () => boolean;
}

function safeText(value: unknown): string {
  try {
    const serialized = JSON.stringify(value, (_key, child) => typeof child === "string" ? child.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 2_000) : child) ?? "[unavailable]";
    return serialized.slice(0, 12_000);
  } catch {
    return "[unavailable]";
  }
}

function errorOutput(error: unknown, operationId?: string): { code: string; status?: number; operationId?: string; correlationId: string } {
  if (error !== null && typeof error === "object") {
    const code = "code" in error && typeof error.code === "string" ? error.code : "request_failed";
    const correlationId = "correlationId" in error && typeof error.correlationId === "string"
      ? error.correlationId.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "redacted"
      : "redacted";
    const output: { code: string; status?: number; operationId?: string; correlationId: string } = { code, correlationId };
    if ("status" in error && typeof error.status === "number") output.status = error.status;
    if ("operationId" in error && typeof error.operationId === "string") output.operationId = error.operationId;
    else if (operationId) output.operationId = operationId;
    return output;
  }
  return { code: "request_failed", ...(operationId ? { operationId } : {}), correlationId: "redacted" };
}

function safeRead(adapter: OperationAdapter): boolean {
  return adapter.risk === "read" && adapter.descriptor.sideEffect === "read"
    && !adapter.descriptor.confirmation.required
    && adapter.descriptor.secrets.inputFields.length === 0;
}

function eligibleIds(mode: "read" | "plan"): string[] {
  return getOperationRegistry().listOperations()
    .filter(adapter => adapter.eligibility.status === "verified")
    .filter(adapter => mode === "read" ? safeRead(adapter) : !safeRead(adapter) && adapter.descriptor.secrets.inputFields.length === 0)
    .map(adapter => adapter.descriptor.operationId);
}

function parseInput(input: unknown): unknown {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("input must be an object");
  return input;
}

function credentialFromEnvironment(options: AdminToolsOptions): void {
  const endpoint = options.endpoint ?? options.ui.endpoint;
  if (!endpoint) return;
  const apiKey = process.env.OMP_OMNIROUTE_ADMIN_API_KEY?.trim();
  const cookie = process.env.OMP_OMNIROUTE_ADMIN_COOKIE?.trim();
  if (!apiKey && !cookie) return;
  options.executor.bindCredential({
    profileId: options.profileId ?? options.ui.profileId ?? DEFAULT_PROFILE,
    endpoint,
    ...(apiKey ? { apiKey } : {}),
    ...(cookie ? { cookie } : {}),
  });
}

type ToolOutput = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };

function content(text: string): ToolOutput {
  return { content: [{ type: "text", text }], details: {} };
}

async function executeRead(options: AdminToolsOptions, operationId: string, input: unknown, signal?: AbortSignal): Promise<ToolOutput> {
  const adapter = getOperationRegistry().lookup(operationId);
  if (!adapter) {
    const descriptor = getOperationRegistry().getOperation(operationId);
    return content(safeText({ code: descriptor ? "operation-unavailable" : "unknown-operation", operationId, correlationId: "redacted", ...(descriptor ? { reason: descriptor.coverage.reason ?? "non-invokable closed descriptor" } : {}) }));
  }
  if (adapter.eligibility.status !== "verified") {
    return content(safeText({ code: "operation-unavailable", operationId, correlationId: "redacted", reason: adapter.eligibility.reason }));
  }
  if (!safeRead(adapter)) {
    return content(safeText({ code: "confirmation-required", operationId, correlationId: "redacted", message: "gated reads and mutations require the human plan/apply workflow" }));
  }
  try {
    await options.syncBinding?.();
    if (!options.isEnabled()) return content(safeText({ code: "credential-disabled", operationId, correlationId: "redacted" }));
    if (adapter.descriptor.auth.domain === "management") credentialFromEnvironment(options);
    const result = await options.executor.read(operationId, parseInput(input), {
      confirmed: true,
      headless: false,
      ...(options.endpoint ?? options.ui.endpoint ? { endpoint: options.endpoint ?? options.ui.endpoint } : {}),
      ...(options.profileId ?? options.ui.profileId ? { profileId: options.profileId ?? options.ui.profileId } : {}),
      ...(signal === undefined ? {} : { signal }),
    });
    return content(safeText({ operationId: result.operationId, output: result.output, correlationId: result.correlationId }));
  } catch (error) {
    return content(safeText(errorOutput(error, operationId)));
  }
}
async function executePlan(options: AdminToolsOptions, operationId: string, input: unknown, signal?: AbortSignal): Promise<ToolOutput> {
  const adapter = getOperationRegistry().lookup(operationId);
  if (!adapter) {
    const descriptor = getOperationRegistry().getOperation(operationId);
    return content(safeText({ code: descriptor ? "operation-unavailable" : "unknown-operation", operationId, correlationId: "redacted", ...(descriptor ? { reason: descriptor.coverage.reason ?? "non-invokable closed descriptor" } : {}) }));
  }
  if (adapter.eligibility.status !== "verified") {
    return content(safeText({ code: "operation-unavailable", operationId, correlationId: "redacted", reason: adapter.eligibility.reason }));
  }
  if (adapter.descriptor.secrets.inputFields.length > 0) {
    return content(safeText({ code: "confirmation-required", operationId, correlationId: "redacted", message: "secret-bearing inputs are human-only and must be entered in /cruxomni-admin" }));
  }
  try {
    await options.syncBinding?.();
    if (!options.isEnabled()) return content(safeText({ code: "credential-disabled", operationId, correlationId: "redacted" }));
    if (adapter.descriptor.auth.domain === "management") credentialFromEnvironment(options);
    const validated = adapter.validate(parseInput(input));
    const plan = await options.executor.plan(operationId, validated, {
      ...(options.endpoint ?? options.ui.endpoint ? { endpoint: options.endpoint ?? options.ui.endpoint } : {}),
      ...(options.profileId ?? options.ui.profileId ? { profileId: options.profileId ?? options.ui.profileId } : {}),
      ...(signal === undefined ? {} : { signal }),
    });
    rememberAdminPlan(options.ui, plan);
    return content(safeText({
      planId: plan.planId,
      operationId: plan.operationId,
      risk: plan.risk,
      target: { profileId: plan.auth.profileId, endpoint: plan.auth.endpoint },
      expiresAt: plan.expiresAt,
      preview: plan.preview,
      next: "/cruxomni-admin apply",
    }));
  } catch (error) {
    return content(safeText(errorOutput(error, operationId)));
  }
}
export function registerAdminTools(pi: ExtensionAPI, options: AdminToolsOptions): readonly string[] {
  if (!options.isEnabled()) return [];
  const z = pi.zod;
  const registered: string[] = [];
  for (const mode of ["read", "plan"] as const) {
    const ids = eligibleIds(mode);
    const first = ids[0];
    if (first === undefined) continue;
    const name = `omniroute_admin_${mode}`;
    const parameters = z.object({ operationId: z.enum([first, ...ids.slice(1)]), input: z.record(z.string(), z.unknown()).optional() }).strict();
    pi.registerTool({
      name,
      label: mode === "read" ? "OmniRoute Admin Read" : "OmniRoute Admin Plan",
      description: mode === "read"
        ? "Read a behavior-verified ordinary OmniRoute operation through its allowlisted projection."
        : "Validate and preview a behavior-verified OmniRoute operation; only a human can apply it.",
      parameters,
      defaultInactive: true,
      strict: true,
      approval: "read",
      execute: async (_toolCallId, params, signal) => mode === "read"
        ? executeRead(options, params.operationId, params.input ?? {}, signal)
        : executePlan(options, params.operationId, params.input ?? {}, signal),
    });
    registered.push(name);
  }
  return registered;
}

export function clearAdminToolsSession(options: AdminToolsOptions): void {
  clearAdminUiSession(options.ui);
  options.executor.logout();
}

export { runAdminApply };
