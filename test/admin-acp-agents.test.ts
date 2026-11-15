import { expect, spyOn, test } from "bun:test";
import { readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { ACP_AGENTS_GET_ID, AcpAgentsFixture, AcpOwnedProcesses, acpAgentsGetContract, acpAgentsGetDescriptor, type AcpProbeInspection, type CustomAgent } from "./fixtures/acp-agents.fixture.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { createAdminExecutor, type AdminExecutor } from "../src/admin/executor.ts";

interface Agent extends CustomAgent { installed: boolean; version: string | null; isCustom: boolean }
interface Body { agents: Agent[]; summary: { total: number; installed: number; notFound: number; builtIn: number; custom: number } }
const custom = (id: string, binary: string, versionCommand: string): CustomAgent => ({
  id, name: id, binary, versionCommand, providerAlias: id, spawnArgs: [], protocol: "stdio",
});

// These are direct-handler observations with in-memory settings and an intercepted
// subprocess boundary; neither real executable isolation nor Next ingress is proven.
test("pinned manifest and registry merge agents, summarize results and isolate failed probes", async () => {
  const fixture = new AcpAgentsFixture();
  fixture.settings.customAgents = [custom("custom-ok", "fixture-ok", "fixture-ok --version"), custom("custom-missing", "fixture-missing", "fixture-missing --version")];
  fixture.outputs.set("aider", "Aider 1.2.3-beta\n");
  fixture.outputs.set("fixture-ok", "fixture 4.5.6\n");
  fixture.outputs.set("fixture-missing", new Error("fixture probe failed"));
  const response = await fixture.get();
  expect(response.status).toBe(200);
  const body = await response.json() as Body;
  expect(body.agents.find(a => a.id === "aider")).toMatchObject({ name: "Aider", binary: "aider", versionCommand: "aider --version", providerAlias: "aider", spawnArgs: ["--no-auto-commits"], installed: true, version: "1.2.3-beta", isCustom: false });
  expect(body.agents.find(a => a.id === "custom-ok")).toMatchObject({ installed: true, version: "4.5.6", isCustom: true });
  expect(body.agents.find(a => a.id === "custom-missing")).toMatchObject({ installed: false, version: null, isCustom: true });
  expect(fixture.probes.find(p => p.command === "fixture-ok")).toEqual({ command: "fixture-ok", args: ["--version"], options: { timeout: 5000, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], ...(process.platform === "win32" ? { shell: true } : {}) } });
  expect(body.summary).toEqual({ total: body.agents.length, installed: 2, notFound: body.agents.length - 2, builtIn: body.agents.length - 2, custom: 2 });
});

test("custom probes reject unsafe commands before the subprocess boundary", async () => {
  const fixture = new AcpAgentsFixture();
  fixture.settings.customAgents = [custom("eval", "fixture-eval", "fixture-eval -e"), custom("shell", "fixture-shell", "fixture-shell --version;echo bad"), custom("mismatch", "fixture-mismatch", "other --version"), custom("allowed", "fixture-allowed", "fixture-allowed -V")];
  fixture.outputs.set("fixture-allowed", "fixture without numeric version\nsecond line");
  const body = await (await fixture.get()).json() as Body;
  for (const id of ["eval", "shell", "mismatch"]) expect(body.agents.find(a => a.id === id)).toMatchObject({ installed: false, version: null });
  expect(fixture.probes.filter(p => p.command.startsWith("fixture-"))).toHaveLength(1);
  expect(fixture.probes.some(p => p.command === "other")).toBe(false);
  expect(fixture.probes.find(p => p.command === "fixture-allowed")?.args).toEqual(["-V"]);
  expect(body.agents.find(a => a.id === "allowed")).toMatchObject({ installed: true, version: "fixture without numeric version" });
});

