import { encodeRouteSources } from "./route-source-store.ts";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, extname, relative, resolve, sep } from "node:path";
import * as ts from "typescript";
import {
  collectManagementPolicyResponses,
  collectPipelineRejectionWitness,
  collectSourceResponseEvidence,
  collectValidatedJsonBodyFailureResponses,
  type ManagementPolicyResponse,
  type PipelineResponseWitness,
  type SourceJsonResponse,
  type SourceResponseEvidence,
} from "./source-response-hints.ts";
import { addDefaultMigrationInputs, resolvedSourceInputsDigest } from "./runtime-source-inputs.ts";
import { fileURLToPath, pathToFileURL } from "node:url";

type UnknownRecord = Record<string, unknown>;
type SourceFileDigest = { path: string; bytes: number; sha256: string; gitBlobSha: string };
type CentralResponseHint = {
  method: HttpMethod;
  statusCode: string;
  mediaType: string;
  sourceFile: string;
  routePath: string;
  routeClass: "MANAGEMENT";
  authority: "pinned-framework-management-policy";
  policySourceFile: string;
  policySourceLine: number;
  responseSourceLine: number;
  evidenceSourceFiles: string[];
  frameworkContextSha256: string;
  frameworkSourcesSha256: string;
};
type CapturedRoute = {
  bytes: number;
  classification: "external" | "source-justified-non-invokable";
  classificationReason: string | null;
  exports: { direct: string[]; reExports: string[]; resolved: string[] };
  gitBlobSha: string;
  responseHints: SourceJsonResponse[];
  centralResponseHints: CentralResponseHint[];
  resolvedImports: string[];
  resolvedImportsSha256: string;
  externalImports: string[];
  unresolvedLocalImports: string[];
  routeTemplate: string;
  sha256: string;
  sourceFile: string;
};
type HttpMethod = "DELETE" | "GET" | "HEAD" | "OPTIONS" | "PATCH" | "POST" | "PUT";
type OpenApiOperation = UnknownRecord & { method: HttpMethod; path: string; pathParameters: unknown[]; operationParameters: unknown[] };

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const upstreamPath = resolve(packageRoot, "provenance/upstreams.json");
const manifestPath = resolve(packageRoot, "provenance/route-sources.json");
const isRecord = (value: unknown): value is UnknownRecord => typeof value === "object" && value !== null && !Array.isArray(value);
function requireRecord(value: unknown, label: string): UnknownRecord {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return value;
}
function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}
function requireArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}
const provenance = requireRecord(JSON.parse(readFileSync(upstreamPath, "utf8")) as unknown, "upstreams");
const upstreams = requireArray(provenance.upstreams, "upstreams.upstreams");
const upstreamRecord = upstreams.map(value => requireRecord(value, "upstream")).find(value => value.id === "omniroute");
if (!upstreamRecord) throw new Error("OmniRoute pin is missing from provenance/upstreams.json");
const release = requireRecord(upstreamRecord.release, "OmniRoute release");
const artifactIntegrity = requireRecord(upstreamRecord.artifact_integrity, "OmniRoute artifact integrity");
const expectedVersion = requireString(release.version, "OmniRoute release version");
const expectedCommit = requireString(release.peeled_commit, "OmniRoute commit");
const repository = requireString(upstreamRecord.repository, "OmniRoute repository");
const releaseTag = requireString(release.tag, "OmniRoute release tag");
const releaseId = typeof release.release_id === "number" ? release.release_id : NaN;
if (!Number.isSafeInteger(releaseId)) throw new Error("OmniRoute release ID is invalid");
const latestSelectorUrl = requireString(release.selector_url, "OmniRoute latest selector URL");
const latestApiUrl = requireString(release.api_url, "OmniRoute latest API URL");
const releaseUrl = requireString(release.release_url, "OmniRoute release URL");
const retrievedAt = requireString(release.retrieved_at, "OmniRoute pin retrieval time");
const publishedAt = requireString(release.published_at, "OmniRoute publication time");
const sourceArchiveSha256 = requireString(artifactIntegrity.source_archive_sha256, "OmniRoute source archive digest").replace(/^sha256:/, "");
const sourceArchiveUrl = requireString(artifactIntegrity.source_archive_url, "OmniRoute source archive URL");
const sourceArchivePath = resolve(packageRoot, `.agents/state/omp-provider-release/upstream/omniroute-v${expectedVersion}-${expectedCommit}.tar.gz`);
const sourceRoot = resolve(packageRoot, `.agents/state/omp-provider-release/upstream/omniroute-v${expectedVersion}`);
const packageRealRoot = realpathSync(packageRoot);
const sourceRealRoot = realpathSync(sourceRoot);
if (sourceRealRoot !== packageRealRoot && !sourceRealRoot.startsWith(`${packageRealRoot}${sep}`)) {
  throw new Error("pinned source root escapes the package workspace");
}
if (existsSync(resolve(sourceRoot, ".git"))) throw new Error("pinned source must be the verified extracted archive, not a Git worktree");
const sourceBytes = new Map<string, Buffer>();
const validatedSourcePaths = new Set<string>();
const hash = (data: Uint8Array | string, algorithm: "sha256" | "sha1" = "sha256"): string => createHash(algorithm).update(data).digest("hex");
const gitBlobSha = (bytes: Uint8Array): string => createHash("sha1").update(`blob ${bytes.byteLength}\0`).update(bytes).digest("hex");
const rel = (path: string): string => relative(sourceRoot, path).split(sep).join("/");
const sourceFiles = new Map<string, SourceFileDigest>();
function validateSourcePath(path: string): string {
  const absolute = resolve(path);
  if (absolute !== sourceRoot && !absolute.startsWith(`${sourceRoot}${sep}`)) {
    throw new Error(`source path escapes pinned snapshot: ${path}`);
  }
  if (validatedSourcePaths.has(absolute)) return absolute;
  const physical = realpathSync(absolute);
  if (physical !== sourceRealRoot && !physical.startsWith(`${sourceRealRoot}${sep}`)) {
    throw new Error(`source symlink escapes pinned snapshot: ${relative(sourceRoot, absolute).split(sep).join("/")}`);
  }
  if (!statSync(physical).isFile()) throw new Error(`source path is not a regular file: ${relative(sourceRoot, absolute).split(sep).join("/")}`);
  validatedSourcePaths.add(absolute);
  return absolute;
}
const sourcePackagePath = validateSourcePath(resolve(sourceRoot, "package.json"));
const sourcePackageBytes = readFileSync(sourcePackagePath);
sourceBytes.set(sourcePackagePath, sourcePackageBytes);
captureSource(sourcePackagePath);
const sourcePackage = requireRecord(JSON.parse(sourcePackageBytes.toString("utf8")) as unknown, "pinned package.json");
if (sourcePackage.version !== expectedVersion || !/^\d+\.\d+\.\d+$/.test(expectedVersion) || !/^[a-f0-9]{40}$/.test(expectedCommit)) {
  throw new Error("source snapshot does not match the immutable OmniRoute release pin");
}
const bunYaml = Bun as unknown as typeof Bun & { YAML: { parse(text: string): unknown } };
const sourceOpenApiPath = validateSourcePath(resolve(sourceRoot, "docs/openapi.yaml"));
const sourceOpenApiBytes = readFileSync(sourceOpenApiPath);
sourceBytes.set(sourceOpenApiPath, sourceOpenApiBytes);
captureSource(sourceOpenApiPath);
const parsedApi: unknown = bunYaml.YAML.parse(sourceOpenApiBytes.toString("utf8"));
const api = requireRecord(parsedApi, "pinned OpenAPI document");
const apiInfo = requireRecord(api.info, "OpenAPI info");
const apiPaths = requireRecord(api.paths, "OpenAPI paths");
if (apiInfo.version !== expectedVersion) throw new Error("pinned OpenAPI document has an unexpected version");
const methods = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"] as const;
const methodSet: Record<string, true> = Object.fromEntries(methods.map(method => [method, true]));
const compareText = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0;
const sourceArchiveBytes = readFileSync(sourceArchivePath);
if (!/^[a-f0-9]{64}$/.test(sourceArchiveSha256) || hash(sourceArchiveBytes) !== sourceArchiveSha256) {
  throw new Error(`pinned source archive bytes do not match ${sourceArchiveUrl}`);
}
const packageSourcePin = requireArray(upstreamRecord.source_hashes, "OmniRoute source hashes")
  .map(value => requireRecord(value, "OmniRoute source hash"))
  .find(value => value.path === "package.json" && value.algorithm === "git-blob-sha1");
