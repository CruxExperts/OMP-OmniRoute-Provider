import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

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
    `CruxOmni-OMP-Client-v${version}-source.tar.gz`,
    `CruxOmni-OMP-Client-v${version}-graphics.zip`,
    `CruxOmni-OMP-Client-v${version}.cdx.json`,
    `CruxOmni-OMP-Client-v${version}-release-notes.md`,
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
  if (!/^\d+$/.test(runId) || repository !== "CruxExperts/CruxOmni-OMP-Client") throw new Error("qualification producer must be the canonical repository workflow run");
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
  if (command === "target" && args.length === 6 && args[0] === "--id" && args[2] === "--release-dir" && args[4] === "--output-dir") {
    await targetQualification(args[1]!, args[3]!, args[5]!);
    return;
  }
  if (command === "aggregate" && args.length === 6 && args[0] === "--release-dir" && args[2] === "--target-artifacts-dir" && args[4] === "--output-dir") {
    await aggregate(args[1]!, args[3]!, args[5]!);
    return;
  }
  throw new Error("usage: bun run scripts/qualify-release.ts target --id <target> --release-dir <release> --output-dir <target-output> | aggregate --release-dir <release> --target-artifacts-dir <targets> --output-dir <bundle>");
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
