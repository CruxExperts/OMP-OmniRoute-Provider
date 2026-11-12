import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, resolve, sep } from "node:path";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
const canonical = (value: Json): string => {
  let nodes = 0;
  let bytes = 0;
  const render = (entry: Json, depth: number): string => {
    if (++nodes > 5_000_000 || depth > 128) throw new Error("Canonical source expansion exceeds bounds");
    const count = (text: string): string => {
      bytes += Buffer.byteLength(text);
      if (bytes > 128 * 1024 * 1024) throw new Error("Canonical source bytes exceed bound");
      return text;
    };
    if (Array.isArray(entry)) { count("[]" + ",".repeat(entry.length)); return `[${entry.map(child => render(child, depth + 1)).join(",")}]`; }
    if (entry !== null && typeof entry === "object") {
      count("{}" + ",".repeat(Object.keys(entry).length));
      return `{${Object.keys(entry).sort().map(key => `${count(JSON.stringify(key) + ":")}${render(entry[key]!, depth + 1)}`).join(",")}}`;
    }
    return count(JSON.stringify(entry));
  };
  return render(value, 0);
};
const hash = (value: Json): string => createHash("sha256").update(canonical(value)).digest("hex");
const isRecord = (value: unknown): value is { [key: string]: Json } => value !== null && !Array.isArray(value) && typeof value === "object";
const referenceKey = "$recordSha256";
const sequenceKey = "$sequenceChunks";
function chunks(value: Json[]): Json[][] | undefined {
  if (value.length <= 64 || !value.every(child => typeof child === "string")) return undefined;
  const groups: Json[][] = [];
  let group: Json[] = [];
  for (const child of value) {
    group.push(child);
    // Content boundaries keep unchanged import subsequences shared after insertions.
    const boundary = createHash("sha256").update(child as string).digest()[0]! % 32 === 0;
    if (group.length >= 64 || (group.length >= 8 && boundary)) { groups.push(group); group = []; }
  }
  if (group.length) groups.push(group);
  return groups;
}

/** Keep repeated provenance content once, without changing the expanded manifest. */
export function encodeRouteSources(manifest: Json): Json {
  const counts = new Map<string, number>();
  const sizes = new Map<string, number>();
  const inspect = (value: Json, depth: number): void => {
    if (depth > 128) throw new Error("Route source nesting exceeds bound");
    if (isRecord(value) && (referenceKey in value || sequenceKey in value)) throw new Error("Reserved source-store reference key in manifest");
    if (value !== null && typeof value === "object") {
      const serialized = canonical(value);
      if (serialized.length >= 512) {
        const digest = createHash("sha256").update(serialized).digest("hex");
        counts.set(digest, (counts.get(digest) ?? 0) + 1);
        sizes.set(digest, serialized.length);
      }
      const groups = Array.isArray(value) ? chunks(value) : undefined;
      if (groups) for (const group of groups) inspect(group, depth + 1);
      else for (const child of Array.isArray(value) ? value : Object.values(value)) inspect(child, depth + 1);
    }
  };
  inspect(manifest, 0);
  const records: Record<string, Json> = Object.create(null);
  const encode = (value: Json, root = false): Json => {
    if (value === null || typeof value !== "object") return value;
    const digest = hash(value);
    if (!root && (counts.get(digest) ?? 0) > 1 && (sizes.get(digest) ?? 0) >= 512) {
      if (!(digest in records)) records[digest] = encode(value, true);
      return { [referenceKey]: digest };
    }
    const groups = Array.isArray(value) ? chunks(value) : undefined;
    if (groups) return { [sequenceKey]: groups.map(group => encode(group)) };
    return Array.isArray(value) ? value.map(child => encode(child)) : Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encode(child)]));
  };
  const root = encode(manifest, true);
  return { schemaVersion: 1, recordKind: "omniroute-content-addressed-source", rootSha256: hash(manifest), root, records: Object.fromEntries(Object.entries(records).sort(([a], [b]) => a.localeCompare(b, "en"))) };
}