const packageSourceReceipt = sourceFiles.get("package.json");
if (!packageSourcePin || !packageSourceReceipt
  || packageSourceReceipt.gitBlobSha !== requireString(packageSourcePin.hash, "pinned package.json Git blob")) {
  throw new Error("extracted package.json does not match the pinned upstream source receipt");
}
const parsedFiles = new Map<string, ts.SourceFile>();
const moduleCache = new Map<string, string | undefined | null>();

function captureSource(path: string): Buffer {
  const absolute = resolve(path);
  const sourcePath = rel(absolute);
  let bytes = sourceBytes.get(absolute);
  if (!sourceFiles.has(sourcePath)) {
    validateSourcePath(absolute);
    if (bytes === undefined) {
      bytes = readFileSync(absolute);
      sourceBytes.set(absolute, bytes);
    }
    sourceFiles.set(sourcePath, { path: sourcePath, bytes: bytes.byteLength, sha256: hash(bytes), gitBlobSha: gitBlobSha(bytes) });
  }
  if (bytes === undefined) throw new Error(`captured source bytes are missing for ${sourcePath}`);
  return bytes;
}

function readSource(path: string): { bytes: Buffer; source: ts.SourceFile } {
  const absolute = resolve(path);
  const existing = parsedFiles.get(absolute);
  const bytes = captureSource(absolute);
  if (existing) return { bytes, source: existing };
  const extension = extname(absolute);
  const scriptKind = extension === ".tsx" ? ts.ScriptKind.TSX : extension === ".jsx" ? ts.ScriptKind.JSX : [".js", ".jsx", ".mjs", ".cjs"].includes(extension) ? ts.ScriptKind.JS : ts.ScriptKind.TS;
  const source = ts.createSourceFile(absolute, bytes.toString("utf8"), ts.ScriptTarget.Latest, true, scriptKind);
  const diagnostics = ts.transpileModule(bytes.toString("utf8"), {
    compilerOptions: { target: ts.ScriptTarget.Latest },
    fileName: absolute,
    reportDiagnostics: true,
  }).diagnostics ?? [];
  const parseError = diagnostics.find(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
  if (parseError) throw new Error(`cannot parse pinned source ${rel(absolute)}: ${ts.flattenDiagnosticMessageText(parseError.messageText, "\n")}`);
  parsedFiles.set(absolute, source);
  return { bytes, source };
}

function candidatePaths(base: string): string[] {
  const extension = extname(base);
  const sourceExtensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json"];
  if (sourceExtensions.includes(extension)) return [base];
  const explicitBase = extension === "" ? [base] : [];
  const suffixed = sourceExtensions.map(suffix => `${base}${suffix}`);
  const indexModules = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"].map(suffix => resolve(base, `index${suffix}`));
  return [...explicitBase, ...suffixed, ...indexModules];
}

function resolveLocalModule(specifier: string, fromFile: string): string | undefined | null {
  const key = `${fromFile}\0${specifier}`;
  if (moduleCache.has(key)) return moduleCache.get(key);
  let base: string | undefined;
  if (specifier.startsWith(".")) base = resolve(dirname(fromFile), specifier);
  else if (specifier.startsWith("@/")) base = resolve(sourceRoot, "src", specifier.slice(2));
  else if (specifier === "@omniroute/open-sse") base = resolve(sourceRoot, "open-sse");
  else if (specifier.startsWith("@omniroute/open-sse/")) base = resolve(sourceRoot, "open-sse", specifier.slice("@omniroute/open-sse/".length));
  else if (specifier.startsWith("@omniroute/")) {
    const workspace = specifier.slice("@omniroute/".length).split("/")[0];
    if (workspace) {
      const remainder = specifier.slice(`@omniroute/${workspace}/`.length);
      const packagePath = resolve(sourceRoot, "packages", workspace);
      if (existsSync(resolve(packagePath, "package.json"))) base = resolve(packagePath, remainder);
    }
  }
  if (!base) { moduleCache.set(key, undefined); return undefined; }
  const found = candidatePaths(base).find(candidate => existsSync(candidate) && statSync(candidate).isFile());
  if (!found) {
    if (rel(fromFile) === "src/lib/source.ts" && specifier === "../../.source/server") {
      moduleCache.set(key, null);
      return null;
    }
    throw new Error(`unresolved local import ${specifier} from ${rel(fromFile)}`);
  }
  const absolute = validateSourcePath(found);
  moduleCache.set(key, absolute);
  return absolute;
}

function importSpecifiers(source: ts.SourceFile): string[] {
  const found = new Set<string>();
  const constants = new Map<string, ts.Expression[]>();
  const functions = new Map<string, ts.FunctionDeclaration[]>();
  const collectConstants = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer
      && ts.isVariableDeclarationList(node.parent) && (node.parent.flags & ts.NodeFlags.Const) !== 0) {
      const expressions = constants.get(node.name.text) ?? [];
      expressions.push(node.initializer);
      constants.set(node.name.text, expressions);
    }
    if (ts.isFunctionDeclaration(node) && node.name && node.body) {
      const declarations = functions.get(node.name.text) ?? [];
      declarations.push(node);
      functions.set(node.name.text, declarations);
    }
    ts.forEachChild(node, collectConstants);
  };
  collectConstants(source);
  const constantString = (expression: ts.Expression, resolving = new Set<string>()): string | undefined => {
    if (ts.isStringLiteralLike(expression)) return expression.text;
    if (ts.isParenthesizedExpression(expression)) return constantString(expression.expression, resolving);
    if (ts.isAsExpression(expression)) return constantString(expression.expression, resolving);
    if (ts.isTypeAssertionExpression(expression)) return constantString(expression.expression, resolving);
    if (ts.isCallExpression(expression) && ts.isPropertyAccessExpression(expression.expression)
      && expression.expression.name.text === "join" && ts.isArrayLiteralExpression(expression.expression.expression)) {
      const elements = expression.expression.expression.elements;
      const parts: string[] = [];
      for (const element of elements) {
        if (!ts.isStringLiteralLike(element)) return undefined;
        parts.push(element.text);
      }
      const separator = expression.arguments.length === 0 ? "," : expression.arguments.length === 1
        ? constantString(expression.arguments[0]!, resolving) : undefined;
      return separator === undefined ? undefined : parts.join(separator);
    }
    if (ts.isCallExpression(expression) && ts.isIdentifier(expression.expression) && expression.arguments.length === 0
      && !resolving.has(expression.expression.text)) {
      const declarations = functions.get(expression.expression.text);
      if (!declarations || declarations.length !== 1) return undefined;
      const body = declarations[0]!.body;
      if (!body) return undefined;
      const statements = body.statements;
      if (statements.length !== 1 || !ts.isReturnStatement(statements[0]!) || !statements[0]!.expression) return undefined;
      resolving.add(expression.expression.text);
      const result = constantString(statements[0]!.expression, resolving);
      resolving.delete(expression.expression.text);
      return result;
    }
    if (ts.isBinaryExpression(expression) && expression.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const left = constantString(expression.left, resolving);
      const right = constantString(expression.right, resolving);
      return left === undefined || right === undefined ? undefined : `${left}${right}`;
    }
    if (ts.isIdentifier(expression) && !resolving.has(expression.text)) {
      const initializers = constants.get(expression.text);
      if (!initializers || initializers.length !== 1) return undefined;
      resolving.add(expression.text);
      const result = constantString(initializers[0]!, resolving);
      resolving.delete(expression.text);
      return result;
    }
    return undefined;
  };
  const add = (node: ts.Node): void => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      found.add(node.moduleSpecifier.text);
    }
    if (ts.isCallExpression(node)) {
      const importer = node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === "require");
      if (importer) {
        const argument = node.arguments[0];
        const specifier = argument ? constantString(argument) : undefined;
        if (node.arguments.length !== 1 || specifier === undefined) {
          throw new Error(`dynamic source import cannot be resolved exactly in ${rel(source.fileName)}`);
        }
        found.add(specifier);
      }
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal)) found.add(node.argument.literal.text);
    ts.forEachChild(node, add);
  };
  add(source);
  return [...found].sort();
}

