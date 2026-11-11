import { execFile } from "node:child_process";
import { join } from "node:path";

// Paths are passed over stdin, never interpolated into PowerShell source. The
// directory is created with its DACL in place, before it can contain files.
export const windowsScript = String.raw`
$stage = 1
try {
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
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
  [System.IO.Directory]::CreateDirectory($request.path, $security) | Out-Null
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
 
async function windowsAcl(targets: Array<{ path: string; directory: boolean }>, create = false): Promise<void> {
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedWindowsScript], { windowsHide: true, timeout: 30_000 }, (error, _stdout, stderr) => {
    if (error) {
      // Retain only our fixed diagnostic, never arbitrary PowerShell output.
      const sentinel = /(?:^|\r?\n)(ACL_DIAGNOSTIC:(?:[1-9]|1[0-5]):[A-Za-z][A-Za-z0-9.]{0,159}:[A-Za-z][A-Za-z0-9.]{0,159})(?:\r?\n|$)/.exec(stderr)?.[1] ?? "";
      reject(new Error("Unable to establish private Windows ACL", { cause: Object.assign(error, { stderr: sentinel }) }));
    } else resolve();
  });
  child.stdin?.on("error", () => {});
  child.stdin?.end(JSON.stringify({ path: targets[0]?.path, targets, create }));
  await promise;
}

export async function createPrivateWindowsDirectory(path: string): Promise<void> {
  await windowsAcl([{ path, directory: true }], true);
}

export async function verifyPrivateWindowsPath(path: string, directory: boolean): Promise<void> {
  await windowsAcl([{ path, directory }]);
}

export async function verifyPrivateWindowsConfig(directory: string, file?: string): Promise<void> {
  await windowsAcl(file === undefined ? [{ path: directory, directory: true }] : [{ path: directory, directory: true }, { path: file, directory: false }]);
}
