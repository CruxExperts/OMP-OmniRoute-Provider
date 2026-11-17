import { expect, test } from "bun:test";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  expectedHealthIngressIdentities,
  generateOperations,
  operationContractTemplate,
  operationEvidenceBinding,
  outcomeArtifactPath,
  testCaseSourceHash,
  testOutcomeHash,
  responseFor,
  validateResponseContract,
  validateHealthIngressEvidence,
  validateCoreLifecycleEvidence,
  validateCoreLifecycleObservation,
  validateAcpContract,
  validateAcpNativeEvidence,
  validateAcpNativeResults,
} from "../scripts/generate-contracts.ts";
import { decodeRouteSources, resolveQualificationSource } from "../scripts/route-source-store.ts";
import { validateReleaseSourceIdentity } from "../scripts/release-gate.ts";
import { operationRequiresIngressEvidence } from "../src/admin/eligibility.ts";
import { getOperation, projectResponse, type OperationDescriptor } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { FALLBACK_CHAIN_POST, FALLBACK_CHAIN_SOURCE_CONTRACTS } from "./fixtures/fallback-chains.fixture.ts";
import { jsonHealthContract } from "./fixtures/pinned-health.fixture.ts";
import { degradationContract } from "./fixtures/pinned-degradation.fixture.ts";
import { agentSkillsContract, agentSkillsReadContract, SKILLS_DETAIL_ID, SKILLS_COVERAGE_ID } from "./fixtures/pinned-agent-skills.fixture.ts";
import { reasoningRulesGetContract, REASONING_RULES_GET_ID } from "../src/admin/source-reasoning-rules.ts";
import type { OperationSourceContract } from "../src/admin/eligibility.ts";
import { acpAgentsGetContract } from "./fixtures/acp-agents.fixture.ts";
import { MODEL_COMBO_MAPPING_OPERATION_IDS, MODEL_COMBO_MAPPING_SOURCE_CONTRACTS } from "./fixtures/model-combo-mappings.fixture.ts";

test("cache metrics, ping and ACP require exact ingress evidence", () => {
  for (const id of ["GET /api/settings/cache-metrics", "DELETE /api/settings/cache-metrics", "GET /api/health/ping", "GET /api/acp/agents"]) expect(operationRequiresIngressEvidence(id)).toBe(true);
  for (const id of ["POST /api/settings/cache-metrics", "HEAD /api/health/ping", "POST /api/acp/agents"]) expect(operationRequiresIngressEvidence(id)).toBe(false);
});
test("ACP admission rejects missing native proof and weakened lifecycle contracts", () => {
  const contract = acpAgentsGetContract();
  expect(() => validateAcpContract(contract)).not.toThrow();
  expect(() => validateAcpNativeEvidence(undefined, { sideEffect: "lifecycle" } as never)).toThrow();
  expect(() => validateAcpNativeEvidence({ artifact: "provenance/qualification/native-acp-" + "a".repeat(64) + ".json", sha256: "b".repeat(64) }, { sideEffect: "lifecycle" } as never)).toThrow();
  for (const changed of [
    { ...contract, sideEffect: "read" },
    { ...contract, confirmation: { ...contract.confirmation, required: false } },
    { ...contract, retry: { allowed: true, maxAttempts: 2, statusCodes: [500] } },
    { ...contract, mutationSafety: { ...contract.mutationSafety!, settlement: { responseComplete: { statusCodes: [200] }, definiteRejection: null } } },
    { ...contract, auth: { ...contract.auth, sourcePolicy: { ...contract.auth.sourcePolicy, localOnly: false } } },
  ]) expect(() => validateAcpContract(changed)).toThrow();
});
test("native ACP target projections reject missing, duplicated and altered stages", () => {
  const stage = { stage: "cleanup", category: "passed", recordCount: 3, outcomeCount: 3, environmentMatches: true, unknownEnvironmentCount: 0, sentinelAssertionPassed: true, outcomes: { success: { status: 0, code: "none", signal: "none", stdout: "success", error: "none" }, failure: { status: 17, code: "none", signal: "none", stdout: "failure", error: "other" }, stall: { status: null, code: "ETIMEDOUT", signal: "SIGKILL", stdout: "empty", error: "timeout" } } };
  const target = (name: string, artifactId: number) => ({ target: name, artifactId, archiveSha256: "a".repeat(64), receiptSha256: "b".repeat(64), stageSha256: "c".repeat(64), stage });
  const results = [target("windows-x64", 1), target("windows-arm64", 2)];
  expect(() => validateAcpNativeResults(results)).not.toThrow();
  expect(() => validateAcpNativeResults(results.slice(0, 1))).toThrow();
  expect(() => validateAcpNativeResults([results[0], { ...results[1], artifactId: 1 }])).toThrow();
  expect(() => validateAcpNativeResults([results[0], { ...results[1], target: "windows-x64" }])).toThrow();
  expect(() => validateAcpNativeResults([results[0], { ...results[1], stage: { ...stage, sentinelAssertionPassed: false } }])).toThrow();
  expect(() => validateAcpNativeResults([results[0], { ...results[1], stage: { ...stage, outcomes: { ...stage.outcomes, stall: { ...stage.outcomes.stall, error: "none" } } } }])).toThrow();
});



test("derived lifecycle research joins independent identities and cold/warm observations", () => {
  const binding = { sourceDerivation: { record: "provenance/derivations/omniroute-3.8.53-startup/manifest.json", sha256: "a".repeat(64) }, effectiveTreeSha256: "b".repeat(64) };
  const phase = (name: "cold" | "warm") => ({ phase: name, driver: "node:sqlite", ping: true, healthWorker: true, healthy: true, settingsPersisted: true, databaseExistedBefore: name === "warm", runtimeSettingApplied: name === "cold", hotReloadFailure: false, tableCount: 2, migrationCount: 3, tableSha256: "c".repeat(64), migrationSha256: "d".repeat(64) });
  const authStatus = { cold: { invalidRejected: true, validAccepted: true, databaseExistedBefore: false, onboardingBefore: "absent", onboardingAfter: "persisted", invalidNoDatabase: true }, warm: { invalidRejected: true, validAccepted: true, databaseExistedBefore: true, onboardingBefore: "persisted", onboardingAfter: "persisted", cachedRevocation: true, revocationAfterExpiry: true, passwordCutoffAfterExpiry: true } };
  const expected = { identity: { ...binding, runnerSourceSha256: "e".repeat(64), runnerArguments: ["/runtime/node", "--import", "tsx/esm", "/work/app/src/lib/db/pinnedLifecycleFixture.mjs"], workerOutputSha256: "f".repeat(64) }, inputSha256: { "scripts/pinned-ingress.py": "1".repeat(64) }, isolation: { network: "private-loopback-only", capabilities: "dropped", source: "read-only", processes: "separate-cold-warm", startupRegressions: "passed" }, cold: phase("cold"), warm: phase("warm"), authStatus };
  // This exercises the join in isolation; it is not a producer receipt.
  const artifact = { status: "research-observed", qualification: false, boundary: "Direct pinned core and settings in isolated Node processes; auth uses a separate persistent database and an explicit cookie boundary; no HTTP, authorization, packaged application or operation qualification.", identity: structuredClone(expected.identity), inputSha256: { "scripts/pinned-ingress.py": "1".repeat(64) }, isolation: { network: "private-loopback-only", capabilities: "dropped", source: "read-only", processes: "separate-cold-warm", startupRegressions: "passed" }, cold: phase("cold"), warm: phase("warm"), authStatus: structuredClone(authStatus) };
  expect(() => validateCoreLifecycleObservation(artifact, binding, expected)).not.toThrow();
  for (const changed of [
    { ...artifact, qualification: true },
    { ...artifact, identity: { ...artifact.identity, runnerArguments: [] } },
    { ...artifact, identity: { ...artifact.identity, runnerSourceSha256: "0".repeat(64) } },
    { ...artifact, identity: { ...artifact.identity, runnerOutputSha256: "0".repeat(64) } },
    { ...artifact, identity: { ...artifact.identity, effectiveTreeSha256: "0".repeat(64) } },
    { ...artifact, inputSha256: {} },
    { ...artifact, isolation: { ...artifact.isolation, capabilities: "retained" } },
    { ...artifact, authStatus: { ...artifact.authStatus, cold: { ...artifact.authStatus.cold, invalidNoDatabase: false } } },
    { ...artifact, authStatus: { ...artifact.authStatus, warm: { ...artifact.authStatus.warm, onboardingBefore: "absent" } } },
    { ...artifact, cold: { ...artifact.cold, databaseExistedBefore: true } },
    { ...artifact, cold: { ...artifact.cold, runtimeSettingApplied: false } },
    { ...artifact, cold: { ...artifact.cold, hotReloadFailure: true } },
    { ...artifact, warm: { ...artifact.warm, hotReloadFailure: true } },
    { ...artifact, warm: { ...artifact.warm, runtimeSettingApplied: true } },
    { ...artifact, warm: { ...artifact.warm, settingsPersisted: false } },
    { ...artifact, warm: { ...artifact.warm, migrationSha256: "0".repeat(64) } },
  ]) expect(() => validateCoreLifecycleObservation(changed, binding, expected)).toThrow();
  // Even matching purported independent observations cannot legitimize a failed reload.
  const failedReload = { ...artifact, cold: { ...artifact.cold, hotReloadFailure: true } };
  expect(() => validateCoreLifecycleObservation(failedReload, binding, { ...expected, cold: failedReload.cold })).toThrow();
  expect(() => validateCoreLifecycleObservation(artifact, {}, expected)).toThrow();
  expect(() => validateCoreLifecycleEvidence({ artifact: `provenance/qualification/core-lifecycle-${"0".repeat(64)}.json`, sha256: "1".repeat(64) }, binding)).toThrow(/path mismatch/);
});
test("lifecycle evidence rejects missing and altered content-addressed artifacts", async () => {
  const binding = { sourceDerivation: { record: "provenance/derivations/omniroute-3.8.53-startup/manifest.json", sha256: "a".repeat(64) }, effectiveTreeSha256: "b".repeat(64) };
  const bytes = "synthetic lifecycle artifact\n";
  const digest = createHash("sha256").update(bytes).digest("hex");
  const artifact = `provenance/qualification/core-lifecycle-${digest}.json`;
  const file = resolve(import.meta.dir, "..", artifact);
  const evidence = { artifact, sha256: digest };
  let created = false;
  try {
    expect(() => validateCoreLifecycleEvidence(evidence, binding)).toThrow();
    await writeFile(file, "changed synthetic bytes\n", { flag: "wx" });
    created = true;
    expect(() => validateCoreLifecycleEvidence(evidence, binding)).toThrow(/digest mismatch/);
  } finally { if (created) await rm(file, { force: true }); }
});


