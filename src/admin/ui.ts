import { Input } from "@oh-my-pi/pi-tui";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { getOperationRegistry, redactSourceOutput, type OperationAdapter, type OperationRegistry } from "./registry.ts";
import { escapeControls, type AdminCredentialInput, type AdminPlanHandle, type AdminPreview } from "./types.ts";
import type { AdminExecutor } from "./executor.ts";
import { isLoopbackHostname } from "./adapters.ts";

const DEFAULT_PROFILE = "omniroute";
type AdminContext = ExtensionContext;

export interface AdminBinding {
  readonly endpoint: string;
}

export interface AdminUiOptions {
  readonly executor: AdminExecutor;
  /**
   * Optional closed registry matching the executor. Production uses the
   * singleton registry; the injection point also permits isolated UI tests.
   */
  readonly registry?: OperationRegistry;
  readonly profileId?: string;
  endpoint?: string;
  allowEnvironmentCredentials?: () => Promise<boolean> | boolean;
  resolveEffectiveEndpoint?: () => Promise<AdminBinding | undefined>;
  syncBinding?: () => Promise<void>;
  onEnable?: (endpoint: string) => Promise<AdminBinding | undefined>;
  onDisable?: () => Promise<void> | void;
}

const planCache = new WeakMap<object, Map<string, AdminPlanHandle>>();

function operationRegistry(options: AdminUiOptions): OperationRegistry {
  return options.registry ?? getOperationRegistry();
}

