import { readRouteSources } from "./route-source-store.ts";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { canonicalJson, generateContracts, normalizeNextRoutePath, sha256 } from "./generate-contracts.ts";

type AnyRecord = Record<string, unknown>;
type Receipt = { path: string; bytes: number; sha256: string; gitBlobSha: string };
type UpstreamPin = { repository: string; tag: string; commit: string; releaseId: number; archiveUrl: string; archiveSha256: string; packageGitBlobSha: string };

const packageRoot = resolve(import.meta.dir, "..");
const manifestPath = resolve(packageRoot, "provenance/route-sources.json");
const operationsPath = resolve(packageRoot, "contracts/operations.json");
const upstreamsPath = resolve(packageRoot, "provenance/upstreams.json");
const eligibilityPath = resolve(packageRoot, "contracts/release-eligibility.json");
const sourceSnapshotPath = resolve(packageRoot, `.agents/state/omp-provider-release/upstream/omniroute-${expectedOmniRoutePin().tag}`);
const METHODS = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"] as const;
const NON_INVOKABLE = new Map<string, string>([
  ["src/app/api/[...omnirouteApiCatchAll]/route.ts", "Source-confirmed unknown-route JSON 404 fallback; OPTIONS supplies only CORS headers."],
  ["src/app/api/v1/[...omnirouteCatchAll]/route.ts", "Source-confirmed unknown-route JSON 404 fallback; OPTIONS supplies only CORS headers."],
  ["src/app/api/openapi/try/route.ts", "Source-confirmed arbitrary OpenAPI request executor; model-authored paths are not invokable."],
  ["src/app/docs/api/search/route.ts", "Source-confirmed Fumadocs search adapter; framework documentation plumbing is not an OmniRoute control-plane operation."],
]);

