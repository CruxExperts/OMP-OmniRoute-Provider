import { createHash, type Hash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { isMuslTarget, validateMuslRuntimeEvidence } from "./musl-runtime.ts";
import { validateNativeSmokeOutput } from "./qualify-release.ts";
import { GITHUB_REPOSITORY, REPOSITORY_SLUG } from "../src/identity.ts";
import { resolveQualificationSource } from "./route-source-store.ts";
import { testCaseSourceHash } from "./generate-contracts.ts";
import ts from "typescript";

const execFileAsync = promisify(execFile);
const defaultRoot = resolve(import.meta.dir, "..");
const sha256Pattern = /^[0-9a-f]{64}$/;
const gitShaPattern = /^[0-9a-f]{40}$/;
const packageName = "@cruxexperts/cruxomni-omp-client";
const receiptDigestDomainName = "cruxomni-release-approval-v1\0";
const receiptDigestDomain = Buffer.from(receiptDigestDomainName, "utf8");
const qualificationTargetIds = [
  "linux-x64-glibc",
  "linux-arm64-glibc",
  "linux-x64-musl",
  "linux-arm64-musl",
  "darwin-x64",
  "darwin-arm64",
  "windows-x64",
  "windows-arm64",
] as const;
const maxQualificationBytes = 1024 * 1024;
const maxEvidenceBytes = 1024 * 1024;
const maxPublicationMetadataBytes = 8 * 1024 * 1024;

interface Artifact { name: string; sha256: string }
interface ReleaseManifest {
  schemaVersion: number;
  package: string;
  version: string;
  sourceRevision: string;
  publication: { status: string; target: string };
  artifacts: Artifact[];
  lockfileSha256: string;
}
interface TargetEvidence { id: string; status: string; version: string; sourceRevision: string; archiveSha256: string; evidenceRef: string; evidenceSha256: string }
interface QualificationReceipt {
  schemaVersion: number;
  release: { version: string; sourceRevision: string };
  producer: { repository: string; runId: string; workflowPath: string; workflowName: string; workflowSha256: string };
  packageArchiveSha256: string;
  targets: TargetEvidence[];
}

interface ExpectedHost { os: string; architecture: string; libc: string | null }
const expectedHosts: Record<(typeof qualificationTargetIds)[number], ExpectedHost> = {
  "linux-x64-glibc": { os: "linux", architecture: "x64", libc: "glibc" },
  "linux-arm64-glibc": { os: "linux", architecture: "arm64", libc: "glibc" },
  "linux-x64-musl": { os: "linux", architecture: "x64", libc: "musl" },
  "linux-arm64-musl": { os: "linux", architecture: "arm64", libc: "musl" },
  "darwin-x64": { os: "darwin", architecture: "x64", libc: null },
  "darwin-arm64": { os: "darwin", architecture: "arm64", libc: null },
  "windows-x64": { os: "windows", architecture: "x64", libc: null },
  "windows-arm64": { os: "windows", architecture: "arm64", libc: null },
};

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function recordArray(value: unknown, label: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((item, index) => objectValue(item, `${label}[${index}]`));
}

async function readJson(path: string, label: string): Promise<Record<string, unknown>> {
  try {
    return objectValue(JSON.parse(await readFile(path, "utf8")) as unknown, label);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error(`${label} is not valid JSON`);
    throw error;
  }
}

async function hashFile(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function readEvidence(receiptDirectory: string, reference: string): Promise<Buffer> {
  if (reference.length > 256 || reference.includes("\\") || isAbsolute(reference) || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(reference)) {
    throw new Error("qualification evidenceRef must be a safe relative POSIX file path");
  }
  const parts = reference.split("/");
  if (parts.some(part => part === "" || part === "." || part === "..")) throw new Error("qualification evidenceRef contains an unsafe path component");
  const evidencePath = resolve(receiptDirectory, ...parts);
  const relativePath = relative(receiptDirectory, evidencePath);
  if (relativePath === "" || relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error("qualification evidenceRef must remain beside its receipt");
  }

  let cursor = receiptDirectory;
  for (const [index, part] of parts.entries()) {
    cursor = resolve(cursor, part);
    const info = await lstat(cursor);
    if (info.isSymbolicLink()) throw new Error(`qualification evidence path contains a symbolic link: ${reference}`);
    const isLast = index === parts.length - 1;
    if (!isLast && !info.isDirectory()) throw new Error(`qualification evidence parent is not a directory: ${reference}`);
    if (isLast && (!info.isFile() || info.size > maxEvidenceBytes)) throw new Error(`qualification evidence must be a regular file no larger than ${maxEvidenceBytes} bytes: ${reference}`);
  }
  return readFile(evidencePath);
}

async function validateQualificationProducer(root: string, value: unknown): Promise<Record<string, unknown>> {
  const producer = objectValue(value, "qualification producer");
  const workflowPath = ".github/workflows/qualification.yml";
  let workflowBytes: Buffer;
  try {
    const info = await lstat(resolve(root, workflowPath));
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("qualification producer workflow must be a regular tracked file");
    workflowBytes = await readFile(resolve(root, workflowPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("required qualification producer workflow .github/workflows/qualification.yml is missing");
    throw error;
  }
  const workflowSource = workflowBytes.toString("utf8");
  if (!/^name:\s*["']?release-qualification["']?\s*$/m.test(workflowSource)) {
    throw new Error("qualification producer workflow must have the exact name release-qualification");
  }
  const workflowSha256 = createHash("sha256").update(workflowBytes).digest("hex");
  if (producer.workflowPath !== workflowPath || producer.workflowName !== "release-qualification"
    || producer.workflowSha256 !== workflowSha256 || typeof producer.repository !== "string"
    || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(producer.repository)
    || typeof producer.runId !== "string" || !/^[1-9][0-9]{0,18}$/.test(producer.runId)) {
    throw new Error("qualification producer metadata does not identify the reviewed release-qualification workflow and run");
  }
  return producer;
}

export function verifyQualificationRunMetadata(options: { run: unknown; jobs: unknown; repository: string; runId: string; sourceRevision: string }): { workflowPath: string; workflowName: string; targets: number } {
  const run = objectValue(options.run, "qualification workflow run");
  const repository = objectValue(run.repository, "qualification workflow repository");
  const workflowPath = ".github/workflows/qualification.yml";
  const workflowName = "release-qualification";
  if (String(run.id) !== options.runId || repository.full_name !== options.repository || run.event !== "workflow_dispatch"
    || run.head_sha !== options.sourceRevision || run.path !== workflowPath || run.name !== workflowName
    || run.status !== "completed" || run.conclusion !== "success") {
    throw new Error("qualification run must be the successful release-qualification workflow for this repository and source commit");
  }

  const jobsRoot = objectValue(options.jobs, "qualification workflow jobs");
  const jobs = recordArray(jobsRoot.jobs, "qualification workflow jobs list");
  if (!Number.isInteger(jobsRoot.total_count) || jobsRoot.total_count !== jobs.length) {
    throw new Error("qualification workflow jobs response is incomplete; fetch every job before approval");
  }
  for (const targetId of qualificationTargetIds) {
    const matches = jobs.filter(job => job.name === targetId);
    if (matches.length !== 1 || String(matches[0]!.run_id) !== options.runId
      || matches[0]!.status !== "completed" || matches[0]!.conclusion !== "success"
      || (matches[0]!.head_sha !== undefined && matches[0]!.head_sha !== options.sourceRevision)) {
      throw new Error(`qualification run does not contain exactly one successful native target job named ${targetId}`);
    }
  }
  return { workflowPath, workflowName, targets: qualificationTargetIds.length };
}
/** Validate authenticated Actions responses; caller must obtain them from GitHub. */
export function validateAcpRunMetadata(options: { run: unknown; jobs: unknown; artifacts: unknown; repository: string; runId: string; sourceRevision: string }): { attempt: number; artifacts: Record<"windows-x64" | "windows-arm64", { id: number; digest: string }> } {
  const { repository, runId, sourceRevision } = options;
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[1-9][0-9]{0,18}$/.test(runId) || !gitShaPattern.test(sourceRevision)) throw new Error("Invalid native ACP run identity");
  const run = objectValue(options.run, "native ACP run");
  if (String(run.id) !== runId || objectValue(run.repository, "native ACP repository").full_name !== repository || run.head_sha !== sourceRevision ||
      run.path !== ".github/workflows/windows-input-diagnostic.yml" || run.name !== "windows-input-diagnostic" || run.event !== "workflow_dispatch" ||
      run.status !== "completed" || run.conclusion !== "success" || run.run_attempt !== 1) throw new Error("Native ACP run identity or result mismatch");
  const jobsRoot = objectValue(options.jobs, "native ACP jobs");
  const jobs = recordArray(jobsRoot.jobs, "native ACP jobs list");
  if (!Number.isSafeInteger(jobsRoot.total_count) || jobsRoot.total_count !== jobs.length) throw new Error("Native ACP jobs response is incomplete");
  const artifactRoot = objectValue(options.artifacts, "native ACP artifacts");
  const artifactList = recordArray(artifactRoot.artifacts, "native ACP artifacts list");
  if (!Number.isSafeInteger(artifactRoot.total_count) || artifactRoot.total_count !== artifactList.length) throw new Error("Native ACP artifacts response is incomplete");
  const selected = {} as Record<"windows-x64" | "windows-arm64", { id: number; digest: string }>;
  for (const target of ["windows-x64", "windows-arm64"] as const) {
    const found = jobs.filter(job => job.name === `native-owned-acp-${target}`);
    if (found.length !== 1 || String(found[0]!.run_id) !== runId || found[0]!.status !== "completed" || found[0]!.conclusion !== "success" || found[0]!.head_sha !== sourceRevision) throw new Error(`Native ACP job missing or mismatched: ${target}`);
    const matches = artifactList.filter(item => item.name === `windows-owned-acp-${target}`);
    const artifact = matches[0];
    if (matches.length !== 1 || !artifact || artifact.expired !== false || !Number.isSafeInteger(artifact.id) || (artifact.id as number) <= 0 || typeof artifact.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(artifact.digest) || String(objectValue(artifact.workflow_run, "artifact workflow run").id) !== runId || objectValue(artifact.workflow_run, "artifact workflow run").head_sha !== sourceRevision) throw new Error(`Native ACP artifact missing or mismatched: ${target}`);
    selected[target] = { id: artifact.id as number, digest: artifact.digest.slice(7) };
  }
  if (selected["windows-x64"].id === selected["windows-arm64"].id) throw new Error("Native ACP artifacts must be distinct");
  return { attempt: run.run_attempt as number, artifacts: selected };
}

type AcpTarget = "windows-x64" | "windows-arm64";
export interface AcpNativeInputs {
  caseSha256: string; lockfileSha256: string; packageSha256: string; compilerPackageSha256: string; compilerSha256: string; compilerVersion: string;
  workflowSha256: string; upstreamManifestSha256: string; sourceManifestSha256: string; fixtureSha256: string; testSha256: string;
  sourceDerivation: { record: string; sha256: string }; effectiveTreeSha256: string;
}

/** Checks artifact assertions only against independently computed expected inputs. */
export function validateAcpNativeReceipt(value: unknown, target: AcpTarget, revision: string, expected: AcpNativeInputs): void {
  const receipt = objectValue(value, "native ACP receipt");
  const names = ["schemaVersion", "target", "commit", "os", "architecture", "bun", "bunArchitecture", "outcome", ...Object.keys(expected)].sort();
  if (Object.keys(receipt).sort().join("\0") !== names.join("\0") || receipt.schemaVersion !== 2 || receipt.target !== target || receipt.commit !== revision || receipt.outcome !== "passed" ||
      receipt.architecture !== (target === "windows-x64" ? "X64" : "ARM64") || receipt.bunArchitecture !== (target === "windows-x64" ? "x64" : "arm64") || receipt.bun !== "1.4.2" || typeof receipt.os !== "string" || receipt.os.length > 256 || /[\r\n\0]/.test(receipt.os)) throw new Error(`Native ACP receipt identity mismatch: ${target}`);
  for (const [key, expectedValue] of Object.entries(expected)) {
    if (key === "sourceDerivation") {
      const derivation = objectValue(receipt[key], "native ACP derivation");
      if (Object.keys(derivation).sort().join(",") !== "record,sha256" || derivation.record !== expected.sourceDerivation.record || derivation.sha256 !== expected.sourceDerivation.sha256) throw new Error(`Native ACP receipt source mismatch: ${target}`);
    } else if (receipt[key] !== expectedValue) throw new Error(`Native ACP receipt input mismatch: ${target} ${key}`);
  }
}

export function verifyAcpArchiveDigest(archive: Uint8Array, expected: string): string {
  if (!sha256Pattern.test(expected)) throw new Error("Invalid native ACP artifact digest");
  const actual = createHash("sha256").update(archive).digest("hex");
  if (actual !== expected) throw new Error("Native ACP artifact digest mismatch");
  return actual;
}

async function boundedAcpCommand(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; maxBuffer?: number } = {}): Promise<Buffer> {
  try {
    const result = await execFileAsync(command, args, { ...options, encoding: "buffer", timeout: 120_000, maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024 });
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(result.stdout);
  } catch { throw new Error(`Native ACP ${command} operation failed`); }
}

/** Fetch GitHub evidence for a clean signed checkout; the output still requires review. */
export async function readAcpEvidenceArchive(archivePath: string): Promise<{ receiptBytes: Buffer; stageBytes: Buffer }> {
  const entries = (await boundedAcpCommand("unzip", ["-Z", "-1", archivePath], { maxBuffer: 4096 })).toString("utf8").trimEnd().split(/\r?\n/).sort();
  if (entries.join("\0") !== ["windows-acp-result.json", "windows-acp-stage.json"].join("\0")) throw new Error("Native ACP artifact contents mismatch");
  return {
    receiptBytes: await boundedAcpCommand("unzip", ["-p", archivePath, "windows-acp-result.json"], { maxBuffer: 1024 * 1024 }),
    stageBytes: await boundedAcpCommand("unzip", ["-p", archivePath, "windows-acp-stage.json"], { maxBuffer: 1024 * 1024 }),
  };
}

export function validateAcpStage(value: unknown, target: AcpTarget): Record<string, unknown> {
  const stage = objectValue(value, "native ACP stage");
  const exactKeys = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
  const fail = () => { throw new Error(`Native ACP stage incomplete: ${target}`); };
  if (!exactKeys(stage, ["stage", "category", "tempForbiddenCodes", "parentForbiddenCodes", "environment", "processes"]) || stage.category !== "passed" || stage.stage !== "cleanup") fail();
  for (const name of ["tempForbiddenCodes", "parentForbiddenCodes"]) {
    const codes = stage[name];
    if (!Array.isArray(codes) || codes.length > 16 || codes.some(code => !Number.isInteger(code) || code < 0 || code > 65535)) fail();
  }
  const environment = objectValue(stage.environment, "native ACP environment");
  if (!exactKeys(environment, ["supplied", "extras", "unknownCount", "unknownPrefixes", "unknownLengths", "unknownHasNonIdentifier", "processorArchitecture", "duplicateCount"]) || environment.unknownCount !== 0 || environment.duplicateCount !== 0 || environment.unknownHasNonIdentifier !== false || !Array.isArray(environment.unknownLengths) || environment.unknownLengths.length !== 0 || environment.processorArchitecture !== (target === "windows-arm64" ? "ARM64" : "absent")) fail();
  const supplied = objectValue(environment.supplied, "native ACP supplied environment");
  const suppliedNames = ["HOME", "TMPDIR", "BUN_DISABLE_TRANSPILER_CACHE", "SYSTEMROOT", "COMSPEC", ...(target === "windows-arm64" ? ["PROCESSOR_ARCHITECTURE"] : [])];
  if (!exactKeys(supplied, suppliedNames)) fail();
  for (const name of suppliedNames) {
    const item = objectValue(supplied[name], "native ACP supplied variable");
    if (!exactKeys(item, ["present", "matches"]) || item.present !== true || item.matches !== true) fail();
  }
  const extras = objectValue(environment.extras, "native ACP environment extras");
  const wow64ArchitectureVariable = ["PROCESSOR_ARCHITEW", "6432"].join("");
  if (!exactKeys(extras, ["PATHEXT", "COMSPEC", "SYSTEMROOT", "TEMP", "TMP", "PROMPT", "SYSTEMDRIVE", "WINDIR", "PROCESSOR_ARCHITECTURE", wow64ArchitectureVariable, "BUN_JSC_FORCERAMSIZE", "BUN_RUNTIME_TRANSPILER_CACHE_PATH", "__COMPAT_LAYER"]) || Object.values(extras).some(item => item !== false)) fail();
  const prefixes = objectValue(environment.unknownPrefixes, "native ACP unknown prefixes");
  if (!exactKeys(prefixes, ["BUN_", "JSC_", "OMP_", "ACP_", "PROCESSOR_", "NODE_", "NPM_", "CI_", "GITHUB_", "RUNNER_", "__"]) || Object.values(prefixes).some(item => item !== 0)) fail();
  const processes = objectValue(stage.processes, "native ACP processes");
  if (!exactKeys(processes, ["recordCount", "outcomeCount", "probeCount", "successProbeCount", "normalizedProbeCount", "caseInsensitiveProbeCount", "sourceProbes", "sourceShell", "rejections", "successPathShellSafe", "successPreflight", "success", "failure", "stall"]) || processes.recordCount !== 3 || processes.outcomeCount !== 3 || processes.successProbeCount !== 1 || processes.normalizedProbeCount !== 1 || processes.caseInsensitiveProbeCount !== 1 || processes.sourceShell !== true || processes.successPathShellSafe !== true || processes.successPreflight !== "execute" || !Number.isInteger(processes.probeCount) || (processes.probeCount as number) < 3 || (processes.probeCount as number) > 1000) fail();
  const probes = objectValue(processes.sourceProbes, "native ACP source probes");
  if (!exactKeys(probes, ["success", "failure", "stall"])) fail();
  for (const name of ["success", "failure", "stall"]) {
    const probe = objectValue(probes[name], "native ACP source probe");
    if (!exactKeys(probe, ["resolved", "exact", "normalized", "caseInsensitive", "shell", "shellSafe", "hasWhitespace"]) || ["resolved", "exact", "normalized", "caseInsensitive", "shell", "shellSafe"].some(key => probe[key] !== true) || probe.hasWhitespace !== false) fail();
  }
  const rejections = objectValue(processes.rejections, "native ACP rejected probes");
  if (!exactKeys(rejections, ["ownership", "integrity", "options", "windows-shell", "execute"]) || Object.values(rejections).some(item => !Number.isInteger(item) || (item as number) < 0 || (item as number) > 1000) || rejections.integrity !== 0 || rejections.options !== 0 || rejections["windows-shell"] !== 0) fail();
  const expected = { success: { status: 0, code: "none", signal: "none", stdout: "success", error: "none" }, failure: { status: 17, code: "none", signal: "none", stdout: "failure", error: "other" }, stall: { status: null, code: "ETIMEDOUT", signal: "SIGKILL", stdout: "empty", error: "timeout" } };
  for (const name of ["success", "failure", "stall"] as const) {
    const outcome = objectValue(processes[name], "native ACP process outcome");
    if (!exactKeys(outcome, ["status", "code", "signal", "stdout", "error"]) || Object.entries(expected[name]).some(([key, item]) => outcome[key] !== item)) fail();
  }
  return { stage: "cleanup", category: "passed", recordCount: 3, outcomeCount: 3, environmentMatches: true, unknownEnvironmentCount: 0, sentinelAssertionPassed: true, outcomes: expected };
}

export async function collectAcpNativeProof(runId: string, revision: string): Promise<Record<string, unknown>> {
  if (!/^[1-9][0-9]{0,18}$/.test(runId) || !gitShaPattern.test(revision) || !process.env.GH_TOKEN) throw new Error("Native ACP verification requires run ID, signed revision and GitHub token");
  const root = defaultRoot;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("GIT_")));
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null";
  const temporary = await mkdtemp(resolve(tmpdir(), "acp-proof-"));
  try {
    const git = (...args: string[]) => boundedAcpCommand("git", args, { cwd: root, env });
    if ((await git("rev-parse", "HEAD")).toString("utf8").trim() !== revision || (await git("status", "--porcelain", "--untracked-files=all")).length !== 0) throw new Error("Native ACP source checkout is not clean at the requested revision");
    const gpgEnv = { ...env, GNUPGHOME: temporary };
    await boundedAcpCommand("gpg", ["--batch", "--no-options", "--import", resolve(root, ".github/crux-experts-release-signing-key.asc")], { env: gpgEnv });
    let signature: string;
    try {
      const result = await execFileAsync("git", ["-c", "gpg.program=gpg", "verify-commit", "--raw", revision], { cwd: root, env: gpgEnv, timeout: 120_000, maxBuffer: 1024 * 1024 });
      signature = result.stderr;
    } catch { throw new Error("Native ACP source signature verification failed"); }
    const signers = [...signature.matchAll(/^\[GNUPG:\] VALIDSIG ([A-F0-9]{40})\b/gm)];
    if (signers.length !== 1 || signers[0]![1] !== "AF7968466B5B39C5E928FEFE716342D3EFBA5522") throw new Error("Native ACP source signer mismatch");
    const source = objectValue(JSON.parse((await boundedAcpCommand("python3", ["scripts/prepare-upstream.py", "--verify-qualification-source"], { cwd: root, env })).toString("utf8")) as unknown, "verified native ACP source");
    const derivation = objectValue(source.derivation, "verified native ACP derivation");
    if (typeof derivation.record !== "string" || typeof derivation.sha256 !== "string" || !sha256Pattern.test(derivation.sha256) || typeof source.treeSha256 !== "string" || !sha256Pattern.test(source.treeSha256)) throw new Error("Invalid verified native ACP source");
    const expected: AcpNativeInputs = {
      caseSha256: testCaseSourceHash("test/admin-acp-agents.test.ts"), lockfileSha256: await hashFile(resolve(root, "bun.lock")), packageSha256: await hashFile(resolve(root, "package.json")),
      compilerPackageSha256: await hashFile(resolve(root, "node_modules/typescript/package.json")), compilerSha256: await hashFile(resolve(root, "node_modules/typescript/lib/typescript.js")), compilerVersion: ts.version,
      workflowSha256: await hashFile(resolve(root, ".github/workflows/windows-input-diagnostic.yml")), upstreamManifestSha256: await hashFile(resolve(root, "provenance/upstreams.json")),
      sourceManifestSha256: await hashFile(resolve(root, "provenance/route-sources.json")), fixtureSha256: await hashFile(resolve(root, "test/fixtures/acp-agents.fixture.ts")), testSha256: await hashFile(resolve(root, "test/admin-acp-agents.test.ts")),
      sourceDerivation: { record: derivation.record, sha256: derivation.sha256 }, effectiveTreeSha256: source.treeSha256,
    };
    const api = `repos/${GITHUB_REPOSITORY}/actions`;
    const gh = (suffix: string) => boundedAcpCommand("gh", ["api", "--hostname", "github.com", `${api}/${suffix}`], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
    const json = async (suffix: string) => objectValue(JSON.parse((await gh(suffix)).toString("utf8")) as unknown, "GitHub native ACP metadata");
    const run = await json(`runs/${runId}`);
    const paged = async (suffix: string, key: "jobs" | "artifacts") => {
      const all: unknown[] = []; let total: number | undefined;
      for (let page = 1; page <= 10; page++) {
        const response = await json(`${suffix}?per_page=100&page=${page}`);
        if (!Number.isSafeInteger(response.total_count) || (total !== undefined && response.total_count !== total) || !Array.isArray(response[key])) throw new Error("Incomplete native ACP metadata");
        total = response.total_count as number;
        const entries = response[key] as unknown[]; all.push(...entries);
        if (all.length === total) return { total_count: total, [key]: all };
        if (all.length > total || entries.length === 0) break;
      }
      throw new Error("Incomplete native ACP metadata");
    };
    const jobs = await paged(`runs/${runId}/attempts/1/jobs`, "jobs");
    const artifacts = await paged(`runs/${runId}/artifacts`, "artifacts");
    const metadata = validateAcpRunMetadata({ run, jobs, artifacts, repository: GITHUB_REPOSITORY, runId, sourceRevision: revision });
    const results: Array<{ target: AcpTarget; artifactId: number; archiveSha256: string; receiptSha256: string; stageSha256: string; stage: Record<string, unknown> }> = [];
    for (const target of ["windows-x64", "windows-arm64"] as const) {
      const artifact = metadata.artifacts[target];
      const archive = await gh(`artifacts/${artifact.id}/zip`);
      const digest = verifyAcpArchiveDigest(archive, artifact.digest);
      const archivePath = resolve(temporary, `${target}.zip`);
      await writeFile(archivePath, archive, { flag: "wx" });
      const { receiptBytes, stageBytes } = await readAcpEvidenceArchive(archivePath);
      const receipt = JSON.parse(receiptBytes.toString("utf8").replace(/^\uFEFF/, "")) as unknown;
      const stage = JSON.parse(stageBytes.toString("utf8").replace(/^\uFEFF/, "")) as unknown;
      validateAcpNativeReceipt(receipt, target, revision, expected);
      const stageView = validateAcpStage(stage, target);
      results.push({ target, artifactId: artifact.id, archiveSha256: digest, receiptSha256: createHash("sha256").update(receiptBytes).digest("hex"), stageSha256: createHash("sha256").update(stageBytes).digest("hex"), stage: stageView });
    }
    if ((await git("rev-parse", "HEAD")).toString("utf8").trim() !== revision || (await git("status", "--porcelain", "--untracked-files=all")).length !== 0) throw new Error("Native ACP source changed during collection");
    return { schemaVersion: 1, kind: "native-acp-actions-proof", repository: GITHUB_REPOSITORY, runId, attempt: metadata.attempt, sourceRevision: revision, inputs: expected, results };
  } finally { await rm(temporary, { recursive: true, force: true }); }
}



export function verifyReleaseEnvironmentMetadata(value: unknown, expectedName = "release"): { name: string; reviewerCount: number; requiredReviewerRules: number } {
  const environment = objectValue(value, "GitHub release environment response");
  if (environment.name !== expectedName) {
    throw new Error(`GitHub environment response must identify the exact ${expectedName} environment`);
  }

  const rules = recordArray(environment.protection_rules, "GitHub release environment protection_rules");
  const reviewerRules = rules.filter(rule => rule.type === "required_reviewers");
  if (reviewerRules.length === 0) {
    throw new Error(`GitHub ${expectedName} environment must have at least one required_reviewers protection rule`);
  }

  let reviewerCount = 0;
  for (const [ruleIndex, rule] of reviewerRules.entries()) {
    if (typeof rule.prevent_self_review !== "boolean") {
      throw new Error(`GitHub ${expectedName} required_reviewers rule ${ruleIndex} has an invalid prevent_self_review field`);
    }
    const reviewers = recordArray(rule.reviewers, `GitHub ${expectedName} required_reviewers rule ${ruleIndex} reviewers`);
    if (reviewers.length === 0 || reviewers.length > 6) {
      throw new Error(`GitHub ${expectedName} required_reviewers rule ${ruleIndex} must contain between one and six configured reviewers`);
    }
    for (const [reviewerIndex, entry] of reviewers.entries()) {
      if (entry.type !== "User" && entry.type !== "Team") {
        throw new Error(`GitHub ${expectedName} reviewer ${reviewerIndex} must have type User or Team`);
      }
      const reviewer = objectValue(entry.reviewer, `GitHub ${expectedName} reviewer ${reviewerIndex} reviewer`);
      if (!Number.isInteger(reviewer.id) || Number(reviewer.id) <= 0) {
        throw new Error(`GitHub ${expectedName} reviewer ${reviewerIndex} must have a positive numeric reviewer id`);
      }
      const identity = entry.type === "User" ? reviewer.login : reviewer.slug ?? reviewer.name;
      if (typeof identity !== "string" || identity.trim() === "") {
        throw new Error(`GitHub ${expectedName} reviewer ${reviewerIndex} must have a configured account identity`);
      }
      reviewerCount += 1;
    }
  }

  return { name: expectedName, reviewerCount, requiredReviewerRules: reviewerRules.length };
}

function validateSmokeEvidence(evidence: Record<string, unknown>, targetId: string, packageArtifact: Artifact): void {
  const expectedHost = expectedHosts[targetId as keyof typeof expectedHosts];
  const host = objectValue(evidence.host, `qualification evidence host for ${targetId}`);
  if (!expectedHost || host.os !== expectedHost.os || host.architecture !== expectedHost.architecture || host.libc !== expectedHost.libc) {
    throw new Error(`qualification evidence for ${targetId} does not identify the required native host`);
  }

  const smoke = objectValue(evidence.smoke, `qualification smoke evidence for ${targetId}`);
  const command = stringValue(smoke.command, `${targetId} smoke command`);
  const output = stringValue(smoke.output, `${targetId} smoke output`);
  if (smoke.exitCode !== 0 || !command.includes(packageArtifact.name) || Buffer.byteLength(output) > 128 * 1024
    || !sha256Pattern.test(String(smoke.outputSha256))
    || createHash("sha256").update(output, "utf8").digest("hex") !== smoke.outputSha256) {
    throw new Error(`qualification evidence for ${targetId} must contain successful native smoke output for the exact package archive`);
  }
  let nativeOutput: unknown;
  try { nativeOutput = JSON.parse(output) as unknown; }
  catch { throw new Error(`qualification evidence for ${targetId} has invalid native smoke JSON`); }
  validateNativeSmokeOutput(nativeOutput, targetId as Parameters<typeof validateNativeSmokeOutput>[1], packageArtifact.sha256, String(evidence.version));

  const checks = recordArray(smoke.checks, `${targetId} smoke checks`);
  const expectedChecks = new Set(["install-package", "package-smoke"]);
  if (checks.length !== expectedChecks.size) throw new Error(`qualification evidence for ${targetId} must contain install-package and package-smoke checks`);
  for (const check of checks) {
    const id = stringValue(check.id, `${targetId} smoke check id`);
    const checkOutput = stringValue(check.output, `${targetId} ${id} output`);
    if (!expectedChecks.delete(id) || check.status !== "passed" || Buffer.byteLength(checkOutput) > 64 * 1024
      || !sha256Pattern.test(String(check.outputSha256))
      || createHash("sha256").update(checkOutput, "utf8").digest("hex") !== check.outputSha256) {
      throw new Error(`qualification evidence for ${targetId} has an incomplete or invalid smoke check: ${id}`);
    }
  }
  if (expectedChecks.size > 0) throw new Error(`qualification evidence for ${targetId} is missing a required smoke check`);
}

async function cleanHead(root: string): Promise<string> {
  const [revision, status] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: root }),
    execFileAsync("git", ["status", "--porcelain=v1", "--untracked-files=all"], { cwd: root }),
  ]);
  const sha = revision.stdout.trim();
  if (!gitShaPattern.test(sha)) throw new Error("release HEAD is not a full Git commit");
  if (status.stdout.trim()) throw new Error("release source changed after export; prepare the receipt from a clean tagged commit");
  return sha;
}