export function decodeRouteSources(store: Json): Json {
  // Historical manifests remain readable so migration can verify byte-for-byte meaning.
  if (!isRecord(store) || store.recordKind !== "omniroute-content-addressed-source") return store;
  if (store.schemaVersion !== 1 || !isRecord(store.records) || typeof store.rootSha256 !== "string"
    || Object.keys(store).sort().join(",") !== ["recordKind", "records", "root", "rootSha256", "schemaVersion"].join(",")) throw new Error("Invalid route source store");
  const records = store.records;
  const visited = new Set<string>();
  const active = new Set<string>();
  const decoded = new Map<string, Json>();
  let expandedNodes = 0;
  const expand = (value: Json, depth: number): Json => {
    if (depth > 128 || ++expandedNodes > 5_000_000) throw new Error("Source store expansion exceeds bounds");
    if (isRecord(value) && referenceKey in value) {
      const digest = value[referenceKey];
      if (Object.keys(value).length !== 1 || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest)
        || !Object.hasOwn(records, digest)) throw new Error("Invalid or missing content-addressed source record");
      if (active.has(digest)) throw new Error("Cyclic content-addressed source record");
      visited.add(digest);
      if (decoded.has(digest)) return decoded.get(digest)!;
      active.add(digest);
      const result = expand(records[digest]!, depth + 1);
      active.delete(digest);
      if (hash(result) !== digest) throw new Error("Content-addressed source record digest mismatch");
      decoded.set(digest, result);
      return result;
    }
    if (isRecord(value) && sequenceKey in value) {
      if (Object.keys(value).length !== 1 || !Array.isArray(value[sequenceKey])) throw new Error("Invalid content-addressed sequence");
      const result: Json[] = [];
      for (const group of value[sequenceKey]) {
        const part = expand(group, depth + 1);
        if (!Array.isArray(part) || !part.every(child => typeof child === "string") || result.length + part.length > 5_000_000) throw new Error("Invalid source sequence chunk");
        result.push(...part);
      }
      return result;
    }
    if (Array.isArray(value)) return value.map(child => expand(child, depth + 1));
    if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, expand(child, depth + 1)]));
    return value;
  };
  const manifest = expand(store.root!, 0);
  if (Object.keys(records).some(key => !visited.has(key))) throw new Error("Unreferenced content-addressed source records");
  if (hash(manifest) !== store.rootSha256) throw new Error("Expanded source manifest digest mismatch");
  return manifest;
}

export type SourceDerivation = { record: string; sha256: string };
export type QualificationSource = { root: string; derivation: SourceDerivation | null };
export type VerifiedQualificationSource = QualificationSource & { treeSha256: string | null; files: ReadonlyMap<string, string> | null };

/** Resolve configuration without executing source or changing the workspace. */
export function resolveQualificationSource(packageRoot: string): QualificationSource {
  const root = resolve(packageRoot);
  for (let path = root;; path = dirname(path)) {
    if (lstatSync(path).isSymbolicLink()) throw new Error("Package root contains symlink");
    if (dirname(path) === path) break;
  }
  const provenance: unknown = JSON.parse(readFileSync(resolve(root, "provenance/upstreams.json"), "utf8"));
  if (!isRecord(provenance) || !Array.isArray(provenance.upstreams)) throw new Error("Invalid upstream provenance");
  const matches = provenance.upstreams.filter(item => isRecord(item) && item.id === "omniroute");
  if (matches.length !== 1 || !isRecord(matches[0])) throw new Error("Invalid OmniRoute upstream pin");
  const upstream = matches[0];
  if (!isRecord(upstream.release) || typeof upstream.release.version !== "string" || !/^\d+\.\d+\.\d+$/.test(upstream.release.version)) throw new Error("Invalid OmniRoute release version");
  const state = resolve(root, ".agents/state/omp-provider-release/upstream");
  if (!("qualification_source" in upstream)) return { root: resolve(state, `omniroute-v${upstream.release.version}`), derivation: null };
  const source = upstream.qualification_source;
  if (!isRecord(source) || Object.keys(source).sort().join(",") !== "kind,record,sha256" || source.kind !== "signed-derivation"
    || typeof source.record !== "string" || typeof source.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(source.sha256)) throw new Error("Invalid qualification source configuration");
  if (isAbsolute(source.record) || /^[A-Za-z]:/.test(source.record) || source.record.includes("\\") || source.record.includes("\0") || source.record.split("/").some(part => !part || part === "." || part === "..")) throw new Error("Invalid qualification source record path");
  const path = resolve(root, source.record);
  if (!path.startsWith(`${root}${sep}`)) throw new Error("Qualification source record escapes package root");
  let current = root;
  for (const part of source.record.split("/")) {
    current = resolve(current, part);
    if (lstatSync(current).isSymbolicLink()) throw new Error("Qualification source record contains symlink");
  }
  if (!lstatSync(path).isFile()) throw new Error("Qualification source record is not a regular file");
  if (createHash("sha256").update(readFileSync(path)).digest("hex") !== source.sha256) throw new Error("Qualification source digest mismatch");
  const derivation = { record: source.record, sha256: source.sha256 };
  return { root: resolve(state, `derived-${source.sha256}`), derivation };
}

