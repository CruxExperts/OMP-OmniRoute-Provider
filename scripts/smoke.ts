import { createHash } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { spawn } from "node:child_process";
import { stripVTControlCharacters } from "node:util";
import { verifyPackage, type PackageVerificationResult } from "./verify-package.ts";

type JsonObject = Record<string, unknown>;
type CommandResult = { code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; dialogueCompleted: number };
type FixtureRequest = {
  method: string;
  path: string;
  authorization: string | undefined;
  startedAt: number;
  body?: JsonObject;
  status?: number;
  completedAt?: number;
  closedAt?: number;
  firstTokenAt?: number;
  stalled?: boolean;
};
type FixtureServer = {
  url: string;
  requests: FixtureRequest[];
  setModelsStatus(status: 200 | 503): void;
  stallMetadata(): void;
  releaseMetadata(): void;
  close(): Promise<void>;
};
type InferenceProtocol = "responses" | "chat-completions";
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
const legacyCacheSeederName = "@fixture/omp-legacy-dynamic-cache-seeder";
const commandTimeoutMs = 45_000;
const sensitiveEnvironment = /(api[_-]?key|access[_-]?token|secret|password|credential|authorization|private[_-]?key|openai|anthropic|gemini|aws_|azure_)/i;
const installedCliMode = "installed-cli";

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

function expectedAssets(provenance: JsonObject, testedVersions: string[]): ExpectedHost[] {
  const artifacts = provenance.artifacts;
  if (!Array.isArray(artifacts)) throw new Error("release artifact manifest has no artifacts array");
  const candidates = artifacts.map(value => objectValue(value, "release artifact"))
    .filter(value => value.upstream === "omp" && value.kind === "release_asset")
    .map(value => {
      const tag = stringValue(value.release_tag, "OMP release tag");
      const digest = stringValue(value.sha256, "OMP binary digest");
      const checksumsDigest = stringValue(value.checksums_sha256, "OMP checksums digest");
      if (!/^v\d+\.\d+\.\d+$/.test(tag) || !/^[0-9a-f]{64}$/.test(digest) || !/^[0-9a-f]{64}$/.test(checksumsDigest)) throw new Error("OMP release artifact has invalid immutable identity");
      return { version: tag.slice(1), commit: stringValue(value.peeled_commit, "OMP release commit"), url: stringValue(value.url, "OMP asset URL"), digest, checksumsUrl: stringValue(value.checksums_url, "OMP checksums URL"), checksumsDigest };
    })
    .filter(value => testedVersions.includes(value.version));
  for (const version of testedVersions) {
    if (candidates.filter(value => value.version === version).length !== 1) throw new Error(`tested OMP ${version} must have exactly one immutable release artifact`);
  }
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

function cleanEnvironment(source: NodeJS.ProcessEnv, profileRoot?: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined || sensitiveEnvironment.test(name)) continue;
    if (["PATH", "LANG", "LC_ALL", "TERM", "NO_COLOR", "TZ"].includes(name)) environment[name] = value;
  }
  if (profileRoot) {
    environment.HOME = join(profileRoot, "home");
    environment.XDG_CONFIG_HOME = join(profileRoot, "config");
    environment.XDG_DATA_HOME = join(profileRoot, "data");
    environment.XDG_CACHE_HOME = join(profileRoot, "cache");
    environment.OMP_AGENT_DIR = join(profileRoot, "agent");
    environment.OMP_PROFILE = "omniroute-smoke";
  }
  return environment;
}

function runtimeDependencies(value: Record<string, unknown>, label: string, hostRange: string): Record<string, string> {
  const dependencies: Record<string, string> = {};
  for (const [name, version] of Object.entries(value).sort(([left], [right]) => left.localeCompare(right))) {
    if (typeof version !== "string" || (!/^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(version) && version !== hostRange)) {
      throw new Error(`${label}.${name} must use an exact semantic version or the package OMP compatibility range`);
    }
    dependencies[name] = version;
  }
  return dependencies;
}

