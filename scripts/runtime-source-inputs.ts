import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

const migrationRunner = "src/lib/db/migrationRunner.ts";
const numberedMigration = /^\d+_.+\.sql$/;
const maxMigrationFiles = 10_000;
const maxMigrationBytes = 8 * 1024 * 1024;

export type RuntimeSourceReceipt = {
  path: string;
  bytes: number;
  sha256: string;
  gitBlobSha: string;
};

function isWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(`${root}${sep}`);
}

function resolveDefaultMigrationsDirectory(sourceRoot: string): string {
  const root = realpathSync(sourceRoot);
  const runner = resolve(root, migrationRunner);
  if (!isWithin(root, runner) || !lstatSync(runner).isFile() || !isWithin(root, realpathSync(runner))) {
    throw new Error("pinned migration runner is missing or unsafe");
  }

  // Match migrationRunner.ts's default resolver from its own directory. Static
  // collection covers only the immutable upstream default; configured external
  // directories and OMNIROUTE_EXTRA_MIGRATIONS_DIRS require separate evidence.
  let basePath = dirname(runner);
  while (isWithin(root, basePath)) {
    const candidates = [
      resolve(basePath, "migrations"),
      resolve(basePath, "src", "lib", "db", "migrations"),
      resolve(basePath, "app", "src", "lib", "db", "migrations"),
    ];
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      if (!lstatSync(candidate).isDirectory()) throw new Error("default migration directory is not a regular directory");
      const physical = realpathSync(candidate);
      if (!isWithin(root, candidate) || !isWithin(root, physical) || !statSync(physical).isDirectory()) {
        throw new Error("default migration directory escapes or is not a directory inside the pinned source");
      }
      const expected = resolve(root, "src", "lib", "db", "migrations");
      if (candidate !== expected) throw new Error(`unknown pinned default migration directory: ${relative(root, candidate).split(sep).join("/")}`);
      return candidate;
    }
    const parent = dirname(basePath);
    if (parent === basePath || !isWithin(root, parent)) break;
    basePath = parent;
  }
  throw new Error("pinned migration runner default migrations directory could not be resolved");
}

/**
 * Add files opened by the migration runner's default numbered-SQL discovery.
 * SQL is captured as opaque bytes, never passed through the TypeScript parser.
 */
export function addDefaultMigrationInputs(
  sourceRoot: string,
  importClosureFiles: readonly string[],
  captureSource: (absolutePath: string) => RuntimeSourceReceipt,
): string[] {
  const files = new Set(importClosureFiles);
  if (!files.has(migrationRunner)) return [...files].sort();

  const root = realpathSync(sourceRoot);
  const directory = resolveDefaultMigrationsDirectory(root);
  const entries = readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.name.endsWith(".sql") && numberedMigration.test(entry.name))
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0);
  if (entries.length > maxMigrationFiles) throw new Error("pinned default migration source exceeds the file-count bound");

  let totalBytes = 0;
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    const physical = realpathSync(path);
    if (!entry.isFile() || lstatSync(path).isSymbolicLink() || !isWithin(root, path) || !isWithin(root, physical)) {
      throw new Error(`pinned default migration is not a regular in-root file: ${entry.name}`);
    }
    const stat = statSync(physical);
    if (!stat.isFile() || stat.size > maxMigrationBytes) throw new Error(`pinned default migration exceeds file safety bounds: ${entry.name}`);
    totalBytes += stat.size;
    if (totalBytes > 64 * 1024 * 1024) throw new Error("pinned default migration sources exceed the total byte bound");

    const receipt = captureSource(path);
    const relativePath = relative(root, path).split(sep).join("/");
    if (receipt.path !== relativePath || receipt.bytes !== stat.size) {
      throw new Error(`pinned default migration receipt does not match its source path: ${entry.name}`);
    }
    files.add(relativePath);
  }
  return [...files].sort();
}

/** Hash resolved source receipts using the collector's stable path/content tuple. */
export function resolvedSourceInputsDigest(receipts: readonly RuntimeSourceReceipt[]): string {
  const records = [...receipts]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map(({ path, sha256, gitBlobSha }) => ({ path, sha256, gitBlobSha }));
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}
