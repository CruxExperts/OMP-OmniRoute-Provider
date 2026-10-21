import { createHash, randomUUID } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { isMuslTarget, muslRuntimeProvenanceSha256, muslTargetProvenance, sortMuslInventory, validateMuslRuntimeEvidence, type MuslInventoryEntry } from "./musl-runtime.ts";
import { GITHUB_REPOSITORY, REPOSITORY_SLUG } from "../src/identity.ts";

const execFileAsync = promisify(execFile);
const root = resolve(import.meta.dir, "..");
const releaseProvenance = object(JSON.parse(readFileSync(join(root, "provenance/release-artifacts.json"), "utf8")), "release artifact provenance");
const pinnedOmpAssets = Array.isArray(releaseProvenance.artifacts)
  ? releaseProvenance.artifacts.map((value, index) => object(value, `provenance artifact ${index}`))
  : [];
const upstreamProvenance = object(JSON.parse(readFileSync(join(root, "provenance/upstreams.json"), "utf8")), "upstream provenance");
if (!Array.isArray(upstreamProvenance.upstreams)) throw new Error("Missing pinned upstreams");
const ompPins = upstreamProvenance.upstreams.filter(value => object(value, "upstream").id === "omp");
if (ompPins.length !== 1) throw new Error("Expected exactly one pinned OMP upstream");
const ompPin = object(ompPins[0], "OMP upstream");
const ompRelease = object(ompPin.release, "OMP release");
const pinnedOmpVersion = nonempty(ompRelease.version, "OMP version");
const pinnedOmpTag = nonempty(ompRelease.tag, "OMP tag");
if (!/^\d+\.\d+\.\d+$/.test(pinnedOmpVersion) || pinnedOmpTag !== `v${pinnedOmpVersion}`) throw new Error("Invalid pinned OMP release identity");
const maxArchiveBytes = 512 * 1024 * 1024;
const maxOmpBytes = 256 * 1024 * 1024;
const targets = {
  "linux-x64-glibc": { os: "linux", architecture: "x64", libc: "glibc", asset: "omp-linux-x64" },
  "linux-arm64-glibc": { os: "linux", architecture: "arm64", libc: "glibc", asset: "omp-linux-arm64" },
  "linux-x64-musl": { os: "linux", architecture: "x64", libc: "musl", asset: "omp-linux-musl-x64" },
  "linux-arm64-musl": { os: "linux", architecture: "arm64", libc: "musl", asset: `omp-linux-musl-${"arm64"}` },
  "darwin-x64": { os: "darwin", architecture: "x64", libc: null, asset: "omp-darwin-x64" },
  "darwin-arm64": { os: "darwin", architecture: "arm64", libc: null, asset: "omp-darwin-arm64" },
  "windows-x64": { os: "windows", architecture: "x64", libc: null, asset: "omp-windows-x64.exe" },
  "windows-arm64": { os: "windows", architecture: "arm64", libc: null, asset: "omp-windows-arm64.exe" },
} as const;
type TargetId = keyof typeof targets;
type JsonRecord = Record<string, unknown>;

function object(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonRecord;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{64}$/.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}

async function regularFile(path: string, maximumBytes: number, label: string): Promise<Buffer> {
  const info = await lstat(path).catch(() => undefined);
  if (!info?.isFile() || info.isSymbolicLink() || info.size > maximumBytes) throw new Error(`${label} must be a bounded regular non-symlink file`);
  const bytes = await readFile(path);
  if (bytes.byteLength > maximumBytes) throw new Error(`${label} exceeds its byte limit`);
  return bytes;
}

async function releaseArtifacts(directory: string): Promise<{ manifest: JsonRecord; archivePath: string; archiveName: string; archiveSha256: string }> {
  const manifestPath = join(directory, "release-manifest.json");
  const manifest = object(JSON.parse((await regularFile(manifestPath, 1024 * 1024, "release manifest")).toString("utf8")), "release manifest");
  const version = nonempty(manifest.version, "release version");
  if (!/^\d+\.\d+\.\d+$/.test(version) || manifest.package !== "@cruxexperts/cruxomni-omp-client") throw new Error("qualification package has an unexpected name or version");
  const sourceRevision = nonempty(manifest.sourceRevision, "release source revision");
  if (!/^[0-9a-f]{40}$/.test(sourceRevision) || sourceRevision !== process.env.GITHUB_SHA) throw new Error("qualification package source revision does not match this workflow run");
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== 5) throw new Error("qualification package manifest must contain exactly five artifacts");
  const artifacts = manifest.artifacts.map((value, index) => object(value, `release artifact ${index}`));
  const artifactNames = artifacts.map((value, index) => {
    const name = nonempty(value.name, `release artifact ${index} name`);
    if (name !== basename(name) || name.includes("\\") || name === "." || name === "..") throw new Error("release artifact manifest contains an unsafe filename");
    digest(value.sha256, `release artifact ${name} SHA-256`);
    return name;
  });
  if (new Set(artifactNames).size !== artifactNames.length) throw new Error("release artifact manifest contains duplicate names");
  const packageName = `cruxexperts-cruxomni-omp-client-${version}.tgz`;
  const expectedNames = new Set([
    packageName,
    `${REPOSITORY_SLUG}-v${version}-source.tar.gz`,
    `${REPOSITORY_SLUG}-v${version}-graphics.zip`,
    `${REPOSITORY_SLUG}-v${version}.cdx.json`,
    `${REPOSITORY_SLUG}-v${version}-release-notes.md`,
  ]);
  if (artifactNames.some(name => !expectedNames.delete(name)) || expectedNames.size !== 0) throw new Error("release manifest does not contain the exact five versioned release artifacts");
  const packageMatches = artifacts.filter(value => value.name === packageName);
  if (packageMatches.length !== 1) throw new Error("release manifest must contain exactly one versioned npm archive");
  const archiveName = packageName;
  const archiveSha256 = digest(packageMatches[0]!.sha256, "release npm archive SHA-256");
  const archivePath = join(directory, archiveName);
  const archiveInfo = await lstat(archivePath).catch(() => undefined);
  if (!archiveInfo?.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size > maxArchiveBytes) throw new Error("manifest npm archive must be a bounded regular non-symlink file");
  const archiveBytes = await readFile(archivePath);
  if (await sha256(archiveBytes) !== archiveSha256) throw new Error("manifest npm archive bytes do not match their recorded SHA-256");
  const sumsBytes = await regularFile(join(directory, "SHA256SUMS.txt"), 16 * 1024, "release checksum manifest");
  const sumLines = sumsBytes.toString("utf8").trimEnd().split(/\r?\n/);
  const expectedSums = new Map(artifacts.map(value => [String(value.name), String(value.sha256)]));
  if (sumLines.length !== expectedSums.size) throw new Error("release checksum manifest does not cover exactly the five artifacts");
  for (const line of sumLines) {
    const match = /^([0-9a-f]{64})  ([^/\\]+)$/.exec(line);
    if (!match || expectedSums.get(match[2]!) !== match[1]) throw new Error("release checksum manifest differs from the artifact manifest");
    expectedSums.delete(match[2]!);
  }
  if (expectedSums.size !== 0) throw new Error("release checksum manifest is missing a manifest-listed artifact");
  const actual = (await readdir(directory, { withFileTypes: true })).map(entry => {
    if (!entry.isFile()) throw new Error(`qualification package directory contains a non-file: ${entry.name}`);
    return entry.name;
  }).sort();
  const expected = [...artifacts.map(value => nonempty(value.name, "release artifact name")), "release-manifest.json", "SHA256SUMS.txt"].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error("qualification package directory differs from the exact release artifact manifest");
  for (const artifact of artifacts) {
    const name = nonempty(artifact.name, "release artifact name");
    const bytes = await regularFile(join(directory, name), maxArchiveBytes, `release artifact ${name}`);
    if (await sha256(bytes) !== artifact.sha256) throw new Error(`release artifact bytes differ from the manifest: ${name}`);
  }
  return { manifest, archivePath, archiveName, archiveSha256 };
}

