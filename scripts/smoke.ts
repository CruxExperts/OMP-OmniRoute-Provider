import { createHash } from "node:crypto";
import { closeSync, openSync, writeSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, parse, relative, resolve, sep, win32 } from "node:path";
import { spawn } from "node:child_process";
import { isDeepStrictEqual, stripVTControlCharacters } from "node:util";
import { verifyPackage, type PackageVerificationResult } from "./verify-package.ts";

type JsonObject = Record<string, unknown>;
type CommandResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; dialogueCompleted: number };
type FixtureRequest = {
  method: string;
  path: string;
  authorization: string | undefined;
  startedAt: number;
  body?: JsonObject;
  responseBody?: JsonObject;
  status?: number;
  completedAt?: number;
  closedAt?: number;
  firstTokenAt?: number;
  stalled?: boolean;
  failure?: string;
};
type FixtureServer = {
  url: string;
  requests: FixtureRequest[];
  setModelsStatus(status: 200 | 503): void;
  stallMetadata(): void;
  releaseMetadata(): void;
  setToolRead(path: string | undefined): void;
  close(): Promise<void>;
};
type InferenceProtocol = "responses" | "chat-completions";
type NativePlatformEvidence = { targetId: string; os: "linux" | "darwin" | "windows"; architecture: "x64" | "arm64"; libc: "glibc" | "musl" | null };
type InferenceEvidence = {
  modelId: string;
  api: "openai-responses" | "openai-completions";
  path: string;
  postCount: 1;
  streamedText: true;
  usageObserved: true;
  metadataStalledThroughFirstToken?: true;
};
type LegacyCacheEvidence = { seeded: true; seederUninstalled: true; modelId: string; api: "openai-responses"; liveDiscoveryStatus: 503; selectable: false; inferencePosts: 0 };
type ToolContinuationEvidence = {
  modelId: string;
  api: "openai-completions";
  postCount: 2;
  tool: "read";
  fileResultObserved: true;
  streamedContinuation: true;
};

const packageRoot = resolve(import.meta.dir, "..");
const packageName = "@cruxexperts/cruxomni-omp-client";
const runtimeKey = "fixture-only-runtime-key";
const adminKey = "fixture-only-admin-key";
const metadataKey = "fixture-only-metadata-key";
const providerId = "omniroute";
const responsesModelId = "fixture-responses-model";
const chatModelId = "fixture-chat-model";
const legacyNativeModelId = "fixture-legacy-native-model";
const responsesReplyText = "Fixture streamed Responses reply.";
const chatReplyText = "Fixture streamed Chat Completions reply.";
const toolReplyText = "Fixture tool result received; continuation complete.";
const toolFileText = "Native tool continuation fixture file content.";
const toolReadCallId = "call_fixture_native_read";
const legacyCacheSeederName = "@fixture/omp-legacy-dynamic-cache-seeder";
const adminFallbackPath = "/api/fallback/chains";
const adminFallbackModel = "fixture-native-admin-model";
const adminFallbackChain = [{ provider: "fixture-native-primary", priority: 1, enabled: true }];
const commandTimeoutMs = 45_000;
const sensitiveEnvironment = /(api[_-]?key|access[_-]?token|secret|password|credential|authorization|private[_-]?key|openai|anthropic|gemini|aws_|azure_)/i;
const installedCliMode = "installed-cli";
let nativeCaptureFd: number | undefined;

function objectValue(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as JsonObject;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function expectedOmpRecord(provenance: JsonObject): JsonObject {
  const values = provenance.upstreams;
  if (!Array.isArray(values)) throw new Error("provenance upstreams must be an array");
  const entry = values.map(value => objectValue(value, "upstream")).find(value => value.id === "omp");
  if (!entry) throw new Error("provenance has no OMP upstream");
  return entry;
}

type ExpectedHost = { version: string; commit: string; url: string; digest: string; checksumsUrl: string; checksumsDigest: string };
type HostCompatibility = { range: string; tested: string[] };

async function nativePlatformEvidence(): Promise<NativePlatformEvidence> {
  if (!["x64", "arm64"].includes(process.arch)) throw new Error("Unsupported smoke architecture");
  const architecture: "x64" | "arm64" = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") return { targetId: `darwin-${architecture}`, os: "darwin", architecture, libc: null };
  if (process.platform === "win32") return { targetId: `windows-${architecture}`, os: "windows", architecture, libc: null };
  if (process.platform !== "linux") throw new Error("Unsupported smoke platform");
  const report = process.report?.getReport();
  const header = report && typeof report === "object" && "header" in report ? objectValue(report.header, "native report header") : {};
  if (typeof header.glibcVersionRuntime === "string") return { targetId: `linux-${architecture}-glibc`, os: "linux", architecture, libc: "glibc" };
  const maps = await readFile("/proc/self/maps", "utf8").catch(() => "");
  if (maps.includes("ld-musl-")) return { targetId: `linux-${architecture}-musl`, os: "linux", architecture, libc: "musl" };
  throw new Error("Cannot establish the native Linux libc; no platform qualification assumed");
}

async function nativeAssetName(): Promise<string> {
  const platform = await nativePlatformEvidence();
  if (platform.os === "linux") return platform.libc === "musl" ? `omp-linux-musl-${platform.architecture}` : `omp-linux-${platform.architecture}`;
  if (platform.os === "darwin") return `omp-darwin-${platform.architecture}`;
  return `omp-windows-${platform.architecture}.exe`;
}

function expectedAssets(provenance: JsonObject, testedVersions: string[], assetName: string): ExpectedHost[] {
  const artifacts = provenance.artifacts;
  if (!Array.isArray(artifacts)) throw new Error("release artifact manifest has no artifacts array");
  const candidates = artifacts.map(value => objectValue(value, "release artifact"))
    .filter(value => value.upstream === "omp" && value.kind === "release_asset" && typeof value.url === "string" && new URL(value.url).pathname.endsWith(`/${assetName}`))
    .map(value => {
      const tag = stringValue(value.release_tag, "OMP release tag");
      const digest = stringValue(value.sha256, "OMP binary digest");
      const checksumsDigest = stringValue(value.checksums_sha256, "OMP checksums digest");
      if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^[0-9a-f]{64}$/.test(digest) || !/^[0-9a-f]{64}$/.test(checksumsDigest)) throw new Error("OMP release artifact has invalid immutable identity");
      return { version: tag.slice(1), commit: stringValue(value.peeled_commit, "OMP release commit"), url: stringValue(value.url, "OMP asset URL"), digest, checksumsUrl: stringValue(value.checksums_url, "OMP checksums URL"), checksumsDigest };
    })
    .filter(value => testedVersions.includes(value.version));
  for (const version of testedVersions) {
    if (candidates.filter(value => value.version === version).length > 1) throw new Error(`tested OMP ${version} has ambiguous native release artifacts`);
  }
  if (candidates.length === 0) throw new Error("No immutable OMP artifact is recorded for this native target");
  return candidates;
}

function isWithin(root: string, candidate: string): boolean {
  const path = relative(resolve(root), resolve(candidate));
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

async function sha256File(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

type VerifiedHost = { path: string; mode: "release-asset" | "installed-cli"; version: string; digest: string };

async function hostCompatibilityContract(): Promise<HostCompatibility> {
  const manifest = objectValue(JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")), "package manifest");
  const omp = objectValue(manifest.omp, "package manifest omp");
  const compatibility = objectValue(omp.compatibility, "package manifest omp.compatibility");
  const range = stringValue(compatibility.host, "package manifest omp.compatibility.host");
  if (!Array.isArray(compatibility.tested) || compatibility.tested.length === 0) throw new Error("package compatibility must name at least one tested OMP release");
  const tested = compatibility.tested.map((value, index) => stringValue(value, `package compatibility tested[${index}]`));
  if (tested.some(value => !/^\d+\.\d+\.\d+$/.test(value)) || new Set(tested).size !== tested.length) throw new Error("package compatibility tested releases must be unique exact semantic versions");
  return { range, tested };
}

async function verifiedBinary(assets: ExpectedHost[], supportedRange: string): Promise<VerifiedHost & { expected: ExpectedHost }> {
  const configured = process.env.OMP_BINARY_PATH ?? process.env.OMP_VERIFIED_BINARY;
  if (!configured || !isAbsolute(configured)) throw new Error("smoke requires OMP_BINARY_PATH as an absolute verified release asset path");
  const info = await lstat(configured).catch(() => undefined);
  const mode = process.env.OMP_SMOKE_HOST_MODE === installedCliMode ? installedCliMode : "release-asset";
  if (!info || (mode === "release-asset" ? !info.isFile() : !info.isFile() && !info.isSymbolicLink())) throw new Error(`OMP_BINARY_PATH is not an accepted executable file: ${configured}`);
  const resolved = await realpath(configured);
  if (!(await stat(resolved)).isFile()) throw new Error(`OMP_BINARY_PATH does not resolve to a regular file: ${configured}`);
  const observed = await sha256File(resolved);
  const version = await runCommand(configured, ["--version"], { cwd: packageRoot, env: cleanEnvironment(process.env), timeoutMs: 15_000 });
  if (version.code !== 0) throw new Error("OMP host did not report a version");
  const match = /\b(\d+\.\d+\.\d+)\b/.exec(`${version.stdout}\n${version.stderr}`);
  if (!match) throw new Error("OMP host version output did not contain semantic version data");
  const observedVersion = match[1]!;
  const expected = assets.find(item => item.version === observedVersion);
  if (mode === "release-asset") {
    if (!expected) throw new Error(`OMP ${observedVersion} is not in the tested release-asset matrix`);
    if (observed !== expected.digest) throw new Error(`OMP binary SHA-256 drift: expected ${expected.digest}, observed ${observed}`);
  } else {
    const cliManifestPath = resolve(resolved, "..", "..", "package.json");
    const cliManifest = objectValue(JSON.parse(await readFile(cliManifestPath, "utf8")), "installed OMP package manifest");
    if (cliManifest.name !== "@oh-my-pi/pi-coding-agent" || cliManifest.version !== observedVersion) throw new Error("installed OMP CLI identity does not match its version output");
    if (!Bun.semver.satisfies(observedVersion, supportedRange)) throw new Error(`installed OMP ${observedVersion} is outside supported range ${supportedRange}`);
  }
  return { path: configured, mode, version: observedVersion, digest: observed, expected: expected ?? { version: observedVersion, commit: "installed-cli", url: "installed-cli", digest: observed, checksumsUrl: "installed-cli", checksumsDigest: "0".repeat(64) } };
}

export function cleanEnvironment(source: NodeJS.ProcessEnv, profileRoot?: string, platform: NodeJS.Platform = process.platform): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  const windows = platform === "win32";
  const profilePath = windows ? win32 : undefined;
  const joinProfile = (...parts: string[]): string => profilePath ? profilePath.join(...parts) : join(...parts);
  const allowedWindowsVariables = new Set([
    "PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "COMSPEC", "PROGRAMFILES", "PROGRAMFILES(X86)", "PROGRAMW6432",
    "PROGRAMDATA", "PUBLIC", "OS", "NUMBER_OF_PROCESSORS", "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER",
    "PROCESSOR_LEVEL", "PROCESSOR_REVISION", "ALLUSERSPROFILE", "DRIVERDATA", "PSMODULEPATH",
  ]);
  const assign = (name: string, value: string, force = false): void => {
    if (windows) {
      const existingMatch = Object.keys(environment).find(existing => existing.toUpperCase() === name.toUpperCase());
      if (existingMatch && !force) return;
      if (existingMatch) delete environment[existingMatch];
      environment[name.toUpperCase()] = value;
    } else environment[name] = value;
  };
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || sensitiveEnvironment.test(name)) continue;
    if (windows ? allowedWindowsVariables.has(name.toUpperCase()) : ["PATH", "LANG", "LC_ALL", "TERM", "NO_COLOR", "TZ"].includes(name)) assign(name, value);
  }
  if (profileRoot) {
    const home = joinProfile(profileRoot, windows ? "windows-user" : "home");
    assign("HOME", home, true);
    assign("OMP_PROFILE", "omniroute-smoke", true);
    if (windows) {
      assign("USERPROFILE", home, true);
      assign("APPDATA", joinProfile(profileRoot, "windows-appdata", "Roaming"), true);
      assign("LOCALAPPDATA", joinProfile(profileRoot, "windows-appdata", "Local"), true);
      assign("TEMP", joinProfile(profileRoot, "windows-temp"), true);
      assign("TMP", joinProfile(profileRoot, "windows-temp"), true);
      const driveRoot = profilePath?.parse(home).root ?? parse(home).root;
      if (driveRoot) {
        assign("HOMEDRIVE", driveRoot.replace(/[\\/]$/, ""), true);
        assign("HOMEPATH", home.slice(driveRoot.length - 1), true);
      }
    } else {
      assign("XDG_CONFIG_HOME", joinProfile(profileRoot, "config"), true);
      assign("XDG_DATA_HOME", joinProfile(profileRoot, "data"), true);
      assign("XDG_CACHE_HOME", joinProfile(profileRoot, "cache"), true);
      assign("OMP_AGENT_DIR", joinProfile(profileRoot, "agent"), true);

    }
  }
  return environment;
}