function importClosure(entry: string): { files: string[]; external: string[]; unresolvedLocal: string[]; digest: string } {
  const seen = new Set<string>();
  const external = new Set<string>();
  const unresolvedLocal = new Set<string>();
  const visit = (file: string): void => {
    const absolute = resolve(file);
    if (seen.has(absolute)) return;
    seen.add(absolute);
    if (seen.size > 100_000) throw new Error("pinned source import graph exceeded the 100,000-file safety bound");
    if ([".json", ".sql"].includes(extname(absolute))) {
      captureSource(absolute);
      return;
    }
    const { source } = readSource(absolute);
    for (const specifier of importSpecifiers(source)) {
      const imported = resolveLocalModule(specifier, absolute);
      if (imported) visit(imported);
      else if (imported === null) unresolvedLocal.add(`${rel(absolute)} -> ${specifier}`);
      else if (!specifier.startsWith(".") && !specifier.startsWith("@/")) external.add(specifier);
    }
  };
  visit(entry);
  const files = addDefaultMigrationInputs(sourceRoot, [...seen].map(rel), path => {
    const absolute = validateSourcePath(path);
    captureSource(absolute);
    const receipt = sourceFiles.get(rel(absolute));
    if (!receipt) throw new Error(`runtime source receipt is missing for ${rel(absolute)}`);
    return receipt;
  });
  const records = files.map(file => sourceFiles.get(file)!).sort((left, right) => compareText(left.path, right.path));
  return {
    files,
    external: [...external].sort(compareText),
    unresolvedLocal: [...unresolvedLocal].sort(compareText),
    digest: resolvedSourceInputsDigest(records),
  };
}
const centralIngressFiles = [
  "src/proxy.ts",
  "src/server/authz/pipeline.ts",
  "src/server/authz/classify.ts",
  "src/shared/constants/publicApiRoutes.ts",
  "src/server/authz/policies/management.ts",
  "src/server/authz/context.ts",
].sort(compareText);
const classifierFile = "src/server/authz/classify.ts";
const publicRoutesFile = "src/shared/constants/publicApiRoutes.ts";
const pipelineFile = "src/server/authz/pipeline.ts";
const managementPolicyFile = "src/server/authz/policies/management.ts";
const classifierImportPath = resolve(sourceRoot, classifierFile);
const publicRoutesImportPath = resolve(sourceRoot, publicRoutesFile);

function isPureConstantExpression(expression: ts.Expression): boolean {
  if (ts.isStringLiteralLike(expression) || ts.isNumericLiteral(expression)
    || expression.kind === ts.SyntaxKind.TrueKeyword || expression.kind === ts.SyntaxKind.FalseKeyword
    || expression.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isArrayLiteralExpression(expression)) return expression.elements.every(element =>
    !ts.isSpreadElement(element) && isPureConstantExpression(element));
  if (ts.isObjectLiteralExpression(expression)) return expression.properties.every(property =>
    ts.isPropertyAssignment(property) && isPureConstantExpression(property.initializer));
  if (ts.isNewExpression(expression) && ts.isIdentifier(expression.expression) && expression.expression.text === "Set") {
    const [argument] = expression.arguments ?? [];
    if (expression.arguments?.length === 1 && argument && ts.isArrayLiteralExpression(argument)) {
      return argument.elements.every(element => !ts.isSpreadElement(element) && isPureConstantExpression(element));
    }
  }
  return false;
}

