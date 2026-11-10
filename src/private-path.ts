import { execFile } from "node:child_process";
import { join } from "node:path";

// Paths are passed over stdin, never interpolated into PowerShell source. The
// directory is created with its DACL in place, before it can contain files.
const windowsScript = String.raw`
$ErrorActionPreference = 'Stop'
$request = [Console]::In.ReadToEnd() | ConvertFrom-Json
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$system = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-18')
$admins = [System.Security.Principal.SecurityIdentifier]::new('S-1-5-32-544')
if ($request.create) {
  $security = [System.Security.AccessControl.DirectorySecurity]::new()
  $security.SetOwner($user)
  $security.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($user, $system, $admins)) {
    $rule = [System.Security.AccessControl.FileSystemAccessRule]::new($sid, [System.Security.AccessControl.FileSystemRights]::FullControl, ([System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit), [System.Security.AccessControl.PropagationFlags]::None, [System.Security.AccessControl.AccessControlType]::Allow)
    $security.AddAccessRule($rule)
  }
  [System.IO.Directory]::CreateDirectory($request.path, $security) | Out-Null
}
$trusted = @($user.Value, $system.Value, $admins.Value)
foreach ($target in $request.targets) {
  $acl = Get-Acl -LiteralPath $target.path
  $descriptor = [System.Security.AccessControl.RawSecurityDescriptor]::new($acl.GetSecurityDescriptorBinaryForm(), 0)
  if ($null -eq $descriptor.DiscretionaryAcl) { throw 'Missing discretionary ACL' }
  $owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value
  if ($owner -notin $trusted) { throw 'Untrusted owner' }
  if ($target.directory -and -not $acl.AreAccessRulesProtected) { throw 'Directory inherits access rules' }
  $rules = $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])
  foreach ($rule in $rules) {
    if ($rule.AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and $rule.IdentityReference.Value -notin $trusted) { throw 'Untrusted access rule' }
  }
}
`;
const encodedWindowsScript = Buffer.from(windowsScript, "utf16le").toString("base64");
 
async function windowsAcl(targets: Array<{ path: string; directory: boolean }>, create = false): Promise<void> {
  const executable = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const { promise, resolve, reject } = Promise.withResolvers<void>();
  const child = execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encodedWindowsScript], { windowsHide: true, timeout: 30_000 }, (error) => {
    if (error) reject(new Error("Unable to establish private Windows ACL", { cause: error }));
    else resolve();
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