type NpmInstallationEvidence = {
  method: "npm";
  version: string;
  archiveSha256: string;
  metadataGets: number;
  tarballGets: 1;
  installedFiles: number;
  ordinaryDirectory: true;
  fileDigestsMatched: true;
  noInstalledHostSdk: true;
  credentialFreeRegistry: true;
};

async function installedPackageFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`installed package contains a symbolic link: ${path}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path.split(sep).join("/"));
      else throw new Error(`installed package contains a non-regular entry: ${path}`);
    }
  };
  await visit("");
  return files.sort();
}

async function verifyNativeInstalledPackage(
  installedRoot: string,
  profile: string,
  evidence: PackageVerificationResult,
  manifest: JsonObject,
): Promise<number> {
  if (!isAbsolute(installedRoot) || !isWithin(profile, installedRoot) || resolve(installedRoot) === resolve(profile)) {
    throw new Error("native npm install returned a package path outside its isolated profile");
  }
  let directory = resolve(profile);
  for (const component of relative(directory, installedRoot).split(sep)) {
    directory = join(directory, component);
    const info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("native npm package path is not an ordinary directory");
  }
  if (!isWithin(await realpath(profile), await realpath(installedRoot))) {
    throw new Error("native npm package escaped its isolated profile through a filesystem link");
  }
  const files = await installedPackageFiles(installedRoot);
  if (files.length !== evidence.entries.length || files.some((file, index) => file !== evidence.entries[index])) {
    throw new Error("native npm package file inventory differs from the verified archive");
  }
  for (const file of files) {
    const digest = createHash("sha256").update(await readFile(join(installedRoot, file))).digest("hex");
    if (digest !== evidence.fileSha256[file]) throw new Error(`native npm package file differs from the verified archive: ${file}`);
  }
  const installedManifest = objectValue(JSON.parse(await readFile(join(installedRoot, "package.json"), "utf8")), "native installed manifest");
  if (installedManifest.name !== packageName || installedManifest.version !== manifest.version) {
    throw new Error("native npm package identity differs from the verified archive");
  }
  const modulesRoot = packageName.startsWith("@") ? resolve(installedRoot, "../..") : resolve(installedRoot, "..");
  if (basename(modulesRoot).toLowerCase() !== "node_modules") throw new Error("native npm install did not use the managed node_modules tree");
  const hostSdk = new Set(Object.keys(objectValue(manifest.peerDependencies, "packed host SDK peers")));
  const inspectDependencies = async (root: string): Promise<void> => {
    if (resolve(root) === resolve(installedRoot)) return;
    for (const entry of await readdir(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isSymbolicLink()) throw new Error("native npm dependency tree contains an unverified filesystem link");
      if (entry.isDirectory()) await inspectDependencies(path);
      else if (entry.isFile() && entry.name === "package.json") {
        const dependency = objectValue(JSON.parse(await readFile(path, "utf8")), "native installed dependency");
        if (typeof dependency.name === "string" && hostSdk.has(dependency.name)) {
          throw new Error(`native npm installation duplicated host SDK ${dependency.name}`);
        }
      }
    }
  };
  await inspectDependencies(modulesRoot);
  return files.length;
}

async function installPackedPackage(
  binary: string,
  workspace: string,
  environment: NodeJS.ProcessEnv,
  profile: string,
  evidence: PackageVerificationResult,
): Promise<NpmInstallationEvidence> {
  const archive = await readFile(evidence.archive);
  const digest = createHash("sha256").update(archive).digest("hex");
  if (digest !== evidence.archiveSha256) throw new Error("candidate archive changed after package verification");
  const integrity = `sha512-${createHash("sha512").update(archive).digest("base64")}`;
  const manifest = objectValue(JSON.parse(await readFile(join(evidence.extractedRoot, "package.json"), "utf8")), "packed manifest");
  if (manifest.name !== packageName) throw new Error("packed package name is not the candidate");
  const version = stringValue(manifest.version, "packed version");
  let registryUrl = "";
  let metadataGets = 0;
  let tarballGets = 0;
  let unexpectedRequests = 0;
  let credentialHeaders = false;
  const server = createServer((request, response) => {
    if (request.headers.authorization !== undefined || request.headers.cookie !== undefined) {
      credentialHeaders = true;
      fixtureResponse(response, 403, { error: "registry credentials are not permitted" });
      return;
    }
    let path: string;
    try {
      path = decodeURIComponent(new URL(request.url ?? "/", registryUrl).pathname);
    } catch {
      unexpectedRequests++;
      fixtureResponse(response, 400, { error: "invalid registry request" });
      return;
    }
    if ((request.method === "GET" || request.method === "HEAD") && path === `/${packageName}`) {
      if (request.method === "GET") metadataGets++;
      const metadata = {
        name: packageName,
        "dist-tags": { latest: version },
        versions: { [version]: { ...manifest, dist: { tarball: `${registryUrl}/candidate.tgz`, integrity } } },
      };
      if (request.method === "HEAD") response.end();
      else fixtureResponse(response, 200, metadata);
    } else if ((request.method === "GET" || request.method === "HEAD") && path === "/candidate.tgz") {
      if (request.method === "GET") tarballGets++;
      response.writeHead(200, { "content-type": "application/octet-stream", "content-length": archive.byteLength });
      response.end(request.method === "HEAD" ? undefined : archive);
    } else {
      unexpectedRequests++;
      fixtureResponse(response, 404, { error: "only the verified candidate is available" });
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolvePromise);
  });
  try {
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("npm fixture did not expose a loopback address");
    registryUrl = `http://127.0.0.1:${address.port}`;
    const result = await runCommand(binary, ["install", `${packageName}@${version}`, "--json"], {
      cwd: workspace,
      env: {
        ...environment,
        npm_config_registry: registryUrl,
        BUN_CONFIG_REGISTRY: registryUrl,
        BUN_INSTALL_CACHE_DIR: join(profile, "bun-cache"),
      },
    });
    const installed = requireJsonText(requireSuccess(result, "native npm install"), "native npm install");
    if (credentialHeaders || unexpectedRequests !== 0 || metadataGets === 0 || tarballGets !== 1) {
      throw new Error("native npm install did not exclusively fetch the verified candidate without credentials");
    }
    const installedFiles = await verifyNativeInstalledPackage(
      stringValue(installed.path, "native install path"), profile, evidence, manifest,
    );
    return {
      method: "npm",
      version,
      archiveSha256: digest,
      metadataGets,
      tarballGets: 1,
      installedFiles,
      ordinaryDirectory: true,
      fileDigestsMatched: true,
      noInstalledHostSdk: true,
      credentialFreeRegistry: true,
    };
  } finally {
    await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
  }
}

