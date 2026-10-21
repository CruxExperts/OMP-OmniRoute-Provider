import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildSbom, scanText, verifyPackage } from "../scripts/verify-package.ts";

function dependencyMap(sbom: { dependencies: Array<{ ref: string; dependsOn: string[] }> }) {
  return new Map(sbom.dependencies.map(edge => [edge.ref, edge.dependsOn]));
}

test("SBOM preserves current Bun nested selections and resolves every edge", async () => {
  const result = await verifyPackage();
  expect(result.sbom.bomFormat).toBe("CycloneDX");
  expect(result.sbom.specVersion).toBe("1.5");
  expect(result.sbom.version).toBe(1);
  expect(result.sbom.serialNumber).toMatch(/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/);
  const edges = dependencyMap(result.sbom);
  expect(edges.get("pkg:npm/onnxruntime-node@1.30.0")).toContain("pkg:npm/onnxruntime-common@1.30.0");
  expect(edges.get("pkg:npm/%40opentelemetry/exporter-metrics-otlp-http@0.220.0")).toContain("pkg:npm/%40opentelemetry/resources@2.9.0");
  expect(edges.get("pkg:npm/%40opentelemetry/resources@2.11.0")).toContain("pkg:npm/%40opentelemetry/core@2.11.0");
  const refs = new Set([result.sbom.metadata.component.purl, ...result.sbom.components.map(component => component.purl)]);
  for (const edge of result.sbom.dependencies) {
    expect(refs.has(edge.ref)).toBe(true);
    expect(edge.dependsOn.every(reference => refs.has(reference))).toBe(true);
  }
});

test("SBOM resolver prefers a synthetic parent-specific nested lock key", () => {
  const integrity = `sha512-${Buffer.from("fixture-integrity").toString("base64")}`;
  const purl = (name: string, version: string) => `pkg:npm/${name}@${version}`;
  const lockfile = {
    path: "bun.lock" as const,
    sha256: "0".repeat(64),
    lockfileVersion: 2,
    packages: [
      { key: "parent", name: "parent", version: "1.0.0", resolution: "parent@1.0.0", integrity, dependencies: { child: "1.0.0" }, purl: purl("parent", "1.0.0") },
      { key: "child", name: "child", version: "2.0.0", resolution: "child@2.0.0", integrity, dependencies: {}, purl: purl("child", "2.0.0") },
      { key: "parent/child", name: "child", version: "1.0.0", resolution: "child@1.0.0", integrity, dependencies: {}, purl: purl("child", "1.0.0") },
    ],
  };
  const sbom = buildSbom({ name: "root", version: "1.0.0", packageManager: "bun@1.4.2", dependencies: { parent: "1.0.0" } }, lockfile);
  expect(dependencyMap(sbom).get(purl("parent", "1.0.0"))).toEqual([purl("child", "1.0.0")]);
});

