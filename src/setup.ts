import { Input } from "@oh-my-pi/pi-tui";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { DISPLAY_NAME } from "./identity.ts";
import { allowsEnvironmentOptionalCredentials, isEnvironmentRuntimeSelected, loadConfig, updateConfig, resolveEnvironmentBinding, resolveEnvironmentEndpointPrefill, validateEndpoint, type CredentialDomain } from "./config.ts";
import { OptionalCredentials, type CredentialBinding, type OptionalCredential } from "./credentials.ts";
import { readSellerPricing } from "./pricing.ts";
import { CATALOG_SOURCE_IDS, getCatalogSourceStatus, type CatalogSourceId } from "./catalog-sources.ts";

export interface SetupServices {
  credentials: OptionalCredentials;
  refresh(context: ExtensionContext): Promise<void>;
  synchronizeAdmin(context: ExtensionContext): Promise<void>;
  status(): string;
}

export function promptSetup(context: ExtensionContext, prompt: string, secret = false, initial = ""): Promise<string | undefined> {
  if (context.mode !== "tui") return Promise.resolve(undefined);
  return context.ui.custom<string | undefined>((_tui, _theme, _keys, done) => {
    const input = new Input();
    input.prompt = `${prompt}: `;
    input.mask = secret;
    if (initial && !secret) input.setValue(initial);
    const finish = (value: string | undefined) => { input.setValue(""); done(value); };
    input.onSubmit = value => finish(value.trim() || undefined);
    input.onEscape = () => finish(undefined);
    return input;
  }, { overlay: true });
}

function info(context: ExtensionContext, text: string, error = false): void {
  context.ui.notify(`${DISPLAY_NAME}: ${text}`, error ? "warning" : "info");
}
function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z-]+$/.test(error.code)) return error.code;
  return "operation-failed";
}

export async function setupConnection(context: ExtensionContext, services: SetupServices): Promise<void> {
  const config = await loadConfig();
  const environmentSelected = isEnvironmentRuntimeSelected(config);
  const endpointInitial = config.runtimeSource === "native"
    ? config.pending?.endpoint ?? config.active?.endpoint ?? config.setupDraft ?? ""
    : environmentSelected
      ? resolveEnvironmentEndpointPrefill(config) ?? config.setupDraft ?? config.active?.endpoint ?? ""
      : config.setupDraft ?? config.active?.endpoint ?? "";
  const endpoint = await promptSetup(context, "Gateway URL", false, endpointInitial);
  if (!endpoint) return;
  validateEndpoint(endpoint, true);
  let key = await promptSetup(context, "Runtime API key", true);
  if (!key) return;
  let insecureConsent = config.allowInsecureHttp;
  try {
    const detail = environmentSelected
      ? `Use ${endpoint} for this OMP profile and remember the new runtime key using OMP's native credential store? This replaces the environment connection for this profile; environment variables remain unchanged.`
      : `Validate ${endpoint} and remember the runtime key using OMP's native credential store?`;
    if (!(await context.ui.confirm(environmentSelected ? "Replace environment connection" : "Save connection and continue", detail))) return;
    const switchApproved = environmentSelected;
    await context.modelRegistry.authStorage.oauth.login("omniroute", {
      onAuth() {},
      onPrompt: async prompt => {
        if (prompt.placeholder === "yes/no") {
          if (prompt.message.startsWith("Use a native OmniRoute profile connection")) return switchApproved ? "yes" : "no";
          if (prompt.message.startsWith("Allow insecure remote HTTP")) {
            insecureConsent = await context.ui.confirm("Insecure transport", prompt.message);
            return insecureConsent ? "yes" : "no";
          }
          // The setup flow does not silently accept an unverified endpoint.
          if (prompt.message.includes("unreachable")) return "no";
          throw new Error("unsupported native sign-in confirmation");
        }
        if (prompt.secret) return key!;
        if (prompt.message === "OmniRoute base URL") return endpoint;
        throw new Error("unsupported native sign-in prompt");
      },
    });
    await services.refresh(context);
    const saved = await loadConfig();
    if (saved.pending || saved.active?.endpoint !== validateEndpoint(endpoint, insecureConsent)) throw new Error("connection not activated");
    await updateConfig(current => { const next = { ...current, invitationDismissed: true }; delete next.setupDraft; return next; });
    info(context, `Connection saved. ${services.status()}`);
  } catch (error) {
    info(context, `Connection not completed (${errorCode(error)}). Environment values were not changed; pending native persistence remains fail-closed until a fresh sign-in.`, true);
    const current = await loadConfig();
    if (!current.pending && errorCode(error) === "network-failure" && await context.ui.confirm("Save URL draft", "Save only this URL for a later attempt? No runtime key will be saved by this draft.")) {
      await updateConfig(value => ({ ...value, allowInsecureHttp: insecureConsent, setupDraft: validateEndpoint(endpoint, insecureConsent) }));
    }
  } finally { key = undefined; }
}