function fixtureResponse(response: ServerResponse, status: number, payload: unknown): void {
  const bytes = Buffer.from(JSON.stringify(payload));
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.setHeader("content-length", bytes.byteLength);
  response.end(bytes);
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.byteLength;
    if (size > 2 * 1024 * 1024) throw new Error("fixture request body exceeds limit");
    chunks.push(bytes);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function fixtureSseHeaders(response: ServerResponse): void {
  response.statusCode = 200;
  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache");
  response.flushHeaders();
}

function fixtureSseData(response: ServerResponse, payload: unknown): void {
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function fixtureSseEvent(response: ServerResponse, event: string, payload: JsonObject): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

function fixtureResponsesStream(response: ServerResponse, record: FixtureRequest, modelId: string): void {
  const responseId = "resp_fixture_stream";
  const itemId = "msg_fixture_stream";
  const text = responsesReplyText;
  const contentPart = { type: "output_text", text, annotations: [] };
  const outputItem = { id: itemId, type: "message", role: "assistant", status: "completed", content: [contentPart] };
  fixtureSseHeaders(response);
  fixtureSseEvent(response, "response.created", {
    type: "response.created",
    response: { id: responseId, object: "response", status: "in_progress", model: modelId, output: [] },
  });
  fixtureSseEvent(response, "response.output_item.added", {
    type: "response.output_item.added",
    output_index: 0,
    item: { id: itemId, type: "message", role: "assistant", status: "in_progress", content: [] },
  });
  fixtureSseEvent(response, "response.content_part.added", {
    type: "response.content_part.added",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });
  record.firstTokenAt = Date.now();
  fixtureSseEvent(response, "response.output_text.delta", {
    type: "response.output_text.delta",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    delta: text,
  });
  fixtureSseEvent(response, "response.output_text.done", {
    type: "response.output_text.done",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    text,
  });
  fixtureSseEvent(response, "response.content_part.done", {
    type: "response.content_part.done",
    item_id: itemId,
    output_index: 0,
    content_index: 0,
    part: contentPart,
  });
  fixtureSseEvent(response, "response.output_item.done", { type: "response.output_item.done", output_index: 0, item: outputItem });
  fixtureSseEvent(response, "response.completed", {
    type: "response.completed",
    response: {
      id: responseId,
      object: "response",
      status: "completed",
      model: modelId,
      output: [outputItem],
      usage: { input_tokens: 3, output_tokens: 5, total_tokens: 8 },
    },
  });
  response.end();
}

function fixtureChatCompletionStream(response: ServerResponse, record: FixtureRequest, modelId: string, text = chatReplyText): void {
  const id = "chatcmpl_fixture_stream";
  const created = 1_760_000_000;
  fixtureSseHeaders(response);
  fixtureSseData(response, {
    id,
    object: "chat.completion.chunk",
    created,
    model: modelId,
    choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }],
  });
  record.firstTokenAt = Date.now();
  fixtureSseData(response, {
    id,
    object: "chat.completion.chunk",
    created,
    model: modelId,
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  });
  fixtureSseData(response, {
    id,
    object: "chat.completion.chunk",
    created,
    model: modelId,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
  });
  response.end("data: [DONE]\n\n");
}

function fixtureReadToolStream(response: ServerResponse, modelId: string, input: JsonObject): void {
  fixtureSseHeaders(response);
  const chunk = { id: "chatcmpl_fixture_tool", object: "chat.completion.chunk", created: 1_760_000_000, model: modelId };
  fixtureSseData(response, { ...chunk, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{
    index: 0, id: toolReadCallId, type: "function", function: { name: "read", arguments: JSON.stringify(input) },
  }] }, finish_reason: null }] });
  fixtureSseData(response, { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 } });
  response.write("data: [DONE]\n\n");
  response.end();
}

function hasNativeReadResult(body: JsonObject): boolean {
  return Array.isArray(body.messages) && body.messages.some(value => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    const message = objectValue(value, "native tool result message");
    return message.role === "tool" && message.tool_call_id === toolReadCallId
      && (typeof message.content === "string" ? message.content : JSON.stringify(message.content ?? null)).includes(toolFileText);
  });
}

async function startFixtureServer(): Promise<FixtureServer> {
  const requests: FixtureRequest[] = [];
  const fallbackChains: JsonObject = {};
  const metadataWaiters = new Set<() => void>();
  let modelsStatus: 200 | 503 = 200;
  let metadataStalled = false;
  let toolRead: { path: string; callSent: boolean } | undefined;
  const releaseMetadata = (): void => {
    metadataStalled = false;
    for (const release of [...metadataWaiters]) release();
  };
  const server = createServer(async (request, response) => {
    const host = request.socket.remoteAddress?.replace(/^::ffff:/, "");
    if (host !== "127.0.0.1" && host !== "::1") {
      fixtureResponse(response, 403, { error: "loopback_only" });
      return;
    }
    const path = request.url?.split("?", 1)[0] ?? "/";
    const record: FixtureRequest = {
      method: request.method ?? "",
      path,
      authorization: request.headers.authorization,
      startedAt: Date.now(),
    };
    requests.push(record);
    response.once("finish", () => {
      record.status = response.statusCode;
      record.completedAt = Date.now();
    });
    response.once("close", () => {
      record.status = response.statusCode;
      record.closedAt = Date.now();
    });
    try {
      const body = await requestBody(request);
      let requestJson: JsonObject | undefined;
      if (body.length > 0) {
        try {
          requestJson = objectValue(JSON.parse(body), "fixture request body");
          record.body = requestJson;
        } catch {
          fixtureResponse(response, 400, { error: "invalid_json" });
          return;
        }
      }
      if (path === "/health" || path === "/api/health") {
        fixtureResponse(response, 200, { status: "ok", server: "fixture-omniroute" });
        return;
      }
      if (path === "/v1/models") {
        if (modelsStatus !== 200) {
          fixtureResponse(response, modelsStatus, { error: "fixture_model_discovery_unavailable" });
          return;
        }
        fixtureResponse(response, 200, {
          object: "list",
          data: [
            { id: responsesModelId, object: "model", owned_by: "fixture", supported_endpoints: ["responses"] },
            { id: chatModelId, object: "model", owned_by: "fixture", supported_endpoints: ["chat-completions"], supportsTools: true },
          ],
        });
        return;
      }
      if (path === "/v1/responses" || path === "/v1/chat/completions") {
        const expectedModel = path === "/v1/responses" ? responsesModelId : chatModelId;
        if (request.method !== "POST" || requestJson?.stream !== true || requestJson.model !== expectedModel) {
          fixtureResponse(response, 400, { error: "unexpected_inference_request" });
          return;
        }
        if (path === "/v1/chat/completions" && toolRead) {
          if (!toolRead.callSent) {
            const tools = Array.isArray(requestJson.tools) ? requestJson.tools : [];
            const read = tools.map(value => objectValue(value, "advertised tool")).find(value => {
              const definition = value.function;
              return definition !== null && typeof definition === "object" && !Array.isArray(definition)
                && objectValue(definition, "tool function").name === "read";
            });
            if (!read) throw new Error("native read tool was not advertised");
            const parameters = objectValue(objectValue(read.function, "read function").parameters, "read parameters");
            const properties = objectValue(parameters.properties, "read parameter properties");
            const pathField = Object.hasOwn(properties, "path") ? "path" : Object.hasOwn(properties, "file_path") ? "file_path" : undefined;
            if (!pathField || !Array.isArray(parameters.required) || parameters.required.some(field => field !== pathField && field !== "i")) {
              throw new Error("native read tool has an unsupported required input contract");
            }
            toolRead.callSent = true;
            // OMP injects a required `i` intent field into tool wire schemas.
            // Send a real intent so its agent loop can strip it before validating ReadTool.
            const input = { [pathField]: toolRead.path, ...(Object.hasOwn(properties, "i") ? { i: "Read the disposable continuation fixture." } : {}) };
            fixtureReadToolStream(response, expectedModel, input);
          } else {
            if (!hasNativeReadResult(requestJson)) throw new Error("native continuation omitted the actual file read result");
            fixtureChatCompletionStream(response, record, expectedModel, toolReplyText);
          }
          return;
        }
        if (path === "/v1/responses") fixtureResponsesStream(response, record, expectedModel);
        else fixtureChatCompletionStream(response, record, expectedModel);
        return;
      }
      if (path === "/api/models/catalog") {
        if (request.headers.authorization !== `Bearer ${metadataKey}`) {
          fixtureResponse(response, 401, { error: "metadata_unauthorized" });
          return;
        }
        if (metadataStalled) {
          record.stalled = true;
          await new Promise<void>(resolvePromise => {
            let release!: () => void;
            release = () => {
              metadataWaiters.delete(release);
              resolvePromise();
            };
            metadataWaiters.add(release);
          });
        }
        if (response.destroyed) return;
        fixtureResponse(response, 200, {
          catalog: { fixture: { models: [{ id: responsesModelId, context_length: 4096 }, { id: chatModelId, context_length: 4096 }] } },
        });
        return;
      }
      if (path === adminFallbackPath) {
        if (request.headers.authorization !== `Bearer ${adminKey}`) {
          fixtureResponse(response, 401, { error: "admin_unauthorized" });
          return;
        }
        if (request.method === "GET" && requestJson === undefined) {
          record.responseBody = structuredClone(fallbackChains);
          fixtureResponse(response, 200, record.responseBody);
          return;
        }
        if (request.method === "POST" && isDeepStrictEqual(requestJson, { model: adminFallbackModel, chain: adminFallbackChain })) {
          fallbackChains[adminFallbackModel] = structuredClone(adminFallbackChain);
          fixtureResponse(response, 200, { success: true, model: adminFallbackModel });
          return;
        }
        if (request.method === "DELETE" && isDeepStrictEqual(requestJson, { model: adminFallbackModel })) {
          const removed = Object.hasOwn(fallbackChains, adminFallbackModel);
          delete fallbackChains[adminFallbackModel];
          fixtureResponse(response, 200, { success: true, removed });
          return;
        }
        fixtureResponse(response, 400, { error: "unexpected_fallback_request" });
        return;
      }
      if (path.startsWith("/api/")) {
        if (request.headers.authorization !== `Bearer ${adminKey}` && request.headers.authorization !== `Bearer ${runtimeKey}` && request.headers.authorization !== `Bearer ${metadataKey}`) {
          fixtureResponse(response, 401, { error: "unauthorized" });
          return;
        }
        fixtureResponse(response, 200, { ok: true, fixture: true, operation: path });
        return;
      }
      fixtureResponse(response, 404, { error: "not_found" });
    } catch (error) {
      record.failure = error instanceof Error ? error.message : String(error);
      fixtureResponse(response, 500, { error: record.failure });
    }
  });
  await new Promise<void>((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("fixture server did not expose a loopback address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    setModelsStatus: status => { modelsStatus = status; },
    setToolRead: path => { toolRead = path === undefined ? undefined : { path, callSent: false }; },
    stallMetadata: () => { metadataStalled = true; },
    releaseMetadata,
    close: async () => {
      releaseMetadata();
      await new Promise<void>((resolvePromise, reject) => server.close(error => error ? reject(error) : resolvePromise()));
    },
  };
}


type CommandOptions = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
  input?: string;
  inputSteps?: Array<{ afterMs: number; text: string }>;
  dialogue?: DialogueStep[];
};

export type DialogueStep = { when: RegExp; text: string | ((match: RegExpExecArray) => string); afterMs?: number };

/**
 * Drives prompt-based input without treating a prompt redraw as a new prompt
 * while the previous response is still waiting to be written.
 */
export function createDialogueScheduler(
  steps: readonly DialogueStep[],
  dispatch: (step: DialogueStep, index: number, text: string) => Promise<void>,
  onError: (error: unknown) => void = () => undefined,
): { observe(chunk: string): boolean; cancel(): void; readonly completed: number } {
  let completed = 0;
  let pending = false;
  let failed = false;
  let cancelled = false;
  let buffer = "";
  let pendingTimer: ReturnType<typeof setTimeout> | undefined;

  const observe = (chunk: string): boolean => {
    if (pending || failed || cancelled || completed >= steps.length) return false;
    buffer = `${buffer}${chunk}`.slice(-32_768);
    const step = steps[completed]!;
    step.when.lastIndex = 0;
    const match = step.when.exec(stripVTControlCharacters(buffer).replace(/\r\n?/g, "\n"));
    if (!match) return false;

    pending = true;
    buffer = "";
    const index = completed;
    pendingTimer = setTimeout(() => {
      pendingTimer = undefined;
      void Promise.resolve().then(() => dispatch(step, index, typeof step.text === "string" ? step.text : step.text(match))).then(() => {
        if (!cancelled) completed = index + 1;
      }).catch(error => {
        if (cancelled) return;
        failed = true;
        onError(error);
      }).finally(() => {
        if (!cancelled) {
          pending = false;
          buffer = "";
        }
      });
    }, step.afterMs ?? 100);
    return true;
  };

  return {
    observe,
    cancel() {
      cancelled = true;
      if (pendingTimer !== undefined) clearTimeout(pendingTimer);
    },
    get completed() { return completed; },
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function availableOperationDescriptionPattern(operationId: string): RegExp {
  return new RegExp(`(?:^|[\\r\\n])[ \\t]*(?:│[ \\t]*)?${escapeRegExp(operationId)}[ \\t]*·[ \\t]*available[ \\t]*(?:│[ \\t]*)?(?=\\r*$)`, "im");
}

export function availableOperationMenuPattern(category: string, operationId: string): RegExp {
  const description = availableOperationDescriptionPattern(operationId);
  return new RegExp(`Operations in ${escapeRegExp(category)}[\\s\\S]{0,4000}${description.source}`, description.flags);
}

export function nativePtyDialogueText(text: string): string {
  return text === "__ESC__" ? "\u001b" : text;
}

export const nativeAdminPromptPattern = /π-omniroute-smoke[ \t]*>[ \t]*⬢ [^>\r\n]{1,120}[ \t]*>/u;
export const nativeAdminApplyConfirmationPattern = /Apply administration plan[\s\S]{0,12000}\bYes\b[\s\S]{0,1000}\bNo\b/i;

export function hasNativeAvailableOperationDescription(output: string, operationId: string): boolean {
  const visible = stripVTControlCharacters(output).replace(/\r\n?/g, "\n");
  return availableOperationDescriptionPattern(operationId).test(visible);
}

async function runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  const timeout = options.timeoutMs ?? commandTimeoutMs;
  return await new Promise<CommandResult>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let dialogueScheduler: ReturnType<typeof createDialogueScheduler> | undefined;
    const finish = (result: Omit<CommandResult, "dialogueCompleted">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      dialogueScheduler?.cancel();
      resolvePromise({ ...result, dialogueCompleted: dialogueScheduler?.completed ?? 0 });
    };
    const advanceDialogue = (chunk: string): void => {
      const dialogue = options.dialogue;
      if (!dialogue || !dialogueScheduler) return;
      dialogueScheduler.observe(chunk);
    };
    if (options.dialogue) {
      dialogueScheduler = createDialogueScheduler(options.dialogue, async (_step, index, text) => {
        await new Promise<void>((resolveWrite, rejectWrite) => {
          if (child.stdin.destroyed || child.stdin.writableEnded) {
            rejectWrite(new Error("command input closed before dialogue input was written"));
            return;
          }
          child.stdin.write(text, error => error ? rejectWrite(error) : resolveWrite());
        });
        if (index === options.dialogue!.length - 1) {
          await new Promise<void>(resolveEnd => setTimeout(resolveEnd, 250));
          child.stdin.end();
        }
      }, () => child.kill("SIGTERM"));
    }
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 2_000).unref();
      finish({ code: null, signal: "SIGTERM", stdout, stderr: `${stderr}\ncommand timeout` });
    }, timeout);
    child.stdout.on("data", chunk => {
      const text = String(chunk);
      stdout += text;
      advanceDialogue(text);
    });
    child.stderr.on("data", chunk => {
      const text = String(chunk);
      stderr += text;
      advanceDialogue(text);
    });
    child.once("error", error => {
      dialogueScheduler?.cancel();
      reject(error);
    });
    child.stdin.on("error", () => {});
    child.once("exit", (code, signal) => finish({ code, signal, stdout, stderr }));
    if (options.inputSteps && options.inputSteps.length > 0) {
      let elapsed = 0;
      for (const step of options.inputSteps) {
        elapsed += step.afterMs;
        setTimeout(() => child.stdin.write(step.text), elapsed).unref();
      }
      setTimeout(() => child.stdin.end(), elapsed + 100).unref();
    } else if (!options.dialogue) {
      if (options.input) child.stdin.write(options.input);
      child.stdin.end();
    }
  });
}

