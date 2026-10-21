import { decodeRouteSources } from "./route-source-store.ts";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";

const execFileAsync = promisify(execFile);
const packageRoot = resolve(import.meta.dir, "..");
const requiredDocs = ["README.md", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", "ASSET_LICENSE.md", "THIRD_PARTY_NOTICES.md", "SUPPORT.md", "LICENSE"] as const;
const maxPackageArchiveBytes = 512 * 1024 * 1024;
const allowedExact = new Set(["package.json", "VERSION", ...requiredDocs]);
const allowedPrefixes = ["src/", "contracts/", "provenance/", "scripts/", "test/fixtures/", "assets/", "docs/", ".omp-plugin/"] as const;
const hostProvidedOmpPackages: Record<string, true> = {
  "@oh-my-pi/pi-ai": true,
  "@oh-my-pi/pi-catalog": true,
  "@oh-my-pi/pi-coding-agent": true,
  "@oh-my-pi/pi-tui": true,
  "@oh-my-pi/pi-utils": true,
};
function hostCompatibilityRange(manifest: PackageManifest): string {
  const value = manifest.omp?.compatibility?.host;
  if (typeof value !== "string" || !/^>=\d+\.\d+\.\d+ <\d+$/.test(value)) {
    throw new Error("manifest.omp.compatibility.host must be a semver floor and major-version ceiling");
  }
  return value;
}

async function pinnedOmpVersion(): Promise<string> {
  const provenance = JSON.parse(await readFile(join(packageRoot, "provenance/upstreams.json"), "utf8")) as unknown;
  if (!recordValue(provenance) || !Array.isArray(provenance.upstreams)) throw new Error("provenance.upstreams must be an array");
  const upstream = provenance.upstreams.find(value => recordValue(value) && value.id === "omp");
  if (!recordValue(upstream) || !recordValue(upstream.release)) throw new Error("provenance has no pinned OMP release");
  const version = upstream.release.version;
  if (typeof version !== "string" || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("provenance OMP release version must be exact semver");
  return version;
}

const semverDependency = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

interface PackageManifest {
  name?: unknown;
  version?: unknown;
  packageManager?: unknown;
  main?: unknown;
  module?: unknown;
  exports?: unknown;
  files?: unknown;
  omp?: { extensions?: unknown; compatibility?: { host?: unknown; tested?: unknown } };
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  peerDependenciesMeta?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

interface LockPackage {
  key: string;
  name: string;
  version: string;
  resolution: string;
  integrity: string;
  dependencies: Record<string, string>;
  purl: string;
}

interface LockEvidence {
  path: "bun.lock";
  sha256: string;
  lockfileVersion: number;
  packages: LockPackage[];
}

interface Sbom {
  bomFormat: "CycloneDX";
  specVersion: "1.5";
  version: 1;
  serialNumber: string;
  metadata: { component: { type: "library"; name: string; version: string; purl: string; properties: Array<{ name: string; value: string }> } };
  components: Array<{ type: "library"; name: string; version: string; purl: string; hashes: Array<{ alg: "SHA-512" | "SHA-256"; content: string }>; properties: Array<{ name: string; value: string }> }>;
  dependencies: Array<{ ref: string; dependsOn: string[] }>;
}

interface ScanIssue {
  kind: "allowlist" | "symlink" | "private-path" | "secret" | "entrypoint" | "import" | "documentation";
  path: string;
  detail: string;
}
function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  if (!recordValue(value)) return undefined;
  const nested = value.dependencies ?? value.requires;
  if (nested !== undefined) return stringRecord(nested);
  const entries = Object.entries(value);
  if (entries.some(([, child]) => typeof child !== "string")) return undefined;
  return Object.fromEntries(entries.map(([key, child]) => [key, child as string]));
}

function allStrings(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(allStrings);
  if (recordValue(value)) return Object.values(value).flatMap(allStrings);
  return [];
}

function packageIdentity(identity: string, key: string): { name: string; version: string } {
  const candidate = identity.startsWith("pkg:npm/") ? identity.slice("pkg:npm/".length) : identity;
  const at = candidate.lastIndexOf("@");
  if (at <= 0 || at === candidate.length - 1) throw new Error(`bun.lock contains a package without an exact name/version identity: ${key}`);
  const name = candidate.slice(0, at).replace(/^%40/, "@");
  const version = candidate.slice(at + 1);
  if (!/^@?[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)?$/.test(name) || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`bun.lock contains a mutable or non-semver package identity: ${identity}`);
  }
  return { name, version };
}

function packagePurl(name: string, version: string): string {
  return `pkg:npm/${name.startsWith("@") ? `%40${name.slice(1)}` : name}@${version}`;
}
function parseBunLock(text: string): unknown {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index++) {
    const character = text[index]!;
    if (inString) {
      result += character;
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") {
      inString = true;
      result += character;
      continue;
    }
    if (character === ",") {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next]!)) next++;
      if (text[next] === "}" || text[next] === "]") continue;
    }
    result += character;
  }
  if (inString || escaped) throw new Error("unterminated string");
  return JSON.parse(result) as unknown;
}