function assertSideEffectFreePredicateModule(file: string, allowedRuntimeImports: ReadonlySet<string>): void {
  const absolute = resolve(sourceRoot, file);
  const source = readSource(absolute).source;
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      if (!ts.isStringLiteral(statement.moduleSpecifier)) throw new Error(`classifier import is not static: ${file}`);
      const clause = statement.importClause;
      if (!clause) throw new Error(`classifier module has a side-effect import: ${file}`);
      if (clause.isTypeOnly) continue;
      const imported = resolveLocalModule(statement.moduleSpecifier.text, absolute);
      if (!imported || !allowedRuntimeImports.has(rel(imported))) throw new Error(`classifier runtime import is not approved: ${file} -> ${statement.moduleSpecifier.text}`);
      continue;
    }
    if (ts.isVariableStatement(statement)) {
      if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) throw new Error(`classifier module has mutable top-level state: ${file}`);
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name) || !declaration.initializer || !isPureConstantExpression(declaration.initializer)) {
          throw new Error(`classifier module has an impure top-level initializer: ${file}`);
        }
      }
      continue;
    }
    if (ts.isFunctionDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
      || ts.isExportDeclaration(statement)) continue;
    throw new Error(`classifier module has an unreviewed top-level effect: ${file}`);
  }
  const inspectCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword
      || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      throw new Error(`classifier module contains a dynamic runtime import: ${file}`);
    }
    ts.forEachChild(node, inspectCalls);
  };
  inspectCalls(source);
}

function assertProxyApiMatcher(source: ts.SourceFile): void {
  const config = source.statements.flatMap(statement => ts.isVariableStatement(statement)
    ? statement.declarationList.declarations
    : []).find(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === "config");
  const initializer = config?.initializer;
  if (!initializer || !ts.isObjectLiteralExpression(initializer)) throw new Error("pinned proxy config is not a literal object");
  const matcher = initializer.properties.find(property => ts.isPropertyAssignment(property)
    && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === "matcher");
  if (!matcher || !ts.isPropertyAssignment(matcher) || !ts.isArrayLiteralExpression(matcher.initializer)
    || !matcher.initializer.elements.some(element => ts.isStringLiteralLike(element) && element.text === "/api/:path*")) {
    throw new Error("pinned proxy matcher does not cover the API route tree");
  }
}

function assertOptionsPreflightBeforePolicy(source: ts.SourceFile): number {
  const pipeline = source.statements.find((statement): statement is ts.FunctionDeclaration => ts.isFunctionDeclaration(statement)
    && statement.name?.text === "runAuthzPipeline");
  if (!pipeline || !pipeline.body) throw new Error("pinned authz pipeline entry is missing");
  let preflightEnd = -1;
  let preflightLine: number | undefined;
  let policyEvaluationPosition = -1;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node) && node !== pipeline) return;
    if (ts.isIfStatement(node) && ts.isBinaryExpression(node.expression)
      && node.expression.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken) {
      const { left, right } = node.expression;
      const isOptions = (ts.isIdentifier(left) && left.text === "method" && ts.isStringLiteral(right) && right.text === "OPTIONS")
        || (ts.isStringLiteral(left) && left.text === "OPTIONS" && ts.isIdentifier(right) && right.text === "method");
      if (isOptions) {
        let nextResponseName: string | undefined;
        let has204 = false;
        const inspectPreflight = (child: ts.Node): void => {
          if (ts.isNewExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === "NextResponse") {
            const argumentsList = child.arguments;
            const options = argumentsList?.[1];
            if (argumentsList?.length === 2 && argumentsList[0]?.kind === ts.SyntaxKind.NullKeyword
              && options && ts.isObjectLiteralExpression(options)) {
              const status = options.properties.find(property => ts.isPropertyAssignment(property)
                && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === "status");
              const parent = child.parent;
              if (status && ts.isPropertyAssignment(status) && ts.isNumericLiteral(status.initializer)
                && Number(status.initializer.text) === 204 && ts.isVariableDeclaration(parent)
                && ts.isIdentifier(parent.name)) {
                nextResponseName = parent.name.text;
                has204 = true;
              }
            }
          }
          ts.forEachChild(child, inspectPreflight);
        };
        inspectPreflight(node.thenStatement);
        const returned = nextResponseName !== undefined && (() => {
          let found = false;
          const findReturn = (child: ts.Node): void => {
            if (ts.isReturnStatement(child) && child.expression && ts.isIdentifier(child.expression)
              && child.expression.text === nextResponseName) found = true;
            ts.forEachChild(child, findReturn);
          };
          findReturn(node.thenStatement);
          return found;
        })();
        if (has204 && returned) {
          preflightEnd = node.end;
          preflightLine = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
        }
      }
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === "policy"
      && node.expression.name.text === "evaluate") policyEvaluationPosition = node.pos;
    ts.forEachChild(node, visit);
  };
  visit(pipeline.body);
  if (preflightEnd < 0 || policyEvaluationPosition < 0 || preflightEnd >= policyEvaluationPosition || preflightLine === undefined) {
    throw new Error("pinned authz pipeline no longer returns OPTIONS preflight before policy evaluation");
  }
  return preflightLine;
}

function apiPathLiterals(source: ts.SourceFile): string[] {
  const found = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isStringLiteralLike(node) && node.text.startsWith("/api/")) found.add(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...found].sort(compareText);
}

function templateMayMatchPath(template: string, candidate: string): boolean {
  const patternParts = template.split("/").filter(Boolean);
  const candidateParts = candidate.replace(/\/$/, "").split("/").filter(Boolean);
  const catchAllIndex = patternParts.findIndex(part => part.startsWith("*"));
  const matches = (index: number): boolean => {
    if (index === candidateParts.length) return true;
    if (catchAllIndex >= 0 && index >= catchAllIndex) return true;
    if (index >= patternParts.length) return false;
    const pattern = patternParts[index]!;
    return (pattern.startsWith("{") && pattern.endsWith("}")) || pattern === candidateParts[index]
      ? matches(index + 1)
      : false;
  };
  if (!matches(0)) return false;
  if (candidate.endsWith("/")) return catchAllIndex >= 0 || patternParts.length > candidateParts.length;
  return catchAllIndex >= 0 || patternParts.length === candidateParts.length;
}

function hasDynamicPublicPathOverlap(template: string, publicPaths: readonly string[]): boolean {
  if (!/\{[^}]+\}|\*[^/]+/.test(template)) return false;
  return publicPaths.some(path => templateMayMatchPath(template, path));
}

function classifierPath(routeTemplate: string): string {
  return routeTemplate.replace(/\{[^}]+\}|\*[^/]+/g, "omp-source-path-parameter");
}

function walk(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) return walk(absolute);
    return entry.isFile() && entry.name === "route.ts" ? [absolute] : [];
  });
}