async function materializeRuntimeDependencies(
  extractedRoot: string,
  profileRoot: string,
  packageEvidence: PackageVerificationResult,
  hostRange: string,
): Promise<void> {
  const manifest = objectValue(JSON.parse(await readFile(join(extractedRoot, "package.json"), "utf8")), "extracted package manifest");
  const manifestDependencies = {
    ...runtimeDependencies(objectValue(manifest.dependencies ?? {}, "extracted package dependencies"), "extracted package dependencies", hostRange),
    ...runtimeDependencies(objectValue(manifest.peerDependencies ?? {}, "extracted package peer dependencies"), "extracted package peer dependencies", hostRange),
  };
  const verifiedDependencies: Record<string, string> = {};
  for (const [name, range] of Object.entries(manifestDependencies)) {
    const matches = packageEvidence.lockfile.packages.filter(item => item.name === name);
    if (matches.length !== 1 || !Bun.semver.satisfies(matches[0]!.version, range)) {
      throw new Error(`${name} does not resolve exactly once to a version allowed by the extracted manifest and verified lock`);
    }
    verifiedDependencies[name] = matches[0]!.version;
  }
  if (Object.keys(verifiedDependencies).length === 0) return;

  const lockPath = join(extractedRoot, "bun.lock");
  await writeFile(lockPath, await readFile(join(packageRoot, "bun.lock")));
  const extractedLock = await readFile(lockPath);
  if (createHash("sha256").update(extractedLock).digest("hex") !== packageEvidence.lockfile.sha256) throw new Error("packed Bun lock differs from verified source lock");
  await mkdir(profileRoot, { recursive: true });
  const bunEnvironment: NodeJS.ProcessEnv = {
    ...cleanEnvironment(process.env, profileRoot),
    BUN_INSTALL_CACHE_DIR: join(profileRoot, "bun-cache"),
  };
  const installed = await runCommand("bun", ["install", "--frozen-lockfile", "--ignore-scripts", "--production"], {
    cwd: extractedRoot,
    env: bunEnvironment,
    timeoutMs: commandTimeoutMs,
  });
  requireSuccess(installed, "frozen runtime dependency materialization");
  for (const [name, version] of Object.entries(verifiedDependencies)) {
    const packagePath = `node_modules/${name}`;
    const installedInfo = await lstat(join(extractedRoot, packagePath)).catch(() => undefined);
    if (!installedInfo?.isDirectory()) throw new Error(`host runtime dependency ${name}@${version} was not materialized inside the extracted package`);
    const receipt = objectValue(JSON.parse(await readFile(join(extractedRoot, packagePath, "package.json"), "utf8")), `installed host runtime dependency ${name}`);
    if (typeof receipt.version !== "string" || receipt.version !== version) throw new Error(`installed host runtime dependency ${name} does not match the verified lock selection`);
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

function fixtureChatCompletionStream(response: ServerResponse, record: FixtureRequest, modelId: string): void {
  const id = "chatcmpl_fixture_stream";
  const created = 1_760_000_000;
  const text = chatReplyText;
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

async function startFixtureServer(): Promise<FixtureServer> {
  const requests: FixtureRequest[] = [];
  const metadataWaiters = new Set<() => void>();
  let modelsStatus: 200 | 503 = 200;
  let metadataStalled = false;
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
            { id: chatModelId, object: "model", owned_by: "fixture", supported_endpoints: ["chat-completions"] },
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
      fixtureResponse(response, 500, { error: error instanceof Error ? error.message : String(error) });
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
  dialogue?: Array<{ when: RegExp; text: string; afterMs?: number }>;
};

async function runCommand(command: string, args: string[], options: CommandOptions): Promise<CommandResult> {
  const timeout = options.timeoutMs ?? commandTimeoutMs;
  return await new Promise<CommandResult>((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    let dialogueCompleted = 0;
    let dialogueBuffer = "";
    const finish = (result: Omit<CommandResult, "dialogueCompleted">): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({ ...result, dialogueCompleted });
    };
    const advanceDialogue = (chunk: string): void => {
      const dialogue = options.dialogue;
      if (!dialogue || dialogueCompleted >= dialogue.length) return;
      dialogueBuffer = `${dialogueBuffer}${chunk}`.slice(-32_768);
      const visibleBuffer = stripVTControlCharacters(dialogueBuffer);
      const step = dialogue[dialogueCompleted]!;
      if (!step.when.test(visibleBuffer)) return;
      dialogueCompleted++;
      dialogueBuffer = "";
      const delay = step.afterMs ?? 100;
      setTimeout(() => child.stdin.write(step.text), delay).unref();
      if (dialogueCompleted === dialogue.length) setTimeout(() => child.stdin.end(), delay + 250).unref();
    };
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
    child.once("error", reject);
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
  let dialogueCompleted = 0;
  let dialogueBuffer = "";
  let timedOut = false;
  const decoder = new TextDecoder();
  const writeInput = (term: Bun.Terminal, text: string): void => {
    if (!text.endsWith("\n")) {
      term.write(text);
      return;
    }
    term.write(text.slice(0, -1));
    setTimeout(() => {
      if (!term.closed) term.write("\r");
    }, 150).unref();
  };
  let child: Bun.Subprocess | undefined;
  const terminal = new Bun.Terminal({
    cols: 160,
    rows: 50,
    data(term, bytes) {
      const text = decoder.decode(bytes, { stream: true });
      stdout += text;
      const dialogue = options.dialogue;
      if (!dialogue || dialogueCompleted >= dialogue.length) return;
      dialogueBuffer = `${dialogueBuffer}${text}`.slice(-32_768);
      const visibleBuffer = stripVTControlCharacters(dialogueBuffer);
      const step = dialogue[dialogueCompleted]!;
      if (!step.when.test(visibleBuffer)) return;
      dialogueCompleted++;
      dialogueBuffer = "";
      setTimeout(() => {
        if (step.text === "__SIGTERM__") {
          child?.kill("SIGTERM");
        } else if (step.text === "__REFRESH_AND_STOP__") {
          if (!term.closed) {
            writeInput(term, "/cruxomni refresh\n");
            setTimeout(() => child?.kill("SIGTERM"), 6_000).unref();
          }
        } else if (!term.closed) {
          writeInput(term, step.text);
        }
      }, step.afterMs ?? 100).unref();
    },
  });
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
        if (!terminal.closed) writeInput(terminal, step.text);
      }, elapsed).unref();
    }
  } else if (!options.dialogue && options.input) {
    writeInput(terminal, options.input);
  }
  const timeout = setTimeout(() => {
    timedOut = true;
    child?.kill("SIGTERM");
    setTimeout(() => child?.kill("SIGKILL"), 2_000).unref();
  }, options.timeoutMs ?? commandTimeoutMs);
  const code = await child.exited;
  clearTimeout(timeout);
  if (!terminal.closed) terminal.close();
  return {
    code: timedOut ? null : code,
    signal: timedOut ? "SIGTERM" : child.signalCode,
    stdout,
    stderr: timedOut ? "command timeout" : "",
    dialogueCompleted,
  };
}