test("truthy customAgents invalidates cache; missing settings field preserves registry and cache", async () => {
  const fixture = new AcpAgentsFixture();
  fixture.settings.customAgents = [custom("cached", "fixture-cache", "fixture-cache --version")];
  fixture.outputs.set("fixture-cache", "1.0.0");
  expect(((await (await fixture.get()).json()) as Body).agents.find(a => a.id === "cached")?.version).toBe("1.0.0");
  const count = fixture.probes.length;
  fixture.outputs.set("fixture-cache", "2.0.0");
  fixture.settings = {};
  expect(((await (await fixture.get()).json()) as Body).agents.find(a => a.id === "cached")?.version).toBe("1.0.0");
  expect(fixture.probes.length).toBe(count);
  fixture.settings = { customAgents: [custom("cached", "fixture-cache", "fixture-cache --version")] };
  expect(((await (await fixture.get()).json()) as Body).agents.find(a => a.id === "cached")?.version).toBe("2.0.0");
  expect(fixture.probes.length).toBeGreaterThan(count);
  fixture.settings = { customAgents: [] };
  const cleared = await (await fixture.get()).json() as Body;
  expect(cleared.summary.custom).toBe(0);
  expect(cleared.agents.some(a => a.id === "cached")).toBe(false);
});

test("direct source authentication denies before settings and probes", async () => {
  const fixture = new AcpAgentsFixture();
  fixture.requireLogin = true;
  const response = await fixture.get();
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "Unauthorized" });
  expect(fixture.settingsReads).toBe(0);
  expect(fixture.probes).toEqual([]);
});

test("settings failure returns fixed public error while logging source detail", async () => {
  const fixture = new AcpAgentsFixture();
  fixture.settingsError = new Error("fixture-private-settings-detail");
  const log = spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await fixture.get();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to detect agents" });
    expect(log).toHaveBeenCalledWith("Error detecting agents:", fixture.settingsError);
    expect(fixture.probes).toEqual([]);
  } finally { log.mockRestore(); }
});

test("source success returns custom definition fields without an allowlist projection", async () => {
  const fixture = new AcpAgentsFixture();
  fixture.settings.customAgents = [Object.assign(custom("extra", "fixture-extra", "fixture-extra --version"), { privateFixtureField: "fixture-private-value" })];
  const body = await (await fixture.get()).json() as Body;
  expect(body.agents.find(a => a.id === "extra")).toMatchObject({ privateFixtureField: "fixture-private-value" });
});

test("candidate projects only status counts, not executable-controlled strings or fields", async () => {
  const fixture = new AcpAgentsFixture();
  fixture.settings.customAgents = [Object.assign(custom("secret-id", "fixture-extra", "fixture-extra --version"), { arbitrary: "fixture-private-value", password: "fixture-password" })];
  fixture.outputs.set("fixture-extra", "fixture-secret-output");
  const raw = await (await fixture.get()).json() as Body;
  const adapter = fixtureRegistry([acpAgentsGetDescriptor()]).require(ACP_AGENTS_GET_ID);
  const projected = adapter.project(raw) as { agents: Array<Record<string, unknown>>; summary: Body["summary"] };
  expect(projected.summary).toEqual(raw.summary);
  expect(projected.agents).toHaveLength(raw.agents.length);
  expect(projected.agents.at(-1)).toEqual({ installed: true, isCustom: true });
  expect(JSON.stringify(projected)).not.toContain("fixture-");
  expect(() => adapter.project({ ...raw, agents: [{ installed: "yes", isCustom: true }] })).toThrow();
  expect(() => adapter.project({ ...raw, summary: { ...raw.summary, total: -1 } })).toThrow();
  expect(adapter.validate({})).toEqual({ path: {}, query: {} });
  expect(() => adapter.validate({ query: { limit: 1 } })).toThrow();
  expect(() => adapter.validate({ body: {} })).toThrow();
  const contract = acpAgentsGetContract();
  expect(contract.pagination).toEqual({ mode: "none", parameters: [] });
  expect(contract.sideEffect).toBe("unknown");
  expect(contract.confirmation.required).toBe(true);
  expect(contract.retry).toEqual({ allowed: false, maxAttempts: 1, statusCodes: [] });
  expect(contract.auth.sourcePolicy).toEqual({ status: "unknown" });
  const executor = createAdminExecutor({ registry: fixtureRegistry([acpAgentsGetDescriptor()]), dispatch: async () => { throw new Error("unexpected dispatch"); } });
  try { await expect(executor.read(ACP_AGENTS_GET_ID, {})).rejects.toMatchObject({ code: "confirmation-required" }); }
  finally { executor.shutdown(); }
});