async function effectiveBinding(): Promise<CredentialBinding | undefined> {
  const config = await loadConfig();
  if (config.pending) return undefined;
  const active = resolveEnvironmentBinding(config) ?? config.active;
  return active ? { endpoint: active.endpoint, generation: active.generation } : undefined;
}

async function credentialSection(context: ExtensionContext, services: SetupServices, domain: CredentialDomain): Promise<void> {
  const binding = await effectiveBinding();
  if (!binding) { info(context, "Save a runtime connection first.", true); return; }
  const config = await loadConfig();
  const allowEnvironment = allowsEnvironmentOptionalCredentials(config, binding.endpoint);
  const external = allowEnvironment
    ? domain === "metadata" ? process.env.OMP_OMNIROUTE_METADATA_API_KEY : process.env.OMP_OMNIROUTE_ADMIN_API_KEY || process.env.OMP_OMNIROUTE_ADMIN_COOKIE
    : undefined;
  const ref = config.optionalCredentials?.[domain];
  if (external) { info(context, `${domain} credential is externally managed; the wizard will not replace it.`); }
  else {
    const action = await context.ui.select(`${domain === "admin" ? "Administration" : "Metadata"} credential${ref ? ` (${ref.state})` : ""}`, ["Set credential", "Forget credential", "Back"]);
    if (!action || action === "Back") return;
    if (action === "Forget credential") {
      if (await context.ui.confirm("Forget credential", `Remove only this plugin's ${domain} credential from this profile and its native storage?`)) {
        if (domain === "admin") {
          await updateConfig(current => ({ ...current, adminEnabled: false }));
          await services.synchronizeAdmin(context);
        }
        await services.credentials.forget(domain, context.modelRegistry.authStorage);
        await services.synchronizeAdmin(context);
        info(context, `${domain} credential forgotten.`);
      }
      return;
    }
    if (ref) { info(context, `Forget the existing ${domain} credential before setting a replacement.`, true); return; }
    const choice = domain === "admin" ? await context.ui.select("Administration credential type", ["API key", "Cookie", "Back"]) : "API key";
    if (!choice || choice === "Back") return;
    let value = await promptSetup(context, domain === "metadata" ? "Metadata API key" : choice === "Cookie" ? "Management cookie" : "Management API key", true);
    if (!value) return;
    try {
      const retention = await context.ui.select("Credential retention", ["This session only", "Remember in OMP credential store", "Back"]);
      if (!retention || retention === "Back") return;
      if (!(await context.ui.confirm("Save credential", `${domain} for ${binding.endpoint}; ${retention.toLowerCase()}.`))) return;
      const credential: OptionalCredential = { kind: choice === "Cookie" ? "cookie" : "apiKey", value };
      await services.credentials.save(domain, credential, binding, retention !== "This session only", context.modelRegistry.authStorage);
      info(context, `${domain} credential saved (${retention.toLowerCase()}).`);
    } finally { value = undefined; }
  }
  if (domain === "admin") {
    const enable = await context.ui.confirm("Enable administration", `Enable verified administration operations for ${binding.endpoint}? This does not apply any server changes or prove this credential's scopes.`);
    await updateConfig(current => ({ ...current, adminEnabled: enable }));
    await services.synchronizeAdmin(context);
    info(context, enable ? "Administration enabled. Credential scopes remain unverified; unavailable operations stay blocked." : "Administration remains disabled.");
  } else {
    await services.refresh(context);
    info(context, `Metadata refresh completed. ${services.status()}`);
  }
}

