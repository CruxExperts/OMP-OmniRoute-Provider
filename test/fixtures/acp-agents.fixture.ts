import * as crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

type ProcessMode = "success" | "failure" | "stall";

/** Owns all executable fixtures and their only writable counter; not a sandbox for arbitrary code. */
export class AcpOwnedProcesses {
  readonly directory = mkdtempSync(path.join(tmpdir(), "acp-owned-"));
  readonly counter = path.join(this.directory, "counter.jsonl");
  readonly executables = new Map<string, { mode: ProcessMode; sha256: string; script?: string; scriptSha256?: string }>();
  readonly outcomes: Array<{ command: string; stdout: string; status: number | null; signal: string | null; code: string | null }> = [];
  readonly errorCategories: Array<"none" | "not-found" | "invalid-argument" | "timeout" | "not-recognized" | "other"> = [];
  readonly preflight = new Map<ProcessMode, "ownership" | "integrity" | "options" | "windows-shell" | "execute">();
  currentPreflight: "ownership" | "integrity" | "options" | "windows-shell" | "execute" = "ownership";
  readonly rejections: Record<string, number> = { ownership: 0, integrity: 0, options: 0, "windows-shell": 0, execute: 0 };
  cleaned = false;

  create(mode: ProcessMode): string {
    const windows = process.platform === "win32";
    const executable = path.join(this.directory, `probe-${mode}${windows ? ".cmd" : ""}`);
    const script = windows ? path.join(this.directory, `probe-${mode}.js`) : executable;
    const source = (windows ? "" : `#!${process.execPath}\n`) +
      `import { appendFileSync } from "node:fs";\n` +
      `appendFileSync(${JSON.stringify(this.counter)}, JSON.stringify({ mode: ${JSON.stringify(mode)}, argv: process.argv.slice(2), cwd: process.cwd(), env: process.env, pid: process.pid }) + "\\n");\n` +
      (mode === "success" ? `process.stdout.write("Owned agent 7.8.9-beta\\n");\n` :
        mode === "failure" ? `process.stdout.write("failed 3.2.1\\n"); process.exit(17);\n` : windows ? `setTimeout(() => process.exit(0), 6500);\n` : `setInterval(() => {}, 1000);\n`);
    writeFileSync(script, source, { mode: 0o700, flag: "wx" });
    if (windows) {
      if (/["%\r\n]/.test(process.execPath) || /["%\r\n]/.test(script)) throw new Error("unsafe fixture wrapper path");
      // The wrapper is fixed at creation; no registry-controlled text enters it.
      const wrapper = `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`;
      writeFileSync(executable, wrapper, { flag: "wx" });
      this.executables.set(executable, { mode, sha256: crypto.createHash("sha256").update(wrapper).digest("hex"), script, scriptSha256: crypto.createHash("sha256").update(source).digest("hex") });
    } else {
      chmodSync(executable, 0o700);
      this.executables.set(executable, { mode, sha256: crypto.createHash("sha256").update(source).digest("hex") });
    }
    return executable;
  }