function expectedArtifactNames(version: string): string[] {
  return [
    `${REPOSITORY_SLUG}-v${version}-source.tar.gz`,
    `cruxexperts-cruxomni-omp-client-${version}.tgz`,
    `${REPOSITORY_SLUG}-v${version}-graphics.zip`,
    `${REPOSITORY_SLUG}-v${version}.cdx.json`,
    `${REPOSITORY_SLUG}-v${version}-release-notes.md`,
  ].sort();
}

async function validateManifest(root: string, releaseDirectory: string): Promise<{ manifest: ReleaseManifest; bytes: Buffer; packageArtifact: Artifact }> {
  const manifestPath = resolve(releaseDirectory, "release-manifest.json");
  const bytes = await readFile(manifestPath);
  const parsed = objectValue(JSON.parse(bytes.toString("utf8")) as unknown, "release manifest");
  const version = stringValue(parsed.version, "release manifest version");
  const sourceRevision = stringValue(parsed.sourceRevision, "release manifest sourceRevision");
  const publication = objectValue(parsed.publication, "release manifest publication");
  if (parsed.schemaVersion !== 1 || parsed.package !== packageName || !/^\d+\.\d+\.\d+$/.test(version)) throw new Error("release manifest identity or version is invalid");
  if (!gitShaPattern.test(sourceRevision) || publication.status !== "prepared" || (publication.target !== "github-only" && publication.target !== "github-and-npm")) throw new Error("release manifest is not a prepared receipt for this release workflow");
  if (!sha256Pattern.test(stringValue(parsed.lockfileSha256, "release manifest lockfileSha256"))) throw new Error("release manifest lockfile hash is invalid");
  const artifacts = recordArray(parsed.artifacts, "release manifest artifacts").map((item, index) => {
    const name = stringValue(item.name, `release artifact ${index} name`);
    const hash = stringValue(item.sha256, `release artifact ${index} sha256`);
    if (name !== name.split(/[\\/]/).pop() || !sha256Pattern.test(hash)) throw new Error(`release artifact ${name} has an invalid name or hash`);
    return { name, sha256: hash };
  });
  const names = artifacts.map(item => item.name);
  if (new Set(names).size !== names.length || JSON.stringify([...names].sort()) !== JSON.stringify(expectedArtifactNames(version))) {
    throw new Error("release manifest must list exactly the five versioned release artifacts");
  }
  for (const artifact of artifacts) {
    const artifactPath = resolve(releaseDirectory, artifact.name);
    const info = await lstat(artifactPath);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`release artifact must be a regular file: ${artifact.name}`);
    if (await hashFile(artifactPath) !== artifact.sha256) throw new Error(`release artifact hash mismatch: ${artifact.name}`);
  }
  const checksums = (await readFile(resolve(releaseDirectory, "SHA256SUMS.txt"), "utf8")).trimEnd().split(/\r?\n/);
  const expectedSums = artifacts.map(item => `${item.sha256}  ${item.name}`);
  if (JSON.stringify(checksums) !== JSON.stringify(expectedSums)) throw new Error("SHA256SUMS.txt does not list exactly the manifest artifacts");
  const expectedFiles = [...names, "SHA256SUMS.txt", "release-manifest.json"].sort();
  const entries = await readdir(releaseDirectory, { withFileTypes: true });
  if (entries.some(entry => !entry.isFile())) throw new Error("release output may contain only top-level regular files");
  const actualFiles = entries.map(entry => entry.name).sort();
  if (JSON.stringify(actualFiles) !== JSON.stringify(expectedFiles)) throw new Error("release output directory contains stale or unmanifested files");
  const revision = await cleanHead(root);
  if (revision !== sourceRevision) throw new Error("release manifest sourceRevision does not match clean HEAD");
  const pkg = await readJson(resolve(root, "package.json"), "package.json");
  const canonicalVersion = (await readFile(resolve(root, "VERSION"), "utf8")).trim();
  if (pkg.name !== packageName || pkg.version !== version || canonicalVersion !== version) throw new Error("release manifest version does not match package.json and VERSION");
  const packageArtifacts = artifacts.filter(item => item.name.endsWith(".tgz"));
  if (packageArtifacts.length !== 1) throw new Error("release manifest must contain exactly one npm package archive");
  const notesName = `${REPOSITORY_SLUG}-v${version}-release-notes.md`;
  const notesArtifact = artifacts.find(item => item.name === notesName);
  if (!notesArtifact || !(await readFile(resolve(releaseDirectory, notesName))).equals(await readFile(resolve(root, "CHANGELOG.md")))) {
    throw new Error("versioned release notes must match the exact reviewed CHANGELOG.md bytes");
  }
  return { manifest: parsed as unknown as ReleaseManifest, bytes, packageArtifact: packageArtifacts[0]! };
}

