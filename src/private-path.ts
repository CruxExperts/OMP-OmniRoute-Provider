import { execFile } from "node:child_process";
import { join } from "node:path";

// Opt-in smoke diagnostics contain only fixed fields, never filesystem data.
export function windowsDiagnostic(event: Record<string, string | number | boolean | null>): void {
  if (process.platform !== "win32" || process.env.OMP_SMOKE_LOGIN_DIAGNOSTICS !== "1") return;
  try { process.stderr.write(`CRUX_WINDOWS_DIAGNOSTIC:${JSON.stringify(event)}\n`); } catch { /* Diagnostics must not change behavior. */ }
}

export function diagnosticElapsed(started: number): number {
  return Math.min(0xffffff, Math.max(0, Math.floor(performance.now() - started)));
}

// Paths are passed over stdin, never interpolated into PowerShell source. The
// directory is created with its DACL in place, before it can contain files.
export const windowsScript = String.raw`
$clock = [System.Diagnostics.Stopwatch]::StartNew()
$diagnostics = $env:OMP_SMOKE_LOGIN_DIAGNOSTICS -eq '1'
function Trace-Phase([string]$phase) {
  if ($diagnostics) { try { [Console]::Error.WriteLine('ACL_PHASE:{0}:{1}', $phase, [Math]::Min(16777215, $clock.ElapsedMilliseconds)) } catch {} }
}
Trace-Phase 'first-statement'
$stage = 1
try {
$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false)
$inputText = [Console]::In.ReadToEnd()
Trace-Phase 'read-complete'
[void][System.Reflection.Assembly]::Load('System.Web.Extensions, Version=4.0.0.0, Culture=neutral, PublicKeyToken=31bf3856ad364e35')
$request = [System.Web.Script.Serialization.JavaScriptSerializer]::new().DeserializeObject($inputText)
Trace-Phase 'parse-complete'
$stage = 2
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$admins = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
$stage = 3
if ($request.create) {
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $stage = 4
  $security.SetOwner($user)
  $stage = 5
  $security.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($user, $system, $admins)) {
    $stage = 6
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit), [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    $stage = 7
    $security.AddAccessRule($rule)
  }
  $stage = 8
  [void][System.IO.Directory]::CreateDirectory($request.path, $security)
}
$trusted = @($user.Value, $system.Value, $admins.Value)
foreach ($target in $request.targets) {
  $stage = 9
  # Use the framework API directly; inherited PowerShell module paths can prevent
  # the Get-Acl cmdlet from loading in the Windows PowerShell child.
  $acl = if ($target.directory) { [System.IO.Directory]::GetAccessControl($target.path) } else { [System.IO.File]::GetAccessControl($target.path) }
  $stage = 10
  $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  $stage = 11
  if ($null -eq $descriptor.DiscretionaryAcl) { throw 'Missing discretionary ACL' }
  $stage = 12
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  $stage = 13
  if ($owner -notin $trusted) { throw 'Untrusted owner' }
  if ($target.directory -and -not $acl.AreAccessRulesProtected) { throw 'Directory inherits access rules' }
  $stage = 14
  $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  $stage = 15
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin $trusted) { throw 'Untrusted access rule' }
  }
}
Trace-Phase 'checks-complete'
} catch {
  $exceptionType = $_.Exception.GetType().FullName
  if ($exceptionType -notmatch '^[A-Za-z][A-Za-z0-9.]{0,159}$') { $exceptionType = 'Unknown' }
  $innerType = 'None'
  if ($null -ne $_.Exception.InnerException) {
    $innerType = $_.Exception.InnerException.GetType().FullName
    if ($innerType -notmatch '^[A-Za-z][A-Za-z0-9.]{0,159}$') { $innerType = 'Unknown' }
  }
  [Console]::Error.WriteLine('ACL_DIAGNOSTIC:{0}:{1}:{2}', $stage, $exceptionType, $innerType)
  exit 1
}
`;
const encodedWindowsScript = Buffer.from(windowsScript, "utf16le").toString("base64");
 
