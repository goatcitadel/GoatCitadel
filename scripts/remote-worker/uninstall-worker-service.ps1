#Requires -Version 5.1
<#
.SYNOPSIS
  Remove exact, stopped worker/controller services and their verified payload; retain cells, configuration and state.
.DESCRIPTION
  Preflight is read-only apart from its fresh evidence directory. Uninstall refuses
  changed payload bytes, permissions, service identity or a running worker. It
  acquires removal handles before changing SCM, so an active supported host prevents
  partial removal. Configuration, credentials and state are retained for operator
  recovery; this script never stops a process or recursively deletes a directory.
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
. (Join-Path $PSScriptRoot 'worker-install-common.ps1')
Initialize-WorkerInstallNative
$paths = Get-WorkerServicePaths
$OutputRoot = [IO.Path]::GetFullPath($OutputRoot).TrimEnd('\')
if ($OutputRoot.Equals($paths.Root, [StringComparison]::OrdinalIgnoreCase) -or
    $OutputRoot.StartsWith($paths.Root + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'REFUSED: evidence output must be outside the installation.' }
New-Item -ItemType Directory -Path $OutputRoot -ErrorAction Stop | Out-Null
$native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
$leases = [Collections.Generic.List[IDisposable]]::new()
$removal = [Collections.Generic.List[IO.FileStream]]::new()
$verdict = 'refused'; $detail = ''; $removedService = $false; $removedController = $false; $removedFiles = 0
try {
  if (-not (Test-BrokerCoordinatorElevation)) { throw 'REFUSED: an elevated administrator context is required.' }
  foreach ($ancestor in @($paths.Drive, $paths.ProgramData, $paths.Shared)) {
    $leases.Add((Get-BrokerCoordinatorDirectoryLease -Path $ancestor -GoatCitadelLevel:($ancestor -eq $paths.Shared)))
  }
  foreach ($directory in @($paths.Root, $paths.Payload, $paths.Configuration)) {
    $leases.Add($native::PinDirectory($directory))
    if ((ConvertTo-CanonicalFileSddl ($native::GetFileSddl($directory))) -cne (ConvertTo-CanonicalFileSddl $script:WorkerReadOnlySddl)) {
      throw 'REFUSED: installed directory permissions differ.'
    }
  }
  $receipt = ConvertFrom-WorkerJson (Read-WorkerBytes (Join-Path $paths.Configuration 'install-receipt.json'))
  if ($receipt.schemaVersion -cne 'goatcitadel.remote-worker.service-install.v1' -or $receipt.target -cne $Target -or
      $receipt.manifestSha256 -cne $ManifestSha256 -or $receipt.serviceName -cne $script:WorkerServiceName -or
      $receipt.controllerServiceName -cne $script:CellControllerServiceName -or
      $receipt.controllerCustodySha256 -cnotmatch '^[a-f0-9]{64}$' -or
      (Get-WorkerBytesHash (Read-WorkerBytes $paths.ControllerCustody)) -cne $receipt.controllerCustodySha256) {
    throw 'REFUSED: installation receipt does not match the requested package.'
  }
  $inventory = Get-WorkerPackage -Root $paths.Payload -ManifestSha256 $ManifestSha256 -Target $Target
  $servicePresent = $native::ServiceExists($script:WorkerServiceName)
  if ($servicePresent) { Assert-WorkerServiceReadBack $paths }
  $controllerPresent = $native::ServiceExists($script:CellControllerServiceName)
  if ($controllerPresent) { Assert-WorkerCellControllerServiceReadBack $paths }
  foreach ($relative in $inventory.Directories) {
    $directory = Assert-WorkerContainedPath $paths.Payload (Join-Path $paths.Payload $relative.Replace('/', '\'))
    $leases.Add($native::PinDirectory($directory))
    if ((ConvertTo-CanonicalFileSddl ($native::GetFileSddl($directory))) -cne (ConvertTo-CanonicalFileSddl $script:WorkerReadOnlySddl)) {
      throw 'REFUSED: payload directory permissions changed.'
    }
  }
  $files = @($inventory.Files) + @([pscustomobject]@{path='worker-package.json';sha256=$ManifestSha256;sizeBytes=$inventory.ManifestBytes.Length})
  foreach ($item in $files) {
    $file = Assert-WorkerContainedPath $paths.Payload (Join-Path $paths.Payload $item.path.Replace('/', '\'))
    if ((ConvertTo-CanonicalFileSddl ($native::GetFileSddl($file))) -cne (ConvertTo-CanonicalFileSddl $script:WorkerReadOnlySddl)) {
      throw 'REFUSED: payload file permissions changed.'
    }
    $stream = [GoatCitadel.RemoteWorker.Install.NativeFiles]::OpenForRemoval($file, $script:WorkerMaximumFileBytes)
    $removal.Add($stream)
    $hash = [Security.Cryptography.SHA256]::Create()
    try { $actualHash = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $hash.Dispose() }
    if ($stream.Length -ne $item.sizeBytes -or $actualHash -cne $item.sha256) { throw 'REFUSED: payload changed before removal.' }
  }
  if ($Preflight) { $verdict='passed'; $detail='Uninstall preflight passed; service and files retained.' }
  else {
    $verdict='failed'
    if ($servicePresent) { Assert-WorkerServiceReadBack $paths }
    if ($controllerPresent) { Assert-WorkerCellControllerServiceReadBack $paths }
    if ($controllerPresent) { $native::RemoveService($script:CellControllerServiceName); $removedController=$true }
    if ($servicePresent) { $native::RemoveService($script:WorkerServiceName); $removedService=$true }
    foreach ($stream in $removal) {
      [GoatCitadel.RemoteWorker.Install.NativeFiles]::DeleteOpenedFile($stream)
      $stream.Dispose(); $removedFiles++
    }
    $removal.Clear()
    for ($index=$leases.Count-1; $index -ge 0; $index--) { $leases[$index].Dispose() }
    $leases.Clear()
    foreach ($relative in @($inventory.Directories | Sort-Object { $_.Split('/').Count }, { $_ } -Descending)) {
      $directory = Assert-WorkerContainedPath $paths.Payload (Join-Path $paths.Payload $relative.Replace('/', '\'))
      [IO.Directory]::Delete($directory, $false)
    }
    [IO.Directory]::Delete($paths.Payload, $false)
    $verdict='passed'; $detail='Worker/controller services and verified payload removed; cells, configuration and state retained.'
  }
} catch { $detail=$_.Exception.Message }
finally {
  foreach ($stream in $removal) { $stream.Dispose() }
  for ($index=$leases.Count-1; $index -ge 0; $index--) { $leases[$index].Dispose() }
  $evidence = [ordered]@{schemaVersion='goatcitadel.remote-worker.service-uninstall-evidence.v1';verdict=$verdict;
    preflight=[bool]$Preflight;target=$Target;manifestSha256=$ManifestSha256;detail=$detail;
    removedService=$removedService;removedController=$removedController;removedFiles=$removedFiles;
    configurationRetained=$true;stateRetained=$true;cellsRetained=$true;processesStopped=$false}
  [IO.File]::WriteAllText((Join-Path $OutputRoot 'worker-uninstall-evidence.json'), ($evidence | ConvertTo-Json -Depth 4), [Text.UTF8Encoding]::new($false))
  $evidence | ConvertTo-Json -Depth 4
}
if ($verdict -eq 'passed') { exit 0 }
if ($verdict -eq 'refused') { exit 2 }
exit 1