type EffectiveSource = { derivation: { record: string; sha256: string } | null; tree: string | undefined };

function effectiveSource(value: Record<string, unknown>, label: string): EffectiveSource {
  const derivation = value.sourceDerivation;
  const tree = value.effectiveTreeSha256;
  if (derivation === undefined && tree === undefined) return { derivation: null, tree: undefined };
  const record = objectValue(derivation, `${label} sourceDerivation`);
  if (Object.keys(record).sort().join(",") !== "record,sha256"
    || record.record !== "provenance/derivations/omniroute-3.8.53-startup/manifest.json"
    || typeof record.sha256 !== "string" || !sha256Pattern.test(record.sha256)
    || typeof tree !== "string" || !sha256Pattern.test(tree)) throw new Error(`${label} effective source identity is invalid`);
  return { derivation: { record: record.record, sha256: record.sha256 }, tree };
}

function sameEffectiveSource(left: EffectiveSource, right: EffectiveSource): boolean {
  return left.tree === right.tree && left.derivation?.record === right.derivation?.record && left.derivation?.sha256 === right.derivation?.sha256;
}

export function validateReleaseSourceIdentity(root: string, operationsRoot: Record<string, unknown>, eligibilityRoot: Record<string, unknown>): void {
  const configured = resolveQualificationSource(root).derivation;
  const operationsSource = effectiveSource(objectValue(operationsRoot.sourceContext, "operations sourceContext"), "operations");
  const eligibilitySource = effectiveSource(eligibilityRoot, "eligibility");
  if (!sameEffectiveSource(operationsSource, eligibilitySource)
    || operationsSource.derivation?.record !== configured?.record || operationsSource.derivation?.sha256 !== configured?.sha256) {
    throw new Error("release qualification effective source mismatch");
  }
  const eligibility = new Map(recordArray(eligibilityRoot.operations, "release eligibility operations").map(entry => [entry.operationId, entry]));
  for (const operation of recordArray(operationsRoot.operations, "operations contract")) {
    const evidence = eligibility.get(operation.operationId);
    if (!evidence) continue;
    const label = String(operation.operationId);
    const binding = objectValue(evidence.binding, `${label} qualification binding`);
    const qualification = objectValue(operation.qualification, `${label} operation qualification`);
    const operationBinding = objectValue(qualification.binding, `${label} operation binding`);
    if (!sameEffectiveSource(operationsSource, effectiveSource(binding, `${label} eligibility binding`))
      || !sameEffectiveSource(operationsSource, effectiveSource(operationBinding, `${label} operation binding`))) {
      throw new Error(`${label} qualification effective source mismatch`);
    }
  }
}

