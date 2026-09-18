#Requires -Version 5.1
<#
.SYNOPSIS
  Update the three pinned GOATBOX broker/signer/client images while preserving installed state.
.DESCRIPTION
  Default preflight verifies exclusive update access but writes no executable.
  -Apply durably saves the original images and a prepared receipt, then replaces
  only those three existing files through held handles, preserving file identity
  and security. A caught write failure restores the originals through those same
  handles. Power-loss recovery is operator-driven using the retained backups;
  this is not an atomic transaction across three executables. Never remove state.
  Service registrations remain unchanged and services are not started or stopped.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$PackageRoot,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-fA-F0-9]{64}$')][string]$ManifestSha256,
  [Parameter(Mandatory=$true)][string]$OutputRoot,
  [switch]$Apply
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
if ([Environment]::MachineName -cne 'GOATBOX' -or $env:COMPUTERNAME -cne 'GOATBOX') { throw 'Run this repair on GOATBOX only.' }
if ([IntPtr]::Size -ne 8) { throw 'Use x64 Windows PowerShell.' }
. (Join-Path $PSScriptRoot 'broker-coordinator-common.ps1')
. (Join-Path $PSScriptRoot 'broker-state-common.ps1')
if (-not (Test-BrokerCoordinatorElevation)) { throw 'Use Administrator PowerShell.' }
Initialize-BrokerCoordinatorNativeType
Initialize-BrokerCoordinatorStateNativeType
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'broker-image-maintenance.cs')))
$native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
$imageType = [GoatCitadel.RemoteWorker.BrokerCoordinator.ImageMaintenanceLease]
$stateType = [GoatCitadel.RemoteWorker.BrokerCoordinator.StateDirectoryLease]
$package = [IO.Path]::GetFullPath($PackageRoot).TrimEnd('\')
$output = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\')
if (-not $output.StartsWith('C:\worker-evidence\client-token-query-', [StringComparison]::OrdinalIgnoreCase) -or
    [IO.Path]::GetDirectoryName($output) -cne 'C:\worker-evidence' -or (Test-Path -LiteralPath $output)) {
  throw 'Use a new client-token-query-* output folder directly under C:\worker-evidence.'
}
if ((Get-Item -LiteralPath 'C:\worker-evidence' -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Evidence root cannot be a reparse point.' }
$manifestPath = Join-Path $package 'worker-package.json'
if ((Get-FileHash -LiteralPath $manifestPath).Hash -ne $ManifestSha256) { throw 'Replacement package manifest mismatch.' }
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
if (@($manifest.files).Count -lt 3) { throw 'Replacement package inventory is empty.' }
$seen = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
$inventory = @{}
foreach ($file in $manifest.files) {
  $path = [IO.Path]::GetFullPath((Join-Path $package $file.path))
  if (-not $path.StartsWith(($package + '\'), [StringComparison]::OrdinalIgnoreCase) -or -not $seen.Add($path)) { throw 'Package inventory path is invalid or duplicated.' }
  if ((Get-FileHash -LiteralPath $path).Hash -ne $file.sha256) { throw "Replacement file mismatch: $($file.path)" }
  $inventory[$path] = [string]$file.sha256
}
Write-Host 'Replacement package files verified.'
$null = New-Item -ItemType Directory -Path $output
$leases = New-Object 'Collections.Generic.List[IDisposable]'
$images = New-Object 'Collections.Generic.List[object]'
$states = New-Object 'Collections.Generic.List[object]'
$services = New-Object 'Collections.Generic.List[object]'
$report = [ordered]@{ schema='goatcitadel.goatbox.client-token-query-update/1'; mode=$(if ($Apply) { 'apply' } else { 'preflight' });
  machineName=[Environment]::MachineName; manifestSha256=$ManifestSha256; verdict='failed'; images=@(); protectedDirectories=@();
  serviceRegistrationsChanged=$false; stateContentsAccessed=$false; refusals=@(); rollbackFailures=@() }
$old = @{
  'GoatCitadelRemoteWorkerProvisioner.exe'='be670dfd61f42bcf01b182ccdac4e3c3551c3fe3cd08290d08210a9e60c08846';
  'GoatCitadelRemoteWorkerProvisionerAvailability.exe'='069241c7653b5f314a16f9c6105bd615698ffd458853762dedb2d116a5cf14d8';
  'GoatCitadelRemoteWorkerProvisionerClient.exe'='6f7309533bf1034c537e9e4c50a19c31d07354490092e8b97d9a29ba3af05948'
}
$paths = Get-BrokerCoordinatorPaths -SystemDrive 'C:'
function Assert-ServiceConfiguration {
  foreach ($entry in @(@($script:BrokerServiceName, $paths.BrokerQuotedBinaryPath, $script:ServiceObjectSddl),
      @($script:SignerServiceName, $paths.SignerQuotedBinaryPath, $script:SignerServiceObjectSddl))) {
    if ($native::GetServiceConfigLine($entry[0]) -cne ('16|3|1|' + $entry[1] + '|LocalSystem||1') -or
        $native::GetServiceSidType($entry[0]) -ne 1 -or
        $native::GetServiceRequiredPrivileges($entry[0]) -cne 'SeChangeNotifyPrivilege' -or
        $native::GetServiceSddl($entry[0]) -cne $native::CanonicalizeSddl($entry[2])) { throw "Service configuration changed: $($entry[0])" }
  }
  foreach ($service in $services) { $service.AssertStopped() }
}
function Save-Receipt([string]$Name) {
  $bytes = [Text.Encoding]::UTF8.GetBytes(($report | ConvertTo-Json -Depth 8) + [Environment]::NewLine)
  $file = New-Object IO.FileStream((Join-Path $output $Name), [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::Read)
  try { $file.Write($bytes, 0, $bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
}
$written = New-Object 'Collections.Generic.List[object]'
$result = 1
try {
  $native::EnablePrivilege('SeBackupPrivilege')
  $native::EnablePrivilege('SeRestorePrivilege')
  foreach ($name in @($script:BrokerServiceName, $script:SignerServiceName)) {
    $service = New-Object GoatCitadel.RemoteWorker.BrokerCoordinator.ExistingServiceLease($name)
    $leases.Add($service); $services.Add($service)
  }
  Assert-ServiceConfiguration
  foreach ($directory in @('C:\', 'C:\ProgramData', $paths.GoatCitadelDirectory, $paths.ProvisionerDirectory, $paths.BinDirectory)) {
    $leases.Add((Get-BrokerCoordinatorDirectoryLease -Path $directory -GoatCitadelLevel:($directory -notin @('C:\', 'C:\ProgramData'))))
  }
  foreach ($directory in @($paths.ProvisionerDirectory, $paths.BinDirectory)) {
    if ((ConvertTo-CanonicalFileSddl -Sddl ($native::GetFileSddl($directory))) -cne (ConvertTo-CanonicalFileSddl -Sddl $script:ProtectedDirectorySddl)) { throw 'Installed parent security differs.' }
  }
  $stateRoot = Join-Path $paths.ProvisionerDirectory 'state-v1'
  foreach ($directory in @($stateRoot, (Join-Path $stateRoot 'journal'), (Join-Path $stateRoot 'keysets'), (Join-Path $stateRoot 'controls'), (Join-Path $stateRoot 'quarantine'))) {
    $state = $stateType::OpenParent($directory)
    $leases.Add($state); $states.Add($state)
    $stateType::AssertSecurity($state.ReadSecuritySddl(), $script:ProtectedStateSddl)
    $report.protectedDirectories += [ordered]@{ path=$directory; identity=$state.Identity; sddl=$state.ReadSecuritySddl() }
  }
  foreach ($name in @($script:SignerExecutableName, $script:BrokerExecutableName, $script:ClientExecutableName)) {
    $source = Join-Path $package ('app\provisioner\' + $name)
    if ((Get-Item -LiteralPath $source).Length -gt 67108864) { throw 'Replacement executable exceeds size bound.' }
    if (-not $inventory.ContainsKey($source)) { throw 'Replacement executable is absent from the verified inventory.' }
    $nextHash = $inventory[$source].ToLowerInvariant()
    $nextBytes = [IO.File]::ReadAllBytes($source)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $bytesHash = ([BitConverter]::ToString($sha.ComputeHash($nextBytes))).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose() }
    if ($bytesHash -cne $nextHash) { throw 'Replacement executable changed after inventory verification.' }
    $isClient = $name -ceq $script:ClientExecutableName

    $sddl = $(if ($name -ceq $script:BrokerExecutableName) { $script:BrokerImageSddl } else { $script:SignerImageSddl })
    $image = if ($isClient) { $imageType::OpenClientReplacement((Join-Path $paths.BinDirectory $name), $old[$name], $sddl) } else { $imageType::Open((Join-Path $paths.BinDirectory $name), $old[$name], $sddl, $true) }
    $leases.Add($image)
    $images.Add([pscustomobject]@{ name=$name; lease=$image; bytes=$nextBytes; nextHash=$nextHash })
    $report.images += [ordered]@{ name=$name; path=$image.Path; identity=$image.Identity; originalSha256=$image.OriginalSha256;
      replacementSha256=$nextHash; securitySddl=$image.SecuritySddl; backup=($name + '.before') }
  }
  Assert-ServiceConfiguration
  if ($Apply) {
    foreach ($image in $images) { $image.lease.SaveOriginal((Join-Path $output ($image.name + '.before'))) }
    $report.verdict = 'prepared'
    Save-Receipt 'prepared-update-evidence.json'
    foreach ($image in $images) {
      Assert-ServiceConfiguration
      $written.Add($image)
      $image.lease.Replace($image.bytes, $image.nextHash)
    }
    Assert-ServiceConfiguration
  }
  foreach ($state in $states) { $stateType::AssertSecurity($state.ReadSecuritySddl(), $script:ProtectedStateSddl) }
  $report.verdict = 'passed'; $result = 0
} catch {
  $report.verdict = 'failed'; $report.refusals += $_.Exception.Message
  for ($i=$written.Count-1; $i -ge 0; $i--) {
    try { $written[$i].lease.RestoreOriginal() }
    catch { $report.rollbackFailures += ($written[$i].name + ': ' + $_.Exception.Message) }
  }
} finally {
  for ($i=$leases.Count-1; $i -ge 0; $i--) { $leases[$i].Dispose() }
  Save-Receipt 'client-token-query-update-evidence.json'
}
[pscustomobject]$report | Select-Object mode, verdict, refusals, rollbackFailures | ConvertTo-Json -Depth 4
Write-Host ('Evidence folder: ' + $output)
exit $result
