import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const provenanceBytes = readFileSync(join(root, "provenance/musl-runtime.json"));
const provenanceRoot = object(JSON.parse(provenanceBytes.toString("utf8")), "musl runtime provenance");
export const muslRuntimeProvenanceSha256 = createHash("sha256").update(provenanceBytes).digest("hex");
const digestPattern = /^[0-9a-f]{64}$/;

const targetHosts = {
  "linux-x64-musl": { architecture: "x64", dockerArchitecture: "amd64", alpineArchitecture: "x86_64", dockerPlatform: "linux/amd64", signer: "alpine-devel@lists.alpinelinux.org-6165ee59.rsa.pub" },
  "linux-arm64-musl": { architecture: "arm64", dockerArchitecture: "arm64", alpineArchitecture: "aarch64", dockerPlatform: "linux/arm64", signer: "alpine-devel@lists.alpinelinux.org-616ae350.rsa.pub" },
} as const;
export type MuslTargetId = keyof typeof targetHosts;
export type MuslInventoryEntry = { name: string; version: string; architecture: string };

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function nonempty(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== "string" || !digestPattern.test(value)) throw new Error(`${label} must be a lowercase SHA-256 digest`);
  return value;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isMuslTarget(value: string): value is MuslTargetId {
  return Object.hasOwn(targetHosts, value);
}