test("package secret scanning distinguishes provenance names from secret-bearing JSON keys and values", async () => {
  const root = await mkdtemp(join(tmpdir(), "crux-package-scan-"));
  const file = "catalog.json";
  const issues: Parameters<typeof scanText>[2] = [];
  const fixtureOpaque = ["Qm7vN2pR8t", "L4wX9cD6fH", "3kJ5sV1zA0"].join("");
  try {
    await writeFile(join(root, file), JSON.stringify({ provenance: { sourceResponseSha256: "f".repeat(64) } }));
    await scanText(root, [file], issues);
    expect(issues).toEqual([]);

    await writeFile(join(root, file), JSON.stringify({
      provenance: { sourceResponseSha256: "f".repeat(64) },
      credentialValue: fixtureOpaque,
    }));
    await scanText(root, [file], issues);
    expect(issues).toContainEqual({ kind: "secret", path: file, detail: "high-entropy secret-like literal" });

    issues.length = 0;
    await writeFile(join(root, file), JSON.stringify({ [fixtureOpaque]: "metadata" }));
    await scanText(root, [file], issues);
    expect(issues).toContainEqual({ kind: "secret", path: file, detail: "high-entropy secret-like literal" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package scanning recognizes immutable field references without exempting opaque source values", async () => {
  const root = await mkdtemp(join(tmpdir(), "crux-package-field-scan-"));
  const issues: Parameters<typeof scanText>[2] = [];
  const fields = ["frameworkContextSha256", "operationSemanticsSha256", "responseProjectionSha256"];
  const source = [
    `const HASH_FIELDS = ${JSON.stringify(fields)} as const;`,
    `type Selected = Pick<Binding, ${fields.map(value => JSON.stringify(value)).join(" | ")}>;`,
    `assertKeys(binding, "binding", ${JSON.stringify(fields)});`,
  ].join("\n");
  const schemaFile = "contracts/operations.schema.json";
  try {
    await mkdir(join(root, "contracts"));
    await writeFile(join(root, "binding.ts"), source);
    await writeFile(join(root, schemaFile), JSON.stringify({
      definitions: { binding: { properties: Object.fromEntries(fields.map(field => [field, { type: "string" }])), required: fields } },
    }));
    await scanText(root, ["binding.ts", schemaFile], issues);
    expect(issues).toEqual([]);

    const opaque = ["Qm7vN2pR8t", "L4wX9cD6fH", "3kJ5sV1zA0"].join("");
    await writeFile(join(root, "binding.ts"), `${source}\nconst SESSION_VALUE = ${JSON.stringify(opaque)};`);
    await scanText(root, ["binding.ts"], issues);
    expect(issues).toContainEqual({ kind: "secret", path: "binding.ts", detail: "high-entropy secret-like literal" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package scanning preserves public model examples and authorization prose but rejects embedded bearer credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "crux-package-openapi-scan-"));
  const issues: Parameters<typeof scanText>[2] = [];
  const file = "provenance/route-sources.json";
  const description = "Two bearer families are accepted. Bearer credentials are accepted here; a Bearer credential or dashboard session is required. A Bearer credential and an exact JSON model field. Specialty route.";
  try {
    await mkdir(join(root, "provenance"));
    const document = {
      openApi: {
        components: { securitySchemes: { BearerAuth: { description } } },
        schema: { properties: { model: { type: "string", example: "claude-sonnet-4-5-20250514" } } },
      },
    };
    await writeFile(join(root, file), JSON.stringify(document));
    await scanText(root, [file], issues);
    expect(issues).toEqual([]);

    const opaque = ["Qm7vN2pR8t", "L4wX9cD6fH", "3kJ5sV1zA0"].join("");
    document.openApi.components.securitySchemes.BearerAuth.description = `${description} Request example: Bearer ${opaque}`;
    await writeFile(join(root, file), JSON.stringify(document));
    await scanText(root, [file], issues);
    expect(issues).toContainEqual({ kind: "secret", path: file, detail: "credential-like bearer literal" });

    issues.length = 0;
    await writeFile(join(root, file), JSON.stringify({
      openApi: { schema: { properties: { apiKey: { example: opaque } } } },
    }));
    await scanText(root, [file], issues);
    expect(issues).toContainEqual({ kind: "secret", path: file, detail: "high-entropy secret-like literal" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("qualification scanning accepts reviewed fixture identifiers but rejects opaque values in the same field", async () => {
  const root = await mkdtemp(join(tmpdir(), "crux-package-qualification-scan-"));
  const directory = join(root, "provenance", "qualification");
  const file = `provenance/qualification/${"a".repeat(64)}.json`;
  const issues: Parameters<typeof scanText>[2] = [];
  const probeModelId = "probe-model-2-fixture-text-embedding";
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(join(root, file), JSON.stringify({
      observation: {
        before: { combos: { models: [{ id: "created-model-1-fixture-new" }] } },
        result: { body: { results: [{ executionKey: probeModelId, stepId: probeModelId }] } },
      },
    }));
    await scanText(root, [file], issues);
    expect(issues).toEqual([]);

    const opaque = ["Qm7vN2pR8t", "L4wX9cD6fH", "3kJ5sV1zA0"].join("");
    await writeFile(join(root, file), JSON.stringify({
      observation: {
        result: { body: { combos: { models: [{ id: opaque }] } } },
      },
    }));
    await scanText(root, [file], issues);
    expect(issues).toContainEqual({ kind: "secret", path: file, detail: "high-entropy secret-like literal" });

    issues.length = 0;
    const unreviewedModelId = ["unreviewed", "model", "1", "fixture", "candidate"].join("-");
    await writeFile(join(root, file), JSON.stringify({
      observation: { result: { body: { combos: { models: [{ id: unreviewedModelId }] } } } },
    }));
    await scanText(root, [file], issues);
    expect(issues).toContainEqual({ kind: "secret", path: file, detail: "high-entropy secret-like literal" });

    issues.length = 0;
    await writeFile(join(root, file), JSON.stringify({
      observation: { result: { body: { combos: { models: [{ id: `Bearer ${opaque}` }] } } } },
    }));
    await scanText(root, [file], issues);
    expect(issues).toContainEqual({ kind: "secret", path: file, detail: "credential-like bearer literal" });

    issues.length = 0;
    const apiKeyLike = `sk_test_${opaque}`;
    await writeFile(join(root, file), JSON.stringify({
      observation: { result: { body: { combos: { models: [{ id: apiKeyLike }] } } } },
    }));
    await scanText(root, [file], issues);
    expect(issues).toContainEqual({ kind: "secret", path: file, detail: "high-entropy secret-like literal" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("package scanning recognizes the reviewed cost metadata schema key without exempting its values", async () => {
  const root = await mkdtemp(join(tmpdir(), "crux-package-schema-metadata-scan-"));
  const issues: Parameters<typeof scanText>[2] = [];
  const publicSchema = {
    schema: { properties: { config: { properties: { slaMaxCostPer1MTokens: { type: "number" } } } } },
  };
  try {
    await mkdir(join(root, "contracts"));
    for (const file of ["contracts/operations.json", "contracts/release-eligibility.json"]) {
      await writeFile(join(root, file), JSON.stringify(publicSchema));
      await scanText(root, [file], issues);
      expect(issues).toEqual([]);

      const opaque = ["Qm7vN2pR8t", "L4wX9cD6fH", "3kJ5sV1zA0"].join("");
      await writeFile(join(root, file), JSON.stringify({
        schema: {
          properties: {
            config: { properties: { slaMaxCostPer1MTokens: { type: "string", example: opaque } } },
            credentials: { properties: { accessToken: { example: opaque } } },
          },
        },
      }));
      await scanText(root, [file], issues);
      expect(issues).toContainEqual({ kind: "secret", path: file, detail: "high-entropy secret-like literal" });
      expect(issues.filter(issue => issue.kind === "secret")).toHaveLength(2);
      issues.length = 0;
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Markdown schema field names do not exempt actual opaque values", async () => {
  const root = await mkdtemp(join(tmpdir(), "crux-package-doc-scan-"));
  const issues: Parameters<typeof scanText>[2] = [];
  try {
    await writeFile(join(root, "guide.md"), '```json\n{"packageArchiveSha256": "<SHA-256 of the package>"}\n```\n');
    await scanText(root, ["guide.md"], issues);
    expect(issues).toEqual([]);
    const opaque = ["Qm7vN2pR8t", "L4wX9cD6fH", "3kJ5sV1zA0"].join("");
    await writeFile(join(root, "guide.md"), `\`\`\`json\n{"packageArchiveSha256": "${opaque}"}\n\`\`\`\n`);
    await scanText(root, ["guide.md"], issues);
    expect(issues).toContainEqual({ kind: "secret", path: "guide.md", detail: "high-entropy secret-like literal" });
  } finally { await rm(root, { recursive: true, force: true }); }
});
