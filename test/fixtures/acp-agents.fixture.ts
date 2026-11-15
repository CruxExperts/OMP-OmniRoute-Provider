import * as crypto from "node:crypto";
import * as path from "node:path";
import { loadExtractedPinnedDeclarations, loadPinnedModule, readPinnedSource } from "./pinned-handler.fixture.ts";
import { operationContractTemplate } from "../../scripts/generate-contracts.ts";
import type { OperationSourceContract } from "../../src/admin/eligibility.ts";
import { getOperation, type JsonSchema, type OperationDescriptor } from "../../src/admin/registry.ts";

export const ACP_AGENTS_GET_ID = "GET /api/acp/agents";
const empty: JsonSchema = { type: "object", properties: {}, additionalProperties: false };
const count: JsonSchema = { type: "integer", minimum: 0 };
const responseView: JsonSchema = { type: "object", properties: {
  agents: { type: "array", items: { type: "object", properties: {
    installed: { type: "boolean" }, isCustom: { type: "boolean" },
  }, required: ["installed", "isCustom"], additionalProperties: false } },
  summary: { type: "object", properties: { total: count, installed: count, notFound: count, builtIn: count, custom: count },
    required: ["total", "installed", "notFound", "builtIn", "custom"], additionalProperties: false },
}, required: ["agents", "summary"], additionalProperties: false };

/** Candidate only: custom executable effects and isAuthenticated policy are not qualified. */
export function acpAgentsGetContract(): OperationSourceContract {
  const template = operationContractTemplate(ACP_AGENTS_GET_ID) as unknown as OperationSourceContract;
  return { ...template,
    request: { ...template.request, pathSchema: empty, querySchema: empty, pathParameters: [], parameters: [], body: null },
    auth: { ...template.auth, domain: "management", sourcePolicy: { status: "unknown" } },
    response: { ...template.response, schema: responseView },
    secrets: { inputFields: [], outputFields: [] }, sideEffect: "unknown",
    pagination: { mode: "none", parameters: [] }, streaming: { mode: "json", framing: "application/json" },
    confirmation: { required: true, reason: "GET can execute locally configured version probes; their effects are not observable here." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] }, reconciliation: null,
    mutationSafety: { preflight: { kind: "not-applicable", sourceReason: "No independent read can establish the effects of locally configured executable probes." },
      reconciliation: { kind: "unknown" }, settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null } },
  };
}

/** Synthetic projection authority only, never release qualification. */
export function acpAgentsGetDescriptor(): OperationDescriptor {
  const original = getOperation(ACP_AGENTS_GET_ID);
  if (!original || original.source.sha256 !== "34c9166ef6ce7a90f89f2a0a26301476ac2ee7425b5af50c0de54e656dd911c3") throw new Error("ACP source identity mismatch");
  const contract = acpAgentsGetContract();
  return { ...original, ...contract, mediaType: { request: null, response: contract.response.mediaType },
    coverage: { status: "invokable", adapterId: "typed.fixture.acp.agents", reason: null } };
}

export interface CustomAgent {
  id: string;
  name: string;
  binary: string;
  versionCommand: string;
  providerAlias: string;
  spawnArgs: string[];
  protocol: "stdio" | "http";
}

/** Direct handler and source registry only. No real process or production settings is used. */
export class AcpAgentsFixture {
  settings: { customAgents?: CustomAgent[] } = { customAgents: [] };
  requireLogin = false;
  now = Date.parse("2026-01-01T00:00:00.000Z");
  settingsReads = 0;
  settingsError: Error | undefined;
  readonly probes: Array<{ command: string; args: string[]; options: unknown }> = [];
  readonly outputs = new Map<string, string | Error>();
  readonly apiKeys = new Map<string, readonly string[]>();
  readonly #get: (request: Request) => Promise<Response>;