function cachedPlans(options: AdminUiOptions): Map<string, AdminPlanHandle> {
  const existing = planCache.get(options.executor);
  if (existing) return existing;
  const created = new Map<string, AdminPlanHandle>();
  planCache.set(options.executor, created);
  return created;
}
export function rememberAdminPlan(options: AdminUiOptions, plan: AdminPlanHandle): void {
  cachedPlans(options).set(plan.planId, plan);
}
function safeDisplay(value: unknown): string {
  try {
    return JSON.stringify(value, (_key, child) => typeof child === "string" ? child.replace(/[\u0000-\u001f\u007f]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`) : child, 2) ?? "[unavailable]";
  } catch {
    return "[unavailable]";
  }
}

function notify(context: AdminContext, message: string, type: "info" | "warning" | "error" = "info"): void {
  context.ui.notify(message.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 8_000), type);
}

function hasInteractiveUi(context: AdminContext): boolean {
  return context.hasUI;
}
async function credentialFromEnvironment(options: AdminUiOptions): Promise<{ apiKey?: string; cookie?: string }> {
  if (options.allowEnvironmentCredentials && !(await options.allowEnvironmentCredentials())) return {};
  const apiKey = process.env.OMP_OMNIROUTE_ADMIN_API_KEY?.trim();
  const cookie = process.env.OMP_OMNIROUTE_ADMIN_COOKIE?.trim();
  return { ...(apiKey ? { apiKey } : {}), ...(cookie ? { cookie } : {}) };
}

async function askText(context: AdminContext, prompt: string, secret = false): Promise<string | undefined> {
  if (!hasInteractiveUi(context)) return undefined;
  return context.ui.custom<string | undefined>((_tui, _theme, _keybindings, done) => {
    const input = new Input();
    input.prompt = `${prompt}: `;
    input.mask = secret;
    input.onSubmit = value => done(value.length > 0 ? value : undefined);
    input.onEscape = () => done(undefined);
    return input;
  }, { overlay: true });
}

function redactPreview(preview: AdminPreview, registry: OperationRegistry): string {
  const descriptor = registry.getOperation(preview.operationId);
  const secretFields = new Set([
    ...(descriptor?.secrets.inputFields ?? []),
    ...(descriptor?.secrets.outputFields ?? []),
  ].map(field => field.toLowerCase()));
  const redact = (value: unknown, key?: string): unknown => {
    if (key && (secretFields.has(key.toLowerCase()) || /(?:secret|password|token|credential|authorization|cookie|api[-_]?key)/i.test(key))) return "[redacted]";
    if (Array.isArray(value)) return value.map(item => redact(item));
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, child]) => [name, redact(child, name)]));
    return value;
  };
  return safeDisplay({
    target: preview.target,
    operation: preview.operationId,
    method: preview.method,
    path: preview.pathTemplate,
    resolvedPath: preview.resolvedPath,
    queryParameters: preview.queryParameters,
    planDigest: preview.planDigest,
    risk: preview.risk,
    sideEffect: preview.sideEffect,
    authorization: preview.authorization,
    change: redact(preview.payload),
    observedTarget: redactSourceOutput(preview.projectedTarget, descriptor?.secrets.outputFields ?? []),
    ...(preview.visibilityLimits === undefined ? {} : { visibilityLimits: preview.visibilityLimits }),
    consequence: preview.consequence,
    confirmationRequired: preview.confirmationRequired,
  });
}

async function rememberCredential(options: AdminUiOptions): Promise<void> {
  const credential = await credentialFromEnvironment(options);
  if (!credential.apiKey && !credential.cookie) return;
  const input: AdminCredentialInput = {
    profileId: options.profileId ?? DEFAULT_PROFILE,
    endpoint: options.endpoint ?? "",
    ...(credential.apiKey ? { apiKey: credential.apiKey } : {}),
    ...(credential.cookie ? { cookie: credential.cookie } : {}),
  };
  options.executor.bindCredential(input);
}

async function collectSessionCredential(options: AdminUiOptions, context: AdminContext, allowTrustedLocal = false): Promise<boolean> {
  if (!options.endpoint) return false;
  const bound = options.executor.getCredentialBinding();
  if (bound?.enabled && bound.endpoint === options.endpoint && bound.profileId === (options.profileId ?? DEFAULT_PROFILE)) return true;
  const fromEnvironment = await credentialFromEnvironment(options);
  if (!fromEnvironment.apiKey && !fromEnvironment.cookie) {
    if (allowTrustedLocal && bound === undefined) return true;
    const kind = await askText(context, "Management credential kind (apiKey or cookie)");
    if (!kind || (kind !== "apiKey" && kind !== "cookie")) return false;
    const value = await askText(context, kind === "apiKey" ? "Management API key" : "Management cookie", true);
    if (!value) return false;
    const input: AdminCredentialInput = {
      profileId: options.profileId ?? DEFAULT_PROFILE,
      endpoint: options.endpoint,
      ...(kind === "apiKey" ? { apiKey: value } : { cookie: value }),
    };
    options.executor.bindCredential(input);
    return true;
  }
  await rememberCredential(options);
  return true;
}
type SelectedOperationResult =
  | { readonly kind: "read"; readonly output: unknown }
  | { readonly kind: "plan"; readonly plan: AdminPlanHandle };

function isOrdinaryRead(adapter: OperationAdapter): boolean {
  const descriptor = adapter.descriptor;
  return adapter.risk === "read"
    && descriptor.sideEffect === "read"
    && !descriptor.confirmation.required
    && ["GET", "HEAD", "OPTIONS"].includes(descriptor.method);
}

async function runSelectedOperation(
  options: AdminUiOptions,
  adapter: OperationAdapter,
  input: unknown,
): Promise<SelectedOperationResult> {
  const operationId = adapter.descriptor.operationId;
  if (adapter.risk === "read") {
    if (!isOrdinaryRead(adapter)) throw new Error("read operation is not eligible for direct execution");
    const result = await options.executor.read(operationId, input);
    return { kind: "read", output: result.output };
  }
  const plan = await options.executor.plan(operationId, input);
  cachedPlans(options).set(plan.planId, plan);
  return { kind: "plan", plan };
}



async function applyPlan(options: AdminUiOptions, context: AdminContext, planId: string): Promise<void> {
  if (!hasInteractiveUi(context)) {
    notify(context, "administration apply requires an interactive human UI; no request was sent", "warning");
    return;
  }
  const plan = cachedPlans(options).get(planId) ?? options.executor.getPlan(planId);
  if (!plan) {
    notify(context, "plan is unavailable or expired; create a new preview; no request was sent", "warning");
    return;
  }
  const preview = plan.preview;
  const registry = operationRegistry(options);
  notify(context, `Exact administration target and redacted change:\n${redactPreview(preview, registry)}\nThis preview will be re-read for drift before dispatch.`, "warning");
  const typed = await askText(context, `Type APPLY to confirm plan ${planId}`);
  if (typed !== "APPLY") {
    notify(context, "administration apply denied; no request was sent", "warning");
    return;
  }
  const confirmed = await context.ui.confirm("Apply administration plan", `${redactPreview(preview, registry)}\n\nConfirm this exact target, side effect, and irreversible consequence?`);
  if (!confirmed) {
    notify(context, "administration apply cancelled; no request was sent", "warning");
    return;
  }
  try {
    const result = await options.executor.apply(planId, { confirmed: true, confirm: true, headless: false });
    if (result.status === "applied") notify(context, `administration plan applied: ${planId}`, "info");
    else if (result.status === "operator-required") notify(context, `administration requires a separate operator action; no applied result was recorded (${planId})`, "warning");
    else if (result.status === "unknown") notify(context, `administration outcome is unknown; reconcile before retrying (${planId})`, "warning");
    else notify(context, `administration plan was not applied (${planId})`, "warning");
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : "request_failed";
    notify(context, `administration apply failed (${code}); no retry was attempted`, "warning");
  }
}

async function browse(options: AdminUiOptions, context: AdminContext, search: string): Promise<void> {
  const registry = operationRegistry(options);
  if (/[\u0000-\u001f\u007f]/.test(search)) {
    notify(context, "search cannot contain control characters; no request was sent", "warning");
    return;
  }
  const exactDescriptor = registry.getOperation(search);
  if (exactDescriptor) {
    await runOperationById(options, context, search);
    return;
  }

  const normalizedSearch = search.trim().toLowerCase();
  if (!hasInteractiveUi(context) || typeof context.ui.select !== "function") {
    const matches = registry.descriptors()
      .filter(descriptor => normalizedSearch === "" || `${descriptor.operationId} ${descriptor.pathTemplate}`.toLowerCase().includes(normalizedSearch))
      .slice(0, 40);
    const summary = matches.length === 0
      ? "No matching administration operations."
      : `Found ${matches.length} matching operation${matches.length === 1 ? "" : "s"}; use an exact operation ID in an interactive session to select one.`;
    notify(context, summary, matches.length === 0 ? "warning" : "info");
    return;
  }

  const descriptors = [...registry.descriptors()].sort((left, right) => left.operationId.localeCompare(right.operationId));
  const matchesSearch = (operationId: string, pathTemplate: string): boolean =>
    normalizedSearch === "" || `${operationId} ${pathTemplate}`.toLowerCase().includes(normalizedSearch);
  const displayCategoryFor = (operationId: string): string => registry.lookup(operationId)?.category ?? "unavailable";
  const allCategories = registry.listCategories();
  const matchedCategories = new Set<string>();
  for (const category of allCategories) {
    if (normalizedSearch === "" || category.toLowerCase().includes(normalizedSearch)
      || registry.listOperations({ category, search: normalizedSearch }).length > 0) {
      matchedCategories.add(category);
    }
  }
  const unavailableMatch = descriptors.some(descriptor => !registry.lookup(descriptor.operationId)
    && matchesSearch(descriptor.operationId, descriptor.pathTemplate));
  if (unavailableMatch) matchedCategories.add("unavailable");

  const categoryOptions = [...matchedCategories].sort((left, right) => left.localeCompare(right)).map(category => {
    const hasOperationMatches = descriptors.some(descriptor => displayCategoryFor(descriptor.operationId) === category
      && matchesSearch(descriptor.operationId, descriptor.pathTemplate));
    const count = descriptors.filter(descriptor => displayCategoryFor(descriptor.operationId) === category
      && (normalizedSearch === "" || !hasOperationMatches || matchesSearch(descriptor.operationId, descriptor.pathTemplate))).length;
    return { label: escapeControls(category), description: `${count} operation${count === 1 ? "" : "s"}` };
  });
  if (categoryOptions.length === 0) {
    notify(context, "No matching administration categories or operations.", "warning");
    return;
  }
  const selectedCategoryLabel = await context.ui.select("Administration category", categoryOptions);
  if (selectedCategoryLabel === undefined) return;
  const selectedCategory = [...matchedCategories].find(category => escapeControls(category) === selectedCategoryLabel);
  if (!selectedCategory) return;

  const categoryDescriptors = descriptors.filter(descriptor => displayCategoryFor(descriptor.operationId) === selectedCategory);
  const matchingOperations = categoryDescriptors.filter(descriptor => matchesSearch(descriptor.operationId, descriptor.pathTemplate));
  const selectedDescriptors = normalizedSearch !== "" && matchingOperations.length > 0
    ? matchingOperations
    : categoryDescriptors;
  const operationOptions = selectedDescriptors.map(descriptor => {
    const adapter = registry.lookup(descriptor.operationId);
    const status = !adapter
      ? `unavailable: ${descriptor.coverage.reason ?? "no executable adapter"}`
      : adapter.eligibility.status === "verified"
        ? "available"
        : `unavailable: ${adapter.eligibility.reason}`;
    return {
      label: escapeControls(descriptor.operationId),
      description: escapeControls(`${descriptor.method} ${descriptor.pathTemplate} · ${status}`),
    };
  });
  if (operationOptions.length === 0) {
    notify(context, "No operations are listed in this category.", "warning");
    return;
  }
  const selectedOperationLabel = await context.ui.select(`Operations in ${escapeControls(selectedCategory)}`, operationOptions);
  if (selectedOperationLabel === undefined) return;
  const selectedDescriptor = selectedDescriptors.find(descriptor => escapeControls(descriptor.operationId) === selectedOperationLabel);
  if (!selectedDescriptor) return;
  await runOperationById(options, context, selectedDescriptor.operationId);
}

async function runOperationById(options: AdminUiOptions, context: AdminContext, operationId: string): Promise<void> {
  const registry = operationRegistry(options);
  const adapter: OperationAdapter | undefined = registry.lookup(operationId);
  if (!adapter) {
    notify(context, "unknown or non-invokable operation; no request was sent", "warning");
    return;
  }
  if (adapter.eligibility.status !== "verified") {
    notify(context, `operation unavailable: ${adapter.eligibility.reason}; no request was sent`, "warning");
    return;
  }
  const sourcePolicy = adapter.descriptor.auth.sourcePolicy;
  let trustedLocalAllowed = false;
  if (options.endpoint !== undefined && sourcePolicy.status === "qualified" && sourcePolicy.routeClass === "management"
    && sourcePolicy.alternatives.some(alternative => alternative.kind === "trusted-local" && alternative.loopbackOnly)) {
    try { trustedLocalAllowed = isLoopbackHostname(new URL(options.endpoint).hostname); } catch {}
  }
  if (adapter.descriptor.auth.domain === "management" && !(await collectSessionCredential(options, context, trustedLocalAllowed))) {
    notify(context, "this operation requires a source-qualified management credential; no request was sent", "warning");
    return;
  }
  const raw = await askText(context, `Validated JSON input for ${escapeControls(operationId)} ({} if empty)`, adapter.descriptor.secrets.inputFields.length > 0);
  if (!raw) return;

  let input: unknown;
  try { input = JSON.parse(raw); } catch { notify(context, "input is not valid JSON; no request was sent", "warning"); return; }
  let result: SelectedOperationResult;
  try {
    result = await runSelectedOperation(options, adapter, input);
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : undefined;
    if (code === "invalid-input") {
      notify(context, "input was rejected by the closed operation validator; no request was sent", "warning");
    } else if (adapter.risk === "read" && !isOrdinaryRead(adapter)) {
      notify(context, "read operation is not eligible for direct execution; no request was sent", "warning");
    } else {
      notify(context, `operation failed${code ? ` (${code})` : ""}; no retry was attempted`, "warning");
    }
    return;
  }
  if (result.kind === "read") {
    notify(context, `read result for ${operationId}:\n${safeDisplay(result.output)}`, "info");
    return;
  }
  notify(context, `plan ${result.plan.planId} created\n${redactPreview(result.plan.preview, registry)}`, "info");
}
async function enableAdmin(options: AdminUiOptions, context: AdminContext): Promise<void> {
  if (!hasInteractiveUi(context)) {
    notify(context, "administration enable requires an interactive human UI; no request was sent", "warning");
    return;
  }
  let binding: AdminBinding | undefined;
  try {
    binding = await options.resolveEffectiveEndpoint?.();
  } catch {
    notify(context, "unable to resolve the active/environment administration endpoint; no request was sent", "warning");
    return;
  }
  const endpoint = binding?.endpoint ?? await askText(context, "Administration endpoint (exact active/environment endpoint)");
  if (!endpoint) {
    notify(context, "administration enable cancelled; no request was sent", "warning");
    return;
  }
  const confirmed = await context.ui.confirm("Enable OmniRoute administration", `Exact endpoint: ${endpoint}\nPersist non-secret adminEnabled for this profile?`);
  if (!confirmed) {
    notify(context, "administration enable cancelled; no request was sent", "warning");
    return;
  }
  if (!options.onEnable) {
    notify(context, "administration enable is unavailable; no request was sent", "warning");
    return;
  }
  try {
    const enabled = await options.onEnable(endpoint);
    if (!enabled) {
      notify(context, "administration enable was not persisted; no request was sent", "warning");
      return;
    }
    options.endpoint = enabled.endpoint;
    notify(context, `administration enabled for exact endpoint ${enabled.endpoint}; source-qualified operations may require credentials`, "info");
  } catch {
    notify(context, "administration enable failed to persist; no request was sent", "warning");
  }
}

export function createAdminCommandHandler(options: AdminUiOptions): (args: string, ctx: AdminContext) => Promise<void> {
  return async (args, ctx) => {
      const context = ctx;
      const parts = args.trim().split(/\s+/).filter(Boolean);
      if (parts[0] === "enable") {
        await enableAdmin(options, context);
        return;
      }
      try {
        await options.syncBinding?.();
      } catch {
        notify(context, "administration configuration is unavailable; no request was sent", "warning");
        return;
      }
      if (parts[0] === "apply") {
        const plan = parts[1] ? options.executor.getPlan(parts[1]) : undefined;
        if (plan && operationRegistry(options).getOperation(plan.operationId)?.auth.domain === "management"
          && !options.executor.getCredentialBinding() && plan.preview.authorization.kind !== "not-required") {
          await collectSessionCredential(options, context);
        }
        const planId = parts[1] ?? await askText(context, "Plan ID to apply");
        if (planId) await applyPlan(options, context, planId);
        return;
      }
      if (parts[0] === "disable" || parts[0] === "logout") {
        if (parts[0] === "logout") options.executor.logout();
        else options.executor.disable();
        cachedPlans(options).clear();
        await options.onDisable?.();
        notify(context, "administration session cleared; no request was sent");
        return;
      }
      await browse(options, context, parts.join(" ") || "");
  };
}

export async function runAdminApply(options: AdminUiOptions, context: AdminContext, planId: string): Promise<void> {
  await applyPlan(options, context, planId);
}

export function clearAdminUiSession(options: AdminUiOptions): void {
  options.executor.logout();
  cachedPlans(options).clear();
}
