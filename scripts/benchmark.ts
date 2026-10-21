import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dir, "..");
async function fingerprint(directory: string): Promise<string> {
  const hash = createHash("sha256");
  async function visit(path: string): Promise<void> {
    const info = await lstat(join(directory, path));
    if (info.isSymbolicLink()) throw new Error(`Source fingerprint rejects links: ${path}`);
    if (info.isDirectory()) {
      for (const entry of (await readdir(join(directory, path))).sort()) await visit(`${path}/${entry}`);
    } else if (info.isFile()) hash.update(path).update("\0").update(await readFile(join(directory, path))).update("\0");
    else throw new Error(`Source fingerprint rejects special entries: ${path}`);
  }
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  if (!Array.isArray(manifest.files) || manifest.files.some((path: unknown) => typeof path !== "string" || !/^[A-Za-z0-9_.\/-]+$/.test(path) || path.startsWith("/") || path.split("/").some(part => part === ".." || part === "." || part === ""))) throw new Error("Benchmark requires explicit package input paths");
  for (const path of [...new Set<string>(["package.json", "VERSION", ...manifest.files])].sort()) await visit(path);
  return hash.digest("hex");
}
async function sample(directory: string): Promise<Record<string, number>> {
  const moduleAt = (path: string) => import(pathToFileURL(join(directory, path)).href);
  const start = performance.now();
  await moduleAt("src/index.ts");
  const startupImportMs = performance.now() - start;
  const startupRssBytes = process.memoryUsage().rss;
  const administrationStart = performance.now();
  const registry = await moduleAt("src/admin/registry.ts");
  registry.getOperationRegistry?.();
  const administrationImportMs = performance.now() - administrationStart;
  const administrationRssBytes = process.memoryUsage().rss;
  const { projectCatalog } = await moduleAt("src/catalog.ts");
  const { DiscoveryManager } = await moduleAt("src/health.ts");
  const payload = { data: Array.from({ length: 1000 }, (_, index) => ({ id: `benchmark/model-${index}`, supported_endpoints: ["chat-completions"] })) };
  const manager = new DiscoveryManager(async () => ({ projection: projectCatalog(payload) }));
  manager.setBinding("https://benchmark.invalid", "disposable-fixture");
  const discoveryStart = performance.now();
  const result = await manager.refresh({ force: true });
  const discovery1000ModelsMs = performance.now() - discoveryStart;
  if (result?.projection.models.length !== 1000) throw new Error("Benchmark discovery did not publish all fixture models");
  return { startupImportMs, administrationImportMs, startupRssBytes, administrationRssBytes, discovery1000ModelsMs };
}
async function measure(directory: string): Promise<Record<string, unknown>> {
  const before = await fingerprint(directory);
  const samples: Array<Record<string, number>> = [];
  for (let index = 0; index < 6; index++) {
    const result = JSON.parse(execFileSync(process.execPath, [import.meta.path, "--sample", directory], { encoding: "utf8", maxBuffer: 1024 * 1024 }));
    if (index > 0) samples.push(result);
  }
  const median = Object.fromEntries(Object.keys(samples[0]!).map(key => [key, samples.map(sample => sample[key]!).sort((a, b) => a - b)[2]]));
  const temporary = await mkdtemp(join(tmpdir(), "cruxomni-benchmark-"));
  let packageSize: Record<string, number>;
  try {
    const [pack] = JSON.parse(execFileSync("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", temporary], { cwd: directory, encoding: "utf8", maxBuffer: 8 * 1024 * 1024, env: { ...process.env, npm_config_ignore_scripts: "true" } }));
    if (!Number.isSafeInteger(pack?.size) || !Number.isSafeInteger(pack?.unpackedSize)) throw new Error("npm pack did not report package sizes");
    packageSize = { archiveBytes: pack.size, unpackedBytes: pack.unpackedSize };
  } finally { await rm(temporary, { recursive: true, force: true }); }
  if (await fingerprint(directory) !== before) throw new Error("Benchmark source changed while measuring");
  return { sourceSha256: before, median, samples, packageSize };
}
if (import.meta.main) {
  if (process.argv[2] === "--sample" && process.argv[3]) console.log(JSON.stringify(await sample(resolve(process.argv[3]))));
  else {
    const baseline = process.argv[2];
    const output = process.argv[3];
    if (!baseline || !output || process.argv.length !== 4) throw new Error("Usage: bun scripts/benchmark.ts <baseline-checkout> <report.json>");
    const report = { schemaVersion: 1, runtime: { bun: Bun.version, platform: process.platform, architecture: process.arch }, methodology: "Five isolated-process samples after one discarded warmup per checkout; median wall time and process RSS. Identical installed SDK/toolchain. Discovery uses 1000 disposable local rows, excludes network latency. Administration includes registry initialization. Import timing is not interactive startup latency. Package size uses npm pack without scripts. Observational data, not release qualification.", baseline: await measure(resolve(baseline)), candidate: await measure(root) };
    await writeFile(resolve(output), JSON.stringify(report, null, 2) + "\n", { mode: 0o600 });
    console.log(JSON.stringify({ report: resolve(output) }));
  }
}
