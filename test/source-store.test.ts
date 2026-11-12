import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { assertQualificationManifest, decodeRouteSources, encodeRouteSources, resolveQualificationSource } from "../scripts/route-source-store.ts";

const fixture = () => {
  const shared = { files: Array.from({ length: 60 }, (_, i) => `src/auth/handler-${i}.ts`), status: "source evidence" };
  return { routeFiles: [{ id: "first", evidence: shared }, { id: "second", evidence: shared }], release: "fixture" };
};

test("source records share repeated evidence and preserve the complete expanded manifest", () => {
  const manifest = fixture();
  const stored = encodeRouteSources(manifest);
  expect(decodeRouteSources(stored)).toEqual(manifest);
  expect(JSON.stringify(stored).length).toBeLessThan(JSON.stringify(manifest).length);
  expect(encodeRouteSources(manifest)).toEqual(stored);
});

test("tampered content, missing records, and unused records fail closed", () => {
  const stored = encodeRouteSources(fixture()) as { records: Record<string, unknown> };
  const key = Object.keys(stored.records)[0]!;
  stored.records[key] = { tampered: true };
  expect(() => decodeRouteSources(stored as never)).toThrow("digest mismatch");
  delete stored.records[key];
  expect(() => decodeRouteSources(stored as never)).toThrow("missing");
  const unused = encodeRouteSources(fixture()) as { records: Record<string, unknown> };
  unused.records["a".repeat(64)] = "secret-bearing unused record";
  expect(() => decodeRouteSources(unused as never)).toThrow("Unreferenced");
});

test("cyclic references and reserved source fields are rejected", () => {
  const key = "b".repeat(64);
  const reference = { $recordSha256: key };
  expect(() => decodeRouteSources({ schemaVersion: 1, recordKind: "omniroute-content-addressed-source", rootSha256: key, root: reference, records: { [key]: reference } })).toThrow("Cyclic");
  expect(() => encodeRouteSources(reference)).toThrow("Reserved");
});

test("overlapping import closures share chunks while preserving order and insertions", () => {
  const imports = Array.from({ length: 300 }, (_, i) => `src/dependency/long-source-file-${i}.ts`);
  const manifest = { first: imports, second: ["src/added.ts", ...imports], third: imports.slice(5) };
  const stored = encodeRouteSources(manifest);
  expect(JSON.stringify(stored)).toContain("$sequenceChunks");
  expect(decodeRouteSources(stored)).toEqual(manifest);
  expect(JSON.stringify(stored).length).toBeLessThan(JSON.stringify(manifest).length);
});

test("qualification selection is explicit, contained and digest pinned", () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "source-selection-"));
  const provenance = join(root, "provenance");
  mkdirSync(provenance);
  const record = "provenance/manifest.json";
  const bytes = "signed manifest bytes";
  const digest = createHash("sha256").update(bytes).digest("hex");
  writeFileSync(join(root, record), bytes);
  const configure = (source?: unknown) => writeFileSync(join(provenance, "upstreams.json"), JSON.stringify({ upstreams: [{ id: "omniroute", release: { version: "3.8.53" }, ...(source === undefined ? {} : { qualification_source: source }) }] }));
  try {
    configure();
    expect(resolveQualificationSource(root)).toEqual({ root: join(root, ".agents/state/omp-provider-release/upstream/omniroute-v3.8.53"), derivation: null });
    const valid = { kind: "signed-derivation", record, sha256: digest };
    configure(valid);
    const selection = resolveQualificationSource(root);
    expect(selection.derivation).toEqual({ record, sha256: digest });
    expect(selection.root).toEndWith(`derived-${digest}`);
    for (const invalid of [{ ...valid, extra: true }, { ...valid, kind: "other" }, { ...valid, sha256: "a".repeat(64) }, { ...valid, record: "../outside" }, { ...valid, record: "/outside" }, { ...valid, record: "provenance/missing" }]) {
      configure(invalid);
      expect(() => resolveQualificationSource(root)).toThrow();
    }
    symlinkSync(provenance, join(root, "link"), process.platform === "win32" ? "junction" : "dir");
    configure({ ...valid, record: "link/manifest.json" });
    expect(() => resolveQualificationSource(root)).toThrow();
    expect(() => assertQualificationManifest({}, { ...selection, treeSha256: "b".repeat(64), files: null })).toThrow();
    expect(() => assertQualificationManifest({ sourceDerivation: selection.derivation, effectiveTreeSha256: "c".repeat(64) }, { ...selection, treeSha256: "b".repeat(64), files: null })).toThrow();
  } finally { rmSync(root, { recursive: true, force: true }); }
});