  run(command: string, args: string[], options: unknown): string {
    this.currentPreflight = "ownership";
    const executable = this.executables.get(command);
    if (!executable || args.length !== 1 || args[0] !== "--version") throw new Error("unowned or unsupported fixture probe");
    this.preflight.set(executable.mode, "integrity");
    this.currentPreflight = "integrity";
    for (const [file, digest] of [[command, executable.sha256], ...(executable.script ? [[executable.script, executable.scriptSha256!]] : [])]) {
      if (!file || !digest || !lstatSync(file).isFile() || crypto.createHash("sha256").update(readFileSync(file)).digest("hex") !== digest) throw new Error("fixture executable changed");
    }
    this.preflight.set(executable.mode, "options");
    this.currentPreflight = "options";
    const sourceOptions = options as { timeout?: number; encoding?: string; shell?: boolean };
    const windows = process.platform === "win32";
    if (sourceOptions.timeout !== 5000 || sourceOptions.encoding !== "utf-8" || Boolean(sourceOptions.shell) !== windows) throw new Error("unexpected source probe options");
    const env: Record<string, string> = { PATH: "", HOME: this.directory, TMPDIR: this.directory, BUN_DISABLE_TRANSPILER_CACHE: "1" };
    this.preflight.set(executable.mode, "windows-shell");
    this.currentPreflight = "windows-shell";
    if (windows) {
      if (!process.env.SystemRoot || !process.env.ComSpec) throw new Error("Windows system shell unavailable");
      env.SystemRoot = process.env.SystemRoot;
      env.ComSpec = process.env.ComSpec;
    }
    this.preflight.set(executable.mode, "execute");
    this.currentPreflight = "execute";
    try {
      const stdout = execFileSync(command, args, { cwd: this.directory, env, shell: windows, timeout: sourceOptions.timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16_384, killSignal: "SIGKILL" });
      this.outcomes.push({ command, stdout, status: 0, signal: null, code: null });
      this.errorCategories.push("none");
      return stdout;
    } catch (error) {
      const failure = error as { stdout?: string | Buffer; stderr?: string | Buffer; message?: string; status?: number | null; signal?: string | null; code?: string };
      const detail = `${failure.message ?? ""}\n${String(failure.stderr ?? "")}`.toLowerCase();
      const category = failure.code === "ENOENT" || detail.includes("no such file or directory") || detail.includes("cannot find the file") ? "not-found" :
        failure.code === "EINVAL" ? "invalid-argument" : failure.code === "ETIMEDOUT" ? "timeout" :
        detail.includes("is not recognized as an internal or external command") ? "not-recognized" : "other";
      this.errorCategories.push(category);
      this.outcomes.push({ command, stdout: String(failure.stdout ?? ""), status: failure.status ?? null, signal: failure.signal ?? null, code: failure.code ?? null });
      throw error;
    }
  }

  records(): Array<{ mode: ProcessMode; argv: string[]; cwd: string; env: Record<string, string>; pid: number }> {
    return existsSync(this.counter) ? readFileSync(this.counter, "utf8").trim().split("\n").map(line => JSON.parse(line)) : [];
  }

  cleanup(): void {
    rmSync(this.directory, { recursive: true, force: true });
    this.cleaned = !existsSync(this.directory);
  }
}

export interface AcpProbeInspection { resolved: boolean; exact: boolean; normalized: boolean; caseInsensitive: boolean; shell: boolean; shellSafe: boolean; hasWhitespace: boolean }

/** Direct handler and pinned registry; process mode is restricted to owned fixtures. */
export class AcpAgentsFixture {
  settings: { customAgents?: CustomAgent[] } = { customAgents: [] };
  requireLogin = false;
  now = Date.parse("2026-01-01T00:00:00.000Z");
  settingsReads = 0;
  settingsError: Error | undefined;
  readonly probes: Array<{ command: string; args: string[]; options: unknown }> = [];
  readonly outputs = new Map<string, string | Error>();
  readonly apiKeys = new Map<string, readonly string[]>();
  readonly inspectProbe: (binary: string, versionCommand: string) => AcpProbeInspection;
  readonly #get: (request: Request) => Promise<Response>;

  constructor(processes?: AcpOwnedProcesses) {
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
        if (processes) {
          try { return processes.run(command, args, options); } catch (error) {
            const stage = processes.currentPreflight;
            processes.rejections[stage] = Math.min((processes.rejections[stage] ?? 0) + 1, 1000);
            throw error;
          }
        }
        const result = this.outputs.get(command);
        if (typeof result !== "string") throw result ?? new Error("fixture executable unavailable");
        return result;
      } };
      throw new Error(`Unexpected registry import: ${s}`);
    }, { date: new Proxy(Date, { get: (target, property, receiver) => property === "now" ? () => this.now : Reflect.get(target, property, receiver) }) });
    const resolveProbe = registry.resolveVersionProbe as (binary: string, command: string, requireMatch: boolean) => { command: string; args: string[] } | null;
    const useShell = registry.shouldUseShellForVersionProbe as (command: string) => boolean;
    const shellSafe = registry.isShellSafeCommand as (command: string) => boolean;
    this.inspectProbe = (binary, versionCommand) => {
      const probe = resolveProbe(binary, versionCommand, true);
      const command = probe?.command ?? "";
      return { resolved: probe !== null, exact: command === binary,
        normalized: path.normalize(command) === path.normalize(binary), caseInsensitive: command.toLowerCase() === binary.toLowerCase(),
        shell: Boolean(probe && useShell(command)),
        shellSafe: Boolean(probe && shellSafe(command)), hasWhitespace: /\s/.test(binary) };
    };
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
