import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DISPLAY_NAME, REPOSITORY_URL } from "../src/identity.ts";

const root = resolve(import.meta.dir, "..");
const manifest = JSON.parse(await readFile(resolve(root, ".omp-plugin/marketplace.json"), "utf8")) as Record<string, any>;
const pkg = JSON.parse(await readFile(resolve(root, "package.json"), "utf8")) as Record<string, any>;

function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`marketplace manifest invalid: ${message}`);
}

requireValue(manifest.schemaVersion === 1, "schemaVersion must be 1");
requireValue(manifest.id === "cruxomni-omp-client", "stable id mismatch");
requireValue(manifest.name === DISPLAY_NAME && pkg.omp?.name === DISPLAY_NAME, "display name mismatch");
requireValue(manifest.package === pkg.name && manifest.version === pkg.version, "package identity/version mismatch");
requireValue(manifest.entrypoint === pkg.omp?.extensions?.[0], "entrypoint differs from OMP extension");
requireValue(manifest.compatibility?.host === pkg.omp?.compatibility?.host, "host range mismatch");
requireValue(JSON.stringify(manifest.compatibility?.tested) === JSON.stringify(pkg.omp?.compatibility?.tested), "tested host matrix mismatch");
requireValue(manifest.license === pkg.license && manifest.publisher === "Crux Experts LLC", "license or publisher mismatch");
requireValue(manifest.publication === "prepared-not-published", "publication status must remain preparation-only");
requireValue(manifest.repository?.url === REPOSITORY_URL, "repository URL is not the public project URL");
requireValue(manifest.repository?.homepage === `${REPOSITORY_URL}#readme`, "homepage is not the public project URL");
requireValue(manifest.repository?.issues === `${REPOSITORY_URL}/issues`, "issues URL is not the public project URL");
process.stdout.write(`${JSON.stringify({ status: "verified", id: manifest.id, version: manifest.version, publication: manifest.publication })}\n`);
