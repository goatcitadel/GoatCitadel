#Requires -Version 5.1
<#
.SYNOPSIS
  Inspect or remove only the stopped orphan services from a failed broker install.
.DESCRIPTION
  Default is read-only. Apply requires the failed install evidence, exact service
  configuration/security, and an absent provisioner directory. Never touches files
  or disks, starts services, or accepts arbitrary service names. Elevation is required.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$PackageRoot,
  [Parameter(Mandatory=$true)][string]$EvidencePath,
  [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PackageRoot 'app\install\broker-coordinator-common.ps1')
Initialize-BrokerCoordinatorNativeType
$native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
$root = 'C:\ProgramData\GoatCitadel\RemoteWorkerProvisioner'
$names = @('GoatCitadelRemoteWorkerProvisionerAvailability', 'GoatCitadelRemoteWorkerProvisioner')
$evidence = Get-Content -Raw -LiteralPath $EvidencePath | ConvertFrom-Json
if ($evidence.mode -cne 'install' -or $evidence.verdict -cne 'failed' -or
    $evidence.target -cne 'windows-x64' -or $evidence.host.machineName -cne $env:COMPUTERNAME -or
    $evidence.paths.binDirectory -cne "$root\bin" -or @($evidence.cleanupFailures).Count -lt 1) {
  throw 'REFUSED: evidence does not describe this failed local installation.'
}
if (-not (Test-BrokerCoordinatorElevation)) { throw 'REFUSED: use Administrator PowerShell.' }

function Assert-Orphan {
  param([string]$Name, [string]$ExpectedSddl)
  if ($Name -cnotin $names) { throw 'REFUSED: unknown service.' }
  if (Test-Path -LiteralPath $root) { throw 'REFUSED: provisioner payload directory exists; preserve it.' }
  $expected = '16|3|1|"' + $root + '\bin\' + $Name + '.exe"|LocalSystem||1'
  if ($native::GetServiceConfigLine($Name) -cne $expected) { throw "REFUSED: $Name configuration changed." }
  $status = $native::GetServiceStatusLine($Name).Split('|')
  if ($status[0] -cne '1' -or $status[1] -cne '0' -or $status[3] -cne '16') {
    throw "REFUSED: $Name is not a stopped own-process service."
  }
  if ((ConvertTo-CanonicalSddl ($native::GetServiceSddl($Name))) -cne (ConvertTo-CanonicalSddl $ExpectedSddl)) {
    throw "REFUSED: $Name permissions changed."
  }
}

$expectedDescriptors = @{}
foreach ($name in $names) {
  $sddl = 'O:SYD:P(A;;0x000f01ff;;;SY)(A;;0x00020035;;;BA)'
  if ($name -ceq 'GoatCitadelRemoteWorkerProvisioner') {
    $sddl += '(A;;0x00020005;;;S-1-5-80-1804173726-3601835665-1843708740-3959121232-3866049905)'
  }
  $expectedDescriptors[$name] = $sddl
  if ($native::ServiceExists($name)) {
    Assert-Orphan $name $sddl
    Write-Output "$name : verified stopped orphan from failed installation"
  } else { Write-Output "$name : already absent" }
}
if (-not $Apply) { Write-Output 'Read-only recovery preflight passed. No changes made.'; return }

# Keep the exact SCM object open throughout validation and recovery, preventing
# replacement by a different service with the same name while this handle lives.
Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public sealed class GoatBrokerRecoveryLease : SafeHandleZeroOrMinusOneIsInvalid {
    private GoatBrokerRecoveryLease(IntPtr value) : base(true) { SetHandle(value); }
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern IntPtr OpenSCManagerW(string machine, string database, uint access);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern IntPtr OpenServiceW(IntPtr manager, string name, uint access);
    [DllImport("advapi32.dll", SetLastError=true)]
    private static extern bool CloseServiceHandle(IntPtr value);
    [DllImport("advapi32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text, uint revision, out IntPtr descriptor, out uint size);
    [DllImport("advapi32.dll", SetLastError=true)]
    private static extern bool SetServiceObjectSecurity(IntPtr service, uint information, IntPtr descriptor);
    [DllImport("kernel32.dll")] private static extern IntPtr LocalFree(IntPtr value);
    protected override bool ReleaseHandle() { return CloseServiceHandle(handle); }
    public static GoatBrokerRecoveryLease Open(string name) {
        if (name != "GoatCitadelRemoteWorkerProvisioner" && name != "GoatCitadelRemoteWorkerProvisionerAvailability")
            throw new InvalidOperationException("Unknown recovery service.");
        IntPtr manager = OpenSCManagerW(null, null, 1);
        if (manager == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            IntPtr service = OpenServiceW(manager, name, 0x000a0005);
            if (service == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
            return new GoatBrokerRecoveryLease(service);
        } finally { CloseServiceHandle(manager); }
    }
    public void TakeAdministratorOwnership() {
        IntPtr descriptor; uint size;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptorW("O:BA", 1, out descriptor, out size))
            throw new Win32Exception(Marshal.GetLastWin32Error());
        bool retained = false;
        try {
            DangerousAddRef(ref retained);
            if (!SetServiceObjectSecurity(DangerousGetHandle(), 1, descriptor))
                throw new Win32Exception(Marshal.GetLastWin32Error());
        } finally { if (retained) DangerousRelease(); LocalFree(descriptor); }
    }
}
'@
$native::EnablePrivilege('SeTakeOwnershipPrivilege')
foreach ($name in $names) {
  if (-not $native::ServiceExists($name)) { continue }
  $lease = [GoatBrokerRecoveryLease]::Open($name)
  try {
    Assert-Orphan $name $expectedDescriptors[$name]
    $lease.TakeAdministratorOwnership()
    # Add DELETE only for elevated administrators on this already verified orphan.
    $temporary = $expectedDescriptors[$name].Replace('O:SY', 'O:BA').Replace('0x00020035;;;BA', '0x00030035;;;BA')
    $native::SetServiceSddl($name, $temporary)
    Assert-Orphan $name $temporary
    $native::RemoveService($name)
    Write-Output "$name : deletion requested; no files changed"
  } finally { $lease.Dispose() }
}
foreach ($name in $names) {
  if ($native::ServiceExists($name)) { throw "Recovery incomplete: $name remains present or pending deletion. Do not reinstall yet." }
}
Write-Output 'Both orphan service registrations are absent. No files or disks changed.'