function sourceRequestAdapter(operationId: string) {
  const source = getOperation(operationId);
  if (!source) throw new Error("source request fixture missing");
  const template = operationContractTemplate(operationId);
  const descriptor: OperationDescriptor = {
    ...source,
    request: template.request as OperationDescriptor["request"],
    auth: {
      ...source.auth,
      domain: "management",
      sourcePolicy: {
        status: "qualified",
        source: "omniroute-v3.8.53",
        routeClass: "management",
        localOnly: false,
        handlerGuard: "none",
        bootstrap: "none",
        alternatives: [{ kind: "management-api-key", anyOf: ["manage", "admin"] }],
      },
    },
    sideEffect: "read",
    confirmation: { required: false, reason: "Synthetic request-validation fixture, not release qualification." },
    coverage: { status: "invokable", adapterId: "fixture.source-request", reason: null },
  };
  return fixtureRegistry([descriptor]).require(operationId);
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("fixture value must be an object");
  return value as Record<string, unknown>;
}

test("source contract binding rejects unsupported legacy guard alternatives and scopes", () => {
  const operationId = "GET /api/health/degradation";
  const base = degradationContract();
  const policy = {
    status: "qualified", source: "omniroute-v3.8.53", routeClass: "management", localOnly: false,
    handlerGuard: "isAuthenticated", bootstrap: "none", alternatives: [
      { kind: "management-api-key", anyOf: ["manage", "admin"] },
      { kind: "dashboard-session" },
      { kind: "auth-disabled", when: "central-and-handler-auth-not-required" },
    ],
  };
  const bind = (sourcePolicy: unknown) => operationEvidenceBinding(operationId, {
    ...base, auth: { ...base.auth, sourcePolicy },
  });
  expect(() => bind(policy)).not.toThrow();
  expect(() => bind({ ...policy, alternatives: [...policy.alternatives, { kind: "oma-access-token", minimumScope: "read" }] })).toThrow(/isAuthenticated contains an unproven/);
  for (const alternative of [
    { kind: "runtime-api-key", sourceScopes: [] },
    { kind: "metadata-api-key", sourceScopes: [] },
    { kind: "trusted-local", loopbackOnly: true },
    { kind: "management-api-key", anyOf: ["read"] },
  ]) expect(() => bind({ ...policy, alternatives: [...policy.alternatives, alternative] })).toThrow();
  for (const changed of [
    { ...policy, handlerGuard: "other" },
    { ...policy, bootstrap: "oma-whoami" },
    { ...policy, routeClass: "client-api" },
  ]) expect(() => bind(changed)).toThrow();
});

test("release source validation binds configured derivation and tree across both contracts and every qualification", () => {
  const root = resolve(import.meta.dir, "..");
  const derivation = resolveQualificationSource(root).derivation;
  if (!derivation) throw new Error("derived source required for this regression");
  const identity = { sourceDerivation: derivation, effectiveTreeSha256: "a".repeat(64) };
  const operation = { operationId: "GET /synthetic", qualification: { binding: { ...identity } } };
  const operations = { sourceContext: { ...identity }, operations: [operation] };
  const entry = { operationId: operation.operationId, binding: { ...identity } };
  const eligibility = { ...identity, operations: [entry] };
  expect(() => validateReleaseSourceIdentity(root, operations, eligibility)).not.toThrow();
  const changed = { ...derivation, sha256: "b".repeat(64) };
  expect(() => validateReleaseSourceIdentity(root, operations, { ...eligibility, sourceDerivation: changed })).toThrow();
  expect(() => validateReleaseSourceIdentity(root, { ...operations, sourceContext: { ...identity, sourceDerivation: changed } }, { ...eligibility, sourceDerivation: changed })).toThrow();
  expect(() => validateReleaseSourceIdentity(root, operations, { ...eligibility, effectiveTreeSha256: undefined })).toThrow();
  expect(() => validateReleaseSourceIdentity(root, operations, { ...eligibility, effectiveTreeSha256: "b".repeat(64) })).toThrow();
  expect(() => validateReleaseSourceIdentity(root, operations, { ...eligibility, operations: [{ ...entry, binding: { ...identity, sourceDerivation: changed } }] })).toThrow();
  expect(() => validateReleaseSourceIdentity(root, { ...operations, operations: [{ ...operation, qualification: { binding: { ...identity, effectiveTreeSha256: "b".repeat(64) } } }] }, eligibility)).toThrow();
});

test("HEAD empty evidence is status-scoped and cannot be invented or dropped by a contract", () => {
  const sourceFile = "src/app/api/livez/route.ts";
  const hint = { statusCode: "200", mediaType: "text/plain", sourceFiles: [sourceFile], contentSourceFile: sourceFile };
  const spec = { responses: { "200": { headers: { "Content-Length": { required: true, schema: { type: "string" } } } } } };
  const head = record(responseFor(spec, "HEAD /api/livez", [{ ...hint, body: "empty" }]));
  const variants = head.variants as Array<Record<string, unknown>>;
  expect(variants[0]).toMatchObject({ statusCode: "200", body: "empty", content: [{ mediaType: "text/plain" }], headers: { "Content-Length": { required: true } } });
  validateResponseContract(head, head, "HEAD /api/livez");
  const withoutBody = { ...head, variants: variants.map(({ body: _body, ...variant }) => variant) };
  expect(() => validateResponseContract(withoutBody, head, "HEAD /api/livez")).toThrow("alters source-derived response body evidence");
  const unknown = record(responseFor(spec, "HEAD /api/livez", [hint]));
  expect(record((unknown.variants as unknown[])[0]).body).toBeUndefined();
  expect(() => validateResponseContract(head, unknown, "HEAD /api/livez")).toThrow("alters source-derived response body evidence");
  const mixed = record(responseFor(spec, "HEAD /api/livez", [{ ...hint, body: "empty" }, hint]));
  expect(record((mixed.variants as unknown[])[0]).body).toBeUndefined();
  const get = record(responseFor(spec, "GET /api/livez", [hint]));
  expect(record((get.variants as unknown[])[0]).body).toBeUndefined();
});
test("unknown header JSON constructor only permits matching source specialization", () => {
  const file = "src/app/api/example/route.ts";
  const source = { file, sha256: "a".repeat(64), gitBlobSha: "b".repeat(40) };
  const base = { statusCodes: ["200"], mediaType: null, schema: null, variants: [{ statusCode: "200", content: [], headers: {} }] };
  const response = { ...base, mediaType: "application/json", variants: [{ statusCode: "200", content: [{ mediaType: "application/json", schema: null, sourceFile: file }], headers: {} }] };
  const witness = { method: "GET", statusCode: "200", sourceFile: file };
  expect(() => validateResponseContract(response, base, "GET /api/example", source, [witness])).not.toThrow();
  for (const changed of [[], [{ ...witness, method: "POST" }], [{ ...witness, statusCode: "201" }], [{ ...witness, sourceFile: "src/other.ts" }], [{ ...witness, extra: true }]]) expect(() => validateResponseContract(response, base, "GET /api/example", source, changed)).toThrow();
  expect(() => validateResponseContract(response, base, "GET /api/example", { ...source, file: "src/other.ts" }, [witness])).toThrow();
});
test("reasoning empty framework failure is additive and bound to the reviewed handler", () => {
  const template = operationContractTemplate(REASONING_RULES_GET_ID) as OperationSourceContract;
  const response = reasoningRulesGetContract(template).response;
  const source = { file: "src/app/api/settings/reasoning-routing-rules/route.ts", sha256: "8607798ef6ffb9deed566cea0f25e7c9438be8eb090d1196240fab6a4f6d3018", gitBlobSha: "fd13070fad4b50034e2019cd1d75058d871f93cf" };
  expect(() => operationEvidenceBinding(REASONING_RULES_GET_ID, reasoningRulesGetContract(template))).not.toThrow();
  expect(() => validateResponseContract(response, template.response, REASONING_RULES_GET_ID, source)).not.toThrow();
  for (const changed of [undefined, { ...source, sha256: "0".repeat(64) }, { ...source, gitBlobSha: "0".repeat(40) }, { ...source, file: "src/app/other/route.ts" }]) {
    expect(() => validateResponseContract(response, template.response, REASONING_RULES_GET_ID, changed)).toThrow();
  }
  expect(() => validateResponseContract(response, template.response, "GET /api/other", source)).toThrow();
  for (const bad of [{ statusCode: "500", content: [], headers: {} }, { statusCode: "500", content: [], body: "empty", headers: { "x-extra": { required: false, schema: null } } }, { statusCode: "500", content: [{ mediaType: "text/plain", schema: null }], body: "empty", headers: {} }]) {
    expect(() => validateResponseContract({ ...response, variants: [...response.variants.slice(0, -1), bad] }, template.response, REASONING_RULES_GET_ID, source)).toThrow();
  }
  const changedBase = { ...response, variants: response.variants.map((variant, index) => index === 0 ? { ...variant, body: "empty" } : variant) };
  expect(() => validateResponseContract(changedBase, template.response, REASONING_RULES_GET_ID, source)).toThrow();
});


