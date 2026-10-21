import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  operationContractTemplate,
  operationEvidenceBinding,
  outcomeArtifactPath,
  testCaseSourceHash,
  testOutcomeHash,
} from "../scripts/generate-contracts.ts";
import { getOperation, type OperationDescriptor } from "../src/admin/registry.ts";
import { fixtureRegistry } from "./fixtures/admin-qualification.fixture.ts";
import { FALLBACK_CHAIN_POST, FALLBACK_CHAIN_SOURCE_CONTRACTS } from "./fixtures/fallback-chains.fixture.ts";

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
        source: "omniroute-v3.8.52",
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

test("observed outcomes enforce bound explicit output-secret paths and typed token metadata", async () => {
  const operationId = "GET /.well-known/agent-card.json";
  const testId = "test/contracts.test.ts";
  const template = operationContractTemplate(operationId);
  const contract = {
    ...template,
    auth: {
      ...record(template.auth),
      domain: "public",
      sourcePolicy: { status: "qualified", source: "omniroute-v3.8.52", routeClass: "public", alternatives: [{ kind: "anonymous" }] },
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
