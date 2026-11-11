import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { operationEvidenceBinding, outcomeArtifactPath, testCaseSourceHash, testOutcomeHash } from "../scripts/generate-contracts.ts";
import { canonicalizeJson, projectResponse } from "../src/admin/registry.ts";
import { agentSkillsContract, agentSkillsDescriptor, agentSkillsReadContract, agentSkillsReadDescriptor, PinnedAgentSkillsFixture, SKILLS_ID, SKILLS_DETAIL_ID, SKILLS_COVERAGE_ID, SKILLS_TEST_ID, SKILLS_TIME } from "./fixtures/pinned-agent-skills.fixture.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";

const ids = [
  "omni-auth", "omni-providers", "omni-models", "omni-combos-routing", "omni-api-keys", "omni-usage-logs", "omni-budget", "omni-settings", "omni-proxies", "omni-cache", "omni-compression", "omni-context-rtk", "omni-resilience", "omni-cli-tools", "omni-tunnels", "omni-sync-cloud", "omni-db-backups", "omni-webhooks", "omni-mcp", "omni-agents-a2a", "omni-version-manager", "omni-inference",
  "cli-serve", "cli-health", "cli-providers", "cli-keys", "cli-models", "cli-chat", "cli-routing", "cli-resilience", "cli-compression", "cli-contexts", "cli-cost-usage", "cli-mcp", "cli-a2a", "cli-tunnel", "cli-backup-sync", "cli-policy-audit", "cli-batches", "cli-eval", "cli-plugins-skills", "cli-setup", "cli-skill-collector", "config-codex-cli", "omni-github-skills", "ponytail",
];
type Body = { skills: Array<{ id: string; category: string; area: string; rawUrl: string; githubUrl: string }>; count: number; coverage: unknown };
let observation: { before: null; after: null; result: { status: number; body: unknown } } | undefined;
const readObservations = new Map<string, { before: null; after: null; result: { status: number; body: unknown } }>();