async function readBunLock(manifest: PackageManifest): Promise<LockEvidence> {
  const lockPath = join(packageRoot, "bun.lock");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await readFile(lockPath));
  } catch {
    throw new Error("bun.lock is required and must be committed; generate it with the reviewed Bun toolchain after the supply-chain gate permits install");
  }
  try {
    await command("git", ["ls-files", "--error-unmatch", "--", "bun.lock"], packageRoot);
  } catch {
    throw new Error("bun.lock is required and must be committed; an untracked lockfile is not accepted");
  }
  if (bytes.byteLength === 0) throw new Error("bun.lock is required and must be committed; the committed lock is empty");
  let parsed: unknown;
  try {
    parsed = parseBunLock(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("bun.lock must be valid Bun text lockfile data with exact transitive identities and integrities");
  }
  if (!recordValue(parsed) || typeof parsed.lockfileVersion !== "number" || !Number.isInteger(parsed.lockfileVersion)) {
    throw new Error("bun.lock must declare an integer lockfileVersion");
  }
  if (!recordValue(parsed.packages)) throw new Error("bun.lock must contain the complete transitive packages table");
  const packages: LockPackage[] = [];
  for (const [key, raw] of Object.entries(parsed.packages)) {
    if (key === "" || key === ".") continue;
    if (!Array.isArray(raw)) throw new Error(`bun.lock package entry ${key} is not a Bun package tuple`);
    const strings = allStrings(raw);
    const identity = strings.find(value => value.includes("@") && !/^sha(?:256|384|512)-/i.test(value) && !/^(?:https?|git|file):/i.test(value));
    if (!identity) throw new Error(`bun.lock package entry ${key} is missing an exact package identity`);
    const { name, version } = packageIdentity(identity, key);
    const integrity = strings.find(value => /^(?:sha(?:256|384|512)-[A-Za-z0-9+/=]+|[a-f0-9]{64})$/.test(value));
    if (!integrity) throw new Error(`bun.lock package ${name}@${version} is missing an integrity`);
    if (/^(?:workspace:|catalog:|latest$|[~^*]|(?:git|github|file|https?):)/i.test(identity)) {
      throw new Error(`bun.lock package ${name}@${version} uses a mutable resolution`);
    }
    const dependencies: Record<string, string> = {};
    const optionalPeers = new Set(raw.flatMap(value => recordValue(value) && Array.isArray(value.optionalPeers) ? value.optionalPeers.filter((name): name is string => typeof name === "string") : []));
    for (const value of raw) {
      if (!recordValue(value)) continue;
      for (const field of ["dependencies", "optionalDependencies", "peerDependencies"] as const) {
        const entries = stringRecord(value[field]);
        if (entries) for (const [name, spec] of Object.entries(entries)) {
          if (field === "peerDependencies" && optionalPeers.has(name)) continue;
          dependencies[name] = spec;
        }
      }
    }
    packages.push({
      key,
      name,
      version,
      resolution: identity,
      integrity,
      dependencies,
      purl: packagePurl(name, version),
    });
  }
  const names = new Set(packages.map(item => item.name));
  const declaredGroups = [manifest.dependencies, manifest.devDependencies, manifest.peerDependencies, manifest.optionalDependencies];
  const declared = declaredGroups.flatMap(group => Object.keys(group ?? {}));
  const hostRange = hostCompatibilityRange(manifest);
  const hostVersion = await pinnedOmpVersion();
  for (const group of declaredGroups) {
    for (const [name, spec] of Object.entries(group ?? {})) {
      const exact = typeof spec === "string" && semverDependency.test(spec);
      const supportedHostRange = Object.hasOwn(hostProvidedOmpPackages, name) && spec === hostRange;
      if (!exact && !supportedHostRange) throw new Error(`manifest dependency ${name} must pin an exact semver or use the reviewed OMP compatibility range ${hostRange}`);
    }
  }
  for (const name of Object.keys(hostProvidedOmpPackages)) {
    if (manifest.dependencies?.[name] !== undefined || manifest.optionalDependencies?.[name] !== undefined) {
      throw new Error(`${name} is host-provided and must not be installed as a package runtime dependency`);
    }
    if (manifest.peerDependencies?.[name] !== hostRange) throw new Error(`${name} must declare the package OMP compatibility range as a peer dependency`);
    const peerMetadata = manifest.peerDependenciesMeta?.[name];
    if (!recordValue(peerMetadata) || peerMetadata.optional !== true) {
      throw new Error(`${name} must be an installer-optional host peer to prevent a second SDK installation`);
    }
    if (manifest.devDependencies?.[name] !== hostVersion) throw new Error(`${name} must use the exact pinned OMP release ${hostVersion} for development checks`);
    const lockEntries = packages.filter(item => item.name === name);
    if (lockEntries.length !== 1 || lockEntries[0]?.version !== hostVersion) {
      throw new Error(`${name} must resolve exactly once to pinned OMP ${hostVersion}; duplicate host runtime copies are not allowed`);
    }
  }
  for (const name of declared) if (!names.has(name)) throw new Error(`bun.lock is missing the declared dependency ${name}`);
  if (typeof manifest.packageManager !== "string" || !/^bun@\d+\.\d+\.\d+$/.test(manifest.packageManager)) throw new Error("manifest.packageManager must pin an exact Bun version (for example bun@1.3.14)");
  return {
    path: "bun.lock",
    sha256: createHash("sha256").update(bytes).digest("hex"),
    lockfileVersion: parsed.lockfileVersion,
    packages,
  };
}

function isAllowed(relativePath: string): boolean {
  return allowedExact.has(relativePath) || allowedPrefixes.some(prefix => relativePath.startsWith(prefix));
}

