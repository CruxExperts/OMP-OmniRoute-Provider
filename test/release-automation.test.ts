import { afterEach, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { exportRelease } from "../scripts/export-release.ts";
import { validateNativeSmokeOutput } from "../scripts/qualify-release.ts";
import { createReleaseApprovalReceipt, verifyQualificationRunMetadata, verifyReleaseApproval, verifyReleaseEnvironmentMetadata } from "../scripts/release-gate.ts";
import { cleanEnvironment } from "../scripts/smoke.ts";
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

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
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

async function fixtureRepo(options: { secondInvokable?: boolean; missingQualificationWorkflow?: boolean } = {}): Promise<string> {
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
    "THIRD_PARTY_NOTICES.md": "fixture notices\n",
    ".github/workflows/qualification.yml": "name: release-qualification\non:\n  workflow_dispatch:\njobs: {}\n",
    "VERSION": "0.1.1\n",
    "bun.lock": "{}\n",
    "package.json": `${JSON.stringify(packageJson, null, 2)}\n`,
    "tsconfig.json": "{}\n",
    ".omp-plugin/marketplace.json": `${JSON.stringify(marketplace, null, 2)}\n`,
    "contracts/operations.json": `${JSON.stringify({ operations }, null, 2)}\n`,
    "contracts/release-eligibility.json": `${JSON.stringify({ schemaVersion: 2, recordKind: "omniroute-release-eligibility", operations: [qualificationOperation(invokableId)] }, null, 2)}\n`,
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

async function qualificationFor(output: string, root: string, skipGateHash = false): Promise<{ path: string; hash: string }> {
  const manifest = JSON.parse(await readFile(join(output, "release-manifest.json"), "utf8")) as { version: string; sourceRevision: string; artifacts: Array<{ name: string; sha256: string }> };
  const packageArchive = manifest.artifacts.find(item => item.name.endsWith(".tgz"))!;
  const packageArchiveSha256 = packageArchive.sha256;
  const workflowPath = ".github/workflows/qualification.yml";
  const workflowBytes = await readFile(join(root, workflowPath)).catch(() => Buffer.alloc(0));
  const producer = {
    repository: "CruxExperts/CruxOmni-OMP-Client",
    runId: "90000001",
    workflowPath,
    workflowName: "release-qualification",
    workflowSha256: createHash("sha256").update(workflowBytes).digest("hex"),
  };
  const bundle = join(dirname(root), `${basename(root)}-qualification`);
  await mkdir(join(bundle, "evidence"), { recursive: true });
  const targetEvidence = await Promise.all(qualificationTargetIds.map(async id => {
    const installOutput = `Installed ${packageArchive.name} on ${id}.\n`;
    const smokeCheckOutput = `Package smoke passed on ${id}.\n`;
    const checks = [
      { id: "install-package", status: "passed", output: installOutput, outputSha256: createHash("sha256").update(installOutput).digest("hex") },
      { id: "package-smoke", status: "passed", output: smokeCheckOutput, outputSha256: createHash("sha256").update(smokeCheckOutput).digest("hex") },
    ];
    const smokeOutput = `${installOutput}${smokeCheckOutput}`;
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
  const repository = "CruxExperts/CruxOmni-OMP-Client";
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

  it("checks the live release environment and npm token before draft creation", async () => {
    const workflow = await readFile(join(import.meta.dir, "../.github/workflows/release.yml"), "utf8");
    const apiChecks = workflow.match(/gh api "repos\/\$GITHUB_REPOSITORY\/environments\/release"/g) ?? [];
    expect(apiChecks).toHaveLength(2);
    expect(workflow.match(/bun run scripts\/release-gate\.ts verify-environment/g) ?? []).toHaveLength(2);

    const tokenCheck = workflow.indexOf("The release environment must provide a non-empty NPM_TOKEN secret before publication.");
    const draftCreation = workflow.indexOf("gh release create \"$RELEASE_TAG\"");
    expect(tokenCheck).toBeGreaterThan(-1);
    expect(draftCreation).toBeGreaterThan(tokenCheck);
    expect(workflow.indexOf("verify-environment \"$RUNNER_TEMP/release-environment.json\" release", workflow.indexOf("jobs:\n  publish:")))
      .toBeLessThan(tokenCheck);
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

  it("makes the qualification workflow fail closed for unverified musl images and incomplete native smoke output", async () => {
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
    expect(workflow.match(/BLOCKED: linux-(?:x64|arm64)-musl qualification requires an architecture-native Alpine image pinned by a verified digest/g)?.length).toBe(2);

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
      },
    };
    expect(validateNativeSmokeOutput(actualSmokeShape, "linux-x64-glibc", hashA).status).toBe("verified");
    expect(() => validateNativeSmokeOutput({ ...actualSmokeShape, installation: { method: "npm", version: "0.1.1" } }, "linux-x64-glibc", hashA)).toThrow("exact release archive");
    expect(() => validateNativeSmokeOutput({ ...actualSmokeShape, native: { prompt: true } }, "linux-x64-glibc", hashA)).toThrow("required interactive checks");
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

  it("exports only fresh manifest files and preserves the prior output when a rebuild fails", async () => {
    const root = await fixtureRepo();
    const outputParent = await temporaryDirectory("cruxomni-release-output-");
    const output = join(outputParent, "release");
    await mkdir(output);
    await writeFile(join(output, "stale.txt"), "must be replaced after successful build\n");
    await exportFixture(root, output);
    const names = (await readdir(output)).sort();
    expect(names).toEqual([
      "CruxOmni-OMP-Client-v0.1.1.cdx.json",
      "CruxOmni-OMP-Client-v0.1.1-graphics.zip",
      "CruxOmni-OMP-Client-v0.1.1-release-notes.md",
      "CruxOmni-OMP-Client-v0.1.1-source.tar.gz",
      "SHA256SUMS.txt",
      "cruxexperts-cruxomni-omp-client-0.1.1.tgz",
      "release-manifest.json",
    ].sort());
    expect(await readFile(join(output, "CruxOmni-OMP-Client-v0.1.1-release-notes.md"))).toEqual(await readFile(join(root, "CHANGELOG.md")));

    const before = new Map(await Promise.all(names.map(async name => [name, await readFile(join(output, name))] as const)));
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

    const notesPath = join(output, "CruxOmni-OMP-Client-v0.1.1-release-notes.md");
    const notesBytes = await readFile(notesPath);
    await writeFile(notesPath, "unreviewed release notes\n");
    await expect(createReleaseApprovalReceipt({ root, releaseDirectory: output, qualificationPath: qualification.path })).rejects.toThrow("release artifact hash mismatch: CruxOmni-OMP-Client-v0.1.1-release-notes.md");
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

  it("blocks a short eligibility subset when any invokable source operation is missing evidence", async () => {
    const root = await fixtureRepo({ secondInvokable: true });
    const output = join(await temporaryDirectory("cruxomni-incomplete-gate-"), "release");
    await exportFixture(root, output);
    const qualification = await qualificationFor(output, root, true);
    await expect(createReleaseApprovalReceipt({ root, releaseDirectory: output, qualificationPath: qualification.path })).rejects.toThrow("1 applicable operations remain unqualified");
  });
});