  constructor() {
    const manifestJson = JSON.parse(readPinnedSource("config/cli-tools-manifest.json"));
    const manifest = loadPinnedModule("src/shared/constants/cliIntegrationManifest.ts", s => {
      if (s === "../../../config/cli-tools-manifest.json") return manifestJson;
      throw new Error(`Unexpected manifest import: ${s}`);
    });
    const registry = loadPinnedModule("src/lib/acp/registry.ts", s => {
      if (s === "path") return path;
      if (s === "@/shared/constants/cliIntegrationManifest") return manifest;
      if (s === "child_process") return { execFileSync: (command: string, args: string[], options: unknown) => {
        this.probes.push({ command, args: [...args], options });
        const result = this.outputs.get(command);
        if (typeof result !== "string") throw result ?? new Error("fixture executable unavailable");
        return result;
      } };
      throw new Error(`Unexpected registry import: ${s}`);
    }, { date: new Proxy(Date, { get: (target, property, receiver) => property === "now" ? () => this.now : Reflect.get(target, property, receiver) }) });
    const headers = loadPinnedModule("src/server/authz/headers.ts", s => { throw new Error(`Unexpected headers import: ${s}`); });
    const guard = loadPinnedModule("src/server/authz/routeGuard.ts", s => {
      if (s === "@/lib/config/runtimeSettings") return { getAuthzBypassSnapshot: () => ({ enabled: false, prefixes: [] }) };
      if (s === "@/shared/constants/spawnCapablePrefixes") return loadPinnedModule("src/shared/constants/spawnCapablePrefixes.ts", x => { throw new Error(`Unexpected prefixes import: ${x}`); });
      if (s === "@/lib/vncSession/manifest") return loadExtractedPinnedDeclarations(["src/lib/vncSession/manifest.ts"], ["VNC_ROUTE_PREFIX"], x => { throw new Error(`Unexpected VNC import: ${x}`); });
      throw new Error(`Unexpected route guard import: ${s}`);
    });
    const stamp = loadPinnedModule("src/server/authz/peerStamp.ts", s => {
      if (s === "node:crypto") return crypto;
      if (s === "./routeGuard") return guard;
      throw new Error(`Unexpected peer stamp import: ${s}`);
    });
    const publicRoutes = loadPinnedModule("src/shared/constants/publicApiRoutes.ts", s => { throw new Error(`Unexpected public route import: ${s}`); });
    const auth = loadPinnedModule("src/shared/utils/apiAuth.ts", s => {
      if (s === "@/lib/auth/bootstrapToken") return { getOrCreateBootstrapToken: () => "", peekBootstrapToken: () => false };
      if (s === "@/lib/db/readCache") return { getCachedSettings: async () => ({ requireLogin: this.requireLogin, password: "fixture-password", setupComplete: true }) };
      if (s === "@/server/authz/headers") return headers;
      if (s === "@/server/authz/peerStamp") return stamp;
      if (s === "@/server/authz/routeGuard") return guard;
      if (s === "@/shared/constants/publicApiRoutes") return publicRoutes;
      if (s === "@/shared/utils/dashboardSessionToken") return { DASHBOARD_SESSION_COOKIE: "fixture-session", verifyDashboardSessionToken: async () => null };
      if (s === "@/sse/services/auth") return loadExtractedPinnedDeclarations(["src/sse/services/auth.ts", "src/sse/services/headerReader.ts", "src/sse/services/googApiKeyAuth.ts"], ["extractApiKey", "readNonEmptyUrlToken", "readHeaderValue", "extractGoogApiKeyHeader"], x => { throw new Error(`Unexpected API key helper import: ${x}`); });
      if (s === "next/headers") return { cookies: async () => ({ get: () => undefined }) };
      if (s === "@/lib/db/apiKeys") return { validateApiKey: async (key: string) => this.apiKeys.has(key), getApiKeyMetadata: async (key: string) => this.apiKeys.has(key) ? { id: "fixture", scopes: this.apiKeys.get(key) } : null };
      if (s === "@/shared/constants/managementScopes") return loadPinnedModule("src/shared/constants/managementScopes.ts", x => { throw new Error(`Unexpected scopes import: ${x}`); });
      throw new Error(`Unexpected auth import: ${s}`);
    });
    const route = loadPinnedModule("src/app/api/acp/agents/route.ts", s => {
      if (s === "next/server") return { NextResponse: { json: (body: unknown, init?: ResponseInit) => Response.json(body, init) } };
      if (s === "@/lib/acp/registry") return registry;
      if (s === "@/lib/db/settings") return { getSettings: async () => {
        this.settingsReads++;
        if (this.settingsError) throw this.settingsError;
        return this.settings;
      }, updateSettings: () => { throw new Error("GET must not update settings"); } };
      if (s === "@/shared/validation/helpers") return {};
      if (s === "@/shared/utils/apiAuth") return auth;
      throw new Error(`Unexpected route import: ${s}`);
    });
    this.#get = route.GET as (request: Request) => Promise<Response>;
  }

  get(request = new Request("http://localhost/api/acp/agents")): Promise<Response> { return this.#get(request); }
}