async function command(command: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execFileAsync(command, args, { cwd, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, npm_config_ignore_scripts: "true" } });
  } catch (error) {
    const failure = error as { message?: unknown; stdout?: unknown; stderr?: unknown };
    const detail = typeof failure.stderr === "string" && failure.stderr.trim().length > 0 ? failure.stderr.trim() : String(failure.message ?? error);
    throw new Error(`${command} ${args.join(" ")} failed: ${detail}`);
  }
}
function packMetadata(parsed: unknown): Record<string, unknown> {
  let value: unknown;
  if (Array.isArray(parsed)) {
    if (parsed.length !== 1) throw new Error("npm pack returned an unexpected result");
    value = parsed[0];
  } else if (parsed && typeof parsed === "object") {
    const entries = Object.entries(parsed);
    if (entries.length !== 1) throw new Error("npm pack returned an unexpected result");
    value = entries[0]![1];
  } else {
    throw new Error("npm pack returned an unexpected result");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("npm pack returned an unexpected result");
  return value as Record<string, unknown>;
}

async function packPackage(destination: string): Promise<{ archive: string }> {
  const packed = await command("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination], packageRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(packed.stdout);
  } catch (error) {
    throw new Error(`npm pack did not return JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const metadata = packMetadata(parsed);
  const filename = metadata.filename;
  if (typeof filename !== "string" || filename.length === 0 || filename !== basename(filename) || filename.includes("\\")) throw new Error("npm pack did not report a safe archive filename");
  const archive = resolve(destination, filename);
  if (relative(resolve(destination), archive).startsWith(`..${sep}`) || isAbsolute(relative(resolve(destination), archive))) throw new Error("npm pack archive escaped its temporary directory");
  const info = await lstat(archive).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > maxPackageArchiveBytes) throw new Error("npm pack did not produce a bounded regular archive file");
  return { archive };
}

async function walk(root: string, current = root): Promise<string[]> {
  const entries = await readdir(current, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = join(current, entry.name);
    const relativePath = relative(root, path).split(sep).join("/");
    if (entry.isSymbolicLink()) throw new Error(`symbolic link is not allowed in package: ${relativePath}`);
    if (entry.isDirectory()) result.push(...await walk(root, path));
    else if (entry.isFile()) result.push(relativePath);
    else throw new Error(`unsupported package entry type: ${relativePath}`);
  }
  return result;
}

function manifestString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function entrypointPaths(manifest: PackageManifest): string[] {
  const result: string[] = [];
  for (const [label, value] of [["main", manifest.main], ["module", manifest.module]] as const) {
    if (value !== undefined) result.push(manifestString(value, `manifest.${label}`));
  }
  const extensions = manifest.omp?.extensions;
  if (Array.isArray(extensions)) for (const [index, value] of extensions.entries()) result.push(manifestString(value, `manifest.omp.extensions[${index}]`));
  else if (extensions !== undefined) throw new Error("manifest.omp.extensions must be an array");
  const exportsValue = manifest.exports;
  const visitExports = (value: unknown): void => {
    if (typeof value === "string") {
      result.push(value);
      return;
    }
    if (!value || typeof value !== "object") throw new Error("manifest.exports contains an invalid target");
    for (const nested of Object.values(value as Record<string, unknown>)) visitExports(nested);
  };
  if (exportsValue !== undefined) visitExports(exportsValue);
  return result;
}

async function resolveEntrypoint(root: string, target: string): Promise<string> {
  if (!target.startsWith("./") || target.includes("..")) throw new Error(`entrypoint must be a package-relative path: ${target}`);
  const candidate = resolve(root, target);
  if (!candidate.startsWith(`${root}${sep}`)) throw new Error(`entrypoint escaped extracted package: ${target}`);
  const candidates = [candidate, `${candidate}.ts`, `${candidate}.tsx`, `${candidate}.js`, `${candidate}.mjs`, `${candidate}.json`, join(candidate, "index.ts"), join(candidate, "index.js")];
  for (const path of candidates) {
    try {
      const info = await lstat(path);
      if (info.isFile()) return path;
    } catch {
      // Continue trying the explicit extension candidates.
    }
  }
  throw new Error(`entrypoint does not resolve: ${target}`);
}

async function scanImports(root: string, files: string[], issues: ScanIssue[]): Promise<void> {
  const importPattern = /(?:from\s*|import\s*\(|import\s+)(["'])([^"']+)\1/g;
  for (const relativePath of files) {
    if (!/\.(?:ts|tsx|js|mjs|cjs)$/.test(relativePath)) continue;
    const text = await readFile(join(root, relativePath), "utf8");
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[2];
      if (!specifier?.startsWith(".")) continue;
      const target = resolve(dirname(join(root, relativePath)), specifier);
      if (!target.startsWith(`${root}${sep}`)) {
        issues.push({ kind: "import", path: relativePath, detail: `relative import escapes package: ${specifier}` });
        continue;
      }
      const candidates = [target, `${target}.ts`, `${target}.tsx`, `${target}.js`, `${target}.mjs`, `${target}.json`, join(target, "index.ts"), join(target, "index.js")];
      let found = false;
      for (const candidate of candidates) {
        try {
          if ((await lstat(candidate)).isFile()) {
            found = true;
            break;
          }
        } catch {
          // Continue trying candidates.
        }
      }
      if (!found) issues.push({ kind: "import", path: relativePath, detail: `unresolved relative import: ${specifier}` });
    }
  }
}

export async function scanText(root: string, files: string[], issues: ScanIssue[]): Promise<Record<string, string>> {
  interface JsonStringLiteral {
    start: number;
    end: number;
    value: string;
    fieldPath: string[];
  }

  const parseJsonStringLiterals = (text: string): JsonStringLiteral[] => {
    const literals: JsonStringLiteral[] = [];
    let cursor = 0;
    const skipWhitespace = (): void => {
      while (cursor < text.length && /\s/.test(text[cursor] ?? "")) cursor += 1;
    };
    const parseString = (): { start: number; end: number; value: string } => {
      const start = cursor;
      if (text[cursor] !== '"') throw new Error("expected JSON string");
      cursor += 1;
      let escaped = false;
      while (cursor < text.length) {
        const character = text[cursor] ?? "";
        cursor += 1;
        if (escaped) {
          escaped = false;
          continue;
        }
        if (character === "\\") {
          escaped = true;
          continue;
        }
        if (character === '"') {
          const end = cursor;
          const value = JSON.parse(text.slice(start, end));
          if (typeof value !== "string") throw new Error("JSON string did not decode to a string");
          return { start, end, value };
        }
      }
      throw new Error("unterminated JSON string");
    };
    const parseValue = (fieldPath: string[]): void => {
      skipWhitespace();
      const marker = text[cursor];
      if (marker === '"') {
        const literal = parseString();
        literals.push({ ...literal, fieldPath });
        return;
      }
      if (marker === "{") {
        cursor += 1;
        skipWhitespace();
        if (text[cursor] === "}") {
          cursor += 1;
          return;
        }
        while (cursor < text.length) {
          const key = parseString();
          literals.push({ ...key, fieldPath: [...fieldPath, key.value] });
          skipWhitespace();
          if (text[cursor] !== ":") throw new Error("expected JSON object colon");
          cursor += 1;
          parseValue([...fieldPath, key.value]);
          skipWhitespace();
          if (text[cursor] === "}") {
            cursor += 1;
            return;
          }
          if (text[cursor] !== ",") throw new Error("expected JSON object comma");
          cursor += 1;
          skipWhitespace();
        }
        throw new Error("unterminated JSON object");
      }
      if (marker === "[") {
        cursor += 1;
        skipWhitespace();
        if (text[cursor] === "]") {
          cursor += 1;
          return;
        }
        while (cursor < text.length) {
          parseValue(fieldPath);
          skipWhitespace();
          if (text[cursor] === "]") {
            cursor += 1;
            return;
          }
          if (text[cursor] !== ",") throw new Error("expected JSON array comma");
          cursor += 1;
          skipWhitespace();
        }
        throw new Error("unterminated JSON array");
      }
      const start = cursor;
      while (cursor < text.length && !/[,\]}\s]/.test(text[cursor] ?? "")) cursor += 1;
      if (cursor === start) throw new Error("expected JSON value");
    };
    try {
      parseValue([]);
      skipWhitespace();
      if (cursor !== text.length) throw new Error("trailing JSON input");
      return literals;
    } catch {
      return [];
    }
  };

  const contextWords = (value: string): string[] => value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const hasImmutableIdentifier = (value: string): boolean => contextWords(value).some(word => /^(?:sha\d*|hash|digest|blob|tree|commit)$/.test(word));
  const hasFixtureIdentifier = (value: string): boolean => contextWords(value).some(word => word === "fixture" || word === "fixtures");
  const isImmutableFieldName = (value: string): boolean =>
    /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) && hasImmutableIdentifier(value);
  // Qualification observations carry deterministic public model/step identifiers in these exact fields.
  const qualificationIdentifierFields = new Set([
    "observation.before.combos.models.id",
    "observation.after.combos.models.id",
    "observation.result.body.combos.models.id",
    "observation.result.body.models.id",
    "observation.result.body.results.executionKey",
    "observation.result.body.results.stepId",
    "observation.result.body.resolvedByExecutionKey",
    "observation.result.body.resolvedByTarget.executionKey",
    "observation.result.body.resolvedByTarget.stepId",
  ]);
  const qualificationFixtureIdentifiers = new Set([
    "auto-best-coding-model-1-fixture-chat",
    "created-model-1-fixture-new",
    "delete-model-1-fixture-chat",
    "probe-model-1-fixture-chat",
    "probe-model-2-fixture-text-embedding",
    "quota-protected-model-1-quota-reference",
    "update-model-1-fixture-chat",
    "update-model-1-fixture-updated",
    "virtual-auto-default-1-fixture",
  ]);
  const publicSchemaPropertyNames = new Set(["slaMaxCostPer1MTokens"]);
  const jsonValueHasContext = (relativePath: string, fieldPath: string[], value: string): boolean => {
    const words = fieldPath.flatMap(contextWords);
    if (words.some(word => /^(?:sha\d*|hash|digest|blob|tree|commit)$/.test(word))) return true;
    if (words.some(word => word === "url" || word === "uri" || word === "href")) return true;
    if (hasFixtureIdentifier(fieldPath.join("_"))) return true;
    const leaf = fieldPath[fieldPath.length - 1]?.toLowerCase();
    const parent = fieldPath[fieldPath.length - 2]?.toLowerCase();
    if (relativePath === "provenance/upstreams.json" && leaf === "name" && /^omp-(?:linux-(?:musl-)?|darwin-|windows-)(?:x64|arm64)(?:\.exe)?$/.test(value)) return true;
    if (relativePath === "package.json" && fieldPath.length === 1 && (leaf === "name" || leaf === "version")) return true;
    if (relativePath === "package.json" && (parent === "dependencies" || parent === "devdependencies" || parent === "peerdependencies" || parent === "optionaldependencies")) return true;
    if (words.includes("package") && (words.includes("name") || words.includes("version"))) return true;
    if (relativePath.endsWith(".schema.json") && leaf === "required" && isImmutableFieldName(value)) return true;
    if ((relativePath === "contracts/operations.json" || relativePath === "provenance/route-sources.json")
      && leaf === "example" && parent === "model" && fieldPath[fieldPath.length - 3] === "properties") return true;
    if ((relativePath === "contracts/operations.json" || relativePath === "contracts/release-eligibility.json")
      && fieldPath[fieldPath.length - 2] === "properties"
      && fieldPath.slice(0, -2).includes("schema")
      && publicSchemaPropertyNames.has(value)) return true;
    if (/^provenance\/qualification\/[a-f0-9]{64}\.json$/.test(relativePath)
      && qualificationIdentifierFields.has(fieldPath.join("."))
      && qualificationFixtureIdentifiers.has(value)) return true;
    return false;
  };
  const sourceLiteralHasContext = (text: string, start: number): boolean => {
    const prefix = text.slice(Math.max(0, start - 240), start);
    const candidates: string[] = [];
    for (const pattern of [
      /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*$/,
      /([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*:\s*$/,
      /([A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*)\s*,\s*$/,
    ]) {
      const match = prefix.match(pattern);
      if (match?.[1]) candidates.push(match[1]);
    }
    const declarationMatches = [...prefix.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*[\[{]\s*$/g)];
    const nearestDeclaration = declarationMatches[declarationMatches.length - 1]?.[1];
    if (nearestDeclaration) candidates.push(nearestDeclaration);
    return candidates.some(candidate => hasImmutableIdentifier(candidate) || hasFixtureIdentifier(candidate));
  };
  const immutableSourceFieldPositions = (path: string, text: string): Set<number> => {
    const positions = new Set<number>();
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteral(node) && isImmutableFieldName(node.text)) {
        const parent = node.parent;
        let fieldReference = (ts.isPropertyAssignment(parent) || ts.isPropertySignature(parent)) && parent.name === node;
        if (ts.isArrayLiteralExpression(parent)) {
          let initializer: ts.Node = parent;
          while (ts.isAsExpression(initializer.parent) || ts.isSatisfiesExpression(initializer.parent)
            || ts.isParenthesizedExpression(initializer.parent)) initializer = initializer.parent;
          const owner = initializer.parent;
          fieldReference ||= ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name) && hasImmutableIdentifier(owner.name.text);
          fieldReference ||= ts.isCallExpression(owner) && ts.isIdentifier(owner.expression)
            && owner.expression.text === "assertKeys" && owner.arguments[2] === parent;
        } else if (ts.isLiteralTypeNode(parent)) {
          let type: ts.Node = parent;
          while (ts.isUnionTypeNode(type.parent) || ts.isParenthesizedTypeNode(type.parent)) type = type.parent;
          const owner = type.parent;
          fieldReference ||= ts.isTypeReferenceNode(owner) && ts.isIdentifier(owner.typeName)
            && (owner.typeName.text === "Pick" || owner.typeName.text === "Omit") && owner.typeArguments?.[1] === type;
        }
        if (fieldReference) positions.add(node.getStart(source));
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return positions;
  };

  const hashes: Record<string, string> = {};
  const absolutePathPattern = new RegExp(
    `(?:^|[\\s"'(<[{=:])\\/(?:${["home", "Users"].join("|")})\\/[A-Za-z0-9._~-]+(?:\\/[A-Za-z0-9._~!$&'()*+,;=@%-]+)*`,
    "m",
  );
  const privateTempPathPattern = /(?:^|[\s"'(<[{=:])\/tmp\/private(?:\/|$)/m;
  const credentialNamePattern = [
    ["api", "key"].join("[_-]?"),
    ["access", "token"].join("[_-]?"),
    ["refresh", "token"].join("[_-]?"),
    "authorization",
    "password",
    "passwd",
    "secret",
    "credential",
    ["private", "key"].join("[_-]?"),
    "token",
    "cookie",
  ].join("|");
  const credentialAssignmentPattern = new RegExp(
    `(?<![A-Za-z0-9_$])(?:[A-Za-z0-9_$]*${credentialNamePattern}[A-Za-z0-9_$]*|key)(?![A-Za-z0-9_$])\\s*(?::|=(?![=>]))\\s*(?:"([^"]*)"|'([^']*)')`,
    "gi",
  );
  const unquotedCredentialPattern = new RegExp(
    `(?<![A-Za-z0-9_$])(?:[A-Za-z0-9_$]*${credentialNamePattern}[A-Za-z0-9_$]*|key)(?![A-Za-z0-9_$])\\s*(?::|=(?![=>]))\\s*([A-Za-z0-9][A-Za-z0-9_+/=-]{7,})(?![A-Za-z0-9_$])`,
    "gi",
  );
  const bearerPattern = /\bBearer\s+([A-Za-z0-9][A-Za-z0-9._~+/=-]{7,})\b/gi;
  const literalPattern = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g;

  const isIdentifierReference = (value: string): boolean => /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(value);
  const isNonLiteralReference = (value: string): boolean => isIdentifierReference(value) || value.startsWith("`") || value.startsWith("$");
  const isPlaceholder = (value: string): boolean => {
    const normalized = value.trim();
    return normalized.length === 0
      || /^\$\{[^}\r\n]+\}$/.test(normalized)
      || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)
      || /^<[^>\r\n]+>$/.test(normalized)
      || /^(?:fixture|example|placeholder|redacted|dummy|fake|sample|test|your|replace|change|insert|set)(?:[-_].*)?$/i.test(normalized);
  };
  const hasHighEntropy = (value: string): boolean => {
    const normalized = value.trim();
    if (normalized.length < 20 || isPlaceholder(normalized)) return false;
    if (/\s/.test(normalized)) return false;
    if (/^\^.*\$$/.test(normalized) && /[\[\]{}()*+?]/.test(normalized)) return false;
    if (!/\d/.test(normalized) || /[/:.]/.test(normalized)) return false;
    if (/^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/.test(normalized)) return false;
    if (/^(?:[a-z][a-z0-9+.-]*):\/\//i.test(normalized)) return false;
    if (/^[a-f0-9]{32,}$/i.test(normalized) || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(normalized)) return false;
    const classes = [/[a-z]/, /[A-Z]/, /\d/, /[^A-Za-z0-9]/].filter(pattern => pattern.test(normalized)).length;
    if (classes < 2 || new Set(normalized).size < 10) return false;
    const counts = new Map<string, number>();
    for (const character of normalized) counts.set(character, (counts.get(character) ?? 0) + 1);
    const entropy = [...counts.values()].reduce((sum, count) => {
      const probability = count / normalized.length;
      return sum - probability * Math.log2(probability);
    }, 0);
    return entropy >= 3.5;
  };

  for (const relativePath of files) {
    const bytes = new Uint8Array(await readFile(join(root, relativePath)));
    hashes[relativePath] = createHash("sha256").update(bytes).digest("hex");
    if (bytes.includes(0)) continue;
    let text = new TextDecoder().decode(bytes);
    if (relativePath === "provenance/route-sources.json") text = JSON.stringify(decodeRouteSources(JSON.parse(text)));
    const parsedJsonLiterals = relativePath.endsWith(".json") ? parseJsonStringLiterals(text) : undefined;
    const jsonLiterals = parsedJsonLiterals
      ? new Map<number, JsonStringLiteral>(parsedJsonLiterals.map(literal => [literal.start, literal] as const))
      : undefined;
    const containingJsonLiteral = (position: number): JsonStringLiteral | undefined => {
      if (!parsedJsonLiterals) return undefined;
      let left = 0;
      let right = parsedJsonLiterals.length - 1;
      while (left <= right) {
        const middle = (left + right) >>> 1;
        const literal = parsedJsonLiterals[middle]!;
        if (position < literal.start) right = middle - 1;
        else if (position >= literal.end) left = middle + 1;
        else return literal;
      }
      return undefined;
    };
    if (absolutePathPattern.test(text) || privateTempPathPattern.test(text)) issues.push({ kind: "private-path", path: relativePath, detail: "private filesystem path marker" });
    for (const match of text.matchAll(credentialAssignmentPattern)) {
      const value = match[1] ?? match[2] ?? "";
      if (!isNonLiteralReference(value) && !isPlaceholder(value)) issues.push({ kind: "secret", path: relativePath, detail: "credential-like literal" });
    }
    for (const match of text.matchAll(unquotedCredentialPattern)) {
      const value = match[1] ?? "";
      if (!isNonLiteralReference(value) && !isPlaceholder(value)) issues.push({ kind: "secret", path: relativePath, detail: "credential-like literal" });
    }
    for (const match of text.matchAll(bearerPattern)) {
      const value = match[1] ?? "";
      const literal = containingJsonLiteral(match.index ?? -1);
      const suffixStart = (match.index ?? 0) + match[0].length;
      const suffix = text.slice(suffixStart, suffixStart + 32);
      const prose = relativePath === "provenance/route-sources.json" && literal?.fieldPath.at(-1) === "description"
        && (((value.toLowerCase() === "families" || value.toLowerCase() === "credentials") && /^\s+are\b/.test(suffix))
          || (value.toLowerCase() === "credential" && (/^\s+or\b/.test(suffix) || /^ and an exact JSON model field\./.test(suffix))));
      if (prose) continue;
      if (!isPlaceholder(value)) issues.push({ kind: "secret", path: relativePath, detail: "credential-like bearer literal" });
    }
    let immutableSourceFields: Set<number> | undefined;
    for (const match of text.matchAll(literalPattern)) {
      const value = match[0].slice(1, -1);
      if (!hasHighEntropy(value)) continue;
      const jsonLiteral = jsonLiterals?.get(match.index ?? -1);
      if (jsonLiteral ? jsonValueHasContext(relativePath, jsonLiteral.fieldPath, value) : (!jsonLiterals && sourceLiteralHasContext(text, match.index ?? -1))) continue;
      if (!jsonLiterals && isImmutableFieldName(value)) {
        // A documented JSON field name is public schema, while its value is still scanned.
        if (relativePath.endsWith(".md") && /^\s*:\s*"<[^>\r\n]+>"/.test(text.slice((match.index ?? 0) + match[0].length))) continue;
        immutableSourceFields ??= immutableSourceFieldPositions(relativePath, text);
        if (immutableSourceFields.has(match.index ?? -1)) continue;
      }
      issues.push({ kind: "secret", path: relativePath, detail: "high-entropy secret-like literal" });
    }
  }
  return hashes;
}

function documentationLinks(text: string): string[] {
  const links: string[] = [];
  const pattern = /\]\(([^)\s]+)(?:\s+[^)]*)?\)/g;
  for (const match of text.matchAll(pattern)) {
    const target = match[1];
    if (!target || target.startsWith("#") || target.startsWith("http://") || target.startsWith("https://") || target.startsWith("mailto:")) continue;
    links.push(target.split("#", 1)[0]!);
  }
  return links;
}

async function verifyDocumentation(root: string, files: string[], issues: ScanIssue[]): Promise<void> {
  for (const name of requiredDocs) {
    if (!files.includes(name)) issues.push({ kind: "documentation", path: name, detail: "required package document is missing" });
  }
  for (const relativePath of files.filter(path => path.endsWith(".md"))) {
    const text = await readFile(join(root, relativePath), "utf8");
    for (const target of documentationLinks(text)) {
      const resolvedTarget = resolve(dirname(join(root, relativePath)), target);
      if (!resolvedTarget.startsWith(`${root}${sep}`)) issues.push({ kind: "documentation", path: relativePath, detail: `documentation link escapes package: ${target}` });
      else {
        try {
          if (!(await lstat(resolvedTarget)).isFile()) issues.push({ kind: "documentation", path: relativePath, detail: `documentation link does not resolve: ${target}` });
        } catch {
          issues.push({ kind: "documentation", path: relativePath, detail: `documentation link does not resolve: ${target}` });
        }
      }
    }
  }
}

async function extractPackage(archive: string, destination: string): Promise<{ root: string; entries: string[] }> {
  const python = process.platform === "win32" ? "python" : "python3";
  const output = await command(python, [join(packageRoot, "scripts/package-archive.py"), "extract", archive, destination], packageRoot);
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.stdout);
  } catch {
    throw new Error("portable archive verifier did not return JSON");
  }
  if (!recordValue(parsed) || typeof parsed.root !== "string" || !Array.isArray(parsed.entries)
    || parsed.entries.some(entry => typeof entry !== "string")) {
    throw new Error("portable archive verifier returned an invalid extraction result");
  }
  const extracted = resolve(parsed.root);
  const expectedRoot = resolve(destination, "package");
  if (extracted !== expectedRoot) throw new Error("portable archive verifier returned an unexpected extraction directory");
  const info = await lstat(extracted);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("archive did not extract an ordinary package directory");
  return { root: extracted, entries: parsed.entries as string[] };
}

