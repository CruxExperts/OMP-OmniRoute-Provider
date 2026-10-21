import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const defaultRoot = resolve(import.meta.dir, "..");
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
type Bump = "patch" | "minor" | "major";
type ReleaseType = Bump | "none";

interface Commit {
  hash: string;
  parents: string[];
  message: string;
}

interface RawChange {
  oldMode: string;
  newMode: string;
  oldBlob: string;
  newBlob: string;
  status: string;
  path: string;
}

function git(root: string, args: string[], encoding: "utf8" | null = "utf8"): string | Buffer {
  return execFileSync("git", args, { cwd: root, encoding, stdio: ["ignore", "pipe", "pipe"] });
}

function current(root = defaultRoot): string {
  const value = readFileSync(resolve(root, "VERSION"), "utf8").trim();
  if (!semver.test(value)) throw new Error(`VERSION is not semantic: ${value}`);
  return value;
}

function readJson(root: string, path: string): Record<string, unknown> {
  const value = JSON.parse(readFileSync(resolve(root, path), "utf8")) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${path} must be a JSON object`);
  return value as Record<string, unknown>;
}

export function checkVersion(expected?: string, root = defaultRoot): string {
  const version = current(root);
  const pkg = readJson(root, "package.json");
  const marketplace = readJson(root, ".omp-plugin/marketplace.json");
  if (pkg.version !== version) throw new Error(`package.json ${pkg.version} does not match VERSION ${version}`);
  if (marketplace.version !== version) throw new Error(`marketplace.json ${marketplace.version} does not match VERSION ${version}`);
  if (expected && expected !== version) throw new Error(`release tag ${expected} does not match VERSION ${version}`);
  return version;
}

function parseCommits(output: string): Commit[] {
  const fields = output.split("\0");
  const commits: Commit[] = [];
  for (let index = 0; index + 2 < fields.length; index += 3) {
    const hash = fields[index]!.trim();
    if (!hash) continue;
    commits.push({ hash, parents: fields[index + 1]!.trim().split(/\s+/).filter(Boolean), message: fields[index + 2]! });
  }
  return commits;
}

function rawChanges(root: string, hash: string): RawChange[] {
  const output = git(root, ["diff-tree", "--root", "--no-commit-id", "--raw", "-r", "-z", hash], null) as Buffer;
  const fields = output.toString("utf8").split("\0");
  const changes: RawChange[] = [];
  for (let index = 0; index < fields.length;) {
    const header = fields[index++];
    if (!header) continue;
    const match = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z][0-9]*)$/.exec(header);
    if (!match) throw new Error(`cannot parse Git change record for ${hash}`);
    const path = fields[index++];
    if (path === undefined) throw new Error(`Git change record has no path for ${hash}`);
    if (match[5]!.startsWith("R") || match[5]!.startsWith("C")) {
      // Renames and copies carry a second path; they are deliberately ineligible for revert cancellation.
      index++;
      changes.push({ oldMode: match[1]!, newMode: match[2]!, oldBlob: match[3]!, newBlob: match[4]!, status: match[5]!, path: `${path}\0${fields[index - 1] ?? ""}` });
      continue;
    }
    changes.push({ oldMode: match[1]!, newMode: match[2]!, oldBlob: match[3]!, newBlob: match[4]!, status: match[5]!, path });
  }
  return changes;
}

function trailer(message: string): ReleaseType | undefined {
  const lines = message.match(/^Release-Type:.*$/gim) ?? [];
  if (lines.length > 1) throw new Error("commit has duplicate Release-Type trailers");
  if (!lines.length) return undefined;
  const value = /^Release-Type:\s*(major|minor|patch|none)\s*$/i.exec(lines[0]!);
  if (!value) throw new Error(`invalid Release-Type trailer: ${lines[0]}`);
  return value[1]!.toLowerCase() as ReleaseType;
}

function versionSync(root: string, commit: Commit, changes: RawChange[]): boolean {
  const allowed = new Set(["VERSION", "package.json", ".omp-plugin/marketplace.json"]);
  if (commit.parents.length !== 1 || changes.length === 0 || changes.some(change => !allowed.has(change.path))) return false;
  const versionText = String(git(root, ["show", `${commit.hash}:VERSION`])).trim();
  if (!semver.test(versionText)) return false;
  try {
    const pkg = JSON.parse(String(git(root, ["show", `${commit.hash}:package.json`]))) as Record<string, unknown>;
    const marketplace = JSON.parse(String(git(root, ["show", `${commit.hash}:.omp-plugin/marketplace.json`]))) as Record<string, unknown>;
    if (pkg.version !== versionText || marketplace.version !== versionText) return false;
    const parent = commit.parents[0]!;
    const oldPkg = JSON.parse(String(git(root, ["show", `${parent}:package.json`]))) as Record<string, unknown>;
    const oldMarketplace = JSON.parse(String(git(root, ["show", `${parent}:.omp-plugin/marketplace.json`]))) as Record<string, unknown>;
    delete pkg.version;
    delete oldPkg.version;
    delete marketplace.version;
    delete oldMarketplace.version;
    return JSON.stringify(pkg) === JSON.stringify(oldPkg) && JSON.stringify(marketplace) === JSON.stringify(oldMarketplace);
  } catch {
    return false;
  }
}

function exactInverse(original: RawChange[], revert: RawChange[]): boolean {
  if (original.length === 0 || original.length !== revert.length) return false;
  if (original.some(change => !["A", "M", "D"].includes(change.status)) || revert.some(change => !["A", "M", "D"].includes(change.status))) return false;
  const reverseStatus: Record<string, string> = { A: "D", D: "A", M: "M" };
  const right = new Map(revert.map(change => [change.path, change]));
  if (right.size !== revert.length) return false;
  return original.every(change => {
    const reverse = right.get(change.path);
    return Boolean(reverse
      && reverse.status === reverseStatus[change.status]
      && reverse.oldMode === change.newMode
      && reverse.newMode === change.oldMode
      && reverse.oldBlob === change.newBlob
      && reverse.newBlob === change.oldBlob);
  });
}

function revertTarget(root: string, commit: Commit): string | undefined {
  if (commit.parents.length !== 1 || !/^Revert ".*"\s*$/m.test(commit.message)) return undefined;
  return /This reverts commit ([0-9a-f]{7,40})\./i.exec(commit.message)?.[1];
}

function classify(root: string, base: string): { bump: "none" | Bump; commits: number; effectiveCommits: number; excluded: Record<string, number>; next: string } {
  let range = "HEAD";
  try {
    const tag = String(git(root, ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"])).trim();
    range = `${tag}..HEAD`;
  } catch { /* The first release plans from all commits. */ }
  const commits = parseCommits(String(git(root, ["log", "--reverse", "--topo-order", "--format=%H%x00%P%x00%B%x00", range])));
  if (commits.length === 0) throw new Error("version plan has an empty commit batch since the latest release tag");

  const commitByHash = new Map(commits.map((commit, index) => [commit.hash, { commit, index }]));
  const changesByHash = new Map(commits.map(commit => [commit.hash, rawChanges(root, commit.hash)]));
  const excluded = { merge: 0, sync: 0, revert: 0, none: 0 };
  const canceled = new Set<string>();
  for (let index = 0; index < commits.length; index++) {
    const commit = commits[index]!;
    const targetPrefix = revertTarget(root, commit);
    if (!targetPrefix) continue;
    const matches = commits.filter(candidate => candidate.hash.startsWith(targetPrefix));
    if (matches.length !== 1) continue;
    const target = matches[0]!;
    const targetEntry = commitByHash.get(target.hash)!;
    if (targetEntry.index >= index || canceled.has(target.hash) || revertTarget(root, target)) continue;
    const paths = new Set(changesByHash.get(target.hash)!.map(change => change.path));
    const touchedBetween = commits.slice(targetEntry.index + 1, index).some(candidate => changesByHash.get(candidate.hash)!.some(change => paths.has(change.path)));
    if (touchedBetween) continue;
    if (!exactInverse(changesByHash.get(target.hash)!, changesByHash.get(commit.hash)!)) continue;
    canceled.add(target.hash);
    canceled.add(commit.hash);
    excluded.revert += 2;
  }

  let bump: Bump | undefined;
  let effectiveCommits = 0;
  for (const commit of commits) {
    if (canceled.has(commit.hash)) continue;
    if (commit.parents.length > 1) {
      excluded.merge++;
      continue;
    }
    if (versionSync(root, commit, changesByHash.get(commit.hash)!)) {
      excluded.sync++;
      continue;
    }
    const releaseType = trailer(commit.message);
    const breaking = /^[a-z]+(?:\([^\r\n)]*\))?!:/im.test(commit.message) || /^BREAKING CHANGE:/im.test(commit.message);
    if (breaking && releaseType !== "major") throw new Error("breaking commits require an explicit Release-Type: major trailer");
    effectiveCommits++;
    if (releaseType === "none") {
      excluded.none++;
      continue;
    }
    const commitBump: Bump = releaseType ?? "patch";
    if (bump === undefined || ["patch", "minor", "major"].indexOf(commitBump) > ["patch", "minor", "major"].indexOf(bump)) bump = commitBump;
  }
  const currentParts = base.split(".").map(Number);
  const [major = 0, minor = 0, patch = 0] = currentParts;
  const next = bump === "major" ? `${major + 1}.0.0` : bump === "minor" ? `${major}.${minor + 1}.0` : bump === "patch" ? `${major}.${minor}.${patch + 1}` : base;
  return { bump: bump ?? "none", commits: commits.length, effectiveCommits, excluded, next };
}

export function planVersion(root = defaultRoot): { current: string; bump: "none" | Bump; next: string; commits: number; effectiveCommits: number; excluded: Record<string, number> } {
  const base = checkVersion(undefined, root);
  let releaseBase = base;
  let releaseTag: string | undefined;
  try { releaseTag = String(git(root, ["describe", "--tags", "--abbrev=0", "--match", "v[0-9]*"])).trim(); } catch { /* First release uses the initial canonical version. */ }
  if (releaseTag) {
    const taggedVersion = String(git(root, ["show", `${releaseTag}:VERSION`])).trim();
    if (!semver.test(taggedVersion) || releaseTag !== `v${taggedVersion}`) throw new Error("release tag and canonical version disagree");
    releaseBase = taggedVersion;
  } else {
    const first = String(git(root, ["rev-list", "--max-parents=0", "HEAD"])).trim().split(/\s+/);
    if (first.length !== 1) throw new Error("first release has ambiguous root ancestry");
    const initial = String(git(root, ["show", `${first[0]}:VERSION`])).trim();
    if (!semver.test(initial)) throw new Error("initial canonical version is invalid");
    releaseBase = initial;
  }
  // A prepared VERSION is the result of the batch, never its arithmetic base.
  const result = classify(root, releaseBase);
  return { current: base, ...result };
}

export function setVersion(value: string, root = defaultRoot): string {
  if (!semver.test(value)) throw new Error(`invalid semantic version: ${value}`);
  const pkg = readJson(root, "package.json");
  const marketplace = readJson(root, ".omp-plugin/marketplace.json");
  pkg.version = value;
  marketplace.version = value;
  writeFileSync(resolve(root, "VERSION"), `${value}\n`);
  writeFileSync(resolve(root, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
  writeFileSync(resolve(root, ".omp-plugin/marketplace.json"), `${JSON.stringify(marketplace, null, 2)}\n`);
  return checkVersion(value, root);
}

const [command = "check", value] = process.argv.slice(2);
if (import.meta.main) {
  if (command === "check") process.stdout.write(`${checkVersion(value?.replace(/^v/, ""))}\n`);
  else if (command === "plan") process.stdout.write(`${JSON.stringify(planVersion(), null, 2)}\n`);
  else if (command === "set" && value) process.stdout.write(`${setVersion(value.replace(/^v/, ""))}\n`);
  else throw new Error("usage: bun run scripts/version.ts check [vX.Y.Z] | plan | set X.Y.Z");
}
