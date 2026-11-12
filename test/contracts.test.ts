import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
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
  validateHealthIngressEvidence,
} from "../scripts/generate-contracts.ts";
import { decodeRouteSources } from "../scripts/route-source-store.ts";
import { getOperation, projectResponse, type OperationDescriptor } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { FALLBACK_CHAIN_POST, FALLBACK_CHAIN_SOURCE_CONTRACTS } from "./fixtures/fallback-chains.fixture.ts";
import { jsonHealthContract } from "./fixtures/pinned-health.fixture.ts";
import { degradationContract } from "./fixtures/pinned-degradation.fixture.ts";
import { agentSkillsContract, agentSkillsReadContract, SKILLS_DETAIL_ID, SKILLS_COVERAGE_ID } from "./fixtures/pinned-agent-skills.fixture.ts";
import { MODEL_COMBO_MAPPING_OPERATION_IDS, MODEL_COMBO_MAPPING_SOURCE_CONTRACTS } from "./fixtures/model-combo-mappings.fixture.ts";

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
    source: { version: "3.8.53", commit: source.commit, archiveSha256: source.archiveSha256, addedSourceSha256: identities.addedSourceSha256, pingDeclarationSha256: identities.pingDeclarationSha256 },
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
    const degradationBinding = operationEvidenceBinding("GET /api/health/degradation", degradationContract());
    const staleIngressSha256 = "a890aefa50060b86b08ebf10af8ab685140c7dcd6737925c99a4a265d9040109";
    expect(() => validateHealthIngressEvidence({ artifact: `provenance/qualification/ingress-${staleIngressSha256}.json`, sha256: staleIngressSha256 }, degradationBinding, "GET /api/health/degradation")).toThrow(/input drift|source identity mismatch/);
    // Synthetic observations exercise validation only; they are not retained evidence.
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
    const comboRoutes = [
      ["GET /api/combos", "src/app/api/combos/route.ts"],
      ["GET /api/combos/{id}", "src/app/api/combos/[id]/route.ts"],
      ["GET /api/combos/auto", "src/app/api/combos/auto/route.ts"],
      ["GET /api/combos/builder/options", "src/app/api/combos/builder/options/route.ts"],
      ["GET /api/combos/metrics", "src/app/api/combos/metrics/route.ts"],
      ["DELETE /api/combos/metrics", "src/app/api/combos/metrics/route.ts"],
    ] as const;
    const comboPolicy = comboRoutes.map(([operationId]) => {
      const [method, template] = operationId.split(" ");
      return { method, path: template!.replace("{id}", "fixture-id"), routeClass: "MANAGEMENT", anonymousStatus: 401, invalidCredentialStatus: 401, authorizedStatus: 200 };
    });
    for (const [index, [operationId, route]] of comboRoutes.entries()) {
      const comboBinding = { ...binding, handlerSha256: String(added[route]) };
      const comboArtifact = { ...artifact, comboPolicy };
      const evidence = await save(comboArtifact);
      expect(() => validateHealthIngressEvidence(evidence, comboBinding, operationId)).not.toThrow();
      expect(() => validateHealthIngressEvidence(evidence, { ...comboBinding, handlerSha256: "0".repeat(64) }, operationId)).toThrow(/source mismatch/);
      for (const [key, value] of [["anonymousStatus", 200], ["invalidCredentialStatus", 200], ["authorizedStatus", 403], ["routeClass", "PUBLIC"], ["path", "/api/wrong"], ["method", "PATCH"]] as const) {
        const changed = structuredClone(comboArtifact);
        record(changed.comboPolicy[index])[key] = value;
        const changedEvidence = await save(changed);
        expect(() => validateHealthIngressEvidence(changedEvidence, comboBinding, operationId)).toThrow(/combo policy observation mismatch/);
      }
      const duplicateEvidence = await save({ ...comboArtifact, comboPolicy: [...comboPolicy, comboPolicy[index]] });
      expect(() => validateHealthIngressEvidence(duplicateEvidence, comboBinding, operationId)).toThrow(/combo policy observation mismatch/);
    }
    await save(artifact);
    // Cached expectations must not be mutable by callers, and changed transformation
    // bytes must force a new verification rather than reuse the prior derivation.
    const exposed = expectedHealthIngressIdentities("3.8.53", source.commit);
    record(exposed.addedSourceSha256)["src/proxy.ts"] = "0".repeat(64);
    expect(() => validateHealthIngressEvidence(valid, binding)).not.toThrow();
    const overlayPath = resolve(root, "test/fixtures/pinned-ingress/backend/core.ts");
    const originalOverlay = await readFile(overlayPath);
    try {
      await writeFile(overlayPath, Buffer.concat([originalOverlay, Buffer.from("\n")]));
      expect(() => expectedHealthIngressIdentities("3.8.53", source.commit)).toThrow();
    } finally {
      await writeFile(overlayPath, originalOverlay);
    }
    const runnerPath = resolve(root, "scripts/pinned-ingress.py");
    const runnerBytes = await readFile(runnerPath);
    const runnerStat = await stat(runnerPath);
    const cacheDirectory = await mkdtemp(join(tmpdir(), "ingress-pyc-"));
    const previousCachePrefix = process.env.PYTHONPYCACHEPREFIX;
    try {
      process.env.PYTHONPYCACHEPREFIX = cacheDirectory;
      execFileSync("python3", ["-m", "py_compile", runnerPath], { env: process.env });
      const original = 'metrics.sqlite';
      const replacement = 'metrics.sqlitf';
      const runnerText = runnerBytes.toString("utf8");
      expect(runnerText.split(original)).toHaveLength(2);
      const changed = Buffer.from(runnerText.replace(original, replacement));
      expect(changed.length).toBe(runnerBytes.length);
      await writeFile(runnerPath, changed);
      await utimes(runnerPath, runnerStat.atime, runnerStat.mtime);
      const changedIdentities = expectedHealthIngressIdentities("3.8.53", source.commit);
      expect(record(changedIdentities.executedOverlaySha256)["backend/core.ts"])
        .not.toBe(record(identities.executedOverlaySha256)["backend/core.ts"]);
    } finally {
      await writeFile(runnerPath, runnerBytes);
      await utimes(runnerPath, runnerStat.atime, runnerStat.mtime);
      if (previousCachePrefix === undefined) delete process.env.PYTHONPYCACHEPREFIX;
      else process.env.PYTHONPYCACHEPREFIX = previousCachePrefix;
      await rm(cacheDirectory, { recursive: true, force: true });
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
});