async function pricingSection(context: ExtensionContext, services: SetupServices): Promise<void> {
  const config = await loadConfig();
  if (process.env.OMP_OMNIROUTE_PRICING_FILE && !config.pricingFile) {
    info(context, "Pricing file is externally managed. Remove OMP_OMNIROUTE_PRICING_FILE to configure it here."); return;
  }
  const action = await context.ui.select("Pricing projection", ["Choose file", "Clear saved file", "Back"]);
  if (!action || action === "Back") return;
  if (action === "Clear saved file") {
    if (!(await context.ui.confirm("Clear pricing file", "Remove the saved reference? The pricing file itself will be preserved."))) return;
    await updateConfig(current => { const next = { ...current }; delete next.pricingFile; return next; });
  } else {
    const file = await promptSetup(context, "Pricing JSON file", false, config.pricingFile ?? "");
    if (!file) return;
    await readSellerPricing(file);
    if (!(await context.ui.confirm("Save pricing file", `Use ${file} for pricing inspection?`))) return;
    await updateConfig(current => ({ ...current, pricingFile: file }));
  }
  await services.refresh(context);
  info(context, "Pricing reference saved. Individual rates may still be unknown or stale.");
}

async function catalogSourcesSection(context: ExtensionContext, services: SetupServices): Promise<void> {
  const config = await loadConfig();
  const enabled = new Set(config.catalogSources ?? []);
  const actions: Record<CatalogSourceId, string> = {
    "models.dev": `${enabled.has("models.dev") ? "Disable" : "Enable"} models.dev`,
    openrouter: `${enabled.has("openrouter") ? "Disable" : "Enable"} OpenRouter`,
  };
  const selection = await context.ui.select(
    `Optional metadata only (${[...enabled].join(", ") || "none enabled"})`,
    [...CATALOG_SOURCE_IDS.map(source => actions[source]), ...(enabled.size > 0 ? ["Disable all"] : []), "Back"],
  );
  if (!selection || selection === "Back") return;
  if (selection === "Disable all") {
    await updateConfig(current => { const next = { ...current }; delete next.catalogSources; return next; });
    await services.refresh(context);
    info(context, "Optional catalog metadata disabled. No model IDs, costs, or credentials were changed.");
    return;
  }
  const source = CATALOG_SOURCE_IDS.find(candidate => actions[candidate] === selection);
  if (!source) return;
  const nextSources = new Set(enabled);
  if (nextSources.has(source)) nextSources.delete(source);
  else nextSources.add(source);
  const catalogSources = CATALOG_SOURCE_IDS.filter(candidate => nextSources.has(candidate));
  await updateConfig(current => ({ ...current, catalogSources }));
  await services.refresh(context);
  info(context, `${source} metadata ${catalogSources.includes(source) ? "enabled" : "disabled"}; this setting does not enable models or alter costs.`);
}

function catalogSourceSummary(sources: readonly CatalogSourceId[]): string {
  if (sources.length === 0) return "none enabled";
  return sources.map(source => {
    const status = getCatalogSourceStatus(source);
    const age = status.fetchedAt === undefined ? "" : ` age=${Math.max(0, Math.floor((Date.now() - status.fetchedAt) / 60_000))}m`;
    const error = status.errorCode ? ` error=${status.errorCode}` : "";
    return `${source}:${status.state}${age}${error}`;
  }).join(", ");
}

export function createSetupWizard(services: SetupServices): (context: ExtensionContext) => Promise<void> {
  let busy = false;
  return async context => {
    if (context.mode !== "tui") { if (context.hasUI) info(context, "Run /omniroute setup in an interactive OMP terminal.", true); return; }
    if (busy) { info(context, "Setup is already open.", true); return; }
    busy = true;
    try {
      await loadConfig();
      for (;;) {
        const selected = await context.ui.select(`${DISPLAY_NAME} — Setup`, ["Connection", "Metadata (optional)", "Catalogs (optional)", "Administration (optional)", "Pricing (optional)", "Summary", "Finish"]);
        if (!selected || selected === "Finish") return;
        try {
          if (selected === "Connection") await setupConnection(context, services);
          else if (selected === "Metadata (optional)") await credentialSection(context, services, "metadata");
          else if (selected === "Catalogs (optional)") await catalogSourcesSection(context, services);
          else if (selected === "Administration (optional)") await credentialSection(context, services, "admin");
          else if (selected === "Pricing (optional)") await pricingSection(context, services);
          else {
            const config = await loadConfig();
            info(context, `${services.status()}; administration=${config.adminEnabled ? "enabled" : "disabled"}; metadata=${config.optionalCredentials?.metadata?.state ?? "session-only or unset"}; catalogs=${catalogSourceSummary(config.catalogSources ?? [])}; admin credential=${config.optionalCredentials?.admin?.state ?? "session-only or unset"}; pricing=${config.pricingFile ? "saved" : "unset"}. Native runtime credentials are managed by OMP.`);
          }
        } catch (error) { info(context, `Section not completed (${errorCode(error)}). Check configuration or credential recovery and try again.`, true); }
      }
    } finally { busy = false; }
  };
}