test("confirmed ACP probes return only projected status while their effects remain unknown", async () => {
  const fixture = new AcpAgentsFixture();
  fixture.settings.customAgents = [Object.assign(custom("private-agent", "fixture-extra", "fixture-extra --version"), { password: "private-password" })];
  fixture.outputs.set("fixture-extra", "private-version-output");
  const candidate = acpAgentsGetDescriptor();
  // Synthetic mutation authority exercises the shared consumer only; ACP remains unqualified.
  const descriptor: typeof candidate = {
    ...candidate,
    sideEffect: "mutation",
    auth: { ...candidate.auth, sourcePolicy: {
      status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false,
      handlerGuard: "none", bootstrap: "none", alternatives: [{ kind: "management-api-key", anyOf: ["manage", "admin"] }],
    } },
  };
  let calls = 0;
  const executor = createAdminExecutor({
    registry: fixtureRegistry([descriptor]),
    dispatch: async () => {
      calls += 1;
      const response = await fixture.get();
      return { kind: "response", status: response.status, body: await response.json() };
    },
  });
  executor.bindCredential({ profileId: "omniroute", endpoint: "http://127.0.0.1:20128", apiKey: "fixture-key" });
  try {
    const plan = await executor.plan(ACP_AGENTS_GET_ID, {});
    const result = await executor.apply(plan.planId, { confirmed: true });
    expect(result).toMatchObject({ status: "unknown", plan: { state: "unknown" }, error: { code: "uncertain-outcome" } });
    const output = result.output as { agents: Array<Record<string, unknown>>; summary: Body["summary"] };
    expect(output.agents.at(-1)).toEqual({ installed: true, isCustom: true });
    expect(output.summary.custom).toBe(1);
    expect(JSON.stringify(result)).not.toContain("private-");
    expect(JSON.stringify(result)).not.toContain("fixture-extra");
    await expect(executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-already-applied" });
    expect(calls).toBe(1);
  } finally { executor.shutdown(); }
});

test("expired source cache reprobes when settings omit customAgents", async () => {
  const fixture = new AcpAgentsFixture();
  fixture.settings = { customAgents: [custom("cached", "fixture-cache", "fixture-cache --version")] };
  fixture.outputs.set("fixture-cache", "1.0.0");
  await fixture.get();
  const count = fixture.probes.length;
  fixture.settings = {};
  fixture.outputs.set("fixture-cache", "2.0.0");
  fixture.now += 59_999;
  expect(((await (await fixture.get()).json()) as Body).agents.find(a => a.id === "cached")?.version).toBe("1.0.0");
  expect(fixture.probes.length).toBe(count);
  fixture.now += 1;
  expect(((await (await fixture.get()).json()) as Body).agents.find(a => a.id === "cached")?.version).toBe("2.0.0");
  expect(fixture.probes.length).toBeGreaterThan(count);
});

test("already aborted direct request still triggers source settings read and probes", async () => {
  const fixture = new AcpAgentsFixture();
  const controller = new AbortController();
  controller.abort();
  const response = await fixture.get(new Request("http://localhost/api/acp/agents", { signal: controller.signal }));
  expect(response.status).toBe(200);
  expect(fixture.settingsReads).toBe(1);
  expect(fixture.probes.length).toBeGreaterThan(0);
});

test("direct isAuthenticated requires a management-scoped key, not a read-scoped key", async () => {
  const fixture = new AcpAgentsFixture();
  fixture.requireLogin = true;
  fixture.apiKeys.set("fixture-read", ["read"]);
  fixture.apiKeys.set("fixture-manage", ["manage"]);
  const request = (key: string) => new Request("http://localhost/api/acp/agents", { headers: { authorization: `Bearer ${key}` } });
  expect((await fixture.get(request("fixture-read"))).status).toBe(401);
  expect(fixture.settingsReads).toBe(0);
  expect(fixture.probes).toEqual([]);
  expect((await fixture.get(request("fixture-manage"))).status).toBe(200);
  expect(fixture.settingsReads).toBe(1);
  expect(fixture.probes.length).toBeGreaterThan(0);
});

test.skipIf(process.platform !== "win32")("owned Windows fixture rejects an unsafe parent before creating files", () => {
  const previous = process.env.ACP_FIXTURE_PARENT;
  try {
    process.env.ACP_FIXTURE_PARENT = "C:\\unsafe!\\fixture";
    expect(() => new AcpOwnedProcesses()).toThrow("Windows owned fixture parent is not shell-safe");
  } finally {
    if (previous === undefined) delete process.env.ACP_FIXTURE_PARENT;
    else process.env.ACP_FIXTURE_PARENT = previous;
  }
});

// Candidate evidence only: the controlled process is not a qualification receipt,
// and neither real ingress nor the production authorization policy is established.
type AcpProcessObservation = { status: number | null; code: string; signal: string; stdout: string; error: string };
type AcpObservation = { stage: string; category: string; expected?: number | null; actual?: number | null; location?: string; tempForbiddenCodes?: number[]; parentForbiddenCodes?: number[];
  environment?: { supplied: Record<string, { present: boolean; matches: boolean }>; extras: Record<string, boolean>; unknownCount: number; duplicateCount: number };
  processes?: { recordCount: number | null; outcomeCount: number; probeCount: number; successProbeCount: number; normalizedProbeCount: number; caseInsensitiveProbeCount: number; successPathShellSafe: boolean; successPreflight: string; sourceProbes: { success: AcpProbeInspection | null; failure: AcpProbeInspection | null; stall: AcpProbeInspection | null }; sourceShell: boolean | null; rejections: Record<string, number>; success: AcpProcessObservation | null; failure: AcpProcessObservation | null; stall: AcpProcessObservation | null } };
let acpObservation: AcpObservation = { stage: "initializing", category: "incomplete" };
function acpStage(stage: string, expected?: number | null, actual?: number | null): void {
  acpObservation = { stage, category: "incomplete", ...(acpObservation.tempForbiddenCodes ? { tempForbiddenCodes: acpObservation.tempForbiddenCodes } : {}), ...(acpObservation.parentForbiddenCodes ? { parentForbiddenCodes: acpObservation.parentForbiddenCodes } : {}), ...(acpObservation.environment ? { environment: acpObservation.environment } : {}), ...(acpObservation.processes ? { processes: acpObservation.processes } : {}), ...(expected === undefined ? {} : { expected }), ...(actual === undefined ? {} : { actual }) };
  if (process.env.ACP_OBSERVATION_PATH) writeFileSync(process.env.ACP_OBSERVATION_PATH, JSON.stringify(acpObservation));
}
async function ownedProcessCase(): Promise<void> {
  const forbiddenCodes = (value: string): number[] => [...new Set(value.split("").filter(char => !/^[A-Za-z0-9._+@:/\\-]$/.test(char)).map(char => char.charCodeAt(0)))].slice(0, 16);
  if (process.platform === "win32") {
    acpObservation.tempForbiddenCodes = forbiddenCodes(tmpdir());
    acpObservation.parentForbiddenCodes = forbiddenCodes(process.env.ACP_FIXTURE_PARENT ?? tmpdir());
  }
  acpStage("initializing");
  try {
    await runOwnedProcessCase();
    acpObservation.category = "passed";
  } catch (error) {
    const name = error instanceof Error ? error.name : "";
    acpObservation.category = name === "AssertionError" || name === "ExpectError" ? "assertion" : name === "TimeoutError" ? "timeout" : "other";
    if (error instanceof Error && typeof error.stack === "string") {
      const match = error.stack.match(/(?:^|[\\/])test[\\/]admin-acp-agents\.test\.ts:(\d{1,5}):(\d{1,5})(?:\)?\s|$)/m);
      if (match) acpObservation.location = `test/admin-acp-agents.test.ts:${match[1]}:${match[2]}`;
    }
    throw error;
  } finally {
    if (process.env.ACP_OBSERVATION_PATH) writeFileSync(process.env.ACP_OBSERVATION_PATH, JSON.stringify(acpObservation));
  }
}

