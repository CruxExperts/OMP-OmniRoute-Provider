import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";
import { REPOSITORY_SLUG } from "../src/identity.ts";
import { verifyPackage, type PackageVerificationResult } from "./verify-package.ts";

const execFileAsync = promisify(execFile);
const defaultRoot = resolve(import.meta.dir, "..");
const sourcePrefixes = [".githooks/", ".github/", ".omp-plugin/", "assets/", "contracts/", "docs/", "provenance/", "scripts/", "src/", "test/"];
const sourceFiles = [".gitignore", "ASSET_LICENSE.md", "CHANGELOG.md", "CONTRIBUTING.md", "LICENSE", "README.md", "SECURITY.md", "SUPPORT.md", "THIRD_PARTY_NOTICES.md", "VERSION", "bun.lock", "package.json", "tsconfig.json"];
const epoch = new Date("1980-01-01T00:00:00Z");

type PackageVerifier = (root: string) => Promise<PackageVerificationResult>;

async function command(name: string, args: string[], cwd: string): Promise<void> {
  await execFileAsync(name, args, { cwd, env: { ...process.env, TZ: "UTC" }, maxBuffer: 16 * 1024 * 1024 });
}
async function commandOutput(name: string, args: string[], cwd: string): Promise<string> {
  return (await execFileAsync(name, args, { cwd, env: process.env, maxBuffer: 16 * 1024 * 1024 })).stdout;
}
async function commandBuffer(name: string, args: string[], cwd: string): Promise<Buffer> {
  return (await execFileAsync(name, args, { cwd, encoding: "buffer", maxBuffer: 16 * 1024 * 1024 })).stdout as Buffer;
}
async function sha(path: string): Promise<string> { return createHash("sha256").update(await readFile(path)).digest("hex"); }
async function touchTree(path: string): Promise<void> {
  const info = await stat(path);
  if (info.isDirectory()) for (const item of await readdir(path)) await touchTree(join(path, item));
  await utimes(path, epoch, epoch);
}
function included(path: string): boolean { return sourceFiles.includes(path) || sourcePrefixes.some(prefix => path.startsWith(prefix)); }

async function reviewedFiles(root: string): Promise<{ paths: string[]; sourceRevision: string; gitRoot: string; packagePrefix: string }> {
  const gitRoot = (await commandOutput("git", ["rev-parse", "--show-toplevel"], root)).trim();
  const packagePrefix = relative(gitRoot, root).replaceAll("\\", "/");
  if (packagePrefix === ".." || packagePrefix.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) throw new Error("release package root is outside its Git worktree");
  const dirty = await commandOutput("git", ["status", "--porcelain=v1", "--untracked-files=all", "--", root], gitRoot);
  if (dirty) throw new Error("release source must be clean in Git and match HEAD; stage and commit reviewed source before exporting");
  const listed = (await commandOutput("git", ["ls-files", "--cached", "-z", "--", root], gitRoot)).split("\0").filter(Boolean);
  const paths = listed.map(path => packagePrefix ? path.slice(packagePrefix.length + 1) : path).filter(included).sort();
  for (const required of sourceFiles) if (!paths.includes(required)) throw new Error(`release source is not tracked: ${required}`);
  const sourceRevision = (await commandOutput("git", ["rev-parse", "HEAD"], root)).trim();
  if (!/^[0-9a-f]{40}$/.test(sourceRevision)) throw new Error("HEAD does not identify a full Git commit");
  return { paths, sourceRevision, gitRoot, packagePrefix };
}