async function runPtyCommand(binary: string, options: CommandOptions): Promise<CommandResult> {
  let stdout = "";
  let timedOut = false;
  const decoder = new TextDecoder();
  const writeInput = async (term: Bun.Terminal, text: string): Promise<void> => {
    if (!text.endsWith("\n")) {
      term.write(text);
      return;
    }
    term.write(text.slice(0, -1));
    await new Promise<void>((resolveWrite, rejectWrite) => {
      setTimeout(() => {
        if (term.closed) {
          rejectWrite(new Error("terminal closed before dialogue input was written"));
          return;
        }
        try {
          term.write("\r");
          resolveWrite();
        } catch (error) {
          rejectWrite(error);
        }
      }, 150).unref();
    });
  };
  let child: Bun.Subprocess | undefined;
  let dialogueScheduler: ReturnType<typeof createDialogueScheduler> | undefined;
  const terminal = new Bun.Terminal({
    cols: 160,
    rows: 50,
    data(term, bytes) {
      const text = decoder.decode(bytes, { stream: true });
      stdout += text;
      if (nativeCaptureFd !== undefined) {
        try {
          writeSync(nativeCaptureFd, bytes);
        } catch {
          child?.kill("SIGTERM");
        }
      }
      dialogueScheduler?.observe(text);
    },
  });
  if (options.dialogue) {
    dialogueScheduler = createDialogueScheduler(options.dialogue, async (_step, _index, text) => {
      if (text === "__SIGTERM__") {
        child?.kill("SIGTERM");
        return;
      }
      if (text === "__REFRESH_AND_STOP__") {
        if (terminal.closed) throw new Error("terminal closed before refresh dialogue input was written");
        await writeInput(terminal, "/cruxomni refresh\n");
        setTimeout(() => child?.kill("SIGTERM"), 6_000).unref();
        return;
      }
      if (terminal.closed) throw new Error("terminal closed before dialogue input was written");
      await writeInput(terminal, nativePtyDialogueText(text));
    }, () => child?.kill("SIGTERM"));
  }
  child = Bun.spawn([binary], {
    cwd: options.cwd,
    env: options.env,
    terminal,
  });
  if (options.inputSteps && options.inputSteps.length > 0) {
    let elapsed = 0;
    for (const step of options.inputSteps) {
      elapsed += step.afterMs;
      setTimeout(() => {
        if (step.text === "__SIGTERM__") child?.kill("SIGTERM");
        else if (step.text === "__ESC__") {
          if (!terminal.closed) terminal.write("\u001b");
        } else if (!terminal.closed) {
          void writeInput(terminal, step.text).catch(() => child?.kill("SIGTERM"));
        }
      }, elapsed).unref();
    }
  } else if (!options.dialogue && options.input) {
    void writeInput(terminal, options.input).catch(() => child?.kill("SIGTERM"));
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    child?.kill("SIGTERM");
    setTimeout(() => child?.kill("SIGKILL"), 2_000).unref();
  }, options.timeoutMs ?? commandTimeoutMs);
  const code = await child.exited;
  clearTimeout(timeout);
  dialogueScheduler?.cancel();
  if (!terminal.closed) terminal.close();
  return {
    code: timedOut ? null : code,
    signal: timedOut ? "SIGTERM" : child.signalCode,
    stdout,
    stderr: timedOut ? "command timeout" : "",
    dialogueCompleted: dialogueScheduler?.completed ?? 0,
  };
}


function requireSuccess(result: CommandResult, label: string): string {
  if ([runtimeKey, adminKey, metadataKey].some(secret => result.stdout.includes(secret) || result.stderr.includes(secret))) throw new Error(`${label} leaked fixture credentials`);
  if (result.code !== 0) throw new Error(`${label} failed with exit ${result.code ?? "unknown"}: ${`${result.stdout}\n${result.stderr}`.slice(-2000)}`);
  return `${result.stdout}\n${result.stderr}`;
}

function requireJsonText(text: string, label: string): JsonObject {
  try {
    return objectValue(JSON.parse(text), label);
  } catch {
    const candidates = text.trim().split(/\r?\n/).reverse();
    for (const candidate of candidates) {
      try {
        return objectValue(JSON.parse(candidate), label);
      } catch {
        // OMP may print a human-readable prefix before its JSON result.
      }
    }
  }
  throw new Error(`${label} did not produce a JSON object`);
}