function validateOperationCoverage(operationsRoot: Record<string, unknown>, eligibilityRoot: Record<string, unknown>): { invokable: number; nonInvokable: number; unqualified: string[] } {
  const operations = recordArray(operationsRoot.operations, "operations contract");
  const operationById = new Map<string, Record<string, unknown>>();
  for (const operation of operations) {
    const id = stringValue(operation.operationId, "operation operationId");
    if (operationById.has(id)) throw new Error(`operations contract contains duplicate operation ${id}`);
    operationById.set(id, operation);
  }
  const eligibility = recordArray(eligibilityRoot.operations, "release eligibility operations");
  const eligibilityById = new Map<string, Record<string, unknown>>();
  for (const operation of eligibility) {
    const id = stringValue(operation.operationId, "eligible operation operationId");
    if (eligibilityById.has(id)) throw new Error(`release eligibility contains duplicate operation ${id}`);
    eligibilityById.set(id, operation);
  }

  let invokable = 0;
  let nonInvokable = 0;
  const unqualified: string[] = [];
  for (const [id, operation] of operationById) {
    const coverage = objectValue(operation.coverage, `${id} coverage`);
    const status = stringValue(coverage.status, `${id} coverage status`);
    const source = objectValue(operation.source, `${id} source`);
    if (status === "invokable") {
      invokable++;
      if (typeof coverage.adapterId !== "string" || coverage.adapterId.trim() === "") throw new Error(`${id} is invokable without an adapterId`);
      const evidence = eligibilityById.get(id);
      if (!evidence || evidence.status !== "verified") {
        unqualified.push(id);
        continue;
      }
      const sourceEvidence = objectValue(evidence.source, `${id} qualification source`);
      const binding = objectValue(evidence.binding, `${id} qualification binding`);
      const test = objectValue(evidence.test, `${id} qualification test`);
      const details = recordArray(evidence.evidence, `${id} qualification evidence`);
      const bindingDigestFields = ["requestSchemaSha256", "authSha256", "responseProjectionSha256", "operationSemanticsSha256", "routeImportsSha256", "frameworkContextSha256", "mutationSafetySha256"];
      const bindingComplete = bindingDigestFields.every(field => sha256Pattern.test(String(binding[field])))
        && ["read", "mutation", "secret", "lifecycle", "destructive"].includes(String(binding.sideEffect));
      const sourceComplete = typeof source.file === "string" && source.file.trim() !== ""
        && sha256Pattern.test(String(source.sha256)) && gitShaPattern.test(String(source.gitBlobSha));
      const testComplete = typeof test.id === "string" && /^test\/[^\\]+$/.test(test.id)
        && typeof test.observedOutcome === "string" && /^provenance\/qualification\/[a-f0-9]{64}\.json$/.test(test.observedOutcome)
        && sha256Pattern.test(String(test.caseSha256)) && sha256Pattern.test(String(test.outcomeSha256));
      const evidenceComplete = details.length > 0 && details.every(detail => typeof detail.kind === "string" && detail.kind.trim() !== "" && typeof detail.detail === "string" && detail.detail.trim() !== "");
      if (!sourceComplete || sourceEvidence.file !== source.file || sourceEvidence.sha256 !== source.sha256 || sourceEvidence.gitBlobSha !== source.gitBlobSha
        || typeof evidence.reason !== "string" || evidence.reason.trim() === "" || !bindingComplete || !testComplete || !evidenceComplete) unqualified.push(id);
    } else if (status === "non-invokable") {
      nonInvokable++;
      const reason = coverage.reason;
      if (coverage.adapterId !== null || typeof reason !== "string" || reason.trim() === ""
        || typeof source.file !== "string" || !sha256Pattern.test(String(source.sha256)) || !gitShaPattern.test(String(source.gitBlobSha))) {
        unqualified.push(id);
      }
    } else if (status === "unqualified") {
      unqualified.push(id);
    } else {
      throw new Error(`${id} has unsupported coverage status ${status}`);
    }
  }
  for (const id of eligibilityById.keys()) {
    const operation = operationById.get(id);
    const coverage = operation ? objectValue(operation.coverage, `${id} coverage`) : undefined;
    if (!coverage || coverage.status !== "invokable") throw new Error(`release eligibility records a non-invokable or unknown operation: ${id}`);
  }
  if (eligibilityRoot.schemaVersion !== 3 || eligibilityRoot.recordKind !== "omniroute-release-eligibility") throw new Error("release eligibility contract identity is invalid");
  return { invokable, nonInvokable, unqualified };
}

