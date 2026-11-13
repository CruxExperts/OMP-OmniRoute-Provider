import { reviewedOpenApiAnnotation } from "./openapi-annotations.ts";
import { readRouteSources } from "./route-source-store.ts";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { sourceNormalizationBinding, sourceStateViewBinding, sourceRelationViewMatches, sourcePreflightViewMatches, sourceUnpaginatedListProofMatches } from "../src/admin/source-normalization.ts";
import { requiredOmaScope } from "../src/admin/authorization-policy.ts";
import { sourceRequestValidatorBinding } from "../src/admin/source-validation.ts";
import { isSecretOutputField } from "../src/admin/registry.ts";
import { FAMILY_INGRESS_OPERATIONS, operationRequiresIngressEvidence } from "../src/admin/eligibility.ts";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type RecordValue = Record<string, unknown>;
type Method = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";
const METHODS: readonly Method[] = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"];
const MAX_DEPTH = 24;
// Contract documents wrap schemas in response variants and eligibility records.
// Their representation depth differs from runtime data and schema traversal.
const MAX_DOCUMENT_DEPTH = 64;
const SCHEMA_KEYS = new Set([
  "$ref", "additionalProperties", "allOf", "anyOf", "const", "default", "description", "enum", "example", "examples",
  "exclusiveMaximum", "exclusiveMinimum", "format", "items", "maxItems", "maxLength", "maxProperties", "maximum",
  "minItems", "minLength", "minProperties", "minimum", "nullable", "oneOf", "pattern", "properties", "readOnly",
  "required", "title", "type", "writeOnly", "x-key-role",
]);
const SCHEMA_FORMATS = new Set(["binary", "byte", "date-time", "uri", "uuid"]);

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = resolve(packageRoot, "provenance/route-sources.json");
const eligibilityPath = resolve(packageRoot, "contracts/release-eligibility.json");
const outputPath = resolve(packageRoot, "contracts/operations.json");

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortJson(value: Json): Json {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareText(left, right)).map(([key, child]) => [key, sortJson(child)]));
  }
  return value;
}

export function canonicalJson(value: Json): string {
  return JSON.stringify(sortJson(value));
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, label: string): RecordValue {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}

function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}
type TestSourceReceipt = { path: string; bytes: number; sha256: string; gitBlobSha: string };
const TEST_SOURCE_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"] as const;

