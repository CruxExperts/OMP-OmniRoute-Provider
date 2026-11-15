import { expect, spyOn, test } from "bun:test";
import { ACP_AGENTS_GET_ID, AcpAgentsFixture, acpAgentsGetContract, acpAgentsGetDescriptor, type CustomAgent } from "./fixtures/acp-agents.fixture.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { createAdminExecutor } from "../src/admin/executor.ts";

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
