import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { exportRelease } from "../scripts/export-release.ts";
import { cleanupNativeQualification, createQualificationSourceSnapshot, DockerCommandError, nativeSmokeTimeoutMs, prepareQualificationDependencyMount, runBoundedQualificationCommand, runOwnedMuslDockerTask, validateNativeSmokeOutput, writeNativeQualificationEvidence, type OwnedMuslDockerResources } from "../scripts/qualify-release.ts";
import { validateMuslRuntimeEvidence } from "../scripts/musl-runtime.ts";
import { createReleaseApprovalReceipt, publishApprovedRelease, recoverPublication, verifyQualificationRunMetadata, verifyReleaseApproval, verifyReleaseEnvironmentMetadata } from "../scripts/release-gate.ts";
import { cleanEnvironment, nativeAdminIoTimeoutMs, nativeInferenceTimeoutMs } from "../scripts/smoke.ts";
import { checkVersion, planVersion, setVersion } from "../scripts/version.ts";
import type { PackageVerificationResult } from "../scripts/verify-package.ts";

const temporaryRoots: string[] = [];
const projectName = "@cruxexperts/cruxomni-omp-client";
const hashA = "a".repeat(64);
const hashB = "b".repeat(64);
const gitHash = "c".repeat(40);
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
const targetHosts: Record<(typeof qualificationTargetIds)[number], { os: string; architecture: string; libc: string | null }> = {
  "linux-x64-glibc": { os: "linux", architecture: "x64", libc: "glibc" },
  "linux-arm64-glibc": { os: "linux", architecture: "arm64", libc: "glibc" },
  "linux-x64-musl": { os: "linux", architecture: "x64", libc: "musl" },
  "linux-arm64-musl": { os: "linux", architecture: "arm64", libc: "musl" },
  "darwin-x64": { os: "darwin", architecture: "x64", libc: null },
  "darwin-arm64": { os: "darwin", architecture: "arm64", libc: null },
  "windows-x64": { os: "windows", architecture: "x64", libc: null },
  "windows-arm64": { os: "windows", architecture: "arm64", libc: null },
};

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryRoots.push(path);
  return path;
}