/** Authenticate the complete prepared tree by reconstructing it with the Python owner. */
export function verifyQualificationSource(packageRoot: string): VerifiedQualificationSource {
  const selection = resolveQualificationSource(packageRoot);
  if (!selection.derivation) return { ...selection, treeSha256: null, files: null };
  const output = execFileSync("python3", [resolve(packageRoot, "scripts/prepare-upstream.py"), "--verify-qualification-source"], { cwd: packageRoot, encoding: "utf8", maxBuffer: 1024 * 1024 });
  const verified: unknown = JSON.parse(output);
  if (!isRecord(verified) || verified.root !== selection.root || !isRecord(verified.derivation)
    || verified.derivation.record !== selection.derivation.record || verified.derivation.sha256 !== selection.derivation.sha256
    || typeof verified.treeSha256 !== "string" || !/^[a-f0-9]{64}$/.test(verified.treeSha256)) throw new Error("Invalid verified qualification source identity");
  const receipt: unknown = JSON.parse(readFileSync(`${selection.root}.receipt.json`, "utf8"));
  if (!isRecord(receipt) || !Array.isArray(receipt.files) || hash(receipt.files) !== verified.treeSha256) throw new Error("Effective source receipt digest mismatch");
  const files = new Map<string, string>();
  for (const entry of receipt.files) {
    if (!isRecord(entry) || Object.keys(entry).sort().join(",") !== "path,sha256" || typeof entry.path !== "string" || typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256) || files.has(entry.path)) throw new Error("Invalid effective source file receipt");
    files.set(entry.path, entry.sha256);
  }
  return { ...selection, treeSha256: verified.treeSha256, files };
}

export function assertQualificationManifest(manifest: unknown, source: VerifiedQualificationSource): void {
  if (!isRecord(manifest)) throw new Error("Invalid route source manifest");
  if (source.derivation === null) {
    if (manifest.sourceDerivation !== undefined || manifest.effectiveTreeSha256 !== undefined) throw new Error("Unexpected qualification source identity");
    return;
  }
  const value = manifest.sourceDerivation;
  if (!isRecord(value) || Object.keys(value).sort().join(",") !== "record,sha256" || value.record !== source.derivation.record
    || value.sha256 !== source.derivation.sha256 || manifest.effectiveTreeSha256 !== source.treeSha256) throw new Error("Qualification source identity mismatch");
}

const cache = new Map<string, { digest: string; manifest: Json }>();
export function readRouteSources(path: string): Json {
  const bytes = readFileSync(path);
  if (bytes.byteLength > 128 * 1024 * 1024) throw new Error("Route source store exceeds size bound");
  const digest = createHash("sha256").update(bytes).digest("hex");
  const previous = cache.get(path);
  if (previous?.digest === digest) return previous.manifest;
  const manifest = decodeRouteSources(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Json);
  const frozen = new Set<object>();
  const freeze = (value: Json): void => {
    if (value === null || typeof value !== "object" || frozen.has(value)) return;
    frozen.add(value);
    for (const child of Array.isArray(value) ? value : Object.values(value)) freeze(child);
    Object.freeze(value);
  };
  freeze(manifest);
  if (cache.size >= 4) cache.clear();
  cache.set(path, { digest, manifest });
  return manifest;
}
