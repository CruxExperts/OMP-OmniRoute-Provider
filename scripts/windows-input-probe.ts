import { writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateWindowsDirectory, verifyPrivateWindowsConfig, verifyPrivateWindowsPath, windowsScript } from "../src/private-path.ts";

// This is a transport diagnostic, not a host smoke test or qualification evidence.
const marker = "INPUT_PROBE:";
const fixture = "/login";
const maxBytes = 1024;
const maxEvents = 128;
type KeyEvent = { vk: number; uc: number; kd: number; cs: number };
type ChildReport = { hex: string; events: KeyEvent[]; fixtureReceived: boolean; crReceived: boolean; truncated: boolean };

function child(): void {
  let raw = "";
  let pending = "";
  let decoded = "";
  const events: KeyEvent[] = [];
  let truncated = false;
  let fixtureReceived = false;
  let crReceived = false;
  let finished = false;
  let windowTimer: NodeJS.Timeout | undefined;
  const previousRaw = process.stdin.isRaw;
  const deadline = setTimeout(finish, 10_000);

  function emit(value: object): void {
    process.stdout.write(`${marker}${JSON.stringify(value)}\n`);
  }
  function cleanup(): void {
    clearTimeout(deadline);
    clearTimeout(windowTimer);
    process.stdin.removeListener("data", onData);
    process.stdout.write("\x1b[?9001l");
    if (process.stdin.isTTY) process.stdin.setRawMode(previousRaw ?? false);
    process.stdin.pause();
  }
  function finish(): void {
    if (finished) return;
    finished = true;
    try {
      const report: ChildReport = { hex: Buffer.from(raw, "latin1").toString("hex"), events, fixtureReceived, crReceived, truncated };
      emit({ type: "result", report });
    } finally {
      cleanup();
    }
  }
  function accept(code: number): void {
    if (!fixtureReceived) {
      decoded += String.fromCodePoint(code);
      if (decoded.endsWith(fixture)) {
        fixtureReceived = true;
        emit({ type: "fixture" });
        windowTimer = setTimeout(finish, 2_000);
      }
      decoded = decoded.slice(-fixture.length);
    } else if (code === 13) {
      crReceived = true;
    }
  }
  function onData(bytes: Buffer): void {
    // Only retain fixture characters and Win32 input protocol syntax. Unexpected
    // input is excluded rather than potentially recording unrelated typed data.
    const text = bytes.toString("latin1");
    for (const char of text) {
      if (!/[\x1b\[\]_;0-9/login\r\n]/.test(char)) {
        truncated = true;
        continue;
      }
      if (raw.length < maxBytes) raw += char;
      else truncated = true;
      pending += char;
    }
    while (pending.length > 0) {
      if (pending.startsWith("\x1b")) {
        const match = /^\x1b\[(\d+);(\d+);(\d+);(\d+);(\d+);(\d+)_/.exec(pending);
        if (!match) {
          if (pending.length > 80 || !/^\x1b(?:\[[0-9;]*)?$/.test(pending)) {
            pending = pending.slice(1);
            truncated = true;
            continue;
          }
          break;
        }
        const vk = Number(match[1]);
        const uc = Number(match[3]);
        const kd = Number(match[4]);
        const cs = Number(match[5]);
        if (events.length < maxEvents) events.push({ vk, uc, kd, cs });
        else truncated = true;
        if (kd === 1 && cs === 0) {
          if (vk === 13) accept(13);
          else if ((vk === 0 || vk === 231) && uc <= 0x10ffff) accept(uc);
          else if (uc !== 13 && uc <= 0x10ffff) accept(uc);
        }
        pending = pending.slice(match[0].length);
      } else {
        accept(pending.charCodeAt(0));
        pending = pending.slice(1);
      }
    }
  }
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      cleanup();
      process.kill(process.pid, signal);
    });
  }
  try {
    if (!process.stdin.isTTY) throw new Error("console input is not a TTY");
    process.stdin.setRawMode(true);
    process.stdin.on("data", onData);
    process.stdin.resume();
    process.stdout.write("\x1b[?9001h");
    emit({ type: "ready" });
  } catch {
    finish();
    process.exitCode = 1;
  }
}