async function nativePromptCancel(binary: string, cwd: string, environment: NodeJS.ProcessEnv): Promise<{ prompted: boolean; cancelled: boolean }> {
  const dialogue = [
    { when: /π-omniroute-smoke\s*>\s*⬢ no-model\s*>/u, text: "/login\n", afterMs: 4_000 },
    { when: /Select provider to login[\s\S]*?Type to search/i, text: "omniroute\n", afterMs: 250 },
    { when: /OmniRoute base URL/i, text: "\u001b", afterMs: 250 },
    { when: /π-omniroute-smoke\s*>\s*⬢ no-model\s*>/u, text: "__SIGTERM__", afterMs: 250 },
  ];
  const result = await runPtyCommand(binary, { cwd, env: environment, timeoutMs: 30_000, dialogue });
  const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
  const prompted = /OmniRoute base URL/i.test(output);
  const cancelled = result.dialogueCompleted === dialogue.length;
  if (!prompted || !cancelled || (result.code !== 0 && result.code !== 143 && result.signal !== "SIGTERM")) {
    throw new Error(`native setup did not expose a provider prompt and explicit cancellation (dialogue ${result.dialogueCompleted}/${dialogue.length}): ${output.replaceAll(runtimeKey, "[redacted]").replaceAll(adminKey, "[redacted]").slice(-2000)}`);
  }
  return { prompted, cancelled };
}

async function nativeWizardCancel(binary: string, cwd: string, environment: NodeJS.ProcessEnv): Promise<{ rendered: boolean; cancelled: boolean }> {
  const dialogue = [
    { when: /π-omniroute-smoke\s*>\s*⬢ no-model\s*>/u, text: "/cruxomni setup\n", afterMs: 4_000 },
    { when: /CruxOmni-OMP-Client\s+—\s+Setup/i, text: "\u001b", afterMs: 500 },
    { when: /π-omniroute-smoke\s*>\s*⬢ no-model\s*>/u, text: "__SIGTERM__", afterMs: 250 },
  ];
  const result = await runPtyCommand(binary, { cwd, env: environment, timeoutMs: 35_000, dialogue });
  const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
  const rendered = /CruxOmni-OMP-Client\s+—\s+Setup/i.test(output) && /Connection/i.test(output) && /Administration \(optional\)/i.test(output);
  const cancelled = result.dialogueCompleted === dialogue.length;
  if (!rendered || !cancelled || (result.code !== 0 && result.code !== 143 && result.signal !== "SIGTERM")) throw new Error(`guided wizard did not render and cancel cleanly (dialogue ${result.dialogueCompleted}/${dialogue.length})`);
  const transcriptPath = process.env.OMP_SMOKE_TRANSCRIPT_PATH;
  if (transcriptPath) {
    const sanitized = output
      .replaceAll(runtimeKey, "[redacted]").replaceAll(adminKey, "[redacted]")
      .replace(/https?:\/\/127\.0\.0\.1:\d+/g, "http://127.0.0.1:[fixture-port]")
      .replace(/\/(?:home|tmp)\/[^\s]*/g, "[redacted-path]");
    await writeFile(transcriptPath, sanitized.slice(-20_000), "utf8");
  }
  return { rendered, cancelled };
}

async function nativePromptSetup(binary: string, cwd: string, environment: NodeJS.ProcessEnv, fixtureUrl: string): Promise<{ masked: boolean }> {
  const scriptedInput = process.env.OMP_SMOKE_NATIVE_INPUTS;
  const dialogue = scriptedInput
    ? undefined
    : [
        { when: /π-omniroute-smoke\s*>\s*⬢ no-model\s*>/u, text: "/login\n", afterMs: 4_000 },
        { when: /Select provider to login[\s\S]*?Type to search/i, text: "omniroute\n", afterMs: 250 },
        { when: /OmniRoute base URL/i, text: `${fixtureUrl}\n`, afterMs: 250 },
        { when: /OmniRoute API key/i, text: `${runtimeKey}\n`, afterMs: 250 },
        { when: /Successfully logged in to omniroute/i, text: "__REFRESH_AND_STOP__", afterMs: 1_500 },
      ];
  const result = scriptedInput
    ? await runPtyCommand(binary, {
        cwd,
        env: environment,
        timeoutMs: 75_000,
        inputSteps: [{ afterMs: 1_000, text: scriptedInput }],
      })
    : await runPtyCommand(binary, {
        cwd,
        env: environment,
        timeoutMs: 75_000,
        dialogue: dialogue!,
      });
  const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
  if (result.stdout.includes(runtimeKey) || result.stderr.includes(runtimeKey)) throw new Error("native provider setup leaked fixture credentials");
  const controlledStop = result.signal === "SIGTERM" || (result.code === 143 && (!dialogue || result.dialogueCompleted === dialogue.length));
  if (result.code !== 0 && !controlledStop) throw new Error(`native provider setup failed with exit ${result.code ?? "unknown"}`);
  if (dialogue && result.dialogueCompleted !== dialogue.length) {
    const safeTail = output.replaceAll(runtimeKey, "[redacted]").replaceAll(adminKey, "[redacted]").slice(-2_000);
    throw new Error(`native provider setup did not complete its prompt sequence (dialogue ${result.dialogueCompleted}/${dialogue.length}): ${safeTail}`);
  }
  if (!/omniroute/i.test(output) || !/base url|api key/i.test(output)) throw new Error("native setup output did not identify the OmniRoute selector/prompts");
  const masked = /\*{3,}|•{3,}|secret|masked|hidden/i.test(output);
  if (!masked) throw new Error("native API-key prompt did not expose a masked/secret indicator");
  return { masked };
}

