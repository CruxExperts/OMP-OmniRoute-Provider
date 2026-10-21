import { expect, test } from "bun:test";
import { decodeRouteSources, encodeRouteSources } from "../scripts/route-source-store.ts";

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