async function parent(output: string): Promise<void> {
  let stage = "startup";
  const observed: { report?: ChildReport } = {};
  let timedOut = false;
  let receivedSignal: NodeJS.Signals | undefined;
  let buffer = "";
  const terminal = new Bun.Terminal({
    cols: 160,
    rows: 50,
    data(term, bytes) {
      buffer = (buffer + Buffer.from(bytes).toString("utf8")).slice(-16_384);
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        const start = line.indexOf(marker);
        if (start < 0) continue;
        try {
          const message: unknown = JSON.parse(line.slice(start + marker.length).trim());
          if (!message || typeof message !== "object" || !("type" in message)) continue;
          if (message.type === "ready" && stage === "startup") {
            stage = "fixture-sent";
            term.write(fixture);
          } else if (message.type === "fixture" && stage === "fixture-sent") {
            stage = "cr-sent";
            term.write("\r");
          } else if (message.type === "result" && "report" in message) {
            observed.report = message.report as ChildReport;
          }
        } catch {
          // Ignore non-protocol terminal output; never persist it.
        }
      }
    },
  });
  const proc = Bun.spawn([process.execPath, import.meta.path, "--child"], { terminal });
  const forward = (signal: NodeJS.Signals): void => {
    receivedSignal = signal;
    proc.kill(signal);
  };
  const onInt = (): void => forward("SIGINT");
  const onTerm = (): void => forward("SIGTERM");
  process.once("SIGINT", onInt);
  process.once("SIGTERM", onTerm);
  const deadline = setTimeout(() => {
    timedOut = true;
    proc.kill("SIGTERM");
    setTimeout(() => proc.kill("SIGKILL"), 2_000).unref();
  }, 15_000);
  let exitCode: number;
  try {
    exitCode = await proc.exited;
  } finally {
    clearTimeout(deadline);
    process.removeListener("SIGINT", onInt);
    process.removeListener("SIGTERM", onTerm);
    if (!terminal.closed) terminal.close();
  }
  const report = observed.report;
  const success = !timedOut && !receivedSignal && exitCode === 0 && stage === "cr-sent" && report?.fixtureReceived === true && report.crReceived && !report.truncated;
  writeFileSync(output, `${JSON.stringify({ diagnostic: "windows-input-transport", success, stage, timedOut, exitCode, report: report ?? null }, null, 2)}\n`);
  if (receivedSignal) process.kill(process.pid, receivedSignal);
  if (!success) process.exitCode = 1;
}

type AclPhase = { phase: string; durationMs: number; status: "ok" | "failed"; exitCode: number | null; signal: string | null; killed: boolean | null };
type AclFailure = { stage: number; exceptionType: string; innerExceptionType: string };

function childStatus(error: unknown): Pick<AclPhase, "exitCode" | "signal" | "killed"> {
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause : error;
  const child = cause && typeof cause === "object" ? cause as { code?: unknown; signal?: unknown; killed?: unknown } : {};
  return {
    exitCode: typeof child.code === "number" ? child.code : null,
    signal: child.signal === "SIGTERM" || child.signal === "SIGKILL" ? child.signal : null,
    killed: typeof child.killed === "boolean" ? child.killed : null,
  };
}

function aclFailure(stderr: string): AclFailure | null {
  const match = /(?:^|\r?\n)ACL_DIAGNOSTIC:(\d{1,2}):([A-Za-z][A-Za-z0-9.]{0,159}):([A-Za-z][A-Za-z0-9.]{0,159})(?:\r?\n|$)/.exec(stderr);
  if (!match) return null;
  const stage = Number(match[1]);
  return stage >= 1 && stage <= 15 ? { stage, exceptionType: match[2]!, innerExceptionType: match[3]! } : null;
}