let missingDirectoryObserved = false;
let adapterObserved = false;
afterAll(async () => {
  if (!observation || !missingDirectoryObserved || !adapterObserved || readObservations.size !== 2) return;
  const caseSha256 = testCaseSourceHash(SKILLS_TEST_ID);
  await mkdir(resolve(process.cwd(), ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
  for (const [operationId, contract, observed] of [[SKILLS_ID, agentSkillsContract(), observation], [SKILLS_DETAIL_ID, agentSkillsReadContract(SKILLS_DETAIL_ID), readObservations.get(SKILLS_DETAIL_ID)!], [SKILLS_COVERAGE_ID, agentSkillsReadContract(SKILLS_COVERAGE_ID), readObservations.get(SKILLS_COVERAGE_ID)!]] as const) {
    const binding = operationEvidenceBinding(operationId, contract);
    const artifactPath = outcomeArtifactPath(operationId);
    await writeFile(resolve(process.cwd(), artifactPath), `${canonicalizeJson({ operationId, testId: SKILLS_TEST_ID, caseSha256, binding, observation: observed })}\n`, { mode: 0o600 });
    testOutcomeHash(operationId, SKILLS_TEST_ID, caseSha256, binding, contract, artifactPath);
  }
});

async function snapshot(root: string): Promise<unknown> {
  const entries = await readdir(root, { withFileTypes: true });
  return Promise.all(entries.sort((a, b) => a.name.localeCompare(b.name)).map(async entry => ({
    name: entry.name,
    value: entry.isDirectory() ? await snapshot(join(root, entry.name)) : await readFile(join(root, entry.name), "utf8"),
  })));
}
test("candidate adapter accepts the source config filter and rejects invalid categories", () => {
  const descriptor = agentSkillsDescriptor();
  const registry = fixtureRegistry([{ ...descriptor, mediaType: { request: descriptor.request.body?.mediaType ?? null, response: descriptor.response.mediaType }, coverage: { status: "invokable", adapterId: "typed.fixture.get.api.agent.skills", reason: null } }]);
  const adapter = registry.lookup(SKILLS_ID);
  if (!adapter) throw new Error("Fixture agent-skills adapter missing");
  const input = adapter.validate({ query: { category: "config", area: "config-codex-cli" } });
  expect(adapter.buildPath(input)).toBe("/api/agent-skills");
  const query = new URLSearchParams(adapter.buildQuery(input).map(parameter => `${parameter.encodedName}=${parameter.encodedValue}`).join("&"));
  expect(Object.fromEntries(query)).toEqual({ category: "config", area: "config-codex-cli" });
  expect(() => adapter.validate({ query: { category: "external" } })).toThrow();
  adapterObserved = true;
});


test("pinned catalog handler filters and counts disposable skill files without writing", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-skills-source-"));
  const log = spyOn(console, "error").mockImplementation(() => {});
  let fixture: PinnedAgentSkillsFixture | undefined;
  try {
    for (const id of ["omni-auth", "cli-setup", "config-codex-cli", "ponytail", "unlisted"]) {
      await mkdir(join(root, "skills", id), { recursive: true });
      await writeFile(join(root, "skills", id, "SKILL.md"), `fixture ${id}\n`);
    }
    await mkdir(join(root, "skills", "omni-providers")); // directory without SKILL.md
    await writeFile(join(root, "skills", "cli-health"), "not a directory");
    const before = await snapshot(root);
    fixture = new PinnedAgentSkillsFixture(root);
    const response = await fixture.handle();
    expect(response.status).toBe(200);
    const body = await response.json() as Body;
    expect(body.count).toBe(46);
    expect(body.skills.map(skill => skill.id)).toEqual(ids);
    for (const skill of body.skills) {
      expect(skill.rawUrl).toBe(`https://raw.githubusercontent.com/cheaper-inference/OmniRoute/refs/heads/main/skills/${skill.id}/SKILL.md`);
      expect(skill.githubUrl).toBe(`https://github.com/cheaper-inference/OmniRoute/blob/main/skills/${skill.id}/SKILL.md`);
    }
    expect(body.coverage).toEqual({ api: { have: 1, total: 23 }, cli: { have: 1, total: 21 }, config: { have: 1, total: 1 }, totalSkills: 3, generatedAt: SKILLS_TIME });
    const projected = projectResponse(agentSkillsDescriptor(), body);
    expect(projected).toEqual(body);
    const observed = { before: null, after: null, result: { status: response.status, body: projected } };
    const query = async (value: string): Promise<Body> => {
      const result = await fixture!.handle(value);
      expect(result.status).toBe(200);
      return await result.json() as Body;
    };
    const api = await query("?category=api");
    expect(api.count).toBe(23);
    expect(api.skills.map(skill => skill.id)).toEqual([...ids.slice(0, 22), "omni-github-skills"]);
    expect((await query("?category=cli")).skills.map(skill => skill.id)).toEqual(ids.slice(22, 43));
    expect((await query("?category=config")).skills.map(skill => skill.id)).toEqual(["config-codex-cli"]);
    expect((await query("?area=cli-setup")).skills.map(skill => skill.id)).toEqual(["cli-setup", "cli-skill-collector"]);
    expect((await query("?category=api&area=cli-setup")).count).toBe(0);
    expect((await query("?area=external")).skills.map(skill => skill.id)).toEqual(["ponytail"]);
    expect((await query("?area=")).count).toBe(46);
    expect((await query("?category=cli&category=api")).count).toBe(21);
    expect(api.coverage).toEqual(body.coverage);
    const invalid = await fixture.handle("?category=external");
    expect(invalid.status).toBe(400);
    const invalidBody = await invalid.json() as { error: { message: string } };
    expect(invalidBody.error.message).toBeTruthy();
    expect(projectResponse(agentSkillsDescriptor(), invalidBody)).toEqual(invalidBody);
    fixture.failNextJson = true;
    const failed = await fixture.handle();
    expect(failed.status).toBe(500);
    const failedBody = await failed.json() as { error: { message: string } };
    expect(failedBody.error.message).toBe("Failed to load agent skills catalog");
    expect(JSON.stringify(failedBody)).not.toContain("fixture-private-json-failure");
    expect(projectResponse(agentSkillsDescriptor(), failedBody)).toEqual(failedBody);
    const detail = await fixture.handlePath("/api/agent-skills/config-codex-cli");
    expect(detail.status).toBe(200);
    const detailBody = await detail.json();
    expect(detailBody).toEqual({ id: "config-codex-cli", name: "Config: Codex CLI", description: "Step-by-step agent workflow to configure the OpenAI Codex CLI on any machine (Linux, macOS, Windows) to use OmniRoute as an OpenAI-compatible backend. Detects OS and shell, writes config.toml and 7 named profiles, sets environment variables, and verifies the setup.", category: "config", area: "config-codex-cli", icon: "terminal", isNew: true, rawUrl: "https://raw.githubusercontent.com/cheaper-inference/OmniRoute/refs/heads/main/skills/config-codex-cli/SKILL.md", githubUrl: "https://github.com/cheaper-inference/OmniRoute/blob/main/skills/config-codex-cli/SKILL.md" });
    expect(projectResponse(agentSkillsReadDescriptor(SKILLS_DETAIL_ID), detailBody)).toEqual(detailBody);
    const unknown = await fixture.handlePath("/api/agent-skills/not-a-skill");
    expect(unknown.status).toBe(404);
    expect((await unknown.json() as { error: { message: string } }).error.message).toBe("Skill not found: not-a-skill");
    const coverageResponse = await fixture.handlePath("/api/agent-skills/coverage");
    expect(coverageResponse.status).toBe(200);
    const coverageBody = await coverageResponse.json();
    expect(coverageBody).toEqual({ api: { have: 1, total: 23 }, cli: { have: 1, total: 21 }, config: { have: 1, total: 1 }, totalSkills: 3, generatedAt: SKILLS_TIME });
    expect(projectResponse(agentSkillsReadDescriptor(SKILLS_COVERAGE_ID), coverageBody)).toEqual(coverageBody);
    fixture.failNextJson = true;
    const detailFailure = await fixture.handlePath("/api/agent-skills/config-codex-cli");
    expect(detailFailure.status).toBe(500);
    expect((await detailFailure.json() as { error: { message: string } }).error.message).toBe("Failed to load skill");
    fixture.failNextJson = true;
    const coverageFailure = await fixture.handlePath("/api/agent-skills/coverage");
    expect(coverageFailure.status).toBe(500);
    expect((await coverageFailure.json() as { error: { message: string } }).error.message).toBe("Failed to compute skill coverage");
    for (const [operationId, value] of [[SKILLS_DETAIL_ID, detailBody], [SKILLS_COVERAGE_ID, coverageBody]] as const) readObservations.set(operationId, { before: null, after: null, result: { status: 200, body: value } });
    for (const operationId of [SKILLS_DETAIL_ID, SKILLS_COVERAGE_ID] as const) {
      const descriptor = agentSkillsReadDescriptor(operationId);
      const registry = fixtureRegistry([{ ...descriptor, mediaType: { request: descriptor.request.body?.mediaType ?? null, response: descriptor.response.mediaType }, coverage: { status: "invokable", adapterId: `typed.fixture.${operationId}`, reason: null } }]);
      const adapter = registry.lookup(operationId);
      if (!adapter) throw new Error(`Fixture adapter missing: ${operationId}`);
      const input = adapter.validate(operationId === SKILLS_DETAIL_ID ? { path: { id: "config-codex-cli" } } : {});
      expect(adapter.buildPath(input)).toBe(operationId === SKILLS_DETAIL_ID ? "/api/agent-skills/config-codex-cli" : "/api/agent-skills/coverage");
      if (operationId === SKILLS_DETAIL_ID) expect(() => adapter.validate({ path: { id: "a b" } })).toThrow();
      expect(adapter.buildQuery(input)).toEqual([]);
    }
    expect(await snapshot(root)).toEqual(before);
    observation = observed;
  } finally {
    fixture?.close();
    log.mockRestore();
    await rm(root, { recursive: true, force: true });
  }
});

test("missing skills directory is a successful zero-coverage read", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-skills-empty-"));
  const fixture = new PinnedAgentSkillsFixture(root);
  try {
    const response = await fixture.handle();
    expect(response.status).toBe(200);
    const body = await response.json() as Body;
    expect(body.count).toBe(46);
    expect(body.coverage).toEqual({ api: { have: 0, total: 23 }, cli: { have: 0, total: 21 }, config: { have: 0, total: 1 }, totalSkills: 0, generatedAt: SKILLS_TIME });
    const coverage = await fixture.handlePath("/api/agent-skills/coverage");
    expect(coverage.status).toBe(200);
    expect(await coverage.json()).toEqual({ api: { have: 0, total: 23 }, cli: { have: 0, total: 21 }, config: { have: 0, total: 1 }, totalSkills: 0, generatedAt: SKILLS_TIME });
    expect(await readdir(root)).toEqual([]);
    missingDirectoryObserved = true;
  } finally {
    fixture.close();
    await rm(root, { recursive: true, force: true });
  }
});