function requireSuccess(result: CommandResult, label: string): string {
  if (result.code !== 0) throw new Error(`${label} failed with exit ${result.code ?? "unknown"}: ${result.stderr.slice(0, 2000)}`);
  if ([runtimeKey, adminKey, metadataKey].some(secret => result.stdout.includes(secret) || result.stderr.includes(secret))) throw new Error(`${label} leaked fixture credentials`);
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
  };
  pluginLifecycle: { linked: true; disabled: true; enabled: true; uninstalled: true };
}

export async function runSmoke(): Promise<SmokeResult> {
  const provenance = objectValue(JSON.parse(await readFile(resolve(packageRoot, "provenance/upstreams.json"), "utf8")), "provenance");
  const latestOmpRelease = objectValue(expectedOmpRecord(provenance).release, "provenance OMP release");
  const latestOmpVersion = stringValue(latestOmpRelease.version, "provenance OMP release version");
  const compatibility = await hostCompatibilityContract();
  if (!compatibility.tested.includes(latestOmpVersion)) throw new Error(`pinned latest OMP ${latestOmpVersion} must be included in the tested host matrix`);
  const releaseArtifacts = objectValue(JSON.parse(await readFile(resolve(packageRoot, "provenance/release-artifacts.json"), "utf8")), "release artifacts");
  const host = await verifiedBinary(expectedAssets(releaseArtifacts, compatibility.tested), compatibility.range);
  const binary = host.path;
  const root = await mkdtemp(join(tmpdir(), "cruxomni-smoke-"));
  const workspace = join(root, "workspace");
  const profile = join(root, "profile");
  const environment = cleanEnvironment(process.env, profile);
  const fixture = await startFixtureServer();
  let packageEvidence: PackageVerificationResult | undefined;
  try {
    await mkdir(workspace, { recursive: true });
    const packageRootInfo = resolve(packageRoot);
    packageEvidence = await verifyPackage({ keepTemporary: true });
    if (isWithin(packageRootInfo, packageEvidence.extractedRoot)) throw new Error("package extraction is inside the source repository");
    await materializeRuntimeDependencies(packageEvidence.extractedRoot, profile, packageEvidence, compatibility.range);

    await seedLegacyNativeCache(binary, workspace, environment, fixture);
    fixture.setModelsStatus(503);
    const bindingEnvironment = {
      ...environment,
      OMP_OMNIROUTE_BASE_URL: fixture.url,
      OMP_OMNIROUTE_API_KEY: runtimeKey,
    };
    const linked = await runCommand(binary, ["plugin", "link", packageEvidence.extractedRoot], {
      cwd: workspace,
      env: { ...bindingEnvironment, OMP_OMNIROUTE_ADMIN_API_KEY: adminKey },
    });
    requireSuccess(linked, "plugin link");
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
      },
      pluginLifecycle: { linked: true, disabled: true, enabled: true, uninstalled: true },
    };
  } finally {
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