function requireObject(value: unknown, label: string): AnyRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as AnyRecord;
}
function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}
function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}
function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite`);
  return value;
}
function compareText(left: string, right: string): number { return left < right ? -1 : left > right ? 1 : 0; }
function canonical(value: unknown, depth = 0): string {
  if (depth > 64) throw new Error("JSON comparison exceeds depth bound");
  if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("undefined in provenance comparison");
    return serialized;
  }
  if (Array.isArray(value)) return `[${value.map(child => canonical(child, depth + 1)).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as AnyRecord;
    return `{${Object.keys(object).sort(compareText).map(key => `${JSON.stringify(key)}:${canonical(object[key], depth + 1)}`).join(",")}}`;
  }
  throw new Error("non-JSON value in provenance comparison");
}
function readJson(path: string): AnyRecord { return requireObject(JSON.parse(readFileSync(path, "utf8")) as unknown, path); }
function safeFile(root: string, path: string): string {
  if (!path || path.startsWith("/") || path.includes("\\") || path.split("/").some(part => part === ".." || part === "")) throw new Error(`unsafe pinned source path: ${path}`);
  const absolute = resolve(root, path);
  if (absolute !== root && !absolute.startsWith(`${root}${sep}`)) throw new Error(`pinned source path escapes snapshot: ${path}`);
  const real = realpathSync(absolute);
  const realRoot = realpathSync(root);
  if (real !== realRoot && !real.startsWith(`${realRoot}${sep}`)) throw new Error(`pinned source symlink escapes snapshot: ${path}`);
  return real;
}
function gitBlobSha(bytes: Buffer): string {
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes])).digest("hex");
}
async function fileSha256(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}
function expectedOmniRoutePin(): UpstreamPin {
  const upstreams = requireArray(readJson(upstreamsPath).upstreams, "provenance.upstreams");
  const upstream = upstreams.map(value => requireObject(value, "provenance upstream")).find(value => value.id === "omniroute");
  if (!upstream) throw new Error("provenance has no OmniRoute upstream");
  const release = requireObject(upstream.release, "provenance OmniRoute release");
  const artifact = requireObject(upstream.artifact_integrity, "provenance OmniRoute source archive");
  const packageHash = requireArray(upstream.source_hashes, "provenance OmniRoute source hashes")
    .map(value => requireObject(value, "provenance source hash"))
    .find(value => value.path === "package.json" && value.algorithm === "git-blob-sha1");
  if (!packageHash) throw new Error("provenance lacks pinned OmniRoute package.json blob hash");
  return {
    repository: requireString(upstream.repository, "OmniRoute repository"),
    tag: requireString(release.tag, "OmniRoute release tag"),
    commit: requireString(release.peeled_commit, "OmniRoute peeled commit"),
    releaseId: requireNumber(release.release_id, "OmniRoute release ID"),
    archiveUrl: requireString(artifact.source_archive_url, "OmniRoute source archive URL"),
    archiveSha256: requireString(artifact.source_archive_sha256, "OmniRoute source archive SHA-256"),
    packageGitBlobSha: requireString(packageHash.hash, "OmniRoute package.json Git blob SHA"),
  };
}
async function verifyArchiveAndSourceRoot(manifest: AnyRecord, pin: UpstreamPin): Promise<void> {
  const archive = requireObject(manifest.sourceArchive, "manifest.sourceArchive");
  const expectedArchivePath = `.agents/state/omp-provider-release/upstream/omniroute-v${pin.tag.slice(1)}-${pin.commit}.tar.gz`;
  if (archive.path !== expectedArchivePath || archive.url !== pin.archiveUrl || archive.commit !== pin.commit
    || manifest.sourceArchiveSha256 !== pin.archiveSha256 || archive.sha256 !== pin.archiveSha256) {
    throw new Error("source archive receipt does not match the immutable OmniRoute pin");
  }
  const archivePath = resolve(packageRoot, expectedArchivePath);
  if (statSync(archivePath).size !== requireNumber(archive.bytes, "manifest.sourceArchive.bytes")) throw new Error("source archive byte count drift");
  if (await fileSha256(archivePath) !== pin.archiveSha256) throw new Error("pinned source archive digest mismatch");
  if (manifest.sourceRoot !== "src/app") throw new Error("manifest source root is not the pinned Next route root");
  if (existsSync(resolve(sourceSnapshotPath, ".git"))) throw new Error("source snapshot must not rely on a mutable checkout");
  const sourcePackage = readJson(safeFile(sourceSnapshotPath, "package.json"));
  if (sourcePackage.version !== pin.tag.slice(1)) throw new Error("source snapshot package version does not match the pinned release");
  if (gitBlobSha(readFileSync(safeFile(sourceSnapshotPath, "package.json"))) !== pin.packageGitBlobSha) throw new Error("pinned package.json Git blob hash mismatch");
}
function verifySourceReceipts(manifest: AnyRecord): Map<string, Receipt> {
  const corpus = requireObject(manifest.sourceCorpus, "manifest.sourceCorpus");
  const values = requireArray(corpus.files, "manifest.sourceCorpus.files");
  if (corpus.fileCount !== values.length) throw new Error("source corpus file count drift");
  const receipts = new Map<string, Receipt>();
  let previous = "";
  for (const value of values) {
    const item = requireObject(value, "source corpus receipt");
    const path = requireString(item.path, "source receipt path");
    if (receipts.has(path) || (previous && compareText(previous, path) >= 0)) throw new Error(`source receipts are duplicate or non-deterministic: ${path}`);
    previous = path;
    const bytes = readFileSync(safeFile(sourceSnapshotPath, path));
    const receipt: Receipt = {
      path,
      bytes: requireNumber(item.bytes, `${path}.bytes`),
      sha256: requireString(item.sha256, `${path}.sha256`),
      gitBlobSha: requireString(item.gitBlobSha, `${path}.gitBlobSha`),
    };
    if (bytes.byteLength !== receipt.bytes
      || createHash("sha256").update(bytes).digest("hex") !== receipt.sha256
      || gitBlobSha(bytes) !== receipt.gitBlobSha) throw new Error(`pinned source receipt mismatch: ${path}`);
    receipts.set(path, receipt);
  }
  return receipts;
}
function sourceDigest(paths: readonly string[], receipts: Map<string, Receipt>, label: string): string {
  const records = paths.map(path => {
    const receipt = receipts.get(path);
    if (!receipt) throw new Error(`${label} references a file without a source receipt: ${path}`);
    return { path: receipt.path, sha256: receipt.sha256, gitBlobSha: receipt.gitBlobSha };
  });
  return createHash("sha256").update(JSON.stringify(records)).digest("hex");
}
function pathShape(path: string): string { return path.replace(/\*[^/]+|\{[^}]+\}/g, "{}"); }
function verifyFrameworkAndRoutes(manifest: AnyRecord, receipts: Map<string, Receipt>): Map<string, AnyRecord> {
  if (manifest.schemaVersion !== 2 || manifest.recordKind !== "omniroute-route-source-manifest") throw new Error("route source manifest version/identity mismatch");
  const framework = requireObject(manifest.frameworkContext, "manifest.frameworkContext");
  const resolvedFiles = requireArray(framework.resolvedFiles, "framework.resolvedFiles").map((value, index) => requireString(value, `framework.resolvedFiles[${index}]`));
  const orderedFramework = [...resolvedFiles].sort(compareText);
  if (canonical(orderedFramework) !== canonical(resolvedFiles) || new Set(resolvedFiles).size !== resolvedFiles.length) throw new Error("framework file closure is not deterministically ordered");
  for (const key of ["entryFiles", "dependencyContextFiles"]) {
    for (const value of requireArray(framework[key], `framework.${key}`)) {
      const path = requireString(value, `framework.${key} item`);
      if (!resolvedFiles.includes(path)) throw new Error(`framework ${key} path is outside its closure: ${path}`);
    }
  }
  if (sourceDigest(resolvedFiles, receipts, "framework closure") !== framework.sha256) throw new Error("framework import closure digest mismatch");
  const routeValues = requireArray(manifest.routeFiles, "manifest.routeFiles");
  const byKey = new Map<string, AnyRecord>();
  const sourceMethods: { method: string; path: string; sourceFile: string }[] = [];
  const methodCounts: Record<string, number> = Object.fromEntries(METHODS.map(method => [method, 0]));
  const excludedSeen = new Set<string>();
  for (const value of routeValues) {
    const route = requireObject(value, "route source entry");
    const sourceFile = requireString(route.sourceFile, "route.sourceFile");
    const template = requireString(route.routeTemplate, `${sourceFile}.routeTemplate`);
    if (normalizeNextRoutePath(sourceFile) !== template) throw new Error(`route path normalization drift: ${sourceFile}`);
    const sourceReceipt = receipts.get(sourceFile);
    if (!sourceReceipt || sourceReceipt.sha256 !== route.sha256 || sourceReceipt.gitBlobSha !== route.gitBlobSha || sourceReceipt.bytes !== route.bytes) throw new Error(`handler receipt drift: ${sourceFile}`);
    const expectedReason = NON_INVOKABLE.get(sourceFile);
    if (expectedReason) {
      if (route.classification !== "source-justified-non-invokable" || route.classificationReason !== expectedReason) throw new Error(`non-invokable exception drift: ${sourceFile}`);
      excludedSeen.add(sourceFile);
    } else if (route.classification !== "external" || route.classificationReason !== null) throw new Error(`unjustified route exclusion: ${sourceFile}`);
    const unresolved = requireArray(route.unresolvedLocalImports, `${sourceFile}.unresolvedLocalImports`);
    if (sourceFile === "src/app/docs/api/search/route.ts") {
      if (canonical(unresolved) !== canonical(["src/lib/source.ts -> ../../.source/server"])) throw new Error("documentation generated-source gap changed");
    } else if (unresolved.length > 0) throw new Error(`handler import closure has unresolved local imports: ${sourceFile}`);
    const imports = requireArray(route.resolvedImports, `${sourceFile}.resolvedImports`).map((item, index) => requireString(item, `${sourceFile}.resolvedImports[${index}]`));
    if (new Set(imports).size !== imports.length || canonical(imports) !== canonical([...imports].sort(compareText))) throw new Error(`handler imports are duplicated or unordered: ${sourceFile}`);
    if (sourceDigest(imports, receipts, `${sourceFile} import closure`) !== route.resolvedImportsSha256) throw new Error(`handler import closure digest mismatch: ${sourceFile}`);
    const exports = requireObject(route.exports, `${sourceFile}.exports`);
    const direct = requireArray(exports.direct, `${sourceFile}.exports.direct`).map(String);
    const reExports = requireArray(exports.reExports, `${sourceFile}.exports.reExports`).map(String);
    const resolved = requireArray(exports.resolved, `${sourceFile}.exports.resolved`).map(String);
    const union = [...new Set([...direct, ...reExports])].sort(compareText);
    if (canonical(union) !== canonical([...resolved].sort(compareText)) || new Set(resolved).size !== resolved.length) throw new Error(`route exported-method closure mismatch: ${sourceFile}`);
    for (const method of resolved) {
      if (!(METHODS as readonly string[]).includes(method)) throw new Error(`unsupported exported method ${method}: ${sourceFile}`);
      methodCounts[method] = (methodCounts[method] ?? 0) + 1;
      const key = `${method} ${template.replace(/\*([A-Za-z0-9._~-]+)/g, "{$1}")} ${sourceFile}`;
      if (byKey.has(key)) throw new Error(`duplicate source operation: ${key}`);
      byKey.set(key, route);
      sourceMethods.push({ method, path: template, sourceFile });
    }
  }
  if (excludedSeen.size !== NON_INVOKABLE.size) throw new Error("one or more source-justified exclusions are missing");
  const coverage = requireObject(manifest.coverage, "manifest.coverage");
  const inputs = requireObject(manifest.inputs, "manifest.inputs");
  const tree = requireObject(inputs.tree, "manifest.inputs.tree");
  if (routeValues.length !== coverage.routeFiles || sourceMethods.length !== coverage.sourceOperations
    || canonical(methodCounts) !== canonical(coverage.sourceMethodCounts)
    || requireNumber(tree.routeFileCount, "manifest.inputs.tree.routeFileCount") !== routeValues.length) throw new Error("source route inventory counts do not match immutable receipts");
  const openapi = requireObject(manifest.openapi, "manifest.openapi");
  const apiBytes = readFileSync(safeFile(sourceSnapshotPath, "docs/openapi.yaml"));
  const parsedYaml = Bun.YAML.parse(apiBytes.toString("utf8"));
  const parsedValue: unknown = JSON.parse(JSON.stringify(parsedYaml) ?? "null");
  const api = requireObject(parsedValue, "pinned OpenAPI document");
  const paths = requireObject(api.paths, "pinned OpenAPI paths");
  if (openapi.pathCount !== Object.keys(paths).length || openapi.operationCount !== requireArray(openapi.operations, "manifest.openapi.operations").length
    || openapi.version !== api.openapi || canonical(openapi.components) !== canonical(api.components ?? {})
    || canonical(openapi.security) !== canonical(api.security ?? [])) throw new Error("OpenAPI snapshot metadata differs from pinned YAML bytes");
  const openapiOperations: AnyRecord[] = [];
  for (const [path, rawPathItem] of Object.entries(paths)) {
    const pathItem = requireObject(rawPathItem, `OpenAPI path ${path}`);
    for (const [name, rawOperation] of Object.entries(pathItem)) {
      const method = name.toUpperCase();
      if (!(METHODS as readonly string[]).includes(method)) continue;
      const operation = requireObject(rawOperation, `OpenAPI ${method} ${path}`);
      openapiOperations.push({
        ...operation,
        method,
        pathParameters: pathItem.parameters === undefined ? [] : requireArray(pathItem.parameters, `${path}.parameters`),
        operationParameters: operation.parameters === undefined ? [] : requireArray(operation.parameters, `${method} ${path}.parameters`),
        path,
      });
    }
  }
  openapiOperations.sort((left, right) => compareText(String(left.method), String(right.method)) || compareText(String(left.path), String(right.path)));
  if (canonical(openapiOperations) !== canonical(openapi.operations)) throw new Error("captured OpenAPI operation inventory differs from pinned YAML bytes");
  const sourceOnly = sourceMethods.filter(source => !openapiOperations.some(spec => spec.method === source.method && pathShape(String(spec.path)) === pathShape(source.path))).length;
  const specificationOnly = openapiOperations.filter(spec => !sourceMethods.some(source => source.method === spec.method && pathShape(source.path) === pathShape(String(spec.path))));
  for (const source of sourceMethods) {
    const shaped = openapiOperations.filter(spec => spec.method === source.method && pathShape(String(spec.path)) === pathShape(source.path));
    if (shaped.length > 1) throw new Error(`ambiguous OpenAPI path match for ${source.method} ${source.path}`);
  }
  const expectedSpecOnly = specificationOnly.map(spec => ({
    method: spec.method,
    path: spec.path,
    operationId: typeof spec.operationId === "string" ? spec.operationId : null,
    reason: "OpenAPI method has no matching exported handler in the pinned source snapshot.",
    sourceAuthority: "handler",
  }));
  const discrepancies = requireObject(manifest.discrepancies, "manifest.discrepancies");
  if (canonical(expectedSpecOnly) !== canonical(discrepancies.specificationOnlyMethods)) throw new Error("OpenAPI-only method discrepancy inventory drift");
  const discrepancyCounts = requireObject(discrepancies.counts, "manifest.discrepancies.counts");
  if (discrepancyCounts["specification-only-method"] !== specificationOnly.length
    || discrepancyCounts["undocumented-source-operation"] !== sourceOnly
    || coverage.sourceOnlyOperations !== sourceOnly
    || coverage.openapiPaths !== openapi.pathCount
    || coverage.openapiOperations !== openapi.operationCount
    || coverage.documentedOperations !== openapi.operationCount - specificationOnly.length
    || coverage.specificationOnlyMethods !== specificationOnly.length) throw new Error("source/OpenAPI discrepancy counts drift");
  return byKey;
}
function verifyDescriptor(operation: AnyRecord, routeByKey: Map<string, AnyRecord>, pin: UpstreamPin, eligibility: Map<string, AnyRecord>): void {
  const id = requireString(operation.operationId, "operation.operationId");
  const method = requireString(operation.method, `${id}.method`);
  const path = requireString(operation.pathTemplate, `${id}.pathTemplate`);
  if (!(METHODS as readonly string[]).includes(method) || id !== `${method} ${path}`) throw new Error(`invalid operation identity: ${id}`);
  const source = requireObject(operation.source, `${id}.source`);
  const sourceFile = requireString(source.file, `${id}.source.file`);
  const route = routeByKey.get(`${method} ${path} ${sourceFile}`);
  if (!route || source.sha256 !== route.sha256 || source.gitBlobSha !== route.gitBlobSha) throw new Error(`operation source drift: ${id}`);
  const coverage = requireObject(operation.coverage, `${id}.coverage`);
  const status = requireString(coverage.status, `${id}.coverage.status`);
  const record = eligibility.get(id);
  const qualification = operation.qualification;
  if (status === "invokable") {
    if (!record || qualification === undefined) throw new Error(`invokable operation lacks baked evidence receipt: ${id}`);
    const qualificationRecord = requireObject(qualification, `${id}.qualification`);
    if (requireString(qualificationRecord.releaseCommit, `${id}.qualification.releaseCommit`) !== pin.commit) throw new Error(`qualification release commit drift: ${id}`);
    const test = requireObject(qualificationRecord.test, `${id}.qualification.test`);
    const eligibilityTest = requireObject(record.test, `${id}.eligibility.test`);
    for (const key of ["id", "caseSha256", "outcomeSha256"]) if (test[key] !== eligibilityTest[key]) throw new Error(`qualification test receipt drift: ${id}`);
    if (Object.prototype.hasOwnProperty.call(test, "observedOutcome")) throw new Error(`private observation path leaked into package contract: ${id}`);
    const auth = requireObject(operation.auth, `${id}.auth`);
    if (auth.domain === "unknown" || operation.sideEffect === "unknown") throw new Error(`invokable operation has unknown source semantics: ${id}`);
  } else if (status === "unqualified") {
    if (record || qualification !== undefined || coverage.adapterId !== null || typeof coverage.reason !== "string") throw new Error(`unqualified operation has eligibility or adapter: ${id}`);
  } else if (status === "non-invokable") {
    if (record || qualification !== undefined || coverage.adapterId !== null) throw new Error(`non-invokable operation has eligibility or adapter: ${id}`);
    const reason = requireString(coverage.reason, `${id}.coverage.reason`);
    if (reason !== route.classificationReason) throw new Error(`non-invokable reason drift: ${id}`);
  } else throw new Error(`unsupported coverage status ${status}: ${id}`);
}
function resolveSchemaPointer(document: unknown, pointer: string, label: string): unknown {
  if (pointer !== "" && !pointer.startsWith("/")) throw new Error(`${label} is not a JSON Pointer`);
  let current: unknown = document;
  for (const token of pointer === "" ? [] : pointer.slice(1).split("/")) {
    if (/~(?![01])/.test(token)) throw new Error(`${label} contains an invalid JSON Pointer escape`);
    const key = token.replace(/~1/g, "/").replace(/~0/g, "~");
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(key) || Number(key) >= current.length) throw new Error(`${label} does not resolve`);
      current = current[Number(key)];
    } else if (typeof current === "object" && current !== null && Object.prototype.hasOwnProperty.call(current, key)) {
      current = (current as AnyRecord)[key];
    } else {
      throw new Error(`${label} does not resolve`);
    }
  }
  return current;
}
export function verifySchemaReferences(documents: Map<string, AnyRecord>): void {
  const visit = (value: unknown, ownerPath: string, label: string, depth = 0): void => {
    if (depth > 64) throw new Error(`${label} exceeds schema reference depth`);
    if (Array.isArray(value)) {
      value.forEach((child, index) => visit(child, ownerPath, `${label}[${index}]`, depth + 1));
      return;
    }
    if (typeof value !== "object" || value === null) return;
    const record = value as AnyRecord;
    if (Object.prototype.hasOwnProperty.call(record, "$ref")) {
      const reference = requireString(record.$ref, `${label}.$ref`);
      const separator = reference.indexOf("#");
      const filePart = separator < 0 ? reference : reference.slice(0, separator);
      const fragment = separator < 0 ? "" : reference.slice(separator + 1);
      const targetPath = filePart === "" ? ownerPath : resolve(dirname(ownerPath), filePart);
      const targetDocument = documents.get(targetPath);
      if (!targetDocument) throw new Error(`${label} uses external or unresolved schema reference ${reference}`);
      let decodedFragment: string;
      try {
        decodedFragment = decodeURIComponent(fragment);
      } catch {
        throw new Error(`${label} has malformed schema reference ${reference}`);
      }
      resolveSchemaPointer(targetDocument, decodedFragment, `${label}.$ref ${reference}`);
    }
    for (const [key, child] of Object.entries(record)) {
      if (["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"].includes(key)) {
        for (const [name, schema] of Object.entries(requireObject(child, `${label}.${key}`))) visit(schema, ownerPath, `${label}.${key}.${name}`, depth + 1);
      } else if (!["$ref", "const", "enum", "default", "examples"].includes(key)) visit(child, ownerPath, `${label}.${key}`, depth + 1);
    }
  };
  for (const [path, document] of documents) visit(document, path, path);
}
function verifySchemaShapes(): void {
  const operationsSchemaPath = resolve(packageRoot, "contracts/operations.schema.json");
  const eligibilitySchemaPath = resolve(packageRoot, "contracts/release-eligibility.schema.json");
  const schema = readJson(operationsSchemaPath);
  const operation = requireObject(requireObject(schema.$defs, "operations schema definitions").operation, "operation schema");
  const properties = requireObject(operation.properties, "operation schema properties");
  if (operation.additionalProperties !== false || !Object.prototype.hasOwnProperty.call(properties, "qualification")) {
    throw new Error("operations schema must be closed and define qualification");
  }
  const eligibilitySchema = readJson(eligibilitySchemaPath);
  verifySchemaReferences(new Map([
    [operationsSchemaPath, schema],
    [eligibilitySchemaPath, eligibilitySchema],
  ]));
  const definitions = requireObject(eligibilitySchema.$defs, "eligibility schema definitions");
  const contract = requireObject(definitions.operationContract, "eligibility operation contract schema");
  const rootProperties = requireObject(eligibilitySchema.properties, "eligibility schema properties");
  if (requireObject(rootProperties.schemaVersion, "eligibility schema version").const !== 2 || contract.additionalProperties !== false) {
    throw new Error("eligibility operation contract schema is not closed/versioned");
  }
  const contractProperties = requireObject(contract.properties, "eligibility operation contract properties");
  const requiredContract = ["request", "auth", "response", "secrets", "sideEffect", "pagination", "streaming", "confirmation", "retry", "reconciliation"].sort(compareText);
  if (canonical([...requireArray(contract.required, "operation contract required")].map(String).sort(compareText)) !== canonical(requiredContract)
    || canonical(Object.keys(contractProperties).sort(compareText)) !== canonical(requiredContract)) {
    throw new Error("eligibility operation contract schema fields drift");
  }
  const qualification = requireObject(definitions.operation, "eligibility operation schema");
  const qualificationProperties = requireObject(qualification.properties, "eligibility operation properties");
  if (requireObject(qualificationProperties.source, "eligibility operation source").$ref !== "#/$defs/source") {
    throw new Error("eligibility operation source must resolve to the closed source receipt schema");
  }
  const testProperties = requireObject(requireObject(qualificationProperties.test, "eligibility test schema").properties, "eligibility test properties");
  if (requireObject(testProperties.observedOutcome, "eligibility observedOutcome schema").pattern
    !== "^provenance/qualification/[a-f0-9]{64}\\.json$") {
    throw new Error("eligibility observed outcome path must use a reviewed content-addressed qualification record");
  }
}
export async function verifyContracts(): Promise<void> {
  const manifest = requireObject(readRouteSources(manifestPath), "route source manifest");
  const operations = readJson(operationsPath);
  const pin = expectedOmniRoutePin();
  const release = requireObject(manifest.release, "manifest.release");
  const operationRelease = requireObject(operations.release, "operations.release");
  for (const [key, value] of Object.entries({ repository: pin.repository, tag: pin.tag, commit: pin.commit })) {
    if (release[key] !== value || operationRelease[key] !== value) throw new Error(`immutable release pin drift: ${key}`);
  }
  if (release.releaseId !== pin.releaseId || release.latestRedirectTarget !== pin.tag || release.selectorKind !== "github-latest-release") throw new Error("release selector evidence drift");
  await verifyArchiveAndSourceRoot(manifest, pin);
  const receipts = verifySourceReceipts(manifest);
  const inputs = requireObject(manifest.inputs, "manifest.inputs");
  for (const key of ["openapi", "package"]) {
    const input = requireObject(inputs[key], `manifest.inputs.${key}`);
    const receipt = receipts.get(requireString(input.path, `manifest.inputs.${key}.path`));
    if (!receipt || input.bytes !== receipt.bytes || input.sha256 !== receipt.sha256 || input.gitBlobSha !== receipt.gitBlobSha) throw new Error(`pinned ${key} input receipt drift`);
  }
  const routeByKey = verifyFrameworkAndRoutes(manifest, receipts);
  verifySchemaShapes();
  const generated = generateContracts();
  if (generated !== readFileSync(operationsPath, "utf8")) throw new Error("operations.json differs from deterministic source/eligibility generation");
  const generatedFrom = requireObject(operations.generatedFrom, "operations.generatedFrom");
  if (generatedFrom.manifestSha256 !== sha256(canonicalJson(readRouteSources(manifestPath)))) throw new Error("operations manifest digest drift");
  const eligibility = readJson(eligibilityPath);
  const eligibilityRecords = new Map(requireArray(eligibility.operations, "eligibility.operations").map(value => {
    const record = requireObject(value, "eligibility record");
    return [requireString(record.operationId, "eligibility.operationId"), record] as const;
  }));
  const operationsList = requireArray(operations.operations, "operations.operations");
  if (operationsList.length === 0) throw new Error("operation inventory is empty");
  const ids = new Set<string>();
  const counts = requireObject(operations.counts, "operations.counts");
  const actualMethodCounts: Record<string, number> = Object.fromEntries(METHODS.map(method => [method, 0]));
  let invokable = 0;
  let unqualified = 0;
  let nonInvokable = 0;
  let documented = 0;
  for (const value of operationsList) {
    const operation = requireObject(value, "operations entry");
    const id = requireString(operation.operationId, "operation.operationId");
    if (ids.has(id)) throw new Error(`duplicate operation ID: ${id}`);
    ids.add(id);
    verifyDescriptor(operation, routeByKey, pin, eligibilityRecords);
    actualMethodCounts[String(operation.method)] = (actualMethodCounts[String(operation.method)] ?? 0) + 1;
    const status = requireString(requireObject(operation.coverage, `${id}.coverage`).status, `${id}.coverage.status`);
    if (status === "invokable") invokable++;
    else if (status === "non-invokable") nonInvokable++;
    else unqualified++;
    if (requireObject(operation.specification, `${id}.specification`).documented === true) documented++;
  }
  const manifestCounts = requireObject(manifest.coverage, "manifest.coverage");
  const expectedCounts: Record<string, number> = {
    routeFiles: requireArray(manifest.routeFiles, "manifest.routeFiles").length,
    sourceOperations: operationsList.length,
    openapiPaths: requireNumber(manifestCounts.openapiPaths, "manifest.coverage.openapiPaths"),
    openapiOperations: requireNumber(manifestCounts.openapiOperations, "manifest.coverage.openapiOperations"),
    documentedOperations: documented,
    unmatchedSpecificationMethods: requireArray(requireObject(manifest.discrepancies, "manifest.discrepancies").specificationOnlyMethods, "specification-only methods").length,
    invokableOperations: invokable,
    nonInvokableOperations: nonInvokable,
    unqualifiedOperations: unqualified,
  };
  for (const [key, expected] of Object.entries(expectedCounts)) if (counts[key] !== expected) throw new Error(`operations count drift: ${key}`);
  if (canonical(actualMethodCounts) !== canonical(counts.methodCounts)) throw new Error("operation method counts drift");
  if (generatedFrom.sourceCorpusFileCount !== requireArray(requireObject(manifest.sourceCorpus, "manifest.sourceCorpus").files, "manifest.sourceCorpus.files").length) throw new Error("generated source corpus receipt count drift");
}
if (import.meta.main) await verifyContracts();