async function validateQualification(root: string, manifest: ReleaseManifest, packageArtifact: Artifact, qualificationPath: string): Promise<{ targets: number; operations: number; nonInvokable: number; receiptBytes: Buffer }> {
  const receiptInfo = await lstat(qualificationPath);
  if (!receiptInfo.isFile() || receiptInfo.isSymbolicLink() || receiptInfo.size > maxQualificationBytes) throw new Error(`qualification receipt must be a regular file no larger than ${maxQualificationBytes} bytes`);
  const realReceiptPath = await realpath(qualificationPath);
  const receiptDirectory = dirname(realReceiptPath);
  const receiptBytes = await readFile(realReceiptPath);
  const receipt = objectValue(JSON.parse(receiptBytes.toString("utf8")) as unknown, "qualification receipt") as unknown as QualificationReceipt;
  if (receipt.schemaVersion !== 1) throw new Error("qualification receipt schemaVersion must be 1");
  if (!receipt.release || receipt.release.version !== manifest.version || receipt.release.sourceRevision !== manifest.sourceRevision) throw new Error("qualification receipt release identity does not match the manifest");
  if (!sha256Pattern.test(receipt.packageArchiveSha256) || receipt.packageArchiveSha256 !== packageArtifact.sha256) throw new Error("qualification receipt must bind to the exact manifest npm archive hash");
  const operationsRoot = await readJson(resolve(root, "contracts/operations.json"), "operations contract");
  const eligibilityRoot = await readJson(resolve(root, "contracts/release-eligibility.json"), "release eligibility contract");
  validateReleaseSourceIdentity(root, operationsRoot, eligibilityRoot);
  const coverage = validateOperationCoverage(operationsRoot, eligibilityRoot);
  if (coverage.unqualified.length > 0) {
    const sample = coverage.unqualified.slice(0, 5).join(", ");
    throw new Error(`${coverage.unqualified.length} applicable operations remain unqualified${sample ? ` (for example: ${sample})` : ""}`);
  }
  if (coverage.invokable === 0) throw new Error("release qualification has no invokable operations with evidence");

  const producer = await validateQualificationProducer(root, receipt.producer);
  if (!Array.isArray(receipt.targets) || receipt.targets.length !== qualificationTargetIds.length) throw new Error("qualification receipt must contain exactly the eight supported target results");
  const targetIds = new Set<string>();
  for (const [index, targetValue] of receipt.targets.entries()) {
    const target = objectValue(targetValue, `qualification target ${index}`) as unknown as TargetEvidence;
    if (typeof target.id !== "string" || !qualificationTargetIds.includes(target.id as typeof qualificationTargetIds[number]) || targetIds.has(target.id)) throw new Error(`qualification target ${index} must use one of the eight supported target IDs exactly once`);
    targetIds.add(target.id);
    if (target.status !== "passed") throw new Error(`qualification target ${target.id} did not pass`);
    if (target.version !== manifest.version || target.sourceRevision !== manifest.sourceRevision) throw new Error(`qualification target ${target.id} source identity does not match the release manifest`);
    if (target.archiveSha256 !== receipt.packageArchiveSha256) throw new Error(`qualification target ${target.id} tested a different package archive`);
    if (typeof target.evidenceRef !== "string" || !sha256Pattern.test(target.evidenceSha256)) throw new Error(`qualification target ${target.id} has no verifiable evidence reference and hash`);
    const evidenceBytes = await readEvidence(receiptDirectory, target.evidenceRef);
    if (createHash("sha256").update(evidenceBytes).digest("hex") !== target.evidenceSha256) throw new Error(`qualification target ${target.id} evidence hash does not match its file`);
    let evidence: Record<string, unknown>;
    try {
      evidence = objectValue(JSON.parse(evidenceBytes.toString("utf8")) as unknown, `qualification evidence for ${target.id}`);
    } catch (error) {
      if (error instanceof SyntaxError) throw new Error(`qualification evidence for ${target.id} is not valid JSON`);
      throw error;
    }
    if (evidence.schemaVersion !== 1 || evidence.recordKind !== "omniroute-target-qualification"
      || evidence.id !== target.id || evidence.status !== target.status || evidence.version !== manifest.version
      || evidence.sourceRevision !== manifest.sourceRevision || evidence.archiveSha256 !== packageArtifact.sha256) {
      throw new Error(`qualification evidence for ${target.id} does not match target, source, status, and archive identity`);
    }
    const evidenceProducer = objectValue(evidence.producer, `qualification evidence producer for ${target.id}`);
    if (evidenceProducer.repository !== producer.repository || evidenceProducer.runId !== producer.runId
      || evidenceProducer.workflowPath !== producer.workflowPath || evidenceProducer.workflowName !== producer.workflowName
      || evidenceProducer.workflowSha256 !== producer.workflowSha256 || evidenceProducer.jobName !== target.id) {
      throw new Error(`qualification evidence for ${target.id} does not match the named native target producer run`);
    }
    if (isMuslTarget(target.id)) {
      await validateMuslRuntimeEvidence(evidence.runtime, target.id, packageArtifact.sha256, manifest.sourceRevision);
    }
    validateSmokeEvidence(evidence, target.id, packageArtifact);
  }
  if (qualificationTargetIds.some(id => !targetIds.has(id))) throw new Error("qualification receipt is missing one or more supported target IDs");
  return { targets: receipt.targets.length, operations: coverage.invokable, nonInvokable: coverage.nonInvokable, receiptBytes };
}