export function buildSbom(manifest: PackageManifest, lockfile: LockEvidence): Sbom {
  const packageName = manifestString(manifest.name, "manifest.name");
  const packageVersion = manifestString(manifest.version, "manifest.version");
  const rootPurl = packagePurl(packageName, packageVersion);
  const byKey = new Map(lockfile.packages.map(item => [item.key, item]));
  const byPurl = new Map(lockfile.packages.map(item => [item.purl, item]));
  const resolveDependency = (parent: LockPackage | undefined, name: string, spec: unknown): LockPackage => {
    if (typeof spec !== "string") throw new Error(`dependency ${name} has no lock selection`);
    const nested = parent ? byKey.get(`${parent.key}/${name}`) : undefined;
    if (nested) return nested;
    const parentPrefix = parent && parent.key.endsWith(parent.name) ? parent.key.slice(0, -parent.name.length) : "";
    const sibling = parentPrefix ? byKey.get(`${parentPrefix}${name}`) : undefined;
    if (sibling && (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(spec) ? sibling.version === spec : true)) return sibling;
    const root = byKey.get(name);
    if (root && (/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(spec) ? root.version === spec : true)) return root;
    const exact = lockfile.packages.filter(item => item.name === name && item.version === spec);
    if (exact.length === 1) return exact[0]!;
    throw new Error(`bun.lock dependency edge is ambiguous or unresolved: ${parent?.key ?? "<root>"} -> ${name}@${spec}`);
  };
  const component = [...byPurl.values()].map(item => {
    const hash = item.integrity.startsWith("sha512-")
      ? { alg: "SHA-512" as const, content: Buffer.from(item.integrity.slice("sha512-".length), "base64").toString("hex") }
      : item.integrity.startsWith("sha256-")
        ? { alg: "SHA-256" as const, content: Buffer.from(item.integrity.slice("sha256-".length), "base64").toString("hex") }
        : { alg: "SHA-256" as const, content: item.integrity };
    return {
      type: "library" as const,
      name: item.name,
      version: item.version,
      purl: item.purl,
      hashes: [hash],
      properties: [
        { name: "bun:resolution", value: item.resolution },
        { name: "bun:integrity", value: item.integrity },
      ],
    };
  });
  const declaredEntries = Object.entries({
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
    ...(manifest.peerDependencies ?? {}),
    ...(manifest.optionalDependencies ?? {}),
  });
  const edgeMap = new Map<string, Set<string>>([[rootPurl, new Set(declaredEntries.map(([name, spec]) => resolveDependency(undefined, name, spec).purl))]]);
  for (const item of lockfile.packages) {
    const edges = edgeMap.get(item.purl) ?? new Set<string>();
    for (const [name, spec] of Object.entries(item.dependencies)) edges.add(resolveDependency(item, name, spec).purl);
    edgeMap.set(item.purl, edges);
  }
  const dependencies = [...edgeMap.entries()].map(([ref, edges]) => ({ ref, dependsOn: [...edges].sort() }));
  const componentRefs = new Set([rootPurl, ...component.map(item => item.purl)]);
  for (const edge of dependencies) {
    if (!componentRefs.has(edge.ref) || edge.dependsOn.some(reference => !componentRefs.has(reference))) throw new Error(`SBOM contains an unresolved component reference from ${edge.ref}`);
  }
  const uuid = `${lockfile.sha256.slice(0, 8)}-${lockfile.sha256.slice(8, 12)}-5${lockfile.sha256.slice(13, 16)}-a${lockfile.sha256.slice(17, 20)}-${lockfile.sha256.slice(20, 32)}`;
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    version: 1,
    serialNumber: `urn:uuid:${uuid}`,
    metadata: { component: { type: "library", name: packageName, version: packageVersion, purl: rootPurl, properties: [
      { name: "cruxomni:bun-lock-sha256", value: lockfile.sha256 },
      { name: "cruxomni:bun-lock-version", value: String(lockfile.lockfileVersion) },
    ] } },
    components: component,
    dependencies,
  };
}