function normalizeNextRoutePath(sourceFile: string): string {
  const relativePath = sourceFile.replace(/^src\/app\//, "").replace(/\/route\.ts$/, "");
  const parts: string[] = [];
  for (const part of relativePath.split("/")) {
    if ((part.startsWith("(") && part.endsWith(")")) || part.startsWith("@")) continue;
    if (part.startsWith("[[...") && part.endsWith("]]")) parts.push(`*${part.slice(5, -2)}`);
    else if (part.startsWith("[...") && part.endsWith("]")) parts.push(`*${part.slice(4, -1)}`);
    else if (part.startsWith("[") && part.endsWith("]")) parts.push(`{${part.slice(1, -1)}}`);
    else parts.push(part);
  }
  return `/${parts.filter(Boolean).join("/")}`;
}

function exportedMethods(file: string, stack = new Set<string>()): { direct: string[]; reExports: string[]; resolved: string[] } {
  const absolute = resolve(file);
  if (stack.has(absolute)) throw new Error(`cyclic route re-export at ${rel(absolute)}`);
  const nextStack = new Set(stack); nextStack.add(absolute);
  const source = readSource(absolute).source;
  const direct = new Set<string>();
  const reExports = new Set<string>();
  const isExported = (node: ts.Node): boolean => ts.canHaveModifiers(node) && (ts.getModifiers(node)?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false);
  for (const statement of source.statements) {
    if ((ts.isFunctionDeclaration(statement) || ts.isVariableStatement(statement)) && isExported(statement)) {
      const names = ts.isFunctionDeclaration(statement)
        ? statement.name ? [statement.name.text] : []
        : statement.declarationList.declarations.flatMap(declaration => {
            if (ts.isIdentifier(declaration.name)) return [declaration.name.text];
            if (ts.isObjectBindingPattern(declaration.name)) return declaration.name.elements.flatMap(element => {
              const key = element.propertyName ?? element.name;
              return ts.isIdentifier(key) ? [key.text] : [];
            });
            return [];
          });
      for (const name of names) if (methodSet[name] === true) direct.add(name);
    }
    if (ts.isExportDeclaration(statement)) {
      const specifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
      if (!specifier) {
        if (statement.exportClause && ts.isNamedExports(statement.exportClause)) for (const element of statement.exportClause.elements) {
          const name = element.name.text;
          if (methodSet[name] === true) direct.add(name);
        }
        continue;
      }
      const importedPath = resolveLocalModule(specifier, absolute);
      if (!importedPath) throw new Error(`route re-export resolves outside pinned source: ${specifier} from ${rel(absolute)}`);
      const imported = exportedMethods(importedPath, nextStack);
      const exported = new Map(imported.resolved.map(method => [method, method]));
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) {
          const sourceName = (element.propertyName ?? element.name).text;
          const publicName = element.name.text;
          if (methodSet[publicName] === true) {
            if (!exported.has(sourceName) && !imported.direct.includes(sourceName) && !imported.reExports.includes(sourceName)) throw new Error(`re-exported HTTP method ${sourceName} is not exported by ${rel(importedPath)}`);
            reExports.add(publicName);
          }
        }
      } else if (statement.exportClause === undefined) {
        for (const method of imported.resolved) if (methodSet[method] === true) reExports.add(method);
      }
    }
  }
  const resolved = new Set([...direct, ...reExports]);
  return { direct: [...direct].sort(), reExports: [...reExports].filter(method => !direct.has(method)).sort(), resolved: [...resolved].sort() };
}

/**
 * Preserve directly returned literal JSON and recognized returned-guard responses per exported method.
 * This conservative inventory does not infer dynamic factories or unknown helper results.
 */
function sourceJsonResponses(file: string, exportName: string, publicMethod: HttpMethod, stack = new Set<string>()): SourceJsonResponse[] {
  const absolute = resolve(file);
  const identity = `${absolute}\0${exportName}`;
  if (stack.has(identity)) throw new Error(`cyclic response export at ${rel(absolute)}#${exportName}`);
  const nextStack = new Set(stack);
  nextStack.add(identity);
  const source = readSource(absolute).source;
  const importedExports: { sourceName: string; path: string }[] = [];
  let localHandlerName: string | undefined;
  let localAliasAmbiguous = false;
  for (const statement of source.statements) {
    if (!ts.isExportDeclaration(statement)) continue;
    const specifier = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : undefined;
    if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        if (element.isTypeOnly || element.name.text !== exportName) continue;
        const sourceName = (element.propertyName ?? element.name).text;
        if (specifier) {
          const path = resolveLocalModule(specifier, absolute);
          if (!path) throw new Error(`response export escapes pinned source: ${specifier}`);
          importedExports.push({ sourceName, path });
        } else if (localHandlerName !== undefined && localHandlerName !== sourceName) {
          localAliasAmbiguous = true;
        } else {
          localHandlerName = sourceName;
        }
      }
    } else if (!statement.exportClause && specifier) {
      const path = resolveLocalModule(specifier, absolute);
      if (!path) throw new Error(`response export escapes pinned source: ${specifier}`);
      if (exportedMethods(path).resolved.includes(exportName)) importedExports.push({ sourceName: exportName, path });
    }
  }

  const results = new Map<string, SourceJsonResponse>();
  const add = (hint: SourceJsonResponse): void => {
    results.set(`${hint.statusCode}\0${hint.mediaType}\0${hint.sourceFile}`, hint);
  };
  let evidence: SourceResponseEvidence = { jsonResponses: [], returnedImportedCalls: [], returnedImportedResponseMembers: [], returnedLocalCalls: [] };
  if (!localAliasAmbiguous) {
    evidence = collectSourceResponseEvidence(source, localHandlerName ?? exportName, publicMethod, rel(absolute));
  }
  for (const hint of evidence.jsonResponses) add(hint);

  for (const imported of importedExports) {
    for (const hint of sourceJsonResponses(imported.path, imported.sourceName, publicMethod, nextStack)) add(hint);
  }

  const importedGuardResponses: Record<string, { statusCodes: readonly string[]; sourceFile: string }> = {
    "@/lib/api/requireManagementAuth\0requireManagementAuth": {
      statusCodes: ["401", "403", "503"],
      sourceFile: "src/lib/api/requireManagementAuth.ts",
    },
    "@/lib/providers/chatgptWebRetirementResponse\0rejectRetiredCommonChatGptWebProvider": {
      statusCodes: ["410"],
      sourceFile: "src/lib/providers/chatgptWebRetirementResponse.ts",
    },
  };
  for (const call of evidence.returnedImportedCalls) {
    const response = importedGuardResponses[`${call.moduleSpecifier}\0${call.importedName}`];
    if (!response) continue;
    for (const statusCode of response.statusCodes) {
      add({ method: publicMethod, statusCode, mediaType: "application/json", sourceFile: response.sourceFile });
    }
  }
  for (const member of evidence.returnedImportedResponseMembers) {
    if (member.moduleSpecifier !== "@/shared/validation/helpers" || member.importedName !== "validatedJsonBody"
      || member.member !== "response") continue;
    const helperPath = resolveLocalModule(member.moduleSpecifier, absolute);
    if (!helperPath || rel(helperPath) !== "src/shared/validation/helpers.ts") continue;
    for (const hint of collectValidatedJsonBodyFailureResponses(readSource(helperPath).source, rel(helperPath), publicMethod)) add(hint);
  }
  return [...results.values()].sort((left, right) =>
    compareText(left.statusCode, right.statusCode) || compareText(left.mediaType, right.mediaType) || compareText(left.sourceFile, right.sourceFile));
}
const frameworkEntryPaths = ["src/proxy.ts", "next.config.mjs", "src/instrumentation.ts"]
  .map(path => resolve(sourceRoot, path));