async function aclProbe(output: string): Promise<void> {
  const phases: AclPhase[] = [];
  let readyMs: number | null = null;
  let eofMs: number | null = null;
  let stdinFinishedMs: number | null = null;
  const scriptBytes = Buffer.from(windowsScript, "utf16le");
  const scriptSha256 = createHash("sha256").update(scriptBytes).digest("hex");
  let helperFailure: AclFailure | null = null;
  let scriptFailure: AclFailure | null = null;
  let root: string | undefined;
  async function phase(name: string, action: () => Promise<void>, isChild = false): Promise<boolean> {
    const start = performance.now();
    try {
      await action();
      phases.push({ phase: name, durationMs: Math.round(performance.now() - start), status: "ok", exitCode: isChild ? 0 : null, signal: null, killed: isChild ? false : null });
      return true;
    } catch (error) {
      if (name === "acl-create-directory" && error instanceof Error && error.cause instanceof Error) {
        const cause = error.cause as Error & { stderr?: unknown };
        if (typeof cause.stderr === "string") helperFailure = aclFailure(cause.stderr);
      }
      phases.push({ phase: name, durationMs: Math.round(performance.now() - start), status: "failed", ...childStatus(error) });
      return false;
    }
  }

  await phase("eof-handshake", () => {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    const start = performance.now();
    const script = "$ErrorActionPreference = 'Stop'; [Console]::Out.WriteLine('READY'); $request = [Console]::In.ReadToEnd() | ConvertFrom-Json; if ($request.fixture -ne 'probe') { exit 2 }; [Console]::Out.WriteLine('EOF')";
    const encoded = Buffer.from(script, "utf16le").toString("base64");
    const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded], { windowsHide: true, timeout: 30_000 }, error => error ? reject(error) : resolve());
    let observed = "";
    child.stdout?.on("data", (bytes: Buffer) => {
      observed = (observed + bytes.toString("utf8")).slice(-128);
      if (readyMs === null && observed.includes("READY")) readyMs = Math.round(performance.now() - start);
      if (eofMs === null && observed.includes("EOF")) eofMs = Math.round(performance.now() - start);
    });
    child.stdin?.on("error", () => {});
    child.stdin?.on("finish", () => { stdinFinishedMs = Math.round(performance.now() - start); });
    child.stdin?.end(JSON.stringify({ fixture: "probe" }));
    return promise;
  }, true);

  const prepared = await phase("temp-create", async () => { root = await mkdtemp(join(tmpdir(), "omp-acl-probe-")); });
  if (prepared && root) {
    const directory = join(root, "private");
    const file = join(directory, "fixture");
    const created = await phase("acl-create-directory", () => createPrivateWindowsDirectory(directory), true);
    // Execute exactly the production script bytes on a separate path, retaining only
    // the fixed-stage sentinel and type names, never PowerShell's raw output.
    const diagnosticDirectory = join(root, "diagnostic-private");
    await phase("acl-script-diagnostic", () => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", scriptBytes.toString("base64")], { windowsHide: true, timeout: 30_000 }, (error, _stdout, stderr) => {
        scriptFailure = aclFailure(stderr);
        if (error) reject(error); else resolve();
      });
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify({ path: diagnosticDirectory, targets: [{ path: diagnosticDirectory, directory: true }], create: true }));
      return promise;
    }, true);
    if (created) {
      await phase("acl-verify-directory", () => verifyPrivateWindowsConfig(directory), true);
      const fileCreated = await phase("fixture-create", () => writeFile(file, "fixture", { flag: "wx" }));
      if (fileCreated) {
        await phase("acl-verify-file", () => verifyPrivateWindowsPath(file, false), true);
        await phase("acl-verify-config", () => verifyPrivateWindowsConfig(directory, file), true);
      }
    }
    await phase("temp-remove", () => rm(root!, { recursive: true, force: true }));
  }
  const success = phases.every(item => item.status === "ok") && readyMs !== null && eofMs !== null && stdinFinishedMs !== null;
  writeFileSync(output, `${JSON.stringify({ diagnostic: "windows-private-acl", success, scriptSha256, helperFailure, scriptFailure, handshake: { readyMs, stdinFinishedMs, eofMs }, phases }, null, 2)}\n`);
  if (!success) process.exitCode = 1;
}

if (process.argv[2] === "--child") child();
else if (process.platform === "win32" && process.argv[2] === "--acl" && process.argv[3] && process.argv.length === 4) await aclProbe(process.argv[3]);
else if (process.platform === "win32" && process.argv[2] && process.argv.length === 3) await parent(process.argv[2]);
else {
  console.error("Usage on Windows: bun run scripts/windows-input-probe.ts [--acl] <output.json>");
  process.exitCode = 1;
}