async function copyReviewed(root: string, paths: string[], destination: string, reviewed: { sourceRevision: string; gitRoot: string; packagePrefix: string }): Promise<void> {
  for (const path of paths) {
    const source = join(root, path);
    const info = await lstat(source);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error(`release input must be a regular non-symlink file: ${path}`);
    const bytes = await readFile(source);
    const gitPath = reviewed.packagePrefix ? `${reviewed.packagePrefix}/${path}` : path;
    const headBytes = await commandBuffer("git", ["show", `${reviewed.sourceRevision}:${gitPath}`], reviewed.gitRoot);
    if (!headBytes.equals(bytes)) throw new Error(`release input changed after clean-source review: ${path}`);
    if (!bytes.includes(0)) {
      const text = bytes.toString("utf8");
      if (/\/(?:home|Users)\/[^\s"']+/.test(text) || /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) || /\bsk-[A-Za-z0-9_-]{16,}\b/.test(text)) throw new Error(`public-content scan rejected ${path}`);
    }
    await mkdir(dirname(join(destination, path)), { recursive: true });
    await cp(source, join(destination, path), { dereference: false });
  }
}

async function assertReviewedHead(root: string, sourceRevision: string): Promise<void> {
  const [currentRevision, status] = await Promise.all([
    commandOutput("git", ["rev-parse", "HEAD"], root),
    commandOutput("git", ["status", "--porcelain=v1", "--untracked-files=all"], root),
  ]);
  if (currentRevision.trim() !== sourceRevision || status.trim()) {
    throw new Error("release source changed during export; discard the staged build and retry from a clean reviewed HEAD");
  }
}

async function directoryNames(path: string): Promise<string[]> {
  return (await readdir(path, { withFileTypes: true })).map(entry => {
    if (!entry.isFile()) throw new Error(`release output may contain only top-level regular files: ${entry.name}`);
    return entry.name;
  }).sort();
}

async function replaceOutput(staged: string, output: string): Promise<void> {
  await mkdir(dirname(output), { recursive: true });
  let previous = false;
  try {
    const info = await lstat(output);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("release output path must be a regular directory");
    previous = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const backup = join(dirname(output), `.${basename(output)}.previous-${process.pid}-${Date.now()}`);
  if (previous) await rename(output, backup);
  try {
    await rename(staged, output);
  } catch (error) {
    if (previous) await rename(backup, output);
    throw error;
  }
  if (previous) {
    await rm(backup, { recursive: true, force: true }).catch(error => {
      process.stderr.write(`warning: replaced release output successfully but could not remove prior output ${backup}: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
}

export async function exportRelease(options: { root?: string; outputDirectory?: string; packageVerifier?: PackageVerifier } = {}): Promise<{ directory: string; sourceRevision: string; artifacts: string[] }> {
  const root = resolve(options.root ?? defaultRoot);
  const output = resolve(options.outputDirectory ?? process.env.CRUXOMNI_RELEASE_DIR ?? join(root, "release"));
  const outputInsideSource = relative(root, output);
  const sourceInsideOutput = relative(output, root);
  const separator = process.platform === "win32" ? "\\" : "/";
  if (sourceInsideOutput === "" || (sourceInsideOutput !== ".." && !sourceInsideOutput.startsWith(`..${separator}`))) throw new Error("release output directory cannot contain or replace the package source tree");
  if (outputInsideSource !== ".." && !outputInsideSource.startsWith(`..${separator}`)) {
    try {
      await command("git", ["check-ignore", "--quiet", "--", outputInsideSource], root);
    } catch {
      throw new Error("release output inside the source tree must be Git-ignored");
    }
  }

  const packageManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as { name: string; version: string };
  if (!/^\d+\.\d+\.\d+$/.test(packageManifest.version)) throw new Error("package version must be exact semantic version");
  const reviewed = await reviewedFiles(root);
  const outputParent = dirname(output);
  await mkdir(outputParent, { recursive: true });
  const temporary = await mkdtemp(join(outputParent, `.${basename(output)}.fresh-`));
  const stage = join(temporary, "staged-output");
  const sourceStage = join(temporary, `${REPOSITORY_SLUG}-${packageManifest.version}`);
  let packageEvidence: PackageVerificationResult | undefined;
  try {
    await mkdir(stage, { recursive: true });
    await mkdir(sourceStage, { recursive: true });
    await copyReviewed(root, reviewed.paths, sourceStage, reviewed);
    await touchTree(sourceStage);

    const sourceName = `${REPOSITORY_SLUG}-v${packageManifest.version}-source.tar.gz`;
    await command("tar", ["--sort=name", "--mtime=1980-01-01 UTC", "--owner=0", "--group=0", "--numeric-owner", "-czf", join(stage, sourceName), basename(sourceStage)], temporary);

    packageEvidence = await (options.packageVerifier ?? (() => verifyPackage({ keepTemporary: true })))(root);
    const npmName = `cruxexperts-cruxomni-omp-client-${packageManifest.version}.tgz`;
    await cp(packageEvidence.archive, join(stage, npmName));
    const sbomName = `${REPOSITORY_SLUG}-v${packageManifest.version}.cdx.json`;
    await writeFile(join(stage, sbomName), `${JSON.stringify(packageEvidence.sbom, null, 2)}\n`);
    const notesName = `${REPOSITORY_SLUG}-v${packageManifest.version}-release-notes.md`;
    await cp(join(sourceStage, "CHANGELOG.md"), join(stage, notesName));

    const graphicsStage = join(temporary, `${REPOSITORY_SLUG}-v${packageManifest.version}-graphics`);
    await mkdir(graphicsStage);
    const graphicsFiles = reviewed.paths.filter(path => path.startsWith("assets/") || path === "ASSET_LICENSE.md" || path === "THIRD_PARTY_NOTICES.md");
    await copyReviewed(root, graphicsFiles, graphicsStage, reviewed);
    await touchTree(graphicsStage);
    const graphicsName = `${REPOSITORY_SLUG}-v${packageManifest.version}-graphics.zip`;
    await command("zip", ["-X", "-q", "-r", join(stage, graphicsName), basename(graphicsStage)], temporary);

    const names = [sourceName, npmName, graphicsName, sbomName, notesName];
    const sums = await Promise.all(names.map(async name => `${await sha(join(stage, name))}  ${name}`));
    await writeFile(join(stage, "SHA256SUMS.txt"), `${sums.join("\n")}\n`);
    const manifest = {
      schemaVersion: 1,
      package: packageManifest.name,
      version: packageManifest.version,
      sourceRevision: reviewed.sourceRevision,
      publication: { status: "prepared", target: "github-release-and-npm" },
      artifacts: await Promise.all(names.map(async name => ({ name, sha256: await sha(join(stage, name)) }))),
      lockfileSha256: packageEvidence.lockfile.sha256,
    };
    await writeFile(join(stage, "release-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const expectedOutput = [...names, "SHA256SUMS.txt", "release-manifest.json"].sort();
    const actualOutput = await directoryNames(stage);
    if (JSON.stringify(actualOutput) !== JSON.stringify(expectedOutput)) throw new Error("release output contains files outside the exact artifact manifest and its receipts");
    await assertReviewedHead(root, reviewed.sourceRevision);
    await replaceOutput(stage, output);
    return { directory: output, sourceRevision: reviewed.sourceRevision, artifacts: names };
  } finally {
    if (packageEvidence) await rm(resolve(packageEvidence.extractedRoot, "..", ".."), { recursive: true, force: true }).catch(error => {
      process.stderr.write(`warning: could not remove temporary package verification files: ${error instanceof Error ? error.message : String(error)}\n`);
    });
    await rm(temporary, { recursive: true, force: true }).catch(error => {
      process.stderr.write(`warning: could not remove temporary release build files: ${error instanceof Error ? error.message : String(error)}\n`);
    });
  }
}

if (import.meta.main) {
  exportRelease().then(result => {
    process.stdout.write(`${JSON.stringify({ status: "prepared", ...result }, null, 2)}\n`);
  }).catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