async function runOwnedProcessCase(): Promise<void> {
  const processes = new AcpOwnedProcesses();
  let executor: AdminExecutor | undefined;
  try {
    acpStage("create-processes");
    const success = processes.create("success");
    const failure = processes.create("failure");
    const stall = processes.create("stall");
    const windows = process.platform === "win32";
    const version = (binary: string) => `${windows ? `"${binary}"` : binary} --version`;
    const unsupported = path.join(processes.directory, "not-owned");
    const spaced = path.join(processes.directory, "not owned.cmd");
    const fixture = new AcpAgentsFixture(processes);
    fixture.settings = { customAgents: [
      custom("success", success, version(success)),
      custom("failure", failure, version(failure)),
      custom("stall", stall, version(stall)),
      custom("invalid-eval", success, `${windows ? `"${success}"` : success} -e`),
      custom("invalid-extra", success, `${version(success)} extra`),
      custom("invalid-shell", success, `${version(success)};bad`),
      custom("invalid-mismatch", success, version(failure)),
      custom("unsupported", unsupported, version(unsupported)),
      ...(windows ? [custom("shell-unsafe-space", spaced, version(spaced))] : []),
    ] };
    acpStage("initial-request");
    const controller = new AbortController();
    controller.abort();
    const response = await fixture.get(new Request("http://localhost/api/acp/agents", { signal: controller.signal }));
    let recordCount: number | null = null;
    try { recordCount = Math.min(processes.records().length, 1000); } catch { /* Diagnostic must not alter fixture behavior. */ }
    const processObservation = (command: string): AcpProcessObservation | null => {
      const index = processes.outcomes.findIndex(outcome => outcome.command === command);
      const outcome = processes.outcomes[index];
      if (!outcome) return null;
      const status = typeof outcome.status === "number" && Number.isInteger(outcome.status) && Math.abs(outcome.status) <= 65535 ? outcome.status : null;
      const code = outcome.code === null ? "none" : ["ENOENT", "EINVAL", "ETIMEDOUT"].includes(outcome.code) ? outcome.code : "other";
      const signal = outcome.signal === null ? "none" : ["SIGKILL", "SIGTERM"].includes(outcome.signal) ? outcome.signal : "other";
      const stdout = outcome.stdout === "" ? "empty" : outcome.stdout === "Owned agent 7.8.9-beta\n" ? "success" : outcome.stdout === "failed 3.2.1\n" ? "failure" : "other";
      return { status, code, signal, stdout, error: processes.errorCategories[index] ?? "unknown" };
    };
    const normalizedSuccess = path.normalize(success);
    const matchingProbe = fixture.probes.find(probe => probe.command === success);
    const sourceOptions = matchingProbe?.options as { shell?: boolean } | undefined;
    const inspect = (binary: string): AcpProbeInspection | null => {
      try { return fixture.inspectProbe(binary, version(binary)); } catch { return null; }
    };
    acpObservation.processes = { recordCount, outcomeCount: Math.min(processes.outcomes.length, 1000),
      probeCount: Math.min(fixture.probes.length, 1000), successProbeCount: Math.min(fixture.probes.filter(probe => probe.command === success).length, 1000),
      normalizedProbeCount: Math.min(fixture.probes.filter(probe => path.normalize(probe.command) === normalizedSuccess).length, 1000),
      caseInsensitiveProbeCount: Math.min(fixture.probes.filter(probe => probe.command.toLowerCase() === success.toLowerCase()).length, 1000),
      sourceProbes: { success: inspect(success), failure: inspect(failure), stall: inspect(stall) }, sourceShell: sourceOptions ? Boolean(sourceOptions.shell) : null,
      rejections: { ...processes.rejections }, successPathShellSafe: /^[A-Za-z0-9._+@:/\\-]+$/.test(success), successPreflight: processes.preflight.get("success") ?? "not-entered",
      success: processObservation(success), failure: processObservation(failure), stall: processObservation(stall) };
    acpStage("response-status", 200, response.status);
    expect(response.status).toBe(200);
    const body = await response.json() as Body;
    acpStage("settings-reads", 1, fixture.settingsReads);
    expect(fixture.settingsReads).toBe(1);
    const successAgent = body.agents.find(a => a.id === "success");
    acpStage("success-agent", 1, successAgent ? Number(successAgent.installed) : null);
    expect(successAgent).toMatchObject({ installed: true, version: "7.8.9-beta" });
    acpStage("invalid-agents");
    for (const id of ["failure", "stall", "invalid-eval", "invalid-extra", "invalid-shell", "invalid-mismatch", "unsupported"]) {
      const agent = body.agents.find(a => a.id === id);
      acpStage(`invalid-agent-${id}`, 0, agent ? Number(agent.installed) : null);
      expect(agent).toMatchObject({ installed: false, version: null });
    }
    acpStage("windows-unsafe-agent");
    if (windows) expect(body.agents.find(a => a.id === "shell-unsafe-space")).toMatchObject({ installed: false, version: null });
    acpStage("outcome-count", 3, processes.outcomes.length);
    expect(processes.outcomes).toHaveLength(3);
    acpStage("success-outcome", 0, processes.outcomes[0]?.status ?? null);
    expect(processes.outcomes[0]).toEqual({ command: success, stdout: "Owned agent 7.8.9-beta\n", status: 0, signal: null, code: null });
    acpStage("failure-outcome", 17, processes.outcomes[1]?.status ?? null);
    expect(processes.outcomes[1]).toMatchObject({ command: failure, stdout: "failed 3.2.1\n", status: 17 });
    acpStage("stall-outcome", null, processes.outcomes[2]?.status ?? null);
    expect(processes.outcomes[2]).toMatchObject({ command: stall, stdout: "", status: null, code: "ETIMEDOUT" });
    if (!windows) expect(processes.outcomes[2]?.signal).toBe("SIGKILL");
    acpStage("probe-counts");
    expect(fixture.probes.filter(p => p.command === success)).toHaveLength(1);
    expect(fixture.probes.filter(p => p.command === failure)).toHaveLength(1);
    expect(fixture.probes.some(p => p.command.endsWith("not-owned"))).toBe(true);
    acpStage("windows-probe-arguments");
    if (windows) {
      expect(fixture.probes.some(p => p.command === spaced)).toBe(false);
      for (const probe of fixture.probes.filter(p => [success, failure, stall].includes(p.command))) {
        expect(probe.args).toEqual(["--version"]);
        expect(probe.options).toMatchObject({ shell: true });
      }
    }
    acpStage("read-records");
    const records = processes.records();
    // A real Windows subprocess must exit on its own deadline, not fake time.
    acpStage("windows-stall-exit");
    if (windows) {
      const stallPid = records.find(record => record.mode === "stall")?.pid;
      if (stallPid === undefined) throw new Error("stall fixture did not start");
      const deadline = Date.now() + 5000;
      while (true) {
        try { process.kill(stallPid, 0); } catch { break; }
        if (Date.now() >= deadline) throw new Error("stall fixture did not exit");
        await Bun.sleep(50);
      }
    }
    acpStage("record-modes", 3, records.length);
    expect(records.map(r => r.mode)).toEqual(["success", "failure", "stall"]);
    for (const record of records) {
      acpStage("record-argv");
      expect(record.argv).toEqual(["--version"]);
      acpStage("record-cwd");
      expect(record.cwd).toBe(processes.directory);
      const expectedEnv: Record<string, string> = { PATH: "", HOME: processes.directory, TMPDIR: processes.directory, BUN_DISABLE_TRANSPILER_CACHE: "1" };
      if (windows) { expectedEnv.SystemRoot = process.env.SystemRoot!; expectedEnv.ComSpec = process.env.ComSpec!; }
      if (windows) {
        const entries = Object.entries(record.env).map(([key, value]) => [key.toUpperCase(), value] as const);
        const actualEnv = Object.fromEntries(entries);
        const normalizedExpected = Object.fromEntries(Object.entries(expectedEnv).map(([key, value]) => [key.toUpperCase(), value]));
        const extraNames = ["PATHEXT", "COMSPEC", "SYSTEMROOT", "TEMP", "TMP", "PROMPT"];
        acpObservation.environment = {
          supplied: Object.fromEntries(Object.entries(normalizedExpected).map(([key, value]) => [key, { present: Object.hasOwn(actualEnv, key), matches: actualEnv[key] === value }])),
          extras: Object.fromEntries(extraNames.map(key => [key, Object.hasOwn(actualEnv, key) && !Object.hasOwn(normalizedExpected, key)])),
          unknownCount: Math.min(entries.filter(([key]) => !Object.hasOwn(normalizedExpected, key) && !extraNames.includes(key)).length, 1000),
          duplicateCount: Math.min(entries.length - Object.keys(actualEnv).length, 1000),
        };
        acpStage("record-environment");
        expect(entries.length).toBe(Object.keys(actualEnv).length);
        expect(actualEnv).toEqual(normalizedExpected);
      } else {
        acpStage("record-environment");
        expect(record.env).toEqual(expectedEnv);
      }
      acpStage("record-process-exited");
      expect(() => process.kill(record.pid, 0)).toThrow();
    }
    acpStage("workspace-files");
    expect(readdirSync(processes.directory).sort()).toEqual(windows
      ? ["counter.jsonl", "probe-failure.cmd", "probe-failure.js", "probe-stall.cmd", "probe-stall.js", "probe-success.cmd", "probe-success.js"]
      : ["counter.jsonl", "probe-failure", "probe-stall", "probe-success"]);
    acpStage("candidate-executor");
    fixture.settings = {};
    const candidate = acpAgentsGetDescriptor();
    const descriptor: typeof candidate = { ...candidate, sideEffect: "mutation", auth: { ...candidate.auth, sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false, handlerGuard: "none", bootstrap: "none", alternatives: [{ kind: "management-api-key", anyOf: ["manage", "admin"] }] } } };
    executor = createAdminExecutor({ registry: fixtureRegistry([descriptor]), dispatch: async () => {
      const result = await fixture.get();
      return { kind: "response", status: result.status, body: await result.json() };
    } });
    executor.bindCredential({ profileId: "omniroute", endpoint: "http://127.0.0.1:20128", apiKey: "[REDACTED:auth_header]" });
    acpStage("candidate-plan");
    const plan = await executor.plan(ACP_AGENTS_GET_ID, {});
    acpStage("candidate-apply");
    const result = await executor.apply(plan.planId, { confirmed: true });
    acpStage("candidate-result");
    expect(result).toMatchObject({ status: "unknown", plan: { state: "unknown" }, error: { code: "uncertain-outcome" } });
    acpStage("candidate-summary");
    expect(result.output).toMatchObject({ summary: body.summary });
    acpStage("candidate-records");
    expect(processes.records()).toEqual(records);
    acpStage("candidate-reapply");
    await expect(executor.apply(plan.planId, { confirmed: true })).rejects.toMatchObject({ code: "plan-already-applied" });
    acpStage("candidate-records-after-reapply");
    expect(processes.records()).toEqual(records);
    acpStage("candidate-contract");
    expect(acpAgentsGetContract()).toMatchObject({ sideEffect: "unknown", auth: { sourcePolicy: { status: "unknown" } } });
    acpStage("cleanup");
  } finally {
    executor?.shutdown();
    // Windows may leave the owned stall child running briefly after its wrapper times out.
    if (process.platform === "win32") {
      const stallPid = processes.records().find(record => record.mode === "stall")?.pid;
      if (stallPid !== undefined) {
        const deadline = Date.now() + 8000;
        while (true) {
          try { process.kill(stallPid, 0); } catch { break; }
          if (Date.now() >= deadline) throw new Error("owned stall fixture termination unconfirmed; workspace retained");
          await Bun.sleep(50);
        }
      }
    }
    processes.cleanup();
    expect(processes.cleaned).toBe(true);
  }
}

test.skipIf(process.platform === "win32")("POSIX owned probes expose status, timeout, cache and abort behavior through the candidate consumer", ownedProcessCase, 20_000);
test.skipIf(process.platform !== "win32")("Windows native owned ACP probes expose status, timeout, cache, validation and ignored cancellation", ownedProcessCase, 30_000);