async function commandFailure(promise: Promise<string>): Promise<DockerCommandError> {
  try {
    await promise;
    throw new Error("qualification command unexpectedly succeeded");
  } catch (error) {
    if (!(error instanceof DockerCommandError)) throw error;
    return error;
  }
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

async function muslRuntimeFixture(targetId: "linux-x64-musl" | "linux-arm64-musl", archiveSha256 = hashA, sourceRevision = gitHash): Promise<Record<string, unknown>> {
  const provenance = JSON.parse(await readFile(join(import.meta.dir, "../provenance/musl-runtime.json"), "utf8")) as {
    baseImage: { targets: Record<string, { baseManifestDigest: string; dockerPlatform: string; dockerArchitecture: string; apkIndex: { sha256: string; signerKeySha256: string }; finalInstalledInventory: Array<{ name: string; version: string; architecture: string }> }> };
  };
  const target = provenance.baseImage.targets[targetId]!;
  const inventory = [...target.finalInstalledInventory].sort((left, right) => left.name.localeCompare(right.name));
  const provenanceSha256 = createHash("sha256").update(await readFile(join(import.meta.dir, "../provenance/musl-runtime.json"))).digest("hex");
  const architecture = targetId.includes("x64") ? "x64" : "arm64";
  return {
    schemaVersion: 1,
    recordKind: "cruxomni-musl-runtime-verification",
    status: "verified",
    targetId,
    sourceRevision,
    archiveSha256,
    provenanceSha256,
    baseImageReference: `oven/bun@${target.baseManifestDigest}`,
    baseManifestDigest: target.baseManifestDigest,
    dockerPlatform: target.dockerPlatform,
    runnerArchitecture: architecture,
    daemonArchitecture: architecture,
    imageId: `sha256:${"d".repeat(64)}`,
    imageArchitecture: target.dockerArchitecture,
    buildNetwork: "none",
    apkInstallNetwork: "none",
    apkScripts: false,
    repositories: [],
    signedIndexSha256: target.apkIndex.sha256,
    signerKeySha256: target.apkIndex.signerKeySha256,
    verifiedApkCount: 26,
    installedDatabaseSha256: hashB,
    installedInventorySha256: createHash("sha256").update(JSON.stringify(inventory)).digest("hex"),
    installedPackageCount: inventory.length,
    installedInventory: inventory,
  };
}

function unsignedCommit(root: string, message: string): string {
  git(root, "add", "--all");
  git(root, "-c", "commit.gpgsign=false", "commit", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

async function put(root: string, path: string, content: string): Promise<void> {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content);
}

function qualificationOperation(id: string): Record<string, unknown> {
  const binding = Object.fromEntries([
    "requestSchemaSha256",
    "authSha256",
    "responseProjectionSha256",
    "operationSemanticsSha256",
    "routeImportsSha256",
    "frameworkContextSha256",
  ].map(field => [field, hashB]));
  return {
    operationId: id,
    status: "verified",
    reason: "Synthetic test fixture only.",
    source: { file: "src/index.ts", sha256: hashA, gitBlobSha: gitHash },
    binding: { ...binding, sideEffect: "read" },
    test: { id: "test/fixture.test.ts", observedOutcome: `provenance/qualification/${hashA}.json`, caseSha256: hashA, outcomeSha256: hashB },
    evidence: [{ kind: "fixture", detail: "Synthetic test fixture only." }],
  };
}

async function fixtureRepo(options: { secondInvokable?: boolean; missingQualificationWorkflow?: boolean; eligibilitySchemaVersion?: number } = {}): Promise<string> {
  const root = await temporaryDirectory("cruxomni-release-repo-");
  git(root, "init", "-b", "main");
  git(root, "config", "user.name", "Unsigned Fixture");
  git(root, "config", "user.email", "fixture@example.invalid");
  const packageJson = { name: projectName, version: "0.1.1", packageManager: "bun@1.4.2" };
  const marketplace = { id: "cruxomni-omp-client", version: "0.1.1" };
  const invokableId = "GET /api/fixture";
  const invokable = {
    operationId: invokableId,
    source: { file: "src/index.ts", sha256: hashA, gitBlobSha: gitHash },
    coverage: { adapterId: "fixture.get", reason: null, status: "invokable" },
  };
  const nonInvokable = {
    operationId: "OPTIONS /api/fixture",
    source: { file: "src/index.ts", sha256: hashA, gitBlobSha: gitHash },
    coverage: { adapterId: null, reason: "Fixture source confirms the route is not invokable.", status: "non-invokable" },
  };
  const operations = [invokable, nonInvokable];
  if (options.secondInvokable) operations.push({ ...invokable, operationId: "POST /api/fixture" });

  const files: Record<string, string> = {
    ".gitignore": "release/\n",
    "ASSET_LICENSE.md": "fixture license\n",
    "CHANGELOG.md": "fixture changelog\n",
    "CONTRIBUTING.md": "fixture guide\n",
    "LICENSE": "fixture license text\n",
    "README.md": "fixture package\n",
    "SECURITY.md": "fixture security\n",
    "SUPPORT.md": "fixture support\n",
    "THIRD_PARTY_NOTICES.md": "fixture notices\n",
    ".github/workflows/qualification.yml": "name: release-qualification\non:\n  workflow_dispatch:\njobs: {}\n",
    "VERSION": "0.1.1\n",
    "bun.lock": "{}\n",
    "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
    "tsconfig.json": "{}\n",
    ".omp-plugin/marketplace.json": `${JSON.stringify(marketplace, null, 2)}\n`,
    "contracts/operations.json": `${JSON.stringify({ operations }, null, 2)}\n`,
    "contracts/release-eligibility.json": `${JSON.stringify({ schemaVersion: options.eligibilitySchemaVersion ?? 3, recordKind: "omniroute-release-eligibility", operations: [qualificationOperation(invokableId)] }, null, 2)}\n`,
    "src/index.ts": "export {};\n",
  };
  if (options.missingQualificationWorkflow) delete files[".github/workflows/qualification.yml"];
  for (const [path, content] of Object.entries(files)) await put(root, path, content);
  unsignedCommit(root, "chore: fixture baseline");
  git(root, "tag", "v0.1.1");
  return root;
}

async function fakePackageEvidence(root: string): Promise<PackageVerificationResult> {
  const directory = await temporaryDirectory("cruxomni-package-fixture-");
  const archive = join(directory, "package.tgz");
  await writeFile(archive, "synthetic npm archive\n");
  return {
    status: "verified",
    archiveSha256: hashA,
    archive,
    extractedRoot: join(directory, "extract", "package"),
    entries: [],
    fileSha256: {},
    lockfile: { path: "bun.lock", sha256: hashA, lockfileVersion: 1, packages: [] },
    sbom: { synthetic: true },
  } as unknown as PackageVerificationResult;
}

async function exportFixture(root: string, output: string): Promise<void> {
  await exportRelease({ root, outputDirectory: output, packageVerifier: () => fakePackageEvidence(root) });
}

async function syntheticNativeSmoke(id: typeof qualificationTargetIds[number], archiveSha256: string, version = "0.1.1") {
  const provenance = JSON.parse(await readFile(join(import.meta.dir, "../provenance/release-artifacts.json"), "utf8")) as {
    artifacts: Array<{ upstream: string; release_tag: string; url: string; sha256: string; peeled_commit: string }>;
  };
  const pins = JSON.parse(await readFile(join(import.meta.dir, "../provenance/upstreams.json"), "utf8")) as {
    upstreams: Array<{ id: string; release: { version: string; tag: string } }>;
  };
  const omp = pins.upstreams.find(item => item.id === "omp")!.release;
  const assetNames: Record<typeof qualificationTargetIds[number], string> = {
    "linux-x64-glibc": "omp-linux-x64", "linux-arm64-glibc": "omp-linux-arm64",
    "linux-x64-musl": "omp-linux-musl-x64", "linux-arm64-musl": "omp-linux-musl-arm64",
    "darwin-x64": "omp-darwin-x64", "darwin-arm64": "omp-darwin-arm64",
    "windows-x64": "omp-windows-x64.exe", "windows-arm64": "omp-windows-arm64.exe",
  };
  const asset = provenance.artifacts.find(item => item.upstream === "omp" && item.release_tag === omp.tag && item.url.endsWith(`/${assetNames[id]}`))!;
  const inference = { modelId: "fixture-model", api: "openai-responses", path: "/v1/responses", postCount: 1, streamedText: true, usageObserved: true };
  return {
    status: "verified",
    platform: { targetId: id, ...targetHosts[id] },
    host: { mode: "release-asset", version: omp.version, digest: asset.sha256, supportedRange: ">=18.12.2 <19" },
    upstream: { version: omp.version, commit: asset.peeled_commit, asset: asset.url, digest: asset.sha256 },
    fixture: { baseUrl: "http://127.0.0.1:12345", requests: 21, failedDiscoveryGets: 1, responsesPosts: 2, chatCompletionsPosts: 2, loopbackOnly: true },
    installation: { method: "npm", version, archiveSha256, metadataGets: 1, tarballGets: 1, installedFiles: 5, ordinaryDirectory: true, fileDigestsMatched: true, noInstalledHostSdk: true, credentialFreeRegistry: true },
    pluginLifecycle: { installed: true, disabled: true, enabled: true, uninstalled: true },
    native: {
      prompt: true, cancellation: true, wizardRendered: true, wizardCancellation: true, maskedPrompt: true, persisted: true,
      inference: { startupResponses: inference, startupChatCompletions: inference, persistedChatCompletions: inference },
      legacyCache: { seeded: true, seederUninstalled: true, modelId: "fixture-legacy-model", api: "openai-responses", liveDiscoveryStatus: 503, selectable: false, inferencePosts: 0 },
      toolContinuation: { modelId: "fixture-model", api: "openai-completions", postCount: 2, tool: "read", fileResultObserved: true, streamedContinuation: true },
      administration: {
        family: "fallback-chains", route: "/api/fallback/chains",
        readOperationId: "GET /api/fallback/chains", mutationOperationId: "POST /api/fallback/chains", cleanupOperationId: "DELETE /api/fallback/chains",
        readRequests: 7, mutationRequests: 1, cleanupRequests: 1, confirmedMutationAttempts: 2,
        unknownOutcomes: 2, durability: "unverified",
        fixtureAuthorization: true, exactMutationBodies: true, baselineAbsent: true,
        runtimeReadBack: true, cleanupRead: true, noUnexpectedAdminRequests: true,
      },
    },
  };
}

async function qualificationFor(output: string, root: string, skipGateHash = false): Promise<{ path: string; hash: string }> {
  const manifest = JSON.parse(await readFile(join(output, "release-manifest.json"), "utf8")) as { version: string; sourceRevision: string; artifacts: Array<{ name: string; sha256: string }> };
  const packageArchive = manifest.artifacts.find(item => item.name.endsWith(".tgz"))!;
  const packageArchiveSha256 = packageArchive.sha256;
  const workflowPath = ".github/workflows/qualification.yml";
  const workflowBytes = await readFile(join(root, workflowPath)).catch(() => Buffer.alloc(0));
  const producer = {
    repository: "CruxExperts/OMP-OmniRoute-Provider",
    runId: "90000001",
    workflowPath,
    workflowName: "release-qualification",
    workflowSha256: createHash("sha256").update(workflowBytes).digest("hex"),
  };
  const bundle = join(dirname(root), `${basename(root)}-qualification`);
  await mkdir(join(bundle, "evidence"), { recursive: true });
  const targetEvidence = await Promise.all(qualificationTargetIds.map(async id => {
    const nativeSmoke = await syntheticNativeSmoke(id, packageArchiveSha256, manifest.version);
    const installOutput = JSON.stringify(nativeSmoke.installation);
    const smokeCheckOutput = JSON.stringify({
      status: nativeSmoke.status, platform: nativeSmoke.platform, host: nativeSmoke.host,
      upstream: nativeSmoke.upstream, fixture: nativeSmoke.fixture, native: nativeSmoke.native,
      pluginLifecycle: nativeSmoke.pluginLifecycle,
    });
    const checks = [
      { id: "install-package", status: "passed", output: installOutput, outputSha256: createHash("sha256").update(installOutput).digest("hex") },
      { id: "package-smoke", status: "passed", output: smokeCheckOutput, outputSha256: createHash("sha256").update(smokeCheckOutput).digest("hex") },
    ];
    const smokeOutput = JSON.stringify(nativeSmoke);
    const evidence = {
      schemaVersion: 1,
      recordKind: "omniroute-target-qualification",
      id,
      status: "passed",
      version: manifest.version,
      sourceRevision: manifest.sourceRevision,
      archiveSha256: packageArchiveSha256,
      producer: { ...producer, jobName: id },
      host: targetHosts[id],
      ...(id === "linux-x64-musl" || id === "linux-arm64-musl"
        ? { runtime: await muslRuntimeFixture(id, packageArchiveSha256, manifest.sourceRevision) }
        : {}),
      smoke: {
        command: `bun run qualification:target --package ${packageArchive.name}`,
        exitCode: 0,
        output: smokeOutput,
        outputSha256: createHash("sha256").update(smokeOutput).digest("hex"),
        checks,
      },
    };
    const bytes = Buffer.from(`${JSON.stringify(evidence, null, 2)}\n`);
    const evidenceRef = `evidence/${id}.json`;
    await writeFile(join(bundle, evidenceRef), bytes);
    return {
      id,
      status: "passed",
      version: manifest.version,
      sourceRevision: manifest.sourceRevision,
      archiveSha256: packageArchiveSha256,
      evidenceRef,
      evidenceSha256: createHash("sha256").update(bytes).digest("hex"),
    };
  }));
  const path = join(bundle, "qualification-receipt.json");
  await writeFile(path, `${JSON.stringify({ schemaVersion: 1, release: { version: manifest.version, sourceRevision: manifest.sourceRevision }, producer, packageArchiveSha256, targets: targetEvidence }, null, 2)}\n`);
  if (skipGateHash) return { path, hash: hashA };
  const receipt = await createReleaseApprovalReceipt({ root, releaseDirectory: output, qualificationPath: path });
  return { path, hash: receipt.approvalReceiptSha256 };
}

function qualificationRunMetadata() {
  const runId = "90000001";
  const repository = "CruxExperts/OMP-OmniRoute-Provider";
  const sourceRevision = gitHash;
  const run = {
    id: Number(runId),
    repository: { full_name: repository },
    event: "workflow_dispatch",
    head_sha: sourceRevision,
    path: ".github/workflows/qualification.yml",
    name: "release-qualification",
    status: "completed",
    conclusion: "success",
  };
  const jobs = {
    total_count: qualificationTargetIds.length,
    jobs: qualificationTargetIds.map(name => ({
      name,
      run_id: Number(runId),
      head_sha: sourceRevision,
      status: "completed",
      conclusion: "success",
    })),
  };
  return { run, jobs, repository, runId, sourceRevision };
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

describe("release automation", () => {
  it("checks remote bytes and authenticated readback before publication effects", async () => {
    const dir = await temporaryDirectory("cruxomni-publication-readback-");
    const archive = Buffer.from("approved package");
    const notes = "reviewed notes\n";
    const assets = new Map<string, Buffer>([
      ["package.tgz", archive], ["review-release-notes.md", Buffer.from(notes)],
      ["SHA256SUMS.txt", Buffer.from("checksums")], ["release-qualification-receipt.json", Buffer.from("receipt")],
      ["release-approval.json", Buffer.from("approval")], ["release-qualification-evidence.tar.gz", Buffer.from("evidence")],
    ]);
    const manifest = JSON.stringify({ package: projectName, version: "0.1.1", artifacts: [{ name: "package.tgz" }, { name: "review-release-notes.md" }] });
    assets.set("release-manifest.json", Buffer.from(manifest));
    for (const [name, bytes] of assets) await writeFile(join(dir, name), bytes);
    const sha = createHash("sha512").update(archive).digest("base64");
    for (const fault of ["none", "chunked", "npm-absent", "github-auth", "npm-auth", "asset", "asset-oversized", "asset-short", "notes", "integrity", "tarball", "tarball-oversized", "tarball-short", "metadata-tag-oversized", "metadata-releases-oversized", "metadata-package-oversized", "metadata-version-oversized", "npm-version-error", "npm-version-unauthorized", "npm-inconsistent", "redirect-untrusted", "redirect-trusted"] as const) {
      const effects: string[] = [];
      let npmPublished = fault !== "npm-absent";
      const entries = [...assets.entries()];
      let cancelled = false;
      const streamed = (chunks: Uint8Array[]) => {
        let index = 0;
        return new Response(new ReadableStream<Uint8Array>({
          pull(controller) { if (index < chunks.length) controller.enqueue(chunks[index++]!); else controller.close(); },
          cancel() { cancelled = true; },
        }, { highWaterMark: 0 }));
      };
      const oversizedMetadata = () => streamed([new Uint8Array(8 * 1024 * 1024), new Uint8Array(1), new Uint8Array(1)]);
      const chunked = (bytes: Buffer) => streamed([bytes.subarray(0, 3), bytes.subarray(3)]);
      const fetcher = async (input: string | URL | Request): Promise<Response> => {
        const url = String(input);
        const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
        if (url.endsWith("/repos/owner/repo")) return json({}, fault === "github-auth" ? 403 : 200);
        if (url.endsWith("/-/whoami")) return json({}, fault === "npm-auth" ? 401 : 200);
        if (url.includes("/git/ref/tags/")) return fault === "metadata-tag-oversized" ? oversizedMetadata() : json({ object: { type: "tag", sha: gitHash } });
        if (url.includes("/releases?")) return fault === "metadata-releases-oversized" ? oversizedMetadata() : json([{ tag_name: "v0.1.1", name: "OMP OmniRoute Provider 0.1.1", draft: true, prerelease: false, body: fault === "notes" ? "different" : notes, assets: entries.map(([name], index) => ({ name, id: index + 1, state: "uploaded" })) }]);
        if (url.includes("/releases/assets/")) {
          const index = Number(url.split("/").pop()) - 1;
          if (index === 0 && (fault === "redirect-untrusted" || fault === "redirect-trusted")) return new Response(null, { status: 302, headers: { location: fault === "redirect-trusted" ? "https://release-assets.githubusercontent.com/asset" : "https://evil.example/asset" } });
          if (index === 0 && fault === "asset-oversized") return streamed([entries[index]![1], new Uint8Array(1), new Uint8Array(1)]);
          if (index === 0 && fault === "asset-short") return streamed([entries[index]![1].subarray(0, 3)]);
          if (fault === "chunked") return chunked(entries[index]![1]);
          return new Response(fault === "asset" && index === 0 ? "changed" : new Uint8Array(entries[index]![1]));
        }
        if (url === "https://release-assets.githubusercontent.com/asset") return new Response(new Uint8Array(entries[0]![1]));
        if (url.endsWith("/%40cruxexperts%2Fcruxomni-omp-client")) return fault === "metadata-package-oversized" ? oversizedMetadata() : json({ name: projectName, versions: npmPublished || fault === "npm-inconsistent" ? { "0.1.1": {} } : {} });
        if (url.endsWith("/%40cruxexperts%2Fcruxomni-omp-client/0.1.1")) {
          if (fault === "metadata-version-oversized") return oversizedMetadata();
          if (fault === "npm-version-error") return json({}, 500);
          if (fault === "npm-version-unauthorized") return json({}, 401);
          if (!npmPublished || fault === "npm-inconsistent") return json({}, 404);
          return json({ name: projectName, version: "0.1.1", dist: { integrity: fault === "integrity" ? "sha512-wrong" : `sha512-${sha}`, tarball: "https://registry.npmjs.org/pkg.tgz" } });
        }
        if (url.endsWith("/pkg.tgz")) {
          if (fault === "tarball-oversized") return streamed([archive, new Uint8Array(1), new Uint8Array(1)]);
          if (fault === "tarball-short") return streamed([archive.subarray(0, 3)]);
          return fault === "chunked" ? chunked(archive) : new Response(fault === "tarball" ? "changed" : new Uint8Array(archive));
        }
        throw new Error(`unexpected fixture URL ${url}`);
      };
      let published = false;
      const request = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
        if (String(input).startsWith("https://release-assets.githubusercontent.com/")) expect(init?.headers).toBeUndefined();
        const response = await fetcher(input);
        if (published && String(input).includes("/releases?")) {
          const releases = await response.json() as Array<Record<string, unknown>>;
          releases[0]!.draft = false;
          return new Response(JSON.stringify(releases));
        }
        return response;
      };
      const operation = publishApprovedRelease(dir, dir, "v0.1.1", "owner/repo", "github-token", "npm-token", {
        fetch: request as unknown as typeof fetch,
        command: async (name, args) => { if (name === "git") return { stdout: gitHash }; effects.push(name); if (name === "npm") { expect(args).toContain("--fetch-retries=0"); npmPublished = true; } else published = true; return { stdout: "" }; },
      });
      if (fault === "none" || fault === "chunked" || fault === "redirect-trusted") { await operation; expect(effects).toEqual(["gh"]); }
      else if (fault === "npm-absent") { await operation; expect(effects).toEqual(["npm", "gh"]); }
      else { await expect(operation).rejects.toThrow(); expect(effects).toEqual([]); }
      if (fault.includes("oversized")) expect(cancelled).toBe(true);
    }
  });

  it("executes only missing protected publication effects and reconciles after each", async () => {
    for (const [initialGithub, initialNpm, expected] of [
      ["absent", "absent", ["draft", "npm", "github"]],
      ["draft", "absent", ["npm", "github"]],
      ["draft", "published", ["github"]],
      ["published", "published", []],
    ] as const) {
      let github: "absent" | "draft" | "published" = initialGithub;
      let npm: "absent" | "published" = initialNpm;
      const effects: string[] = [];
      let reads = 0;
      await recoverPublication({
        inspect: async () => { reads++; return { github, npm }; },
        createDraft: async () => { effects.push("draft"); github = "draft"; },
        publishNpm: async () => { effects.push("npm"); npm = "published"; },
        publishGithub: async () => { effects.push("github"); github = "published"; },
      });
      expect(effects).toEqual([...expected]);
      expect(reads).toBe(expected.length + 1);
    }
  });

  it("stops on uncertain reads, failed effects, and inconsistent destination states", async () => {
    for (const failure of ["initial-read", "draft", "post-draft-read", "npm", "post-npm-read", "github", "post-github-read"] as const) {
      let github: "absent" | "draft" | "published" = "absent";
      let npm: "absent" | "published" = "absent";
      const effects: string[] = [];
      let reads = 0;
      const failRead = failure === "initial-read" ? 1 : failure === "post-draft-read" ? 2 : failure === "post-npm-read" ? 3 : failure === "post-github-read" ? 4 : 0;
      await expect(recoverPublication({
        inspect: async () => { if (++reads === failRead) throw new Error("readback unavailable"); return { github, npm }; },
        createDraft: async () => { effects.push("draft"); if (failure === "draft") throw new Error("uncertain draft"); github = "draft"; },
        publishNpm: async () => { effects.push("npm"); if (failure === "npm") throw new Error("uncertain npm"); npm = "published"; },
        publishGithub: async () => { effects.push("github"); if (failure === "github") throw new Error("uncertain github"); github = "published"; },
      })).rejects.toThrow();
      const expectedCount = failure === "initial-read" ? 0 : failure === "draft" || failure === "post-draft-read" ? 1 : failure === "npm" || failure === "post-npm-read" ? 2 : 3;
      expect(effects).toEqual(["draft", "npm", "github"].slice(0, expectedCount));
    }
    for (const state of [{ github: "absent", npm: "published" }, { github: "published", npm: "absent" }] as const) {
      const effects: string[] = [];
      await expect(recoverPublication({ inspect: async () => state, createDraft: async () => { effects.push("draft"); }, publishNpm: async () => { effects.push("npm"); }, publishGithub: async () => { effects.push("github"); } })).rejects.toThrow("inconsistent");
      expect(effects).toEqual([]);
    }
  });

  it("builds a shallow source snapshot from the exact commit without checkout-local state", async () => {
    const source = await temporaryDirectory("cruxomni-musl-snapshot-source-");
    git(source, "init", "-b", "main");
    git(source, "config", "user.name", "Unsigned Snapshot Fixture");
    git(source, "config", "user.email", "snapshot@example.invalid");
    await put(source, ".gitignore", ".agents/\n.env\n.gitconfig\n.bash_history\n");
    await put(source, "tracked.txt", "first committed bytes\n");
    const olderRevision = unsignedCommit(source, "chore: snapshot fixture baseline");
    await put(source, "tracked.txt", "exact committed bytes\n");
    await put(source, "src/index.ts", "export const fixture = true;\n");
    const expectedRevision = unsignedCommit(source, "chore: snapshot fixture update");
    expect(expectedRevision).not.toBe(olderRevision);
    git(source, "config", "remote.origin.url", "https://private.invalid/checkout.git");
    git(source, "config", "core.hooksPath", "/private/hooks");
    git(source, "checkout", "--detach", expectedRevision);
    await put(source, ".agents/state/private.json", "private ignored state\n");
    await put(source, ".env", "PRIVATE_SENTINEL=do-not-copy\n");
    await put(source, ".gitconfig", "[credential]\n\thelper = store\n");
    await put(source, ".bash_history", "private shell history\n");

    const destination = join(await temporaryDirectory("cruxomni-musl-snapshot-output-"), "workspace");
    await createQualificationSourceSnapshot(source, expectedRevision, destination);
    expect(git(destination, "rev-parse", "HEAD")).toBe(expectedRevision);
    expect(git(destination, "rev-parse", "--is-shallow-repository")).toBe("true");
    expect(git(destination, "rev-list", "--count", "HEAD")).toBe("1");
    expect(() => git(destination, "rev-parse", "HEAD^" )).toThrow();
    expect(git(destination, "remote")).toBe("");
    expect(git(destination, "config", "--local", "--name-only", "--list").split(/\r?\n/).sort()).toEqual([
      "core.bare",
      "core.filemode",
      "core.logallrefupdates",
      "core.repositoryformatversion",
    ]);
    expect(await lstat(join(destination, ".git", "objects", "info", "alternates")).catch(() => undefined)).toBeUndefined();
    expect(await readFile(join(destination, "tracked.txt"), "utf8")).toBe("exact committed bytes\n");
    expect(await readFile(join(destination, "src/index.ts"), "utf8")).toBe("export const fixture = true;\n");
    for (const privatePath of [".agents", ".env", ".gitconfig", ".bash_history"]) {
      expect(await lstat(join(destination, privatePath)).catch(() => undefined)).toBeUndefined();
    }

    const objectFiles = async (directory: string): Promise<Array<{ dev: number; ino: number }>> => {
      const result: Array<{ dev: number; ino: number }> = [];
      const visit = async (current: string): Promise<void> => {
        for (const entry of await readdir(current, { withFileTypes: true })) {
          const path = join(current, entry.name);
          const info = await lstat(path);
          if (info.isDirectory()) await visit(path);
          else if (info.isFile()) result.push({ dev: info.dev, ino: info.ino });
          else throw new Error("fixture object directory contains an unsupported entry");
        }
      };
      await visit(directory);
      return result;
    };
    const sourceObjects = await objectFiles(join(source, ".git/objects"));
    const snapshotObjects = await objectFiles(join(destination, ".git/objects"));
    expect(snapshotObjects.length).toBeGreaterThan(0);
    expect(snapshotObjects.some(snapshot => sourceObjects.some(original => original.dev === snapshot.dev && original.ino === snapshot.ino))).toBe(false);
    const dependencyMount = await prepareQualificationDependencyMount(destination);
    expect(dependencyMount).toBe(join(destination, "node_modules"));
    expect((await lstat(dependencyMount)).isDirectory()).toBe(true);
    expect(await readdir(dependencyMount)).toEqual([]);
    await expect(prepareQualificationDependencyMount(destination)).rejects.toThrow("already contains a node_modules path");
    await expect(createQualificationSourceSnapshot(source, olderRevision, join(await temporaryDirectory("cruxomni-musl-snapshot-wrong-") , "workspace"))).rejects.toThrow("checkout HEAD does not match");
  });

  it("cleans only the task-owned musl container and image tag after timeout or interruption", async () => {
    for (const termination of ["timeout", "interrupted"] as const) {
      const root = await temporaryDirectory(`cruxomni-musl-lifecycle-${termination}-`);
      const ownerToken = "123e4567-e89b-42d3-a456-426614174000";
      const containerName = `cruxomni-musl-x64-${ownerToken}`;
      const imageTag = `cruxomni-musl-x64:${ownerToken}`;
      const containerId = "a".repeat(64);
      const imageId = `sha256:${"b".repeat(64)}`;
      const unrelatedImageTag = "unrelated-application:kept";
      const resources: OwnedMuslDockerResources = {
        containerName,
        ownerToken,
        cidFile: join(root, "container.cid"),
        imageTag,
        imageId,
        imageTagOwned: true,
      };
      await writeFile(resources.cidFile, `${containerId}\n`);
      let containerPresent = true;
      let containerRunning = true;
      const imageTags = new Map([[imageTag, imageId], [unrelatedImageTag, imageId]]);
      const events: string[] = [];
      const fakeDocker = async (args: string[]): Promise<string> => {
        const [category, action, ...rest] = args;
        if (category === "container" && action === "ls") {
          events.push("container-list");
          return containerPresent ? containerId : "";
        }
        if (category === "container" && action === "inspect") {
          events.push("container-inspect");
          return `${containerId}|/${containerName}|${containerRunning}|${ownerToken}`;
        }
        if (category === "container" && action === "stop") {
          events.push("container-stop");
          if (termination === "timeout") throw new Error("simulated stop timeout");
          containerRunning = false;
          return containerId;
        }
        if (category === "container" && action === "kill") {
          events.push("container-kill");
          containerRunning = false;
          return containerId;
        }
        if (category === "container" && action === "rm") {
          expect(rest).toContain(containerId);
          events.push("container-remove");
          containerPresent = false;
          containerRunning = false;
          return containerId;
        }
        if (category === "image" && action === "ls") {
          const tag = rest.at(-1)!;
          events.push(`image-list:${tag}`);
          return imageTags.get(tag) ?? "";
        }
        if (category === "image" && action === "rm") {
          const tag = rest[0]!;
          events.push(`image-remove:${tag}`);
          if (tag === imageId || tag !== imageTag) throw new Error("cleanup attempted to remove a non-owned image reference");
          imageTags.delete(tag);
          return "Untagged: ";
        }
        throw new Error(`unexpected fake docker command: ${args.join(" ")}`);
      };
      const failure = new DockerCommandError(`simulated ${termination}`, "smoke output", "smoke error", null, termination);
      await expect(runOwnedMuslDockerTask(resources, async () => { throw failure; }, fakeDocker, async () => { events.push("release-mounts"); })).rejects.toBe(failure);
      expect(events.indexOf("container-remove")).toBeGreaterThan(-1);
      expect(events.indexOf("container-remove")).toBeLessThan(events.indexOf(`image-remove:${imageTag}`));
      expect(events.indexOf(`image-remove:${imageTag}`)).toBeLessThan(events.indexOf("release-mounts"));
      expect(imageTags.get(unrelatedImageTag)).toBe(imageId);
      expect(events.some(event => event === `image-remove:${imageId}`)).toBe(false);
      if (termination === "timeout") expect(events).toContain("container-kill");
      else expect(events).not.toContain("container-kill");
    }
  });

  it("reconciles an absent tag before build and a created tag after a failed build", async () => {
    for (const imageCreated of [false, true]) {
      const root = await temporaryDirectory("cruxomni-musl-build-cleanup-");
      const ownerToken = "123e4567-e89b-42d3-a456-426614174000";
      const imageId = `sha256:${"b".repeat(64)}`;
      const resources: OwnedMuslDockerResources = {
        containerName: `cruxomni-musl-x64-${ownerToken}`,
        ownerToken,
        cidFile: join(root, "container.cid"),
        imageTag: `cruxomni-musl-x64:${ownerToken}`,
        imageTagOwned: true,
      };
      let tagPresent = imageCreated;
      let mountsReleased = false;
      const commands: string[] = [];
      const fakeDocker = async (args: string[]): Promise<string> => {
        commands.push(args.join(" "));
        if (args[0] === "container" && args[1] === "ls") return "";
        if (args[0] === "image" && args[1] === "ls") return tagPresent ? imageId : "";
        if (args[0] === "image" && args[1] === "rm" && args[2] === resources.imageTag) {
          tagPresent = false;
          return resources.imageTag;
        }
        throw new Error(`unexpected cleanup command: ${args.join(" ")}`);
      };
      const failedBuild = new Error(imageCreated ? "build failed after image creation" : "download failed before build");
      await expect(runOwnedMuslDockerTask(resources, async () => { throw failedBuild; }, fakeDocker, async () => { mountsReleased = true; })).rejects.toBe(failedBuild);
      expect(mountsReleased).toBe(true);
      expect(tagPresent).toBe(false);
      expect(resources.imageId).toBe(imageCreated ? imageId : undefined);
      expect(commands.some(command => command.startsWith("image rm "))).toBe(imageCreated);
      expect(commands.some(command => command.includes(`image rm ${imageId}`))).toBe(false);
    }
  });

  it("reclaims a named verifier container after interruption before any image build", async () => {
    const root = await temporaryDirectory("cruxomni-musl-verifier-cleanup-");
    const ownerToken = "123e4567-e89b-42d3-a456-426614174000";
    const containerId = "c".repeat(64);
    const resources: OwnedMuslDockerResources = {
      containerName: `cruxomni-musl-x64-${ownerToken}`,
      ownerToken,
      cidFile: join(root, "container.cid"),
      imageTag: `cruxomni-musl-x64:${ownerToken}`,
      imageTagOwned: true,
    };
    await writeFile(resources.cidFile, `${containerId}\n`);
    let containerPresent = true;
    let containerRunning = true;
    let released = false;
    const events: string[] = [];
    const fakeDocker = async (args: string[]): Promise<string> => {
      const [category, action] = args;
      if (category === "container" && action === "ls") return containerPresent ? containerId : "";
      if (category === "container" && action === "inspect") return `${containerId}|/${resources.containerName}|${containerRunning}|${ownerToken}`;
      if (category === "container" && action === "stop") {
        events.push("stop");
        containerRunning = false;
        return containerId;
      }
      if (category === "container" && action === "rm") {
        events.push("remove");
        containerPresent = false;
        return containerId;
      }
      if (category === "image" && action === "ls") return "";
      throw new Error(`unexpected verifier cleanup command: ${args.join(" ")}`);
    };
    const interrupted = new DockerCommandError("verifier interrupted", "", "", null, "interrupted");
    await expect(runOwnedMuslDockerTask(resources, async () => { throw interrupted; }, fakeDocker, async () => { events.push("release"); released = true; })).rejects.toBe(interrupted);
    expect(events).toEqual(["stop", "remove", "release"]);
    expect(released).toBe(true);
  });

  it("bounds real child-process output and handles timeout and abort", async () => {
    const outputChunks: Buffer[] = [];
    const overLimit = runBoundedQualificationCommand(process.execPath, ["-e", "process.stdout.write('x'.repeat(200000)); process.stderr.write('y'.repeat(200000))"], {
      maxBuffer: 4096,
      timeout: 10_000,
      onOutput: (_stream, chunk) => outputChunks.push(chunk),
    });
    const overflow = await commandFailure(overLimit);
    expect(overflow).toBeInstanceOf(DockerCommandError);
    expect(overflow.termination).toBe("output-limit");
    expect(Buffer.byteLength(overflow.stdout) + Buffer.byteLength(overflow.stderr)).toBeLessThanOrEqual(4096);
    expect(outputChunks.reduce((total, chunk) => total + chunk.byteLength, 0)).toBeLessThanOrEqual(4096);

    const timeout = await commandFailure(runBoundedQualificationCommand(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { timeout: 100, maxBuffer: 1024 }));
    expect(timeout).toBeInstanceOf(DockerCommandError);
    expect(timeout.termination).toBe("timeout");

    const controller = new AbortController();
    const interruption = await commandFailure(runBoundedQualificationCommand(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
      timeout: 10_000,
      maxBuffer: 1024,
      signal: controller.signal,
      onOutput: () => controller.abort(),
    }));
    expect(interruption).toBeInstanceOf(DockerCommandError);
    expect(interruption.termination).toBe("interrupted");
  });

  it("handles an owned native process tree before releasing its workspace", async () => {
    const work = await temporaryDirectory("cruxomni-owned-tree-");
    // This integration test exercises the real OS process tree and deadline.
    let pids: number[] = [];
    const childScript = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e', 'setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(process.pid,child.pid); setInterval(()=>{},1000);`;
    try {
      const failure = await commandFailure(runBoundedQualificationCommand(process.execPath, ["-e", childScript], {
        cwd: work, timeout: 4_000, maxBuffer: 1024, ownedTree: true,
        onOutput: (_stream, chunk) => { pids = chunk.toString().trim().split(/\s+/).map(Number); },
      }));
      expect(failure.termination).toBe("timeout");
      expect(pids).toHaveLength(2);
      if (process.platform === "win32") {
        expect(failure.residualProcesses).toBe(true);
        expect(failure.message).toContain("descendants may still be running");
        expect(failure.message).toContain("termination unconfirmed");
        expect(() => process.kill(pids[0]!, 0)).toThrow();
        expect(() => process.kill(pids[1]!, 0)).not.toThrow();
      } else {
        expect(failure.residualProcesses).toBe(false);
        expect(() => process.kill(pids[1]!, 0)).toThrow();
      }
    } finally {
      if (process.platform === "win32") for (const pid of pids) { try { process.kill(pid); } catch {} }
    }
  });

  it("does not target an exited wrapper whose descendant holds its pipe", async () => {
    // The real deadline must race an exited OS process with a still-open pipe.
    let descendant = 0;
    // Bun keeps the wrapper alive for its child unless it explicitly exits.
    const script = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore',1,2]}); child.once('spawn',()=>process.stdout.write(String(child.pid)+'\\n',()=>process.exit(0)));`;
    try {
      const failure = await commandFailure(runBoundedQualificationCommand(process.execPath, ["-e", script], {
        timeout: 2_000, ownedTree: true,
        onOutput: (_stream, chunk) => { descendant = Number(chunk.toString().trim()); },
      }));
      expect(descendant).toBeGreaterThan(0);
      expect(failure.termination).toBe("timeout");
      expect(failure.residualProcesses).toBe(true);
      expect(() => process.kill(descendant, 0)).not.toThrow();
    } finally {
      if (descendant) try { process.kill(descendant); } catch {}
    }
  });

  it("retains the workspace when process tree termination is unconfirmed", async () => {
    const paths: string[] = [];
    const remove: typeof rm = async path => { paths.push(String(path)); };
    const failure = new DockerCommandError("timed out; termination unconfirmed", "", "", null, "timeout", true);
    await expect(cleanupNativeQualification("work", "output", false, failure, remove)).rejects.toThrow("workspace retained at work");
    expect(paths).toEqual(["output"]);
  });

  it("rejects cancellation during either evidence write and removes partial output", async () => {
    for (const cancelAt of [1, 2]) {
      const root = await temporaryDirectory("cruxomni-cancel-evidence-");
      const work = join(root, "work");
      const stage = join(root, "output");
      await mkdir(work);
      const controller = new AbortController();
      let writes = 0;
      const write = async (path: string, data: Buffer | string, options: { flag: "wx" }): Promise<void> => {
        await writeFile(path, data, options);
        if (++writes === cancelAt) controller.abort();
      };
      let failure: unknown;
      try { await writeNativeQualificationEvidence(stage, "target", Buffer.from("{}"), "{}", controller.signal, write); }
      catch (error) { failure = error; }
      expect(String(failure)).toContain("interrupted");
      await expect(cleanupNativeQualification(work, stage, false, failure)).rejects.toThrow("interrupted");
      await expect(lstat(stage)).rejects.toThrow();
      await expect(lstat(work)).rejects.toThrow();
    }
  });

  it("preserves the primary failure and attempts both native cleanups", async () => {
    const primary = new DockerCommandError("smoke timed out after 3300000ms (exit none, signal SIGKILL)", "", "", null, "timeout");
    const paths: string[] = [];
    const remove: typeof rm = async path => { paths.push(String(path)); throw new Error(`EPERM ${String(path)}`); };
    try {
      await cleanupNativeQualification("work", "output", false, primary, remove);
      throw new Error("expected cleanup failure");
    } catch (error) {
      expect(String(error)).toContain(primary.message);
      expect(String(error)).toContain("EPERM work");
      expect(String(error)).toContain("EPERM output");
      expect((error as Error).cause).toBeInstanceOf(AggregateError);
    }
    expect(paths).toEqual(["work", "output"]);
    await expect(cleanupNativeQualification("work", "output", true, undefined, remove)).rejects.toThrow("qualification cleanup failed");
  });

  it("keeps native and workflow deadlines above the source-counted Windows stages", async () => {
    const source = await readFile(join(import.meta.dir, "../scripts/smoke.ts"), "utf8");
    expect(source).toContain("75_000 + (process.platform === \"win32\" ? 28 * 30_000 : 0)");
    expect(source).toContain("nativeInferenceTimeoutMs(process.platform, persistedProfile)");
    expect(source).toContain("nativeAdminIoTimeoutMs(process.platform)");
    const majorStages = 75_000 + 28 * 30_000 + nativeInferenceTimeoutMs("win32", true) + nativeAdminIoTimeoutMs("win32");
    expect(majorStages).toBe(2_090_000);
    expect(nativeSmokeTimeoutMs("win32")).toBe(55 * 60_000);
    expect(nativeSmokeTimeoutMs("linux")).toBe(20 * 60_000);
    const sequence = source.slice(source.indexOf("    await seedLegacyNativeCache(binary, workspace, environment, fixture);"), source.indexOf("    if (environmentFixture!.requests.length !== nativeSetup.postSwitchEnvironmentRequestIndex)"));
    expect((sequence.match(/await nativeProviderInference\(/g) ?? []).length).toBe(3);
    expect((sequence.match(/await runCommand\(/g) ?? []).length).toBe(5);
    expect((sequence.match(/await checkPluginState\(/g) ?? []).length).toBe(4);
    // Five direct default commands and four plugin-state commands, plus the
    // two non-persisted inference calls, tool call, and prompt/wizard dialogues.
    const countedCommands = (5 + 4) * 45_000 + 3 * 20_000 + 30_000 + 35_000;
    expect(nativeSmokeTimeoutMs("win32")).toBeGreaterThan(majorStages + countedCommands);
    for (const file of ["qualification.yml", "windows-input-diagnostic.yml"]) {
      const workflow = await readFile(join(import.meta.dir, "../.github/workflows", file), "utf8");
      const job = file === "qualification.yml" ? workflow.split("  native:")[1]?.split("  linux-x64-musl:")[0] : workflow.split("  host:")[1]?.split("  probe:")[0];
      expect(job).toContain("timeout-minutes: 90");
      expect(90 * 60_000 - nativeSmokeTimeoutMs("win32")).toBeGreaterThanOrEqual(30 * 60_000);
    }
  });

  it("preserves mount paths when owned-container removal cannot be confirmed", async () => {
    const root = await temporaryDirectory("cruxomni-musl-cleanup-uncertain-");
    const ownerToken = "123e4567-e89b-42d3-a456-426614174000";
    const resources: OwnedMuslDockerResources = {
      containerName: `cruxomni-musl-arm64-${ownerToken}`,
      ownerToken,
      cidFile: join(root, "container.cid"),
      imageTag: `cruxomni-musl-arm64:${ownerToken}`,
      imageId: `sha256:${"c".repeat(64)}`,
      imageTagOwned: true,
    };
    const containerId = "d".repeat(64);
    await writeFile(resources.cidFile, `${containerId}\n`);
    let released = false;
    const events: string[] = [];
    const fakeDocker = async (args: string[]): Promise<string> => {
      if (args[0] === "container" && args[1] === "ls") return containerId;
      if (args[0] === "container" && args[1] === "inspect") return `${containerId}|/${resources.containerName}|true|${ownerToken}`;
      if (args[0] === "container" && args[1] === "stop") return "";
      if (args[0] === "container" && args[1] === "kill") {
        events.push("container-kill");
        return "";
      }
      if (args[0] === "container" && args[1] === "rm") {
        events.push("container-remove-unconfirmed");
        throw new Error("Docker removal result is uncertain");
      }
      events.push(`unexpected:${args.join(" ")}`);
      throw new Error("unexpected docker cleanup command");
    };
    await expect(runOwnedMuslDockerTask(resources, async () => "failed smoke", fakeDocker, async () => { released = true; }))
      .rejects.toThrow("mounted paths were preserved");
    expect(events).toEqual(["container-kill", "container-remove-unconfirmed"]);
    expect(released).toBe(false);
  });

  it("preserves mount paths when a cidfile container no longer has its owned name", async () => {
    const root = await temporaryDirectory("cruxomni-musl-renamed-container-");
    const ownerToken = "123e4567-e89b-42d3-a456-426614174000";
    const containerId = "e".repeat(64);
    const resources: OwnedMuslDockerResources = {
      containerName: `cruxomni-musl-x64-${ownerToken}`,
      ownerToken,
      cidFile: join(root, "container.cid"),
      imageTag: `cruxomni-musl-x64:${ownerToken}`,
      imageTagOwned: true,
    };
    await writeFile(resources.cidFile, `${containerId}\n`);
    let released = false;
    const commands: string[] = [];
    const fakeDocker = async (args: string[]): Promise<string> => {
      commands.push(args.join(" "));
      if (args[0] === "container" && args[1] === "ls" && args.includes(`name=^/${resources.containerName}$`)) return "";
      if (args[0] === "container" && args[1] === "ls" && args.includes(`id=${containerId}`)) return containerId;
      throw new Error(`unexpected mutation or image cleanup: ${args.join(" ")}`);
    };
    await expect(runOwnedMuslDockerTask(resources, async () => "completed", fakeDocker, async () => { released = true; }))
      .rejects.toThrow("mounted paths were preserved");
    expect(commands).toEqual([
      `container ls --all --quiet --no-trunc --filter name=^/${resources.containerName}$`,
      `container ls --all --quiet --no-trunc --filter id=${containerId}`,
    ]);
    expect(released).toBe(false);
  });

  it("accepts only a named GitHub environment with configured required reviewers", () => {
    const environment = {
      id: 42,
      name: "release",
      protection_rules: [
        {
          id: 7,
          type: "required_reviewers",
          prevent_self_review: true,
          reviewers: [
            { type: "User", reviewer: { id: 101, login: "release-reviewer" } },
            { type: "Team", reviewer: { id: 202, slug: "release-approvers", name: "Release Approvers" } },
          ],
        },
      ],
    };

    expect(verifyReleaseEnvironmentMetadata(environment)).toEqual({
      name: "release",
      reviewerCount: 2,
      requiredReviewerRules: 1,
    });
    expect(() => verifyReleaseEnvironmentMetadata(undefined)).toThrow("GitHub release environment response must be an object");
    expect(() => verifyReleaseEnvironmentMetadata({ ...environment, name: "staging" })).toThrow("exact release environment");
    expect(() => verifyReleaseEnvironmentMetadata({ ...environment, protection_rules: [] })).toThrow("at least one required_reviewers protection rule");
    expect(() => verifyReleaseEnvironmentMetadata({ ...environment, protection_rules: {} })).toThrow("protection_rules must be an array");

    const emptyReviewers = structuredClone(environment);
    emptyReviewers.protection_rules[0]!.reviewers = [];
    expect(() => verifyReleaseEnvironmentMetadata(emptyReviewers)).toThrow("between one and six configured reviewers");

    const malformedReviewer = structuredClone(environment);
    malformedReviewer.protection_rules[0]!.reviewers = [{ type: "Bot", reviewer: { id: 303, login: "release-bot" } }];
    expect(() => verifyReleaseEnvironmentMetadata(malformedReviewer)).toThrow("type User or Team");
  });


  it("keeps the native Windows smoke profile isolated while preserving required system variables case-insensitively", () => {
    const environment = cleanEnvironment({
      path: "C:\\Windows\\System32;C:\\Tools",
      Path: "C:\\shadowed-path",
      SYSTEMROOT: "C:\\Windows",
      ComSpec: "C:\\Windows\\System32\\cmd.exe",
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
      USERPROFILE: "C:\\Users\\runner",
      APPDATA: "C:\\Users\\runner\\AppData\\Roaming",
      OMP_OMNIROUTE_API_KEY: "must-not-survive",
    }, "C:\\agent\\isolated", "win32");
    expect(Object.keys(environment).filter(key => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
    expect(environment.PATH).toBe("C:\\Windows\\System32;C:\\Tools");
    expect(environment.SYSTEMROOT).toBe("C:\\Windows");
    expect(environment.COMSPEC).toBe("C:\\Windows\\System32\\cmd.exe");
    expect(environment.PATHEXT).toBe(".COM;.EXE;.BAT;.CMD");
    expect(environment.USERPROFILE).toBe("C:\\agent\\isolated\\windows-user");
    expect(environment.APPDATA).toBe("C:\\agent\\isolated\\windows-appdata\\Roaming");
    expect(environment.OMP_PROFILE).toBe("omniroute-smoke");
    expect(environment.TEMP).toBe("C:\\agent\\isolated\\windows-temp");
    expect(environment.OMP_OMNIROUTE_API_KEY).toBeUndefined();
  });

  it("rebuilds exact native musl runtimes and fails closed on incomplete native smoke output", async () => {
    const workflow = await readFile(join(import.meta.dir, "../.github/workflows/qualification.yml"), "utf8");
    const provenance = JSON.parse(await readFile(join(import.meta.dir, "../provenance/release-artifacts.json"), "utf8")) as { artifacts: Array<{ upstream: string; release_tag: string; url: string; sha256: string; peeled_commit: string }> };
    const pins = JSON.parse(await readFile(join(import.meta.dir, "../provenance/upstreams.json"), "utf8")) as { upstreams: Array<{ id: string; release: { version: string; tag: string } }> };
    const omp = pins.upstreams.find(item => item.id === "omp")!.release;
    const pinnedLinuxAsset = provenance.artifacts.find(item => item.upstream === "omp" && item.release_tag === omp.tag && item.url.endsWith("/omp-linux-x64"))!;
    expect(workflow).toContain("name: release-qualification");
    expect(workflow).toContain("workflow_dispatch:");
    expect(workflow).not.toMatch(/^\s*(?:push|release):/m);
    expect(workflow).toContain("name: cruxomni-release-input");
    expect([...workflow.matchAll(/^\s+- id: ([a-z0-9-]+)\s*$/gm)].map(match => match[1])).toEqual([
      "linux-x64-glibc", "linux-arm64-glibc", "darwin-x64", "darwin-arm64", "windows-x64", "windows-arm64",
    ]);
    expect(workflow).toContain("ubuntu-24.04-arm");
    expect(workflow).toContain("macos-15-intel");
    expect(workflow).toContain("macos-15");
    expect(workflow).toContain("windows-2025");
    expect(workflow).toContain("windows-11-arm");
    expect(workflow).toContain("runs-on: ubuntu-24.04");
    expect(workflow).toContain("runs-on: ubuntu-24.04-arm");
    expect(workflow).toContain("musl-target --id \"$QUALIFICATION_TARGET\"");
    expect(workflow).toContain("qualification-evidence-linux-x64-musl");
    expect(workflow).toContain("qualification-evidence-linux-arm64-musl");
    expect(workflow).not.toContain("BLOCKED: linux-x64-musl");
    expect(workflow).not.toContain("BLOCKED: linux-arm64-musl");

    const runtime = await muslRuntimeFixture("linux-x64-musl");
    expect(await validateMuslRuntimeEvidence(runtime, "linux-x64-musl", hashA, gitHash)).toMatchObject({
      status: "verified",
      targetId: "linux-x64-musl",
      installedPackageCount: 41,
      verifiedApkCount: 26,
    });
    expect(runtime.installedInventory).toContainEqual({ name: "ncurses-terminfo-base", version: "6.5_p20250503-r0", architecture: "noarch" });
    expect(() => validateMuslRuntimeEvidence({ ...runtime, daemonArchitecture: "arm64" }, "linux-x64-musl", hashA, gitHash)).toThrow("native offline build");
    expect(() => validateMuslRuntimeEvidence({ ...runtime, provenanceSha256: hashB }, "linux-x64-musl", hashA, gitHash)).toThrow("native offline build");
    const alteredInventory = structuredClone(runtime) as { installedInventory: Array<{ name: string; version: string; architecture: string }>; installedInventorySha256: string };
    alteredInventory.installedInventory[0]!.version = "0.0.0-forged";
    alteredInventory.installedInventorySha256 = createHash("sha256").update(JSON.stringify(alteredInventory.installedInventory)).digest("hex");
    expect(() => validateMuslRuntimeEvidence(alteredInventory, "linux-x64-musl", hashA, gitHash)).toThrow("differs from the reviewed 41-package closure");
    expect(() => validateMuslRuntimeEvidence({ ...runtime, unexpected: true }, "linux-x64-musl", hashA, gitHash)).toThrow("missing or unexpected fields");
    expect(() => validateMuslRuntimeEvidence(runtime, "linux-x64-musl", hashB, gitHash)).toThrow("not bound to the reviewed native offline build");

    const actualSmokeShape = {
      status: "verified",
      platform: { targetId: "linux-x64-glibc", os: "linux", architecture: "x64", libc: "glibc" },
      host: { mode: "release-asset", version: omp.version, digest: pinnedLinuxAsset.sha256, supportedRange: ">=18.12.2 <19" },
      upstream: { version: omp.version, commit: pinnedLinuxAsset.peeled_commit, asset: pinnedLinuxAsset.url, digest: pinnedLinuxAsset.sha256 },
      fixture: { baseUrl: "http://127.0.0.1:12345", requests: 12, failedDiscoveryGets: 1, responsesPosts: 2, chatCompletionsPosts: 2, loopbackOnly: true },
      installation: { method: "npm", version: "0.1.1", archiveSha256: hashA, metadataGets: 1, tarballGets: 1, installedFiles: 5, ordinaryDirectory: true, fileDigestsMatched: true, noInstalledHostSdk: true, credentialFreeRegistry: true },
      pluginLifecycle: { installed: true, disabled: true, enabled: true, uninstalled: true },
      native: {
        prompt: true,
        cancellation: true,
        wizardRendered: true,
        wizardCancellation: true,
        maskedPrompt: true,
        persisted: true,
        inference: Object.fromEntries(["startupResponses", "startupChatCompletions", "persistedChatCompletions"].map(key => [key, {
          modelId: "fixture-model", api: "openai-responses", path: "/v1/responses", postCount: 1, streamedText: true, usageObserved: true,
        }])),
        legacyCache: { seeded: true, seederUninstalled: true, modelId: "fixture-legacy-model", api: "openai-responses", liveDiscoveryStatus: 503, selectable: false, inferencePosts: 0 },
        toolContinuation: { modelId: "fixture-model", api: "openai-completions", postCount: 2, tool: "read", fileResultObserved: true, streamedContinuation: true },
        administration: {
          family: "fallback-chains", route: "/api/fallback/chains",
          readOperationId: "GET /api/fallback/chains", mutationOperationId: "POST /api/fallback/chains", cleanupOperationId: "DELETE /api/fallback/chains",
          readRequests: 7, mutationRequests: 1, cleanupRequests: 1, confirmedMutationAttempts: 2,
          unknownOutcomes: 2, durability: "unverified",
          fixtureAuthorization: true, exactMutationBodies: true, baselineAbsent: true,
          runtimeReadBack: true, cleanupRead: true, noUnexpectedAdminRequests: true,
        },
      },
    };
    expect(validateNativeSmokeOutput(actualSmokeShape, "linux-x64-glibc", hashA).status).toBe("verified");
    expect(() => validateNativeSmokeOutput({ ...actualSmokeShape, installation: { method: "npm", version: "0.1.1" } }, "linux-x64-glibc", hashA)).toThrow("exact release archive");
    expect(() => validateNativeSmokeOutput({ ...actualSmokeShape, native: { prompt: true } }, "linux-x64-glibc", hashA)).toThrow("required interactive checks");
    const native = actualSmokeShape.native;
    expect(() => validateNativeSmokeOutput({ ...actualSmokeShape, native: { ...native, administration: undefined } }, "linux-x64-glibc", hashA))
      .toThrow("native administration I/O evidence");
    expect(() => validateNativeSmokeOutput({ ...actualSmokeShape, native: { ...native, administration: { ...native.administration, mutationRequests: 2 } } }, "linux-x64-glibc", hashA))
      .toThrow("unknown-outcome administration I/O");
    expect(() => validateNativeSmokeOutput({ ...actualSmokeShape, native: { ...native, administration: { ...native.administration, cleanupRead: false } } }, "linux-x64-glibc", hashA))
      .toThrow("unknown-outcome administration I/O");
    expect(() => validateNativeSmokeOutput({ ...actualSmokeShape, native: { ...native, administration: { ...native.administration, unknownOutcomes: 1 } } }, "linux-x64-glibc", hashA))
      .toThrow("unknown-outcome administration I/O");
    expect(() => validateNativeSmokeOutput({ ...actualSmokeShape, native: { ...native, administration: { ...native.administration, durability: "verified" } } }, "linux-x64-glibc", hashA))
      .toThrow("unknown-outcome administration I/O");
    expect(() => validateNativeSmokeOutput({ ...actualSmokeShape, native: { ...native, administration: { ...native.administration, confirmedApplies: 2 } } }, "linux-x64-glibc", hashA))
      .toThrow("unknown-outcome administration I/O");
    expect(() => validateNativeSmokeOutput({ ...actualSmokeShape, native: { ...native, administration: { ...native.administration, persistedRead: true } } }, "linux-x64-glibc", hashA))
      .toThrow("unknown-outcome administration I/O");
  });

  it("synchronizes VERSION, package.json, and marketplace.json", async () => {
    const root = await fixtureRepo();
    expect(checkVersion(undefined, root)).toBe("0.1.1");
    expect(setVersion("0.2.0", root)).toBe("0.2.0");
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { version: string };
    const marketplace = JSON.parse(await readFile(join(root, ".omp-plugin/marketplace.json"), "utf8")) as { version: string };
    expect(pkg.version).toBe("0.2.0");
    expect(marketplace.version).toBe("0.2.0");
  });

  it("rejects an empty batch but permits an explicit none-only batch", async () => {
    const emptyRoot = await fixtureRepo();
    expect(() => planVersion(emptyRoot)).toThrow("empty commit batch");

    const noneRoot = await fixtureRepo();
    await put(noneRoot, "docs/note.md", "no release impact\n");
    unsignedCommit(noneRoot, "docs: clarify setup\n\nRelease-Type: none");
    expect(planVersion(noneRoot)).toMatchObject({ current: "0.1.1", bump: "none", next: "0.1.1", effectiveCommits: 1, excluded: { none: 1 } });
  });

  it("excludes actual merge and version-only synchronization commits", async () => {
    const root = await fixtureRepo();
    await put(root, "src/feature.ts", "export const feature = true;\n");
    unsignedCommit(root, "feat: add feature\n\nRelease-Type: minor");
    git(root, "checkout", "-b", "side-work");
    await put(root, "docs/side.md", "side branch\n");
    unsignedCommit(root, "docs: add side note");
    git(root, "checkout", "main");
    git(root, "-c", "commit.gpgsign=false", "merge", "--no-ff", "side-work", "-m", "feat!: merge title only");
    setVersion("0.1.2", root);
    unsignedCommit(root, "chore: version sync");
    expect(planVersion(root)).toMatchObject({ current: "0.1.2", bump: "minor", next: "0.2.0", excluded: { merge: 1, sync: 1 } });
  });

  it("cancels only an exact untouched-path native revert", async () => {
    const exactRoot = await fixtureRepo();
    await put(exactRoot, "src/reverted.ts", "export const value = true;\n");
    const target = unsignedCommit(exactRoot, "feat: add temporary feature\n\nRelease-Type: minor");
    git(exactRoot, "revert", "--no-edit", target);
    expect(planVersion(exactRoot)).toMatchObject({ bump: "none", next: "0.1.1", excluded: { revert: 2 } });

    const touchedRoot = await fixtureRepo();
    await put(touchedRoot, "src/reverted.ts", "export const value = true;\n");
    const touchedTarget = unsignedCommit(touchedRoot, "feat: add temporary feature\n\nRelease-Type: minor");
    await put(touchedRoot, "src/reverted.ts", "export const value = true;\nexport const later = true;\n");
    unsignedCommit(touchedRoot, "docs: unrelated follow-up\n\nRelease-Type: none");
    await put(touchedRoot, "src/reverted.ts", "export {};\n");
    unsignedCommit(touchedRoot, `Revert "feat: add temporary feature"\n\nThis reverts commit ${touchedTarget}.`);
    expect(planVersion(touchedRoot)).toMatchObject({ bump: "minor", excluded: { revert: 0 } });
  });

  it("exports a reviewed source file larger than subprocess buffering limits without truncation", async () => {
    const root = await fixtureRepo();
    const content = Buffer.alloc(17 * 1024 * 1024, 120);
    const path = "contracts/large-source.json";
    await writeFile(join(root, path), content);
    unsignedCommit(root, "chore: large source fixture");
    const output = join(root, "release");
    await exportFixture(root, output);
    const archive = join(output, "OMP-OmniRoute-Provider-v0.1.1-source.tar.gz");
    const exported = execFileSync("tar", ["-xOzf", archive, `OMP-OmniRoute-Provider-0.1.1/${path}`], { maxBuffer: content.length + 1 });
    expect(createHash("sha256").update(exported).digest("hex")).toBe(createHash("sha256").update(content).digest("hex"));
  });

  it("exports into ignored source output, blocks unrelated source drift, and preserves the prior output when a rebuild fails", async () => {
    const root = await fixtureRepo();
    const output = join(root, "release");
    await exportFixture(root, output);
    const expectedNames = [
      "OMP-OmniRoute-Provider-v0.1.1.cdx.json",
      "OMP-OmniRoute-Provider-v0.1.1-graphics.zip",
      "OMP-OmniRoute-Provider-v0.1.1-release-notes.md",
      "OMP-OmniRoute-Provider-v0.1.1-source.tar.gz",
      "SHA256SUMS.txt",
      "cruxexperts-cruxomni-omp-client-0.1.1.tgz",
      "release-manifest.json",
    ].sort();
    expect((await readdir(output)).sort()).toEqual(expectedNames);
    expect(await readFile(join(output, "OMP-OmniRoute-Provider-v0.1.1-release-notes.md"))).toEqual(await readFile(join(root, "CHANGELOG.md")));

    await writeFile(join(output, "stale.txt"), "must be replaced after successful build\n");
    await exportFixture(root, output);
    const names = (await readdir(output)).sort();
    expect(names).toEqual(expectedNames);
    const before = new Map(await Promise.all(names.map(async name => [name, await readFile(join(output, name))] as const)));
    const unrelatedChange = join(root, "unrelated-source-change.txt");
    await expect(exportRelease({ root, outputDirectory: output, packageVerifier: async () => {
      await writeFile(unrelatedChange, "unrelated source drift during export\n");
      return fakePackageEvidence(root);
    } })).rejects.toThrow("release source changed during export");
    for (const [name, bytes] of before) expect(await readFile(join(output, name))).toEqual(bytes);
    await rm(unrelatedChange, { force: true });

    await expect(exportRelease({ root, outputDirectory: output, packageVerifier: async () => { throw new Error("synthetic package verification failure"); } })).rejects.toThrow("synthetic package verification failure");
    for (const [name, bytes] of before) expect(await readFile(join(output, name))).toEqual(bytes);
  });

  it("requires clean reviewed bytes before export", async () => {
    const root = await fixtureRepo();
    const output = join(await temporaryDirectory("cruxomni-dirty-output-"), "release");
    await put(root, "README.md", "staged bytes differ from HEAD\n");
    git(root, "add", "README.md");
    await expect(exportFixture(root, output)).rejects.toThrow("clean in Git and match HEAD");
  });

  it("binds eight targets and every invokable operation to the exact package archive", async () => {
    const root = await fixtureRepo();
    const output = join(await temporaryDirectory("cruxomni-gate-output-"), "release");
    await exportFixture(root, output);
    const qualification = await qualificationFor(output, root);
    const result = await verifyReleaseApproval({ root, releaseDirectory: output, qualificationPath: qualification.path, expectedReceiptSha256: qualification.hash });
    expect(result).toMatchObject({ status: "ready-for-protected-approval", targets: 8, qualifiedOperations: 1 });

    const notesPath = join(output, "OMP-OmniRoute-Provider-v0.1.1-release-notes.md");
    const notesBytes = await readFile(notesPath);
    await writeFile(notesPath, "unreviewed release notes\n");
    await expect(createReleaseApprovalReceipt({ root, releaseDirectory: output, qualificationPath: qualification.path })).rejects.toThrow("release artifact hash mismatch: OMP-OmniRoute-Provider-v0.1.1-release-notes.md");
    await writeFile(notesPath, notesBytes);

    const manifestPath = join(output, "release-manifest.json");
    const checksumsPath = join(output, "SHA256SUMS.txt");
    const manifestBytes = await readFile(manifestPath);
    const checksumsBytes = await readFile(checksumsPath);
    const changedNotes = Buffer.from("unreviewed release notes\n");
    await writeFile(notesPath, changedNotes);
    const manifest = JSON.parse(manifestBytes.toString("utf8")) as { artifacts: Array<{ name: string; sha256: string }> };
    manifest.artifacts.find(item => item.name.endsWith("-release-notes.md"))!.sha256 = createHash("sha256").update(changedNotes).digest("hex");
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await writeFile(checksumsPath, `${manifest.artifacts.map(item => `${item.sha256}  ${item.name}`).join("\n")}\n`);
    await expect(createReleaseApprovalReceipt({ root, releaseDirectory: output, qualificationPath: qualification.path })).rejects.toThrow("versioned release notes must match the exact reviewed CHANGELOG.md bytes");
    await writeFile(notesPath, notesBytes);
    await writeFile(manifestPath, manifestBytes);
    await writeFile(checksumsPath, checksumsBytes);

    const receipt = JSON.parse(await readFile(qualification.path, "utf8")) as { targets: Array<{ archiveSha256: string }> };
    receipt.targets[7]!.archiveSha256 = hashB;
    await writeFile(qualification.path, JSON.stringify(receipt));
    await expect(createReleaseApprovalReceipt({ root, releaseDirectory: output, qualificationPath: qualification.path })).rejects.toThrow("tested a different package archive");
  });

  it("rejects arbitrary target IDs and target evidence whose bytes do not match the receipt", async () => {
    const root = await fixtureRepo();
    const output = join(await temporaryDirectory("cruxomni-evidence-gate-output-"), "release");
    await exportFixture(root, output);
    const qualification = await qualificationFor(output, root, true);
    const originalBytes = await readFile(qualification.path);
    const receipt = JSON.parse(originalBytes.toString("utf8")) as { targets: Array<{ id: string; evidenceRef: string }> };

    receipt.targets[0]!.id = "arbitrary-linux-target";
    await writeFile(qualification.path, JSON.stringify(receipt));
    await expect(createReleaseApprovalReceipt({ root, releaseDirectory: output, qualificationPath: qualification.path })).rejects.toThrow("eight supported target IDs exactly once");

    await writeFile(qualification.path, originalBytes);
    const evidencePath = join(dirname(qualification.path), receipt.targets[0]!.evidenceRef);
    await writeFile(evidencePath, "tampered target evidence\n");
    await expect(createReleaseApprovalReceipt({ root, releaseDirectory: output, qualificationPath: qualification.path })).rejects.toThrow("evidence hash does not match its file");
  });

  it("requires musl runtime inventory evidence in the standalone release gate", async () => {
    const root = await fixtureRepo();
    const output = join(await temporaryDirectory("cruxomni-musl-runtime-gate-output-"), "release");
    await exportFixture(root, output);
    const qualification = await qualificationFor(output, root, true);
    const receipt = JSON.parse(await readFile(qualification.path, "utf8")) as { targets: Array<{ id: string; evidenceRef: string; evidenceSha256: string }> };
    const target = receipt.targets.find(item => item.id === "linux-x64-musl")!;
    const evidencePath = join(dirname(qualification.path), target.evidenceRef);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as { runtime?: Record<string, unknown> };
    delete evidence.runtime;
    const evidenceBytes = Buffer.from(JSON.stringify(evidence));
    await writeFile(evidencePath, evidenceBytes);
    target.evidenceSha256 = createHash("sha256").update(evidenceBytes).digest("hex");
    await writeFile(qualification.path, JSON.stringify(receipt));
    await expect(createReleaseApprovalReceipt({ root, releaseDirectory: output, qualificationPath: qualification.path })).rejects.toThrow("musl runtime evidence must be an object");

    const refreshed = await qualificationFor(output, root, true);
    const secondReceipt = JSON.parse(await readFile(refreshed.path, "utf8")) as { targets: Array<{ id: string; evidenceRef: string; evidenceSha256: string }> };
    const secondTarget = secondReceipt.targets.find(item => item.id === "linux-arm64-musl")!;
    const secondEvidencePath = join(dirname(refreshed.path), secondTarget.evidenceRef);
    const secondEvidence = JSON.parse(await readFile(secondEvidencePath, "utf8")) as { runtime: Record<string, unknown> };
    secondEvidence.runtime.archiveSha256 = hashB;
    const secondBytes = Buffer.from(JSON.stringify(secondEvidence));
    await writeFile(secondEvidencePath, secondBytes);
    secondTarget.evidenceSha256 = createHash("sha256").update(secondBytes).digest("hex");
    await writeFile(refreshed.path, JSON.stringify(secondReceipt));
    await expect(createReleaseApprovalReceipt({ root, releaseDirectory: output, qualificationPath: refreshed.path })).rejects.toThrow("not bound to the reviewed native offline build");
  });

  it("requires the named qualification producer and complete native smoke evidence", async () => {
    const missingProducerRoot = await fixtureRepo({ missingQualificationWorkflow: true });
    const missingProducerOutput = join(await temporaryDirectory("cruxomni-no-producer-output-"), "release");
    await exportFixture(missingProducerRoot, missingProducerOutput);
    const missingProducerReceipt = await qualificationFor(missingProducerOutput, missingProducerRoot, true);
    await expect(createReleaseApprovalReceipt({ root: missingProducerRoot, releaseDirectory: missingProducerOutput, qualificationPath: missingProducerReceipt.path })).rejects.toThrow("required qualification producer workflow .github/workflows/qualification.yml is missing");

    const root = await fixtureRepo();
    const output = join(await temporaryDirectory("cruxomni-incomplete-smoke-output-"), "release");
    await exportFixture(root, output);
    const qualification = await qualificationFor(output, root, true);
    const receipt = JSON.parse(await readFile(qualification.path, "utf8")) as { targets: Array<{ evidenceRef: string; evidenceSha256: string }> };
    const evidencePath = join(dirname(qualification.path), receipt.targets[0]!.evidenceRef);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as { smoke: Record<string, unknown> };
    delete evidence.smoke.output;
    const evidenceBytes = Buffer.from(JSON.stringify(evidence));
    await writeFile(evidencePath, evidenceBytes);
    receipt.targets[0]!.evidenceSha256 = createHash("sha256").update(evidenceBytes).digest("hex");
    await writeFile(qualification.path, JSON.stringify(receipt));
    await expect(createReleaseApprovalReceipt({ root, releaseDirectory: output, qualificationPath: qualification.path })).rejects.toThrow("smoke output must be a non-empty string");
  });

  it("blocks release approval when a digested native target omits or miscounts administration I/O", async () => {
    const root = await fixtureRepo();
    const output = join(await temporaryDirectory("cruxomni-admin-smoke-gate-output-"), "release");
    await exportFixture(root, output);
    const qualification = await qualificationFor(output, root, true);
    const receipt = JSON.parse(await readFile(qualification.path, "utf8")) as { targets: Array<{ evidenceRef: string; evidenceSha256: string }> };
    const target = receipt.targets[0]!;
    const evidencePath = join(dirname(qualification.path), target.evidenceRef);
    const evidence = JSON.parse(await readFile(evidencePath, "utf8")) as {
      smoke: { output: string; outputSha256: string; checks: Array<{ id: string; output: string; outputSha256: string }> };
    };
    const smoke = JSON.parse(evidence.smoke.output) as { native: { administration?: Record<string, unknown> }; [key: string]: unknown };
    const validAdministration = structuredClone(smoke.native.administration)!;
    const writeEvidence = async (): Promise<void> => {
      evidence.smoke.output = JSON.stringify(smoke);
      evidence.smoke.outputSha256 = createHash("sha256").update(evidence.smoke.output).digest("hex");
      const check = evidence.smoke.checks.find(item => item.id === "package-smoke")!;
      check.output = JSON.stringify({
        status: smoke.status, platform: smoke.platform, host: smoke.host, upstream: smoke.upstream,
        fixture: smoke.fixture, native: smoke.native, pluginLifecycle: smoke.pluginLifecycle,
      });
      check.outputSha256 = createHash("sha256").update(check.output).digest("hex");
      const bytes = Buffer.from(JSON.stringify(evidence));
      await writeFile(evidencePath, bytes);
      target.evidenceSha256 = createHash("sha256").update(bytes).digest("hex");
      await writeFile(qualification.path, JSON.stringify(receipt));
    };
    delete smoke.native.administration;
    await writeEvidence();
    await expect(createReleaseApprovalReceipt({ root, releaseDirectory: output, qualificationPath: qualification.path }))
      .rejects.toThrow("native administration I/O evidence");
    smoke.native.administration = { ...validAdministration, mutationRequests: 2 };
    await writeEvidence();
    await expect(createReleaseApprovalReceipt({ root, releaseDirectory: output, qualificationPath: qualification.path }))
      .rejects.toThrow("unknown-outcome administration I/O");
    smoke.native.administration = { ...validAdministration, confirmedApplies: 2 };
    await writeEvidence();
    await expect(createReleaseApprovalReceipt({ root, releaseDirectory: output, qualificationPath: qualification.path }))
      .rejects.toThrow("unknown-outcome administration I/O");
    smoke.native.administration = { ...validAdministration, durability: "verified" };
    await writeEvidence();
    await expect(createReleaseApprovalReceipt({ root, releaseDirectory: output, qualificationPath: qualification.path }))
      .rejects.toThrow("unknown-outcome administration I/O");
    smoke.native.administration = { ...validAdministration, unknownOutcomes: 1 };
    await writeEvidence();
    await expect(createReleaseApprovalReceipt({ root, releaseDirectory: output, qualificationPath: qualification.path }))
      .rejects.toThrow("unknown-outcome administration I/O");
  });

  it("accepts only the named qualification run with all eight completed native jobs", () => {
    const metadata = qualificationRunMetadata();
    expect(verifyQualificationRunMetadata(metadata)).toMatchObject({
      workflowPath: ".github/workflows/qualification.yml",
      workflowName: "release-qualification",
      targets: 8,
    });

    expect(() => verifyQualificationRunMetadata({
      ...metadata,
      run: { ...metadata.run, name: "unrelated-workflow" },
    })).toThrow("successful release-qualification workflow");

    const failedJobs = structuredClone(metadata.jobs);
    failedJobs.jobs[0]!.conclusion = "failure";
    expect(() => verifyQualificationRunMetadata({ ...metadata, jobs: failedJobs })).toThrow("successful native target job");

    const incompleteJobs = structuredClone(metadata.jobs);
    incompleteJobs.total_count++;
    expect(() => verifyQualificationRunMetadata({ ...metadata, jobs: incompleteJobs })).toThrow("jobs response is incomplete");

    const uncountedJobs = structuredClone(metadata.jobs);
    delete (uncountedJobs as { total_count?: number }).total_count;
    expect(() => verifyQualificationRunMetadata({ ...metadata, jobs: uncountedJobs })).toThrow("jobs response is incomplete");
  });

  it("rejects unsupported release eligibility schema versions", async () => {
    const root = await fixtureRepo({ eligibilitySchemaVersion: 2 });
    const output = join(await temporaryDirectory("cruxomni-eligibility-version-"), "release");
    await exportFixture(root, output);
    const qualification = await qualificationFor(output, root, true);
    await expect(createReleaseApprovalReceipt({ root, releaseDirectory: output, qualificationPath: qualification.path })).rejects.toThrow("release eligibility contract identity is invalid");
  });

  it("blocks a short eligibility subset when any invokable source operation is missing evidence", async () => {
    const root = await fixtureRepo({ secondInvokable: true });
    const output = join(await temporaryDirectory("cruxomni-incomplete-gate-"), "release");
    await exportFixture(root, output);
    const qualification = await qualificationFor(output, root, true);
    await expect(createReleaseApprovalReceipt({ root, releaseDirectory: output, qualificationPath: qualification.path })).rejects.toThrow("1 applicable operations remain unqualified");
  });
});