for (const path of frameworkEntryPaths) {
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`required framework source is missing: ${rel(path)}`);
}
const dependencyContextFiles: string[] = [];
for (const sourcePath of ["package.json", "open-sse/package.json", "package-lock.json", "bun.lock", "bun.lockb"]) {
  const absolute = resolve(sourceRoot, sourcePath);
  if (!existsSync(absolute) || !statSync(absolute).isFile()) {
    if (["package.json", "open-sse/package.json", "package-lock.json"].includes(sourcePath)) throw new Error(`required dependency context is missing: ${sourcePath}`);
    continue;
  }
  captureSource(absolute);
  dependencyContextFiles.push(sourcePath);
}
const frameworkFiles = new Set<string>();
const frameworkExternalImports = new Set<string>();
for (const entry of frameworkEntryPaths) {
  const closure = importClosure(entry);
  if (closure.unresolvedLocal.length > 0) throw new Error(`framework import closure has unresolved local imports: ${closure.unresolvedLocal.join(", ")}`);
  for (const path of closure.files) frameworkFiles.add(path);
  for (const specifier of closure.external) frameworkExternalImports.add(specifier);
}
for (const path of dependencyContextFiles) frameworkFiles.add(path);
const frameworkFileList = [...frameworkFiles].sort();
const sourceDigestFor = (paths: readonly string[]): string => {
  const records = paths.map(path => {
    const record = sourceFiles.get(path);
    if (!record) throw new Error(`source digest is missing for ${path}`);
    return { path: record.path, sha256: record.sha256, gitBlobSha: record.gitBlobSha };
  });
  return hash(JSON.stringify(records));
};
const frameworkContextSha256 = sourceDigestFor(frameworkFileList);
const frameworkFilesSet = new Set(frameworkFileList);
if (centralIngressFiles.some(file => !frameworkFilesSet.has(file))) {
  throw new Error("central ingress witness source is outside the authenticated framework context");
}
const centralClassifierClosure = importClosure(classifierImportPath);
if (centralClassifierClosure.unresolvedLocal.length > 0 || centralClassifierClosure.external.length > 0
  || !centralClassifierClosure.files.includes(classifierFile) || !centralClassifierClosure.files.includes(publicRoutesFile)
  || centralClassifierClosure.files.some(file => !frameworkFilesSet.has(file))) {
  throw new Error("pinned route classifier closure is not wholly inside the authenticated framework context");
}
assertSideEffectFreePredicateModule(classifierFile, new Set([publicRoutesFile]));
assertSideEffectFreePredicateModule(publicRoutesFile, new Set());
const classifierSource = readSource(classifierImportPath).source;
const classifierRuntimeImports = classifierSource.statements.flatMap(statement =>
  ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
    && statement.importClause && !statement.importClause.isTypeOnly ? [statement.moduleSpecifier.text] : []);
if (classifierRuntimeImports.length !== 1 || classifierRuntimeImports[0] !== "../../shared/constants/publicApiRoutes") {
  throw new Error("pinned route classifier runtime imports differ from the reviewed pure policy module");
}
const proxySource = readSource(resolve(sourceRoot, "src/proxy.ts")).source;
const pipelineSource = readSource(resolve(sourceRoot, pipelineFile)).source;
const managementPolicySource = readSource(resolve(sourceRoot, managementPolicyFile)).source;
assertProxyApiMatcher(proxySource);
const optionsPreflightLine = assertOptionsPreflightBeforePolicy(pipelineSource);
const managementPolicyResponses: ManagementPolicyResponse[] = collectManagementPolicyResponses(managementPolicySource, managementPolicyFile);
const centralResponseWitness: PipelineResponseWitness = collectPipelineRejectionWitness(pipelineSource, pipelineFile);
const centralResponseMediaType = centralResponseWitness.mediaType;
const publicPathLiterals = apiPathLiterals(readSource(publicRoutesImportPath).source);
const centralFrameworkSourcesSha256 = sourceDigestFor(centralIngressFiles);

const routeFiles: CapturedRoute[] = [];
const routePaths = walk(resolve(sourceRoot, "src/app")).sort((left, right) => compareText(rel(left), rel(right)));
for (const absolute of routePaths) {
  const sourceFile = rel(absolute);
  const routeSource = readSource(absolute).bytes;
  const exports = exportedMethods(absolute);
  if (exports.resolved.length === 0) throw new Error(`route file exports no supported HTTP method: ${sourceFile}`);
  const sourceHash = sourceFiles.get(sourceFile);
  if (!sourceHash) throw new Error(`route handler bytes were not captured: ${sourceFile}`);
  const routeTemplate = normalizeNextRoutePath(sourceFile);
  const unknownRouteFallback = sourceFile === "src/app/api/[...omnirouteApiCatchAll]/route.ts"
    || sourceFile === "src/app/api/v1/[...omnirouteCatchAll]/route.ts";
  const arbitraryOpenApi = routeTemplate === "/api/openapi/try";
  const docsPlumbing = sourceFile === "src/app/docs/api/search/route.ts";
  const classification = unknownRouteFallback || arbitraryOpenApi || docsPlumbing ? "source-justified-non-invokable" : "external";
  const classificationReason = unknownRouteFallback
    ? "Source-confirmed unknown-route JSON 404 fallback; OPTIONS supplies only CORS headers."
    : arbitraryOpenApi
      ? "Source-confirmed arbitrary OpenAPI request executor; model-authored paths are not invokable."
      : docsPlumbing
        ? "Source-confirmed Fumadocs search adapter; framework documentation plumbing is not an OmniRoute control-plane operation."
        : null;
  const imports = importClosure(absolute);
  if (imports.unresolvedLocal.length > 0
    && classification !== "source-justified-non-invokable") {
    throw new Error(`invokable handler has unresolved local imports: ${sourceFile}: ${imports.unresolvedLocal.join(", ")}`);
  }
  const resolvedImports = imports.files.filter(file => file !== sourceFile).sort(compareText);
  routeFiles.push({
    bytes: routeSource.byteLength,
    classification,
    classificationReason,
    exports,
    gitBlobSha: sourceHash.gitBlobSha,
    responseHints: exports.resolved.flatMap(method => sourceJsonResponses(absolute, method, method as HttpMethod)),
    centralResponseHints: [],
    resolvedImports,
    resolvedImportsSha256: sourceDigestFor(resolvedImports),
    externalImports: imports.external,
    unresolvedLocalImports: imports.unresolvedLocal,
    routeTemplate,
    sha256: sourceHash.sha256,
    sourceFile,
  });
}