export async function createReleaseApprovalReceipt(options: { root?: string; releaseDirectory: string; qualificationPath: string; destination?: "github-only" | "github-and-npm" }): Promise<{ status: "ready-for-protected-approval"; approvalReceiptSha256: string; manifestSha256: string; qualificationSha256: string; targets: number; qualifiedOperations: number; sourceRevision: string }> {
  const root = resolve(options.root ?? defaultRoot);
  const { manifest, bytes: manifestBytes, packageArtifact } = await validateManifest(root, resolve(options.releaseDirectory));
  if (manifest.publication.target !== (options.destination ?? "github-and-npm")) throw new Error("release publication destination differs from qualified manifest");
  const qualification = await validateQualification(root, manifest, packageArtifact, resolve(options.qualificationPath));
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const qualificationSha256 = createHash("sha256").update(qualification.receiptBytes).digest("hex");
  const approvalReceiptSha256 = createHash("sha256").update(receiptDigestDomain).update(manifestBytes).update(Buffer.from([0])).update(qualification.receiptBytes).digest("hex");
  return {
    status: "ready-for-protected-approval",
    approvalReceiptSha256,
    manifestSha256,
    qualificationSha256,
    targets: qualification.targets,
    qualifiedOperations: qualification.operations,
    sourceRevision: manifest.sourceRevision,
  };
}

