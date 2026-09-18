#Requires -Version 5.1
<#
.SYNOPSIS
  Admit the installed worker as an operator and transfer its retained credential.
.DESCRIPTION
  Requires the exact installed package, a stopped worker service and the already
  running availability broker. Preflight does not enroll or change services.
  Enrollment runs the pinned native host with private administrator-only state,
  once, stopping after admission. Only an exact successful admission report can
  publish the credential into worker state, atomically and without replacement.
  Private state is retained for retries and operator recovery. No service is
  installed, started, stopped or reconfigured, and no assignment is requested.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidateSet('windows-x64','windows-arm64')][string]$Target,
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$ManifestSha256,
  [Parameter(Mandatory=$true)][string]$OutputRoot,
  [switch]$Preflight
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'worker-enrollment-common.ps1')
Initialize-WorkerInstallNative
$paths = Get-WorkerServicePaths
$native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
$files = [GoatCitadel.RemoteWorker.Install.NativeFiles]
$leases = [Collections.Generic.List[IDisposable]]::new()
$owned = [Collections.Generic.List[string]]::new()
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\')
if ($OutputRoot.Equals($paths.Root,[StringComparison]::OrdinalIgnoreCase) -or
    $OutputRoot.StartsWith($paths.Root+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'REFUSED: evidence must be outside the installation.' }
New-Item -ItemType Directory -Path $OutputRoot -ErrorAction Stop | Out-Null
$verdict='refused'; $detail=''; $transfer=$null; $proof=$null; $networkAttempted=$false
$runId='enroll-'+[guid]::NewGuid().ToString('N')

function Hold-EnrollmentDirectory {
  param([string]$Path,[string]$Sddl)
  $leases.Add($native::PinDirectory($Path))
  if ((ConvertTo-CanonicalFileSddl ($native::GetFileSddl($Path))) -cne (ConvertTo-CanonicalFileSddl $Sddl)) {
    throw 'REFUSED: installed directory permissions differ.'
  }
}
function Hold-EnrollmentFile {
  param([string]$Path,[string]$Sddl)
  $leases.Add($files::OpenRead($Path,$script:WorkerMaximumFileBytes))
  if ((ConvertTo-CanonicalFileSddl ($native::GetFileSddl($Path))) -cne (ConvertTo-CanonicalFileSddl $Sddl)) {
    throw 'REFUSED: installed file permissions differ.'
  }
  return Get-WorkerFileRecord $Path
}

try {
  if (-not (Test-BrokerCoordinatorElevation)) { throw 'REFUSED: run enrollment from an elevated administrator terminal.' }
  if (('windows-'+[Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()) -cne $Target -or
      [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData) -cne $paths.ProgramData) {
    throw 'REFUSED: installed worker architecture or ProgramData location differs.'
  }
  foreach ($ancestor in @($paths.Drive,$paths.ProgramData,$paths.Shared)) {
    $leases.Add((Get-BrokerCoordinatorDirectoryLease $ancestor -GoatCitadelLevel:($ancestor -eq $paths.Shared)))
  }
  foreach ($directory in @($paths.Root,$paths.Payload,$paths.Configuration)) {
    Hold-EnrollmentDirectory $directory $script:WorkerReadOnlySddl
  }
  Assert-WorkerServiceReadBack $paths
  $null = Hold-EnrollmentFile (Join-Path $paths.Configuration 'install-receipt.json') $script:WorkerReadOnlySddl
  $receipt = ConvertFrom-WorkerJson (Read-WorkerBytes (Join-Path $paths.Configuration 'install-receipt.json'))
  if ($receipt.schemaVersion -cne 'goatcitadel.remote-worker.service-install.v1' -or $receipt.target -cne $Target -or
      $receipt.manifestSha256 -cne $ManifestSha256 -or $receipt.serviceName -cne $script:WorkerServiceName -or
      $receipt.installationId -cnotmatch '^[a-f0-9]{32}$') { throw 'REFUSED: installation receipt does not match the requested package.' }
  $inventory = Get-WorkerPackage $paths.Payload $ManifestSha256 $Target
  foreach ($relative in $inventory.Directories) {
    Hold-EnrollmentDirectory (Assert-WorkerContainedPath $paths.Payload (Join-Path $paths.Payload $relative.Replace('/','\'))) $script:WorkerReadOnlySddl
  }
  $items=@($inventory.Files)+@([pscustomobject]@{path='worker-package.json';sha256=$ManifestSha256;sizeBytes=$inventory.ManifestBytes.Length})
  foreach ($item in $items) {
    $file = Assert-WorkerContainedPath $paths.Payload (Join-Path $paths.Payload $item.path.Replace('/','\'))
    $actual = Hold-EnrollmentFile $file $script:WorkerReadOnlySddl
    if ($actual.sha256 -cne $item.sha256 -or $actual.sizeBytes -ne $item.sizeBytes) { throw 'REFUSED: pinned package changed before enrollment.' }
  }
  $binding = [ordered]@{schemaVersion='goatcitadel.remote-worker.enrollment-binding.v1';installationId=$receipt.installationId;
    manifestSha256=$ManifestSha256;settingsSha256=$receipt.settingsSha256;configuration=[ordered]@{}}
  foreach ($name in @('client-cert.pem','ca.pem','ticket.json','protected-key.json','worker.environment')) {
    $binding.configuration[$name] = Hold-EnrollmentFile (Join-Path $paths.Configuration $name) $script:WorkerReadOnlySddl
  }
  $settings = Read-WorkerBytes (Join-Path $paths.Configuration 'worker.environment')
  if ((Get-WorkerBytesHash $settings) -cne $receipt.settingsSha256) { throw 'REFUSED: installed settings changed.' }
  $installedSettings = Get-WorkerInstalledSettings $paths $settings
  $stateDirectory = $installedSettings['GOATCITADEL_CONNECTED_WORKER_STATE_DIR']
  if ($stateDirectory -ceq $paths.State) {
    Assert-WorkerCapacityEnrollmentReceipt $false $receipt $null
    Hold-EnrollmentDirectory $paths.State $script:WorkerStateSddl
  } else {
    Hold-EnrollmentDirectory $paths.State $script:WorkerReadOnlySddl
    $areas = Get-WorkerCellCapacityPaths $paths.Root
    foreach ($directory in $areas.Values) {
      if ($directory -cne $paths.Cells) { Hold-EnrollmentDirectory $directory $script:WorkerStateSddl }
    }
    $capacityRecord = Hold-EnrollmentFile $paths.CapacityCustody $script:WorkerReadOnlySddl
    Assert-WorkerCapacityEnrollmentReceipt $true $receipt $capacityRecord
    $binding.configuration['cell-capacity.identity'] = $capacityRecord
  }
  $start = Get-WorkerEnrollmentStartInfo $paths $settings $runId
  $broker = $native::GetServiceStatusLine($script:BrokerServiceName).Split('|')
  if ($broker.Count -ne 8 -or $broker[0] -ne '4' -or [uint32]$broker[1] -eq 0 -or
      $broker[3] -ne '16' -or $broker[4] -ne '0' -or $broker[5] -ne '0') {
    throw 'REFUSED: start the verified GoatCitadelRemoteWorkerProvisionerAvailability service before enrollment.'
  }
  # Every elevated Node input stays under this protected, pinned directory.
  # The service-writable state is never used as the enrollment runtime's input.
  if (Test-Path -LiteralPath $paths.Enrollment) {
    Hold-EnrollmentDirectory $paths.Enrollment $script:WorkerEnrollmentSddl
    $children=@(Get-ChildItem -LiteralPath $paths.Enrollment -Force)
    if ($children.Count -gt 32) { throw 'REFUSED: private enrollment state needs operator reconciliation.' }
    foreach ($child in $children) {
      if ($child.PSIsContainer -or ($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
          $child.Name -cnotmatch '^(binding\.json|runtime-credential\.json|report\.json|enrollment\.lock|(runtime-credential\.json|report\.json)\.[a-f0-9-]{16,36}\.tmp)$') {
        throw 'REFUSED: unexpected private enrollment state; preserve it for reconciliation.'
      }
      Assert-WorkerEnrollmentPrivateSddl ($native::GetFileSddl($child.FullName))
      $null = Get-WorkerFileRecord $child.FullName
    }
  }
  if ($Preflight) { $verdict='passed'; $detail='Enrollment preflight passed; no admission or credential transfer performed.' }
  else {
    $verdict='failed'
    if ($stateDirectory -cne $paths.State) {
      # Both installed services hold read leases before admitting any work.
      # OPEN_EXISTING plus share-none closes the stopped-service/startup race.
      $leases.Add($files::AcquireInstalledStateWriterGate($paths.StateWriterGate))
      if ((ConvertTo-CanonicalFileSddl ($native::GetFileSddl($paths.StateWriterGate))) -cne
          (ConvertTo-CanonicalFileSddl $script:WorkerReadOnlySddl)) { throw 'REFUSED: state writer gate security differs.' }
    }
    $native::EnablePrivilege('SeRestorePrivilege')
    if (-not (Test-Path -LiteralPath $paths.Enrollment)) {
      $native::CreateProtectedDirectory($paths.Enrollment,$script:WorkerEnrollmentSddl)
      Hold-EnrollmentDirectory $paths.Enrollment $script:WorkerEnrollmentSddl
    }
    $leases.Add($files::AcquireEnrollmentLock((Join-Path $paths.Enrollment 'enrollment.lock')))
    $bindingBytes=[Text.UTF8Encoding]::new($false).GetBytes(($binding | ConvertTo-Json -Depth 6 -Compress))
    $bindingFile=Join-Path $paths.Enrollment 'binding.json'
    if (Test-Path -LiteralPath $bindingFile) {
      $leases.Add($files::OpenRead($bindingFile,2097152))
      if ((Get-WorkerBytesHash (Read-WorkerBytes $bindingFile)) -cne (Get-WorkerBytesHash $bindingBytes)) {
        throw 'REFUSED: enrollment belongs to different installation inputs; existing state was preserved.'
      }
    } else {
      if (Test-Path -LiteralPath (Join-Path $paths.Enrollment 'runtime-credential.json')) { throw 'REFUSED: private credential has no installation binding.' }
      Write-WorkerProtectedBytes $bindingFile $bindingBytes $script:WorkerEnrollmentSddl $owned $leases
    }
    Assert-WorkerServiceReadBack $paths
    $networkAttempted=$true
    Invoke-WorkerEnrollmentHost $start
    Assert-WorkerServiceReadBack $paths
    $credentialFile=Join-Path $paths.Enrollment 'runtime-credential.json'
    $reportFile=Join-Path $paths.Enrollment 'report.json'
    foreach ($file in @($credentialFile,$reportFile)) {
      $leases.Add($files::OpenRead($file,2097152))
      Assert-WorkerEnrollmentPrivateSddl ($native::GetFileSddl($file))
      $null=Get-WorkerFileRecord $file
    }
    $proof=Get-WorkerEnrollmentProof (Read-WorkerBytes $reportFile) (Read-WorkerBytes $credentialFile) $runId
    $destination=Join-Path $stateDirectory 'runtime-credential.json'
    $transfer=Publish-WorkerEnrollmentCredential $credentialFile $destination $proof $script:WorkerStateSddl
    $leases.Add($files::OpenRead($destination,2097152))
    $actual=Get-WorkerFileRecord $destination
    if ($actual.sha256 -cne $proof.sha256 -or $actual.sizeBytes -ne $proof.sizeBytes -or
        (ConvertTo-CanonicalFileSddl ($native::GetFileSddl($destination))) -cne (ConvertTo-CanonicalFileSddl $script:WorkerStateSddl)) {
      throw 'REFUSED: published credential changed; private authority is retained for reconciliation.'
    }
    Assert-WorkerServiceReadBack $paths
    $verdict='passed'; $detail='Protected admission verified and retained credential handed off; worker service remains stopped.'
  }
} catch { $detail=$_.Exception.Message }
finally {
  for ($index=$leases.Count-1; $index -ge 0; $index--) { $leases[$index].Dispose() }
  $evidence=[ordered]@{schemaVersion='goatcitadel.remote-worker.enrollment-evidence.v1';verdict=$verdict;preflight=[bool]$Preflight;
    runId=$runId;target=$Target;manifestSha256=$ManifestSha256;detail=$detail;credentialTransfer=$transfer;credential=$proof;
    admissionAttempted=$networkAttempted;privateStateRetained=$true;scmMutated=$false;assignmentsRequested=$false}
  [IO.File]::WriteAllText((Join-Path $OutputRoot 'worker-enrollment-evidence.json'),($evidence | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
  $evidence | ConvertTo-Json -Depth 5
}
if ($verdict -eq 'passed') { exit 0 }
if ($verdict -eq 'refused') { exit 2 }
exit 1