const openapiOperations: OpenApiOperation[] = [];
for (const [path, pathItemValue] of Object.entries(apiPaths)) {
  const pathItem = requireRecord(pathItemValue, `OpenAPI path ${path}`);
  for (const [methodName, operationValue] of Object.entries(pathItem)) {
    const method = methods.find(candidate => candidate === methodName.toUpperCase());
    if (!method) continue;
    const operation = requireRecord(operationValue, `OpenAPI operation ${method} ${path}`);
    const pathParameters = pathItem.parameters === undefined ? [] : requireArray(pathItem.parameters, `${path}.parameters`);
    const operationParameters = operation.parameters === undefined ? [] : requireArray(operation.parameters, `${method} ${path}.parameters`);
    openapiOperations.push({ ...operation, method, pathParameters, operationParameters, path });
  }
}
openapiOperations.sort((left, right) => compareText(left.method, right.method) || compareText(left.path, right.path));

captureSource(resolve(sourceRoot, "docs/openapi.yaml"));
const openapiSource = sourceFiles.get("docs/openapi.yaml");
if (!openapiSource) throw new Error("pinned OpenAPI bytes were not captured");
const sortedSourceFiles = [...sourceFiles.values()].sort((left, right) => compareText(left.path, right.path));
// Checking the compressed archive's digest alone does not authenticate an
// existing extraction. Compare every byte receipt used by parsing and policy
// analysis with the matching regular member in that exact archive.
const memberPatterns = sortedSourceFiles.map(record => `*/${record.path.replace(/[\\*?\[\]{}!]/g, "\\$&")}`);
const archiveMembers = await new Bun.Archive(sourceArchiveBytes).files(memberPatterns);
if (archiveMembers.size !== sortedSourceFiles.length) throw new Error("pinned archive does not contain exactly the captured source members");
const archiveRoots = new Set<string>();
for (const [memberPath, member] of archiveMembers) {
  const separator = memberPath.indexOf("/");
  if (separator <= 0) throw new Error("pinned archive member has no release root");
  archiveRoots.add(memberPath.slice(0, separator));
  const sourcePath = memberPath.slice(separator + 1);
  const receipt = sourceFiles.get(sourcePath);
  if (!receipt || member.size !== receipt.bytes || hash(new Uint8Array(await member.arrayBuffer())) !== receipt.sha256) {
    throw new Error(`extracted source bytes do not match the pinned archive: ${sourcePath}`);
  }
}
if (archiveRoots.size !== 1 || ![...archiveRoots][0]!.endsWith(`-${expectedCommit}`)) throw new Error("pinned archive source root does not match its release commit");
// Load only after all imported classifier bytes and their full runtime closure have matched the pinned archive.
const classifierArtifact: unknown = await import(pathToFileURL(classifierImportPath).href);
if (!isRecord(classifierArtifact) || typeof classifierArtifact.classifyRoute !== "function") {
  throw new Error("authenticated pinned route classifier does not expose classifyRoute");
}
const classifyRoute = classifierArtifact.classifyRoute as (rawPath: string, method: string) => unknown;
const centralIngressSkippedReasons: Record<string, number> = {};
const centralIngressCoverage = {
  apiOperationsConsidered: 0,
  managementPolicyOperations: 0,
  publishedResponseVariants: 0,
  skippedReasons: centralIngressSkippedReasons,
  pendingCoverage: [
    { code: "head-response-entity", qualificationStatus: "pending", publicationStatus: "not-inferred", sourceFiles: [pipelineFile] },
    { code: "options-preflight-outcome", qualificationStatus: "pending", publicationStatus: "not-inferred", sourceFiles: [pipelineFile], line: optionsPreflightLine },
    { code: "non-management-policy-outcomes", qualificationStatus: "pending", publicationStatus: "not-inferred", sourceFiles: [classifierFile] },
    { code: "non-api-proxy-branches", qualificationStatus: "pending", publicationStatus: "not-inferred", sourceFiles: ["src/proxy.ts", pipelineFile] },
    { code: "rewritten-client-aliases", qualificationStatus: "pending", publicationStatus: "not-inferred", sourceFiles: [classifierFile, "src/proxy.ts"] },
    { code: "request-conditioned-early-exits", qualificationStatus: "pending", publicationStatus: "not-inferred", sourceFiles: [pipelineFile] },
  ],
};
const skipCentralIngress = (reason: string): void => {
  centralIngressSkippedReasons[reason] = (centralIngressSkippedReasons[reason] ?? 0) + 1;
};
for (const route of routeFiles) {
  for (const methodName of route.exports.resolved) {
    const method = methods.find(candidate => candidate === methodName);
    if (!method) continue;
    if (!route.routeTemplate.startsWith("/api/")) {
      skipCentralIngress("non-api-proxy-route");
      continue;
    }
    centralIngressCoverage.apiOperationsConsidered += 1;
    if (method === "OPTIONS") {
      skipCentralIngress("options-preflight-before-policy");
      continue;
    }
    if (method === "HEAD") {
      skipCentralIngress("head-has-no-json-entity");
      continue;
    }
    const classification = requireRecord(classifyRoute(classifierPath(route.routeTemplate), method), "pinned route classification");
    const routeClass = requireString(classification.routeClass, "pinned route classification.routeClass");
    if (routeClass !== "MANAGEMENT") {
      skipCentralIngress(`non-management-${routeClass.toLowerCase()}-policy`);
      continue;
    }
    if (hasDynamicPublicPathOverlap(route.routeTemplate, publicPathLiterals)) {
      skipCentralIngress("dynamic-route-overlaps-public-path");
      continue;
    }
    centralIngressCoverage.managementPolicyOperations += 1;
    for (const response of managementPolicyResponses) {
      route.centralResponseHints.push({
        method,
        statusCode: response.statusCode,
        mediaType: centralResponseMediaType,
        sourceFile: pipelineFile,
        routePath: route.routeTemplate,
        routeClass: "MANAGEMENT",
        authority: "pinned-framework-management-policy",
        policySourceFile: response.sourceFile,
        policySourceLine: response.line,
        responseSourceLine: centralResponseWitness.line,
        evidenceSourceFiles: [...centralIngressFiles],
        frameworkContextSha256,
        frameworkSourcesSha256: centralFrameworkSourcesSha256,
      });
      centralIngressCoverage.publishedResponseVariants += 1;
    }
    route.centralResponseHints.sort((left, right) =>
      compareText(left.method, right.method) || compareText(left.statusCode, right.statusCode));
  }
}

const centralIngress = {
  authority: "pinned-framework-management-policy",
  frameworkContextSha256,
  frameworkSources: centralIngressFiles,
  frameworkSourcesSha256: centralFrameworkSourcesSha256,
  classifierSourceFile: classifierFile,
  publicRoutePolicySourceFile: publicRoutesFile,
  proxyMatcherSourceFile: "src/proxy.ts",
  pipelineSourceFile: pipelineFile,
  policySourceFile: managementPolicyFile,
  policyOutcomeFactorySourceFile: "src/server/authz/context.ts",
  responseSourceFile: pipelineFile,
  coverage: centralIngressCoverage,
  policyResponseStatuses: [...new Set(managementPolicyResponses.map(response => response.statusCode))]
    .sort((left, right) => Number(left) - Number(right)),
  policyResponseWitnesses: managementPolicyResponses,
  responseWitness: centralResponseWitness,
  optionsPreflightWitness: { sourceFile: pipelineFile, line: optionsPreflightLine },
};