export interface PackageVerificationResult {
  status: "verified";
  archiveSha256: string;
  archive: string;
  extractedRoot: string;
  entries: string[];
  fileSha256: Record<string, string>;
  lockfile: LockEvidence;
  sbom: Sbom;
}

export async function verifyPackage(options: { keepTemporary?: boolean; archivePath?: string; expectedArchiveSha256?: string } = {}): Promise<PackageVerificationResult> {
  const suppliedArchive = options.archivePath !== undefined;
  const suppliedDigest = options.expectedArchiveSha256 !== undefined;
  if (suppliedArchive !== suppliedDigest) throw new Error("archivePath and expectedArchiveSha256 must be provided together");
  if (options.expectedArchiveSha256 !== undefined && !/^[0-9a-f]{64}$/.test(options.expectedArchiveSha256)) {
    throw new Error("expectedArchiveSha256 must be a lowercase SHA-256 digest");
  }
  const sourceManifest = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as PackageManifest;
  const lockfile = await readBunLock(sourceManifest);
  const sbom = buildSbom(sourceManifest, lockfile);
  const temporaryRoot = await mkdtemp(join(tmpdir(), "cruxomni-package-"));
  const packRoot = join(temporaryRoot, "pack");
  const extractRoot = join(temporaryRoot, "extract");
  await mkdir(packRoot, { recursive: true });
  await mkdir(extractRoot, { recursive: true });
  try {
    let archive: string;
    if (options.archivePath !== undefined) {
      const inputArchive = resolve(options.archivePath);
      const inputInfo = await lstat(inputArchive).catch(() => undefined);
      if (!inputInfo?.isFile() || inputInfo.isSymbolicLink()) throw new Error("caller package archive must be a regular non-symlink file");
      if (inputInfo.size > maxPackageArchiveBytes) throw new Error(`caller package archive exceeds ${maxPackageArchiveBytes} bytes`);
      const noFollow = process.platform === "win32" ? 0 : (fsConstants.O_NOFOLLOW ?? 0);
      const inputHandle = await open(inputArchive, fsConstants.O_RDONLY | noFollow);
      let inputBytes: Buffer;
      try {
        const openedInfo = await inputHandle.stat();
        if (!openedInfo.isFile() || openedInfo.size > maxPackageArchiveBytes) throw new Error("opened caller package archive is not a bounded regular file");
        inputBytes = await inputHandle.readFile();
      } finally {
        await inputHandle.close();
      }
      if (inputBytes.byteLength > maxPackageArchiveBytes) throw new Error(`caller package archive exceeds ${maxPackageArchiveBytes} bytes`);
      const inputDigest = createHash("sha256").update(inputBytes).digest("hex");
      if (inputDigest !== options.expectedArchiveSha256) throw new Error("caller package archive SHA-256 does not match expectedArchiveSha256");
      archive = join(packRoot, "verified-input.tgz");
      await writeFile(archive, inputBytes, { flag: "wx" });
      if (createHash("sha256").update(await readFile(archive)).digest("hex") !== options.expectedArchiveSha256) {
        throw new Error("copied package archive SHA-256 changed while staging verification");
      }
    } else {
      archive = (await packPackage(packRoot)).archive;
    }
    const archiveBytes = new Uint8Array(await readFile(archive));
    const extracted = await extractPackage(archive, extractRoot);
    const extractedRoot = extracted.root;
    const files = (await walk(extractedRoot)).sort();
    if (JSON.stringify(files) !== JSON.stringify(extracted.entries)) throw new Error("portable archive extraction inventory differs from files on disk");
    const issues: ScanIssue[] = [];
    for (const relativePath of files) if (!isAllowed(relativePath)) issues.push({ kind: "allowlist", path: relativePath, detail: "file is outside package allowlist" });
    const manifest = JSON.parse(await readFile(join(extractedRoot, "package.json"), "utf8")) as PackageManifest;
    const targets = entrypointPaths(manifest);
    for (const target of targets) {
      try {
        await resolveEntrypoint(extractedRoot, target);
      } catch (error) {
        issues.push({ kind: "entrypoint", path: target, detail: error instanceof Error ? error.message : String(error) });
      }
    }
    await scanImports(extractedRoot, files, issues);
    const fileSha256 = await scanText(extractedRoot, files, issues);
    await verifyDocumentation(extractedRoot, files, issues);
    if (issues.length > 0) throw new Error(`package verification failed:\n${issues.map(issue => `${issue.kind}: ${issue.path}: ${issue.detail}`).join("\n")}`);
    if (manifest.name !== sourceManifest.name || manifest.version !== sourceManifest.version) {
      throw new Error("packed package name and version must exactly match the reviewed source manifest");
    }
    if (manifest.packageManager !== sourceManifest.packageManager) throw new Error("packed package manifest packageManager does not match the reviewed source manifest");
    return {
      status: "verified",
      archiveSha256: createHash("sha256").update(archiveBytes).digest("hex"),
      archive,
      extractedRoot,
      entries: files,
      fileSha256,
      lockfile,
      sbom,
    };
  } finally {
    if (!options.keepTemporary && process.env.VERIFY_PACKAGE_KEEP !== "1") await rm(temporaryRoot, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  verifyPackage({ keepTemporary: process.env.VERIFY_PACKAGE_KEEP === "1" })
    .then(result => {
      const { archive: _archive, extractedRoot: _extractedRoot, ...sanitized } = result;
      process.stdout.write(`${JSON.stringify(sanitized, null, 2)}\n`);
    })
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