function importSpecifiers(source: ts.SourceFile): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.add(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const argument = node.arguments[0];
      if (!argument || !ts.isStringLiteral(argument)) throw new Error(`dynamic source import is not evidence-bindable in ${source.fileName}`);
      found.add(argument.text);
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) {
      found.add(node.argument.literal.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort(compareText);
}

function resolveTestModule(specifier: string, fromFile: string): string | undefined {
  let base: string | undefined;
  if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else if (specifier.startsWith("@/")) base = resolve(packageRoot, "src", specifier.slice(2));
  if (!base) return undefined;
  if (base !== packageRoot && !base.startsWith(`${packageRoot}${sep}`)) throw new Error(`test import escapes the package: ${specifier}`);
  const extension = extname(base);
  const candidates = extension
    ? [base, ...TEST_SOURCE_EXTENSIONS.map(candidate => `${base.slice(0, -extension.length)}${candidate}`)]
    : [base, ...TEST_SOURCE_EXTENSIONS.map(candidate => `${base}${candidate}`), ...TEST_SOURCE_EXTENSIONS.filter(candidate => candidate !== ".json").map(candidate => resolve(base!, `index${candidate}`))];
  const found = candidates.find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  if (!found) throw new Error(`unresolved local test import ${specifier} from ${relative(packageRoot, fromFile).split(sep).join("/")}`);
  const absolute = resolve(found);
  if (absolute !== packageRoot && !absolute.startsWith(`${packageRoot}${sep}`)) throw new Error(`test import escapes the package: ${specifier}`);
  return absolute;
}

export function testCaseSourceHash(testId: string): string {
  const entry = resolve(packageRoot, testId);
  const normalized = relative(packageRoot, entry).split(sep).join("/");
  if (normalized !== testId || !testId.startsWith("test/") || !existsSync(entry) || !statSync(entry).isFile()) {
    throw new Error(`test.id must name an existing package-relative test source file: ${testId}`);
  }
  const seen = new Set<string>();
  const parsedSources = new Set<string>();
  const receipts = new Map<string, TestSourceReceipt>();
  const visit = (file: string, followImports = true): void => {
    const absolute = resolve(file);
    if (seen.has(absolute) && (!followImports || parsedSources.has(absolute))) return;
    seen.add(absolute);
    if (followImports) parsedSources.add(absolute);
    const bytes = readFileSync(absolute);
    const path = relative(packageRoot, absolute).split(sep).join("/");
    const gitBlob = createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.byteLength}\0`), bytes])).digest("hex");
    receipts.set(path, {
      path,
      bytes: bytes.byteLength,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      gitBlobSha: gitBlob,
    });
    // Subprocesses and dynamic fixture files are not discoverable from imports.
    const declaration = `${absolute}.inputs.json`;
    if (existsSync(declaration)) {
      const declared: unknown = JSON.parse(readFileSync(declaration, "utf8"));
      if (!isRecord(declared) || declared.schemaVersion !== 1 || Object.keys(declared).sort().join(",") !== "files,schemaVersion"
        || !Array.isArray(declared.files) || declared.files.length === 0 || declared.files.length > 256) {
        throw new Error(`invalid auxiliary evidence declaration for ${path}`);
      }
      visit(declaration);
      const inputs = new Set<string>();
      for (const input of declared.files) {
        if (typeof input !== "string" || input.includes("\\") || input.includes("\0") || input.split("/").some(part => !part || part === "." || part === ".." || part === ".agents" || part === "node_modules" || part === ".git")) {
          throw new Error(`invalid auxiliary evidence path for ${path}`);
        }
        const auxiliary = resolve(packageRoot, input);
        if (relative(packageRoot, auxiliary).split(sep).join("/") !== input || inputs.has(input)
          || !existsSync(auxiliary) || !lstatSync(auxiliary).isFile() || realpathSync(auxiliary) !== auxiliary) {
          throw new Error(`auxiliary evidence input must be a unique repository-contained regular file: ${input}`);
        }
        inputs.add(input);
        visit(auxiliary, false);
      }
    }
    const extension = extname(absolute);
    if (!followImports || extension === ".json" || !TEST_SOURCE_EXTENSIONS.some(candidate => candidate === extension)) return;
    const text = bytes.toString("utf8");
    const kind = absolute.endsWith(".tsx") ? ts.ScriptKind.TSX
      : absolute.endsWith(".jsx") ? ts.ScriptKind.JSX
        : [".js", ".jsx", ".mjs", ".cjs"].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
    const parsed = ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true, kind);
    const diagnostics = ts.transpileModule(text, {
      compilerOptions: { target: ts.ScriptTarget.Latest },
      fileName: absolute,
      reportDiagnostics: true,
    }).diagnostics ?? [];
    const parseError = diagnostics.find(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
    if (parseError) throw new Error(`cannot parse test evidence source ${path}: ${ts.flattenDiagnosticMessageText(parseError.messageText, "\n")}`);
    for (const specifier of importSpecifiers(parsed)) {
      const imported = resolveTestModule(specifier, absolute);
      if (imported) visit(imported);
    }
  };
  visit(entry);
  for (const contextFile of ["package.json", "bun.lock", "bun.lockb"]) {
    const absolute = resolve(packageRoot, contextFile);
    if (existsSync(absolute) && statSync(absolute).isFile()) visit(absolute);
  }
  const ordered = [...receipts.values()].sort((left, right) => compareText(left.path, right.path));
  return sha256(canonicalJson(toJson(ordered, `test source closure ${testId}`)));
}

export function outcomeArtifactPath(operationId: string): string {
  return `.agents/state/omp-provider-release/qualification-observations/${sha256(operationId)}.json`;
}

export function testOutcomeHash(
  operationId: string,
  testId: string,
  caseSha256: string,
  binding: OperationEvidenceBinding,
  reviewedContract: unknown,
  artifactPath: string,
): string {
  const reviewed = requireRecord(reviewedContract, `${operationId}.reviewed contract`);
  assertKeys(reviewed, `${operationId}.reviewed contract`, OPERATION_CONTRACT_FIELDS);
  const secrets = requireRecord(reviewed.secrets, `${operationId}.reviewed contract.secrets`);
  assertKeys(secrets, `${operationId}.reviewed contract.secrets`, ["inputFields", "outputFields"]);
  stringList(secrets.inputFields, `${operationId}.reviewed contract.secrets.inputFields`);
  const outputSecretFields = stringList(secrets.outputFields, `${operationId}.reviewed contract.secrets.outputFields`);
  const reviewedContractJson = toJson(contractFromOperation(reviewed), `${operationId}.reviewed contract`);
  if (sha256(canonicalJson(reviewedContractJson)) !== binding.operationSemanticsSha256) {
    throw new Error(`reviewed contract does not match the operation evidence binding: ${operationId}`);
  }

  const expectedPath = outcomeArtifactPath(operationId);
  const publicMatch = /^provenance\/qualification\/([a-f0-9]{64})\.json$/.exec(artifactPath);
  if (artifactPath !== expectedPath && !publicMatch) throw new Error(`observed outcome artifact path is not bound to ${operationId}`);
  const artifactFile = resolve(packageRoot, artifactPath);
  const info = lstatSync(artifactFile);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024
    || !realpathSync(artifactFile).startsWith(`${realpathSync(packageRoot)}${sep}`)) throw new Error(`invalid observed outcome artifact: ${operationId}`);
  const artifact = requireRecord(JSON.parse(readFileSync(artifactFile, "utf8")) as unknown, `${operationId}.observed outcome artifact`);
  if (publicMatch && sha256(canonicalJson(toJson(artifact, `${operationId}.artifact`))) !== publicMatch[1]) throw new Error(`content-addressed qualification artifact digest mismatch: ${operationId}`);
  const artifactKeys = Object.keys(artifact).sort(compareText);
  const expectedKeys = ["binding", "caseSha256", "observation", "operationId", "testId"].sort(compareText);
  if (canonicalJson(toJson(artifactKeys, `${operationId}.artifact keys`)) !== canonicalJson(toJson(expectedKeys, `${operationId}.expected artifact keys`))
    || artifact.operationId !== operationId || artifact.testId !== testId || artifact.caseSha256 !== caseSha256) {
    throw new Error(`observed outcome artifact identity or case binding mismatch: ${operationId}`);
  }
  const actualBinding = requireRecord(artifact.binding, `${operationId}.observed outcome binding`);
  if (canonicalJson(toJson(actualBinding, `${operationId}.observed outcome binding`)) !== canonicalJson(toJson(binding, `${operationId}.expected outcome binding`))) {
    throw new Error(`observed outcome source/contract binding mismatch: ${operationId}`);
  }
  const observation = requireRecord(artifact.observation, `${operationId}.observation`);
  if (canonicalJson(toJson(Object.keys(observation).sort(compareText), `${operationId}.observation keys`))
    !== canonicalJson(toJson(["after", "before", "result"], `${operationId}.expected observation keys`))) {
    throw new Error(`observed outcome must contain semantic before/after/result fields: ${operationId}`);
  }
  const before = toJson(observation.before, `${operationId}.observation.before`, 0, MAX_DEPTH);
  const after = toJson(observation.after, `${operationId}.observation.after`, 0, MAX_DEPTH);
  const result = requireRecord(observation.result, `${operationId}.observation.result`);
  if (canonicalJson(toJson(Object.keys(result).sort(compareText), `${operationId}.result keys`))
    !== canonicalJson(toJson(["body", "status"], `${operationId}.expected result keys`))
    || typeof result.status !== "number" || !Number.isInteger(result.status) || result.status < 100 || result.status > 599
    || !Object.prototype.hasOwnProperty.call(result, "body")) {
    throw new Error(`observed outcome result must contain an HTTP status and body: ${operationId}`);
  }
  const body = toJson(result.body, `${operationId}.observation.result.body`, 0, MAX_DEPTH);
  const stateSecretPaths = outputSecretFields.filter(field => field.includes("."));
  assertNoSecretFields(before, `${operationId}.observation.before`, [], stateSecretPaths);
  assertNoSecretFields(after, `${operationId}.observation.after`, [], stateSecretPaths);
  assertNoSecretFields(body, `${operationId}.observation.result.body`, [], outputSecretFields);
  if (binding.sideEffect !== "read" && binding.sideEffect !== "unknown" && (before === null || after === null)) {
    throw new Error(`side-effect evidence requires observed before and after state: ${operationId}`);
  }
  const canonicalObservation = toJson({ before, after, result: { status: result.status, body } }, `${operationId}.observation`);
  return sha256(canonicalJson(canonicalObservation));
}

// Cache only the expensive expected derivation, never the observation being validated.
let healthIngressIdentityCache: { key: string; value: RecordValue } | undefined;

function healthIngressDerivationKey(archive: string, version: string, commit: string, program: string): string {
  const declarationPath = "test/pinned-ingress.test.ts.inputs.json";
  const declaration = requireRecord(JSON.parse(readFileSync(resolve(packageRoot, declarationPath), "utf8")) as unknown, "ingress input declaration");
  if (declaration.schemaVersion !== 1) throw new Error("ingress input declaration mismatch");
  const files = stringList(declaration.files, "ingress input declaration files", true);
  const required = ["scripts/pinned-ingress.py", "test/fixtures/pinned-ingress/alias-map.json", "test/fixtures/pinned-ingress/source-manifest.json", "test/fixtures/pinned-ingress/backend/core.ts", "test/fixtures/pinned-ingress/backend/settings.ts", "test/fixtures/pinned-ingress/extracted/degradation-control.ts"];
  if (new Set(files).size !== files.length || required.some(path => !files.includes(path))) throw new Error("ingress derivation inputs are incomplete or duplicated");
  const aliases = requireArray(requireRecord(JSON.parse(readFileSync(resolve(packageRoot, "test/fixtures/pinned-ingress/alias-map.json"), "utf8")) as unknown, "ingress aliases").aliases, "ingress aliases");
  for (const alias of aliases) {
    const replacement = requireString(requireRecord(alias, "ingress alias").replacement, "ingress alias replacement");
    if (!files.includes(`test/fixtures/pinned-ingress/${replacement}`)) throw new Error("ingress alias replacement is not a declared input");
  }
  const digest = createHash("sha256");
  digest.update(JSON.stringify([version, commit, program]));
  for (const path of [archive, declarationPath, "test/pinned-ingress.test.ts", ...files]) {
    const absolute = resolve(packageRoot, path);
    if (path !== archive && (path.includes("\\") || path.split("/").some(part => !part || part === "." || part === ".." || [".git", ".agents", "node_modules"].includes(part))
      || relative(packageRoot, absolute).split(sep).join("/") !== path || !lstatSync(absolute).isFile() || realpathSync(absolute) !== absolute)) {
      throw new Error(`invalid ingress derivation input: ${path}`);
    }
    const bytes = readFileSync(absolute);
    digest.update(JSON.stringify([path, bytes.length, createHash("sha256").update(bytes).digest("hex")]));
  }
  return digest.digest("hex");
}

/** Recompute the runner's verified source and disposable transformation identities. */
export function expectedHealthIngressIdentities(version: string, commit: string): RecordValue {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error("Invalid pinned ingress source identity");
  const archive = resolve(packageRoot, `.agents/state/omp-provider-release/upstream/omniroute-v${version}-${commit}.tar.gz`);
  const program = `import importlib.util, json, pathlib, sys, tempfile
spec = importlib.util.spec_from_file_location('ingress', sys.argv[1])
m = importlib.util.module_from_spec(spec); exec(compile(pathlib.Path(sys.argv[1]).read_bytes(), sys.argv[1], 'exec'), m.__dict__)
m.SOURCE = pathlib.Path(sys.argv[2]); source, effective_identity = m.approved_source(with_identity=True)
manifest = json.loads((m.FIXTURE / 'source-manifest.json').read_bytes())
with tempfile.TemporaryDirectory() as directory:
 app = pathlib.Path(directory)
 for name in m.READ_CLOSURES: m.put(app, name, source[name])
 closures = m.read_closures(app, manifest)
declaration = m.ping_declaration(source['src/lib/db/core.ts'].decode('utf-8'))
overlays = {name: m.sha(data) for name, data in m.overlay_bytes((m.FIXTURE / 'backend/core.ts').read_bytes(), (m.FIXTURE / 'backend/settings.ts').read_bytes(), declaration).items()}
aliases = json.loads((m.FIXTURE / 'alias-map.json').read_bytes())['aliases']
assert len(aliases) == 6 and len({a['source'] for a in aliases}) == 6
mapping = {}
for a in aliases:
 original = m.sha(source[a['source']]); replacement = m.sha((m.FIXTURE / a['replacement']).read_bytes())
 assert (original == a['sourceSha256']) if a['source'] != 'src/lib/db/core.ts' else True
 assert replacement == a['replacementSha256']
 mapping[a['source']] = {'originalSha256': original, 'replacement': a['replacement'], 'executedSha256': overlays.get(a['replacement'], replacement)}
identities = {name: m.sha(source[name]) for name in set(m.ROUTES) | set(m.POLICY_SOURCES) | {'src/lib/db/core.ts', 'src/lib/api/requireManagementAuth.ts', 'src/app/api/health/route.ts', 'src/proxy.ts'}}
for name in ('src/app/api/health/degradation/route.ts', 'src/domain/degradation.ts'):
 data = source[name]; executed = b'import "./fixture-control";\\n' + data if name.endswith('/route.ts') else data
 identities[name] = {'originalSha256': m.sha(data), 'executedSha256': m.sha(executed)}
identities['src/app/livez/route.ts'] = {'originalSha256': m.sha(source['src/app/livez/route.ts']), 'executedSha256': m.sha(source['src/app/livez/route.ts'])}
identities.update({name: {'originalSha256': m.READ_CLOSURES[name], 'executedSha256': m.sha(data)} for name, data in closures.items()})
print(json.dumps({'addedSourceSha256': identities, 'pingDeclarationSha256': m.sha(declaration.encode()), 'sourceOverlaySha256': mapping, 'executedOverlaySha256': overlays, **effective_identity}))`;
  const key = healthIngressDerivationKey(archive, version, commit, program);
  if (healthIngressIdentityCache?.key === key) return structuredClone(healthIngressIdentityCache.value);
  // This generator requires python3 and the prepared pinned archive; fail closed if
  // either is unavailable, or if the derivation cannot complete within its bound.
  const output = execFileSync("python3", ["-c", program, resolve(packageRoot, "scripts/pinned-ingress.py"), archive], { cwd: packageRoot, encoding: "utf8", maxBuffer: 1024 * 1024, timeout: 60_000 });
  if (healthIngressDerivationKey(archive, version, commit, program) !== key) throw new Error("ingress derivation inputs changed during verification");
  const value = requireRecord(JSON.parse(output) as unknown, "expected ingress identities");
  healthIngressIdentityCache = { key, value };
  return structuredClone(value);
}

const FAMILY_POLICY_SOURCES: Readonly<Record<string, string>> = Object.fromEntries(FAMILY_INGRESS_OPERATIONS.map(operationId => [
  operationId, `src/app${operationId.slice(operationId.indexOf(" ") + 1).replace("{id}", "[id]")}/route.ts`,
]));

/** Validate the retained research export separately from the handler receipt. */
export function validateHealthIngressEvidence(value: unknown, binding: OperationEvidenceBinding, operationId: string = "GET /api/health"): void {
  const label = `${operationId} ingress evidence`;
  const evidence = requireRecord(value, label);
  assertKeys(evidence, label, ["artifact", "sha256"]);
  const path = requireString(evidence.artifact, `${label}.artifact`);
  if (!/^provenance\/qualification\/ingress-[a-f0-9]{64}\.json$/.test(path)
    && path !== ".agents/state/omp-provider-release/qualification-observations/health-ingress.json") {
    throw new Error(`${label} artifact path is invalid`);
  }
  const file = resolve(packageRoot, path);
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 2 * 1024 * 1024
    || !realpathSync(file).startsWith(`${realpathSync(packageRoot)}${sep}`)) throw new Error(`${label} artifact is invalid`);
  const bytes = readFileSync(file);
  const digest = createHash("sha256").update(bytes).digest("hex");
  if (evidence.sha256 !== digest || (path.startsWith("provenance/") && path !== `provenance/qualification/ingress-${digest}.json`)) {
    throw new Error(`${label} artifact digest mismatch`);
  }
  const artifact = requireRecord(JSON.parse(bytes.toString("utf8")) as unknown, label);
  if (artifact.schemaVersion !== 1 || artifact.classification !== "research-only-not-qualification") throw new Error(`${label} classification mismatch`);
  const source = requireRecord(artifact.source, `${label}.source`);
  const manifest = requireRecord(JSON.parse(readFileSync(resolve(packageRoot, "test/fixtures/pinned-ingress/source-manifest.json"), "utf8")) as unknown, `${label}.manifest`);
  const release = requireRecord(requireRecord(readRouteSources(manifestPath), "route source manifest").release, "manifest.release");
  const added = requireRecord(source.addedSourceSha256, `${label}.source.addedSourceSha256`);
  const degradationSource = requireRecord(added["src/app/api/health/degradation/route.ts"], `${label}.degradation source`);
  const livenessSource = (operationId === "GET /livez" || operationId === "HEAD /livez") ? requireRecord(added["src/app/livez/route.ts"], `${label}.liveness source`) : undefined;
  if (source.commit !== release.commit || source.commit !== manifest.commit || `v${String(source.version)}` !== release.tag
    || source.archiveSha256 !== manifest.archiveSha256 || (livenessSource !== undefined ? livenessSource.originalSha256 : operationId === "GET /api/health" ? added["src/app/api/health/route.ts"] : operationId === "GET /api/agent-skills" ? added["src/app/api/agent-skills/route.ts"] : operationId === "GET /api/agent-skills/{id}" ? added["src/app/api/agent-skills/[id]/route.ts"] : operationId === "GET /api/agent-skills/coverage" ? added["src/app/api/agent-skills/coverage/route.ts"] : operationId.includes("/api/model-combo-mappings") ? added[operationId.endsWith("{id}") ? "src/app/api/model-combo-mappings/[id]/route.ts" : "src/app/api/model-combo-mappings/route.ts"] : Object.hasOwn(FAMILY_POLICY_SOURCES, operationId) ? added[FAMILY_POLICY_SOURCES[operationId]!] : degradationSource.originalSha256) !== binding.handlerSha256
    || (livenessSource !== undefined && livenessSource.executedSha256 !== binding.handlerSha256)) {
    throw new Error(`${label} source mismatch`);
  }
  const inputs = requireRecord(artifact.inputs, `${label}.inputs`);
  const hashes = requireRecord(inputs.sha256, `${label}.inputs.sha256`);
  const declarationPath = "test/pinned-ingress.test.ts.inputs.json";
  const declaration = requireRecord(JSON.parse(readFileSync(resolve(packageRoot, declarationPath), "utf8")) as unknown, `${label}.declaration`);
  if (declaration.schemaVersion !== 1) throw new Error(`${label} declaration mismatch`);
  const declared = stringList(declaration.files, `${label}.declaration.files`, true);
  const paths = ["test/pinned-ingress.test.ts", declarationPath, ...declared];
  if (new Set(paths).size !== paths.length || Object.keys(hashes).sort(compareText).join("\n") !== [...paths].sort(compareText).join("\n")) {
    throw new Error(`${label} declared inputs mismatch`);
  }
  for (const input of paths) {
    const absolute = resolve(packageRoot, input);
    if (input.includes("\\") || input.split("/").some(part => !part || part === "." || part === ".." || [".git", ".agents", "node_modules"].includes(part))
      || relative(packageRoot, absolute).split(sep).join("/") !== input || !lstatSync(absolute).isFile() || realpathSync(absolute) !== absolute
      || hashes[input] !== createHash("sha256").update(readFileSync(absolute)).digest("hex")) {
      throw new Error(`${label} input drift: ${input}`);
    }
  }
  const runtime = requireRecord(JSON.parse(readFileSync(resolve(packageRoot, "test/fixtures/pinned-ingress/runtime.json"), "utf8")) as unknown, `${label}.runtime`);
  const actualRuntime = requireRecord(inputs.runtime, `${label}.inputs.runtime`);
  if (inputs.nodeSha256 !== runtime.nodeSha256 || actualRuntime.node !== runtime.nodeVersion
    || actualRuntime.next !== "16.4.2" || actualRuntime.react !== "19.2.8" || actualRuntime["react-dom"] !== "19.2.8") {
    throw new Error(`${label} runtime mismatch`);
  }
  const isolation = requireRecord(artifact.isolation, `${label}.isolation`);
  if (["namespacesDistinct", "memoryLimitEnforced", "cpuLimitEnforced", "privateLoopbackOnly", "environmentAllowlisted"].some(key => isolation[key] !== true)) {
    throw new Error(`${label} isolation mismatch`);
  }
  const healthRows = requireArray(artifact.health, `${label}.health`).filter(row => isRecord(row) && row.method === "GET" && row.path === "/api/health");
  if (healthRows.length !== 1) throw new Error(`${label} health observation missing or duplicated`);
  const health = requireRecord(healthRows[0], `${label}.health`);
  if (health.status !== 200 || canonicalJson(toJson(health.bodyKeys, label)) !== '["status","timestamp"]'
    || typeof health.timestamp !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(health.timestamp)
    || typeof health.cacheControl !== "string" || !health.cacheControl.split(",").some(part => part.trim() === "no-store")) {
    throw new Error(`${label} health observation mismatch`);
  }
  const publicHealth = requireRecord(artifact.publicHealthHttp, `${label}.publicHealthHttp`);
  const expected = { method: "GET", path: "/api/health", anonymous: true, status: 200, bodyKeys: ["status", "timestamp"], timestampFormatAndRequestWindowValid: true, cacheControl: "no-store, no-cache, must-revalidate", contentType: "application/json", routeClass: "PUBLIC", requestIdUuid: true, drain: { status: 503, code: "SERVICE_UNAVAILABLE", message: "Server is shutting down", requestIdUuid: true, correlationMatchesRequestId: true, retryAfter: "5", contentType: "application/json", routeClass: "PUBLIC", recoveryStatus: 200 }, cors: { configuredAllowedOrigin: "https://allowed.example", allowedOriginEchoed: true, unlistedOriginOmitted: true, credentialsOmitted: true } };
  if (canonicalJson(toJson(publicHealth, label)) !== canonicalJson(toJson(expected, label))) throw new Error(`${label} public HTTP observation mismatch`);
  const authentication = requireArray(artifact.sharedAuthentication, `${label}.sharedAuthentication`);
  for (const [name, bypass] of [["default-bypass-health", "source-default"], ["disabled-bypass-health", "disabled"]] as const) {
    const rows = authentication.filter(row => isRecord(row) && (row.name === name || (isRecord(row.input) && row.input.path === "/api/health" && row.input.bypass === bypass)));
    const expectedCase = { name, input: { method: "GET", path: "/api/health", bypass, credential: "none", requireLogin: true, setupComplete: true }, observed: { status: 200, routeClass: "PUBLIC", successMarkerPresent: true, usageStampObserved: false } };
    if (rows.length !== 1 || canonicalJson(toJson(rows[0], label)) !== canonicalJson(toJson(expectedCase, label))) throw new Error(`${label} authentication observation mismatch: ${name}`);
  }
  if (authentication.some(row => isRecord(row) && isRecord(row.input) && row.input.path === "/api/health" && row.name !== "default-bypass-health" && row.name !== "disabled-bypass-health")) throw new Error(`${label} unexpected health authentication observation`);
  const ipFilter = { enabled: true, mode: "blacklist", configReadObserved: true, forwardedAddressFallback: { deniedStatus: 403, error: "IP blacklisted", recoveryStatus: 200, routeClass: "PUBLIC", requestIdUuid: true, allowedOriginEchoed: true } };
  if (canonicalJson(toJson(artifact.publicHealthIpFilter, label)) !== canonicalJson(toJson(ipFilter, label))) throw new Error(`${label} IP filter observation mismatch`);
  if (operationId === "GET /livez") {
    const response = { status: 200, body: "ok\n", contentType: "text/plain; charset=utf-8", cacheControl: "no-store", contentLength: "3", routeClass: null };
    const expectedLiveness = { method: "GET", path: "/livez", matcher: "not-matched", proxyIdentity: { originalSha256: added["src/proxy.ts"], executedSha256: added["src/proxy.ts"] }, cases: { anonymous: response, invalidCredential: response, session: response } };
    if (!isRecord(artifact.publicLivenessHttp) || canonicalJson(toJson(artifact.publicLivenessHttp, label)) !== canonicalJson(toJson(expectedLiveness, label))) throw new Error(`${label} liveness observation mismatch`);
  }
  if (operationId === "HEAD /livez") {
    const response = { status: 200, body: "", contentType: "text/plain; charset=utf-8", cacheControl: "no-store", contentLength: "3", routeClass: null };
    const expectedLiveness = { method: "HEAD", path: "/livez", matcher: "not-matched", proxyIdentity: { originalSha256: added["src/proxy.ts"], executedSha256: added["src/proxy.ts"] }, cases: { anonymous: response, invalidCredential: response, session: response } };
    if (!isRecord(artifact.publicLivenessHeadHttp) || canonicalJson(toJson(artifact.publicLivenessHeadHttp, label)) !== canonicalJson(toJson(expectedLiveness, label))) throw new Error(`${label} liveness HEAD observation mismatch`);
  }
  if (operationId === "GET /api/health/degradation") {
    const expectedDegradation = { method: "GET", path: "/api/health/degradation", routeClass: "MANAGEMENT", anonymousStatus: 401, invalidCredentialStatus: 401, empty: { status: 200, summary: { full: 0, reduced: 0, minimal: 0, default: 0 } }, populated: { status: 200, summary: { full: 1, reduced: 1, minimal: 0, default: 1 }, levels: ["default", "reduced", "full"] }, summaryTrue: { status: 200, bodyKeys: ["isDegraded", "summary"] }, summaryFalseAndCapitalTrueReturnFullReport: true, recovery: { status: 200, summary: { full: 3, reduced: 0, minimal: 0, default: 0 }, active: false }, handlerFailure: "unobserved" };
    if (canonicalJson(toJson(artifact.degradation, label)) !== canonicalJson(toJson(expectedDegradation, label))) throw new Error(`${label} degradation observation mismatch`);
  }
  if (operationId === "GET /api/agent-skills") {
    const expectedSkills = { method: "GET", path: "/api/agent-skills", routeClass: "MANAGEMENT", anonymousStatus: 401, invalidCredentialStatus: 401, query: "category=config&area=config-codex-cli", authorizedStatus: 200, ids: ["config-codex-cli"] };
    if (canonicalJson(toJson(artifact.agentSkills, label)) !== canonicalJson(toJson(expectedSkills, label))) throw new Error(`${label} agent-skills observation mismatch`);
  }
  if (operationId === "GET /api/agent-skills/{id}" || operationId === "GET /api/agent-skills/coverage") {
    const path = operationId.endsWith("{id}") ? "/api/agent-skills/config-codex-cli" : "/api/agent-skills/coverage";
    const rows = requireArray(artifact.agentSkillsReads, `${label}.agentSkillsReads`).filter(row => isRecord(row) && row.method === "GET" && row.path === path);
    const expectedRead = { method: "GET", path, routeClass: "MANAGEMENT", anonymousStatus: 401, invalidCredentialStatus: 401, authorizedStatus: 200 };
    if (rows.length !== 1 || canonicalJson(toJson(rows[0], label)) !== canonicalJson(toJson(expectedRead, label))) throw new Error(`${label} agent-skills read observation mismatch`);
  }
  if (/^(GET|POST|PUT|DELETE) \/api\/model-combo-mappings(?:\/\{id\})?$/.test(operationId)) {
    const [method, template] = operationId.split(" ");
    const path = template!.replace("{id}", "fixture-id");
    const rows = requireArray(artifact.modelComboMappingPolicy, `${label}.modelComboMappingPolicy`).filter(row => isRecord(row) && row.method === method && row.path === path);
    const expectedPolicy = { method, path, routeClass: "MANAGEMENT", anonymousStatus: 401, invalidCredentialStatus: 401, authorizedStatus: 200 };
    if (rows.length !== 1 || canonicalJson(toJson(rows[0], label)) !== canonicalJson(toJson(expectedPolicy, label))) throw new Error(`${label} mapping policy observation mismatch`);
  }
  if (Object.hasOwn(FAMILY_POLICY_SOURCES, operationId)) {
    const [method, template] = operationId.split(" ");
    const path = template!.replace("{id}", "fixture-id");
    const rows = requireArray(artifact.familyPolicy, `${label}.familyPolicy`).filter(row => isRecord(row) && row.method === method && row.path === path);
    const mutation = method !== "GET";
    const adminRequired = mutation && (path === "/api/providers" || path.startsWith("/api/providers/"));
    const expectedPolicy = { method, path, routeClass: "MANAGEMENT", anonymousStatus: 401, invalidCredentialStatus: 401, authorizedStatus: 200, readScopeStatus: mutation ? 403 : 200, writeScopeStatus: adminRequired ? 403 : 200, adminScopeStatus: 200 };
    if (rows.length !== 1 || canonicalJson(toJson(rows[0], label)) !== canonicalJson(toJson(expectedPolicy, label))) throw new Error(`${label} family policy observation mismatch`);
  }
  const expectedIdentities = expectedHealthIngressIdentities(String(source.version), String(source.commit));
  const sourceIdentityHashFields = ["addedSourceSha256", "pingDeclarationSha256"] as const;
  for (const key of ["sourceDerivation", "effectiveTreeSha256"] as const) {
    if (canonicalJson(toJson(source[key] ?? null, label)) !== canonicalJson(toJson(expectedIdentities[key] ?? null, label))) throw new Error(`${label} effective source identity mismatch: ${key}`);
  }
  if (canonicalJson(toJson(source.sourceDerivation ?? null, label)) !== canonicalJson(toJson(binding.sourceDerivation ?? null, label))
    || (binding.sourceDerivation !== undefined && source.effectiveTreeSha256 !== binding.effectiveTreeSha256)) throw new Error(`${label} effective operation binding mismatch`);
  for (const key of sourceIdentityHashFields) {
    if (canonicalJson(toJson(source[key], label)) !== canonicalJson(toJson(expectedIdentities[key], label))) throw new Error(`${label} source identity mismatch: ${key}`);
  }
  const overlayIdentityHashFields = ["sourceOverlaySha256", "executedOverlaySha256"] as const;
  for (const key of overlayIdentityHashFields) {
    if (canonicalJson(toJson(inputs[key], label)) !== canonicalJson(toJson(expectedIdentities[key], label))) throw new Error(`${label} overlay identity mismatch: ${key}`);
  }
}

// Only expected producer results are cached; artifacts are always read and validated anew.
const coreLifecycleIdentityCache = new Map<string, unknown>();

/** Join a research-only cold/warm observation to independently rerun producer identities. */
export function validateCoreLifecycleEvidence(value: unknown, binding: Pick<OperationEvidenceBinding, "sourceDerivation" | "effectiveTreeSha256">): void {
  const label = "core lifecycle evidence";
  const evidence = requireRecord(value, label);
  assertKeys(evidence, label, ["artifact", "sha256"]);
  const path = requireString(evidence.artifact, `${label}.artifact`);
  if (!/^[a-f0-9]{64}$/.test(String(evidence.sha256)) || path !== `provenance/qualification/core-lifecycle-${String(evidence.sha256)}.json`) throw new Error(`${label} path mismatch`);
  const file = resolve(packageRoot, path);
  const info = lstatSync(file);
  if (!info.isFile() || info.nlink !== 1 || realpathSync(file) !== file || info.size > 2 * 1024 * 1024) throw new Error(`${label} artifact is not a regular unlinked file`);
  const bytes = readFileSync(file);
  if (createHash("sha256").update(bytes).digest("hex") !== evidence.sha256) throw new Error(`${label} digest mismatch`);
  const artifact = requireRecord(JSON.parse(bytes.toString("utf8")) as unknown, label);
  const names = ["PINNED_INGRESS_ARCHIVE", "PINNED_INGRESS_NODE", "PINNED_INGRESS_DEPENDENCIES", "PINNED_INGRESS_BWRAP"] as const;
  const paths = names.map(name => {
    const path = process.env[name];
    if (!path || !path.startsWith("/")) throw new Error(`${label} requires absolute ${name}`);
    return path;
  });
  const program = `import json, pathlib, sys
ns = {'__name__': 'pinned_ingress_expected', '__file__': sys.argv[1]}
exec(compile(pathlib.Path(sys.argv[1]).read_bytes(), sys.argv[1], 'exec'), ns)
name = sys.argv[2]
print(json.dumps(ns[name](*(pathlib.Path(p) for p in sys.argv[3:]))))`;
  const invoke = (name: string): unknown => JSON.parse(execFileSync("python3", ["-c", program, resolve(packageRoot, "scripts/pinned-ingress.py"), name, ...paths], { cwd: packageRoot, encoding: "utf8", maxBuffer: 2 * 1024 * 1024, timeout: 900_000 })) as unknown;
  const inputKey = (): string => {
    const key = invoke("expected_core_lifecycle_input_key");
    if (typeof key !== "string" || !/^[a-f0-9]{64}$/.test(key)) throw new Error(`${label} invalid producer input key`);
    return sha256(JSON.stringify([key, paths, program]));
  };
  const key = inputKey();
  let expected = coreLifecycleIdentityCache.get(key);
  if (expected === undefined) {
    expected = invoke("expected_core_lifecycle_identities");
    if (inputKey() !== key) throw new Error(`${label} producer inputs changed during verification`);
    coreLifecycleIdentityCache.set(key, expected);
  }
  validateCoreLifecycleObservation(artifact, binding, expected);
}

/** Validate observations against an independently computed identity. */
export function validateCoreLifecycleObservation(value: unknown, binding: Pick<OperationEvidenceBinding, "sourceDerivation" | "effectiveTreeSha256">, independentValue: unknown): void {
  const label = "core lifecycle evidence";
  const artifact = requireRecord(value, label);
  assertKeys(artifact, label, ["status", "qualification", "boundary", "inputSha256", "identity", "isolation", "cold", "warm"]);
  if (artifact.status !== "research-observed" || artifact.qualification !== false || artifact.boundary !== "Direct pinned core and settings in two isolated Node processes; no HTTP, authorization, packaged application or operation qualification.") throw new Error(`${label} classification mismatch`);
  const identity = requireRecord(artifact.identity, `${label}.identity`);
  if (!binding.sourceDerivation || !binding.effectiveTreeSha256
    || canonicalJson(toJson(identity.sourceDerivation, label)) !== canonicalJson(toJson(binding.sourceDerivation, label))
    || identity.effectiveTreeSha256 !== binding.effectiveTreeSha256) throw new Error(`${label} effective source mismatch`);
  if (canonicalJson(toJson(identity.runnerArguments, label)) !== canonicalJson(["/runtime/node", "--import", "tsx/esm", "/work/app/src/lib/db/pinnedLifecycleFixture.mjs"])
    || typeof identity.runnerSourceSha256 !== "string" || !/^[a-f0-9]{64}$/.test(identity.runnerSourceSha256)
    || Object.hasOwn(identity, "runnerOutputSha256")) throw new Error(`${label} runner identity mismatch`);
  const isolation = { network: "private-loopback-only", capabilities: "dropped", source: "read-only", processes: "separate-cold-warm", startupRegressions: "passed" };
  if (canonicalJson(toJson(artifact.isolation, label)) !== canonicalJson(toJson(isolation, label))) throw new Error(`${label} isolation mismatch`);
  const expected = requireRecord(independentValue, `${label}.expected`);
  for (const key of ["identity", "inputSha256", "isolation"] as const) {
    if (canonicalJson(toJson(artifact[key], label)) !== canonicalJson(toJson(expected[key], label))) throw new Error(`${label} ${key} mismatch`);
  }
  const phases: RecordValue[] = [];
  for (const phase of ["cold", "warm"] as const) {
    const actual = requireRecord(artifact[phase], `${label}.${phase}`);
    const independent = requireRecord(expected[phase], `${label}.expected.${phase}`);
    assertKeys(actual, `${label}.${phase}`, ["phase", "driver", "ping", "healthWorker", "healthy", "settingsPersisted", "databaseExistedBefore", "runtimeSettingApplied", "hotReloadFailure", "tableCount", "migrationCount", "tableSha256", "migrationSha256"]);
    if (actual.phase !== phase || actual.driver !== "node:sqlite" || actual.ping !== true || actual.healthWorker !== true
      || typeof actual.healthy !== "boolean" || actual.settingsPersisted !== true || actual.databaseExistedBefore !== (phase === "warm") || actual.runtimeSettingApplied !== (phase === "cold") || actual.hotReloadFailure !== false
      || !Number.isSafeInteger(actual.tableCount) || Number(actual.tableCount) <= 0 || !Number.isSafeInteger(actual.migrationCount) || Number(actual.migrationCount) <= 0
      || !/^[a-f0-9]{64}$/.test(String(actual.tableSha256)) || !/^[a-f0-9]{64}$/.test(String(actual.migrationSha256))) throw new Error(`${label} ${phase} observation mismatch`);
    const { healthy: _healthy, ...actualStable } = actual;
    const { healthy: _expectedHealthy, ...expectedStable } = independent;
    if (canonicalJson(toJson(actualStable, label)) !== canonicalJson(toJson(expectedStable, label))) throw new Error(`${label} ${phase} independent observation mismatch`);
    phases.push(actual);
  }
  if (phases[0]!.tableSha256 !== phases[1]!.tableSha256 || phases[0]!.migrationSha256 !== phases[1]!.migrationSha256
    || phases[0]!.tableCount !== phases[1]!.tableCount || phases[0]!.migrationCount !== phases[1]!.migrationCount) throw new Error(`${label} cold/warm state mismatch`);
}

function assertNoSecretFields(value: Json, label: string, parentPath: readonly string[] = [], explicitSecretPaths: readonly string[] = []): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => assertNoSecretFields(child, `${label}[${index}]`, parentPath, explicitSecretPaths));
  } else if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (isSecretOutputField(key, child, parentPath, explicitSecretPaths)) {
        throw new Error(`${label} contains a secret-bearing field name`);
      }
      assertNoSecretFields(child, `${label}.${key}`, [...parentPath, key], explicitSecretPaths);
    }
  }
}


function toJson(value: unknown, label: string, depth = 0, maxDepth = MAX_DOCUMENT_DEPTH): Json {
  if (depth > maxDepth) throw new Error(`${label} exceeds JSON depth ${maxDepth}`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return value.map((item, index) => toJson(item, `${label}[${index}]`, depth + 1, maxDepth));
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, toJson(child, `${label}.${key}`, depth + 1, maxDepth)]));
  }
  throw new Error(`${label} contains a non-JSON value`);
}

/** Convert Next route folders to the exact declared path shape, preserving catch-all segments. */
export function normalizeNextRoutePath(sourceFile: string): string {
  const relative = sourceFile.replace(/^src\/app\//, "").replace(/\/route\.ts$/, "");
  const parts: string[] = [];
  for (const part of relative.split("/")) {
    if (part.startsWith("(") && part.endsWith(")")) continue;
    if (part.startsWith("@")) continue;
    if (part.startsWith("[[...") && part.endsWith("]]")) parts.push(`*${part.slice(5, -2)}`);
    else if (part.startsWith("[...") && part.endsWith("]")) parts.push(`*${part.slice(4, -1)}`);
    else if (part.startsWith("[") && part.endsWith("]")) parts.push(`{${part.slice(1, -1)}}`);
    else parts.push(part);
  }
  return `/${parts.filter(Boolean).join("/")}`;
}


function resolvePointer(root: unknown, ref: string): unknown {
  if (!ref.startsWith("#/") || /(?:^|\/)\.\.(?:\/|$)/.test(ref)) throw new Error(`external or unsafe OpenAPI reference ${ref}`);
  let current = root;
  for (const segment of ref.slice(2).split("/").map(part => part.replace(/~1/g, "/").replace(/~0/g, "~"))) {
    if (!isRecord(current) || !Object.prototype.hasOwnProperty.call(current, segment)) throw new Error(`unresolved local OpenAPI reference ${ref}`);
    current = current[segment];
  }
  return current;
}

function resolveReferences(value: unknown, root: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) throw new Error(`OpenAPI reference expansion exceeds depth ${MAX_DEPTH}`);
  if (Array.isArray(value)) return value.map(item => resolveReferences(item, root, depth + 1));
  if (!isRecord(value)) return value;
  const ref = value.$ref;
  if (ref !== undefined) {
    if (typeof ref !== "string") throw new Error("OpenAPI $ref must be a string");
    const target = requireRecord(resolvePointer(root, ref), `OpenAPI reference ${ref}`);
    return resolveReferences({ ...target, ...Object.fromEntries(Object.entries(value).filter(([key]) => key !== "$ref")) }, root, depth + 1);
  }
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, resolveReferences(child, root, depth + 1)]));
}

function convertSchema(value: unknown, label: string, depth = 0): Json {
  if (depth > MAX_DEPTH) throw new Error(`${label} exceeds schema depth ${MAX_DEPTH}`);
  let schema = requireRecord(value, label);
  if (label === "GET /api/system/version.responses.200.application/json.schema.properties.news") {
    const manifest = requireRecord(readRouteSources(manifestPath), "route manifest");
    const release = requireRecord(manifest.release, "manifest.release");
    const source = requireRecord(requireRecord(manifest.inputs, "manifest.inputs").openapi, "manifest.inputs.openapi");
    schema = requireRecord(reviewedOpenApiAnnotation(schema, label, { commit: String(release.commit), sha256: String(source.sha256) }), label);
  }
  for (const key of Object.keys(schema)) {
    if (!SCHEMA_KEYS.has(key)) throw new Error(`unsupported OpenAPI schema keyword ${key} at ${label}`);
  }
  if (schema.$ref !== undefined) throw new Error(`unresolved OpenAPI schema reference at ${label}`);
  if (schema["x-key-role"] !== undefined
    && (schema["x-key-role"] !== "identifier" || schema.type !== "object" || !isRecord(schema.additionalProperties))) {
    throw new Error(`${label}.x-key-role requires an explicitly typed identifier map`);
  }
  const output: Record<string, Json> = {};
  for (const [key, child] of Object.entries(schema)) {
    if (key === "nullable") {
      if (typeof child !== "boolean") throw new Error(`${label}.nullable must be boolean`);
    } else if (key === "properties") {
      const properties = requireRecord(child, `${label}.properties`);
      output.properties = Object.fromEntries(Object.entries(properties).map(([name, childSchema]) => [name, convertSchema(childSchema, `${label}.properties.${name}`, depth + 1)]));
    } else if (key === "items" || key === "additionalProperties") {
      if (key === "additionalProperties" && typeof child === "boolean") output[key] = child;
      else output[key] = convertSchema(child, `${label}.${key}`, depth + 1);
    } else if (key === "oneOf" || key === "anyOf" || key === "allOf") {
      const alternatives = requireArray(child, `${label}.${key}`);
      if (alternatives.length === 0) throw new Error(`${label}.${key} cannot be empty`);
      output[key] = alternatives.map((candidate, index) => convertSchema(candidate, `${label}.${key}[${index}]`, depth + 1));
    } else if (key === "required") {
      const required = requireArray(child, `${label}.required`);
      if (required.some(item => typeof item !== "string")) throw new Error(`${label}.required must contain only strings`);
      if (new Set(required).size !== required.length) throw new Error(`${label}.required contains duplicates`);
      output.required = [...required] as string[];
    } else if (key === "type") {
      const types = Array.isArray(child) ? child : [child];
      if (types.some(type => typeof type !== "string" || !["array", "boolean", "integer", "null", "number", "object", "string"].includes(type))) {
        throw new Error(`${label}.type contains an unsupported JSON Schema type`);
      }
      output.type = Array.isArray(child) ? [...types] as string[] : child as string;
    } else if (key === "format") {
      if (typeof child !== "string" || !SCHEMA_FORMATS.has(child)) throw new Error(`${label}.format uses unsupported serialization ${String(child)}`);
      output.format = child;
    } else if (key === "pattern") {
      if (typeof child !== "string") throw new Error(`${label}.pattern must be a string`);
      try { new RegExp(child); } catch { throw new Error(`${label}.pattern is invalid`); }
      output.pattern = child;
    } else if (key === "exclusiveMinimum" || key === "exclusiveMaximum") {
      if (typeof child === "boolean") {
        if (child) {
          const boundKey = key === "exclusiveMinimum" ? "minimum" : "maximum";
          const bound = schema[boundKey];
          if (typeof bound !== "number" || !Number.isFinite(bound)) throw new Error(`${label}.${key} requires a numeric ${boundKey}`);
          output[key] = bound;
        }
      } else if (typeof child === "number" && Number.isFinite(child)) {
        output[key] = child;
      } else {
        throw new Error(`${label}.${key} must be boolean or finite number`);
      }
    } else if (key !== "nullable") {
      output[key] = toJson(child, `${label}.${key}`, depth + 1);
    }
  }
  if (schema.exclusiveMinimum === true) delete output.minimum;
  if (schema.exclusiveMaximum === true) delete output.maximum;
  if (schema.nullable === true) {
    const rawType = output.type;
    // OpenAPI 3.0 nullable only adds null when a type is explicitly declared.
    if (rawType !== undefined) {
      const types = Array.isArray(rawType) ? rawType : [rawType];
      output.type = types.includes("null") ? types : [...types, "null"];
    }
  }
  if (output.type === "array" && output.items === undefined) throw new Error(`${label} is an array without an item schema`);
  if (Array.isArray(output.type) && output.type.includes("array") && output.items === undefined) throw new Error(`${label} is a nullable array without an item schema`);
  return output;
}


function normalizedParameter(value: unknown, root: unknown, label: string): RecordValue {
  const parameter = requireRecord(resolveReferences(value, root), label);
  if (parameter.content !== undefined) throw new Error(`${label} uses content-based parameter serialization; an operation-specific codec is required`);
  const name = requireString(parameter.name, `${label}.name`);
  const location = requireString(parameter.in, `${label}.in`);
  if (!["cookie", "header", "path", "query"].includes(location)) throw new Error(`${label}.in is unsupported`);

  if (parameter.schema === undefined) throw new Error(`${label} has no schema`);
  const defaultStyle = location === "query" || location === "cookie" ? "form" : "simple";
  const style = parameter.style === undefined ? defaultStyle : requireString(parameter.style, `${label}.style`);
  const supportedStyles: Record<string, readonly string[]> = {
    path: ["simple", "label", "matrix"], query: ["form", "spaceDelimited", "pipeDelimited", "deepObject"],
    header: ["simple"], cookie: ["form"],
  };
  if (!supportedStyles[location]!.includes(style)) throw new Error(`${label} uses unsupported ${location} style ${style}`);
  if (parameter.explode !== undefined && typeof parameter.explode !== "boolean") throw new Error(`${label}.explode must be boolean`);
  if (parameter.allowReserved !== undefined && typeof parameter.allowReserved !== "boolean") throw new Error(`${label}.allowReserved must be boolean`);
  if (parameter.required !== undefined && typeof parameter.required !== "boolean") throw new Error(`${label}.required must be boolean`);
  const schema = convertSchema(parameter.schema, `${label}.schema`);
  return {
    name,
    in: location,
    required: location === "path" ? true : parameter.required === true,
    style,
    explode: parameter.explode === undefined ? style === "form" : parameter.explode,
    allowReserved: parameter.allowReserved === true,
    schema,
    inputAllowed: location === "path" || location === "query",
  };
}

function mergedParameters(spec: RecordValue, root: RecordValue, operationId: string): RecordValue[] {
  const values = new Map<string, RecordValue>();
  for (const [field, label] of [["pathParameters", "path-level"], ["operationParameters", "operation-level"]] as const) {
    for (const [index, value] of requireArray(spec[field], `${operationId}.${field}`).entries()) {
      const parameter = normalizedParameter(value, root, `${operationId} ${label} parameter ${index}`);
      values.set(`${parameter.in}:${parameter.name}`, parameter);
    }
  }
  return [...values.values()];
}
function sourceQueryParameterHints(route: RecordValue, method: Method, operationId: string): RecordValue[] {
  if (operationId !== "GET /api/providers") return [];
  const sourceFile = requireString(route.sourceFile, `${operationId}.sourceFile`);
  if (method !== "GET" || sourceFile !== "src/app/api/providers/route.ts") {
    throw new Error(`source query hint route drift: ${operationId}`);
  }
  const parameter = (name: string, schema: Json): RecordValue => ({
    name,
    in: "query",
    required: false,
    style: "form",
    explode: true,
    allowReserved: false,
    schema,
    inputAllowed: true,
    sourceFile,
  });
  return [
    parameter("provider", { type: "string" }),
    parameter("limit", { type: "integer", minimum: 1 }),
    parameter("offset", { type: "integer", minimum: 0 }),
  ];
}

function sourcePathParameters(route: RecordValue): { name: string; catchAll: boolean; optional: boolean }[] {
  const template = requireString(route.routeTemplate, `${String(route.sourceFile)}.routeTemplate`);
  const file = requireString(route.sourceFile, "route.sourceFile");
  return [...template.matchAll(/\{([^}]+)\}|\*([A-Za-z0-9._~-]+)/g)].map(match => {
    const name = match[1] ?? match[2];
    if (!name) throw new Error(`invalid path parameter in ${file}`);
    const catchAll = match[2] !== undefined;
    return { name, catchAll, optional: catchAll && file.includes(`[[...${name}]]`) };
  });
}
function sourcePathSchemaHint(route: RecordValue, method: Method, name: string): Json | undefined {
  const file = requireString(route.sourceFile, "route.sourceFile");
  const segments = "^(?:[^/]+)(?:/[^/]+)*$";
  const hint = (pattern: string): Json => ({ type: "string", pattern });
  if (name === "path" && file === "src/app/(dashboard)/dashboard/providers/services/[name]/embed/[[...path]]/route.ts") {
    return hint(segments);
  }
  if (name === "path" && file === "src/app/api/cursor-cli/[...path]/route.ts" && ["GET", "POST"].includes(method)) {
    return hint(segments);
  }
  if (name === "model" && file === "src/app/api/v1/models/[...model]/route.ts" && ["GET", "HEAD", "OPTIONS"].includes(method)) {
    return hint(segments);
  }
  if (name === "path" && file === "src/app/api/v1/responses/[...path]/route.ts" && ["POST", "OPTIONS"].includes(method)) {
    return hint(segments);
  }
  if (name === "path" && file === "src/app/api/v1beta/models/[...path]/route.ts") {
    return method === "POST"
      ? hint("^[^/]+(?::generateContent|:streamGenerateContent|/[^/]+:(?:generateContent|streamGenerateContent))$")
      : method === "OPTIONS" ? hint(segments) : undefined;
  }
  if (name === "slug" && file === "src/app/api/v1/vscode/combos/[token]/[[...slug]]/route.ts" && ["GET", "OPTIONS"].includes(method)) {
    return hint(segments);
  }
  if (name === "slug" && file === "src/app/api/v1/vscode/combos/[token]/[[...slug]]/route.ts" && method === "POST") {
    return { type: "string", const: "api/show" };
  }
  if (name === "params" && file === "src/app/api/vnc-session/[...params]/route.ts") {
    if (method === "GET") return hint("^[^/]+(?:/[^/]+)?$");
    if (method === "POST") return hint("^(?:[^/]+/start|[^/]+/[^/]+/(?:harvest|touch))$");
    if (method === "DELETE") return hint("^[^/]+/[^/]+$");
  }
  if (route.classification === "source-justified-non-invokable") return hint(segments);
  if (route.classification === "external") throw new Error(`external catch-all path lacks a source-derived codec: ${file} ${method} ${name}`);
  return undefined;
}
function sourceRequestNormalizations(route: RecordValue, operationId: string): Json[] | undefined {
  if (operationId !== "PATCH /api/providers") return undefined;
  if (route.sourceFile !== "src/app/api/providers/route.ts") throw new Error(`source normalization route drift: ${operationId}`);
  const imports = requireArray(route.resolvedImports, `${operationId}.resolvedImports`).map((path, index) =>
    requireString(path, `${operationId}.resolvedImports[${index}]`));
  if (!imports.includes("src/shared/validation/schemas/provider.ts")) {
    throw new Error(`source normalization schema is outside the pinned handler closure: ${operationId}`);
  }
  return [{ section: "body", path: ["ids"], kind: "trim-string-array" }];
}


function requestBodyFor(spec: RecordValue | null, operationId: string): Json {
  if (!spec || spec.requestBody === undefined) return null;
  const body = requireRecord(spec.requestBody, `${operationId}.requestBody`);
  const content = requireRecord(body.content, `${operationId}.requestBody.content`);
  const variants = Object.entries(content).sort(([left], [right]) => compareText(left, right)).map(([mediaType, media]) => {
    const record = requireRecord(media, `${operationId}.requestBody.content.${mediaType}`);
    return {
      mediaType,
      schema: record.schema === undefined ? null : convertSchema(record.schema, `${operationId}.requestBody.content.${mediaType}.schema`),
    };
  });
  if (variants.length === 0) throw new Error(`${operationId}.requestBody has no content variants`);
  const schemas = variants.map(variant => variant.schema).filter((schema): schema is Json => schema !== null);
  const schema = schemas.length === 0 ? null : schemas.length === 1 ? schemas[0]! : { anyOf: schemas };
  return {
    required: body.required === true,
    mediaType: variants.length === 1 ? variants[0]!.mediaType : null,
    schema,
    contentVariants: variants,
  };
}

type SourceResponseHint = {
  statusCode: string;
  sourceFiles: string[];
  mediaType: string;
  contentSourceFile: string;
  body?: "empty";
  pipelineKind?: "draining" | "ip-deny";
};

type SourceResponseVariant = {
  statusCode: string;
  content: Json[];
  headers: Json;
  body?: "empty";
  sourceFiles?: string[];
};

type CentralIngressContext = {
  authority: "pinned-framework-management-policy";
  frameworkContextSha256: string;
  frameworkSources: string[];
  frameworkSourcesSet: Set<string>;
  frameworkSourcesSha256: string;
  policyResponseStatuses: Set<string>;
  policyResponseLines: Map<string, number>;
  responseSourceLine: number;
  pipelineResponseLines: Map<string, number>;
  optionsPreflightLine: number;
  managementPolicyOperations: number;
  publishedResponseVariants: number;
  responseSourceFile: string;
  policySourceFile: string;
};

const CENTRAL_INGRESS_FILES = [
  "src/proxy.ts",
  "src/server/authz/pipeline.ts",
  "src/server/authz/headers.ts",
  "src/server/authz/classify.ts",
  "src/shared/constants/publicApiRoutes.ts",
  "src/server/authz/policies/management.ts",
  "src/server/authz/context.ts",
].sort(compareText);

function validateCentralIngressContext(manifest: RecordValue, frameworkContextSha256: string): CentralIngressContext {
  const central = requireRecord(manifest.centralIngress, "manifest.centralIngress; refresh the pinned source manifest");
  assertKeys(central, "manifest.centralIngress", [
    "authority", "frameworkContextSha256", "frameworkSources", "frameworkSourcesSha256",
    "classifierSourceFile", "publicRoutePolicySourceFile", "proxyMatcherSourceFile",
    "pipelineSourceFile", "policySourceFile", "policyOutcomeFactorySourceFile",
    "responseSourceFile", "policyResponseStatuses", "policyResponseWitnesses",
    "responseWitness", "pipelineResponseWitnesses", "optionsPreflightWitness", "coverage",
  ]);
  if (central.authority !== "pinned-framework-management-policy"
    || central.frameworkContextSha256 !== frameworkContextSha256
    || central.classifierSourceFile !== "src/server/authz/classify.ts"
    || central.publicRoutePolicySourceFile !== "src/shared/constants/publicApiRoutes.ts"
    || central.proxyMatcherSourceFile !== "src/proxy.ts"
    || central.pipelineSourceFile !== "src/server/authz/pipeline.ts"
    || central.policySourceFile !== "src/server/authz/policies/management.ts"
    || central.policyOutcomeFactorySourceFile !== "src/server/authz/context.ts"
    || central.responseSourceFile !== "src/server/authz/pipeline.ts") {
    throw new Error("manifest.centralIngress does not bind the reviewed pinned framework response owners");
  }

  const framework = requireRecord(manifest.frameworkContext, "manifest.frameworkContext");
  const resolvedFrameworkFiles = new Set(stringList(framework.resolvedFiles, "manifest.frameworkContext.resolvedFiles", true));
  const frameworkSources = stringList(central.frameworkSources, "manifest.centralIngress.frameworkSources", true);
  if (canonicalJson(toJson(frameworkSources, "manifest.centralIngress.frameworkSources"))
    !== canonicalJson(toJson(CENTRAL_INGRESS_FILES, "reviewed central ingress framework sources"))
    || frameworkSources.some(file => !resolvedFrameworkFiles.has(file))) {
    throw new Error("central ingress framework witnesses are not the exact reviewed files in the pinned framework context");
  }

  const sourceFiles = requireArray(requireRecord(manifest.sourceCorpus, "manifest.sourceCorpus").files, "manifest.sourceCorpus.files");
  const corpusByPath = new Map<string, { path: string; sha256: string; gitBlobSha: string }>();
  for (const [index, value] of sourceFiles.entries()) {
    const record = requireRecord(value, `manifest.sourceCorpus.files[${index}]`);
    const path = requireString(record.path, `manifest.sourceCorpus.files[${index}].path`);
    const sha256Value = requireString(record.sha256, `${path}.sha256`);
    const gitBlobSha = requireString(record.gitBlobSha, `${path}.gitBlobSha`);
    if (!/^[a-f0-9]{64}$/.test(sha256Value) || !/^[a-f0-9]{40}$/.test(gitBlobSha) || corpusByPath.has(path)) {
      throw new Error(`source corpus contains an invalid or duplicate central ingress receipt: ${path}`);
    }
    corpusByPath.set(path, { path, sha256: sha256Value, gitBlobSha });
  }
  const centralSourceRecords = CENTRAL_INGRESS_FILES.map(path => {
    const record = corpusByPath.get(path);
    if (!record) throw new Error(`source corpus is missing central ingress witness ${path}`);
    return record;
  });
  const expectedSourcesSha256 = sha256(JSON.stringify(centralSourceRecords));
  const frameworkSourcesSha256 = requireString(central.frameworkSourcesSha256, "manifest.centralIngress.frameworkSourcesSha256");
  if (!/^[a-f0-9]{64}$/.test(frameworkSourcesSha256) || frameworkSourcesSha256 !== expectedSourcesSha256) {
    throw new Error("central ingress framework witness digest differs from the pinned source corpus");
  }

  const policyResponseStatuses = stringList(central.policyResponseStatuses, "manifest.centralIngress.policyResponseStatuses", true);
  const sortedStatuses = [...new Set(policyResponseStatuses)].sort((left, right) => Number(left) - Number(right));
  if (canonicalJson(toJson(policyResponseStatuses, "central ingress policy statuses"))
    !== canonicalJson(toJson(sortedStatuses, "sorted central ingress policy statuses"))
    || policyResponseStatuses.some(status => !/^[45][0-9]{2}$/.test(status))) {
    throw new Error("central ingress policy response statuses are malformed or duplicated");
  }
  const requireLine = (value: unknown, label: string): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw new Error(`${label} must be a positive source line number`);
    }
    return value;
  };
  const policyResponseLines = new Map<string, number>();
  for (const [index, value] of requireArray(central.policyResponseWitnesses, "manifest.centralIngress.policyResponseWitnesses").entries()) {
    const witness = requireRecord(value, `manifest.centralIngress.policyResponseWitnesses[${index}]`);
    assertKeys(witness, `manifest.centralIngress.policyResponseWitnesses[${index}]`, ["statusCode", "sourceFile", "line"]);
    const status = requireString(witness.statusCode, "central ingress policy witness status");
    const sourceFile = requireString(witness.sourceFile, "central ingress policy witness source");
    const line = requireLine(witness.line, "central ingress policy witness line");
    if (sourceFile !== central.policySourceFile || policyResponseLines.has(status)) {
      throw new Error("central ingress policy response witnesses are not uniquely bound to the pinned policy source");
    }
    policyResponseLines.set(status, line);
  }
  if (canonicalJson(toJson([...policyResponseLines.keys()].sort((left, right) => Number(left) - Number(right)), "policy witness statuses"))
    !== canonicalJson(toJson(policyResponseStatuses, "policy response statuses"))) {
    throw new Error("central ingress policy response line witnesses do not cover the exact response statuses");
  }
  const responseWitness = requireRecord(central.responseWitness, "manifest.centralIngress.responseWitness");
  assertKeys(responseWitness, "manifest.centralIngress.responseWitness", ["mediaType", "sourceFile", "line"]);
  if (responseWitness.mediaType !== "application/json" || responseWitness.sourceFile !== central.responseSourceFile) {
    throw new Error("central ingress response owner witness is not the pinned JSON response function");
  }
  const responseSourceLine = requireLine(responseWitness.line, "central ingress response witness line");
  const pipelineResponseLines = new Map<string, number>();
  for (const [index, value] of requireArray(central.pipelineResponseWitnesses, "manifest.centralIngress.pipelineResponseWitnesses").entries()) {
    const witness = requireRecord(value, `pipelineResponseWitnesses[${index}]`);
    assertKeys(witness, `pipelineResponseWitnesses[${index}]`, ["kind", "statusCode", "sourceFile", "line"]);
    const kind = requireString(witness.kind, "pipeline witness kind");
    if (!((kind === "draining" && witness.statusCode === "503") || (kind === "ip-deny" && witness.statusCode === "403"))
      || witness.sourceFile !== central.pipelineSourceFile || pipelineResponseLines.has(kind)) {
      throw new Error("invalid pipeline response witness");
    }
    pipelineResponseLines.set(kind, requireLine(witness.line, "pipeline witness line"));
  }
  if (pipelineResponseLines.size !== 2) throw new Error("pipeline response witnesses are incomplete");
  const optionsPreflightWitness = requireRecord(central.optionsPreflightWitness, "manifest.centralIngress.optionsPreflightWitness");
  assertKeys(optionsPreflightWitness, "manifest.centralIngress.optionsPreflightWitness", ["sourceFile", "line"]);
  if (optionsPreflightWitness.sourceFile !== central.pipelineSourceFile) {
    throw new Error("central ingress preflight witness is not bound to the pinned pipeline");
  }
  const optionsPreflightLine = requireLine(optionsPreflightWitness.line, "central ingress preflight witness line");


  const coverage = requireRecord(central.coverage, "manifest.centralIngress.coverage");
  assertKeys(coverage, "manifest.centralIngress.coverage", [
    "apiOperationsConsidered", "managementPolicyOperations", "publishedResponseVariants", "skippedReasons", "pendingCoverage",
  ]);
  for (const field of ["apiOperationsConsidered", "managementPolicyOperations", "publishedResponseVariants"]) {
    const value = coverage[field];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      throw new Error(`manifest.centralIngress.coverage.${field} must be a non-negative integer`);
    }
  }
  for (const [reason, count] of Object.entries(requireRecord(coverage.skippedReasons, "manifest.centralIngress.coverage.skippedReasons"))) {
    if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0) {
      throw new Error(`manifest.centralIngress.coverage.skippedReasons.${reason} must be a non-negative integer`);
    }
  }
  const pendingCoverage = requireArray(coverage.pendingCoverage, "manifest.centralIngress.coverage.pendingCoverage");
  const expectedPendingCodes = [
    "head-response-entity",
    "options-preflight-outcome",
    "non-management-policy-outcomes",
    "non-api-proxy-branches",
    "rewritten-client-aliases",
    "request-conditioned-early-exits",
  ];
  const observedPendingCodes = new Set<string>();
  for (const [index, value] of pendingCoverage.entries()) {
    const record = requireRecord(value, `manifest.centralIngress.coverage.pendingCoverage[${index}]`);
    assertKeys(record, `manifest.centralIngress.coverage.pendingCoverage[${index}]`,
      ["code", "qualificationStatus", "publicationStatus", "sourceFiles"], ["line"]);
    const code = requireString(record.code, `pendingCoverage[${index}].code`);
    const sourceWitnesses = stringList(record.sourceFiles, `pendingCoverage[${index}].sourceFiles`);
    if (!expectedPendingCodes.includes(code) || observedPendingCodes.has(code)
      || record.qualificationStatus !== "pending" || record.publicationStatus !== "not-inferred"
      || sourceWitnesses.some(file => !frameworkSources.includes(file))) {
      throw new Error(`central ingress pending coverage record ${code} is malformed or outside its pinned sources`);
    }
    observedPendingCodes.add(code);
    if (code === "options-preflight-outcome") {
      if (requireLine(record.line, `pendingCoverage[${index}].line`) !== optionsPreflightLine
        || !sourceWitnesses.includes("src/server/authz/pipeline.ts")) {
        throw new Error("central ingress OPTIONS pending coverage is not bound to its source line witness");
      }
    } else if (record.line !== undefined) {
      throw new Error(`central ingress pending coverage ${code} has an unexpected source line`);
    }
  }
  if (canonicalJson(toJson([...observedPendingCodes].sort(compareText), "pending coverage codes"))
    !== canonicalJson(toJson([...expectedPendingCodes].sort(compareText), "expected pending coverage codes"))) {
    throw new Error("central ingress pending coverage report is incomplete");
  }
  return {
    authority: "pinned-framework-management-policy",
    frameworkContextSha256,
    frameworkSources,
    frameworkSourcesSet: new Set(frameworkSources),
    frameworkSourcesSha256,
    policyResponseStatuses: new Set(policyResponseStatuses),
    policyResponseLines,
    responseSourceLine,
    pipelineResponseLines,
    optionsPreflightLine,
    managementPolicyOperations: coverage.managementPolicyOperations as number,
    publishedResponseVariants: coverage.publishedResponseVariants as number,
    responseSourceFile: "src/server/authz/pipeline.ts",
    policySourceFile: "src/server/authz/policies/management.ts",
  };
}

function sourceResponseHints(
  route: RecordValue,
  operationId: string,
  centralIngress: CentralIngressContext,
): SourceResponseHint[] {
  const routeFile = requireString(route.sourceFile, `${operationId}.sourceFile`);
  const routePath = requireString(route.routeTemplate, `${operationId}.routeTemplate`);
  const imports = requireArray(route.resolvedImports, `${operationId}.resolvedImports`).map((value, index) =>
    requireString(value, `${operationId}.resolvedImports[${index}]`));
  const importSet = new Set(imports);
  const hints: SourceResponseHint[] = [];
  const addHandler = (statusCode: string, sourceFiles: string[], contentSourceFile: string, mediaType: string, body?: "empty"): void => {
    for (const file of sourceFiles) {
      if (file !== routeFile && !importSet.has(file)) throw new Error(`${operationId} response hint source is outside the pinned handler closure: ${file}`);
    }
    hints.push({ statusCode, sourceFiles: [...new Set(sourceFiles)].sort(compareText), mediaType, contentSourceFile, ...(body === undefined ? {} : { body }) });
  };
  const addFramework = (statusCode: string, sourceFiles: string[], contentSourceFile: string, mediaType: string): void => {
    for (const file of sourceFiles) {
      if (!centralIngress.frameworkSourcesSet.has(file)) throw new Error(`${operationId} framework response witness is outside the pinned framework context: ${file}`);
    }
    if (!centralIngress.frameworkSourcesSet.has(contentSourceFile)) {
      throw new Error(`${operationId} framework response content source is outside the pinned framework context: ${contentSourceFile}`);
    }
    hints.push({ statusCode, sourceFiles: [...new Set(sourceFiles)].sort(compareText), mediaType, contentSourceFile });
  };

  const method = operationId.slice(0, operationId.indexOf(" "));
  const authFile = "src/lib/api/requireManagementAuth.ts";
  const jsonResponseFile = "src/lib/api/errorResponse.ts";
  const retirementFile = "src/lib/providers/chatgptWebRetirementResponse.ts";
  for (const [index, value] of requireArray(route.responseHints, `${routeFile}.responseHints; refresh the pinned source manifest`).entries()) {
    const hint = requireRecord(value, `${routeFile}.responseHints[${index}]`);
    assertKeys(hint, `${routeFile}.responseHints[${index}]`, ["method", "statusCode", "mediaType", "sourceFile"], ["body"]);
    if (!METHODS.includes(hint.method as Method)) throw new Error(`${routeFile} has an invalid source response method`);
    const statusCode = requireString(hint.statusCode, `${routeFile}.responseHints[${index}].statusCode`);
    const mediaType = requireString(hint.mediaType, `${routeFile}.responseHints[${index}].mediaType`);
    const sourceFile = requireString(hint.sourceFile, `${routeFile}.responseHints[${index}].sourceFile`);
    if (!/^[2-5][0-9]{2}$/.test(statusCode) || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mediaType)) throw new Error(`${routeFile} has malformed source response metadata`);
    if (hint.body !== undefined && (hint.body !== "empty" || hint.method !== "HEAD" || sourceFile === authFile || sourceFile === retirementFile)) throw new Error(`${routeFile} has invalid empty response evidence`);
    if (hint.method !== method) continue;
    if (sourceFile === authFile) {
      if (!["401", "403", "503"].includes(statusCode) || mediaType !== "application/json") throw new Error(`${operationId} has an unsupported management guard response hint`);
      addHandler(statusCode, [routeFile, authFile, jsonResponseFile], jsonResponseFile, mediaType);
    } else if (sourceFile === retirementFile) {
      if (statusCode !== "410" || mediaType !== "application/json") throw new Error(`${operationId} has an unsupported retirement guard response hint`);
      addHandler(statusCode, [routeFile, retirementFile], retirementFile, mediaType);
    } else addHandler(statusCode, [routeFile, sourceFile], sourceFile, mediaType, hint.body as "empty" | undefined);
  }

  const routeExports = requireArray(requireRecord(route.exports, `${routeFile}.exports`).resolved, `${routeFile}.exports.resolved`);
  const seenCentralHints = new Set<string>();
  const selectedCentralStatuses: string[] = [];
  for (const [index, value] of requireArray(route.centralResponseHints, `${routeFile}.centralResponseHints; refresh the pinned source manifest`).entries()) {
    const hint = requireRecord(value, `${routeFile}.centralResponseHints[${index}]`);
    assertKeys(hint, `${routeFile}.centralResponseHints[${index}]`, [
      "method", "statusCode", "mediaType", "sourceFile", "routePath", "routeClass",
      "authority", "responseSourceLine", "evidenceSourceFiles", "frameworkContextSha256", "frameworkSourcesSha256",
    ], ["policySourceFile", "policySourceLine", "pipelineKind"]);
    const hintMethod = requireString(hint.method, `${routeFile}.centralResponseHints[${index}].method`);
    if (!METHODS.includes(hintMethod as Method) || !routeExports.includes(hintMethod)) {
      throw new Error(`${routeFile} central response hint is not bound to an exported method`);
    }
    const statusCode = requireString(hint.statusCode, `${routeFile}.centralResponseHints[${index}].statusCode`);
    const mediaType = requireString(hint.mediaType, `${routeFile}.centralResponseHints[${index}].mediaType`);
    const sourceFile = requireString(hint.sourceFile, `${routeFile}.centralResponseHints[${index}].sourceFile`);
    const policySourceFile = hint.policySourceFile;
    const evidenceSourceFiles = stringList(hint.evidenceSourceFiles, `${routeFile}.centralResponseHints[${index}].evidenceSourceFiles`, true);
    const routeHintPath = requireString(hint.routePath, `${routeFile}.centralResponseHints[${index}].routePath`);
    const pipeline = hint.authority === "pinned-framework-pipeline";
    const kind = hint.pipelineKind;
    // These exits precede all route policies; routeClass is descriptive only,
    // not proof of classification or of exclusive response shapes.
    const validPipeline = pipeline && (kind === "draining" || kind === "ip-deny")
      && hintMethod !== "HEAD" && hintMethod !== "OPTIONS"
      && ["PUBLIC", "MANAGEMENT", "CLIENT_API"].includes(String(hint.routeClass))
      && statusCode === (kind === "draining" ? "503" : "403")
      && hint.responseSourceLine === centralIngress.pipelineResponseLines.get(kind)
      && hint.policySourceFile === undefined && hint.policySourceLine === undefined
      && /^\/api\/[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/.test(routePath)
      && !routePath.split("/").some(segment => segment === "." || segment === "..");
    const validPolicy = hint.authority === centralIngress.authority && hint.routeClass === "MANAGEMENT"
      && policySourceFile === centralIngress.policySourceFile && hint.pipelineKind === undefined
      && centralIngress.policyResponseStatuses.has(statusCode)
      && hint.policySourceLine === centralIngress.policyResponseLines.get(statusCode)
      && hint.responseSourceLine === centralIngress.responseSourceLine;
    if ((!validPipeline && !validPolicy) || sourceFile !== centralIngress.responseSourceFile
      || routeHintPath !== routePath || hint.frameworkContextSha256 !== centralIngress.frameworkContextSha256
      || hint.frameworkSourcesSha256 !== centralIngress.frameworkSourcesSha256 || mediaType !== "application/json"
      || canonicalJson(toJson(evidenceSourceFiles, "central response witness files"))
        !== canonicalJson(toJson(centralIngress.frameworkSources, "pinned central framework source files"))) {
      throw new Error(`${operationId} central response hint is not source-bound to the pinned framework`);
    }
    const identity = `${hintMethod}\0${statusCode}\0${hint.authority}`;
    if (seenCentralHints.has(identity)) throw new Error(`${operationId} has a duplicate central response status hint`);
    seenCentralHints.add(identity);
    if (hintMethod === method) {
      if (validPolicy) selectedCentralStatuses.push(statusCode);
      addFramework(statusCode, evidenceSourceFiles, sourceFile, mediaType);
      if (validPipeline) hints[hints.length - 1]!.pipelineKind = kind as "draining" | "ip-deny";
    }
  }
  if (selectedCentralStatuses.length > 0) {
    const actual = [...new Set(selectedCentralStatuses)].sort((left, right) => Number(left) - Number(right));
    const expected = [...centralIngress.policyResponseStatuses].sort((left, right) => Number(left) - Number(right));
    if (canonicalJson(toJson(actual, `${operationId}.centralResponseHints.statuses`))
      !== canonicalJson(toJson(expected, "pinned management policy response statuses"))) {
      throw new Error(`${operationId} central response hints omit or add a pinned management policy response variant`);
    }
  }
  return hints;
}
function validateCentralResponseHintCoverage(
  routes: readonly RecordValue[],
  centralIngress: CentralIngressContext,
): void {
  const variants = new Map<string, Set<string>>();
  const policyOperations = new Set<string>();
  let variantCount = 0;
  for (const [routeIndex, route] of routes.entries()) {
    const routeFile = requireString(route.sourceFile, `routeFiles[${routeIndex}].sourceFile`);
    const routePath = requireString(route.routeTemplate, `${routeFile}.routeTemplate`);
    for (const value of requireArray(route.centralResponseHints, `${routeFile}.centralResponseHints`)) {
      const hint = requireRecord(value, `${routeFile}.centralResponseHints`);
      const method = requireString(hint.method, "central hint method");
      const status = requireString(hint.statusCode, "central hint status");
      if (hint.routePath !== routePath) throw new Error(`${routeFile} central hint has a different route`);
      const operation = `${method}\0${routePath}`;
      const authority = requireString(hint.authority, "central hint authority");
      const key = `${operation}\0${authority}`;
      const statuses = variants.get(key) ?? new Set<string>();
      if (statuses.has(status)) throw new Error(`${routeFile} has a duplicate central response witness`);
      statuses.add(status);
      variants.set(key, statuses);
      if (authority === "pinned-framework-management-policy") policyOperations.add(operation);
      variantCount++;
    }
  }
  for (const [key, statuses] of variants) {
    const expected = key.endsWith("\0pinned-framework-pipeline") ? ["403", "503"]
      : [...centralIngress.policyResponseStatuses].sort((left, right) => Number(left) - Number(right));
    if (canonicalJson(toJson([...statuses].sort(), "central statuses")) !== canonicalJson(toJson(expected, "expected central statuses"))) {
      throw new Error(`${key} central response witnesses are incomplete`);
    }
  }
  for (const route of routes) {
    const path = requireString(route.routeTemplate, "route template");
    if (!path.startsWith("/api/") || /[{*]/.test(path)) continue;
    const exports = requireArray(requireRecord(route.exports, "route exports").resolved, "resolved exports");
    for (const method of exports) {
      if (typeof method !== "string" || !METHODS.includes(method as Method) || method === "HEAD" || method === "OPTIONS") continue;
      if (!variants.has(`${method}\0${path}\0pinned-framework-pipeline`)) {
        throw new Error(`${method} ${path} is missing canonical pipeline response witnesses`);
      }
    }
  }
  if (variantCount !== centralIngress.publishedResponseVariants || policyOperations.size !== centralIngress.managementPolicyOperations) {
    throw new Error("central response hint coverage counts differ from the pinned manifest report");
  }
}


export function responseFor(spec: RecordValue | null, operationId: string, sourceHints: SourceResponseHint[]): Json {
  const variants: SourceResponseVariant[] = [];
  if (spec) {
    const responses = requireRecord(spec.responses, `${operationId}.responses`);
    if (Object.keys(responses).length === 0) throw new Error(`${operationId} has no response status`);
    for (const [statusCode, rawResponse] of Object.entries(responses).sort(([left], [right]) => {
      if (left === "default") return 1;
      if (right === "default") return -1;
      return compareText(left, right);
    })) {
      if (statusCode !== "default" && !/^[1-5](?:\d{2}|XX)$/.test(statusCode)) {
        throw new Error(`${operationId} has unsupported response status key ${statusCode}`);
      }
      const response = requireRecord(rawResponse, `${operationId}.responses.${statusCode}`);
      const content = response.content === undefined ? {} : requireRecord(response.content, `${operationId}.responses.${statusCode}.content`);
      const contentVariants = Object.entries(content).sort(([left], [right]) => compareText(left, right)).map(([mediaType, rawMedia]) => {
        const media = requireRecord(rawMedia, `${operationId}.responses.${statusCode}.content.${mediaType}`);
        return {
          mediaType,
          schema: media.schema === undefined ? null : convertSchema(media.schema, `${operationId}.responses.${statusCode}.${mediaType}.schema`),
        };
      });
      const headers = response.headers === undefined ? {} : requireRecord(response.headers, `${operationId}.responses.${statusCode}.headers`);
      const projectedHeaders: Record<string, Json> = {};
      for (const [name, rawHeader] of Object.entries(headers)) {
        const header = requireRecord(rawHeader, `${operationId}.responses.${statusCode}.headers.${name}`);
        projectedHeaders[name] = {
          required: header.required === true,
          schema: header.schema === undefined ? null : convertSchema(header.schema, `${operationId}.responses.${statusCode}.headers.${name}.schema`),
        };
      }
      variants.push({ statusCode, content: contentVariants, headers: projectedHeaders });
    }
  }

  for (const hint of sourceHints) {
    let variant = variants.find(value => value.statusCode === hint.statusCode);
    if (!variant) {
      variant = { statusCode: hint.statusCode, content: [], headers: {} };
      variants.push(variant);
    }
    const sourceFiles = new Set<string>(variant.sourceFiles === undefined
      ? []
      : stringList(variant.sourceFiles, `${operationId}.response.${hint.statusCode}.sourceFiles`));
    for (const file of hint.sourceFiles) sourceFiles.add(file);
    variant.sourceFiles = [...sourceFiles].sort(compareText);
    const content = requireArray(variant.content, `${operationId}.response.${hint.statusCode}.content`);
    const documentedContent = content.find(item => isRecord(item) && item.mediaType === hint.mediaType);
    if (!documentedContent) {
      content.push({ mediaType: hint.mediaType, schema: null, sourceFile: hint.contentSourceFile });
    }
  }
  for (const variant of variants) {
    const matching = sourceHints.filter(hint => hint.statusCode === variant.statusCode);
    if (matching.length > 0 && matching.every(hint => hint.body === "empty")) variant.body = "empty";
  }
  variants.sort((left, right) => {
    if (left.statusCode === "default") return 1;
    if (right.statusCode === "default") return -1;
    return compareText(String(left.statusCode), String(right.statusCode));
  });

  const successfulContent = variants.filter(variant => /^2(?:\d{2}|XX)$/.test(String(variant.statusCode)))
    .flatMap(variant => requireArray(variant.content, `${operationId}.response.content`));
  const successfulMediaTypes = [...new Set(successfulContent.map(content => requireString(requireRecord(content, "response content").mediaType, "response media type")))];
  const successfulSchemas = successfulContent.map(content => requireRecord(content, "response content").schema).filter((schema): schema is Json => schema !== null);
  const schema = successfulContent.some(content => requireRecord(content, "response content").schema === null)
    ? null
    : successfulSchemas.length === 0 ? null : successfulSchemas.length === 1 ? successfulSchemas[0]! : { anyOf: successfulSchemas };
  return {
    statusCodes: variants.map(variant => variant.statusCode),
    mediaType: successfulMediaTypes.length === 1 ? successfulMediaTypes[0]! : null,
    schema,
    variants,
  };
}

function specificationFor(manifest: RecordValue, method: Method, path: string): RecordValue | null {
  const openapi = requireRecord(manifest.openapi, "manifest.openapi");
  const operations = requireArray(openapi.operations, "manifest.openapi.operations").map((operation, index) => requireRecord(operation, `OpenAPI operation ${index}`));
  const exact = operations.filter(operation => operation.method === method && operation.path === path);
  if (exact.length > 1) throw new Error(`duplicate OpenAPI operation ${method} ${path}`);
  if (exact.length === 1) return requireRecord(resolveReferences(exact[0], openapi), `OpenAPI ${method} ${path}`);
  const shapedPath = path.replace(/\*[^/]+|\{[^}]+\}/g, "{}");
  const shaped = operations.filter(operation => operation.method === method && String(operation.path).replace(/\*[^/]+|\{[^}]+\}/g, "{}") === shapedPath);
  if (shaped.length > 1) throw new Error(`ambiguous OpenAPI path match for ${method} ${path}`);
  return shaped.length === 1 ? requireRecord(resolveReferences(shaped[0], openapi), `OpenAPI ${method} ${path}`) : null;
}

function securityAlternatives(manifest: RecordValue, spec: RecordValue | null, operationId: string): Json[] {
  const openapi = requireRecord(manifest.openapi, "manifest.openapi");
  const raw = spec && Object.prototype.hasOwnProperty.call(spec, "security") ? spec.security : openapi.security ?? [];
  const alternatives = requireArray(raw, `${operationId}.security`);
  const components = requireRecord(openapi.components, "manifest.openapi.components");
  const schemes = components.securitySchemes === undefined ? {} : requireRecord(components.securitySchemes, "OpenAPI security schemes");
  return alternatives.map((entry, index) => {
    const requirements = requireRecord(entry, `${operationId}.security[${index}]`);
    return Object.entries(requirements).sort(([left], [right]) => compareText(left, right)).map(([name, rawScopes]) => {
      const scopes = requireArray(rawScopes, `${operationId}.security.${name}`);
      if (scopes.some(scope => typeof scope !== "string")) throw new Error(`${operationId}.security.${name} scopes must be strings`);
      const schemeValue = schemes[name];
      if (schemeValue === undefined) {
        return { name, scopes: [...scopes] as string[], type: null, scheme: null, in: null, parameterName: null, unresolved: true };
      }
      const scheme = requireRecord(resolveReferences(schemeValue, openapi), `OpenAPI security scheme ${name}`);
      return {
        name,
        scopes: [...scopes] as string[],
        type: scheme.type === undefined ? null : toJson(scheme.type, `${name}.type`),
        scheme: scheme.scheme === undefined ? null : toJson(scheme.scheme, `${name}.scheme`),
        in: scheme.in === undefined ? null : toJson(scheme.in, `${name}.in`),
        parameterName: scheme.name === undefined ? null : toJson(scheme.name, `${name}.name`),
        unresolved: false,
      };
    });
  });
}

function discrepancies(path: string, spec: RecordValue | null, sourcePathSchemaMissing = false): Json[] {
  const result: Json[] = !spec
    ? [{ code: "undocumented-source-operation", authority: "source", detail: "Exported handler method is absent from the pinned OpenAPI specification; request/response behavior remains unqualified." }]
    : spec.path === path ? [] : [{
      code: "spec-path-parameter-name-mismatch",
      authority: "source",
      detail: `OpenAPI path ${String(spec.path)} uses different parameter names; source route parameter names define the dispatch path.`,
    }];
  if (path === "/api/system/version" && spec) result.push({
    code: "spec-annotation-flow-mapping-typo",
    authority: "source",
    detail: "Pinned OpenAPI news.description contains an unquoted comma parsed as an extra null key. Only the exact commit and document digest receive the reviewed annotation repair; no response type or behavior is inferred.",
  });
  if (sourcePathSchemaMissing) result.push({
    code: "spec-path-parameter-missing-schema",
    authority: "source",
    detail: "The matched OpenAPI path omits a referenced parameter schema; the Next route declares a required single-segment string parameter, which is retained as a source-derived constraint.",
  });
  return result;
}

type SideEffect = "read" | "unknown" | "mutation" | "secret" | "lifecycle" | "destructive";
type EvidenceBinding = {
  requestSchemaSha256: string;
  authSha256: string;
  sideEffect: SideEffect;
  responseProjectionSha256: string;
  operationSemanticsSha256: string;
  routeImportsSha256: string;
  frameworkContextSha256: string;
  mutationSafetySha256: string;
  sourceDerivation?: { record: string; sha256: string };
  effectiveTreeSha256?: string;
  databaseInitializationRequired?: true;
};

function eligibilityRecords(): Map<string, RecordValue> {
  const root = requireRecord(JSON.parse(readFileSync(eligibilityPath, "utf8")) as unknown, "release eligibility");
  assertKeys(root, "release eligibility", ["$schema", "schemaVersion", "recordKind", "release", "default", "operations", "history"], ["sourceDerivation", "effectiveTreeSha256"]);
  if (root.schemaVersion !== 3 || root.recordKind !== "omniroute-release-eligibility") throw new Error("release eligibility identity/version is unsupported");
  const expectedRelease = requireRecord(requireRecord(readRouteSources(manifestPath), "route source manifest").release, "manifest.release");
  const release = requireRecord(root.release, "release eligibility.release");
  assertKeys(release, "release eligibility.release", ["repository", "tag", "commit"]);
  if (release.repository !== expectedRelease.repository || release.tag !== expectedRelease.tag || release.commit !== expectedRelease.commit) {
    throw new Error("release eligibility pin does not match the route-source manifest");
  }
  const sourceManifest = requireRecord(readRouteSources(manifestPath), "route source manifest");
  if (canonicalJson(toJson(root.sourceDerivation ?? null, "eligibility derivation")) !== canonicalJson(toJson(sourceManifest.sourceDerivation ?? null, "manifest derivation"))
    || root.effectiveTreeSha256 !== sourceManifest.effectiveTreeSha256) throw new Error("release eligibility effective source mismatch");
  const defaultStatus = requireRecord(root.default, "release eligibility.default");
  assertKeys(defaultStatus, "release eligibility.default", ["status", "reason"]);
  if (defaultStatus.status !== "unavailable") throw new Error("release eligibility default must fail closed");
  requireString(defaultStatus.reason, "release eligibility.default.reason");
  requireArray(root.history, "release eligibility.history");
  const records = requireArray(root.operations, "release eligibility.operations");
  const result = new Map<string, RecordValue>();
  for (const value of records) {
    const record = requireRecord(value, "eligibility record");
    assertKeys(record, "eligibility record", ["operationId", "status", "reason", "source", "contract", "binding", "test", "evidence"], ["ingressEvidence", "lifecycleEvidence"]);
    const operationId = requireString(record.operationId, "eligibility operationId");
    if (result.has(operationId)) throw new Error(`duplicate eligibility record ${operationId}`);
    if (record.status !== "verified") throw new Error(`eligibility entries must be verified or omitted: ${operationId}`);
    requireString(record.reason, `${operationId}.eligibility.reason`);
    const source = requireRecord(record.source, `${operationId}.eligibility.source`);
    assertKeys(source, `${operationId}.eligibility.source`, ["file", "sha256", "gitBlobSha"]);
    const binding = requireRecord(record.binding, `${operationId}.eligibility.binding`);
    assertKeys(binding, `${operationId}.eligibility.binding`, ["requestSchemaSha256", "authSha256", "sideEffect", "responseProjectionSha256", "operationSemanticsSha256", "routeImportsSha256", "frameworkContextSha256", "mutationSafetySha256"], ["sourceDerivation", "effectiveTreeSha256", "databaseInitializationRequired"]);
    const test = requireRecord(record.test, `${operationId}.eligibility.test`);
    assertKeys(test, `${operationId}.eligibility.test`, ["id", "observedOutcome", "caseSha256", "outcomeSha256"]);
    const evidence = requireArray(record.evidence, `${operationId}.eligibility.evidence`);
    if (evidence.length === 0) throw new Error(`${operationId}.eligibility.evidence is empty`);
    result.set(operationId, record);
  }
  return result;
}

const OPERATION_CONTRACT_FIELDS = [
  "request", "auth", "response", "secrets", "sideEffect", "pagination",
  "streaming", "confirmation", "retry", "reconciliation", "mutationSafety",
] as const;

function contractFromOperation(operation: RecordValue): RecordValue {
  return Object.fromEntries(OPERATION_CONTRACT_FIELDS.map(field => [field, operation[field]]));
}

function bindingFor(operation: RecordValue, route: RecordValue, frameworkContextSha256: string, manifest: RecordValue): EvidenceBinding {
  const contract = toJson(contractFromOperation(operation), `${String(operation.operationId)}.contract`);
  return {
    requestSchemaSha256: sha256(canonicalJson(toJson(operation.request, "operation.request"))),
    authSha256: sha256(canonicalJson(toJson(operation.auth, "operation.auth"))),
    sideEffect: requireString(operation.sideEffect, "operation.sideEffect") as SideEffect,
    responseProjectionSha256: sha256(canonicalJson(toJson(operation.response, "operation.response"))),
    operationSemanticsSha256: sha256(canonicalJson(contract)),
    routeImportsSha256: requireString(route.resolvedImportsSha256, `${String(route.sourceFile)}.resolvedImportsSha256`),
    frameworkContextSha256,
    ...effectiveSourceBinding(manifest),
    ...(requireArray(route.resolvedImports, "route.resolvedImports").includes("src/lib/db/core.ts") ? { databaseInitializationRequired: true as const } : {}),
    mutationSafetySha256: sha256(canonicalJson(toJson(operation.mutationSafety, "operation.mutationSafety"))),
  };
}

function effectiveSourceBinding(manifest: RecordValue): Pick<EvidenceBinding, "sourceDerivation" | "effectiveTreeSha256"> {
  if (manifest.sourceDerivation === undefined) {
    if (manifest.effectiveTreeSha256 !== undefined) throw new Error("Official source cannot declare a derived tree");
    return {};
  }
  const derivation = requireRecord(manifest.sourceDerivation, "manifest.sourceDerivation");
  assertKeys(derivation, "manifest.sourceDerivation", ["record", "sha256"]);
  const record = requireString(derivation.record, "manifest.sourceDerivation.record");
  const digest = requireString(derivation.sha256, "manifest.sourceDerivation.sha256");
  const tree = requireString(manifest.effectiveTreeSha256, "manifest.effectiveTreeSha256");
  if (record !== "provenance/derivations/omniroute-3.8.53-startup/manifest.json" || !/^[a-f0-9]{64}$/.test(digest) || !/^[a-f0-9]{64}$/.test(tree)) throw new Error("Invalid effective source identity");
  return { sourceDerivation: { record, sha256: digest }, effectiveTreeSha256: tree };
}

export type OperationEvidenceBinding = EvidenceBinding & {
  handlerSha256: string;
  handlerGitBlobSha: string;
  sideEffectSha256: string;
};

function outcomeBindingFor(route: RecordValue, binding: EvidenceBinding): OperationEvidenceBinding {
  return {
    handlerSha256: requireString(route.sha256, `${String(route.sourceFile)}.sha256`),
    handlerGitBlobSha: requireString(route.gitBlobSha, `${String(route.sourceFile)}.gitBlobSha`),
    ...binding,
    sideEffectSha256: sha256(canonicalJson(toJson(binding.sideEffect, "sideEffect classification"))),
  };
}

function validateEligibility(
  record: RecordValue | undefined,
  operationId: string,
  route: RecordValue,
  binding: EvidenceBinding,
): boolean {
  if (!record) return false;
  if (binding.sideEffect === "unknown") throw new Error(`eligibility requires a source-qualified side-effect classification: ${operationId}`);
  const source = requireRecord(record.source, `${operationId}.eligibility.source`);
  if (record.status !== "verified"
    || source.file !== route.sourceFile || source.sha256 !== route.sha256 || source.gitBlobSha !== route.gitBlobSha) {
    throw new Error(`eligibility source binding mismatch: ${operationId}`);
  }
  const actual = requireRecord(record.binding, `${operationId}.eligibility.binding`);
  const expectedBinding = outcomeBindingFor(route, binding);
  const actualJson = toJson(actual, `${operationId}.eligibility.binding`);
  const expectedJson = toJson({
    requestSchemaSha256: binding.requestSchemaSha256,
    authSha256: binding.authSha256,
    sideEffect: binding.sideEffect,
    responseProjectionSha256: binding.responseProjectionSha256,
    operationSemanticsSha256: binding.operationSemanticsSha256,
    routeImportsSha256: binding.routeImportsSha256,
    frameworkContextSha256: binding.frameworkContextSha256,
    mutationSafetySha256: binding.mutationSafetySha256,
    ...(binding.sourceDerivation ? { sourceDerivation: binding.sourceDerivation, effectiveTreeSha256: binding.effectiveTreeSha256 } : {}),
    ...(binding.databaseInitializationRequired ? { databaseInitializationRequired: true } : {}),
  }, `${operationId}.expected binding`);
  if (canonicalJson(actualJson) !== canonicalJson(expectedJson)) throw new Error(`eligibility operation contract binding drift: ${operationId}`);
  const test = requireRecord(record.test, `${operationId}.eligibility.test`);
  const testId = requireString(test.id, `${operationId}.eligibility.test.id`);
  const caseSha256 = requireString(test.caseSha256, `${operationId}.eligibility.test.caseSha256`);
  const expectedCaseSha256 = testCaseSourceHash(testId);
  if (caseSha256 !== expectedCaseSha256) throw new Error(`eligibility test case source closure drift: ${operationId}`);
  const observedOutcome = requireString(test.observedOutcome, `${operationId}.eligibility.test.observedOutcome`);
  const expectedOutcomeSha256 = testOutcomeHash(operationId, testId, caseSha256, expectedBinding, record.contract, observedOutcome);
  if (requireString(test.outcomeSha256, `${operationId}.eligibility.test.outcomeSha256`) !== expectedOutcomeSha256) {
    throw new Error(`eligibility observed outcome digest mismatch: ${operationId}`);
  }
  if (operationRequiresIngressEvidence(operationId)) {
    const ingress = requireRecord(record.ingressEvidence, `${operationId}.eligibility.ingressEvidence`);
    if (typeof ingress.artifact !== "string" || !/^provenance\/qualification\/ingress-[a-f0-9]{64}\.json$/.test(ingress.artifact)) {
      throw new Error(`eligibility ingress artifact must be retained in provenance: ${operationId}`);
    }
    validateHealthIngressEvidence(ingress, expectedBinding, operationId);
  }
  else if (record.ingressEvidence !== undefined) throw new Error(`ingress evidence is unsupported for ${operationId}`);
  if (binding.databaseInitializationRequired) validateCoreLifecycleEvidence(record.lifecycleEvidence, binding);
  else if (record.lifecycleEvidence !== undefined) throw new Error(`lifecycle evidence is unsupported for ${operationId}`);
  const evidence = requireArray(record.evidence, `${operationId}.eligibility.evidence`);
  if (evidence.length === 0) throw new Error(`eligibility evidence is empty: ${operationId}`);
  return true;
}

function assertKeys(record: RecordValue, label: string, required: readonly string[], optional: readonly string[] = []): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.filter(key => !Object.prototype.hasOwnProperty.call(record, key));
  const extra = Object.keys(record).filter(key => !allowed.has(key));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`${label} has missing keys [${missing.join(", ")}] or unsupported keys [${extra.join(", ")}]`);
  }
}

function stringList(value: unknown, label: string, nonempty = false): string[] {
  const values = requireArray(value, label);
  if ((nonempty && values.length === 0) || values.some(item => typeof item !== "string" || item.length === 0)) {
    throw new Error(`${label} must contain ${nonempty ? "one or more" : "only"} non-empty strings`);
  }
  const strings = values as string[];
  if (new Set(strings).size !== strings.length) throw new Error(`${label} contains duplicates`);
  return strings;
}

function matchesSourceOperationBinding(operationId: string, methods: readonly string[], pathTemplate: string): boolean {
  const separator = operationId.indexOf(" ");
  return separator > 0 && operationId.slice(separator + 1) === pathTemplate
    && methods.includes(operationId.slice(0, separator));
}

function validateSchemaValue(value: unknown, label: string): void {
  convertSchema(value, label);
}

function validateRequestContract(value: unknown, baseValue: unknown, operationId: string, routeFile: string): void {
  const request = requireRecord(value, `${operationId}.contract.request`);
  assertKeys(request, `${operationId}.contract.request`, ["pathSchema", "querySchema", "pathParameters", "parameters", "body", "specificationDocumented"], ["normalizations", "sourceValidator", "sourceNormalizer"]);
  validateSchemaValue(request.pathSchema, `${operationId}.contract.request.pathSchema`);
  validateSchemaValue(request.querySchema, `${operationId}.contract.request.querySchema`);
  if (typeof request.specificationDocumented !== "boolean") throw new Error(`${operationId}.contract.request.specificationDocumented must be boolean`);
  const base = requireRecord(baseValue, `${operationId}.base.request`);
  if (request.specificationDocumented !== base.specificationDocumented) throw new Error(`${operationId}.contract cannot relabel specification authority`);
  if (canonicalJson(toJson(request.pathParameters, "request.pathParameters")) !== canonicalJson(toJson(base.pathParameters, "base.pathParameters"))) {
    throw new Error(`${operationId}.contract cannot alter source-derived path serialization`);
  }
  const routeParameters = requireArray(request.parameters, `${operationId}.contract.parameters`);
  const specificationParameters = requireArray(base.parameters, `${operationId}.base.parameters`);
  const specificationPrefix = routeParameters.slice(0, specificationParameters.length);
  if (canonicalJson(toJson(specificationPrefix, "request specification parameters"))
    !== canonicalJson(toJson(specificationParameters, "base specification parameters"))) {
    throw new Error(`${operationId}.contract cannot alter or remove OpenAPI parameter serialization`);
  }
  const routeOnlyParameters = routeParameters.slice(specificationParameters.length);
  if (routeOnlyParameters.length > 0) {
    const querySchema = requireRecord(request.querySchema, `${operationId}.contract.querySchema`);
    const queryProperties = requireRecord(querySchema.properties, `${operationId}.contract.querySchema.properties`);
    const seen = new Set(specificationParameters.map(value => requireString(requireRecord(value, "base parameter").name, "base parameter.name")));
    for (const [index, value] of routeOnlyParameters.entries()) {
      const parameter = requireRecord(value, `${operationId}.contract.routeOnlyParameters[${index}]`);
      const label = `${operationId}.contract.routeOnlyParameters[${index}]`;
      if (parameter.in !== "query" || parameter.sourceFile !== routeFile || parameter.inputAllowed !== true
        || typeof parameter.name !== "string" || seen.has(parameter.name)
        || !Object.prototype.hasOwnProperty.call(queryProperties, parameter.name)
        || canonicalJson(toJson(parameter.schema, `${label}.schema`))
          !== canonicalJson(toJson(queryProperties[parameter.name], `${operationId}.querySchema.${String(parameter.name)}`))) {
        throw new Error(`${label} must be a unique query input bound to the pinned route and its matching schema`);
      }
      seen.add(parameter.name);
    }
  }
  const pathParameters = requireArray(request.pathParameters, `${operationId}.contract.pathParameters`);
  for (const [index, value] of pathParameters.entries()) {
    const parameter = requireRecord(value, `${operationId}.contract.pathParameters[${index}]`);
    assertKeys(parameter, `${operationId}.contract.pathParameters[${index}]`, ["name", "specName", "serialization", "required"], ["style", "explode"]);
    requireString(parameter.name, `${operationId}.pathParameter.name`);
    requireString(parameter.specName, `${operationId}.pathParameter.specName`);
    if (!["simple", "label", "matrix", "catch-all-segments"].includes(String(parameter.serialization)) || typeof parameter.required !== "boolean") {
      throw new Error(`${operationId}.contract.pathParameters[${index}] has unsupported serialization`);
    }
  }
  const parameters = requireArray(request.parameters, `${operationId}.contract.parameters`);
  for (const [index, value] of parameters.entries()) {
    const parameter = requireRecord(value, `${operationId}.contract.parameters[${index}]`);
    assertKeys(parameter, `${operationId}.contract.parameters[${index}]`, ["name", "in", "required", "style", "explode", "allowReserved", "schema", "inputAllowed"], ["sourceFile"]);
    const location = requireString(parameter.in, `${operationId}.parameter.in`);
    if (!["path", "query", "header", "cookie"].includes(location)
      || typeof parameter.required !== "boolean" || typeof parameter.explode !== "boolean"
      || typeof parameter.allowReserved !== "boolean" || typeof parameter.inputAllowed !== "boolean"
      || parameter.inputAllowed !== (location === "path" || location === "query")) {
      throw new Error(`${operationId}.contract.parameters[${index}] has invalid location or input permission`);
    }
    requireString(parameter.name, `${operationId}.parameter.name`);
    if (parameter.sourceFile !== undefined) {
      const sourceFile = requireString(parameter.sourceFile, `${operationId}.parameter.sourceFile`);
      if (!/^src\/app\/.+\/route\.ts$/.test(sourceFile)) throw new Error(`${operationId}.parameter.sourceFile must name a route receipt`);
    }
    requireString(parameter.style, `${operationId}.parameter.style`);
    validateSchemaValue(parameter.schema, `${operationId}.parameter.schema`);
  }
  const body = request.body;
  if (body !== null) {
    const bodyRecord = requireRecord(body, `${operationId}.contract.body`);
    assertKeys(bodyRecord, `${operationId}.contract.body`, ["required", "mediaType", "schema", "contentVariants"]);
    if (typeof bodyRecord.required !== "boolean" || !(bodyRecord.mediaType === null || typeof bodyRecord.mediaType === "string")) throw new Error(`${operationId}.contract.body has invalid required/mediaType`);
    if (bodyRecord.schema !== null) validateSchemaValue(bodyRecord.schema, `${operationId}.contract.body.schema`);
    const variants = requireArray(bodyRecord.contentVariants, `${operationId}.contract.body.contentVariants`);
    if (variants.length === 0) throw new Error(`${operationId}.contract.body.contentVariants cannot be empty`);
    for (const [index, item] of variants.entries()) {
      const variant = requireRecord(item, `${operationId}.contract.body.contentVariants[${index}]`);
      assertKeys(variant, `${operationId}.body.contentVariant`, ["mediaType", "schema"]);
      requireString(variant.mediaType, `${operationId}.body.contentVariant.mediaType`);
      if (variant.schema !== null) validateSchemaValue(variant.schema, `${operationId}.body.contentVariant.schema`);
    }
    const baseBody = base.body === null ? null : requireRecord(base.body, `${operationId}.base.body`);
    if (baseBody) {
      const baseVariants = requireArray(baseBody.contentVariants, `${operationId}.base.body.contentVariants`).map(item => requireRecord(item, "base body variant").mediaType);
      const variantTypes = variants.map(item => requireRecord(item, "body variant").mediaType);
      if (canonicalJson(toJson(variantTypes, "body media types")) !== canonicalJson(toJson(baseVariants, "base body media types"))) {
        throw new Error(`${operationId}.contract drops or changes documented request media types`);
      }
    }
  }
  if (request.sourceValidator !== undefined) {
    const binding = sourceRequestValidatorBinding(request.sourceValidator);
    if (!binding || !matchesSourceOperationBinding(operationId, binding.methods, binding.pathTemplate)) {
      throw new Error(`${operationId}.contract.request.sourceValidator is not allowed for this operation`);
    }
    if (body === null || !isRecord(body) || body.required !== true) {
      throw new Error(`${operationId}.contract.request.sourceValidator requires a required request body`);
    }
  }
  if (request.sourceNormalizer !== undefined) {
    const binding = sourceNormalizationBinding(request.sourceNormalizer);
    if (!binding || !matchesSourceOperationBinding(operationId, binding.methods, binding.pathTemplate)
      || (binding.section === "body" && (body === null || !isRecord(body) || body.required !== true))) {
      throw new Error(`${operationId}.contract.request.sourceNormalizer does not match its closed source operation`);
    }
  }
  if (request.normalizations !== undefined) {
    const normalizations = requireArray(request.normalizations, `${operationId}.contract.normalizations`);
    if (normalizations.length === 0) throw new Error(`${operationId}.contract.normalizations cannot be empty`);
    for (const [index, value] of normalizations.entries()) {
      const normalization = requireRecord(value, `${operationId}.contract.normalizations[${index}]`);
      assertKeys(normalization, `${operationId}.normalization`, ["section", "path", "kind"]);
      if (!["path", "query", "body"].includes(String(normalization.section))
        || !["trim-string", "trim-string-array"].includes(String(normalization.kind))) throw new Error(`${operationId}.contract.normalization is unsupported`);
      stringList(normalization.path, `${operationId}.normalization.path`, true);
    }
  }
  const baseNormalizations = base.normalizations;
  if (baseNormalizations !== undefined
    && canonicalJson(toJson(request.normalizations, `${operationId}.normalizations`)) !== canonicalJson(toJson(baseNormalizations, `${operationId}.base.normalizations`))) {
    throw new Error(`${operationId}.contract must preserve the exact pinned source normalization`);
  }
}

export function validateResponseContract(value: unknown, baseValue: unknown, operationId: string): void {
  const response = requireRecord(value, `${operationId}.contract.response`);
  assertKeys(response, `${operationId}.contract.response`, ["statusCodes", "mediaType", "schema", "variants"]);
  const statusCodes = stringList(response.statusCodes, `${operationId}.response.statusCodes`);
  if (!(response.mediaType === null || typeof response.mediaType === "string")) throw new Error(`${operationId}.response.mediaType must be string or null`);
  if (response.schema !== null) validateSchemaValue(response.schema, `${operationId}.response.schema`);
  const variants = requireArray(response.variants, `${operationId}.response.variants`);
  const variantStatuses: string[] = [];
  const successfulTypes = new Set<string>();
  for (const [index, value] of variants.entries()) {
    const variant = requireRecord(value, `${operationId}.response.variants[${index}]`);
    assertKeys(variant, `${operationId}.response.variant`, ["statusCode", "content", "headers"], ["sourceFiles", "body"]);
    const status = requireString(variant.statusCode, `${operationId}.response.statusCode`);
    if (status !== "default" && !/^[1-5](?:\d{2}|XX)$/.test(status)) throw new Error(`${operationId}.response has unsupported status ${status}`);
    if (variant.body !== undefined && variant.body !== "empty") throw new Error(`${operationId}.response.body must be empty when present`);
    variantStatuses.push(status);
    if (variant.sourceFiles !== undefined) stringList(variant.sourceFiles, `${operationId}.response.sourceFiles`);
    const content = requireArray(variant.content, `${operationId}.response.content`);
    for (const [contentIndex, item] of content.entries()) {
      const contentVariant = requireRecord(item, `${operationId}.response.content[${contentIndex}]`);
      assertKeys(contentVariant, `${operationId}.response.contentVariant`, ["mediaType", "schema"], ["sourceFile"]);
      const mediaType = requireString(contentVariant.mediaType, `${operationId}.response.mediaType`);
      if (contentVariant.sourceFile !== undefined) {
        const sourceFile = requireString(contentVariant.sourceFile, `${operationId}.response.content.sourceFile`);
        if (!/^(?:src|packages)\/.+\.tsx?$/.test(sourceFile)) throw new Error(`${operationId}.response content source must identify a pinned source file`);
      }
      if (contentVariant.schema !== null) validateSchemaValue(contentVariant.schema, `${operationId}.response.content.schema`);
      if (/^2(?:\d{2}|XX)$/.test(status)) successfulTypes.add(mediaType);
    }
    const headers = requireRecord(variant.headers, `${operationId}.response.headers`);
    for (const [name, headerValue] of Object.entries(headers)) {
      const header = requireRecord(headerValue, `${operationId}.response.headers.${name}`);
      assertKeys(header, `${operationId}.response.header`, ["required", "schema"]);
      if (typeof header.required !== "boolean") throw new Error(`${operationId}.response.headers.${name}.required must be boolean`);
      if (header.schema !== null) validateSchemaValue(header.schema, `${operationId}.response.headers.${name}.schema`);
    }
  }
  if (canonicalJson(toJson(statusCodes, "response.statusCodes")) !== canonicalJson(toJson(variantStatuses, "response.variantStatuses"))) {
    throw new Error(`${operationId}.response.statusCodes must exactly match response variants`);
  }
  const expectedMedia = successfulTypes.size === 1 ? [...successfulTypes][0] : null;
  if (response.mediaType !== expectedMedia) throw new Error(`${operationId}.response.mediaType must summarize successful response variants`);

  const base = requireRecord(baseValue, `${operationId}.base.response`);
  const baseVariants = requireArray(base.variants, `${operationId}.base.response.variants`);
  const expectedStatuses = baseVariants.map(item => requireRecord(item, "base response variant").statusCode);
  if (canonicalJson(toJson(variantStatuses, "response statuses")) !== canonicalJson(toJson(expectedStatuses, "base response statuses"))) {
    throw new Error(`${operationId}.contract drops or changes a documented or source-derived response status`);
  }
  for (const [index, item] of variants.entries()) {
    const actual = requireRecord(item, "response variant");
    const expected = requireRecord(baseVariants[index], "base response variant");
    if (actual.body !== expected.body) throw new Error(`${operationId}.contract alters source-derived response body evidence`);
    const actualTypes = requireArray(actual.content, "response variant content")
      .map(content => requireRecord(content, "response content variant").mediaType);
    const expectedTypes = requireArray(expected.content, "base response content")
      .map(content => requireRecord(content, "base response content variant").mediaType);
    if (canonicalJson(toJson(actualTypes, "response media types")) !== canonicalJson(toJson(expectedTypes, "base response media types"))) {
      throw new Error(`${operationId}.contract drops or changes a documented or source-derived response media type`);
    }
    if (canonicalJson(toJson(actual.sourceFiles ?? null, "response variant sourceFiles")) !== canonicalJson(toJson(expected.sourceFiles ?? null, "base response variant sourceFiles"))) {
      throw new Error(`${operationId}.contract alters response status source provenance`);
    }
    const actualContent = requireArray(actual.content, "response content");
    const expectedContent = requireArray(expected.content, "base response content");
    for (const [contentIndex, contentValue] of actualContent.entries()) {
      const actualContentRecord = requireRecord(contentValue, "response content variant");
      const expectedContentRecord = requireRecord(expectedContent[contentIndex], "base response content variant");
      if (canonicalJson(toJson(actualContentRecord.sourceFile ?? null, "response content sourceFile"))
        !== canonicalJson(toJson(expectedContentRecord.sourceFile ?? null, "base response content sourceFile"))) {
        throw new Error(`${operationId}.contract alters response media source provenance`);
      }
    }
  }
}

function validateFieldMappings(value: unknown, label: string): void {
  for (const [index, item] of requireArray(value, label).entries()) {
    const mapping = requireRecord(item, `${label}[${index}]`);
    assertKeys(mapping, `${label}[${index}]`, ["target", "source"]);
    const target = requireRecord(mapping.target, `${label}[${index}].target`);
    assertKeys(target, `${label}[${index}].target`, ["section", "field"]);
    if (!["path", "query"].includes(String(target.section))) throw new Error(`${label}[${index}] has unsupported target section`);
    requireString(target.field, `${label}[${index}].target.field`);
    const source = requireRecord(mapping.source, `${label}[${index}].source`);
    assertKeys(source, `${label}[${index}].source`, ["section", "path"]);
    if (!["path", "query", "body", "result"].includes(String(source.section))) throw new Error(`${label}[${index}] has unsupported source section`);
    if (!Array.isArray(source.path) || source.path.some(part => typeof part !== "string")) throw new Error(`${label}[${index}].source.path must be string array`);
  }
}

function validateReconciliation(value: unknown, operationId: string): void {
  if (value === null) return;
  const relation = requireRecord(value, `${operationId}.contract.reconciliation`);
  assertKeys(relation, `${operationId}.reconciliation`, ["targetRead", "reconcile"]);
  const targetRead = requireRecord(relation.targetRead, `${operationId}.reconciliation.targetRead`);
  assertKeys(targetRead, `${operationId}.targetRead`, ["operationId", "inputs", "snapshot"], ["sourceView"]);
  requireString(targetRead.operationId, `${operationId}.targetRead.operationId`);
  validateFieldMappings(targetRead.inputs, `${operationId}.targetRead.inputs`);
  const snapshot = requireRecord(targetRead.snapshot, `${operationId}.targetRead.snapshot`);
  assertKeys(snapshot, `${operationId}.targetRead.snapshot`, ["kind", "identity", "state"], ["collectionPath", "selection"]);
  if (!["resource", "collection", "action"].includes(String(snapshot.kind))) throw new Error(`${operationId}.targetRead.snapshot.kind is invalid`);
  for (const field of ["identity", "state"]) {
    for (const [index, value] of requireArray(snapshot[field], `${operationId}.targetRead.snapshot.${field}`).entries()) {
      const projected = requireRecord(value, `${operationId}.snapshot.${field}[${index}]`);
      assertKeys(projected, `${operationId}.snapshot.${field}[${index}]`, ["name", "path"], ["sourceView"]);
      requireString(projected.name, `${operationId}.snapshot.${field}.name`);
      stringList(projected.path, `${operationId}.snapshot.${field}.path`);
      if (projected.sourceView !== undefined) {
        const binding = sourceStateViewBinding(projected.sourceView);
        if (field !== "state" || !binding || binding.section !== "body" || binding.readMethod !== "GET"
          || targetRead.operationId !== `${binding.readMethod} ${binding.pathTemplate}`) {
          throw new Error(`${operationId}.snapshot source state view does not match its closed target read`);
        }
      }
    }
  }
  if (snapshot.collectionPath !== undefined) stringList(snapshot.collectionPath, `${operationId}.targetRead.snapshot.collectionPath`, true);
  if (snapshot.selection !== undefined) {
    const selection = requireRecord(snapshot.selection, `${operationId}.targetRead.snapshot.selection`);
    assertKeys(selection, `${operationId}.targetRead.snapshot.selection`, ["input", "rowPath"]);
    const input = requireRecord(selection.input, `${operationId}.targetRead.snapshot.selection.input`);
    assertKeys(input, `${operationId}.selection.input`, ["section", "path"]);
    if (!["path", "query", "body"].includes(String(input.section))) throw new Error(`${operationId}.selection.input.section is invalid`);
    stringList(input.path, `${operationId}.selection.input.path`, true);
    stringList(selection.rowPath, `${operationId}.selection.rowPath`, true);
  }
  const reconciliation = requireRecord(relation.reconcile, `${operationId}.reconciliation.reconcile`);
  assertKeys(reconciliation, `${operationId}.reconcile`, ["operationId", "inputs", "outcome"]);
  requireString(reconciliation.operationId, `${operationId}.reconcile.operationId`);
  validateFieldMappings(reconciliation.inputs, `${operationId}.reconcile.inputs`);
  const outcome = requireRecord(reconciliation.outcome, `${operationId}.reconcile.outcome`);
  assertKeys(outcome, `${operationId}.reconcile.outcome`, ["kind", "identityFields", "stateFields"], ["expectedFromInput"]);
  if (!["exists", "absent", "matches", "upsert"].includes(String(outcome.kind))) throw new Error(`${operationId}.reconcile.outcome.kind is invalid`);
  if (targetRead.sourceView !== undefined
    && !sourceRelationViewMatches(targetRead.sourceView, operationId, targetRead.operationId, reconciliation.operationId, outcome.kind)) {
    throw new Error(`${operationId}.targetRead source relation view does not match its exact mutation and read operations`);
  }
  stringList(outcome.identityFields, `${operationId}.reconcile.identityFields`);
  stringList(outcome.stateFields, `${operationId}.reconcile.stateFields`);
  if (outcome.expectedFromInput !== undefined) {
    for (const [index, item] of requireArray(outcome.expectedFromInput, `${operationId}.reconcile.expectedFromInput`).entries()) {
      const expected = requireRecord(item, `${operationId}.expectedFromInput[${index}]`);
      assertKeys(expected, `${operationId}.expectedFromInput[${index}]`, ["name", "source"], ["sourceView"]);
      requireString(expected.name, `${operationId}.expectedFromInput.name`);
      const source = requireRecord(expected.source, `${operationId}.expectedFromInput.source`);
      assertKeys(source, `${operationId}.expectedFromInput.source`, ["section", "path"]);
      if (!["path", "query", "body"].includes(String(source.section))) throw new Error(`${operationId}.expectedFromInput.source.section is invalid`);
      const path = stringList(source.path, `${operationId}.expectedFromInput.source.path`);
      if (expected.sourceView !== undefined) {
        const binding = sourceStateViewBinding(expected.sourceView);
        const fields = requireArray(snapshot.state, `${operationId}.snapshot.state`).map(value => requireRecord(value, `${operationId}.snapshot.state field`));
        const field = fields.find(field => field.name === expected.name);
        if (!binding || binding.section !== "body" || binding.readMethod !== "GET"
          || !matchesSourceOperationBinding(operationId, binding.methods, binding.pathTemplate)
          || reconciliation.operationId !== `${binding.readMethod} ${binding.pathTemplate}`
          || field?.sourceView !== expected.sourceView || source.section !== "body" || path.length !== 0) {
          throw new Error(`${operationId}.expected source state view does not match its closed mutation`);
        }
      }
    }
  }
}

function validateReadCompleteness(value: unknown, operationId: string, readId: string): void {
  const proof = requireRecord(value, `${operationId}.readCompleteness`);
  if (proof.kind === "single-response") {
    assertKeys(proof, `${operationId}.readCompleteness`, ["kind", "sourceReason"]);
  } else if (proof.kind === "unpaginated-list") {
    assertKeys(proof, `${operationId}.readCompleteness`, ["kind", "sourceReason", "itemsPath", "totalPath", "identityPaths"]);
    stringList(proof.itemsPath, `${operationId}.readCompleteness.itemsPath`, true);
    stringList(proof.totalPath, `${operationId}.readCompleteness.totalPath`, true);
    const identities = requireArray(proof.identityPaths, `${operationId}.readCompleteness.identityPaths`);
    if (identities.length === 0 || identities.length > 4) throw new Error(`${operationId}.readCompleteness identity path count is invalid`);
    for (const path of identities) stringList(path, `${operationId}.readCompleteness.identityPath`, true);
    if (!sourceUnpaginatedListProofMatches(readId, proof, operationId)) throw new Error(`${operationId}.readCompleteness does not match a pinned complete list source`);
  } else throw new Error(`${operationId}.readCompleteness kind is unsupported`);
  requireString(proof.sourceReason, `${operationId}.readCompleteness.sourceReason`);
}

function validateMutationSafety(value: unknown, operationId: string, sideEffect: unknown, responseValue: unknown): void {
  if (value === null) {
    if (sideEffect !== "read" && sideEffect !== "unknown") throw new Error(`${operationId}.mutationSafety is required for mutations`);
    return;
  }
  if (sideEffect === "read") throw new Error(`${operationId}.read operation cannot carry mutation safety`);
  const safety = requireRecord(value, `${operationId}.mutationSafety`);
  assertKeys(safety, `${operationId}.mutationSafety`, ["preflight", "reconciliation", "settlement"]);
  const preflight = requireRecord(safety.preflight, `${operationId}.preflight`);
  if (preflight.kind === "required") {
    assertKeys(preflight, `${operationId}.preflight`, ["kind", "observations"], ["visibilityLimits"]);
    const observations = requireArray(preflight.observations, `${operationId}.observations`);
    if (observations.length < 1 || observations.length > 16) throw new Error(`${operationId}.preflight observation count is invalid`);
    if (preflight.visibilityLimits !== undefined) {
      const visibilityLimits = requireArray(preflight.visibilityLimits, `${operationId}.preflight.visibilityLimits`);
      if (visibilityLimits.length < 1 || visibilityLimits.length > 16) throw new Error(`${operationId}.preflight visibility limit count is invalid`);
      for (const [index, value] of visibilityLimits.entries()) {
        const limit = requireString(value, `${operationId}.preflight.visibilityLimits[${index}]`);
        if (limit.trim().length === 0 || limit.length > 500 || /[\u0000-\u001f\u007f]/.test(limit)) {
          throw new Error(`${operationId}.preflight visibility limit is empty, oversized, or contains control characters`);
        }
      }
    }
    const names = new Set<string>();
    for (const observationValue of observations) {
      const observation = requireRecord(observationValue, `${operationId}.observation`);
      assertKeys(observation, `${operationId}.observation`, ["name", "read", "readCompleteness"]);
      const name = requireString(observation.name, `${operationId}.observation.name`);
      const read = requireRecord(observation.read, `${operationId}.observation.read`);
      validateReadCompleteness(observation.readCompleteness, operationId, requireString(read.operationId, `${operationId}.observation.read.operationId`));
      if (names.has(name)) throw new Error(`${operationId}.observation name is duplicated`);
      names.add(name);
      if (read.sourceView !== undefined && !sourcePreflightViewMatches(read.sourceView, operationId, read.operationId)) {
        throw new Error(`${operationId}.source relation preflight does not match its exact mutation and read operation`);
      }
      const { sourceView: _sourceView, ...plainRead } = read;
      validateReconciliation({ targetRead: plainRead, reconcile: { operationId: read.operationId, inputs: [], outcome: { kind: "matches", identityFields: [], stateFields: [] } } }, operationId);
    }
  } else if (preflight.kind === "not-applicable") {
    assertKeys(preflight, `${operationId}.preflight`, ["kind", "sourceReason"]);
    requireString(preflight.sourceReason, `${operationId}.preflight.sourceReason`);
  } else if (preflight.kind === "unavailable") {
    assertKeys(preflight, `${operationId}.preflight`, ["kind", "reason"]);
    requireString(preflight.reason, `${operationId}.preflight.reason`);
  } else throw new Error(`${operationId}.preflight kind is invalid`);
  const reconciliation = requireRecord(safety.reconciliation, `${operationId}.mutationSafety.reconciliation`);
  if (reconciliation.kind === "unknown") assertKeys(reconciliation, `${operationId}.mutationSafety.reconciliation`, ["kind"]);
  else if (reconciliation.kind === "complete") {
    assertKeys(reconciliation, `${operationId}.mutationSafety.reconciliation`, ["kind", "postconditions"]);
    const postconditions = requireArray(reconciliation.postconditions, `${operationId}.postconditions`);
    if (postconditions.length < 1 || postconditions.length > 16) throw new Error(`${operationId}.postcondition count is invalid`);
    const names = new Set<string>();
    for (const value of postconditions) {
      const item = requireRecord(value, `${operationId}.postcondition`);
      assertKeys(item, `${operationId}.postcondition`, ["name", "relation", "readCompleteness"]);
      const name = requireString(item.name, `${operationId}.postcondition.name`);
      const relation = requireRecord(item.relation, `${operationId}.postcondition.relation`);
      const targetRead = requireRecord(relation.targetRead, `${operationId}.postcondition.targetRead`);
      validateReadCompleteness(item.readCompleteness, operationId, requireString(targetRead.operationId, `${operationId}.postcondition.targetRead.operationId`));
      if (names.has(name)) throw new Error(`${operationId}.postcondition name is duplicated`);
      names.add(name);
      validateReconciliation(item.relation, operationId);
    }
  } else throw new Error(`${operationId}.reconciliation kind is invalid`);
  const settlement = requireRecord(safety.settlement, `${operationId}.settlement`);
  assertKeys(settlement, `${operationId}.settlement`, ["responseComplete", "definiteRejection"]);
  const responseComplete = requireRecord(settlement.responseComplete, `${operationId}.responseComplete`);
  assertKeys(responseComplete, `${operationId}.responseComplete`, ["statusCodes"]);
  const statuses = requireArray(responseComplete.statusCodes, `${operationId}.responseComplete.statusCodes`);
  if (new Set(statuses).size !== statuses.length || statuses.some(status => !Number.isInteger(status) || Number(status) < 200 || Number(status) > 299)) throw new Error(`${operationId}.responseComplete status is invalid`);
  const response = requireRecord(responseValue, `${operationId}.response`);
  const declared = new Set(requireArray(response.statusCodes, `${operationId}.response.statusCodes`));
  if (statuses.some(status => !declared.has(String(status)))) throw new Error(`${operationId}.responseComplete status is not source declared`);
  if (settlement.definiteRejection !== null) throw new Error(`${operationId}.definiteRejection has no reviewed source classifier`);
}

function validateSourceAuthorizationPolicy(value: unknown, domain: string, operationId: string): void {
  const policy = requireRecord(value, `${operationId}.contract.auth.sourcePolicy`);
  if (policy.status !== "qualified" || policy.source !== "omniroute-v3.8.53") {
    throw new Error(`${operationId}.contract.auth.sourcePolicy must be qualified against the pinned source`);
  }
  const routeClass = requireString(policy.routeClass, `${operationId}.auth.sourcePolicy.routeClass`);
  const alternatives = requireArray(policy.alternatives, `${operationId}.auth.sourcePolicy.alternatives`);
  if (alternatives.length === 0) throw new Error(`${operationId}.auth.sourcePolicy.alternatives cannot be empty`);
  const managementKinds = ["management-api-key", "dashboard-session", "auth-disabled", "oma-access-token", "oma-whoami-bootstrap", "mcp-connect", "runtime-api-key", "metadata-api-key", "trusted-local"];
  const clientKinds = ["runtime-api-key", "metadata-api-key", "anonymous"];
  const allowedKinds = routeClass === "management" ? managementKinds : routeClass === "client-api" ? clientKinds
    : routeClass === "public" ? ["anonymous"] : routeClass === "local" ? ["trusted-local"] : [];
  if (allowedKinds.length === 0) throw new Error(`${operationId}.auth.sourcePolicy.routeClass is unsupported`);
  for (const [index, item] of alternatives.entries()) {
    const alternative = requireRecord(item, `${operationId}.auth.sourcePolicy.alternatives[${index}]`);
    const kind = requireString(alternative.kind, `${operationId}.auth.sourcePolicy.alternatives[${index}].kind`);
    if (!allowedKinds.includes(kind)) throw new Error(`${operationId}.auth.sourcePolicy alternative is invalid for ${routeClass}`);
    switch (kind) {
      case "management-api-key": {
        assertKeys(alternative, `${operationId}.sourcePolicy`, ["kind", "anyOf"]);
        const scopes = stringList(alternative.anyOf, `${operationId}.auth.sourcePolicy.management-api-key.anyOf`, true);
        if (scopes.some(scope => !["manage", "admin"].includes(scope))) throw new Error(`${operationId}.auth.sourcePolicy management key scopes are invalid`);
        break;
      }
      case "dashboard-session":
      case "anonymous":
        assertKeys(alternative, `${operationId}.sourcePolicy`, ["kind"]);
        break;
      case "auth-disabled":
        assertKeys(alternative, `${operationId}.sourcePolicy`, ["kind", "when"]);
        if (alternative.when !== "central-and-handler-auth-not-required") {
          throw new Error(`${operationId}.auth.sourcePolicy conditional authorization must retain its server-enforced condition`);
        }
        break;
      case "oma-access-token": {
        assertKeys(alternative, `${operationId}.sourcePolicy`, ["kind", "minimumScope"]);
        const separator = operationId.indexOf(" ");
        if (alternative.minimumScope !== requiredOmaScope(operationId.slice(0, separator), operationId.slice(separator + 1))) {
          throw new Error(`${operationId}.auth.sourcePolicy OMA scope differs from pinned source policy`);
        }
        break;
      }
      case "oma-whoami-bootstrap":
        assertKeys(alternative, `${operationId}.sourcePolicy`, ["kind", "operationId"]);
        if (alternative.operationId !== "GET /api/cli/whoami") throw new Error(`${operationId}.auth.sourcePolicy OMA bootstrap ID is invalid`);
        break;
      case "mcp-connect":
        assertKeys(alternative, `${operationId}.sourcePolicy`, ["kind", "pathPrefix", "handlerOptIn"]);
        if (alternative.pathPrefix !== "/api/mcp/" || alternative.handlerOptIn !== true || !operationId.endsWith("/api/mcp/") && !operationId.includes("/api/mcp/")) {
          throw new Error(`${operationId}.auth.sourcePolicy MCP exception is not bound to its opted-in route`);
        }
        break;
      case "runtime-api-key":
      case "metadata-api-key":
        assertKeys(alternative, `${operationId}.sourcePolicy`, ["kind", "sourceScopes"]);
        stringList(alternative.sourceScopes, `${operationId}.auth.sourcePolicy.${kind}.sourceScopes`);
        break;
      case "trusted-local":
        assertKeys(alternative, `${operationId}.sourcePolicy`, ["kind", "loopbackOnly"]);
        if (alternative.loopbackOnly !== true) throw new Error(`${operationId}.auth.sourcePolicy trusted-local boundary must be loopback-only`);
        break;
    }
  }
  if (routeClass === "management") {
    assertKeys(policy, `${operationId}.sourcePolicy`, ["status", "source", "routeClass", "localOnly", "handlerGuard", "bootstrap", "alternatives"]);
    if (typeof policy.localOnly !== "boolean" || !["none", "requireManagementAuth"].includes(String(policy.handlerGuard))
      || !["none", "oma-whoami"].includes(String(policy.bootstrap))) throw new Error(`${operationId}.auth.sourcePolicy management fields are invalid`);
    const bootstrapCount = alternatives.filter(item => isRecord(item) && item.kind === "oma-whoami-bootstrap").length;
    if (policy.bootstrap === "oma-whoami") {
      if (operationId !== "GET /api/cli/whoami" || bootstrapCount !== 1) throw new Error(`${operationId}.auth.sourcePolicy bootstrap is not the exact whoami operation`);
    } else if (bootstrapCount !== 0 || operationId === "GET /api/cli/whoami") {
      throw new Error(`${operationId}.auth.sourcePolicy whoami must use its non-recursive bootstrap alternative`);
    }
  } else if (routeClass === "client-api") {
    assertKeys(policy, `${operationId}.sourcePolicy`, ["status", "source", "routeClass", "localOnly", "alternatives"]);
    if (typeof policy.localOnly !== "boolean") throw new Error(`${operationId}.auth.sourcePolicy client API localOnly must be boolean`);
  } else if (routeClass === "public") {
    assertKeys(policy, `${operationId}.sourcePolicy`, ["status", "source", "routeClass", "alternatives"]);
    if (alternatives.length !== 1) throw new Error(`${operationId}.auth.sourcePolicy public route must have one anonymous alternative`);
  } else {
    assertKeys(policy, `${operationId}.sourcePolicy`, ["status", "source", "routeClass", "localOnly", "alternatives"]);
    if (policy.localOnly !== true || alternatives.length !== 1) throw new Error(`${operationId}.auth.sourcePolicy local route must be loopback-only`);
  }
  const has = (kind: string): boolean => alternatives.some(item => isRecord(item) && item.kind === kind);
  const compatible = domain === "management"
    ? routeClass === "management" && ["management-api-key", "dashboard-session", "oma-access-token", "oma-whoami-bootstrap", "mcp-connect", "trusted-local"].some(has)
    : domain === "runtime"
      ? ["client-api", "management"].includes(routeClass) && has("runtime-api-key")
      : domain === "metadata"
        ? ["client-api", "management"].includes(routeClass) && has("metadata-api-key")
        : domain === "public"
          ? routeClass === "public" && has("anonymous")
          : routeClass === "local" || (routeClass === "management" && has("trusted-local"));
  if (!compatible) throw new Error(`${operationId}.auth.sourcePolicy alternatives do not match credential domain ${domain}`);
}

function validateOperationContract(value: unknown, base: RecordValue, operationId: string, routeFile: string): RecordValue {
  const contract = requireRecord(toJson(value, `${operationId}.contract`), `${operationId}.contract`);
  assertKeys(contract, `${operationId}.contract`, OPERATION_CONTRACT_FIELDS);
  validateRequestContract(contract.request, base.request, operationId, routeFile);
  const auth = requireRecord(contract.auth, `${operationId}.contract.auth`);
  assertKeys(auth, `${operationId}.contract.auth`, ["domain", "specificationAlternatives", "sourcePolicy"]);
  const domain = requireString(auth.domain, `${operationId}.contract.auth.domain`);
  if (!["public", "runtime", "metadata", "management", "local"].includes(domain)) throw new Error(`${operationId}.contract.auth.domain must be source-qualified`);
  validateSourceAuthorizationPolicy(auth.sourcePolicy, domain, operationId);
  const baseAuth = requireRecord(base.auth, `${operationId}.base.auth`);
  if (canonicalJson(toJson(auth.specificationAlternatives, `${operationId}.auth.specificationAlternatives`))
    !== canonicalJson(toJson(baseAuth.specificationAlternatives, `${operationId}.base.auth.specificationAlternatives`))) {
    throw new Error(`${operationId}.contract cannot rewrite OpenAPI security alternatives`);
  }
  validateResponseContract(contract.response, base.response, operationId);
  const secrets = requireRecord(contract.secrets, `${operationId}.contract.secrets`);
  assertKeys(secrets, `${operationId}.contract.secrets`, ["inputFields", "outputFields"]);
  stringList(secrets.inputFields, `${operationId}.secrets.inputFields`);
  stringList(secrets.outputFields, `${operationId}.secrets.outputFields`);
  if (!["read", "mutation", "secret", "lifecycle", "destructive", "unknown"].includes(String(contract.sideEffect))) {
    throw new Error(`${operationId}.contract.sideEffect is invalid`);
  }
  const pagination = requireRecord(contract.pagination, `${operationId}.contract.pagination`);
  assertKeys(pagination, `${operationId}.contract.pagination`, ["mode", "parameters"]);
  if (!["none", "offset", "cursor", "unknown"].includes(String(pagination.mode))) throw new Error(`${operationId}.pagination.mode is invalid`);
  stringList(pagination.parameters, `${operationId}.pagination.parameters`);
  const streaming = requireRecord(contract.streaming, `${operationId}.contract.streaming`);
  assertKeys(streaming, `${operationId}.contract.streaming`, ["mode", "framing"]);
  if (!["json", "text", "sse", "websocket", "binary", "unknown"].includes(String(streaming.mode))) throw new Error(`${operationId}.streaming.mode is invalid`);
  requireString(streaming.framing, `${operationId}.streaming.framing`);
  const confirmation = requireRecord(contract.confirmation, `${operationId}.contract.confirmation`);
  assertKeys(confirmation, `${operationId}.contract.confirmation`, ["required", "reason"]);
  if (typeof confirmation.required !== "boolean") throw new Error(`${operationId}.confirmation.required must be boolean`);
  requireString(confirmation.reason, `${operationId}.confirmation.reason`);
  const retry = requireRecord(contract.retry, `${operationId}.contract.retry`);
  assertKeys(retry, `${operationId}.contract.retry`, ["allowed", "maxAttempts", "statusCodes"]);
  if (typeof retry.allowed !== "boolean" || typeof retry.maxAttempts !== "number" || !Number.isInteger(retry.maxAttempts)
    || retry.maxAttempts < 1 || retry.maxAttempts > 2) throw new Error(`${operationId}.retry policy is invalid`);
  const retryStatuses = requireArray(retry.statusCodes, `${operationId}.retry.statusCodes`);
  if (retryStatuses.some(status => typeof status !== "number" || !Number.isInteger(status) || status < 100 || status > 599)) {
    throw new Error(`${operationId}.retry.statusCodes must be HTTP status integers`);
  }
  if (!retry.allowed && (retry.maxAttempts !== 1 || retryStatuses.length > 0)) throw new Error(`${operationId}.disabled retry must have one attempt and no statuses`);
  validateReconciliation(contract.reconciliation, operationId);
  validateMutationSafety(contract.mutationSafety, operationId, contract.sideEffect, contract.response);
  return contract;
}

function makeOperation(
  manifest: RecordValue,
  route: RecordValue,
  method: Method,
  eligibility: Map<string, RecordValue>,
  frameworkContextSha256: string,
  centralIngress: CentralIngressContext,
  explicitContract?: unknown,
  requireContract = false,
): RecordValue {
  const sourceTemplate = requireString(route.routeTemplate, `${String(route.sourceFile)}.routeTemplate`);
  const path = sourceTemplate.replace(/\*([A-Za-z0-9._~-]+)/g, "{$1}");
  if (normalizeNextRoutePath(requireString(route.sourceFile, "route.sourceFile")) !== sourceTemplate) throw new Error(`route template drift: ${String(route.sourceFile)}`);
  const operationId = `${method} ${path}`;
  const spec = specificationFor(manifest, method, path);
  const parameters = spec ? mergedParameters(spec, requireRecord(manifest.openapi, "manifest.openapi"), operationId) : [];
  const sourceQueryParameters = sourceQueryParameterHints(route, method, operationId);
  for (const sourceParameter of sourceQueryParameters) {
    const name = requireString(sourceParameter.name, `${operationId}.sourceQueryParameter.name`);
    const existing = parameters.find(parameter => parameter.in === "query" && parameter.name === name);
    if (existing) throw new Error(`${operationId} has both OpenAPI and source-only declarations for query parameter ${name}`);
    parameters.push(sourceParameter);
  }
  const sourceParams = sourcePathParameters(route);
  const pathProperties: Record<string, Json> = {};
  const pathRequired: string[] = [];
  const specPathNames = spec ? [...requireString(spec.path, `${operationId}.spec.path`).matchAll(/\{([^}]+)\}/g)].map(match => match[1]!).filter(Boolean) : [];
  if (spec && specPathNames.length !== sourceParams.length) throw new Error(`OpenAPI path parameter count differs from source: ${operationId}`);
  const pathParameters: Json[] = [];
  let sourcePathSchemaMissing = false;
  sourceParams.forEach((parameter, index) => {
    const specName = specPathNames[index];
    const documented = parameters.find(candidate => candidate.in === "path" && candidate.name === specName);
    const pathHint = parameter.catchAll ? sourcePathSchemaHint(route, method, parameter.name) : undefined;
    if (spec && !documented && !parameter.catchAll) sourcePathSchemaMissing = true;
    const style = documented === undefined || parameter.catchAll ? "simple" : requireString(documented.style, `${operationId}.path.${parameter.name}.style`);
    if (!["simple", "label", "matrix"].includes(style)) throw new Error(`${operationId}.path.${parameter.name} has unsupported path serialization ${style}`);
    let explode = false;
    if (documented !== undefined && !parameter.catchAll) {
      if (typeof documented.explode !== "boolean") throw new Error(`${operationId}.path.${parameter.name}.explode must be boolean`);
      explode = documented.explode;
    }
    const documentedSchema = documented === undefined ? undefined : toJson(documented.schema, `${operationId}.path.${parameter.name}.schema`);
    const sourceSegmentSchema: Json = { type: "string", minLength: 1 };
    pathProperties[parameter.name] = documentedSchema === undefined
      ? pathHint ?? sourceSegmentSchema
      : pathHint === undefined ? documentedSchema : { allOf: [documentedSchema, pathHint] };
    if (!parameter.optional) pathRequired.push(parameter.name);
    pathParameters.push(toJson({
      name: parameter.name,
      specName: specName ?? parameter.name,
      serialization: parameter.catchAll ? "catch-all-segments" : style,
      required: !parameter.optional,
      ...(documented === undefined || parameter.catchAll ? {} : { style, explode }),
    }, `${operationId}.pathParameters[${index}]`));
  });
  const pathSchema: Json = { type: "object", properties: pathProperties, additionalProperties: false, ...(pathRequired.length ? { required: [...new Set(pathRequired)].sort(compareText) } : {}) };
  const queryProperties: Record<string, Json> = {};
  const queryRequired: string[] = [];
  for (const parameter of parameters) {
    if (parameter.in === "query") {
      const name = requireString(parameter.name, `${operationId}.queryParameter.name`);
      queryProperties[name] = toJson(parameter.schema, `${operationId}.query.${name}.schema`);
      if (parameter.required) queryRequired.push(name);
    }
  }
  const querySchema: Json = { type: "object", properties: queryProperties, additionalProperties: false, ...(queryRequired.length ? { required: [...new Set(queryRequired)].sort(compareText) } : {}) };
  const body = requestBodyFor(spec, operationId);
  const normalizations = sourceRequestNormalizations(route, operationId);
  const request: Json = {
    pathSchema,
    querySchema,
    pathParameters,
    parameters: toJson(parameters, `${operationId}.parameters`),
    body,
    specificationDocumented: spec !== null,
    ...(normalizations === undefined ? {} : { normalizations }),
  };
  const responseHints = sourceResponseHints(route, operationId, centralIngress);
  const response = responseFor(spec, operationId, responseHints);
  const security = securityAlternatives(manifest, spec, operationId);
  const auth: Json = {
    domain: "unknown",
    specificationAlternatives: security,
    sourcePolicy: { status: "unknown" },
  };
  const specificationDiscrepancies = discrepancies(path, spec, sourcePathSchemaMissing);
  for (const parameter of sourceQueryParameters) {
    specificationDiscrepancies.push({
      code: "source-query-parameter-not-documented",
      authority: "source",
      detail: `${String(parameter.sourceFile)} reads optional query parameter ${String(parameter.name)}; its scalar form serialization and schema are derived from the handler and are not documented by OpenAPI.`,
    });
  }
  const documentedResponses = spec ? requireRecord(spec.responses, `${operationId}.responses`) : {};
  for (const hint of responseHints) {
    const documentedResponse = documentedResponses[hint.statusCode];
    const documentedContent = isRecord(documentedResponse) && isRecord(documentedResponse.content)
      ? documentedResponse.content
      : {};
    if (!Object.prototype.hasOwnProperty.call(documentedContent, hint.mediaType)) {
      specificationDiscrepancies.push({
        code: "source-response-status-or-media-not-documented",
        authority: "source",
        detail: `${hint.sourceFiles.join(", ")} establishes HTTP ${hint.statusCode} with ${hint.mediaType}; this source-derived status/media variant is preserved alongside OpenAPI declarations.`,
      });
    }
  }
  for (const [alternativeIndex, alternative] of security.entries()) {
    for (const [schemeIndex, value] of requireArray(alternative, `${operationId}.securityAlternatives[${alternativeIndex}]`).entries()) {
      const scheme = requireRecord(value, `${operationId}.securityAlternatives[${alternativeIndex}][${schemeIndex}]`);
      if (scheme.unresolved === true) {
        specificationDiscrepancies.push({
          code: "unresolved-security-scheme",
          authority: "specification",
          detail: `OpenAPI security requirement names undeclared scheme ${String(scheme.name)}; its form is preserved as unresolved and is not inferred.`,
        });
      }
    }
  }
  const routeClass = requireString(route.classification, `${String(route.sourceFile)}.classification`);
  const reason = routeClass === "source-justified-non-invokable"
    ? requireString(route.classificationReason, `${String(route.sourceFile)}.classificationReason`)
    : "No operation-specific source-bound request/auth/side-effect/response behavior test is recorded.";
  const responseRecord = requireRecord(response, `${operationId}.response`);
  const responseVariants = requireArray(responseRecord.variants, `${operationId}.response.variants`);
  const responseMediaType = responseRecord.mediaType === null ? null : requireString(responseRecord.mediaType, `${operationId}.response.mediaType`);
  const requestRecord = requireRecord(request, `${operationId}.request`);
  const bodyRecord = requestRecord.body === null ? null : requireRecord(requestRecord.body, `${operationId}.request.body`);
  const requestMediaType = bodyRecord === null || bodyRecord.mediaType === null ? null : requireString(bodyRecord.mediaType, `${operationId}.request.body.mediaType`);
  const base: RecordValue = {
    operationId,
    method,
    pathTemplate: path,
    ...(requireArray(route.resolvedImports, `${operationId}.resolvedImports`).includes("src/lib/db/core.ts") ? { databaseInitializationRequired: true } : {}),
    request,
    response,
    mediaType: { request: requestMediaType, response: responseMediaType },
    auth,
    secrets: { inputFields: [], outputFields: [] },
    sideEffect: "unknown",
    pagination: { mode: "none", parameters: [] },
    streaming: {
      mode: responseVariants.some(variant => isRecord(variant) && requireArray(variant.content, `${operationId}.response.content`).some(content => isRecord(content) && content.mediaType === "text/event-stream")) ? "sse" : "unknown",
      framing: responseVariants.some(variant => isRecord(variant) && requireArray(variant.content, `${operationId}.response.content`).some(content => isRecord(content) && content.mediaType === "text/event-stream")) ? "text/event-stream" : "behavior-unverified",
    },
    confirmation: { required: true, reason: "Source-side effect and auth behavior have not been operation-qualified." },
    retry: { allowed: false, maxAttempts: 1, statusCodes: [] },
    source: {
      file: route.sourceFile,
      sha256: route.sha256,
      gitBlobSha: route.gitBlobSha,
      export: requireArray(requireRecord(route.exports, `${String(route.sourceFile)}.exports`).direct, "route.exports.direct").includes(method) ? "direct" : "re-export",
    },
    specification: {
      documented: spec !== null,
      path: spec?.path ?? null,
      operationId: spec?.operationId ?? null,
      discrepancies: specificationDiscrepancies,
    },
    reconciliation: null,
    mutationSafety: method === "GET" || method === "HEAD" || method === "OPTIONS" ? null : {
      preflight: { kind: "unavailable", reason: "No source-qualified preflight observation is recorded." },
      reconciliation: { kind: "unknown" },
      settlement: { responseComplete: { statusCodes: [] }, definiteRejection: null },
    },
  };
  const eligibilityRecord = eligibility.get(operationId);
  if (routeClass === "source-justified-non-invokable" && (eligibilityRecord || explicitContract !== undefined)) {
    throw new Error(`source-justified non-invokable operation cannot carry qualification: ${operationId}`);
  }
  if (eligibilityRecord && !Object.prototype.hasOwnProperty.call(eligibilityRecord, "contract")) {
    throw new Error(`eligibility record has no source-reviewed operation contract: ${operationId}`);
  }
  const contractValue = explicitContract !== undefined ? explicitContract : eligibilityRecord?.contract;
  if (requireContract && contractValue === undefined) throw new Error(`operationEvidenceBinding requires a source-reviewed contract: ${operationId}`);
  const effective: RecordValue = contractValue === undefined
    ? base
    : { ...base, ...validateOperationContract(contractValue, base, operationId, requireString(route.sourceFile, `${operationId}.sourceFile`)) };
  if (eligibilityRecord && effective.sideEffect !== "read"
    && requireRecord(requireRecord(effective.mutationSafety, `${operationId}.mutationSafety`).preflight, `${operationId}.preflight`).kind === "unavailable") {
    throw new Error(`stored verified eligibility cannot promote a mutation with unavailable preflight: ${operationId}`);
  }
  const effectiveRequest = requireRecord(effective.request, `${operationId}.request`);
  const effectiveBody = effectiveRequest.body === null ? null : requireRecord(effectiveRequest.body, `${operationId}.request.body`);
  const effectiveResponse = requireRecord(effective.response, `${operationId}.response`);
  effective.mediaType = {
    request: effectiveBody === null || effectiveBody.mediaType === null ? null : requireString(effectiveBody.mediaType, `${operationId}.request.body.mediaType`),
    response: effectiveResponse.mediaType === null ? null : requireString(effectiveResponse.mediaType, `${operationId}.response.mediaType`),
  };
  const binding = bindingFor(effective, route, frameworkContextSha256, manifest);
  const effectiveAuth = requireRecord(effective.auth, `${operationId}.auth`);
  const effectivePolicy = requireRecord(effectiveAuth.sourcePolicy, `${operationId}.auth.sourcePolicy`);
  const verified = routeClass === "external" && effectivePolicy.status === "qualified"
    && validateEligibility(eligibilityRecord, operationId, route, binding);
  effective.coverage = routeClass === "source-justified-non-invokable"
    ? { status: "non-invokable", adapterId: null, reason }
    : verified
      ? { status: "invokable", adapterId: `typed.${method.toLowerCase()}.${path.toLowerCase().replace(/[^a-z0-9]+/g, ".").replace(/^\.|\.$/g, "")}`, reason: null }
      : { status: "unqualified", adapterId: null, reason };
  if (verified && eligibilityRecord) {
    const test = requireRecord(eligibilityRecord.test, `${operationId}.eligibility.test`);
    const release = requireRecord(manifest.release, "manifest.release");
    effective.qualification = {
      releaseCommit: requireString(release.commit, "manifest.release.commit"),
      binding: outcomeBindingFor(route, binding),
      test: {
        id: requireString(test.id, `${operationId}.eligibility.test.id`),
        caseSha256: requireString(test.caseSha256, `${operationId}.eligibility.test.caseSha256`),
        outcomeSha256: requireString(test.outcomeSha256, `${operationId}.eligibility.test.outcomeSha256`),
      },
      ...(operationRequiresIngressEvidence(operationId) ? { ingressSha256: requireRecord(eligibilityRecord.ingressEvidence, `${operationId}.ingressEvidence`).sha256 } : {}),
      ...(binding.databaseInitializationRequired ? { lifecycleSha256: requireRecord(eligibilityRecord.lifecycleEvidence, `${operationId}.lifecycleEvidence`).sha256 } : {}),
    };
  }
  return effective;
}
function validateClosedRelations(operations: readonly RecordValue[]): void {
  const byId = new Map(operations.map(operation => [String(operation.operationId), operation]));
  const requireRead = (operationId: string, relatedId: string, proof: unknown): void => {
    const related = byId.get(relatedId);
    if (!related || (related.method !== "GET" && related.method !== "HEAD")
      || requireRecord(related.coverage, `${relatedId}.coverage`).status !== "invokable") {
      throw new Error(`${operationId} references an unqualified or incomplete safety read: ${relatedId}`);
    }
    const pagination = requireRecord(related.pagination, `${relatedId}.pagination`);
    const completeness = requireRecord(proof, `${operationId}.readCompleteness`);
    if ((completeness.kind === "single-response" && pagination.mode !== "none")
      || (completeness.kind === "unpaginated-list"
        && (pagination.mode !== "offset" || !sourceUnpaginatedListProofMatches(relatedId, completeness, operationId)))) {
      throw new Error(`${operationId} references a safety read without a complete source proof: ${relatedId}`);
    }
  };
  for (const operation of operations) {
    const safety = operation.mutationSafety;
    if (safety !== null) {
      const contract = requireRecord(safety, `${String(operation.operationId)}.mutationSafety`);
      const preflight = requireRecord(contract.preflight, `${String(operation.operationId)}.preflight`);
      if (preflight.kind === "required") for (const value of requireArray(preflight.observations, "observations")) {
        const observation = requireRecord(value, "observation");
        const read = requireRecord(observation.read, "observation.read");
        requireRead(String(operation.operationId), requireString(read.operationId, "observation.read.operationId"), observation.readCompleteness);
      }
      const reconciliation = requireRecord(contract.reconciliation, "mutation reconciliation");
      if (reconciliation.kind === "complete") for (const value of requireArray(reconciliation.postconditions, "postconditions")) {
        const postcondition = requireRecord(value, "postcondition");
        const relation = requireRecord(postcondition.relation, "postcondition.relation");
        for (const key of ["targetRead", "reconcile"]) {
          const read = requireRecord(relation[key], `postcondition.${key}`);
          requireRead(String(operation.operationId), requireString(read.operationId, `postcondition.${key}.operationId`), postcondition.readCompleteness);
        }
      }
    }
    if (operation.reconciliation === null) continue;
    const relation = requireRecord(operation.reconciliation, `${String(operation.operationId)}.reconciliation`);
    for (const key of ["targetRead", "reconcile"] as const) {
      const side = requireRecord(relation[key], `${String(operation.operationId)}.reconciliation.${key}`);
      const relatedId = requireString(side.operationId, `${String(operation.operationId)}.reconciliation.${key}.operationId`);
      const related = byId.get(relatedId);
      if (!related) throw new Error(`${String(operation.operationId)} references a reconciliation operation outside the pinned inventory: ${relatedId}`);
      if (related.method !== "GET" && related.method !== "HEAD") throw new Error(`${String(operation.operationId)} reconciliation relation must reference a read operation: ${relatedId}`);
      if (requireRecord(related.coverage, `${relatedId}.coverage`).status !== "invokable") {
        throw new Error(`${String(operation.operationId)} reconciliation relation references an unqualified read operation: ${relatedId}`);
      }
    }
  }
}


export function generateOperations(manifestValue: unknown, eligibility = eligibilityRecords()): RecordValue {
  const manifest = requireRecord(manifestValue, "route source manifest");
  const routes = requireArray(manifest.routeFiles, "manifest.routeFiles").map((route, index) => requireRecord(route, `manifest.routeFiles[${index}]`));
  const framework = requireRecord(manifest.frameworkContext, "manifest.frameworkContext");
  const frameworkContextSha256 = requireString(framework.sha256, "manifest.frameworkContext.sha256");
  const centralIngress = validateCentralIngressContext(manifest, frameworkContextSha256);
  validateCentralResponseHintCoverage(routes, centralIngress);
  const operations: RecordValue[] = [];
  const seen = new Set<string>();
  for (const route of [...routes].sort((left, right) => compareText(String(left.sourceFile), String(right.sourceFile)))) {
    const exports = requireRecord(route.exports, `${String(route.sourceFile)}.exports`);
    for (const methodValue of requireArray(exports.resolved, `${String(route.sourceFile)}.exports.resolved`)) {
      const method = requireString(methodValue, "route export") as Method;
      if (!(METHODS as readonly string[]).includes(method)) throw new Error(`unsupported exported HTTP method ${method}`);
      const operation = makeOperation(manifest, route, method, eligibility, frameworkContextSha256, centralIngress);
      if (seen.has(operation.operationId as string)) throw new Error(`multiple source handlers map to ${String(operation.operationId)}; resolve the route ambiguity explicitly`);
      seen.add(operation.operationId as string);
      operations.push(operation);
    }
  }
  validateClosedRelations(operations);
  operations.sort((left, right) => compareText(String(left.operationId), String(right.operationId)));
  const methodCounts = Object.fromEntries(METHODS.map(method => [method, operations.filter(operation => operation.method === method).length]));
  const documentedOperations = operations.filter(operation => requireRecord(operation.specification, "operation.specification").documented === true).length;
  const nonInvokableOperations = operations.filter(operation => requireRecord(operation.coverage, "operation.coverage").status === "non-invokable").length;
  const invokableOperations = operations.filter(operation => requireRecord(operation.coverage, "operation.coverage").status === "invokable").length;
  const routeImportDigestEntries: [string, string][] = routes.map((route): [string, string] => [
    requireString(route.sourceFile, "route.sourceFile"),
    requireString(route.resolvedImportsSha256, `${String(route.sourceFile)}.resolvedImportsSha256`),
  ]);
  const sourceContext = {
    frameworkContextSha256,
    ...effectiveSourceBinding(manifest),
    routeImportDigests: Object.fromEntries(routeImportDigestEntries.sort(([left], [right]) => compareText(left, right))),
  };
  const openapi = requireRecord(manifest.openapi, "manifest.openapi");
  const discrepancies = requireRecord(manifest.discrepancies, "manifest.discrepancies");
  const sourceFiles = requireArray(requireRecord(manifest.sourceCorpus, "manifest.sourceCorpus").files, "manifest.sourceCorpus.files");
  const eligibilityJson = toJson(JSON.parse(readFileSync(eligibilityPath, "utf8")), "release eligibility");
  return {
    $schema: "./operations.schema.json",
    schemaVersion: 3,
    recordKind: "omniroute-operation-contract",
    release: toJson(manifest.release, "manifest.release"),
    generatedFrom: {
      manifest: "provenance/route-sources.json",
      manifestSha256: sha256(canonicalJson(toJson(manifest, "manifest"))),
      eligibility: "contracts/release-eligibility.json",
      eligibilitySha256: sha256(canonicalJson(eligibilityJson)),
      sourceCorpusFileCount: sourceFiles.length,
      authority: "pinned exported handler bytes/imports; framework policy context; OpenAPI as a separate specification source",
    },
    sourceContext,
    counts: {
      routeFiles: routes.length,
      sourceOperations: operations.length,
      openapiPaths: openapi.pathCount,
      openapiOperations: openapi.operationCount,
      documentedOperations,
      unmatchedSpecificationMethods: requireArray(discrepancies.specificationOnlyMethods, "specification-only methods").length,
      invokableOperations,
      nonInvokableOperations,
      unqualifiedOperations: operations.length - invokableOperations - nonInvokableOperations,
      methodCounts,
    },
    operations,
  };
}
function sourceOperationFor(operationId: string): {
  manifest: RecordValue;
  route: RecordValue;
  method: Method;
  frameworkContextSha256: string;
  centralIngress: CentralIngressContext;
} {
  const separator = operationId.indexOf(" ");
  if (separator < 1) throw new Error(`invalid operation ID: ${operationId}`);
  const methodValue = operationId.slice(0, separator);
  if (!(METHODS as readonly string[]).includes(methodValue)) throw new Error(`invalid operation method: ${methodValue}`);
  const method = methodValue as Method;
  const path = operationId.slice(separator + 1);
  const manifest = requireRecord(readRouteSources(manifestPath), "route source manifest");
  const routes = requireArray(manifest.routeFiles, "manifest.routeFiles").map((route, index) => requireRecord(route, `manifest.routeFiles[${index}]`));
  const matches = routes.filter(candidate => requireString(candidate.routeTemplate, `${String(candidate.sourceFile)}.routeTemplate`).replace(/\*([A-Za-z0-9._~-]+)/g, "{$1}") === path
    && requireArray(requireRecord(candidate.exports, `${String(candidate.sourceFile)}.exports`).resolved, "route exports").includes(method));
  if (matches.length !== 1) throw new Error(matches.length === 0
    ? `operation is absent from pinned source inventory: ${operationId}`
    : `operation maps ambiguously to pinned source handlers: ${operationId}`);
  const route = matches[0]!;
  if (route.classification !== "external") throw new Error(`source operation is not externally invokable: ${operationId}`);
  const framework = requireRecord(manifest.frameworkContext, "manifest.frameworkContext");
  const frameworkContextSha256 = requireString(framework.sha256, "manifest.frameworkContext.sha256");
  const centralIngress = validateCentralIngressContext(manifest, frameworkContextSha256);
  validateCentralResponseHintCoverage(routes, centralIngress);
  return { manifest, route, method, frameworkContextSha256, centralIngress };
}

export function operationContractTemplate(operationId: string): RecordValue {
  const source = sourceOperationFor(operationId);
  const operation = makeOperation(source.manifest, source.route, source.method, new Map(), source.frameworkContextSha256, source.centralIngress);
  return contractFromOperation(operation);
}
/** Fail closed if the reviewed cache implementation is no longer in the pinned handler closure. */
export function assertCacheMetricsSourceBinding(operationId: string): void {
  if (operationId !== "GET /api/settings/cache-metrics" && operationId !== "DELETE /api/settings/cache-metrics") {
    throw new Error(`not a reviewed cache metrics operation: ${operationId}`);
  }
  const { manifest, route } = sourceOperationFor(operationId);
  const backend = "src/lib/db/settings/cacheMetrics.ts";
  const corpus = requireRecord(manifest.sourceCorpus, "manifest.sourceCorpus");
  const receipts = requireArray(corpus.files, "manifest.sourceCorpus.files")
    .map((value, index) => requireRecord(value, `manifest.sourceCorpus.files[${index}]`))
    .filter(receipt => receipt.path === backend);
  if (route.sha256 !== "1a8b1e376b02daa883d2d90eca5274684c4cdee7cb7a56d83d0a30f68032362a"
    || !requireArray(route.resolvedImports, `${operationId}.resolvedImports`).includes(backend)
    || receipts.length !== 1 || receipts[0]?.sha256 !== "784114e9262a8a34348a17bcc510c29886fb1dc7af028bc2827ab3eb515fdca1"
    || receipts[0]?.gitBlobSha !== "4a2ce8d5ecf2b8c7115d82a9922239a27ca04373") {
    throw new Error(`${operationId} cache metrics source differs from the reviewed handler and backend`);
  }
}

/** Compute a source/contract binding only; explicit contracts never create eligibility. */
export function operationEvidenceBinding(operationId: string, explicitContract?: unknown): OperationEvidenceBinding {
  const source = sourceOperationFor(operationId);
  const contract = explicitContract !== undefined ? explicitContract : eligibilityRecords().get(operationId)?.contract;
  if (contract === undefined) throw new Error(`operationEvidenceBinding requires an explicit or stored source-reviewed contract: ${operationId}`);
  const operation = makeOperation(source.manifest, source.route, source.method, new Map(), source.frameworkContextSha256, source.centralIngress, contract, true);
  return outcomeBindingFor(source.route, bindingFor(operation, source.route, source.frameworkContextSha256, source.manifest));
}


export function generateContracts(): string {
  const manifest = readRouteSources(manifestPath);
  return `${JSON.stringify(sortJson(toJson(generateOperations(manifest), "operations")), null, 2)}\n`;
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const expected = readFileSync(outputPath, "utf8");
    if (expected !== generateContracts()) throw new Error("operations.json is stale; run bun scripts/generate-contracts.ts");
  } else {
    writeFileSync(outputPath, generateContracts());
  }
  const routeManifest = requireRecord(readRouteSources(manifestPath), "route source manifest");
  const centralIngress = requireRecord(routeManifest.centralIngress, "manifest.centralIngress");
  const coverage = requireRecord(centralIngress.coverage, "manifest.centralIngress.coverage");
  console.log(JSON.stringify({
    centralIngress: {
      apiOperationsConsidered: coverage.apiOperationsConsidered,
      managementPolicyOperations: coverage.managementPolicyOperations,
      publishedResponseVariants: coverage.publishedResponseVariants,
      skippedReasons: coverage.skippedReasons,
      pendingCoverage: coverage.pendingCoverage,
      pendingCoverageReleaseEffect: "no-exclusion",
    },
  }, null, 2));
}