const sourceOperationKeys = new Set<string>();
const sourceMethodCounts: Record<(typeof methods)[number], number> = {
  DELETE: 0, GET: 0, HEAD: 0, OPTIONS: 0, PATCH: 0, POST: 0, PUT: 0,
};
const sourceDomainCounts: Record<string, number> = {};
const sourceOperations: Array<{ method: (typeof methods)[number]; path: string; route: CapturedRoute }> = [];
for (const route of routeFiles) {
  for (const method of route.exports.resolved) {
    const key = `${method} ${route.routeTemplate}`;
    if (sourceOperationKeys.has(key)) throw new Error(`ambiguous exported route method/path: ${key}`);
    sourceOperationKeys.add(key);
    const supportedMethod = methods.find(candidate => candidate === method);
    if (!supportedMethod) throw new Error(`unsupported method was captured from ${route.sourceFile}: ${method}`);
    sourceMethodCounts[supportedMethod] += 1;
    sourceOperations.push({ method: supportedMethod, path: route.routeTemplate, route });
    const parts = route.routeTemplate.split("/").filter(Boolean);
    const domain = parts[0] === "api" ? `api/${parts[1] ?? "root"}` : parts[0] ?? "root";
    sourceDomainCounts[domain] = (sourceDomainCounts[domain] ?? 0) + 1;
  }
}
const shape = (value: string): string => value.replace(/\{[^}]+\}|\*[^/]+/g, "{}");
const specificationOnlyMethods = openapiOperations.filter(operation => {
  const candidates = sourceOperations.filter(source => source.method === operation.method && shape(source.path) === shape(operation.path));
  if (candidates.length > 1) throw new Error(`ambiguous OpenAPI-to-handler path match: ${operation.method} ${operation.path}`);
  return candidates.length === 0;
}).map(operation => ({
  method: operation.method,
  path: operation.path,
  operationId: typeof operation.operationId === "string" ? operation.operationId : null,
  reason: "OpenAPI method has no matching exported handler in the pinned source snapshot.",
  sourceAuthority: "handler",
}));
const sourceOperationsCount = sourceOperations.length;
const sourceOnlyOperations = sourceOperations.filter(source => !openapiOperations.some(operation =>
  operation.method === source.method && shape(operation.path) === shape(source.path))).length;
const nonInvokableOperations = sourceOperations.filter(source => source.route.classification === "source-justified-non-invokable").length;
const sourceArchiveDigest = /^[a-f0-9]{64}$/.test(sourceArchiveSha256) ? sourceArchiveSha256 : (() => { throw new Error("pinned source archive digest is malformed"); })();
const routeSources = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  schemaVersion: 2,
  recordKind: "omniroute-route-source-manifest",
  release: {
    repository,
    tag: releaseTag,
    commit: expectedCommit,
    releaseId,
    latestSelectorUrl,
    latestApiUrl,
    releaseUrl,
    selectorKind: "github-latest-release",
    latestRedirectTarget: releaseTag,
    selectorCheckedAt: retrievedAt,
    publishedAt,
    readmeNpmBadgeIsNotSelector: true,
  },
  retrievedAt,
  sourceRoot: "src/app",
  sourceArchiveSha256: sourceArchiveDigest,
  sourceArchive: {
    path: relative(packageRoot, sourceArchivePath).split(sep).join("/"),
    url: sourceArchiveUrl,
    bytes: statSync(sourceArchivePath).size,
    sha256: sourceArchiveDigest,
    commit: expectedCommit,
  },
  frameworkContext: {
    entryFiles: frameworkEntryPaths.map(rel),
    dependencyContextFiles,
    resolvedFiles: frameworkFileList,
    externalImports: [...frameworkExternalImports].sort(),
    sha256: frameworkContextSha256,
  },
  centralIngress,
  inputs: {
    openapi: { ...openapiSource, retrievalUrl: `https://raw.githubusercontent.com/${repository}/${expectedCommit}/docs/openapi.yaml` },
    tree: { sourceCommit: expectedCommit, routeFileCount: routeFiles.length, treeUrl: `https://api.github.com/repos/${repository}/git/trees/${expectedCommit}?recursive=1` },
    package: sortedSourceFiles.find(record => record.path === "package.json"),
  },
  sourceCorpus: { fileCount: sortedSourceFiles.length, files: sortedSourceFiles },
  routeFiles,
  openapi: {
    version: requireString(api.openapi, "OpenAPI version"),
    pathCount: Object.keys(apiPaths).length,
    operationCount: openapiOperations.length,
    components: api.components === undefined ? {} : requireRecord(api.components, "OpenAPI components"),
    security: api.security === undefined ? [] : requireArray(api.security, "OpenAPI security"),
    operations: openapiOperations,
  },
  discrepancies: {
    specificationOnlyMethods,
    counts: {
      "specification-only-method": specificationOnlyMethods.length,
      "undocumented-source-operation": sourceOnlyOperations,
    },
  },
  coverage: {
    routeFiles: routeFiles.length,
    sourceOperations: sourceOperationsCount,
    sourceMethodCounts,
    sourceDomainCounts,
    sourceOnlyOperations,
    openapiPaths: Object.keys(apiPaths).length,
    openapiOperations: openapiOperations.length,
    documentedOperations: openapiOperations.length - specificationOnlyMethods.length,
    specificationOnlyMethods: specificationOnlyMethods.length,
    executableQualifiedOperations: 0,
    sourceJustifiedNonInvokableOperations: nonInvokableOperations,
    operatorRequiredOperations: 0,
    unqualifiedOperations: sourceOperationsCount - nonInvokableOperations,
  },
};
const generatedManifest = `${JSON.stringify(encodeRouteSources(JSON.parse(JSON.stringify(routeSources))), null, 2)}\n`;
if (process.argv.includes("--check")) {
  if (readFileSync(manifestPath, "utf8") !== generatedManifest) throw new Error("route-sources.json is stale; run bun scripts/acquire-route-corpus.ts");
} else {
  writeFileSync(manifestPath, generatedManifest);
}
console.log(JSON.stringify({
  release: expectedVersion,
  routeFiles: routeFiles.length,
  sourceOperations: sourceOperationsCount,
  sourceMethodCounts,
  sourceDomainCounts,
  documentedOperations: routeSources.coverage.documentedOperations,
  openapiOperations: openapiOperations.length,
  sourceFiles: sortedSourceFiles.length,
  sourceOnlyOperations,
  nonInvokableOperations,
  unqualifiedOperations: sourceOperationsCount - nonInvokableOperations,
  executableQualifiedOperations: 0,
  centralIngressCoverage,
}, null, 2));