async function nativeAdminWalkthrough(binary: string, cwd: string, environment: NodeJS.ProcessEnv): Promise<void> {
  const prompt = nativeAdminPromptPattern;
  const dialogue = [
    { when: prompt, text: "/cruxomni-admin status\n", afterMs: 6_000 },
    { when: prompt, text: "/cruxomni-admin enable\n", afterMs: 500 },
    { when: /Enable OmniRoute administration[\s\S]{0,1000}\bYes\b[\s\S]{0,1000}\bNo\b/i, text: "\n", afterMs: 250 },
    { when: prompt, text: "/cruxomni-admin fallback/chains\n", afterMs: 500 },
    { when: /Administration category[\s\S]{0,1000}api\/fallback/i, text: "\n", afterMs: 250 },
    { when: availableOperationMenuPattern("api/fallback", "GET /api/fallback/chains"), text: "__ESC__", afterMs: 500 },
    { when: prompt, text: "/cruxomni-admin model-capability-overrides\n", afterMs: 500 },
    { when: /Administration category[\s\S]{0,1000}api\/model-capability-overrides/i, text: "\n", afterMs: 250 },
    { when: availableOperationMenuPattern("api/model-capability-overrides", "GET /api/model-capability-overrides"), text: "__ESC__", afterMs: 500 },
    { when: prompt, text: "__SIGTERM__", afterMs: 250 },
  ];
  const result = await runPtyCommand(binary, { cwd, env: environment, timeoutMs: 45_000, dialogue });
  const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`);
  const requiredOperations = [
    "GET /api/fallback/chains",
    "POST /api/fallback/chains",
    "DELETE /api/fallback/chains",
    "GET /api/model-capability-overrides",
    "PATCH /api/model-capability-overrides",
    "DELETE /api/model-capability-overrides",
  ];
  if (result.dialogueCompleted !== dialogue.length || (result.signal !== "SIGTERM" && result.code !== 143)) {
    throw new Error(`native administration walkthrough did not select both categories, cancel operation menus, and stop cleanly (dialogue ${result.dialogueCompleted}/${dialogue.length}, exit ${result.code ?? "unknown"})`);
  }
  for (const operationId of requiredOperations) {
    if (!hasNativeAvailableOperationDescription(output, operationId)) {
      throw new Error(`native administration browse did not show the source-qualified operation as available: ${operationId}`);
    }
  }
  if (/operation failed|read result for|plan [a-z0-9-]+ created|administration plan applied/i.test(output)) {
    throw new Error("native administration walkthrough progressed beyond the operation browser");
  }
}

type NativeAdministrationEvidence = {
  family: "fallback-chains";
  route: typeof adminFallbackPath;
  readOperationId: "GET /api/fallback/chains";
  mutationOperationId: "POST /api/fallback/chains";
  cleanupOperationId: "DELETE /api/fallback/chains";
  readRequests: number;
  mutationRequests: 1;
  cleanupRequests: 1;
  confirmedApplies: 2;
  fixtureAuthorization: true;
  exactMutationBodies: true;
  baselineAbsent: true;
  persistedRead: true;
  cleanupRead: true;
  noUnexpectedAdminRequests: true;
};

async function nativeAdministrationIo(
  binary: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  fixture: FixtureServer,
): Promise<NativeAdministrationEvidence> {
  const start = fixture.requests.length;
  const readId = "GET /api/fallback/chains";
  const postId = "POST /api/fallback/chains";
  const deleteId = "DELETE /api/fallback/chains";
  const input = (body: JsonObject): string => `${JSON.stringify(body)}\n`;
  const planCommand = (match: RegExpExecArray): string => {
    const id = match[1];
    if (!id || !/^[a-z0-9-]+$/.test(id)) throw new Error("native administration plan ID was not captured");
    return `/cruxomni-admin apply ${id}\n`;
  };
  const dialogue: DialogueStep[] = [
    { when: nativeAdminPromptPattern, text: "/cruxomni-admin enable\n", afterMs: 6_000 },
    { when: /Enable OmniRoute administration[\s\S]{0,1000}\bYes\b[\s\S]{0,1000}\bNo\b/i, text: "\n", afterMs: 250 },
    { when: /administration enabled for exact endpoint/i, text: `/cruxomni-admin ${readId}\n`, afterMs: 500 },
    { when: /Validated JSON input for GET \/api\/fallback\/chains/i, text: "{}\n", afterMs: 250 },
    { when: /read result for GET \/api\/fallback\/chains/i, text: `/cruxomni-admin ${postId}\n`, afterMs: 500 },
    { when: /Validated JSON input for POST \/api\/fallback\/chains/i, text: input({ body: { model: adminFallbackModel, chain: adminFallbackChain } }), afterMs: 250 },
    { when: /plan ([a-z0-9-]+) created/i, text: planCommand, afterMs: 500 },
    { when: /Type APPLY to confirm plan/i, text: "APPLY\n", afterMs: 250 },
    { when: nativeAdminApplyConfirmationPattern, text: "\n", afterMs: 250 },
    { when: /administration plan applied:/i, text: `/cruxomni-admin ${readId}\n`, afterMs: 500 },
    { when: /Validated JSON input for GET \/api\/fallback\/chains/i, text: "{}\n", afterMs: 250 },
    { when: new RegExp(`read result for ${escapeRegExp(readId)}:[\\s\\S]{0,1500}${escapeRegExp(adminFallbackModel)}[\\s\\S]{0,1500}${escapeRegExp(adminFallbackChain[0]!.provider)}`, "i"), text: `/cruxomni-admin ${deleteId}\n`, afterMs: 500 },
    { when: /Validated JSON input for DELETE \/api\/fallback\/chains/i, text: input({ body: { model: adminFallbackModel } }), afterMs: 250 },
    { when: /plan ([a-z0-9-]+) created/i, text: planCommand, afterMs: 500 },
    { when: /Type APPLY to confirm plan/i, text: "APPLY\n", afterMs: 250 },
    { when: nativeAdminApplyConfirmationPattern, text: "\n", afterMs: 250 },
    { when: /administration plan applied:/i, text: `/cruxomni-admin ${readId}\n`, afterMs: 500 },
    { when: /Validated JSON input for GET \/api\/fallback\/chains/i, text: "{}\n", afterMs: 250 },
    { when: /read result for GET \/api\/fallback\/chains/i, text: "__SIGTERM__", afterMs: 500 },
  ];
  const result = await runPtyCommand(binary, { cwd, env: { ...environment, OMP_OMNIROUTE_ADMIN_API_KEY: adminKey }, timeoutMs: 105_000, dialogue });
  const output = stripVTControlCharacters(`${result.stdout}\n${result.stderr}`).replace(/\r\n?/g, "\n");
  if ([runtimeKey, adminKey, metadataKey].some(secret => output.includes(secret))) throw new Error("native administration I/O leaked fixture credentials");
  if (result.dialogueCompleted !== dialogue.length || (result.signal !== "SIGTERM" && result.code !== 143)) {
    throw new Error(`native administration I/O did not complete the read, confirmed mutation, persisted read, cleanup, and final read (dialogue ${result.dialogueCompleted}/${dialogue.length}, exit ${result.code ?? "unknown"})`);
  }
  if (/operation failed|administration apply failed|administration plan was not applied|unknown or non-invokable/i.test(output)) {
    throw new Error("native administration I/O reported a failed operation");
  }
  const requests = fixture.requests.slice(start);
  const adminRequests = requests.filter(request => request.path.startsWith("/api/") && request.path !== "/api/health");
  if (adminRequests.some(request => request.path !== adminFallbackPath)) throw new Error("native administration I/O sent an unexpected administration request");
  const fallbackRequests = adminRequests.filter(request => request.path === adminFallbackPath);
  if (fallbackRequests.some(request => request.authorization !== `Bearer ${adminKey}` || request.status !== 200 || request.failure
    || request.completedAt === undefined)) throw new Error("native administration I/O request failed or used the wrong fixture credential");
  const reads = fallbackRequests.filter(request => request.method === "GET");
  const posts = fallbackRequests.filter(request => request.method === "POST");
  const deletes = fallbackRequests.filter(request => request.method === "DELETE");
  if (fallbackRequests.length !== reads.length + posts.length + deletes.length || reads.length < 3 || reads.length > 20
    || posts.length !== 1 || deletes.length !== 1) throw new Error("native administration I/O used unexpected methods or dispatch counts");
  if (reads.some(request => request.body !== undefined)
    || !isDeepStrictEqual(posts[0]!.body, { model: adminFallbackModel, chain: adminFallbackChain })
    || !isDeepStrictEqual(deletes[0]!.body, { model: adminFallbackModel })) {
    throw new Error("native administration I/O sent unexpected source-contract request bodies");
  }
  const expectedPersisted = { [adminFallbackModel]: adminFallbackChain };
  const snapshots = reads.map(request => request.responseBody);
  const baselineIndex = snapshots.findIndex(snapshot => isDeepStrictEqual(snapshot, {}));
  const persistedIndex = snapshots.findIndex((snapshot, index) => index > baselineIndex && isDeepStrictEqual(snapshot, expectedPersisted));
  const cleanupIndex = snapshots.findIndex((snapshot, index) => index > persistedIndex && isDeepStrictEqual(snapshot, {}));
  if (baselineIndex < 0 || persistedIndex < 0 || cleanupIndex < 0 || !isDeepStrictEqual(snapshots.at(-1), {})) {
    throw new Error("native administration I/O did not prove the exact persisted and cleaned-up fallback state");
  }
  if (output.split("administration plan applied:").length - 1 < 2) throw new Error("native administration I/O did not show both confirmed applies");
  return {
    family: "fallback-chains", route: adminFallbackPath,
    readOperationId: readId, mutationOperationId: postId, cleanupOperationId: deleteId,
    readRequests: reads.length, mutationRequests: 1, cleanupRequests: 1, confirmedApplies: 2,
    fixtureAuthorization: true, exactMutationBodies: true, baselineAbsent: true,
    persistedRead: true, cleanupRead: true, noUnexpectedAdminRequests: true,
  };
}

function requireNativeReply(result: CommandResult, label: string, expectedText: string): void {
  requireSuccess(result, label);
  let assistant: JsonObject | undefined;
  for (const line of result.stdout.split(/\r?\n/)) {
    let event: JsonObject;
    try { event = objectValue(JSON.parse(line), "native event"); } catch { continue; }
    if (event.type !== "message_end") continue;
    const message = objectValue(event.message, "completed native message");
    if (message.role === "assistant") assistant = message;
  }
  if (!assistant || assistant.stopReason !== "stop" || !Array.isArray(assistant.content)) {
    throw new Error(`${label} did not complete a successful assistant message`);
  }
  const text = assistant.content.map(part => objectValue(part, "assistant content"))
    .filter(part => part.type === "text").map(part => stringValue(part.text, "assistant text")).join("");
  if (text !== expectedText) throw new Error(`${label} did not assemble the streamed fixture response`);
  const usage = objectValue(assistant.usage, "assistant usage");
  if (usage.input !== 3 || usage.output !== 5) throw new Error(`${label} did not preserve the reported input/output token usage`);
}

async function nativeToolContinuation(
  binary: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  fixture: FixtureServer,
): Promise<ToolContinuationEvidence> {
  const path = join(cwd, "native-tool-result.txt");
  await writeFile(path, toolFileText, { mode: 0o600 });
  const requestStart = fixture.requests.length;
  fixture.setToolRead(path);
  try {
    const result = await runCommand(binary, [
      "--profile=omniroute-smoke", "--no-session", "--print", "--mode=json",
      "--model", `${providerId}/${chatModelId}`,
      "Complete this isolated native tool and continuation check.",
    ], { cwd, env: environment, timeoutMs: 20_000 });
    const failedRequest = fixture.requests.slice(requestStart).find(request => request.failure);
    if (failedRequest) throw new Error(`native tool fixture rejected the request: ${failedRequest.failure}`);
    requireNativeReply(result, "native tool continuation", toolReplyText);
    const posts = fixture.requests.slice(requestStart).filter(request => request.method === "POST");
    if (posts.length !== 2 || posts.some(request => request.path !== "/v1/chat/completions"
      || request.body?.model !== chatModelId || request.body.stream !== true)) {
      throw new Error("native tool continuation did not use exactly one guarded POST for each of its two turns");
    }
    if (!posts[1]!.body || !hasNativeReadResult(posts[1]!.body)) {
      throw new Error("native tool continuation did not carry the actual native file read result");
    }
    return { modelId: chatModelId, api: "openai-completions", postCount: 2, tool: "read", fileResultObserved: true, streamedContinuation: true };
  } finally {
    fixture.setToolRead(undefined);
  }
}

async function nativeProviderInference(
  binary: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  label: string,
  fixture: FixtureServer,
  protocol: InferenceProtocol,
  modelId: string,
  expectedText: string,
  stallMetadata = false,
): Promise<InferenceEvidence> {
  const requestStart = fixture.requests.length;
  if (stallMetadata) fixture.stallMetadata();
  try {
    const result = await runCommand(binary, [
      "--profile=omniroute-smoke",
      "--no-session",
      "--print",
      "--mode=json",
      "--model",
      `${providerId}/${modelId}`,
      "Return a short reply for this isolated protocol check.",
    ], { cwd, env: environment, timeoutMs: 20_000 });
    requireNativeReply(result, label, expectedText);

    const requests = fixture.requests.slice(requestStart);
    const inferencePath = protocol === "responses" ? "/v1/responses" : "/v1/chat/completions";
    const api = protocol === "responses" ? "openai-responses" : "openai-completions";
    const posts = requests.filter(request => request.method === "POST");
    if (posts.length !== 1 || posts[0]!.path !== inferencePath) throw new Error(`${label} did not make exactly one ${inferencePath} POST`);
    const post = posts[0]!;
    const postBody = post.body;
    if (!postBody || postBody.model !== modelId || postBody.stream !== true) throw new Error(`${label} did not send the exact model ID as a streaming request`);
    const discovery = requests.find(request => request.method === "GET" && request.path === "/v1/models");
    if (!discovery || discovery.status !== 200 || discovery.startedAt > post.startedAt) {
      throw new Error(`${label} did not discover live models before its first inference POST`);
    }

    if (stallMetadata) {
      const metadata = requests.find(request => request.path === "/api/models/catalog" && request.authorization === `Bearer ${metadataKey}`);
      if (!metadata?.stalled || metadata.completedAt !== undefined || metadata.startedAt > post.startedAt) {
        throw new Error(`${label} did not keep optional metadata pending alongside inference`);
      }
      if (post.firstTokenAt === undefined || post.firstTokenAt < metadata.startedAt || post.firstTokenAt - metadata.startedAt >= 5_000) {
        throw new Error(`${label} waited for the five-second optional-metadata deadline before its first streamed token`);
      }
    }
    return {
      modelId,
      api,
      path: inferencePath,
      postCount: 1,
      streamedText: true,
      usageObserved: true,
      ...(stallMetadata ? { metadataStalledThroughFirstToken: true as const } : {}),
    };
  } finally {
    if (stallMetadata) fixture.releaseMetadata();
  }
}

async function seedLegacyNativeCache(binary: string, cwd: string, environment: NodeJS.ProcessEnv, fixture: FixtureServer): Promise<void> {
  const seederRoot = join(cwd, "legacy-dynamic-cache-seeder");
  const cacheProbePath = join(seederRoot, "dynamic-model-fetches");
  const seederEnvironment = {
    ...environment,
    OMP_OMNIROUTE_BASE_URL: fixture.url,
    OMP_OMNIROUTE_API_KEY: runtimeKey,
    OMP_LEGACY_CACHE_PROBE: cacheProbePath,
  };
  await mkdir(seederRoot, { recursive: true });
  await writeFile(join(seederRoot, "package.json"), `${JSON.stringify({
    name: legacyCacheSeederName,
    version: "0.0.0",
    type: "module",
    omp: { name: "Legacy Dynamic Cache Seeder", extensions: ["./index.js"] },
  }, null, 2)}\n`, "utf8");
  // Seed an adversarial native-API row that survives cross-process cache restoration.
  // authHeader would add an unrestorable header resolver and force another discovery.
  await writeFile(join(seederRoot, "index.js"), `import { appendFile } from "node:fs/promises";
export default function (pi) {
  pi.registerProvider("${providerId}", {
    baseUrl: process.env.OMP_OMNIROUTE_BASE_URL + "/v1",
    api: "openai-responses",
    apiKey: "OMP_OMNIROUTE_API_KEY",
    fetchDynamicModels: async () => {
      await appendFile(process.env.OMP_LEGACY_CACHE_PROBE, "x");
      return [{
        id: "${legacyNativeModelId}",
        name: "Legacy native cache fixture",
        api: "openai-responses",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 4096,
        maxTokens: 1024
      }];
    }
  });
}
`, "utf8");

  let linked = false;
  try {
    const linkedSeeder = await runCommand(binary, ["plugin", "link", seederRoot], { cwd, env: seederEnvironment });
    requireSuccess(linkedSeeder, "legacy cache seeder link");
    linked = true;
    await checkPluginState(binary, cwd, seederEnvironment, "present", legacyCacheSeederName);
    const refreshed = await runCommand(binary, ["--profile=omniroute-smoke", "models", "refresh", "--json"], { cwd, env: seederEnvironment });
    const rows = requireModelList(requireJsonText(requireSuccess(refreshed, "legacy cache seeder refresh"), "legacy cache seeder refresh"), "legacy cache seeder refresh");
    requireListedChatModel(rows, legacyNativeModelId, "legacy cache seeder refresh");
    const initialFetches = await readFile(cacheProbePath, "utf8");
    if (initialFetches.length === 0) throw new Error("legacy cache seeder did not invoke its public dynamic-model callback");
    const cachedList = await runCommand(binary, ["--profile=omniroute-smoke", "models", "--json"], { cwd, env: seederEnvironment });
    const cachedRows = requireModelList(requireJsonText(requireSuccess(cachedList, "legacy cache-aware model list"), "legacy cache-aware model list"), "legacy cache-aware model list");
    requireListedChatModel(cachedRows, legacyNativeModelId, "legacy cache-aware model list");
    if (await readFile(cacheProbePath, "utf8") !== initialFetches) {
      throw new Error("legacy cache-aware model list fetched dynamic models again instead of reusing the refreshed cache");
    }
    const uninstalledSeeder = await runCommand(binary, ["plugin", "uninstall", legacyCacheSeederName], { cwd, env: seederEnvironment });
    requireSuccess(uninstalledSeeder, "legacy cache seeder uninstall");
    linked = false;
    await checkPluginState(binary, cwd, seederEnvironment, "absent", legacyCacheSeederName);
  } finally {
    if (linked) await runCommand(binary, ["plugin", "uninstall", legacyCacheSeederName], { cwd, env: seederEnvironment }).catch(() => undefined);
    await rm(seederRoot, { recursive: true, force: true });
  }
}

async function rejectLegacyNativeCacheModel(binary: string, cwd: string, environment: NodeJS.ProcessEnv, fixture: FixtureServer): Promise<LegacyCacheEvidence> {
  const requestStart = fixture.requests.length;
  const listed = await runCommand(binary, ["--profile=omniroute-smoke", "models", "--json"], { cwd, env: environment });
  const rows = requireModelList(requireJsonText(requireSuccess(listed, "failed-discovery model list"), "failed-discovery model list"), "failed-discovery model list");
  if (rows.some(model => model.id === legacyNativeModelId)) throw new Error("failed live discovery exposed a selectable legacy native API model");
  const refreshed = await runCommand(binary, ["--profile=omniroute-smoke", "models", "refresh", "--json"], { cwd, env: environment });
  const refreshedRows = requireModelList(requireJsonText(requireSuccess(refreshed, "failed-discovery forced refresh"), "failed-discovery forced refresh"), "failed-discovery forced refresh");
  if (refreshedRows.some(model => model.id === legacyNativeModelId)) throw new Error("failed forced refresh exposed a selectable legacy native API model");
  const inferenceRequestStart = fixture.requests.length;
  const result = await runCommand(binary, [
    "--profile=omniroute-smoke",
    "--no-session",
    "--print",
    "--mode=json",
    "--model",
    `${providerId}/${legacyNativeModelId}`,
    "Reply with the text that was cached by the old native provider.",
  ], { cwd, env: environment, timeoutMs: 20_000 });
  const output = `${result.stdout}\n${result.stderr}`;
  if ([runtimeKey, adminKey, metadataKey].some(secret => output.includes(secret))) throw new Error("legacy cache rejection leaked fixture credentials");
  if (result.code === 0 || result.code === null || result.signal !== null || (!output.includes(legacyNativeModelId) && !/model_not_in_live_catalog/i.test(output))) {
    throw new Error(`legacy native-cache model was not rejected as an unavailable model after live discovery failed: ${output.replaceAll(runtimeKey, "[redacted]").replaceAll(adminKey, "[redacted]").replaceAll(metadataKey, "[redacted]").slice(-2_000)}`);
  }
  const requests = fixture.requests.slice(requestStart);
  if (!fixture.requests.slice(inferenceRequestStart).some(request => request.method === "GET" && request.path === "/v1/models" && request.status === 503)) {
    throw new Error("legacy cache rejection did not exercise failed live model discovery");
  }
  const inferencePosts = requests.filter(request => request.method === "POST");
  if (inferencePosts.length !== 0) throw new Error("legacy native-cache model dispatched inference after live discovery failed");
  return { seeded: true, seederUninstalled: true, modelId: legacyNativeModelId, api: "openai-responses", liveDiscoveryStatus: 503, selectable: false, inferencePosts: 0 };
}

function requireListedChatModel(models: JsonObject[], modelId: string, label: string): void {
  // OMP's public models JSON omits Model.api; provider, selector, and kind are its serialized identity.
  const matches = models.filter(model => model.id === modelId);
  const model = matches[0];
  if (
    matches.length !== 1 ||
    model?.provider !== providerId ||
    model.selector !== `${providerId}/${modelId}` ||
    model.kind !== "chat"
  ) {
    throw new Error(`${label} did not expose exactly one selectable ${providerId} chat model for ${modelId}`);
  }
}

function requireGuardedModels(models: JsonObject[], label: string): void {
  for (const id of [responsesModelId, chatModelId]) {
    requireListedChatModel(models, id, label);
  }
  if (models.some(model => model.id === legacyNativeModelId)) {
    throw new Error(`${label} exposed the pre-upgrade native API cache row`);
  }
}

function requireModelList(parsed: JsonObject, label: string): JsonObject[] {
  if (!Array.isArray(parsed.models)) throw new Error(`${label} JSON did not contain a models array`);
  return parsed.models.map((model, index) => objectValue(model, `${label} model ${index}`));
}

function pluginIsEnabled(value: unknown, expectedName = packageName): boolean {
  if (Array.isArray(value)) return value.some(item => pluginIsEnabled(item, expectedName));
  if (!value || typeof value !== "object") return false;
  const entry = value as Record<string, unknown>;
  const identity = [entry.name, entry.id, entry.package, entry.packageName].find(item => item === expectedName);
  if (identity === expectedName) return entry.enabled !== false;
  return Object.values(entry).some(item => pluginIsEnabled(item, expectedName));
}

async function checkPluginState(
  binary: string,
  cwd: string,
  environment: NodeJS.ProcessEnv,
  expected: "present" | "absent",
  expectedName = packageName,
): Promise<JsonObject> {
  const result = await runCommand(binary, ["plugin", "list", "--json"], { cwd, env: environment });
  const output = requireSuccess(result, "plugin list");
  const parsed = requireJsonText(output, "plugin list");
  const present = pluginIsEnabled(parsed, expectedName);
  if ((expected === "present" && !present) || (expected === "absent" && present)) throw new Error(`plugin list state mismatch for ${expectedName}: expected ${expected}`);
  return parsed;
}

export interface SmokeResult {
  status: "verified";
  platform: NativePlatformEvidence;
  host: { mode: "release-asset" | "installed-cli"; version: string; digest: string; supportedRange: string };
  upstream: { version: string; commit: string; asset: string; digest: string };
  fixture: {
    baseUrl: string;
    requests: number;
    modelDiscoveryGets: number;
    failedDiscoveryGets: number;
    responsesPosts: number;
    chatCompletionsPosts: number;
    metadataCatalogRequests: number;
    loopbackOnly: true;
  };
  native: {
    prompt: boolean;
    cancellation: boolean;
    wizardRendered: boolean;
    wizardCancellation: boolean;
    maskedPrompt: boolean;
    persisted: true;
    inference: {
      startupResponses: InferenceEvidence;
      startupChatCompletions: InferenceEvidence;
      persistedChatCompletions: InferenceEvidence;
    };
    legacyCache: LegacyCacheEvidence;
    toolContinuation: ToolContinuationEvidence;
    administration: NativeAdministrationEvidence;
  };
  installation: NpmInstallationEvidence;
  pluginLifecycle: { installed: true; disabled: true; enabled: true; uninstalled: true };
}

export async function runSmoke(): Promise<SmokeResult> {
  const packageArchivePath = process.env.OMP_SMOKE_PACKAGE_ARCHIVE;
  const packageArchiveSha256 = process.env.OMP_SMOKE_PACKAGE_SHA256;
  const capturePipe = process.env.OMP_SMOKE_CAPTURE_FIFO;
  const captureAdmin = process.env.OMP_SMOKE_CAPTURE_ADMIN === "1";
  if (captureAdmin && !capturePipe) throw new Error("OMP_SMOKE_CAPTURE_ADMIN requires OMP_SMOKE_CAPTURE_FIFO");
  if (capturePipe !== undefined && !isAbsolute(capturePipe)) throw new Error("OMP_SMOKE_CAPTURE_FIFO must be an absolute private FIFO path");
  if ((packageArchivePath === undefined) !== (packageArchiveSha256 === undefined)) {
    throw new Error("OMP_SMOKE_PACKAGE_ARCHIVE and OMP_SMOKE_PACKAGE_SHA256 must be provided together");
  }
  const platform = await nativePlatformEvidence();
  const expectedTarget = process.env.OMP_QUALIFICATION_TARGET_ID;
  if (expectedTarget !== undefined && expectedTarget !== platform.targetId) {
    throw new Error(`native smoke target mismatch: expected ${expectedTarget}, observed ${platform.targetId}`);
  }
  const provenance = objectValue(JSON.parse(await readFile(resolve(packageRoot, "provenance/upstreams.json"), "utf8")), "provenance");
  const latestOmpRelease = objectValue(expectedOmpRecord(provenance).release, "provenance OMP release");
  const latestOmpVersion = stringValue(latestOmpRelease.version, "provenance OMP release version");
  const compatibility = await hostCompatibilityContract();
  if (!compatibility.tested.includes(latestOmpVersion)) throw new Error(`pinned latest OMP ${latestOmpVersion} must be included in the tested host matrix`);
  const releaseArtifacts = objectValue(JSON.parse(await readFile(resolve(packageRoot, "provenance/release-artifacts.json"), "utf8")), "release artifacts");
  const host = await verifiedBinary(expectedAssets(releaseArtifacts, compatibility.tested, await nativeAssetName()), compatibility.range);
  const binary = host.path;
  const configuredTempRoot = process.env.OMP_SMOKE_TEMP_ROOT;
  let tempRoot = tmpdir();
  if (configuredTempRoot !== undefined) {
    if (!isAbsolute(configuredTempRoot)) throw new Error("OMP_SMOKE_TEMP_ROOT must be an absolute isolated directory");
    const requestedRoot = resolve(configuredTempRoot);
    const requestedInfo = await lstat(requestedRoot).catch(() => undefined);
    if (!requestedInfo?.isDirectory() || requestedInfo.isSymbolicLink()) {
      throw new Error("OMP_SMOKE_TEMP_ROOT must name an existing ordinary directory");
    }
    if (process.platform !== "win32" && (requestedInfo.mode & 0o077) !== 0) {
      throw new Error("OMP_SMOKE_TEMP_ROOT must be private to the current user");
    }
    tempRoot = await realpath(requestedRoot);
    if (tempRoot !== requestedRoot) throw new Error("OMP_SMOKE_TEMP_ROOT cannot resolve through a symbolic path");
  }
  const root = await mkdtemp(join(tempRoot, "cruxomni-smoke-"));
  const rootInfo = await lstat(root);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || !isWithin(tempRoot, await realpath(root))) {
    await rm(root, { recursive: true, force: true });
    throw new Error("smoke temporary profile escaped its private temporary root");
  }
  const workspace = join(root, "workspace");
  const profile = join(root, "profile");
  const environment = cleanEnvironment(process.env, profile);
  const fixture = await startFixtureServer();
  let packageEvidence: PackageVerificationResult | undefined;
  try {
    await mkdir(profile, { recursive: true });
    await mkdir(workspace, { recursive: true });
    if (process.platform === "win32") await mkdir(environment.TEMP!, { recursive: true });
    if (capturePipe !== undefined) {
      const captureInfo = await lstat(capturePipe).catch(() => undefined);
      if (!captureInfo?.isFIFO()) throw new Error("OMP_SMOKE_CAPTURE_FIFO must name an existing FIFO");
      nativeCaptureFd = openSync(capturePipe, "w");
    }
    const packageRootInfo = resolve(packageRoot);
    packageEvidence = await verifyPackage({
      keepTemporary: true,
      ...(packageArchivePath === undefined ? {} : { archivePath: packageArchivePath, expectedArchiveSha256: packageArchiveSha256! }),
    });
    if (isWithin(packageRootInfo, packageEvidence.extractedRoot)) throw new Error("package extraction is inside the source repository");

    await seedLegacyNativeCache(binary, workspace, environment, fixture);
    fixture.setModelsStatus(503);
    const bindingEnvironment = {
      ...environment,
      OMP_OMNIROUTE_BASE_URL: fixture.url,
      OMP_OMNIROUTE_API_KEY: runtimeKey,
    };
    // Only the disposable legacy-cache seeder uses the developer-link path.
    const installation = await installPackedPackage(binary, workspace, environment, profile, packageEvidence);
    await checkPluginState(binary, workspace, bindingEnvironment, "present");
    const legacyCache = await rejectLegacyNativeCacheModel(binary, workspace, bindingEnvironment, fixture);
    fixture.setModelsStatus(200);

    const startupResponses = await nativeProviderInference(
      binary,
      workspace,
      { ...bindingEnvironment, OMP_OMNIROUTE_METADATA_API_KEY: metadataKey },
      "startup Responses inference",
      fixture,
      "responses",
      responsesModelId,
      responsesReplyText,
      true,
    );
    const startupChatCompletions = await nativeProviderInference(
      binary,
      workspace,
      bindingEnvironment,
      "startup Chat Completions inference",
      fixture,
      "chat-completions",
      chatModelId,
      chatReplyText,
    );
    const toolContinuation = await nativeToolContinuation(binary, workspace, bindingEnvironment, fixture);
    const refreshed = await runCommand(binary, ["models", "refresh", "--json"], { cwd: workspace, env: bindingEnvironment });
    const refreshJson = requireJsonText(requireSuccess(refreshed, "models refresh"), "models refresh");
    requireGuardedModels(requireModelList(refreshJson, "models refresh"), "models refresh");

    const nativeEnvironment = cleanEnvironment(process.env, profile);
    const setupVersion = await runCommand(binary, ["config", "set", "setupVersion", "2"], { cwd: workspace, env: nativeEnvironment });
    requireSuccess(setupVersion, "setup version initialization");
    const cancelled = await nativePromptCancel(binary, workspace, nativeEnvironment);
    const wizard = await nativeWizardCancel(binary, workspace, nativeEnvironment);
    const nativeSetup = await nativePromptSetup(binary, workspace, nativeEnvironment, fixture.url);
    const persistedChatCompletions = await nativeProviderInference(
      binary,
      workspace,
      nativeEnvironment,
      "persisted Chat Completions inference",
      fixture,
      "chat-completions",
      chatModelId,
      chatReplyText,
    );
    if (captureAdmin) {
      const beforeAdminBrowse = fixture.requests.length;
      await nativeAdminWalkthrough(binary, workspace, nativeEnvironment);
      const adminRequests = fixture.requests.slice(beforeAdminBrowse).filter(request =>
        /^\/(?:api\/fallback\/chains|api\/model-capability-overrides)(?:\/|\?|$)/.test(request.path),
      );
      if (adminRequests.length > 0) throw new Error("native admin browser sent an operation request instead of cancelling at the operation prompt");
    }
    const administration = await nativeAdministrationIo(binary, workspace, nativeEnvironment, fixture);

    const disabled = await runCommand(binary, ["plugin", "disable", packageName], { cwd: workspace, env: environment });
    requireSuccess(disabled, "plugin disable");
    await checkPluginState(binary, workspace, environment, "absent");
    const enabled = await runCommand(binary, ["plugin", "enable", packageName], { cwd: workspace, env: environment });
    requireSuccess(enabled, "plugin enable");
    await checkPluginState(binary, workspace, bindingEnvironment, "present");
    const uninstalled = await runCommand(binary, ["plugin", "uninstall", packageName], { cwd: workspace, env: environment });
    requireSuccess(uninstalled, "plugin uninstall");
    await checkPluginState(binary, workspace, environment, "absent");

    const allowedAuthorization = new Set([`Bearer ${runtimeKey}`, `Bearer ${adminKey}`, `Bearer ${metadataKey}`]);
    if (fixture.requests.some(request => request.authorization && !allowedAuthorization.has(request.authorization))) {
      throw new Error("fixture server observed a non-fixture credential");
    }
    const modelDiscoveryGets = fixture.requests.filter(request => request.method === "GET" && request.path === "/v1/models").length;
    const failedDiscoveryGets = fixture.requests.filter(request => request.method === "GET" && request.path === "/v1/models" && request.status === 503).length;
    const responsesPosts = fixture.requests.filter(request => request.method === "POST" && request.path === "/v1/responses").length;
    const chatCompletionsPosts = fixture.requests.filter(request => request.method === "POST" && request.path === "/v1/chat/completions").length;
    const metadataCatalogRequests = fixture.requests.filter(request => request.method === "GET" && request.path === "/api/models/catalog").length;
    return {
      status: "verified",
      platform,
      host: { mode: host.mode, version: host.version, digest: host.digest, supportedRange: compatibility.range },
      upstream: { version: host.expected.version, commit: host.expected.commit, asset: host.expected.url, digest: host.expected.digest },
      fixture: {
        baseUrl: fixture.url,
        requests: fixture.requests.length,
        modelDiscoveryGets,
        failedDiscoveryGets,
        responsesPosts,
        chatCompletionsPosts,
        metadataCatalogRequests,
        loopbackOnly: true,
      },
      native: {
        prompt: cancelled.prompted,
        cancellation: cancelled.cancelled,
        wizardRendered: wizard.rendered,
        wizardCancellation: wizard.cancelled,
        maskedPrompt: nativeSetup.masked,
        persisted: true,
        inference: { startupResponses, startupChatCompletions, persistedChatCompletions },
        legacyCache,
        toolContinuation,
        administration,
      },
      installation,
      pluginLifecycle: { installed: true, disabled: true, enabled: true, uninstalled: true },
    };
  } finally {
    if (nativeCaptureFd !== undefined) {
      closeSync(nativeCaptureFd);
      nativeCaptureFd = undefined;
    }
    await fixture.close();
    if (packageEvidence) await rm(resolve(packageEvidence.extractedRoot, "..", ".."), { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  runSmoke()
    .then(result => process.stdout.write(`${JSON.stringify(result, null, 2)}\n`))
    .catch(error => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