test("public health pipeline responses remain conservative without complete exclusivity proof", () => {
  const template = record(operationContractTemplate("GET /api/health").response);
  const variants = template.variants as Array<Record<string, unknown>>;
  for (const status of ["403", "503"]) {
    const variant = variants.find(item => item.statusCode === status);
    if (!variant) throw new Error(`missing response ${status}`);
    expect(record((variant.content as unknown[])[0]).schema).toBeNull();
    expect(variant.headers).toEqual({});
    expect(variant.sourceFiles).toContain("src/server/authz/pipeline.ts");
  }
});

test("client API SSO rejections are not narrowed to pipeline-only bodies or headers", () => {
  const response = record(operationContractTemplate("POST /api/v1/messages").response);
  const variants = response.variants as Array<Record<string, unknown>>;
  const source = getOperation("POST /api/v1/messages");
  if (!source) throw new Error("missing client API operation");
  // Values are the pinned Entra policy outcomes forwarded by rejectionResponse.
  const outcomes = [
    { status: "403", body: { error: { code: "AUTH_SSO_DEACTIVATED", message: "This SSO identity has been deactivated on the gateway", correlation_id: "request-id" } } },
    { status: "503", body: { error: { code: "AUTH_SSO_PROVISION_FAILED", message: "Could not provision gateway access for this identity", correlation_id: "request-id" } } },
  ];
  for (const { status, body } of outcomes) {
    const variant = variants.find(item => item.statusCode === status);
    if (!variant) throw new Error(`missing response ${status}`);
    expect(projectResponse({ ...source, response: { ...source.response, schema: record((variant.content as unknown[])[0]).schema as OperationDescriptor["response"]["schema"] }, streaming: { mode: "json", framing: "application/json" } }, body)).toBeUndefined();
    expect(record((variant.content as unknown[])[0]).schema).toBeNull();
    expect(variant.headers).toEqual({});
    expect(variant.sourceFiles).toContain("src/server/authz/pipeline.ts");
    expect(variant.sourceFiles).toContain("src/server/authz/classify.ts");
  }
});

test("supplied pipeline witnesses cannot claim excluded HEAD or OPTIONS responses", async () => {
  const stored = JSON.parse(await readFile(resolve(import.meta.dir, "../provenance/route-sources.json"), "utf8"));
  for (const method of ["HEAD", "OPTIONS"]) {
    const manifest = record(decodeRouteSources(stored));
    const routes = manifest.routeFiles as Array<Record<string, unknown>>;
    const route = routes.find(item => item.routeTemplate === "/api/v1/messages");
    if (!route) throw new Error("missing client API fixture route");
    const exports = record(route.exports).resolved as string[];
    if (!exports.includes(method)) exports.push(method);
    const hints = route.centralResponseHints as Array<Record<string, unknown>>;
    const originals = hints.filter(hint => hint.authority === "pinned-framework-pipeline" && hint.method === "POST");
    hints.push(...originals.map(hint => ({ ...hint, method })));
    const coverage = record(record(manifest.centralIngress).coverage);
    coverage.publishedResponseVariants = Number(coverage.publishedResponseVariants) + originals.length;
    expect(() => generateOperations(manifest, new Map())).toThrow("central response hint is not source-bound");
  }
});

test("pipeline and management responses sharing a status remain one conservative variant", () => {
  const response = record(operationContractTemplate("GET /api/providers").response);
  const variants = response.variants as Array<Record<string, unknown>>;
  for (const status of ["401", "403", "503"]) expect(variants.filter(item => item.statusCode === status)).toHaveLength(1);
  const forbidden = variants.find(item => item.statusCode === "403");
  expect(forbidden).toBeDefined();
  expect((forbidden?.sourceFiles as string[])).toContain("src/server/authz/pipeline.ts");
  expect((forbidden?.sourceFiles as string[])).toContain("src/server/authz/policies/management.ts");
  expect(record((forbidden?.content as unknown[])[0]).schema).toBeNull();
  const ping = jsonHealthContract("GET /api/health/ping");
  const ping503s = ping.response.variants.filter(item => item.statusCode === "503");
  expect(ping503s).toHaveLength(1);
  const ping503 = ping503s[0];
  expect(ping503?.sourceFiles).toContain("src/server/authz/pipeline.ts");
  expect(ping503?.content[0]?.schema).toBeNull();
});

test("OpenAPI nullable without type preserves enum constraints without inventing a type", () => {
  const request = record(operationContractTemplate("POST /api/v1/music/detailed").request);
  const schema = record(record(request.body).schema);
  const branches = schema.oneOf as unknown[];
  const first = record(record(branches[0]).properties);
  const second = record(record(branches[1]).properties);
  expect(first.composition_plan).toEqual({ enum: [null] });
  expect(second.prompt).toEqual({ enum: [null] });
  expect(record(record(schema.properties).composition_plan).type).toEqual(["object", "null"]);
});

