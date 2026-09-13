#Requires -Version 5.1
<#
.SYNOPSIS
  Select a reviewed registry for a stopped installed worker, or disable new tools.
.DESCRIPTION
  Verifies the installed package, protected configuration, ticket scope and exact
  registry digest. Retains immutable registries and atomically selects one under
  an exclusive configuration lock. Never stops/starts services, changes destination
  directory ACLs, activates capabilities or deletes old registry/runtime evidence.
#>
[CmdletBinding(DefaultParameterSetName='Enable')]
param(
  [Parameter(Mandatory=$true)][ValidateSet('windows-x64','windows-arm64')][string]$Target,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256,
  [Parameter(Mandatory=$true,ParameterSetName='Enable')][string]$RegistryFile,
  [Parameter(Mandatory=$true,ParameterSetName='Enable')][ValidatePattern('^[a-f0-9]{64}$')][string]$RegistrySha256,
  [Parameter(Mandatory=$true,ParameterSetName='Disable')][switch]$Disable,
  [Parameter(Mandatory=$true)][ValidatePattern('^(none|disabled|[a-f0-9]{64})$')][string]$ExpectedCurrent,
  [Parameter(Mandatory=$true)][string]$OutputRoot,
  [switch]$Preflight
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'worker-mesh-registry-common.ps1')
Initialize-WorkerInstallNative
$paths = Get-WorkerServicePaths
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\')
if ($OutputRoot.Equals($paths.Root,[StringComparison]::OrdinalIgnoreCase) -or
    $OutputRoot.StartsWith($paths.Root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'REFUSED: evidence output must be outside the installation.' }
New-Item -ItemType Directory -Path $OutputRoot -ErrorAction Stop | Out-Null
$leases = [Collections.Generic.List[IDisposable]]::new()
$native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
$verdict='refused'; $detail=''; $result=$null
try {
  if (-not (Test-BrokerCoordinatorElevation)) { throw 'REFUSED: registry configuration requires an elevated administrator terminal.' }
  if (('windows-'+[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()) -cne $Target -or
      [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData) -cne $paths.ProgramData) {
    throw 'REFUSED: installed worker architecture or ProgramData location differs.'
  }
  foreach ($ancestor in @($paths.Drive,$paths.ProgramData,$paths.Shared)) {
    $leases.Add((Get-BrokerCoordinatorDirectoryLease $ancestor -GoatCitadelLevel:($ancestor -eq $paths.Shared)))
  }
  foreach ($directory in @($paths.Root,$paths.Payload,$paths.Configuration)) {
    $leases.Add($native::PinDirectory($directory))
    Assert-WorkerMeshFileSecurity $directory $script:WorkerReadOnlySddl
  }
  Assert-WorkerServiceReadBack $paths
  foreach ($name in @('install-receipt.json','ticket.json')) {
    $file = Join-Path $paths.Configuration $name
    $leases.Add([GoatCitadel.RemoteWorker.Install.NativeFiles]::OpenRead($file, 2097152))
    Assert-WorkerMeshFileSecurity $file $script:WorkerReadOnlySddl
  }
  $receipt = ConvertFrom-WorkerJson (Read-WorkerBytes (Join-Path $paths.Configuration 'install-receipt.json'))
  if ($receipt.schemaVersion -cne 'goatcitadel.remote-worker.service-install.v1' -or $receipt.target -cne $Target -or
      $receipt.manifestSha256 -cne $ManifestSha256 -or $receipt.serviceName -cne $script:WorkerServiceName) {
    throw 'REFUSED: installation receipt differs from the requested package.'
  }
  $null = Get-WorkerPackage $paths.Payload $ManifestSha256 $Target
  $hostReceipt = ConvertFrom-WorkerJson (Read-WorkerBytes (Join-Path $paths.Payload 'app\runtime\worker-host-receipt.json'))
  if ($hostReceipt.serviceIdentity.meshRegistrySelection -cne 'configuration/mesh-registry.sha256') {
    throw 'REFUSED: rebuild the worker package with installed registry support.'
  }
  $selection = 'disabled'; $bytes = [byte[]]@()
  if (-not $Disable) {
    $ticket = ConvertFrom-WorkerJson (Read-WorkerBytes (Join-Path $paths.Configuration 'ticket.json'))
    $bytes = Read-WorkerMeshRegistryInput $RegistryFile $RegistrySha256 $ticket
    $selection = $RegistrySha256
  }
  if ((Get-WorkerMeshSelection $paths.Configuration $script:WorkerReadOnlySddl) -cne $ExpectedCurrent) {
    throw 'REFUSED: the active registry selection differs from ExpectedCurrent.'
  }
  if ($Preflight) { $verdict='passed'; $detail='Registry preflight passed; configuration is unchanged.' }
  else {
    $verdict='failed'
    $native::EnablePrivilege('SeRestorePrivilege')
    $native::EnablePrivilege('SeTakeOwnershipPrivilege')
    $result = Publish-WorkerMeshSelection $paths.Configuration $selection $bytes $ExpectedCurrent $script:WorkerReadOnlySddl { Assert-WorkerServiceReadBack $paths }
    $verdict='passed'; $detail='Registry selection retained; worker service remains stopped.'
  }
} catch { $detail=$_.Exception.Message }
finally {
  for ($index=$leases.Count-1; $index -ge 0; $index--) { $leases[$index].Dispose() }
  $evidence=[ordered]@{schemaVersion='goatcitadel.remote-worker.mesh-registry-configuration.v1'; verdict=$verdict;
    preflight=[bool]$Preflight; manifestSha256=$ManifestSha256; previous=$ExpectedCurrent; result=$result; detail=$detail;
    serviceStarted=$false; destinationPermissionsChanged=$false; inputContentsInEvidence=$false}
  [IO.File]::WriteAllText((Join-Path $OutputRoot 'worker-mesh-registry-evidence.json'),($evidence | ConvertTo-Json -Depth 4),[Text.UTF8Encoding]::new($false))
  $evidence | ConvertTo-Json -Depth 4
}
if ($verdict -eq 'passed') { exit 0 }
if ($verdict -eq 'refused') { exit 2 }
exit 1
