import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test } from "bun:test";
import { readRouteSources } from "../scripts/route-source-store.ts";
import { addDefaultMigrationInputs, resolvedSourceInputsDigest, type RuntimeSourceReceipt } from "../scripts/runtime-source-inputs.ts";

const requiredMigrations = [
  "src/lib/db/migrations/004_proxy_registry.sql",
  "src/lib/db/migrations/005_combo_agent_fields.sql",
  "src/lib/db/migrations/117_proxy_pool_rotation.sql",
];
const sha256 = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
const gitBlobSha = (bytes: Uint8Array): string => createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");

test("pinned migration runner source closure includes all numbered SQL receipts as opaque bytes", () => {
  const temporary = mkdtempSync(join(tmpdir(), "cruxomni-runtime-inputs-"));
  const migrations = join(temporary, "src/lib/db/migrations");
  mkdirSync(migrations, { recursive: true });
  writeFileSync(join(temporary, "src/lib/db/migrationRunner.ts"), "export const runner = true;\n");
  const invalidTypeScriptSql = "CREATE TABLE runtime_input (value TEXT NOT NULL);\n";
  for (const path of requiredMigrations) writeFileSync(join(temporary, path), invalidTypeScriptSql);

  try {
    const captured = new Map<string, RuntimeSourceReceipt>();
    const closure = addDefaultMigrationInputs(temporary, ["src/lib/db/migrationRunner.ts"], absolutePath => {
      const bytes = readFileSync(absolutePath);
      const path = absolutePath.slice(temporary.length + 1).split("\\").join("/");
      const receipt = { path, bytes: bytes.byteLength, sha256: sha256(bytes), gitBlobSha: gitBlobSha(bytes) };
      captured.set(path, receipt);
      return receipt;
    });
    expect(closure).toEqual([
      "src/lib/db/migrationRunner.ts",
      ...requiredMigrations,
    ].sort());
    expect([...captured.keys()].sort()).toEqual(requiredMigrations.sort());

    const initialDigest = resolvedSourceInputsDigest([...captured.values()]);
    const changedPath = join(temporary, requiredMigrations[0]!);
    writeFileSync(changedPath, `${invalidTypeScriptSql}-- changed bytes\n`);
    const changedBytes = readFileSync(changedPath);
    const changedReceipt = {
      path: requiredMigrations[0]!,
      bytes: changedBytes.byteLength,
      sha256: sha256(changedBytes),
      gitBlobSha: gitBlobSha(changedBytes),
    };
    const changedDigest = resolvedSourceInputsDigest([
      ...[...captured.values()].filter(receipt => receipt.path !== changedReceipt.path),
      changedReceipt,
    ]);
    expect(changedDigest).not.toBe(initialDigest);
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
});

test("generated pinned source corpus binds the required migration bytes into route and framework digests", () => {
  const manifestPath = resolve(import.meta.dir, "../provenance/route-sources.json");
  const manifest = readRouteSources(manifestPath) as unknown as {
    frameworkContext: { resolvedFiles: string[]; sha256: string };
    sourceCorpus: { files: RuntimeSourceReceipt[] };
    routeFiles: Array<{ sourceFile: string; resolvedImports: string[]; resolvedImportsSha256: string }>;
  };
  const sourceFiles = new Map(manifest.sourceCorpus.files.map(receipt => [receipt.path, receipt]));
  for (const path of requiredMigrations) expect(sourceFiles.has(path)).toBe(true);

  expect(manifest.frameworkContext.resolvedFiles).toEqual(expect.arrayContaining(requiredMigrations));
  expect(resolvedSourceInputsDigest(manifest.frameworkContext.resolvedFiles.map(path => sourceFiles.get(path)!)))
    .toBe(manifest.frameworkContext.sha256);

  const route = manifest.routeFiles.find(candidate => candidate.resolvedImports.includes("src/lib/db/migrationRunner.ts"));
  expect(route).toBeDefined();
  expect(route!.resolvedImports).toEqual(expect.arrayContaining(requiredMigrations));
  expect(resolvedSourceInputsDigest(route!.resolvedImports.map(path => sourceFiles.get(path)!)))
    .toBe(route!.resolvedImportsSha256);
});