export function sortMuslInventory(value: unknown, label: string): MuslInventoryEntry[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  const entries = value.map((item, index) => {
    const entry = object(item, `${label}[${index}]`);
    return {
      name: nonempty(entry.name, `${label}[${index}].name`),
      version: nonempty(entry.version, `${label}[${index}].version`),
      architecture: nonempty(entry.architecture, `${label}[${index}].architecture`),
    };
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(entries.map(entry => entry.name)).size !== entries.length) throw new Error(`${label} contains duplicate package names`);
  return entries;
}

export function muslTargetProvenance(targetId: MuslTargetId): Record<string, unknown> {
  if (provenanceRoot.schemaVersion !== 1 || provenanceRoot.recordKind !== "cruxomni-musl-runtime-provenance") {
    throw new Error("musl runtime provenance identity is invalid");
  }
  const base = object(provenanceRoot.baseImage, "musl base image provenance");
  if (base.repository !== "oven/bun" || base.tag !== "1.4.2-alpine" || base.registry !== "docker.io"
    || base.alpineVersion !== "3.22.5" || base.bunVersion !== "1.4.2") throw new Error("musl base image must pin reviewed Bun 1.4.2 on Alpine 3.22.5");
  const targets = object(base.targets, "musl runtime targets");
  const target = object(targets[targetId], `${targetId} runtime provenance`);
  const expected = targetHosts[targetId];
  if (target.dockerPlatform !== expected.dockerPlatform || target.dockerArchitecture !== expected.dockerArchitecture
    || target.alpineArchitecture !== expected.alpineArchitecture) throw new Error(`${targetId} runtime provenance has an unexpected architecture mapping`);
  const baseDigest = nonempty(target.baseManifestDigest, `${targetId} base manifest digest`);
  if (!/^sha256:[0-9a-f]{64}$/.test(baseDigest)) throw new Error(`${targetId} base manifest digest is invalid`);
  const apkIndex = object(target.apkIndex, `${targetId} signed Alpine index`);
  const indexUrl = new URL(nonempty(apkIndex.url, `${targetId} index URL`));
  if (indexUrl.protocol !== "https:" || indexUrl.hostname !== "dl-cdn.alpinelinux.org"
    || !digestPattern.test(String(apkIndex.sha256)) || apkIndex.signatureVerifiedDuringReview !== true
    || apkIndex.signerKeyName !== expected.signer) throw new Error(`${targetId} signed index provenance is incomplete`);
  digest(apkIndex.signerKeySha256, `${targetId} signer key digest`);
  digest(apkIndex.signatureMemberSha256, `${targetId} index signature digest`);
  const closure = object(provenanceRoot.apkClosure, "musl APK closure provenance");
  digest(closure.closureSha256, "musl APK closure digest");
  if (closure.packageCountPerArchitecture !== 26) throw new Error("musl APK closure does not match the reviewed 26-package closure");
  const recipe = object(provenanceRoot.recipe, "musl runtime build recipe");
  if (recipe.dockerBuildNetwork !== "none" || recipe.packageScripts !== false || !Array.isArray(recipe.repositories)
    || recipe.repositories.length !== 0 || typeof recipe.apkInstallCommand !== "string"
    || !recipe.apkInstallCommand.includes("--no-network") || !recipe.apkInstallCommand.includes("--no-scripts")
    || !recipe.apkInstallCommand.includes("--repositories-file /dev/null")) {
    throw new Error("musl runtime recipe must install the frozen package closure without network, scripts, or repositories");
  }
  if (!Array.isArray(target.packages) || target.packages.length !== 26) throw new Error(`${targetId} runtime provenance must contain exactly 26 signed APKs`);
  const seen = new Set<string>();
  for (const [index, item] of target.packages.entries()) {
    const pkg = object(item, `${targetId} APK ${index}`);
    const name = nonempty(pkg.name, `${targetId} APK ${index} name`);
    const version = nonempty(pkg.version, `${targetId} APK ${index} version`);
    if (pkg.architecture !== expected.alpineArchitecture || pkg.signatureVerifiedDuringReview !== true || pkg.signerKeyName !== expected.signer
      || !Number.isSafeInteger(pkg.sizeBytes) || Number(pkg.sizeBytes) < 1) throw new Error(`${targetId} APK ${name} lacks reviewed architecture, size, or signature data`);
    digest(pkg.sha256, `${targetId} APK ${name} digest`);
    digest(pkg.dataTarSha256, `${targetId} APK ${name} data digest`);
    const url = new URL(nonempty(pkg.url, `${targetId} APK ${name} URL`));
    if (url.protocol !== "https:" || url.hostname !== "dl-cdn.alpinelinux.org"
      || url.pathname !== `/alpine/v3.22/main/${expected.alpineArchitecture}/${name}-${version}.apk`) throw new Error(`${targetId} APK ${name} URL is outside the pinned Alpine repository`);
    if (seen.has(name)) throw new Error(`${targetId} APK closure duplicates ${name}`);
    seen.add(name);
  }
  const inventory = sortMuslInventory(target.finalInstalledInventory, `${targetId} final installed inventory`);
  if (target.finalInstalledPackageCount !== 41 || inventory.length !== 41
    || inventory.some(entry => entry.architecture !== expected.alpineArchitecture && entry.architecture !== "noarch")) throw new Error(`${targetId} final installed inventory must contain exactly 41 target-architecture or noarch packages`);
  const review = object(provenanceRoot.review, "musl advisory review");
  if (!Array.isArray(review.sources) || review.sources.length < 4 || typeof review.coverage !== "string"
    || !review.coverage.includes("does not establish absence of every vulnerability")) {
    throw new Error("musl advisory review must preserve its bounded coverage statement");
  }
  return target;
}

export async function validateMuslRuntimeEvidence(value: unknown, targetId: string, archiveSha256: string, sourceRevision: string): Promise<Record<string, unknown>> {
  if (!isMuslTarget(targetId)) throw new Error("runtime evidence is permitted only for the two Linux musl targets");
  const target = targetId;
  const provenance = muslTargetProvenance(target);
  const evidence = object(value, "musl runtime evidence");
  const expected = targetHosts[target];
  const installedDatabaseHashField = "installedDatabase" + "Sha256";
  const installedInventoryHashField = "installedInventory" + "Sha256";
  const expectedKeys = ["schemaVersion", "recordKind", "status", "targetId", "sourceRevision", "archiveSha256", "provenanceSha256", "baseImageReference", "baseManifestDigest", "dockerPlatform", "runnerArchitecture", "daemonArchitecture", "imageId", "imageArchitecture", "buildNetwork", "apkInstallNetwork", "apkScripts", "repositories", "signedIndexSha256", "signerKeySha256", "verifiedApkCount", installedDatabaseHashField, installedInventoryHashField, "installedPackageCount", "installedInventory"];
  if (Object.keys(evidence).sort().join("\0") !== [...expectedKeys].sort().join("\0")) throw new Error("musl runtime evidence has missing or unexpected fields");
  if (evidence.schemaVersion !== 1 || evidence.recordKind !== "cruxomni-musl-runtime-verification" || evidence.status !== "verified"
    || evidence.targetId !== target || evidence.sourceRevision !== sourceRevision || evidence.archiveSha256 !== archiveSha256
    || evidence.provenanceSha256 !== muslRuntimeProvenanceSha256 || evidence.baseImageReference !== `oven/bun@${provenance.baseManifestDigest}`
    || evidence.baseManifestDigest !== provenance.baseManifestDigest || evidence.dockerPlatform !== provenance.dockerPlatform
    || evidence.runnerArchitecture !== expected.architecture || evidence.daemonArchitecture !== expected.architecture
    || evidence.imageArchitecture !== provenance.dockerArchitecture || evidence.buildNetwork !== "none"
    || evidence.apkInstallNetwork !== "none" || evidence.apkScripts !== false || !Array.isArray(evidence.repositories)
    || evidence.repositories.length !== 0) throw new Error(`${target} runtime evidence is not bound to the reviewed native offline build`);
  if (typeof evidence.imageId !== "string" || !/^sha256:[0-9a-f]{64}$/.test(evidence.imageId)) throw new Error(`${target} runtime image ID is invalid`);
  const apkIndex = object(provenance.apkIndex, `${target} signed index`);
  if (evidence.signedIndexSha256 !== apkIndex.sha256 || evidence.signerKeySha256 !== apkIndex.signerKeySha256
    || evidence.verifiedApkCount !== 26) throw new Error(`${target} runtime package signature evidence is incomplete`);
  digest(evidence.installedDatabaseSha256, `${target} installed database digest`);
  digest(evidence.installedInventorySha256, `${target} installed inventory digest`);
  const actualInventory = sortMuslInventory(evidence.installedInventory, `${target} runtime inventory`);
  const expectedInventory = sortMuslInventory(provenance.finalInstalledInventory, `${target} provenance inventory`);
  if (evidence.installedPackageCount !== 41 || actualInventory.length !== 41
    || JSON.stringify(actualInventory) !== JSON.stringify(expectedInventory)
    || await sha256(Buffer.from(JSON.stringify(actualInventory))) !== evidence.installedInventorySha256) {
    throw new Error(`${target} installed package inventory differs from the reviewed 41-package closure`);
  }
  return evidence;
}
