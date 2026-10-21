import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";

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
    `CruxOmni-OMP-Client-v${version}-source.tar.gz`,
    `cruxexperts-cruxomni-omp-client-${version}.tgz`,
    `CruxOmni-OMP-Client-v${version}-graphics.zip`,
    `CruxOmni-OMP-Client-v${version}.cdx.json`,
    `CruxOmni-OMP-Client-v${version}-release-notes.md`,
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
  if (!gitShaPattern.test(sourceRevision) || publication.status !== "prepared" || publication.target !== "github-release-and-npm") throw new Error("release manifest is not a prepared receipt for this release workflow");
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
  const notesName = `CruxOmni-OMP-Client-v${version}-release-notes.md`;
  const notesArtifact = artifacts.find(item => item.name === notesName);
  if (!notesArtifact || !(await readFile(resolve(releaseDirectory, notesName))).equals(await readFile(resolve(root, "CHANGELOG.md")))) {
    throw new Error("versioned release notes must match the exact reviewed CHANGELOG.md bytes");
  }
  return { manifest: parsed as unknown as ReleaseManifest, bytes, packageArtifact: packageArtifacts[0]! };
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
      const bindingDigestFields = ["requestSchemaSha256", "authSha256", "responseProjectionSha256", "operationSemanticsSha256", "routeImportsSha256", "frameworkContextSha256"];
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
  if (eligibilityRoot.schemaVersion !== 2 || eligibilityRoot.recordKind !== "omniroute-release-eligibility") throw new Error("release eligibility contract identity is invalid");
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
    validateSmokeEvidence(evidence, target.id, packageArtifact);
  }
  if (qualificationTargetIds.some(id => !targetIds.has(id))) throw new Error("qualification receipt is missing one or more supported target IDs");
  return { targets: receipt.targets.length, operations: coverage.invokable, nonInvokable: coverage.nonInvokable, receiptBytes };
}

export async function createReleaseApprovalReceipt(options: { root?: string; releaseDirectory: string; qualificationPath: string }): Promise<{ status: "ready-for-protected-approval"; approvalReceiptSha256: string; manifestSha256: string; qualificationSha256: string; targets: number; qualifiedOperations: number; sourceRevision: string }> {
  const root = resolve(options.root ?? defaultRoot);
  const { manifest, bytes: manifestBytes, packageArtifact } = await validateManifest(root, resolve(options.releaseDirectory));
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

export async function verifyReleaseApproval(options: { root?: string; releaseDirectory: string; qualificationPath: string; expectedReceiptSha256: string }): Promise<Awaited<ReturnType<typeof createReleaseApprovalReceipt>>> {
  if (!sha256Pattern.test(options.expectedReceiptSha256)) throw new Error("expected approval receipt must be a lowercase SHA-256 digest");
  const receipt = await createReleaseApprovalReceipt(options);
  if (receipt.approvalReceiptSha256 !== options.expectedReceiptSha256) throw new Error(`exact release approval receipt mismatch: generated ${receipt.approvalReceiptSha256}`);
  return receipt;
}

async function main(): Promise<void> {
  const [command, ...args] = process.argv.slice(2);
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

  const [releaseDirectory, qualificationPath, expectedReceiptSha256] = args;
  if (!releaseDirectory || !qualificationPath || (command !== "receipt" && (command !== "approve" || !expectedReceiptSha256))) {
    throw new Error("usage: bun run scripts/release-gate.ts verify-environment <environment.json> <environment-name> | verify-run <run.json> <jobs.json> <owner/repository> <run-id> <source-revision> | receipt <release-directory> <qualification-receipt.json> | approve <release-directory> <qualification-receipt.json> <expected-approval-sha256>");
  }
  if (command === "receipt") {
    process.stdout.write(`${JSON.stringify(await createReleaseApprovalReceipt({ releaseDirectory, qualificationPath }), null, 2)}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify(await verifyReleaseApproval({ releaseDirectory, qualificationPath, expectedReceiptSha256: expectedReceiptSha256! }), null, 2)}\n`);
}

if (import.meta.main) {
  main().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = error instanceof Error && error.message.startsWith("usage:") ? 2 : 1;
  });
}