export async function verifyReleaseApproval(options: { root?: string; releaseDirectory: string; qualificationPath: string; expectedReceiptSha256: string; destination?: "github-only" | "github-and-npm" }): Promise<Awaited<ReturnType<typeof createReleaseApprovalReceipt>>> {
  if (!sha256Pattern.test(options.expectedReceiptSha256)) throw new Error("expected approval receipt must be a lowercase SHA-256 digest");
  const receipt = await createReleaseApprovalReceipt(options);
  if (receipt.approvalReceiptSha256 !== options.expectedReceiptSha256) throw new Error(`exact release approval receipt mismatch: generated ${receipt.approvalReceiptSha256}`);
  return receipt;
}

type PublicationState = "absent" | "draft" | "published";
type PublicationIO = {
  inspect: () => Promise<{ github: PublicationState; npm?: "absent" | "published" }>;
  createDraft: () => Promise<void>;
  publishNpm: () => Promise<void>;
  publishGithub: () => Promise<void>;
};

// Every effect is followed by a new read of the selected destinations. A failed
// effect is never retried: it may have reached the server despite the error.
export async function recoverPublication(io: PublicationIO, destination: "github-only" | "github-and-npm" = "github-and-npm"): Promise<void> {
  let state = await io.inspect();
  if (destination === "github-only") {
    if (state.github === "absent") {
      await io.createDraft();
      state = await io.inspect();
      if (state.github !== "draft") throw new Error("GitHub publication state changed; reconcile before further mutation");
    }
    if (state.github === "draft") {
      await io.publishGithub();
      state = await io.inspect();
    }
    if (state.github !== "published") throw new Error("GitHub publication state changed; reconcile before further mutation");
    return;
  }
  const requireState = (github: PublicationState, npm: "absent" | "published") => {
    if (state.github !== github || state.npm !== npm) throw new Error("publication state changed or is inconsistent; reconcile both destinations before further mutation");
  };
  if (state.github === "absent" && state.npm === "absent") {
    await io.createDraft();
    state = await io.inspect();
    requireState("draft", "absent");
  }
  if (state.github === "draft" && state.npm === "absent") {
    await io.publishNpm();
    state = await io.inspect();
    requireState("draft", "published");
  }
  if (state.github === "draft" && state.npm === "published") {
    await io.publishGithub();
    state = await io.inspect();
    requireState("published", "published");
  }
  requireState("published", "published");
}

async function readPublicationBody(response: Response, limit: number, label: string, consume: (chunk: Uint8Array, offset: number) => void): Promise<number> {
  if (!response.body) throw new Error(`${label} has no response body`);
  const reader = response.body.getReader();
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return total;
      if (value.byteLength > limit - total) {
        await reader.cancel().catch(() => {});
        throw new Error(`${label} exceeds its byte limit`);
      }
      consume(value, total);
      total += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
}