async function windowsAcl(targets: Array<{ path: string; directory: boolean }>, create = false, signal?: AbortSignal): Promise<void> {
  const started = performance.now();
  const abortedAtEntry = signal?.aborted ?? false;
  if (abortedAtEntry) windowsDiagnostic({ kind: "acl", elapsedMs: diagnosticElapsed(started), outcome: "aborted", abortedAtEntry, exitCode: null, signal: null, sentinel: "" });
  signal?.throwIfAborted();
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const closed = Promise.withResolvers<void>();
  const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedWindowsScript], { windowsHide: true, timeout: 30_000, ...(signal ? { signal } : {}) }, (error, _stdout, stderr) => {
    // Retain only our fixed diagnostic, never arbitrary PowerShell output.
    const sentinel = /(?:^|\r?\n)(ACL_DIAGNOSTIC:(?:[1-9]|1[0-5]):[A-Za-z][A-Za-z0-9.]{0,159}:[A-Za-z][A-Za-z0-9.]{0,159})(?:\r?\n|$)/.exec(stderr)?.[1] ?? "";
    const exitCode = !error ? 0 : typeof error.code === "number" && Number.isInteger(error.code) && error.code >= 0 && error.code <= 255 ? error.code : null;
    const childSignal = error && (error.signal === "SIGTERM" || error.signal === "SIGKILL") ? error.signal : null;
    windowsDiagnostic({ kind: "acl", elapsedMs: diagnosticElapsed(started), outcome: error ? "error" : "ok", abortedAtEntry, exitCode, signal: childSignal, sentinel });
    if (error) {
      if (signal?.aborted && error.name === "AbortError" && error.cause === signal.reason) {
        reject(signal.reason);
        return;
      }
      reject(new Error("Unable to establish private Windows ACL", { cause: Object.assign(error, { stderr: sentinel }) }));
    } else resolve();
  });
  child.once("exit", () => windowsDiagnostic({ kind: "acl-phase", phase: "exit", elapsedMs: diagnosticElapsed(started) }));
  if (process.env.OMP_SMOKE_LOGIN_DIAGNOSTICS === "1") {
    let pending = "";
    child.stderr?.on("data", (chunk: Buffer | string) => {
      pending += chunk.toString();
      const lines = pending.split(/\r?\n/);
      pending = (lines.pop() ?? "").slice(-128);
      for (const line of lines) {
        const match = /^ACL_PHASE:(first-statement|read-complete|parse-complete|checks-complete):([0-9]{1,8})$/.exec(line);
        if (!match) continue;
        const childElapsedMs = Number(match[2]);
        if (childElapsedMs <= 0xffffff) windowsDiagnostic({ kind: "acl-child-phase", phase: match[1]!, elapsedMs: diagnosticElapsed(started), childElapsedMs });
      }
    });
  }
  child.once("close", () => {
    windowsDiagnostic({ kind: "acl-close", elapsedMs: diagnosticElapsed(started), outcome: "ok" });
    closed.resolve();
  });
  child.stdin?.on("error", () => {});
  child.stdin?.once("finish", () => windowsDiagnostic({ kind: "acl-phase", phase: "stdin-finish", elapsedMs: diagnosticElapsed(started) }));
  child.stdin?.end(JSON.stringify({ path: targets[0]?.path, targets, create }));
  // Abort can report an error before the child closes. Keep the transaction
  // owned until no helper process can continue a directory mutation.
  try { await promise; } finally { await closed.promise; }
}

export async function createPrivateWindowsDirectory(path: string, signal?: AbortSignal): Promise<void> {
  await windowsAcl([{ path, directory: true }], true, signal);
}

export async function verifyPrivateWindowsPath(path: string, directory: boolean, signal?: AbortSignal): Promise<void> {
  await windowsAcl([{ path, directory }], false, signal);
}

export async function verifyPrivateWindowsConfig(directory: string, file?: string, signal?: AbortSignal): Promise<void> {
  await windowsAcl(file === undefined ? [{ path: directory, directory: true }] : [{ path: directory, directory: true }, { path: file, directory: false }], false, signal);
}
