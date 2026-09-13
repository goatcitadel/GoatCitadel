#Requires -Version 5.1
<#
.SYNOPSIS
  Install the pinned Windows worker and cell controller as dedicated, stopped services.
.DESCRIPTION
  Preflight reads the candidate, input files, ACLs and SCM without installing.
  Install creates a fresh protected payload/configuration tree and a separate
  worker-writable state directory, then creates and verifies the demand-start
  virtual-account service and its separate SYSTEM cell controller. The protected
  cells parent and custody record bind both images and directory identities.
  It never starts a service or contacts a provider.
  Existing services or worker footprints are refused. Failure cleanup removes
  only objects created by this invocation; uncertain SCM ownership preserves them.
  Exit codes: 0 passed, 1 failed (possibly with retained partial install), 2 refused.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('windows-x64','windows-arm64')][string]$Target,
  [Parameter(Mandatory=$true)][string]$PackageRoot,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256,
  [Parameter(Mandatory=$true)][string]$GatewayHost,
  [Parameter(Mandatory=$true)][ValidateRange(1,65535)][int]$GatewayPort,
  [Parameter(Mandatory=$true)][string]$ClientCertificateFile,
  [Parameter(Mandatory=$true)][string]$TrustAnchorFile,
  [Parameter(Mandatory=$true)][string]$TicketFile,
  [Parameter(Mandatory=$true)][string]$ProtectedKeyFile,
  [Parameter(Mandatory=$true)][string]$OutputRoot,
  [switch]$Preflight
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'worker-install-common.ps1')
Initialize-WorkerInstallNative
$paths = Get-WorkerServicePaths
$PackageRoot = [IO.Path]::GetFullPath($PackageRoot).TrimEnd('\')
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\')
foreach ($forbidden in @($PackageRoot, $paths.Root)) {
  if ($OutputRoot.Equals($forbidden, [StringComparison]::OrdinalIgnoreCase) -or
      $OutputRoot.StartsWith($forbidden + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'REFUSED: evidence output must be outside the package and installation.'
  }
}
New-Item -ItemType Directory -Path $OutputRoot -ErrorAction Stop | Out-Null
$native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
$ownedFiles = [Collections.Generic.List[string]]::new()
$ownedDirectories = [Collections.Generic.List[string]]::new()
$leases = [Collections.Generic.List[IDisposable]]::new()
$ancestorLeases = [Collections.Generic.List[IDisposable]]::new()
$refusals = [Collections.Generic.List[string]]::new()
$cleanupFailures = [Collections.Generic.List[string]]::new()
$createdService = $false
$serviceLease = $null
$createdController = $false; $controllerLease = $null; $createdCells = $false
$custodyHash = $null
$verdict = 'failed'; $detail = ''; $inventory = $null; $settingsHash = $null
$installationId = [guid]::NewGuid().ToString('N')
$sharedBefore = $null; $sharedApplied = $null

function Add-WorkerDirectory {
  param([string]$Path, [string]$Sddl)
  $native::CreateProtectedDirectory($Path, $Sddl)
  $ownedDirectories.Add($Path)
  $leases.Add($native::PinDirectory($Path))
}
function Close-WorkerInstallLeases {
  for ($index = $leases.Count - 1; $index -ge 0; $index--) { $leases[$index].Dispose() }
  $leases.Clear()
}
try {
  if (-not (Test-BrokerCoordinatorElevation)) { $refusals.Add('An elevated administrator context is required for installation.') }
  $actualArchitecture = [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
  if (('windows-' + $actualArchitecture) -cne $Target) { $refusals.Add('The candidate architecture differs from this Windows host.') }
  if ([Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData) -cne $paths.ProgramData) {
    $refusals.Add('Relocated ProgramData is not supported by the installed worker contract.')
  }
  if ((Get-VirtualServiceAccountSid $script:WorkerServiceName) -cne $script:WorkerSid) { $refusals.Add('Worker service SID derivation differs.') }
  if ((Get-VirtualServiceAccountSid $script:CellControllerServiceName) -cne $script:CellControllerSid) { $refusals.Add('Cell controller service SID derivation differs.') }
  if ($native::ServiceExists($script:WorkerServiceName)) { $refusals.Add('A worker service already exists.') }
  if ($native::ServiceExists($script:CellControllerServiceName)) { $refusals.Add('A cell controller service already exists.') }
  if (Test-Path -LiteralPath $paths.Root) { $refusals.Add('A worker installation footprint already exists.') }
  foreach ($ancestor in @($paths.Drive, $paths.ProgramData)) {
    $ancestorLeases.Add((Get-BrokerCoordinatorDirectoryLease -Path $ancestor))
  }
  $sharedPresent = Test-Path -LiteralPath $paths.Shared
  if ($sharedPresent) {
    $ancestorLeases.Add((Get-BrokerCoordinatorDirectoryLease -Path $paths.Shared -GoatCitadelLevel))
    $null = Get-WorkerSharedRootGrant ($native::GetFileSddl($paths.Shared))
  }
  $inventory = Get-WorkerPackage -Root $PackageRoot -ManifestSha256 $ManifestSha256 -Target $Target
  $inputs = [ordered]@{
    'client-cert.pem' = Read-WorkerBytes ([IO.Path]::GetFullPath($ClientCertificateFile))
    'ca.pem' = Read-WorkerBytes ([IO.Path]::GetFullPath($TrustAnchorFile))
    'ticket.json' = Read-WorkerBytes ([IO.Path]::GetFullPath($TicketFile))
    'protected-key.json' = Read-WorkerBytes ([IO.Path]::GetFullPath($ProtectedKeyFile))
  }
  foreach ($name in $inputs.Keys) {
    if ([Text.Encoding]::UTF8.GetString($inputs[$name]) -match '(?i)-----BEGIN [A-Z ]*PRIVATE KEY-----') {
      throw 'REFUSED: private PEM material is not an installed worker input.'
    }
  }
  foreach ($name in @('client-cert.pem', 'ca.pem')) {
    if ([Text.Encoding]::UTF8.GetString($inputs[$name]) -notmatch '-----BEGIN CERTIFICATE-----') {
      throw 'REFUSED: a public certificate input is missing.'
    }
  }
  $ticket = ConvertFrom-WorkerJson $inputs['ticket.json']
  if ($ticket.PSObject.Properties.Name -contains 'protectedSignerPrivateKeyPem' -or
      $ticket.PSObject.Properties.Name -notcontains 'protectedSignerPublicKeySpkiBase64Url') {
    throw 'REFUSED: ticket must reference the public protected signing key.'
  }
  $null = ConvertFrom-WorkerJson $inputs['protected-key.json']
  $settings = Get-WorkerSettingsBytes $paths $GatewayHost $GatewayPort ('service-' + $installationId)
  $settingsHash = Get-WorkerBytesHash $settings
  if ($refusals.Count -gt 0) { $verdict = 'refused' }
  elseif ($Preflight) { $verdict = 'passed'; $detail = 'Preflight passed; no installation was performed.' }
  else {
    $native::EnablePrivilege('SeRestorePrivilege')
    $native::EnablePrivilege('SeTakeOwnershipPrivilege')
    # Installer-only read access to the SYSTEM/controller parent through backup-intent handles.
    # Neither the worker nor signer receives this privilege.
    $native::EnablePrivilege('SeBackupPrivilege')
    if (-not $sharedPresent) { Add-WorkerDirectory $paths.Shared $script:WorkerReadOnlySddl }
    else {
      $sharedBefore = $native::GetFileSddl($paths.Shared)
      $sharedApplied = Get-WorkerSharedRootGrant $sharedBefore
      $native::SetFileSddl($paths.Shared, $sharedApplied)
      if ((ConvertTo-CanonicalFileSddl ($native::GetFileSddl($paths.Shared))) -cne (ConvertTo-CanonicalFileSddl $sharedApplied)) {
        throw 'REFUSED: shared-root read grant did not persist exactly.'
      }
    }
    foreach ($directory in @($paths.Root, $paths.Payload, $paths.Configuration)) { Add-WorkerDirectory $directory $script:WorkerReadOnlySddl }
    Add-WorkerDirectory $paths.State $script:WorkerStateSddl
    foreach ($relative in @($inventory.Directories | Sort-Object { $_.Split('/').Count }, { $_ })) {
      $directory = Assert-WorkerContainedPath $paths.Payload (Join-Path $paths.Payload $relative.Replace('/', '\'))
      Add-WorkerDirectory $directory $script:WorkerReadOnlySddl
    }
    foreach ($item in $inventory.Files) {
      $source = Assert-WorkerContainedPath $PackageRoot (Join-Path $PackageRoot $item.path.Replace('/', '\'))
      $destination = Assert-WorkerContainedPath $paths.Payload (Join-Path $paths.Payload $item.path.Replace('/', '\'))
      Copy-WorkerPinnedFile $source $destination $item $script:WorkerReadOnlySddl $ownedFiles $leases
    }
    Write-WorkerProtectedBytes (Join-Path $paths.Payload 'worker-package.json') $inventory.ManifestBytes $script:WorkerReadOnlySddl $ownedFiles $leases
    foreach ($name in $inputs.Keys) {
      Write-WorkerProtectedBytes (Join-Path $paths.Configuration $name) $inputs[$name] $script:WorkerReadOnlySddl $ownedFiles $leases
    }
    Write-WorkerProtectedBytes (Join-Path $paths.Configuration 'worker.environment') $settings $script:WorkerReadOnlySddl $ownedFiles $leases
    $native::CreateProtectedDirectory($paths.Cells, $script:CellControllerParentSddl)
    $createdCells = $true
    $leases.Add($native::PinDirectory($paths.Cells))
    $custodyBytes = Get-WorkerCellControllerCustodyBytes $paths $inventory
    $custodyHash = Get-WorkerBytesHash $custodyBytes
    Write-WorkerProtectedBytes $paths.ControllerCustody $custodyBytes $script:WorkerReadOnlySddl $ownedFiles $leases
    $receipt = [ordered]@{ schemaVersion='goatcitadel.remote-worker.service-install.v1'; installationId=$installationId;
      target=$Target; manifestSha256=$ManifestSha256; settingsSha256=$settingsHash; serviceName=$script:WorkerServiceName;
      controllerServiceName=$script:CellControllerServiceName; controllerCustodySha256=$custodyHash }
    $receiptBytes = [Text.UTF8Encoding]::new($false).GetBytes(($receipt | ConvertTo-Json -Depth 4))
    Write-WorkerProtectedBytes (Join-Path $paths.Configuration 'install-receipt.json') $receiptBytes $script:WorkerReadOnlySddl $ownedFiles $leases
    $null = Get-WorkerPackage -Root $paths.Payload -ManifestSha256 $ManifestSha256 -Target $Target
    foreach ($file in $ownedFiles) {
      if ((ConvertTo-CanonicalFileSddl ($native::GetFileSddl($file))) -cne (ConvertTo-CanonicalFileSddl $script:WorkerReadOnlySddl)) {
        throw 'REFUSED: installed file security differs.'
      }
    }
    foreach ($directory in $ownedDirectories) {
      $expectedSddl = $script:WorkerReadOnlySddl
      if ($directory -eq $paths.State) { $expectedSddl = $script:WorkerStateSddl }
      if ((ConvertTo-CanonicalFileSddl ($native::GetFileSddl($directory))) -cne (ConvertTo-CanonicalFileSddl $expectedSddl)) {
        throw 'REFUSED: installed directory security differs.'
      }
    }
    Assert-WorkerCellControllerCustody $paths $inventory
    $controllerLease = [GoatCitadel.RemoteWorker.Install.NativeFiles]::CreateStoppedCellControllerService($paths.ControllerImage)
    $createdController = $true
    [GoatCitadel.RemoteWorker.Install.NativeFiles]::ConfigureCellControllerPrivileges($controllerLease)
    $native::SetServiceSidTypeUnrestricted($script:CellControllerServiceName)
    $native::SetServiceSddl($script:CellControllerServiceName, $script:WorkerServiceSddl)
    Assert-WorkerCellControllerServiceReadBack $paths
    $serviceLease = [GoatCitadel.RemoteWorker.Install.NativeFiles]::CreateStoppedWorkerService($paths.Image)
    $createdService = $true
    $native::SetServiceSidTypeUnrestricted($script:WorkerServiceName)
    $native::SetServiceRequiredPrivilegesChangeNotify($script:WorkerServiceName)
    $native::SetServiceSddl($script:WorkerServiceName, $script:WorkerServiceSddl)
    Assert-WorkerServiceReadBack $paths
    Assert-WorkerCellControllerServiceReadBack $paths
    Assert-WorkerCellControllerCustody $paths $inventory
    $verdict = 'passed'; $detail = 'Verified package and custody installed; worker and cell controller services are stopped.'
  }
} catch {
  $detail = $_.Exception.Message
  if ($ownedFiles.Count -eq 0 -and $ownedDirectories.Count -eq 0 -and -not $createdService) { $verdict = 'refused' }
  else { $verdict = 'failed' }
  if ($sharedApplied) { $verdict = 'failed' }
} finally {
  Close-WorkerInstallLeases
  if ($verdict -ne 'passed' -and ($ownedDirectories.Count -gt 0 -or $createdService)) {
    # Never discard a protected parent or its recovery/custody evidence after creation.
    # A controller may have been started by an operator after SCM creation.
    $mayRemoveFiles = -not $createdCells
    if ($createdCells) { $cleanupFailures.Add('Protected cell parent and staged installation retained for operator recovery.') }
    if (-not $createdController) {
      try {
        if ($native::ServiceExists($script:CellControllerServiceName)) {
          throw 'A cell controller service appeared during installation; preserving staged files for ownership review.'
        }
      } catch { $mayRemoveFiles = $false; $cleanupFailures.Add($_.Exception.Message) }
    }
    if ($createdController) {
      try {
        $config = $native::GetServiceConfigLine($script:CellControllerServiceName).Split('|')
        $status = $native::GetServiceStatusLine($script:CellControllerServiceName).Split('|')
        if ($config[3] -cne ('"' + $paths.ControllerImage + '"') -or $config[4] -cne 'LocalSystem' -or
            $status[0] -ne '1' -or $status[1] -ne '0') { throw 'Cell controller ownership or stopped state changed.' }
        $native::RemoveService($script:CellControllerServiceName)
      } catch { $mayRemoveFiles = $false; $cleanupFailures.Add($_.Exception.Message) }
    }
    if (-not $createdService) {
      try {
        if ($native::ServiceExists($script:WorkerServiceName)) {
          throw 'A worker service appeared during installation; preserving the staged files for ownership review.'
        }
      } catch { $mayRemoveFiles = $false; $cleanupFailures.Add($_.Exception.Message) }
    }
    if ($createdService) {
      try {
        # On a partially configured service, require our exact image/account and a stopped process.
        $config = $native::GetServiceConfigLine($script:WorkerServiceName).Split('|')
        $status = $native::GetServiceStatusLine($script:WorkerServiceName).Split('|')
        if ($config[3] -cne ('"' + $paths.Image + '"') -or $config[4] -cne $script:WorkerAccount -or
            $status[0] -ne '1' -or $status[1] -ne '0') { throw 'Worker service ownership or stopped state changed.' }
        $native::RemoveService($script:WorkerServiceName)
      } catch { $mayRemoveFiles = $false; $cleanupFailures.Add($_.Exception.Message) }
    }
    if ($mayRemoveFiles) {
      for ($index = $ownedFiles.Count - 1; $index -ge 0; $index--) {
        try { $file = Assert-WorkerContainedPath $paths.Root $ownedFiles[$index]; Remove-Item -LiteralPath $file -Force -ErrorAction Stop }
        catch { $cleanupFailures.Add($_.Exception.Message) }
      }
      for ($index = $ownedDirectories.Count - 1; $index -ge 0; $index--) {
        try {
          $directory = $ownedDirectories[$index]
          if ($directory -cne $paths.Root -and $directory -cne $paths.Shared) { $directory = Assert-WorkerContainedPath $paths.Root $directory }
          [IO.Directory]::Delete($directory, $false)
        } catch { $cleanupFailures.Add($_.Exception.Message) }
      }
    }
  }
  if ($verdict -ne 'passed' -and $sharedBefore -and $sharedApplied) {
    try {
      if ((ConvertTo-CanonicalFileSddl ($native::GetFileSddl($paths.Shared))) -cne (ConvertTo-CanonicalFileSddl $sharedApplied)) {
        throw 'Shared-root permissions changed after installation; preserving the current descriptor.'
      }
      $native::SetFileSddl($paths.Shared, $sharedBefore)
    } catch { $cleanupFailures.Add($_.Exception.Message) }
  }
  for ($index = $ancestorLeases.Count - 1; $index -ge 0; $index--) { $ancestorLeases[$index].Dispose() }
  if ($serviceLease) { $serviceLease.Dispose() }
  if ($controllerLease) { $controllerLease.Dispose() }
  $evidence = [ordered]@{
    schemaVersion='goatcitadel.remote-worker.service-install-evidence.v1'; verdict=$verdict; preflight=[bool]$Preflight
    installationId=$installationId; target=$Target; manifestSha256=$ManifestSha256; settingsSha256=$settingsHash
    serviceName=$script:WorkerServiceName; installedRoot=$paths.Root; detail=$detail
    refusals=@($refusals.ToArray()); cleanupFailures=@($cleanupFailures.ToArray())
    createdService=$createdService; serviceStarted=$false; inputContentsInEvidence=$false
    createdController=$createdController; createdCells=$createdCells; controllerStarted=$false; controllerCustodySha256=$custodyHash
  }
  [IO.File]::WriteAllText((Join-Path $OutputRoot 'worker-install-evidence.json'), ($evidence | ConvertTo-Json -Depth 5), [Text.UTF8Encoding]::new($false))
  $evidence | ConvertTo-Json -Depth 5
}
if ($verdict -eq 'passed') { exit 0 }
if ($verdict -eq 'refused') { exit 2 }
exit 1