async function producerMetadata(jobName: string): Promise<JsonRecord> {
  const repository = nonempty(process.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY");
  const runId = nonempty(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID");
  const workflowPath = ".github/workflows/qualification.yml";
  const workflowName = "release-qualification";
  const workflowSha256 = await sha256(await readFile(join(root, workflowPath)));
  if (!/^\d+$/.test(runId) || repository !== GITHUB_REPOSITORY) throw new Error("qualification producer must be the canonical repository workflow run");
  return { repository, runId, workflowPath, workflowName, workflowSha256, jobName };
}

async function fetchPinned(url: string, maximumBytes: number): Promise<Buffer> {
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: "follow" });
  if (!response.ok) throw new Error(`pinned upstream download failed with HTTP ${response.status}`);
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > maximumBytes) throw new Error("pinned upstream response exceeds its byte limit");
  if (!response.body) throw new Error("pinned upstream response has no body");
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximumBytes) {
        await reader.cancel();
        throw new Error("pinned upstream response exceeds its byte limit");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  if (total === 0) throw new Error("pinned upstream response is empty");
  return Buffer.concat(chunks, total);
}

async function downloadOmp(target: TargetId, destination: string): Promise<string> {
  const expectedHost = targets[target];
  const matches = pinnedOmpAssets
    .filter(value => value.upstream === "omp" && value.kind === "release_asset" && value.release_tag === pinnedOmpTag && typeof value.url === "string" && new URL(value.url).pathname.endsWith(`/${expectedHost.asset}`));
  if (matches.length !== 1) throw new Error(`provenance must contain one pinned OMP ${pinnedOmpVersion} asset for ${target}`);
  const asset = matches[0]!;
  const binaryDigest = digest(asset.sha256, `${target} OMP binary digest`);
  const checksumDigest = digest(asset.checksums_sha256, `${target} OMP checksum-file digest`);
  const checksumsUrl = nonempty(asset.checksums_url, `${target} OMP checksums URL`);
  if (new URL(checksumsUrl).hostname !== "github.com" || new URL(checksumsUrl).protocol !== "https:") throw new Error("OMP checksum URL must use HTTPS GitHub releases");
  const sums = await fetchPinned(checksumsUrl, 2 * 1024 * 1024);
  if (await sha256(sums) !== checksumDigest) throw new Error("downloaded OMP checksums file differs from the provenance digest");
  const checksumLines = sums.toString("utf8").split(/\r?\n/).filter(line => line.trim().length > 0);
  const escapedAsset = expectedHost.asset.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const listed = checksumLines.filter(line => new RegExp(`^([0-9a-f]{64})\\s+\\*?${escapedAsset}$`).test(line.trim()));
  if (listed.length !== 1 || listed[0]!.trim().split(/\s+/)[0] !== binaryDigest) throw new Error("OMP upstream checksum file does not name the exact provenance binary digest");
  const assetUrl = new URL(nonempty(asset.url, `${target} OMP asset URL`));
  if (assetUrl.protocol !== "https:" || assetUrl.hostname !== "github.com") throw new Error("OMP asset URL must use HTTPS GitHub releases");
  const binary = await fetchPinned(assetUrl.toString(), maxOmpBytes);
  if (await sha256(binary) !== binaryDigest) throw new Error("downloaded OMP binary differs from the provenance digest");
  const path = join(destination, expectedHost.asset);
  await writeFile(path, binary, { flag: "wx", mode: process.platform === "win32" ? undefined : 0o755 });
  if (process.platform !== "win32") await chmod(path, 0o755);
  return path;
}

function normalizedArchitecture(value: string): "x64" | "arm64" | undefined {
  if (["x64", "x86_64", "amd64", "X64"].includes(value)) return "x64";
  if (["arm64", "aarch64", "ARM64"].includes(value)) return "arm64";
  return undefined;
}

type DockerOptions = { cwd?: string; timeout?: number; maxBuffer?: number; signal?: AbortSignal; onOutput?: (stream: "stdout" | "stderr", chunk: Buffer) => void };
type DockerRunner = (args: string[], options?: DockerOptions) => Promise<string>;

export class DockerCommandError extends Error {
  constructor(
    message: string,
    readonly stdout: string,
    readonly stderr: string,
    readonly exitCode: number | null,
    readonly termination: "exit" | "timeout" | "interrupted" | "output-limit" | "spawn-error",
  ) {
    super(message);
    this.name = "DockerCommandError";
  }
}