test("observed outcomes enforce bound explicit output-secret paths and typed token metadata", async () => {
  const operationId = "GET /.well-known/agent-card.json";
  const testId = "test/contracts.test.ts";
  const template = operationContractTemplate(operationId);
  const contract = {
    ...template,
    auth: {
      ...record(template.auth),
      domain: "public",
      sourcePolicy: { status: "qualified", source: "omniroute-v3.8.53", routeClass: "public", alternatives: [{ kind: "anonymous" }] },
    },
    secrets: { inputFields: [], outputFields: ["providers.connections.lastError", "config.apiKey"] },
    sideEffect: "read",
  };
  const binding = operationEvidenceBinding(operationId, contract);
  const caseSha256 = testCaseSourceHash(testId);
  const artifactPath = outcomeArtifactPath(operationId);
  const absolutePath = resolve(import.meta.dir, "..", artifactPath);
  const previous = await readFile(absolutePath).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  const observation = (body: unknown, before: unknown = {}, after: unknown = {}) => ({ before, after, result: { status: 200, body } });
  const writeArtifact = async (body: unknown, before?: unknown, after?: unknown) => {
    await mkdir(resolve(import.meta.dir, "../.agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
    await writeFile(absolutePath, `${JSON.stringify({ operationId, testId, caseSha256, binding, observation: observation(body, before, after) })}\n`, { mode: 0o600 });
  };

  try {
    await writeArtifact({
      providers: [{ connections: [{ max_output_tokens: 8192, outputTokenLimit: 4096 }] }],
      config: { reasoningTokenBufferEnabled: true },
    });
    expect(testOutcomeHash(operationId, testId, caseSha256, binding, contract, artifactPath)).toMatch(/^[a-f0-9]{64}$/);

    await writeArtifact({ safe: true }, {}, { providers: [{ connections: [{ lastError: "fixture-provider-secret" }] }] });
    expect(() => testOutcomeHash(operationId, testId, caseSha256, binding, contract, artifactPath)).toThrow(/secret-bearing field name/);

    await writeArtifact({ providers: [{ connections: [{ lastError: "fixture-provider-secret" }] }] });
    expect(() => testOutcomeHash(operationId, testId, caseSha256, binding, contract, artifactPath)).toThrow(/secret-bearing field name/);

    await writeArtifact({ providers: [{ connections: [{ max_output_tokens: "8192", outputTokenLimit: 4096 }] }] });
    expect(() => testOutcomeHash(operationId, testId, caseSha256, binding, contract, artifactPath)).toThrow(/secret-bearing field name/);

    const omittedSecretPath = { ...contract, secrets: { inputFields: [], outputFields: [] } };
    expect(() => testOutcomeHash(operationId, testId, caseSha256, binding, omittedSecretPath, artifactPath)).toThrow(/reviewed contract does not match the operation evidence binding/);
    const extraSecretsKey = { ...contract, secrets: { ...record(contract.secrets), undocumented: "ignored" } };
    expect(() => testOutcomeHash(operationId, testId, caseSha256, binding, extraSecretsKey, artifactPath)).toThrow(/unsupported keys/);
    expect(() => testOutcomeHash(operationId, testId, caseSha256, binding, undefined, artifactPath)).toThrow(/reviewed contract must be an object/);
  } finally {
    if (previous === undefined) await rm(absolutePath, { force: true });
    else await writeFile(absolutePath, previous, { mode: 0o600 });
  }
});

test("source-derived provider pagination stays optional and rejects invalid bounds before dispatch", () => {
  const adapter = sourceRequestAdapter("GET /api/providers");
  expect(adapter.validate({}).query).toEqual({});
  const input = adapter.validate({ query: { provider: "openai", limit: 2, offset: 0 } });
  const query = new URLSearchParams(adapter.buildQuery(input).map(parameter =>
    `${parameter.encodedName}=${parameter.encodedValue}`).join("&"));
  expect(Object.fromEntries(query)).toEqual({ provider: "openai", limit: "2", offset: "0" });
  for (const query of [
    { limit: 0 }, { limit: -1 }, { limit: 1.5 }, { limit: "2" },
    { offset: -1 }, { offset: 0.5 }, { ids: ["invented-filter"] },
  ]) expect(() => adapter.validate({ query })).toThrow();
});

test("a source-only path parameter remains required even without an OpenAPI schema", () => {
  const adapter = sourceRequestAdapter("GET /api/providers/{id}/cc-alias");
  expect(() => adapter.validate({})).toThrow();
  expect(() => adapter.validate({ path: { id: "" } })).toThrow();
  const input = adapter.validate({ path: { id: "provider-123" } });
  expect(adapter.buildPath(input)).toBe("/api/providers/provider-123/cc-alias");
});

test("source-bound preflight views remain valid when settlement is unknown", () => {
  const base = FALLBACK_CHAIN_SOURCE_CONTRACTS[FALLBACK_CHAIN_POST];
  if (!base.reconciliation) throw new Error("fallback source fixture has no preflight view");
  const observation = {
    name: "existing-chain",
    read: base.reconciliation.targetRead,
    readCompleteness: { kind: "single-response", sourceReason: "Pinned GET returns the complete runtime chain map." },
  };
  const safety = {
    preflight: { kind: "required", observations: [observation] },
    reconciliation: { kind: "unknown" },
    settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null },
  };
  const contract = { ...base, reconciliation: null, mutationSafety: safety };
  expect(operationEvidenceBinding(FALLBACK_CHAIN_POST, contract).mutationSafetySha256).toMatch(/^[a-f0-9]{64}$/);
  const wrongRead = { ...observation, read: { ...observation.read, operationId: "GET /api/health" } };
  expect(() => operationEvidenceBinding(FALLBACK_CHAIN_POST, {
    ...contract,
    mutationSafety: { ...safety, preflight: { ...safety.preflight, observations: [wrongRead] } },
  })).toThrow(/source relation preflight does not match/);
});

test("auxiliary input changes invalidate only consuming receipt cases", async () => {
  const directory = `test/.auxiliary-evidence-${crypto.randomUUID()}`;
  const root = resolve(import.meta.dir, "..");
  const consumer = `${directory}/consumer.ts`;
  const unrelated = `${directory}/unrelated.ts`;
  const input = `${directory}/driver.py`;
  const overlay = `${directory}/overlay.ts`;
  await mkdir(resolve(root, directory));
  try {
    await writeFile(resolve(root, consumer), "export const response = { status: 200 };\n");
    await writeFile(resolve(root, unrelated), "export const response = { status: 200 };\n");
    await writeFile(resolve(root, input), "print(200)\n");
    await writeFile(resolve(root, overlay), 'import { handler } from "@/upstream-only-owner"; export { handler };\n');
    await writeFile(resolve(root, `${consumer}.inputs.json`), JSON.stringify({ schemaVersion: 1, files: [input, overlay] }));
    const consumerBefore = testCaseSourceHash(consumer);
    const unrelatedBefore = testCaseSourceHash(unrelated);
    await writeFile(resolve(root, input), "# changed backend\nprint(200)\n");
    expect(testCaseSourceHash(consumer)).not.toBe(consumerBefore);
    expect(testCaseSourceHash(unrelated)).toBe(unrelatedBefore);
    for (const files of [[input, input], ["../outside.py"], [".agents/state/private.json"], [`${directory}/missing.py`]]) {
      await writeFile(resolve(root, `${consumer}.inputs.json`), JSON.stringify({ schemaVersion: 1, files }));
      expect(() => testCaseSourceHash(consumer)).toThrow(/auxiliary evidence/);
    }
  } finally {
    await rm(resolve(root, directory), { recursive: true, force: true });
  }
});

test("health ingress evidence separately rejects missing, stale and contradictory exports", async () => {
  const root = resolve(import.meta.dir, "..");
  const path = ".agents/state/omp-provider-release/qualification-observations/health-ingress.json";
  const absolute = resolve(root, path);
  const prior = await readFile(absolute).catch((error: unknown) => {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  });
  const declarationPath = "test/pinned-ingress.test.ts.inputs.json";
  const declaration = JSON.parse(await readFile(resolve(root, declarationPath), "utf8")) as { files: string[] };
  const paths = ["test/pinned-ingress.test.ts", declarationPath, ...declaration.files];
  const hashes = Object.fromEntries(await Promise.all(paths.map(async input => [input, createHash("sha256").update(await readFile(resolve(root, input))).digest("hex")] as const)));
  const source = JSON.parse(await readFile(resolve(root, "test/fixtures/pinned-ingress/source-manifest.json"), "utf8")) as { commit: string; archiveSha256: string };
  const runtime = JSON.parse(await readFile(resolve(root, "test/fixtures/pinned-ingress/runtime.json"), "utf8")) as { nodeSha256: string; nodeVersion: string };
  const binding = operationEvidenceBinding("GET /api/health", jsonHealthContract("GET /api/health"));
  const identities = expectedHealthIngressIdentities("3.8.53", source.commit);
  const added = record(identities.addedSourceSha256);
  const routeIdentity = record(added["src/app/api/health/degradation/route.ts"]);
  const domainIdentity = record(added["src/domain/degradation.ts"]);
  expect(routeIdentity.originalSha256).not.toBe(routeIdentity.executedSha256);
  expect(domainIdentity.originalSha256).toBe(domainIdentity.executedSha256);
  const artifact = {
    schemaVersion: 1, classification: "research-only-not-qualification",
    source: { version: "3.8.53", commit: source.commit, archiveSha256: source.archiveSha256, addedSourceSha256: identities.addedSourceSha256, pingDeclarationSha256: identities.pingDeclarationSha256, ...(identities.sourceDerivation === undefined ? {} : { sourceDerivation: identities.sourceDerivation, effectiveTreeSha256: identities.effectiveTreeSha256 }) },
    inputs: { sha256: hashes, nodeSha256: runtime.nodeSha256, runtime: { node: runtime.nodeVersion, next: "16.4.2", react: "19.2.8", "react-dom": "19.2.8" }, sourceOverlaySha256: identities.sourceOverlaySha256, executedOverlaySha256: identities.executedOverlaySha256 },
    isolation: { namespacesDistinct: true, memoryLimitEnforced: true, cpuLimitEnforced: true, privateLoopbackOnly: true, environmentAllowlisted: true },
    health: [{ method: "GET", path: "/api/health", status: 200, bodyKeys: ["status", "timestamp"], timestamp: "2026-01-01T00:00:00.000Z", cacheControl: "no-store" }],
    publicHealthHttp: { method: "GET", path: "/api/health", anonymous: true, status: 200, bodyKeys: ["status", "timestamp"], timestampFormatAndRequestWindowValid: true, cacheControl: "no-store, no-cache, must-revalidate", contentType: "application/json", routeClass: "PUBLIC", requestIdUuid: true, drain: { status: 503, code: "SERVICE_UNAVAILABLE", message: "Server is shutting down", requestIdUuid: true, correlationMatchesRequestId: true, retryAfter: "5", contentType: "application/json", routeClass: "PUBLIC", recoveryStatus: 200 }, cors: { configuredAllowedOrigin: "https://allowed.example", allowedOriginEchoed: true, unlistedOriginOmitted: true, credentialsOmitted: true } },
    sharedAuthentication: ["source-default", "disabled"].map((bypass, index) => ({ name: index === 0 ? "default-bypass-health" : "disabled-bypass-health", input: { method: "GET", path: "/api/health", bypass, credential: "none", requireLogin: true, setupComplete: true }, observed: { status: 200, routeClass: "PUBLIC", successMarkerPresent: true, usageStampObserved: false } })),
    publicHealthIpFilter: { enabled: true, mode: "blacklist", configReadObserved: true, forwardedAddressFallback: { deniedStatus: 403, error: "IP blacklisted", recoveryStatus: 200, routeClass: "PUBLIC", requestIdUuid: true, allowedOriginEchoed: true } },
  };
  const save = async (value: unknown) => {
    const bytes = Buffer.from(JSON.stringify(value));
    await mkdir(resolve(root, ".agents/state/omp-provider-release/qualification-observations"), { recursive: true, mode: 0o700 });
    await writeFile(absolute, bytes, { mode: 0o600 });
    return { artifact: path, sha256: createHash("sha256").update(bytes).digest("hex") };
  };
  try {
    expect(() => validateHealthIngressEvidence(undefined, binding)).toThrow(/ingress evidence/);
    await rm(absolute, { force: true });
    expect(() => validateHealthIngressEvidence({ artifact: path, sha256: "0".repeat(64) }, binding)).toThrow();
    const valid = await save(artifact);
    expect(() => validateHealthIngressEvidence(valid, binding)).not.toThrow();
    const statusCodes: Record<string, number> = { anonymous: 401, invalid: 403, session: 200, "key-read": 403, "key-write": 403, "key-admin": 200, "key-manage": 200, "oma-read": 200, "oma-write": 200, "oma-admin": 200 };
    const statusHttp = { matcherMatched: true, cases: Object.fromEntries(Object.entries(statusCodes).map(([name, status]) => [name, { status, routeClass: "MANAGEMENT", disabled: status === 200 ? true : null }])), enabled: { status: 200, routeClass: "MANAGEMENT", enabled: true, agentName: "OmniRoute AI Gateway", streaming: true, skillCount: 6 }, failure: { status: 500, routeClass: "MANAGEMENT", rawErrorPresent: true } };
    const allIds = ["five", "four", "three", "two", "one"];
    const historyAuth = { anonymous: [401, null], invalid: [403, null], inference: [403, null], session: [200, allIds], oma: [200, allIds], manage: [200, ["five", "four", "two", "one"]], admin: [200, ["five", "three", "one"]] } as const;
    const historyPages = [[["five", "four"], 5, 2, 0], [["three", "two"], 5, 2, 2], [["one"], 5, 2, 4], [[], 5, 2, 8], [allIds, 5, 500, 0], [["four"], 1, 100, 0]] as const;
    const historyHttp = { auth: Object.fromEntries(Object.entries(historyAuth).map(([name, [status, ids]]) => [name, { status, routeClass: "MANAGEMENT", ids }])), pages: historyPages.map(([ids, total, limit, offset]) => ({ status: 200, ids, total, limit, offset })), invalid: [400, 400, 400, 400, 400], failure: { status: 500, routeClass: "MANAGEMENT", hasTasks: false } };
    const a2aArtifact = { ...artifact, a2aStatusHttp: statusHttp, a2aStatusClosure: identities.a2aStatusClosure, a2aHistoryHttp: historyHttp };
    for (const [operation, handlerSha256, handlerGitBlobSha] of [
      ["GET /api/a2a/status", "d230afbd417035cd919d25853cf03e165392f83b1774739b780dd0000c8f6dc2", "4072255a115bd068918763682203c8f909d986df"],
      ["GET /api/a2a/tasks/history", "0c35eb4cffe05b36d66d725049e354fd70bab29e2fade1346760bf80c5e85d01", "1b93277bd5560075f14b6453458445ea3ade6daa"],
    ] as const) {
      const a2aBinding = { ...binding, handlerSha256, handlerGitBlobSha };
      const complete = await save(a2aArtifact);
      expect(() => validateHealthIngressEvidence(complete, a2aBinding, operation)).not.toThrow();
      const missingAdded = { ...added };
      delete missingAdded["src/lib/db/a2aTasks.ts"];
      const missing = await save({ ...a2aArtifact, source: { ...artifact.source, addedSourceSha256: missingAdded } });
      expect(() => validateHealthIngressEvidence(missing, a2aBinding, operation)).toThrow(/source mismatch|source identity mismatch/);
    }
    await save(artifact);
    const degradationBinding = operationEvidenceBinding("GET /api/health/degradation", degradationContract());
    const staleIngressSha256 = "a890aefa50060b86b08ebf10af8ab685140c7dcd6737925c99a4a265d9040109";
    expect(() => validateHealthIngressEvidence({ artifact: `provenance/qualification/ingress-${staleIngressSha256}.json`, sha256: staleIngressSha256 }, degradationBinding, "GET /api/health/degradation")).toThrow(/input drift|source identity mismatch|declared inputs mismatch/);
    // Synthetic observations exercise validation only; they are not retained evidence.
    const pingRow = { method: "GET", path: "/api/health/ping", status: 200, bodyKeys: ["latencyMs", "status", "timestamp"], timestamp: "2026-01-01T00:00:00.000Z", cacheControl: "no-store", latencyMs: 1 };
    const pingBinding = { ...binding, handlerSha256: String(added["src/app/api/health/ping/route.ts"]) };
    const pingArtifact = { ...artifact, health: [...artifact.health, pingRow] };
    expect(() => validateHealthIngressEvidence(valid, pingBinding, "GET /api/health/ping")).toThrow(/ping observation/);
    const pingEvidence = await save(pingArtifact);
    expect(() => validateHealthIngressEvidence(pingEvidence, pingBinding, "GET /api/health/ping")).not.toThrow();
    expect(() => validateHealthIngressEvidence(pingEvidence, { ...pingBinding, handlerSha256: "0".repeat(64) }, "GET /api/health/ping")).toThrow(/source mismatch/);
    for (const rows of [[pingRow, pingRow], [{ ...pingRow, method: "POST" }], [{ ...pingRow, latencyMs: -1 }], [{ ...pingRow, status: 503 }], [{ ...pingRow, cacheControl: "public" }], [{ ...pingRow, bodyKeys: ["status"] }]]) {
      const evidence = await save({ ...artifact, health: [...artifact.health, ...rows] });
      expect(() => validateHealthIngressEvidence(evidence, pingBinding, "GET /api/health/ping")).toThrow(/ping observation/);
    }
    const values = { totalRequests: 3, requestsWithCacheControl: 2, totalInputTokens: 300, totalCachedTokens: 150, totalCacheCreationTokens: 10, alphaRequests: 2, directCachedTokens: 50 };
    const cacheRow = (method: string) => ({ method, path: "/api/settings/cache-metrics", unauthenticatedStatus: 401, invalidTokenStatus: 401, sessionStatus: 200, selectedValues: values, usageRowsAfter: 3 });
    const missingUsageHistory = { status: 200, totalRequests: 0, totalCachedTokens: 0, providerCount: 0 };
    const cacheBinding = { ...binding, handlerSha256: String(added["src/app/api/settings/cache-metrics/route.ts"]) };
    for (const method of ["GET", "DELETE"]) {
      const id = `${method} /api/settings/cache-metrics`;
      const row = cacheRow(method);
      const cacheArtifact = { ...artifact, cacheMetrics: [row], missingUsageHistory };
      const cacheEvidence = await save(cacheArtifact);
      expect(() => validateHealthIngressEvidence(cacheEvidence, cacheBinding, id)).not.toThrow();
      expect(() => validateHealthIngressEvidence(cacheEvidence, { ...cacheBinding, handlerSha256: "0".repeat(64) }, id)).toThrow(/source mismatch/);
      for (const rows of [[], [row, row], [{ ...row, method: method === "GET" ? "DELETE" : "GET" }], [{ ...row, sessionStatus: 401 }], [{ ...row, selectedValues: { ...values, totalRequests: 2 } }]]) {
        const evidence = await save({ ...cacheArtifact, cacheMetrics: rows });
        expect(() => validateHealthIngressEvidence(evidence, cacheBinding, id)).toThrow(/cache metrics observation/);
      }
      if (method === "GET") {
        const evidence = await save({ ...cacheArtifact, missingUsageHistory: { ...missingUsageHistory, totalRequests: 1 } });
        expect(() => validateHealthIngressEvidence(evidence, cacheBinding, id)).toThrow(/missing usage history observation/);
      }
    }
    const livenessRoute = record(added["src/app/livez/route.ts"]);
    const livenessBinding = { ...binding, handlerSha256: String(livenessRoute.originalSha256) };
    const livenessResponse = { status: 200, body: "ok\n", contentType: "text/plain; charset=utf-8", cacheControl: "no-store", contentLength: "3", routeClass: null };
    const liveness = { ...artifact, publicLivenessHttp: { method: "GET", path: "/livez", matcher: "not-matched", proxyIdentity: { originalSha256: added["src/proxy.ts"], executedSha256: added["src/proxy.ts"] }, cases: { anonymous: { ...livenessResponse }, invalidCredential: { ...livenessResponse }, session: { ...livenessResponse } } } };
    const livenessEvidence = await save(liveness);
    expect(() => validateHealthIngressEvidence(livenessEvidence, livenessBinding, "GET /livez")).not.toThrow();
    expect(() => validateHealthIngressEvidence(livenessEvidence, { ...livenessBinding, handlerSha256: "0".repeat(64) }, "GET /livez")).toThrow(/source mismatch/);
    expect(() => validateHealthIngressEvidence(livenessEvidence, livenessBinding, "HEAD /livez")).toThrow(/liveness HEAD observation mismatch/);
    const headResponse = { ...livenessResponse, body: "" };
    const head = { ...liveness, publicLivenessHeadHttp: { ...liveness.publicLivenessHttp, method: "HEAD", cases: { anonymous: { ...headResponse }, invalidCredential: { ...headResponse }, session: { ...headResponse } } } };
    const headEvidence = await save(head);
    expect(() => validateHealthIngressEvidence(headEvidence, livenessBinding, "HEAD /livez")).not.toThrow();
    expect(() => validateHealthIngressEvidence(headEvidence, { ...livenessBinding, handlerSha256: "0".repeat(64) }, "HEAD /livez")).toThrow(/source mismatch/);
    for (const condition of ["anonymous", "invalidCredential", "session"] as const) {
      const changed = structuredClone(head);
      changed.publicLivenessHeadHttp.cases[condition].body = "ok\n";
      const evidence = await save(changed);
      expect(() => validateHealthIngressEvidence(evidence, livenessBinding, "HEAD /livez")).toThrow(/liveness HEAD observation mismatch/);
    }
    const wrongHead = structuredClone(head);
    wrongHead.publicLivenessHeadHttp.method = "GET";
    const wrongHeadEvidence = await save(wrongHead);
    expect(() => validateHealthIngressEvidence(wrongHeadEvidence, livenessBinding, "HEAD /livez")).toThrow(/liveness HEAD observation mismatch/);
    for (const key of ["originalSha256", "executedSha256"] as const) {
      const changed = structuredClone(liveness);
      record(record(changed.source.addedSourceSha256)["src/app/livez/route.ts"])[key] = "0".repeat(64);
      const evidence = await save(changed);
      expect(() => validateHealthIngressEvidence(evidence, livenessBinding, "GET /livez")).toThrow(/source mismatch/);
    }
    const wrongProxy = structuredClone(liveness);
    record(wrongProxy.source.addedSourceSha256)["src/proxy.ts"] = "0".repeat(64);
    wrongProxy.publicLivenessHttp.proxyIdentity = { originalSha256: "0".repeat(64), executedSha256: "0".repeat(64) };
    const wrongProxyEvidence = await save(wrongProxy);
    expect(() => validateHealthIngressEvidence(wrongProxyEvidence, livenessBinding, "GET /livez")).toThrow(/source identity mismatch/);
    for (const key of ["originalSha256", "executedSha256"] as const) {
      const changed = structuredClone(liveness);
      changed.publicLivenessHttp.proxyIdentity[key] = "0".repeat(64);
      const evidence = await save(changed);
      expect(() => validateHealthIngressEvidence(evidence, livenessBinding, "GET /livez")).toThrow(/liveness observation mismatch/);
    }
    for (const [key, value] of [["method", "POST"], ["path", "/api/health"], ["matcher", "matched"], ["cases", {}]] as const) {
      const changed = structuredClone(liveness);
      record(changed.publicLivenessHttp)[key] = value;
      const evidence = await save(changed);
      expect(() => validateHealthIngressEvidence(evidence, livenessBinding, "GET /livez")).toThrow(/liveness observation mismatch/);
    }
    for (const condition of ["anonymous", "invalidCredential", "session"] as const) {
      for (const [key, value] of [["status", 401], ["body", "ok"], ["contentType", "application/json"], ["cacheControl", "public"], ["contentLength", "2"], ["routeClass", "PUBLIC"]] as const) {
        const changed = structuredClone(liveness);
        record(changed.publicLivenessHttp.cases[condition])[key] = value;
        const evidence = await save(changed);
        expect(() => validateHealthIngressEvidence(evidence, livenessBinding, "GET /livez")).toThrow(/liveness observation mismatch/);
      }
      const missing = structuredClone(liveness);
      delete record(missing.publicLivenessHttp.cases)[condition];
      const evidence = await save(missing);
      expect(() => validateHealthIngressEvidence(evidence, livenessBinding, "GET /livez")).toThrow(/liveness observation mismatch/);
    }
    const extraCase = structuredClone(liveness);
    record(extraCase.publicLivenessHttp.cases).extra = livenessResponse;
    const extraEvidence = await save(extraCase);
    expect(() => validateHealthIngressEvidence(extraEvidence, livenessBinding, "GET /livez")).toThrow(/liveness observation mismatch/);
    const hosted = { ...artifact, degradation: { method: "GET", path: "/api/health/degradation", routeClass: "MANAGEMENT", anonymousStatus: 401, invalidCredentialStatus: 401, empty: { status: 200, summary: { full: 0, reduced: 0, minimal: 0, default: 0 } }, populated: { status: 200, summary: { full: 1, reduced: 1, minimal: 0, default: 1 }, levels: ["default", "reduced", "full"] }, summaryTrue: { status: 200, bodyKeys: ["isDegraded", "summary"] }, summaryFalseAndCapitalTrueReturnFullReport: true, recovery: { status: 200, summary: { full: 3, reduced: 0, minimal: 0, default: 0 }, active: false }, handlerFailure: "unobserved" } };
    const hostedEvidence = await save(hosted);
    expect(() => validateHealthIngressEvidence(hostedEvidence, degradationBinding, "GET /api/health/degradation")).not.toThrow();
    expect(() => validateHealthIngressEvidence(hostedEvidence, { ...degradationBinding, handlerSha256: "0".repeat(64) }, "GET /api/health/degradation")).toThrow(/source mismatch/);
    for (const [key, value] of [["anonymousStatus", 200], ["invalidCredentialStatus", 200], ["summaryFalseAndCapitalTrueReturnFullReport", false], ["handlerFailure", "observed"]] as const) {
      const changed = structuredClone(hosted);
      record(changed.degradation)[key] = value;
      const changedEvidence = await save(changed);
      expect(() => validateHealthIngressEvidence(changedEvidence, degradationBinding, "GET /api/health/degradation")).toThrow(/degradation observation mismatch/);
    }
    const skillsBinding = operationEvidenceBinding("GET /api/agent-skills", agentSkillsContract());
    const skillsArtifact = { ...artifact, agentSkills: { method: "GET", path: "/api/agent-skills", routeClass: "MANAGEMENT", anonymousStatus: 401, invalidCredentialStatus: 401, query: "category=config&area=config-codex-cli", authorizedStatus: 200, ids: ["config-codex-cli"] } };
    const skillsEvidence = await save(skillsArtifact);
    expect(() => validateHealthIngressEvidence(skillsEvidence, skillsBinding, "GET /api/agent-skills")).not.toThrow();
    expect(() => validateHealthIngressEvidence(skillsEvidence, { ...skillsBinding, handlerSha256: "0".repeat(64) }, "GET /api/agent-skills")).toThrow(/source mismatch/);
    for (const [key, value] of [["anonymousStatus", 200], ["invalidCredentialStatus", 200], ["authorizedStatus", 403], ["routeClass", "PUBLIC"], ["ids", []]] as const) {
      const changed = structuredClone(skillsArtifact);
      record(changed.agentSkills)[key] = value;
      const evidence = await save(changed);
      expect(() => validateHealthIngressEvidence(evidence, skillsBinding, "GET /api/agent-skills")).toThrow(/agent-skills observation mismatch/);
    }
    const agentSkillsReads = ["/api/agent-skills/config-codex-cli", "/api/agent-skills/coverage"].map(path => ({ method: "GET", path, routeClass: "MANAGEMENT", anonymousStatus: 401, invalidCredentialStatus: 401, authorizedStatus: 200 }));
    for (const [index, operationId] of [SKILLS_DETAIL_ID, SKILLS_COVERAGE_ID].entries()) {
      const readBinding = operationEvidenceBinding(operationId, agentSkillsReadContract(operationId));
      const readArtifact = { ...artifact, agentSkillsReads };
      const readEvidence = await save(readArtifact);
      expect(() => validateHealthIngressEvidence(readEvidence, readBinding, operationId)).not.toThrow();
      const changed = structuredClone(readArtifact);
      changed.agentSkillsReads[index]!.path += "/wrong";
      const badEvidence = await save(changed);
      expect(() => validateHealthIngressEvidence(badEvidence, readBinding, operationId)).toThrow(/agent-skills read observation mismatch/);
    }
    const mappingPolicy = MODEL_COMBO_MAPPING_OPERATION_IDS.map(operationId => {
      const [method, template] = operationId.split(" ");
      return { method, path: template!.replace("{id}", "fixture-id"), routeClass: "MANAGEMENT", anonymousStatus: 401, invalidCredentialStatus: 401, authorizedStatus: 200 };
    });
    for (const [index, operationId] of MODEL_COMBO_MAPPING_OPERATION_IDS.entries()) {
      const mappingBinding = operationEvidenceBinding(operationId, MODEL_COMBO_MAPPING_SOURCE_CONTRACTS[operationId]);
      const mappingArtifact = { ...artifact, modelComboMappingPolicy: mappingPolicy };
      const evidence = await save(mappingArtifact);
      expect(() => validateHealthIngressEvidence(evidence, mappingBinding, operationId)).not.toThrow();
      expect(() => validateHealthIngressEvidence(evidence, { ...mappingBinding, handlerSha256: "0".repeat(64) }, operationId)).toThrow(/source mismatch/);
      for (const [key, value] of [["anonymousStatus", 200], ["invalidCredentialStatus", 200], ["authorizedStatus", 403], ["routeClass", "PUBLIC"], ["path", "/api/wrong"], ["method", "PATCH"]] as const) {
        const changed = structuredClone(mappingArtifact);
        record(changed.modelComboMappingPolicy[index])[key] = value;
        const changedEvidence = await save(changed);
        expect(() => validateHealthIngressEvidence(changedEvidence, mappingBinding, operationId)).toThrow(/mapping policy observation mismatch/);
      }
      const duplicated = { ...mappingArtifact, modelComboMappingPolicy: [...mappingPolicy, mappingPolicy[index]] };
      const duplicateEvidence = await save(duplicated);
      expect(() => validateHealthIngressEvidence(duplicateEvidence, mappingBinding, operationId)).toThrow(/mapping policy observation mismatch/);
    }
    // The complete metrics HTTP witness is exercised in pinned-ingress.test.ts.
    // These rejections occur before, or at, that specialized observation boundary.
    const metricsBinding = { ...binding, handlerSha256: "e4757286e25c18ad075c5b948bb27cf1e7e3fcb2d01d8053c7d893af9a190416", handlerGitBlobSha: "9266bfc7ba5444f3b8685775d10ad72210050634" };
    for (const method of ["GET", "DELETE"] as const) {
      const operationId = `${method} /api/combos/metrics`;
      const policy = { method, path: "/api/combos/metrics", routeClass: "MANAGEMENT", anonymousStatus: 401, invalidCredentialStatus: 401, authorizedStatus: 200, readScopeStatus: method === "GET" ? 200 : 403, writeScopeStatus: 200, adminScopeStatus: 200 };
      const metricsArtifact = { ...artifact, familyPolicy: [policy] };
      const evidence = await save(metricsArtifact);
      expect(() => validateHealthIngressEvidence(evidence, { ...metricsBinding, handlerSha256: "0".repeat(64) }, operationId)).toThrow(/combo metrics source mismatch/);
      expect(() => validateHealthIngressEvidence(evidence, { ...metricsBinding, handlerGitBlobSha: "0".repeat(40) }, operationId)).toThrow(/combo metrics source mismatch/);
      expect(() => validateHealthIngressEvidence(evidence, metricsBinding, operationId)).toThrow();
      const wrongHttp = await save({ ...metricsArtifact, comboMetricsHttp: {} });
      expect(() => validateHealthIngressEvidence(wrongHttp, metricsBinding, operationId)).toThrow(/combo metrics HTTP mismatch/);
      for (const [key, value] of [["anonymousStatus", 200], ["invalidCredentialStatus", 200], ["authorizedStatus", 403], ["readScopeStatus", 401], ["writeScopeStatus", 401], ["adminScopeStatus", 403], ["routeClass", "PUBLIC"], ["path", "/api/wrong"], ["method", "OPTIONS"]] as const) {
        const changed = await save({ ...metricsArtifact, familyPolicy: [{ ...policy, [key]: value }] });
        expect(() => validateHealthIngressEvidence(changed, metricsBinding, operationId)).toThrow(/family policy observation mismatch/);
      }
      for (const familyPolicy of [[], [policy, policy]]) {
        const changed = await save({ ...metricsArtifact, familyPolicy });
        expect(() => validateHealthIngressEvidence(changed, metricsBinding, operationId)).toThrow(/family policy observation mismatch/);
      }
    }
    // Combo metrics uses the source-bound HTTP witness in pinned-ingress.test.ts,
    // not this generic family-policy-only fixture.
    const familyRoutes = [
      ["GET /api/combos", "src/app/api/combos/route.ts"],
      ["GET /api/combos/{id}", "src/app/api/combos/[id]/route.ts"],
      ["GET /api/combos/auto", "src/app/api/combos/auto/route.ts"],
      ["GET /api/combos/builder/options", "src/app/api/combos/builder/options/route.ts"],
      ["POST /api/combos/import", "src/app/api/combos/import/route.ts"],
      ["GET /api/combos/export", "src/app/api/combos/export/route.ts"],
      ["GET /api/providers", "src/app/api/providers/route.ts"],
      ["POST /api/providers", "src/app/api/providers/route.ts"],
      ["PATCH /api/providers", "src/app/api/providers/route.ts"],
      ["DELETE /api/providers", "src/app/api/providers/route.ts"],
      ["PUT /api/providers/{id}/cc-alias", "src/app/api/providers/[id]/cc-alias/route.ts"],
      ["POST /api/provider-nodes", "src/app/api/provider-nodes/route.ts"],
      ["PUT /api/providers/{id}/interception-rules", "src/app/api/providers/[id]/interception-rules/route.ts"],
      ["DELETE /api/providers/{id}/param-filters", "src/app/api/providers/[id]/param-filters/route.ts"],
      ["PATCH /api/model-capability-overrides", "src/app/api/model-capability-overrides/route.ts"],
      ["POST /api/fallback/chains", "src/app/api/fallback/chains/route.ts"],
      ["GET /api/settings/reasoning-routing-rules", "src/app/api/settings/reasoning-routing-rules/route.ts"],
    ] as const;
    const familyPolicy = familyRoutes.map(([operationId]) => {
      const [method, template] = operationId.split(" ");
      const path = template!.replace("{id}", "fixture-id");
      const mutation = method !== "GET";
      const adminRequired = mutation && (path === "/api/providers" || path.startsWith("/api/providers/"));
      return { method, path, routeClass: "MANAGEMENT", anonymousStatus: 401, invalidCredentialStatus: 401, authorizedStatus: 200, readScopeStatus: mutation ? 403 : 200, writeScopeStatus: adminRequired ? 403 : 200, adminScopeStatus: 200 };
    });
    const reasoningHttp = { method: "GET", path: "/api/settings/reasoning-routing-rules", denied: { status: 401, routeClass: "MANAGEMENT" }, invalid: { status: 401, routeClass: "MANAGEMENT" }, failure: { status: 500, routeClass: "MANAGEMENT", contentType: null, bodyCategory: "empty", privateMarkerPresent: false }, allowed: { status: 200, routeClass: "MANAGEMENT", body: { rules: [] } }, cached: { status: 200, routeClass: "MANAGEMENT", body: { rules: [] } }, sqliteReadCount: 2, sqliteFaultCount: 1 };
    for (const [index, [operationId, route]] of familyRoutes.entries()) {
      const reasoning = operationId === REASONING_RULES_GET_ID;
      const familyBinding = { ...binding, handlerSha256: reasoning ? String(record(added[route]).originalSha256) : String(added[route]), ...(reasoning ? { handlerGitBlobSha: "fd13070fad4b50034e2019cd1d75058d871f93cf" } : {}) };
      const familyArtifact = { ...artifact, familyPolicy, ...(reasoning ? { reasoningHttp } : {}) };
      const evidence = await save(familyArtifact);
      expect(() => validateHealthIngressEvidence(evidence, familyBinding, operationId)).not.toThrow();
      expect(() => validateHealthIngressEvidence(evidence, { ...familyBinding, handlerSha256: "0".repeat(64) }, operationId)).toThrow(/source mismatch/);
      for (const [key, value] of [["anonymousStatus", 200], ["invalidCredentialStatus", 200], ["authorizedStatus", 403], ["readScopeStatus", 401], ["writeScopeStatus", 401], ["adminScopeStatus", 403], ["routeClass", "PUBLIC"], ["path", "/api/wrong"], ["method", "OPTIONS"]] as const) {
        const changed = structuredClone(familyArtifact);
        record(changed.familyPolicy[index])[key] = value;
        const changedEvidence = await save(changed);
        expect(() => validateHealthIngressEvidence(changedEvidence, familyBinding, operationId)).toThrow(/family policy observation mismatch/);
      }
      const duplicateEvidence = await save({ ...familyArtifact, familyPolicy: [...familyPolicy, familyPolicy[index]] });
      expect(() => validateHealthIngressEvidence(duplicateEvidence, familyBinding, operationId)).toThrow(/family policy observation mismatch/);
      const missingEvidence = await save({ ...familyArtifact, familyPolicy: familyPolicy.filter((_, item) => item !== index) });
      expect(() => validateHealthIngressEvidence(missingEvidence, familyBinding, operationId)).toThrow(/family policy observation mismatch/);
      if (reasoning) {
        const missingHttp = await save({ ...familyArtifact, reasoningHttp: undefined });
        expect(() => validateHealthIngressEvidence(missingHttp, familyBinding, operationId)).toThrow(/reasoning HTTP observation mismatch/);
        const malformedHttp = await save({ ...familyArtifact, reasoningHttp: { ...reasoningHttp, failure: { ...reasoningHttp.failure, status: 503 } } });
        expect(() => validateHealthIngressEvidence(malformedHttp, familyBinding, operationId)).toThrow(/reasoning HTTP observation mismatch/);
      }
    }
    // Synthetic values exercise the guard, not the independent producer.
    const acpId = "GET /api/acp/agents";
    const acpBinding = { ...binding, handlerSha256: String(added["src/app/api/acp/agents/route.ts"]), handlerGitBlobSha: "1aa6c1a3305aab27f6e011defda696cab62a945e" };
    const acpStatuses: Record<string, number> = { anonymous: 401, invalid: 403, session: 200, "key-read": 403, "key-write": 403, "key-admin": 200, "key-manage": 200, "oma-read": 401, "oma-write": 401, "oma-admin": 401 };
    const acpCases = Object.fromEntries(Object.entries(acpStatuses).map(([name, status]) => [name, { status, routeClass: "MANAGEMENT", owned: status === 200 ? { installed: true, version: "7.8.9" } : null }]));
    const acpArtifact = { ...artifact, acpAgentsHttp: { cases: acpCases, unstampedSessionStatus: 403, probeCount: 3, processPlatform: "linux" } };
    const acpEvidence = await save(acpArtifact);
    expect(() => validateHealthIngressEvidence(acpEvidence, acpBinding, acpId)).not.toThrow();
    expect(() => validateHealthIngressEvidence(acpEvidence, { ...acpBinding, handlerGitBlobSha: "0".repeat(40) }, acpId)).toThrow(/ACP source mismatch/);
    for (const key of Object.keys(acpStatuses)) {
      const changed = structuredClone(acpArtifact);
      delete changed.acpAgentsHttp.cases[key];
      const evidence = await save(changed);
      expect(() => validateHealthIngressEvidence(evidence, acpBinding, acpId)).toThrow(/ACP HTTP observation mismatch/);
    }
    for (const [key, value] of [["unstampedSessionStatus", 200], ["probeCount", 4], ["processPlatform", "win32"]] as const) {
      const changed = structuredClone(acpArtifact);
      record(changed.acpAgentsHttp)[key] = value;
      const evidence = await save(changed);
      expect(() => validateHealthIngressEvidence(evidence, acpBinding, acpId)).toThrow(/ACP HTTP observation mismatch/);
    }
    for (const key of ["originalSha256", "executedSha256", "processBoundarySha256", "ownedProbeSha256"]) {
      const changed = structuredClone(acpArtifact);
      record(record(changed.source.addedSourceSha256)["src/lib/acp/registry.ts"])[key] = "0".repeat(64);
      const evidence = await save(changed);
      expect(() => validateHealthIngressEvidence(evidence, acpBinding, acpId)).toThrow(/source identity mismatch/);
    }
    for (const name of ["src/server/authz/routeGuard.ts", "src/shared/utils/apiAuth.ts", "src/server/authz/peerStamp.ts"]) {
      const changed = structuredClone(acpArtifact);
      record(changed.source.addedSourceSha256)[name] = "0".repeat(64);
      const evidence = await save(changed);
      expect(() => validateHealthIngressEvidence(evidence, acpBinding, acpId)).toThrow(/source identity mismatch/);
    }
    await save(artifact);
    // Cached expectations must not be mutable by callers, and changed transformation
    // bytes must force a new verification rather than reuse the prior derivation.
    const exposed = expectedHealthIngressIdentities("3.8.53", source.commit);
    record(exposed.addedSourceSha256)["src/proxy.ts"] = "0".repeat(64);
    expect(() => validateHealthIngressEvidence(valid, binding)).not.toThrow();
    const isolatedRoot = await mkdtemp(join(tmpdir(), "ingress-derivation-"));
    try {
      for (const directory of ["scripts", "src", "test", "provenance", ".github"]) {
        await cp(resolve(root, directory), join(isolatedRoot, directory), { recursive: true });
      }
      await symlink(resolve(root, "node_modules"), join(isolatedRoot, "node_modules"), "junction");
      const archive = `.agents/state/omp-provider-release/upstream/omniroute-v3.8.53-${source.commit}.tar.gz`;
      await mkdir(resolve(isolatedRoot, archive, ".."), { recursive: true });
      await copyFile(resolve(root, archive), resolve(isolatedRoot, archive));
      // A separate process resolves the static import from the disposable root;
      // the parent test's evidence closure remains statically bindable.
      const program = `
        import assert from "node:assert/strict";
        import { readFile, writeFile, stat, utimes } from "node:fs/promises";
        import { execFileSync } from "node:child_process";
        import { resolve } from "node:path";
        import { expectedHealthIngressIdentities } from "./scripts/generate-contracts.ts";
        const commit = process.argv[1];
        const original = expectedHealthIngressIdentities("3.8.53", commit);
        const overlay = resolve("test/fixtures/pinned-ingress/backend/core.ts");
        const originalOverlay = await readFile(overlay);
        await writeFile(overlay, Buffer.concat([originalOverlay, Buffer.from("\\n")]));
        assert.throws(() => expectedHealthIngressIdentities("3.8.53", commit));
        await writeFile(overlay, originalOverlay);
        const runner = resolve("scripts/pinned-ingress.py");
        const bytes = await readFile(runner);
        const info = await stat(runner);
        execFileSync("python3", ["-m", "py_compile", runner], {
          env: { ...process.env, PYTHONPYCACHEPREFIX: resolve("pycache") },
        });
        const text = bytes.toString("utf8");
        const changed = Buffer.from(text.replace('sqlite ??= new DatabaseSync("/work/data/metrics.sqlite")', 'sqlite ??= new DatabaseSync("/work/data/metrics.sqlitf")'));
        assert.equal(changed.length, bytes.length);
        await writeFile(runner, changed);
        await utimes(runner, info.atime, info.mtime);
        const after = expectedHealthIngressIdentities("3.8.53", commit);
        assert.notEqual(after.executedOverlaySha256["backend/core.ts"], original.executedOverlaySha256["backend/core.ts"]);
      `;
      execFileSync(process.execPath, ["-e", program, source.commit], { cwd: isolatedRoot, timeout: 120_000 });
    } finally {
      await rm(isolatedRoot, { recursive: true, force: true });
    }
    expect(() => validateHealthIngressEvidence(valid, binding)).not.toThrow();
    expect(() => validateHealthIngressEvidence({ ...valid, sha256: "0".repeat(64) }, binding)).toThrow(/digest mismatch/);
    expect(() => validateHealthIngressEvidence(valid, { ...binding, handlerSha256: "0".repeat(64) })).toThrow(/source mismatch/);
    const stale = structuredClone(artifact);
    stale.inputs.sha256[paths[0]!] = "0".repeat(64);
    const staleEvidence = await save(stale);
    expect(() => validateHealthIngressEvidence(staleEvidence, binding)).toThrow(/input drift/);
    const missing = structuredClone(artifact);
    delete missing.inputs.sha256[paths[0]!];
    const missingEvidence = await save(missing);
    expect(() => validateHealthIngressEvidence(missingEvidence, binding)).toThrow(/declared inputs mismatch/);
    const denied = structuredClone(artifact);
    denied.publicHealthHttp.anonymous = false;
    const deniedEvidence = await save(denied);
    expect(() => validateHealthIngressEvidence(deniedEvidence, binding)).toThrow(/public HTTP observation mismatch/);
    for (const key of ["addedSourceSha256", "pingDeclarationSha256"] as const) {
      const changed = structuredClone(artifact);
      if (key === "addedSourceSha256") record(changed.source.addedSourceSha256)["src/proxy.ts"] = "0".repeat(64);
      else changed.source.pingDeclarationSha256 = "0".repeat(64);
      const evidence = await save(changed);
      expect(() => validateHealthIngressEvidence(evidence, binding)).toThrow(/source identity mismatch/);
    }
    for (const key of ["sourceOverlaySha256", "executedOverlaySha256"] as const) {
      const changed = structuredClone(artifact);
      changed.inputs[key] = {};
      const evidence = await save(changed);
      expect(() => validateHealthIngressEvidence(evidence, binding)).toThrow(/overlay identity mismatch/);
    }
    for (const change of ["missing", "duplicate", "contradictory"] as const) {
      const changed = structuredClone(artifact);
      if (change === "missing") changed.sharedAuthentication.pop();
      if (change === "duplicate") changed.sharedAuthentication.push(structuredClone(changed.sharedAuthentication[0]!));
      if (change === "contradictory") changed.sharedAuthentication[1]!.observed.status = 403;
      const evidence = await save(changed);
      expect(() => validateHealthIngressEvidence(evidence, binding)).toThrow(/authentication observation mismatch/);
    }
    for (const change of ["missing", "configuration", "recovery", "requestId", "cors"] as const) {
      const changed: Record<string, unknown> = structuredClone(artifact);
      if (change === "missing") delete changed.publicHealthIpFilter;
      else {
        const filter = record(changed.publicHealthIpFilter);
        if (change === "configuration") filter.configReadObserved = false;
        else {
          const fallback = record(filter.forwardedAddressFallback);
          if (change === "recovery") fallback.recoveryStatus = 403;
          if (change === "requestId") fallback.requestIdUuid = false;
          if (change === "cors") fallback.allowedOriginEchoed = false;
        }
      }
      const evidence = await save(changed);
      expect(() => validateHealthIngressEvidence(evidence, binding)).toThrow();
    }
  } finally {
    if (prior === undefined) await rm(absolute, { force: true });
    else await writeFile(absolute, prior, { mode: 0o600 });
  }
}, 180_000);