async function readPublicationJson(response: Response, label: string): Promise<unknown> {
  const chunks: Buffer[] = [];
  await readPublicationBody(response, maxPublicationMetadataBytes, label, chunk => { chunks.push(Buffer.from(chunk)); });
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function verifyPublicationBytes(response: Response, expected: Buffer, label: string, hash?: Hash): Promise<void> {
  let matches = true;
  const total = await readPublicationBody(response, expected.byteLength, label, (chunk, offset) => {
    hash?.update(chunk);
    if (!expected.subarray(offset, offset + chunk.byteLength).equals(chunk)) matches = false;
  });
  if (!matches || total !== expected.byteLength) throw new Error(`${label} bytes mismatch`);
}

export async function publishApprovedRelease(releaseDirectory: string, evidenceDirectory: string, tag: string, repository: string, token: string, npmToken: string, dependencies: { fetch?: typeof fetch; command?: (command: string, args: string[], env?: NodeJS.ProcessEnv) => Promise<{ stdout: string }> } = {}, destination: "github-only" | "github-and-npm" = "github-and-npm"): Promise<void> {
  if ((destination !== "github-only" && destination !== "github-and-npm") || !/^v\d+\.\d+\.\d+$/.test(tag) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !token || (destination === "github-and-npm" && !npmToken)) throw new Error("invalid publication identity, destination, or missing credentials");
  const command = dependencies.command ?? (async (name: string, args: string[], env?: NodeJS.ProcessEnv) => execFileAsync(name, args, { env }));
  const manifest = await readJson(resolve(releaseDirectory, "release-manifest.json"), "release manifest");
  if (objectValue(manifest.publication, "release manifest publication").target !== destination) throw new Error("release publication destination differs from qualified manifest");
  const version = stringValue(manifest.version, "release version");
  if (tag !== `v${version}` || manifest.package !== packageName) throw new Error("publication tag or package does not match manifest");
  const artifacts = recordArray(manifest.artifacts, "release artifacts");
  const names = artifacts.map(item => stringValue(item.name, "artifact name"));
  const archive = names.find(name => name.endsWith(".tgz"));
  const notes = names.find(name => name.endsWith("-release-notes.md"));
  if (!archive || !notes) throw new Error("missing package archive or release notes");
  const assetPaths = [...names.map(name => resolve(releaseDirectory, name)), resolve(releaseDirectory, "release-manifest.json"), resolve(releaseDirectory, "SHA256SUMS.txt"), ...["release-qualification-receipt.json", "release-approval.json", "release-qualification-evidence.tar.gz"].map(name => resolve(evidenceDirectory, name))];
  const expectedAssets = new Map(await Promise.all(assetPaths.map(async path => [path.split(sep).pop()!, await readFile(path)] as const)));
  if (expectedAssets.size !== assetPaths.length) throw new Error("duplicate expected release asset name");
  const archiveBytes = expectedAssets.get(archive)!;
  const archiveHash = createHash("sha256").update(archiveBytes).digest("hex");
  const archiveIntegrity = `sha512-${createHash("sha512").update(archiveBytes).digest("base64")}`;
  const api = `https://api.github.com/repos/${repository}`;
  const githubHeaders = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "User-Agent": "cruxomni-release-gate" };
  const npmHeaders = destination === "github-and-npm" ? { Authorization: `Bearer ${npmToken}`, Accept: "application/json" } : undefined;
  const request = async (url: string, headers: Record<string, string>, allowMissing = false, asset = false): Promise<Response | null> => {
    let response = await (dependencies.fetch ?? fetch)(url, { headers, redirect: "manual", signal: AbortSignal.timeout(30_000) });
    if (asset && [301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      const location = response.headers.get("location");
      if (!location) throw new Error("GitHub asset redirect has no location");
      const target = new URL(location, url);
      if (target.protocol !== "https:" || !["release-assets.githubusercontent.com", "objects.githubusercontent.com"].includes(target.hostname) || target.username || target.password || target.port) throw new Error("GitHub asset redirect is not a trusted download host");
      response = await (dependencies.fetch ?? fetch)(target.href, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
    }
    if (response.status === 404 && allowMissing) { await response.body?.cancel(); return null; }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`publication readback failed with HTTP ${response.status}; reconcile before mutation`); }
    return response;
  };
  const inspect = async (): Promise<{ github: PublicationState; npm?: "absent" | "published" }> => {
    // Authenticate and establish repository visibility before interpreting a 404.
    await (await request(api, githubHeaders))!.body?.cancel();
    if (npmHeaders) await (await request("https://registry.npmjs.org/-/whoami", npmHeaders))!.body?.cancel();
    const tagResponse = await request(`${api}/git/ref/tags/${encodeURIComponent(tag)}`, githubHeaders);
    const tagObject = objectValue(await readPublicationJson(tagResponse!, "GitHub tag reference"), "GitHub tag reference");
    const tagRef = objectValue(tagObject.object, "GitHub tag object");
    const { stdout: localTag } = await command("git", ["rev-parse", `refs/tags/${tag}`]);
    if (tagRef.type !== "tag" || tagRef.sha !== localTag.trim()) throw new Error("GitHub tag differs from the verified signed tag");
    // The tag lookup endpoint omits drafts; enumerate the authenticated list.
    const matches: Record<string, unknown>[] = [];
    let complete = false;
    for (let page = 1; page <= 100; page++) {
      const response = await request(`${api}/releases?per_page=100&page=${page}`, githubHeaders);
      const releases = recordArray(await readPublicationJson(response!, "GitHub releases"), "GitHub releases");
      matches.push(...releases.filter(release => release.tag_name === tag));
      if (releases.length < 100) { complete = true; break; }
    }
    if (!complete || matches.length > 1) throw new Error("GitHub release list is incomplete or ambiguous");
    let github: PublicationState = "absent";
    if (matches.length === 1) {
      const release = matches[0]!;
      if (release.tag_name !== tag || release.name !== `OMP OmniRoute Provider ${version}` || typeof release.draft !== "boolean" || release.prerelease !== false || release.body !== expectedAssets.get(notes)!.toString("utf8")) throw new Error("GitHub release metadata or reviewed notes mismatch");
      const assets = recordArray(release.assets, "GitHub release assets");
      if (assets.length !== expectedAssets.size || new Set(assets.map(asset => asset.name)).size !== expectedAssets.size) throw new Error("GitHub release asset set mismatch");
      for (const asset of assets) {
        const name = stringValue(asset.name, "GitHub asset name");
        const expected = expectedAssets.get(name);
        if (!expected || !Number.isSafeInteger(asset.id) || asset.state !== "uploaded") throw new Error("GitHub release asset identity mismatch");
        const response = await request(`${api}/releases/assets/${asset.id}`, { ...githubHeaders, Accept: "application/octet-stream" }, false, true);
        await verifyPublicationBytes(response!, expected, `GitHub release asset ${name}`);
      }
      github = release.draft ? "draft" : "published";
    }
    if (!npmHeaders) return { github };
    const packageResponse = await request(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`, npmHeaders, true);
    if (!packageResponse) {
      const npmResponse = await request(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`, npmHeaders, true);
      if (npmResponse) {
        await npmResponse.body?.cancel();
        throw new Error("npm version readback is inconsistent");
      }
      return { github, npm: "absent" };
    }
    const packageMetadata = objectValue(await readPublicationJson(packageResponse, "npm package metadata"), "npm package metadata");
    if (packageMetadata.name !== packageName) throw new Error("npm package identity mismatch");
    const versions = objectValue(packageMetadata.versions, "npm package versions");
    const npmResponse = await request(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`, npmHeaders, true);
    if (!npmResponse) {
      if (Object.hasOwn(versions, version)) throw new Error("npm version readback is inconsistent");
      return { github, npm: "absent" };
    }
    if (!Object.hasOwn(versions, version)) throw new Error("npm version readback is inconsistent");
    const metadata = objectValue(await readPublicationJson(npmResponse, "npm version metadata"), "npm version metadata");
    const dist = objectValue(metadata.dist, "npm distribution");
    if (metadata.name !== packageName || metadata.version !== version || dist.integrity !== archiveIntegrity || typeof dist.tarball !== "string") throw new Error("npm package identity or integrity mismatch");
    const tarball = new URL(dist.tarball);
    if (tarball.protocol !== "https:" || tarball.hostname !== "registry.npmjs.org" || tarball.username || tarball.password || tarball.port) throw new Error("npm tarball URL is not the trusted registry");
    const downloaded = await request(tarball.href, npmHeaders);
    const downloadedHash = createHash("sha256");
    await verifyPublicationBytes(downloaded!, archiveBytes, "npm tarball", downloadedHash);
    if (downloadedHash.digest("hex") !== archiveHash) throw new Error("npm tarball SHA-256 mismatch");
    return { github, npm: "published" };
  };
  const effect = async (name: string, args: string[], env: NodeJS.ProcessEnv = process.env) => {
    try { await command(name, args, env); }
    catch { throw new Error(`${name} publication outcome is uncertain; stop and reconcile both destinations before any retry`); }
  };
  await recoverPublication({
    inspect,
    createDraft: () => effect("gh", ["release", "create", tag, ...assetPaths, "--repo", repository, "--title", `OMP OmniRoute Provider ${version}`, "--notes-file", resolve(releaseDirectory, notes), "--draft", "--verify-tag"]),
    publishNpm: () => effect("npm", ["publish", resolve(releaseDirectory, archive), "--access", "public", "--ignore-scripts", "--fetch-retries=0"], { ...process.env, NODE_AUTH_TOKEN: npmToken }),
    publishGithub: () => effect("gh", ["release", "edit", tag, "--repo", repository, "--draft=false"]),
  }, destination);
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
  if (command === "verify-native-acp") {
    const [runId, revision, outputDirectory] = args;
    if (!runId || !revision || !outputDirectory || args.length !== 3) throw new Error("usage: bun run scripts/release-gate.ts verify-native-acp <run-id> <signed-revision> <private-output-directory>");
    const proof = await collectAcpNativeProof(runId, revision);
    const bytes = Buffer.from(`${JSON.stringify(proof)}\n`);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const directory = resolve(outputDirectory);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("Native ACP proof output must be an existing directory");
    await writeFile(resolve(directory, `${digest}.json`), bytes, { flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ status: "native-acp-evidence-collected-review-required", sha256: digest })}\n`);
    return;
  }
  if (command === "publish") {
    const [releaseDirectory, evidenceDirectory, tag, repository, qualificationPath, approval, destination] = args;
    if (!releaseDirectory || !evidenceDirectory || !tag || !repository || !qualificationPath || !approval || (destination !== "github-only" && destination !== "github-and-npm")) throw new Error("usage: bun run scripts/release-gate.ts publish <release-directory> <evidence-directory> <tag> <repository> <qualification-receipt.json> <approval-sha256> <github-only|github-and-npm>");
    await verifyReleaseApproval({ releaseDirectory, qualificationPath, expectedReceiptSha256: approval, destination });
    await publishApprovedRelease(releaseDirectory, evidenceDirectory, tag, repository, process.env.GH_TOKEN ?? "", destination === "github-and-npm" ? process.env.NODE_AUTH_TOKEN ?? "" : "", {}, destination);
    return;
  }
  if (command === "verify-environment") {
    const [environmentPath, environmentName] = args;
    if (!environmentPath || !environmentName) {
      throw new Error("usage: bun run scripts/release-gate.ts verify-environment <environment.json> <environment-name>");
    }
    const environment = await readJson(resolve(environmentPath), "GitHub release environment response");
    const result = verifyReleaseEnvironmentMetadata(environment, environmentName);
    process.stdout.write(`${JSON.stringify({ status: "protected-environment-verified", ...result }, null, 2)}\n`);
    return;
  }
  if (command === "verify-run") {
    const [runPath, jobsPath, repository, runId, sourceRevision] = args;
    if (!runPath || !jobsPath || !repository || !runId || !sourceRevision) {
      throw new Error("usage: bun run scripts/release-gate.ts verify-run <run.json> <jobs.json> <owner/repository> <run-id> <source-revision>");
    }
    const [run, jobs] = await Promise.all([
      readJson(resolve(runPath), "qualification workflow run"),
      readJson(resolve(jobsPath), "qualification workflow jobs"),
    ]);
    const result = verifyQualificationRunMetadata({ run, jobs, repository, runId, sourceRevision });
    process.stdout.write(`${JSON.stringify({ status: "producer-run-verified", ...result }, null, 2)}\n`);
    return;
  }

  const [releaseDirectory, qualificationPath, expectedReceiptSha256, requestedDestination] = args;
  const destination = command === "receipt" ? expectedReceiptSha256 ?? "github-and-npm" : requestedDestination ?? "github-and-npm";
  if (destination !== "github-only" && destination !== "github-and-npm") throw new Error("invalid release publication destination");
  if (!releaseDirectory || !qualificationPath || (command !== "receipt" && (command !== "approve" || !expectedReceiptSha256))) {
    throw new Error("usage: bun run scripts/release-gate.ts verify-environment <environment.json> <environment-name> | verify-run <run.json> <jobs.json> <owner/repository> <run-id> <source-revision> | receipt <release-directory> <qualification-receipt.json> | approve <release-directory> <qualification-receipt.json> <expected-approval-sha256>");
  }
  if (command === "receipt") {
    process.stdout.write(`${JSON.stringify(await createReleaseApprovalReceipt({ releaseDirectory, qualificationPath, destination }), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(await verifyReleaseApproval({ releaseDirectory, qualificationPath, expectedReceiptSha256: expectedReceiptSha256!, destination }), null, 2)}\n`);
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof Error && error.message.startsWith("usage:") ? 2 : 1;
  });
}