export async function runBoundedQualificationCommand(executable: string, commandArgs: string[], options: DockerOptions = {}): Promise<string> {
  const maxBuffer = options.maxBuffer ?? 16 * 1024 * 1024;
  const timeoutMs = options.timeout ?? 20 * 60 * 1000;
  const signal = options.signal;
  if (!Number.isSafeInteger(maxBuffer) || maxBuffer < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) throw new Error("qualification command requires bounded output and timeout limits");
  if (signal?.aborted) throw new DockerCommandError(`${executable} command was interrupted before launch`, "", "", null, "interrupted");
  return await new Promise<string>((resolvePromise, rejectPromise) => {
    const child = spawn(executable, commandArgs, {
      cwd: options.cwd ?? root,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let retainedBytes = 0;
    let timedOut = false;
    let interrupted = false;
    let outputLimited = false;
    let settled = false;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const terminate = (): void => {
      child.kill("SIGTERM");
      if (escalation === undefined) {
        escalation = setTimeout(() => child.kill("SIGKILL"), 2_000);
      }
    };
    const onAbort = (): void => {
      interrupted = true;
      terminate();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    const cleanup = (): void => {
      clearTimeout(timer);
      if (escalation !== undefined) clearTimeout(escalation);
      signal?.removeEventListener("abort", onAbort);
    };
    const output = (chunks: Buffer[]): string => Buffer.concat(chunks).toString("utf8");
    const fail = (error: DockerCommandError): void => {
      if (settled) return;
      settled = true;
      cleanup();
      rejectPromise(error);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const retain = (stream: "stdout" | "stderr", chunk: Buffer): void => {
      if (outputLimited || settled) return;
      const remaining = maxBuffer - retainedBytes;
      const kept = Buffer.from(chunk.subarray(0, remaining));
      if (kept.byteLength > 0) {
        (stream === "stdout" ? stdout : stderr).push(kept);
        retainedBytes += kept.byteLength;
        options.onOutput?.(stream, kept);
      }
      if (chunk.byteLength > remaining) {
        outputLimited = true;
        terminate();
      }
    };
    child.stdout.on("data", (chunk: Buffer) => retain("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => retain("stderr", chunk));
    child.on("error", error => {
      fail(new DockerCommandError(`${executable} ${commandArgs[0] ?? "command"} could not start: ${error.message}`, output(stdout), output(stderr), null, "spawn-error"));
    });
    child.on("close", (code, childSignal) => {
      if (settled) return;
      const stdoutText = output(stdout);
      const stderrText = output(stderr);
      if (timedOut || interrupted || outputLimited || code !== 0) {
        const termination = timedOut ? "timeout" : interrupted ? "interrupted" : outputLimited ? "output-limit" : "exit";
        const detail = stderrText.trim().slice(-4_000);
        const state = timedOut ? "timed out" : interrupted ? "was interrupted" : outputLimited ? "exceeded its output limit" : `failed (${code ?? childSignal ?? "unknown"})`;
        fail(new DockerCommandError(`${executable} ${commandArgs[0] ?? "command"} ${state}${detail ? `: ${detail}` : ""}`, stdoutText, stderrText, code, termination));
        return;
      }
      settled = true;
      cleanup();
      resolvePromise(stdoutText.trim());
    });
  });
}

export const runQualificationDockerCommand = (commandArgs: string[], options: DockerOptions = {}): Promise<string> => runBoundedQualificationCommand("docker", commandArgs, options);
const docker = runQualificationDockerCommand;

export function createQualificationInterruptSignal(): { signal: AbortSignal; interrupted: () => string | undefined; dispose: () => void } {
  const controller = new AbortController();
  let received: string | undefined;
  const onInterrupt = (name: "SIGINT" | "SIGTERM"): void => {
    received = name;
    controller.abort(new Error(`received ${name}`));
  };
  const onSigint = (): void => onInterrupt("SIGINT");
  const onSigterm = (): void => onInterrupt("SIGTERM");
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  return {
    signal: controller.signal,
    interrupted: () => received,
    dispose: () => {
      process.removeListener("SIGINT", onSigint);
      process.removeListener("SIGTERM", onSigterm);
    },
  };
}

function gitSnapshotEnvironment(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_COUNT: "0",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ATTR_NOSYSTEM: "1",
  };
}

export async function createQualificationSourceSnapshot(sourceRoot: string, expectedRevision: string, destination: string, signal?: AbortSignal): Promise<string> {
  const revision = expectedRevision;
  if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("qualification source revision must be a full Git commit ID");
  const source = resolve(sourceRoot);
  const target = resolve(destination);
  if (source === target || target.startsWith(`${source}/`) || source.startsWith(`${target}/`)) throw new Error("qualification source snapshot must use an isolated directory");
  const destinationInfo = await lstat(target).catch(() => undefined);
  if (destinationInfo) throw new Error("qualification source snapshot destination must not exist yet");
  const env = gitSnapshotEnvironment();
  const git = async (cwd: string, args: string[], timeout = 120_000): Promise<string> => {
    const result = await execFileAsync("git", args, { cwd, env, timeout, maxBuffer: 4 * 1024 * 1024, signal });
    return result.stdout.trim();
  };
  const current = await git(source, ["rev-parse", "--verify", "HEAD^{commit}"]);
  if (current !== revision) throw new Error("qualification source checkout HEAD does not match the prepared package");
  const template = await mkdtemp(join(tmpdir(), "cruxomni-git-template-"));
  const isolatedHome = await mkdtemp(join(tmpdir(), "cruxomni-git-home-"));
  env.HOME = isolatedHome;
  try {
    await mkdir(target, { recursive: true });
    await git(dirname(target), ["init", "--quiet", `--template=${template}`, target]);
    await git(target, ["-c", "protocol.file.allow=always", "fetch", "--depth=1", "--no-tags", pathToFileURL(source).toString(), revision], 5 * 60 * 1000);
    const fetched = await git(target, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"]);
    if (fetched !== revision) throw new Error("qualification source fetch did not resolve the expected Git commit");
    await git(target, ["checkout", "--force", "--detach", "FETCH_HEAD"]);
    const gitDirectory = await git(target, ["rev-parse", "--absolute-git-dir"]);
    if (resolve(gitDirectory) !== join(target, ".git")) throw new Error("qualification source clone must have a private ordinary .git directory");
    const configPath = join(gitDirectory, "config");
    const configInfo = await lstat(configPath).catch(() => undefined);
    if (!configInfo?.isFile() || configInfo.isSymbolicLink()) throw new Error("qualification source clone Git config must be a regular file");
    await writeFile(configPath, "[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = false\n\tlogallrefupdates = true\n", { mode: 0o600 });
    const sanitizedConfigKeys = await git(target, ["config", "--local", "--name-only", "--list"]);
    if (sanitizedConfigKeys.split(/\r?\n/).some(key => key !== "core.repositoryformatversion" && key !== "core.filemode" && key !== "core.bare" && key !== "core.logallrefupdates")) {
      throw new Error("qualification source clone retained unexpected Git configuration");
    }
    if (await git(target, ["remote"]) !== "") throw new Error("qualification source clone must not retain remotes");
    const alternatesPath = join(gitDirectory, "objects", "info", "alternates");
    if (await lstat(alternatesPath).catch(() => undefined)) throw new Error("qualification source clone must not retain object alternates");
    if (await git(target, ["rev-parse", "--is-shallow-repository"]) !== "true" || await git(target, ["rev-list", "--count", "HEAD"]) !== "1") {
      throw new Error("qualification source clone must contain only the shallow expected commit");
    }
    if (await git(target, ["rev-parse", "HEAD"]) !== revision || await git(target, ["status", "--porcelain=v1", "--untracked-files=all"]) !== "") {
      throw new Error("qualification source snapshot is not a clean checkout of the expected commit");
    }
    const committed = await git(target, ["ls-tree", "-rz", "--full-tree", "HEAD"]);
    const expectedFiles = new Map<string, string>();
    for (const entry of committed.split("\0").filter(Boolean)) {
      const match = /^(100644|100755) blob ([0-9a-f]{40})\t(.+)$/.exec(entry);
      if (!match) throw new Error("qualification source commit contains a non-regular or unsupported tracked entry");
      const path = match[3]!;
      if (path.startsWith("/") || path.includes("\\") || path.split("/").some(part => part === "" || part === "." || part === "..")) {
        throw new Error("qualification source commit contains an unsafe tracked path");
      }
      expectedFiles.set(path, match[2]!);
    }
    const actualFiles: string[] = [];
    const visit = async (directory: string, prefix = ""): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (prefix === "" && entry.name === ".git") continue;
        const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        const path = join(directory, entry.name);
        const info = await lstat(path);
        if (info.isSymbolicLink()) throw new Error(`qualification source snapshot contains a symbolic link: ${relativePath}`);
        if (info.isDirectory()) await visit(path, relativePath);
        else if (info.isFile()) actualFiles.push(relativePath);
        else throw new Error(`qualification source snapshot contains an unsupported filesystem entry: ${relativePath}`);
      }
    };
    await visit(target);
    actualFiles.sort();
    const expectedPaths = [...expectedFiles.keys()].sort();
    if (JSON.stringify(actualFiles) !== JSON.stringify(expectedPaths)) throw new Error("qualification source snapshot files do not match the exact committed tree");
    for (const [path, expectedBlob] of expectedFiles) {
      const bytes = await readFile(join(target, ...path.split("/")));
      const actualBlob = createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
      if (actualBlob !== expectedBlob) throw new Error(`qualification source snapshot bytes differ from the committed tree: ${path}`);
    }
    for (const privatePath of [".agents", ".env", ".gitconfig", ".bash_history", ".zsh_history"]) {
      if (await lstat(join(target, privatePath)).catch(() => undefined)) throw new Error(`qualification source snapshot contains private ignored state: ${privatePath}`);
    }
    return target;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(template, { recursive: true, force: true });
    await rm(isolatedHome, { recursive: true, force: true });
  }
}

export async function prepareQualificationDependencyMount(sourceSnapshot: string): Promise<string> {
  const snapshot = resolve(sourceSnapshot);
  const dependencyMount = join(snapshot, "node_modules");
  if (await lstat(dependencyMount).catch(() => undefined)) {
    throw new Error("qualification source snapshot already contains a node_modules path");
  }
  await mkdir(dependencyMount, { mode: 0o755 });
  const info = await lstat(dependencyMount);
  if (!info.isDirectory() || info.isSymbolicLink() || (await readdir(dependencyMount)).length !== 0) {
    throw new Error("qualification dependency mount point must be a new empty directory");
  }
  return dependencyMount;
}

const ownerLabel = "io.cruxexperts.cruxomni.musl-owner";
export type OwnedMuslDockerResources = {
  containerName: string;
  ownerToken: string;
  cidFile: string;
  imageTag: string;
  imageId?: string;
  imageTagOwned: boolean;
};

async function listedDockerIds(args: string[], dockerRunner: DockerRunner): Promise<string[]> {
  const output = await dockerRunner(args, { timeout: 15_000, maxBuffer: 64 * 1024 });
  return output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

async function removeOwnedMuslContainer(resources: OwnedMuslDockerResources, dockerRunner: DockerRunner): Promise<void> {
  if (!/^cruxomni-musl-(?:x64|arm64)-[a-f0-9-]{36}$/.test(resources.containerName)
    || !/^[a-f0-9-]{36}$/.test(resources.ownerToken)) throw new Error("refusing cleanup for a container without a task-owned identity");
  const cidInfo = await lstat(resources.cidFile).catch(() => undefined);
  if (cidInfo && (!cidInfo.isFile() || cidInfo.isSymbolicLink())) throw new Error("task-owned Docker cidfile is not a regular file");
  const cid = cidInfo ? (await readFile(resources.cidFile, "utf8")).trim() : undefined;
  if (cid !== undefined && !/^[a-f0-9]{64}$/.test(cid)) throw new Error("task-owned Docker cidfile has an invalid container ID");
  const containerIds = await listedDockerIds(["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `name=^/${resources.containerName}$`], dockerRunner);
  if (containerIds.length === 0) {
    if (cid !== undefined) {
      const byId = await listedDockerIds(["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `id=${cid}`], dockerRunner);
      if (byId.length !== 0) throw new Error("task-owned Docker cidfile still points to a container without its exact owned name");
    }
    return;
  }
  if (containerIds.length !== 1 || !/^[a-f0-9]{64}$/.test(containerIds[0]!)) throw new Error("task-owned Docker container lookup was ambiguous");
  const containerId = containerIds[0]!;
  if (cid !== undefined && cid !== containerId) throw new Error("task-owned Docker cidfile does not match the named container");
  const inspect = await dockerRunner([
    "container", "inspect", "--format",
    `{{.Id}}|{{.Name}}|{{.State.Running}}|{{index .Config.Labels "${ownerLabel}"}}`, containerId,
  ], { timeout: 15_000, maxBuffer: 64 * 1024 });
  const [observedId, observedName, running, observedOwner] = inspect.split("|");
  if (observedId !== containerId || observedName !== `/${resources.containerName}` || observedOwner !== resources.ownerToken || !["true", "false"].includes(running ?? "")) {
    throw new Error("refusing to clean a Docker container without the exact task-owned name and label");
  }
  if (running === "true") {
    try { await dockerRunner(["container", "stop", "--time", "10", containerId], { timeout: 15_000, maxBuffer: 64 * 1024 }); }
    catch { /* Reinspect below and escalate only while this exact owned container still runs. */ }
  }
  const afterStop = await dockerRunner([
    "container", "inspect", "--format", `{{.Id}}|{{.Name}}|{{.State.Running}}|{{index .Config.Labels "${ownerLabel}"}}`, containerId,
  ], { timeout: 15_000, maxBuffer: 64 * 1024 });
  const [stoppedId, stoppedName, stillRunning, stoppedOwner] = afterStop.split("|");
  if (stoppedId !== containerId || stoppedName !== `/${resources.containerName}` || stoppedOwner !== resources.ownerToken) {
    throw new Error("task-owned Docker container identity changed during cleanup");
  }
  if (stillRunning === "true") await dockerRunner(["container", "kill", "--signal", "KILL", containerId], { timeout: 15_000, maxBuffer: 64 * 1024 });
  await dockerRunner(["container", "rm", "--force", containerId], { timeout: 15_000, maxBuffer: 64 * 1024 });
  const remaining = await listedDockerIds(["container", "ls", "--all", "--quiet", "--no-trunc", "--filter", `name=^/${resources.containerName}$`], dockerRunner);
  if (remaining.length !== 0) throw new Error("task-owned Docker container was not removed before releasing mounted paths");
}

async function removeOwnedMuslImageTag(resources: OwnedMuslDockerResources, dockerRunner: DockerRunner): Promise<void> {
  if (!resources.imageTagOwned) return;
  if (!/^cruxomni-musl-(?:x64|arm64):[a-f0-9-]{36}$/.test(resources.imageTag)) throw new Error("refusing cleanup for an image without a task-owned tag");
  const imageIds = await listedDockerIds(["image", "ls", "--quiet", "--no-trunc", resources.imageTag], dockerRunner);
  if (imageIds.length === 0) return;
  if (imageIds.length !== 1 || !/^sha256:[0-9a-f]{64}$/.test(imageIds[0]!)) throw new Error("task-owned Docker image tag has an ambiguous identity");
  if (resources.imageId !== undefined && imageIds[0] !== resources.imageId) throw new Error("task-owned Docker image tag no longer refers to its recorded image");
  resources.imageId = imageIds[0]!;
  await dockerRunner(["image", "rm", resources.imageTag], { timeout: 15_000, maxBuffer: 64 * 1024 });
  const remaining = await listedDockerIds(["image", "ls", "--quiet", "--no-trunc", resources.imageTag], dockerRunner);
  if (remaining.length !== 0) throw new Error("task-owned Docker image tag was not removed");
}

export async function runOwnedMuslDockerTask<T>(
  resources: OwnedMuslDockerResources,
  operation: () => Promise<T>,
  dockerRunner: DockerRunner,
  releaseMountPaths: (operationSucceeded: boolean) => Promise<void>,
): Promise<T> {
  let result: T | undefined;
  let operationError: unknown;
  try { result = await operation(); }
  catch (error) { operationError = error; }
  try {
    await removeOwnedMuslContainer(resources, dockerRunner);
    await removeOwnedMuslImageTag(resources, dockerRunner);
  } catch (cleanupError) {
    throw new Error(`owned Docker cleanup failed; mounted paths were preserved (${resources.cidFile})`, {
      cause: operationError === undefined ? cleanupError : new AggregateError([operationError, cleanupError]),
    });
  }
  await releaseMountPaths(operationError === undefined);
  if (operationError !== undefined) throw operationError;
  return result as T;
}

function parseApkDatabase(text: string, expectedArchitecture: string): MuslInventoryEntry[] {
  const entries: MuslInventoryEntry[] = [];
  for (const [index, block] of text.trim().split(/\n\s*\n/).entries()) {
    const fields = new Map<string, string>();
    for (const line of block.split(/\r?\n/)) {
      const match = /^([PVA]):(.*)$/.exec(line);
      if (!match) continue;
      if (fields.has(match[1]!)) throw new Error(`APK database record ${index} duplicates field ${match[1]}`);
      fields.set(match[1]!, match[2]!);
    }
    const name = fields.get("P");
    const version = fields.get("V");
    const architecture = fields.get("A");
    if (!name || !version || !architecture) throw new Error(`APK database record ${index} lacks package name, version, or architecture`);
    if (architecture !== expectedArchitecture && architecture !== "noarch") throw new Error(`APK database package ${name} uses unexpected architecture ${architecture}`);
    entries.push({ name, version, architecture });
  }
  return sortMuslInventory(entries, "created-container APK database");
}

async function downloadReviewedApks(target: "linux-x64-musl" | "linux-arm64-musl", packagesDirectory: string): Promise<void> {
  const provenance = muslTargetProvenance(target);
  const packages = provenance.packages as JsonRecord[];
  await mkdir(packagesDirectory, { recursive: true });
  for (const item of packages) {
    const pkg = object(item, "musl APK package");
    const url = new URL(nonempty(pkg.url, "musl APK URL"));
    const expectedDigest = digest(pkg.sha256, "musl APK SHA-256");
    const expectedSize = Number(pkg.sizeBytes);
    if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > 64 * 1024 * 1024) throw new Error(`pinned Alpine APK size is outside the allowed range: ${pkg.name}`);
    const response = await fetch(url, { signal: AbortSignal.timeout(120_000), redirect: "error" });
    if (!response.ok || !response.body || response.url !== url.toString()) throw new Error(`pinned Alpine APK download failed for ${pkg.name}: HTTP ${response.status}`);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength !== expectedSize) throw new Error(`pinned Alpine APK length differs from provenance: ${pkg.name}`);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > expectedSize) {
          await reader.cancel();
          throw new Error(`pinned Alpine APK exceeds its exact size: ${pkg.name}`);
        }
        chunks.push(Buffer.from(value));
      }
    } finally {
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks, total);
    if (bytes.byteLength !== expectedSize || await sha256(bytes) !== expectedDigest) throw new Error(`pinned Alpine APK bytes differ from provenance: ${pkg.name}`);
    const filename = basename(url.pathname);
    await writeFile(join(packagesDirectory, filename), bytes, { flag: "wx", mode: 0o600 });
  }
}

async function apkDatabaseFromUnstartedContainer(imageId: string, platform: string, destination: string, resources: OwnedMuslDockerResources, signal?: AbortSignal): Promise<Buffer> {
  const signalOption = signal ? { signal } : {};
  const containerId = (await docker([
    "create", "--platform", platform, "--network", "none",
    "--name", resources.containerName, "--cidfile", resources.cidFile,
    "--label", `${ownerLabel}=${resources.ownerToken}`, imageId,
  ], signalOption)).trim();
  if (!/^[a-f0-9]{64}$/.test(containerId)) throw new Error("Docker did not return an exact created-container ID");
  const status = await docker(["inspect", "--format", "{{.State.Status}}", containerId], signalOption);
  if (status !== "created") throw new Error("runtime inventory must be inspected before starting its container");
  await docker(["cp", `${containerId}:/lib/apk/db/installed`, destination], signalOption);
  const database = await readFile(destination);
  await removeOwnedMuslContainer(resources, docker);
  await rm(resources.cidFile);
  return database;
}

export async function buildMuslRuntime(
  targetId: "linux-x64-musl" | "linux-arm64-musl",
  archiveSha256: string,
  sourceRevision: string,
  work: string,
  resources: OwnedMuslDockerResources,
  signal?: AbortSignal,
): Promise<{ evidence: JsonRecord; imageId: string; imageTag: string }> {
  const signalOption = signal ? { signal } : {};
  const provenance = muslTargetProvenance(targetId);
  const expected = targets[targetId];
  const imageTag = resources.imageTag;
  const expectedArch = expected.architecture;
  if (process.platform !== "linux" || process.arch !== expectedArch) throw new Error(`${targetId} runtime build requires a native Linux ${expectedArch} runner`);
  if (process.env.GITHUB_ACTIONS === "true" && normalizedArchitecture(process.env.RUNNER_ARCH ?? "") !== expectedArch) {
    throw new Error(`${targetId} runtime build runner architecture does not match RUNNER_ARCH`);
  }
  const daemon = await docker(["info", "--format", "{{.OSType}}|{{.Architecture}}"], signalOption);
  const [daemonOs, daemonArchName] = daemon.split("|");
  const daemonArch = normalizedArchitecture(daemonArchName ?? "");
  if (daemonOs !== "linux" || daemonArch !== expectedArch) throw new Error(`${targetId} runtime build requires an architecture-native Linux Docker daemon`);
  const baseDigest = nonempty(provenance.baseManifestDigest, `${targetId} base manifest digest`);
  const baseReference = `oven/bun@${baseDigest}`;
  const platform = nonempty(provenance.dockerPlatform, `${targetId} Docker platform`);
  await docker(["pull", "--platform", platform, baseReference], { timeout: 10 * 60 * 1000, ...signalOption });
  const baseInspection = (await docker(["image", "inspect", "--format", "{{.Id}}|{{.Os}}|{{.Architecture}}|{{json .RepoDigests}}", baseReference], signalOption)).split("|");
  if (baseInspection.length !== 4 || baseInspection[1] !== "linux" || baseInspection[2] !== nonempty(provenance.dockerArchitecture, `${targetId} Docker architecture`)) {
    throw new Error(`${targetId} pinned Bun base image is not the expected native platform`);
  }
  const baseDigests = JSON.parse(baseInspection[3]!) as unknown;
  if (!Array.isArray(baseDigests) || !baseDigests.includes(baseReference)) throw new Error(`${targetId} pulled Bun base image does not retain the pinned child digest`);

  const packageDirectory = join(work, "packages");
  await downloadReviewedApks(targetId, packageDirectory);
  const verification = await docker([
    "run", "--network", "none", "--platform", platform,
    "--name", resources.containerName, "--cidfile", resources.cidFile,
    "--label", `${ownerLabel}=${resources.ownerToken}`,
    "--mount", `type=bind,src=${packageDirectory},dst=/tmp/pinned-apks,readonly`,
    baseReference, "sh", "-ceu", "apk verify --keys-dir /etc/apk/keys /tmp/pinned-apks/*.apk",
  ], { timeout: 10 * 60 * 1000, ...signalOption });
  await removeOwnedMuslContainer(resources, docker);
  await rm(resources.cidFile);
  const verificationLines = verification.split(/\r?\n/).filter(line => line.trim().length > 0);
  const verifiedPackageNames = new Set<string>();
  for (const line of verificationLines) {
    const match = /^\/tmp\/pinned-apks\/([^/]+\.apk): 0 - OK$/.exec(line);
    if (!match || verifiedPackageNames.has(match[1]!)) throw new Error(`${targetId} Alpine APK signature verification returned an unexpected result`);
    verifiedPackageNames.add(match[1]!);
  }
  const expectedPackageNames = new Set((provenance.packages as JsonRecord[]).map(item => basename(new URL(String(item.url)).pathname)));
  if (verificationLines.length !== 26 || verifiedPackageNames.size !== expectedPackageNames.size
    || [...verifiedPackageNames].some(name => !expectedPackageNames.has(name))) {
    throw new Error(`${targetId} Alpine APK signature verification did not report 26 successful packages`);
  }
  const dockerfile = [
    `FROM --platform=${platform} ${baseReference}`,
    "COPY packages/ /tmp/pinned-apks/",
    "RUN set -eu; apk verify --keys-dir /etc/apk/keys /tmp/pinned-apks/*.apk; apk add --no-network --no-cache --no-scripts --repositories-file /dev/null /tmp/pinned-apks/*.apk; rm -rf /tmp/pinned-apks",
    "",
  ].join("\n");
  await writeFile(join(work, "Dockerfile"), dockerfile, { flag: "wx", mode: 0o600 });
  const existingImage = await listedDockerIds(["image", "ls", "--quiet", "--no-trunc", imageTag], docker);
  if (existingImage.length !== 0) throw new Error("unique musl task image tag unexpectedly exists before build");
  await docker(["build", "--pull=false", "--no-cache", "--network=none", "--platform", platform, "--file", join(work, "Dockerfile"), "--tag", imageTag, work], { timeout: 30 * 60 * 1000, ...signalOption });
  const imageInspection = (await docker(["image", "inspect", "--format", "{{.Id}}|{{.Os}}|{{.Architecture}}", imageTag], signalOption)).split("|");
  const imageId = imageInspection[0] ?? "";
  if (/^sha256:[0-9a-f]{64}$/.test(imageId)) resources.imageId = imageId;
  if (!/^sha256:[0-9a-f]{64}$/.test(imageId) || imageInspection[1] !== "linux"
    || imageInspection[2] !== provenance.dockerArchitecture) throw new Error(`${targetId} built musl runtime image has the wrong identity or architecture`);
  const databasePath = join(work, "apk-installed-db");
  const database = await apkDatabaseFromUnstartedContainer(imageId, platform, databasePath, resources, signal);
  const installedInventory = parseApkDatabase(database.toString("utf8"), nonempty(provenance.alpineArchitecture, `${targetId} Alpine architecture`));
  const expectedInventory = sortMuslInventory(provenance.finalInstalledInventory, `${targetId} expected inventory`);
  if (installedInventory.length !== 41 || JSON.stringify(installedInventory) !== JSON.stringify(expectedInventory)) {
    throw new Error(`${targetId} actual installed APK database differs from the reviewed 41-package inventory`);
  }
  const apkIndex = object(provenance.apkIndex, `${targetId} APK index`);
  const evidence: JsonRecord = {
    schemaVersion: 1,
    recordKind: "cruxomni-musl-runtime-verification",
    status: "verified",
    targetId,
    sourceRevision,
    archiveSha256,
    provenanceSha256: muslRuntimeProvenanceSha256,
    baseImageReference: baseReference,
    baseManifestDigest: baseDigest,
    dockerPlatform: platform,
    runnerArchitecture: expectedArch,
    daemonArchitecture: daemonArch,
    imageId,
    imageArchitecture: provenance.dockerArchitecture,
    buildNetwork: "none",
    apkInstallNetwork: "none",
    apkScripts: false,
    repositories: [],
    signedIndexSha256: apkIndex.sha256,
    signerKeySha256: apkIndex.signerKeySha256,
    verifiedApkCount: verificationLines.length,
    installedDatabaseSha256: await sha256(database),
    installedInventorySha256: await sha256(Buffer.from(JSON.stringify(installedInventory))),
    installedPackageCount: installedInventory.length,
    installedInventory,
  };
  await validateMuslRuntimeEvidence(evidence, targetId, archiveSha256, sourceRevision);
  return { evidence, imageId, imageTag };
}

async function muslTargetQualification(targetValue: string, releaseDirectory: string, outputDirectory: string): Promise<void> {
  if (!isMuslTarget(targetValue)) throw new Error(`unsupported musl qualification target: ${targetValue}`);
  const target = targetValue;
  const { manifest, archiveSha256 } = await releaseArtifacts(resolve(releaseDirectory));
  const sourceRevision = nonempty(manifest.sourceRevision, "release source revision");
  if ((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim() !== sourceRevision) throw new Error("musl qualification source HEAD does not match the prepared package");
  const stage = resolve(outputDirectory);
  const stageInfo = await lstat(stage).catch(() => undefined);
  if (stageInfo?.isSymbolicLink() || (stageInfo && (!stageInfo.isDirectory() || (await readdir(stage)).length > 0))) {
    throw new Error("musl target output must be a fresh regular directory");
  }
  await mkdir(stage, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), `cruxomni-musl-runtime-${target}-`));
  const sourceParent = await mkdtemp(join(tmpdir(), `cruxomni-musl-source-${target}-`));
  const sourceSnapshot = join(sourceParent, "workspace");
  const expectedArchitecture = target === "linux-x64-musl" ? "x64" : "arm64";
  const taskId = randomUUID();
  const resources: OwnedMuslDockerResources = {
    containerName: `cruxomni-musl-${expectedArchitecture}-${taskId}`,
    ownerToken: taskId,
    cidFile: join(work, "smoke-container.cid"),
    imageTag: `cruxomni-musl-${expectedArchitecture}:${taskId}`,
    imageTagOwned: false,
  };
  const interrupt = createQualificationInterruptSignal();
  let complete = false;
  let mountPathsReleased = false;
  try {
    await runOwnedMuslDockerTask(resources, async () => {
      const existingTag = await listedDockerIds(["image", "ls", "--quiet", "--no-trunc", resources.imageTag], docker);
      if (existingTag.length !== 0) throw new Error("unique musl task image tag unexpectedly exists before build");
      resources.imageTagOwned = true;
      await createQualificationSourceSnapshot(root, sourceRevision, sourceSnapshot, interrupt.signal);
      const built = await buildMuslRuntime(target, archiveSha256, sourceRevision, work, resources, interrupt.signal);
      resources.imageId = built.imageId;
      const runtimePath = join(work, "musl-runtime-evidence.json");
      await writeFile(runtimePath, `${JSON.stringify(built.evidence, null, 2)}\n`, { flag: "wx", mode: 0o400 });
      await prepareQualificationDependencyMount(sourceSnapshot);
      const hostArch = targets[target].architecture === "x64" ? "X64" : "ARM64";
      const shell = "set -eu; mkdir -p /tmp/musl-home /tmp/bun-cache; bun install --frozen-lockfile --ignore-scripts; bun run scripts/qualify-release.ts target --id \"$QUALIFICATION_TARGET\" --release-dir /release --output-dir /target-output";
      const env = {
        QUALIFICATION_TARGET: target,
        GITHUB_SHA: sourceRevision,
        GITHUB_REPOSITORY: nonempty(process.env.GITHUB_REPOSITORY, "GITHUB_REPOSITORY"),
        GITHUB_RUN_ID: nonempty(process.env.GITHUB_RUN_ID, "GITHUB_RUN_ID"),
        RUNNER_ARCH: hostArch,
      };
      const args = [
        "run", "--platform", nonempty(muslTargetProvenance(target).dockerPlatform, `${target} Docker platform`),
        "--name", resources.containerName,
        "--cidfile", resources.cidFile,
        "--label", `${ownerLabel}=${resources.ownerToken}`,
        "--mount", `type=bind,src=${sourceSnapshot},dst=/workspace,readonly`,
        "--mount", `type=bind,src=${resolve(releaseDirectory)},dst=/release,readonly`,
        "--mount", `type=bind,src=${stage},dst=/target-output`,
        "--mount", `type=bind,src=${runtimePath},dst=/musl-runtime.json,readonly`,
        "--tmpfs", "/workspace/node_modules:rw,nosuid,nodev,size=2g",
        "--tmpfs", "/tmp:rw,nosuid,nodev,exec,size=2g",
        "--workdir", "/workspace",
        "--env", "HOME=/tmp/musl-home",
        "--env", "BUN_INSTALL_CACHE_DIR=/tmp/bun-cache",
        "--env", "TMPDIR=/tmp",
        "--env", "GIT_CONFIG_COUNT=1",
        "--env", "GIT_CONFIG_KEY_0=safe.directory",
        "--env", "GIT_CONFIG_VALUE_0=/workspace",
        "--env", "OMP_MUSL_RUNTIME_EVIDENCE_PATH=/musl-runtime.json",
        ...Object.entries(env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
        resources.imageTag, "sh", "-ceu", shell,
      ];
      return await docker(args, { timeout: 60 * 60 * 1000, maxBuffer: 32 * 1024 * 1024, signal: interrupt.signal });
    }, docker, async operationSucceeded => {
      await rm(work, { recursive: true, force: true });
      await rm(sourceParent, { recursive: true, force: true });
      if (!operationSucceeded) await rm(stage, { recursive: true, force: true });
      mountPathsReleased = true;
    });
    complete = true;
    process.stdout.write(`${JSON.stringify({ status: "musl-target-passed", id: target, version: manifest.version, sourceRevision, archiveSha256, imageId: resources.imageId })}\n`);
  } finally {
    interrupt.dispose();
    if (!mountPathsReleased && complete) throw new Error("musl qualification completed without releasing its owned mount paths");
    if (!mountPathsReleased && !complete) {
      process.stderr.write(`musl task-owned temporary paths were preserved for safe cleanup: ${work} ${sourceParent}\n`);
    }
  }
}

export function validateNativeSmokeOutput(value: unknown, target: TargetId, archiveSha256: string, expectedPackageVersion?: string): JsonRecord {
  const smoke = object(value, "native smoke output");
  const host = targets[target];
  const platform = object(smoke.platform, "smoke native platform");
  if (smoke.status !== "verified" || platform.targetId !== target || platform.os !== host.os
    || platform.architecture !== host.architecture || platform.libc !== host.libc) {
    throw new Error(`native smoke did not verify required target ${target}`);
  }
  const installation = object(smoke.installation, "smoke package installation");
  if (installation.method !== "npm" || typeof installation.version !== "string"
    || (expectedPackageVersion !== undefined && installation.version !== expectedPackageVersion)
    || installation.archiveSha256 !== archiveSha256 || !Number.isInteger(installation.metadataGets) || Number(installation.metadataGets) < 1
    || installation.tarballGets !== 1 || !Number.isInteger(installation.installedFiles) || Number(installation.installedFiles) < 1
    || installation.ordinaryDirectory !== true || installation.fileDigestsMatched !== true
    || installation.noInstalledHostSdk !== true || installation.credentialFreeRegistry !== true) {
    throw new Error("native smoke installation evidence does not bind to the exact release archive");
  }
  const hostEvidence = object(smoke.host, "smoke verified OMP host");
  const upstream = object(smoke.upstream, "smoke OMP upstream");
  const expectedOmpAssets = pinnedOmpAssets.filter(value => value.upstream === "omp" && value.kind === "release_asset"
    && value.release_tag === pinnedOmpTag && typeof value.url === "string" && new URL(value.url).pathname.endsWith(`/${targets[target].asset}`));
  if (expectedOmpAssets.length !== 1) throw new Error(`provenance must identify exactly one pinned OMP asset for ${target}`);
  const expectedOmp = expectedOmpAssets[0]!;
  if (hostEvidence.mode !== "release-asset" || hostEvidence.version !== pinnedOmpVersion || upstream.version !== hostEvidence.version
    || digest(hostEvidence.digest, "smoke OMP host digest") !== expectedOmp.sha256 || upstream.digest !== expectedOmp.sha256
    || upstream.commit !== expectedOmp.peeled_commit || upstream.asset !== expectedOmp.url) {
    throw new Error(`native smoke did not use the pinned OMP ${pinnedOmpVersion} asset for this platform`);
  }
  const fixture = object(smoke.fixture, "smoke loopback fixture");
  const fixtureUrl = new URL(nonempty(fixture.baseUrl, "smoke fixture URL"));
  if (fixtureUrl.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(fixtureUrl.hostname)
    || fixture.loopbackOnly !== true || !Number.isInteger(fixture.requests) || Number(fixture.requests) < 1
    || !Number.isInteger(fixture.failedDiscoveryGets) || Number(fixture.failedDiscoveryGets) < 1
    || !Number.isInteger(fixture.responsesPosts) || Number(fixture.responsesPosts) < 1
    || !Number.isInteger(fixture.chatCompletionsPosts) || Number(fixture.chatCompletionsPosts) < 1) {
    throw new Error("native smoke omitted successful loopback provider and failure-path observations");
  }
  const lifecycle = object(smoke.pluginLifecycle, "smoke plugin lifecycle");
  if (lifecycle.installed !== true || lifecycle.disabled !== true || lifecycle.enabled !== true || lifecycle.uninstalled !== true) {
    throw new Error("native smoke did not complete the package lifecycle checks");
  }
  const native = object(smoke.native, "native prompt and inference evidence");
  if (native.prompt !== true || native.cancellation !== true || native.wizardRendered !== true || native.wizardCancellation !== true
    || native.maskedPrompt !== true || native.persisted !== true) throw new Error("native smoke omitted required interactive checks");
  const inference = object(native.inference, "native inference evidence");
  for (const key of ["startupResponses", "startupChatCompletions", "persistedChatCompletions"]) {
    const item = object(inference[key], `${key} evidence`);
    if (typeof item.modelId !== "string" || typeof item.api !== "string" || typeof item.path !== "string"
      || item.postCount !== 1 || item.streamedText !== true || item.usageObserved !== true) {
      throw new Error(`native smoke has incomplete inference evidence: ${key}`);
    }
  }
  const legacyCache = object(native.legacyCache, "legacy cache evidence");
  if (legacyCache.seeded !== true || legacyCache.seederUninstalled !== true || legacyCache.liveDiscoveryStatus !== 503 || legacyCache.selectable !== false || legacyCache.inferencePosts !== 0) {
    throw new Error("native smoke omitted the legacy cache rejection check");
  }
  const toolContinuation = object(native.toolContinuation, "tool continuation evidence");
  if (toolContinuation.postCount !== 2 || toolContinuation.tool !== "read" || toolContinuation.fileResultObserved !== true || toolContinuation.streamedContinuation !== true) {
    throw new Error("native smoke omitted the tool continuation check");
  }
  const administration = object(native.administration, "native administration I/O evidence");
  const administrationFields = ["family", "route", "readOperationId", "mutationOperationId", "cleanupOperationId",
    "readRequests", "mutationRequests", "cleanupRequests", "confirmedMutationAttempts", "unknownOutcomes",
    "durability", "fixtureAuthorization", "exactMutationBodies", "baselineAbsent", "runtimeReadBack",
    "cleanupRead", "noUnexpectedAdminRequests"];
  if (administration.family !== "fallback-chains" || administration.route !== "/api/fallback/chains"
    || administration.readOperationId !== "GET /api/fallback/chains"
    || administration.mutationOperationId !== "POST /api/fallback/chains"
    || administration.cleanupOperationId !== "DELETE /api/fallback/chains"
    || !Number.isInteger(administration.readRequests) || Number(administration.readRequests) < 3 || Number(administration.readRequests) > 20
    || administration.mutationRequests !== 1 || administration.cleanupRequests !== 1
    || administration.confirmedMutationAttempts !== 2 || administration.unknownOutcomes !== 2
    || administration.durability !== "unverified"
    || administration.fixtureAuthorization !== true || administration.exactMutationBodies !== true
    || administration.baselineAbsent !== true || administration.runtimeReadBack !== true || administration.cleanupRead !== true
    || administration.noUnexpectedAdminRequests !== true
    || Object.keys(administration).length !== administrationFields.length
    || administrationFields.some(field => !Object.hasOwn(administration, field))) {
    throw new Error("native smoke omitted exact unknown-outcome administration I/O and runtime cleanup evidence");
  }
  const bytes = Buffer.from(JSON.stringify(smoke));
  if (bytes.byteLength > 128 * 1024) throw new Error("native smoke output is too large for qualification evidence");
  return smoke;
}

async function targetQualification(targetValue: string, releaseDirectory: string, outputDirectory: string): Promise<void> {
  if (!Object.hasOwn(targets, targetValue)) throw new Error(`unsupported qualification target: ${targetValue}`);
  const target = targetValue as TargetId;
  const expected = targets[target];
  if (process.platform !== (expected.os === "windows" ? "win32" : expected.os) || process.arch !== expected.architecture) {
    throw new Error(`qualification target ${target} must run natively on ${expected.os}/${expected.architecture}`);
  }
  const sourceRevision = nonempty(process.env.GITHUB_SHA, "GITHUB_SHA");
  if ((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim() !== sourceRevision) throw new Error("checked out source HEAD does not match this qualification run");
  const { manifest, archivePath, archiveName, archiveSha256 } = await releaseArtifacts(resolve(releaseDirectory));
  const version = nonempty(manifest.version, "release version");
  const stage = resolve(outputDirectory);
  const stageInfo = await lstat(stage).catch(() => undefined);
  if (stageInfo?.isSymbolicLink() || (stageInfo && (!stageInfo.isDirectory() || (await readdir(stage)).length > 0))) {
    throw new Error("qualification target output must be a fresh regular directory");
  }
  await mkdir(stage, { recursive: true });
  const work = await mkdtemp(join(tmpdir(), `cruxomni-qualification-${target}-`));
  let complete = false;
  try {
    const ompPath = await downloadOmp(target, work);
    const command = process.execPath;
    const args = ["run", "scripts/smoke.ts", "--", "--package", archiveName];
    const env = {
      ...process.env,
      OMP_BINARY_PATH: ompPath,
      OMP_SMOKE_PACKAGE_ARCHIVE: archivePath,
      OMP_SMOKE_PACKAGE_SHA256: archiveSha256,
      OMP_QUALIFICATION_TARGET_ID: target,
      npm_config_ignore_scripts: "true",
    };
    const execution = await execFileAsync(command, args, { cwd: root, env, timeout: 20 * 60 * 1000, maxBuffer: 2 * 1024 * 1024 });
    const smokeText = execution.stdout.trim();
    if (!smokeText || Buffer.byteLength(smokeText) > 128 * 1024) throw new Error("native smoke returned empty or oversized output");
    let parsed: unknown;
    try { parsed = JSON.parse(smokeText) as unknown; }
    catch { throw new Error("native smoke output was not valid JSON"); }
    const smoke = validateNativeSmokeOutput(parsed, target, archiveSha256, version);
    const smokePlatform = object(smoke.platform, "validated smoke platform");
    let runtimeEvidence: JsonRecord | undefined;
    if (isMuslTarget(target)) {
      const runtimePath = nonempty(process.env.OMP_MUSL_RUNTIME_EVIDENCE_PATH, "OMP_MUSL_RUNTIME_EVIDENCE_PATH");
      const runtimeBytes = await regularFile(runtimePath, 256 * 1024, "musl runtime evidence");
      runtimeEvidence = await validateMuslRuntimeEvidence(JSON.parse(runtimeBytes.toString("utf8")) as unknown, target, archiveSha256, sourceRevision);
    } else if (process.env.OMP_MUSL_RUNTIME_EVIDENCE_PATH !== undefined) {
      throw new Error("musl runtime evidence must not be supplied for a non-musl target");
    }
    const installOutput = JSON.stringify(smoke.installation);
    const packageOutput = JSON.stringify({
      status: smoke.status,
      platform: smoke.platform,
      host: smoke.host,
      upstream: smoke.upstream,
      fixture: smoke.fixture,
      native: smoke.native,
      pluginLifecycle: smoke.pluginLifecycle,
    });
    const producer = await producerMetadata(target);
    const evidence = {
      schemaVersion: 1,
      recordKind: "omniroute-target-qualification",
      id: target,
      status: "passed",
      version,
      sourceRevision,
      archiveSha256,
      producer,
      host: { os: smokePlatform.os, architecture: smokePlatform.architecture, libc: smokePlatform.libc },
      ...(runtimeEvidence === undefined ? {} : { runtime: runtimeEvidence }),
      smoke: {
        command: `bun run scripts/smoke.ts -- --package ${archiveName}`,
        exitCode: 0,
        output: smokeText,
        outputSha256: await sha256(Buffer.from(smokeText, "utf8")),
        checks: [
          { id: "install-package", status: "passed", output: installOutput, outputSha256: await sha256(Buffer.from(installOutput)) },
          { id: "package-smoke", status: "passed", output: packageOutput, outputSha256: await sha256(Buffer.from(packageOutput)) },
        ],
      },
    };
    await mkdir(join(stage, "evidence"), { recursive: true });
    const evidenceBytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    await writeFile(join(stage, "evidence", `${target}.json`), evidenceBytes, { flag: "wx" });
    await writeFile(join(stage, "target-result.json"), `${JSON.stringify({
      id: target,
      version,
      sourceRevision,
      archiveSha256,
      evidenceSha256: await sha256(evidenceBytes),
    }, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify({ status: "target-passed", id: target, version, sourceRevision, archiveSha256 })}\n`);
    complete = true;
  } finally {
    await rm(work, { recursive: true, force: true });
    if (!complete) await rm(stage, { recursive: true, force: true });
  }
}

async function verifyTargetArtifact(target: TargetId, directory: string, manifest: JsonRecord, archiveSha256: string, producer: JsonRecord): Promise<JsonRecord> {
  const directoryInfo = await lstat(directory).catch(() => undefined);
  if (!directoryInfo?.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error(`${target} artifact must be an ordinary directory`);
  const topEntries = await readdir(directory, { withFileTypes: true });
  if (topEntries.length !== 2 || topEntries.some(entry => entry.isSymbolicLink())
    || !topEntries.some(entry => entry.isFile() && entry.name === "target-result.json")
    || !topEntries.some(entry => entry.isDirectory() && entry.name === "evidence")) {
    throw new Error(`${target} artifact must contain only target-result.json and evidence/`);
  }
  const evidenceEntries = await readdir(join(directory, "evidence"), { withFileTypes: true });
  if (evidenceEntries.length !== 1 || evidenceEntries[0]!.isSymbolicLink() || !evidenceEntries[0]!.isFile() || evidenceEntries[0]!.name !== `${target}.json`) {
    throw new Error(`${target} artifact must contain exactly its target evidence file`);
  }
  const resultPath = join(directory, "target-result.json");
  const result = object(JSON.parse((await regularFile(resultPath, 16 * 1024, `${target} result`)).toString("utf8")), `${target} result`);
  const version = nonempty(manifest.version, "release version");
  const sourceRevision = nonempty(manifest.sourceRevision, "release source revision");
  if (result.id !== target || result.version !== version || result.sourceRevision !== sourceRevision || result.archiveSha256 !== archiveSha256) {
    throw new Error(`target artifact identity does not match the release package: ${target}`);
  }
  const evidencePath = join(directory, "evidence", `${target}.json`);
  const evidenceBytes = await regularFile(evidencePath, 1024 * 1024, `${target} evidence`);
  if (await sha256(evidenceBytes) !== digest(result.evidenceSha256, `${target} evidence SHA-256`)) throw new Error(`${target} evidence digest does not match target result`);
  const evidence = object(JSON.parse(evidenceBytes.toString("utf8")), `${target} evidence`);
  if (evidence.schemaVersion !== 1 || evidence.recordKind !== "omniroute-target-qualification" || evidence.id !== target
    || evidence.status !== "passed" || evidence.version !== version || evidence.sourceRevision !== sourceRevision || evidence.archiveSha256 !== archiveSha256) {
    throw new Error(`${target} evidence identity is incomplete or inconsistent`);
  }
  const evidenceProducer = object(evidence.producer, `${target} producer`);
  for (const key of ["repository", "runId", "workflowPath", "workflowName", "workflowSha256", "jobName"]) {
    if (evidenceProducer[key] !== (key === "jobName" ? target : producer[key])) throw new Error(`${target} evidence has mismatched producer ${key}`);
  }
  const host = object(evidence.host, `${target} host`);
  const expected = targets[target];
  if (host.os !== expected.os || host.architecture !== expected.architecture || host.libc !== expected.libc) throw new Error(`${target} evidence host does not match its native target`);
  if (isMuslTarget(target)) {
    await validateMuslRuntimeEvidence(evidence.runtime, target, archiveSha256, sourceRevision);
  } else if (evidence.runtime !== undefined) {
    throw new Error(`${target} non-musl evidence must not contain a musl runtime binding`);
  }
  const smokeEvidence = object(evidence.smoke, `${target} smoke evidence`);
  const output = nonempty(smokeEvidence.output, `${target} smoke output`);
  if (smokeEvidence.exitCode !== 0 || typeof smokeEvidence.command !== "string" || !smokeEvidence.command.includes(`--package cruxexperts-cruxomni-omp-client-${version}.tgz`)
    || await sha256(Buffer.from(output)) !== digest(smokeEvidence.outputSha256, `${target} smoke output digest`)) throw new Error(`${target} smoke output is not bound to the exact package archive`);
  let actualSmoke: unknown;
  try { actualSmoke = JSON.parse(output) as unknown; } catch { throw new Error(`${target} smoke output is not valid JSON`); }
  const validatedSmoke = validateNativeSmokeOutput(actualSmoke, target, archiveSha256, version);
  const checks = smokeEvidence.checks;
  if (!Array.isArray(checks) || checks.length !== 2) throw new Error(`${target} smoke evidence must contain both actual required checks`);
  const byId = new Map<string, JsonRecord>();
  for (const [index, value] of checks.entries()) {
    const check = object(value, `${target} check ${index}`);
    const id = nonempty(check.id, `${target} check id`);
    if (byId.has(id) || check.status !== "passed") throw new Error(`${target} smoke check is duplicate or not passed`);
    const checkOutput = nonempty(check.output, `${target} ${id} output`);
    if (await sha256(Buffer.from(checkOutput)) !== digest(check.outputSha256, `${target} ${id} output digest`)) throw new Error(`${target} ${id} output digest mismatch`);
    byId.set(id, check);
  }
  const installation = object(validatedSmoke.installation, "actual smoke installation");
  const expectedChecks: Record<string, string> = {
    "install-package": JSON.stringify(installation),
    "package-smoke": JSON.stringify({
      status: validatedSmoke.status,
      platform: validatedSmoke.platform,
      host: validatedSmoke.host,
      upstream: validatedSmoke.upstream,
      fixture: validatedSmoke.fixture,
      native: validatedSmoke.native,
      pluginLifecycle: validatedSmoke.pluginLifecycle,
    }),
  };
  if (byId.size !== 2 || Object.entries(expectedChecks).some(([id, expectedOutput]) => byId.get(id)?.output !== expectedOutput)) {
    throw new Error(`${target} smoke checks do not match actual native smoke output`);
  }
  return evidence;
}

async function aggregate(releaseDirectory: string, targetArtifactsDirectory: string, outputDirectory: string): Promise<void> {
  const { manifest, archiveSha256 } = await releaseArtifacts(resolve(releaseDirectory));
  const sourceRevision = nonempty(manifest.sourceRevision, "release source revision");
  if ((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim() !== sourceRevision) throw new Error("aggregate source HEAD does not match the prepared package");
  const producer = await producerMetadata("aggregate");
  const baseProducer = { ...producer };
  delete baseProducer.jobName;
  const targetRoot = resolve(targetArtifactsDirectory);
  const targetRootInfo = await lstat(targetRoot).catch(() => undefined);
  if (!targetRootInfo?.isDirectory() || targetRootInfo.isSymbolicLink()) throw new Error("native target evidence root must be an ordinary directory");
  const targetEntries = await readdir(targetRoot, { withFileTypes: true });
  const expectedTargetIds = Object.keys(targets).sort();
  if (targetEntries.length !== expectedTargetIds.length || targetEntries.some(entry => entry.isSymbolicLink() || !entry.isDirectory())
    || JSON.stringify(targetEntries.map(entry => entry.name).sort()) !== JSON.stringify(expectedTargetIds)) {
    throw new Error("native target evidence root must contain exactly the eight supported target directories");
  }
  const stage = resolve(outputDirectory);
  const stageInfo = await lstat(stage).catch(() => undefined);
  if (stageInfo?.isSymbolicLink() || (stageInfo && (!stageInfo.isDirectory() || (await readdir(stage)).length > 0))) throw new Error("qualification aggregate output must be a fresh regular directory");
  await mkdir(join(stage, "evidence"), { recursive: true });
  let complete = false;
  try {
    const receiptTargets: JsonRecord[] = [];
    for (const id of Object.keys(targets) as TargetId[]) {
      const targetDir = join(targetRoot, id);
      const evidence = await verifyTargetArtifact(id, targetDir, manifest, archiveSha256, baseProducer);
      const evidenceBytes = await regularFile(join(targetDir, "evidence", `${id}.json`), 1024 * 1024, `${id} evidence`);
      const ref = `evidence/${id}.json`;
      await writeFile(join(stage, ref), evidenceBytes, { flag: "wx" });
      receiptTargets.push({ id, status: "passed", version: manifest.version, sourceRevision, archiveSha256, evidenceRef: ref, evidenceSha256: await sha256(evidenceBytes) });
      if (evidence.id !== id) throw new Error(`target evidence identifier mismatch: ${id}`);
    }
    const receipt = {
      schemaVersion: 1,
      release: { version: manifest.version, sourceRevision },
      producer: baseProducer,
      packageArchiveSha256: archiveSha256,
      targets: receiptTargets,
    };
    await writeFile(join(stage, "qualification-receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(`${JSON.stringify({ status: "qualification-bundle-passed", targets: receiptTargets.length, archiveSha256 })}\n`);
    complete = true;
  } finally {
    if (!complete) await rm(stage, { recursive: true, force: true });
  }
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "musl-target" && args.length === 6 && args[0] === "--id" && args[2] === "--release-dir" && args[4] === "--output-dir") {
    await muslTargetQualification(args[1]!, args[3]!, args[5]!);
    return;
  }
  if (command === "target" && args.length === 6 && args[0] === "--id" && args[2] === "--release-dir" && args[4] === "--output-dir") {
    await targetQualification(args[1]!, args[3]!, args[5]!);
    return;
  }
  if (command === "aggregate" && args.length === 6 && args[0] === "--release-dir" && args[2] === "--target-artifacts-dir" && args[4] === "--output-dir") {
    await aggregate(args[1]!, args[3]!, args[5]!);
    return;
  }
  throw new Error("usage: bun run scripts/qualify-release.ts target --id <target> --release-dir <release> --output-dir <target-output> | musl-target --id <linux-musl-target> --release-dir <release> --output-dir <target-output> | aggregate --release-dir <release> --target-artifacts-dir <targets> --output-dir <bundle>");
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
