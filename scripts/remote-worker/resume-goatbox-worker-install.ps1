#Requires -Version 5.1
# Finish only the known GOATBOX recovery stopped at virtual-account service creation.
# No key APIs, payload replacement, service startup, disk or volume operations.
[CmdletBinding()]
param([switch]$Apply)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ([Environment]::MachineName -cne 'GOATBOX' -or $env:COMPUTERNAME -cne 'GOATBOX') { throw 'GOATBOX only.' }
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator PowerShell required.' }
# Replaced only by the handoff builder; fail closed when run directly from source.
$manifestHash='__HANDOFF_MANIFEST_SHA256__'
$leases=[Collections.Generic.List[IDisposable]]::new()
$owned=[Collections.Generic.List[string]]::new()
$serviceLease=$null; $controllerLease=$null; $createdWorker=$false; $createdController=$false
$output=$null; $verdict='refused'; $detail=''; $stage='verify handoff'
function Hold-Handoff([string]$Path,[string]$Expected) {
  $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $leases.Add($stream); $hash=[Security.Cryptography.SHA256]::Create()
  try { $actual=[BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
  if ($actual -cne $Expected) { throw ('Handoff hash mismatch: '+$Path) }
}
try {
  Hold-Handoff (Join-Path $PSScriptRoot 'recovery-files.json') $manifestHash
  $handoff=Get-Content -Raw -LiteralPath (Join-Path $PSScriptRoot 'recovery-files.json') | ConvertFrom-Json
  foreach ($file in $handoff.files) {
    $path=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot $file.path))
    if (-not $path.StartsWith($PSScriptRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Handoff path escape.' }
    Hold-Handoff $path $file.sha256
  }
  . (Join-Path $PSScriptRoot 'worker-enrollment-common.ps1')
  Initialize-WorkerInstallNative
  $native=[GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
  $files=[GoatCitadel.RemoteWorker.Install.NativeFiles]
  $paths=Get-WorkerServicePaths
  if ($paths.Root -cne 'C:\ProgramData\GoatCitadel\RemoteWorker' -or
      [Environment]::GetFolderPath([Environment+SpecialFolder]::CommonApplicationData) -cne $paths.ProgramData -or
      [Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() -cne 'X64') { throw 'Unexpected installation host layout.' }
  $output='C:\worker-evidence\worker-resume-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff')
  New-Item -ItemType Directory -Path $output -ErrorAction Stop | Out-Null
  $stage='verify failed installation and existing public key review'
  $failed=ConvertFrom-WorkerJson (Read-WorkerBytes 'C:\worker-evidence\worker-install-20260918-153225-760\worker-install-evidence.json')
  $id='81877965c3b140539617e7699cd4e3e8'
  $packageHash='d80b8d70375b40962947689e2cfc4787ae28aa9dc64a8ebc9e0fed3c5559256b'
  $settingsHash='333f16a1bf8c6263da29af38ebee4711b5917cfece64a609d201ee40d85a3427'
  $custodyHash='fcd2150487ec87d98b60df32491a215ae693167003744b072ea338173d45a786'
  if ($failed.verdict -cne 'failed' -or $failed.preflight -ne $false -or $failed.installationId -cne $id -or
      $failed.manifestSha256 -cne $packageHash -or $failed.settingsSha256 -cne $settingsHash -or
      $failed.controllerCustodySha256 -cne $custodyHash -or $failed.createdService -ne $false -or
      $failed.createdController -ne $false -or $failed.createdCells -ne $true) { throw 'Failed-install evidence differs.' }
  $review=ConvertFrom-WorkerJson (Read-WorkerBytes 'C:\ProgramData\GoatCitadel\ControllerKeyReview-b078588a4d3f44978dc0ca66c4cab883\public-review.json')
  $point='0473401e4f060e970cbc5814df8428c6b34dc557ad2127d33b8b155f9c9a57ce96b925db1947adf2ae3c2c19e6678d1f4016c33364a88483537a661d2de71ca0ca'
  $keyHash='173b2848bc3fd5b2f0f41e983a46c8883fe1f1919369826e96704cb091edf362'
  if ($review.schemaVersion -cne 'goatcitadel.controller-key-system-review.v1' -or $review.verdict -cne 'passed' -or
      $review.publicPointHex -cne $point -or $review.keySha256 -cne $keyHash -or $review.computerName -cne 'GOATBOX' -or
      $review.keyCreated -ne $false -or $review.keyPermissionsChanged -ne $false -or $review.privateKeyExported -ne $false) { throw 'Verified controller public key evidence differs.' }
  # Validate the partial v2 recovery before retaining its controller and records.
  $partial=ConvertFrom-WorkerJson (Read-WorkerBytes 'C:\worker-evidence\worker-resume-20260918-160046-472\recovery-report.json')
  if ($partial.schemaVersion -cne 'goatcitadel.goatbox-worker-recovery.v1' -or $partial.verdict -cne 'failed' -or
      $partial.stage -cne 'create stopped worker service' -or $partial.apply -ne $true -or
      $partial.createdWorker -ne $false -or $partial.createdController -ne $true -or
      $partial.servicesStarted -ne $false -or $partial.keyChanged -ne $false -or $partial.payloadReplaced -ne $false -or
      ($partial.newConfigurationFiles -join '|') -cne 'C:\ProgramData\GoatCitadel\RemoteWorker\configuration\controller-signing-enrollment.json|C:\ProgramData\GoatCitadel\RemoteWorker\configuration\install-receipt.json') { throw 'Partial recovery evidence differs.' }
  # Service state is checked again under the installation writer gate.
  if ($native::ServiceExists($script:WorkerServiceName)) { throw 'Worker already exists; preserve it.' }
  Assert-WorkerCellControllerServiceReadBack $paths
  if ((Get-VirtualServiceAccountSid $script:WorkerServiceName) -cne $script:WorkerSid -or
      (Get-VirtualServiceAccountSid $script:CellControllerServiceName) -cne $script:CellControllerSid) { throw 'Service SID derivation differs.' }
  foreach ($ancestor in @($paths.Drive,$paths.ProgramData)) { $leases.Add((Get-BrokerCoordinatorDirectoryLease $ancestor)) }
  $leases.Add((Get-BrokerCoordinatorDirectoryLease $paths.Shared -GoatCitadelLevel))
  $sharedBefore=$native::GetFileSddl($paths.Shared)
  $sharedAfter=Get-WorkerSharedRootGrant $sharedBefore
  $native::EnablePrivilege('SeBackupPrivilege')
  function Hold-RecoveryDirectory([string]$Path,[string]$Sddl) {
    $leases.Add($native::PinDirectory($Path))
    if ((ConvertTo-CanonicalFileSddl ($native::GetFileSddl($Path))) -cne (ConvertTo-CanonicalFileSddl $Sddl)) { throw ('Directory security differs: '+$Path) }
  }
  foreach ($directory in @($paths.Root,$paths.Payload,$paths.Configuration,$paths.State)) { Hold-RecoveryDirectory $directory $script:WorkerReadOnlySddl }
  $stage='verify retained payload and protected configuration'
  $inventory=Get-WorkerPackage $paths.Payload $packageHash 'windows-x64'
  foreach ($directory in $inventory.Directories) { Hold-RecoveryDirectory (Join-Path $paths.Payload $directory) $script:WorkerReadOnlySddl }
  foreach ($item in $inventory.Files) {
    $path=Assert-WorkerContainedPath $paths.Payload (Join-Path $paths.Payload $item.path)
    $leases.Add($files::OpenRead($path,$script:WorkerMaximumFileBytes))
    $actual=Get-WorkerFileRecord $path
    if ($actual.sha256 -cne $item.sha256 -or $actual.sizeBytes -ne $item.sizeBytes -or
      (ConvertTo-CanonicalFileSddl ($native::GetFileSddl($path))) -cne (ConvertTo-CanonicalFileSddl $script:WorkerReadOnlySddl)) { throw 'Retained payload changed.' }
  }
  $leases.Add($files::OpenRead((Join-Path $paths.Payload 'worker-package.json'),2097152))
  $expectedNames=@('client-cert.pem','ca.pem','protected-key.json','worker.environment','state-writers.guard','host-run.guard',
    'cell-controller.identity','cell-runtime.identity','cell-capacity.identity','controller-signing-enrollment.json','install-receipt.json')
  $children=@(Get-ChildItem -LiteralPath $paths.Configuration -Force)
  if ($children.Count -ne $expectedNames.Count) { throw 'Configuration inventory differs; no overwrite allowed.' }
  foreach ($child in $children) {
    if ($child.PSIsContainer -or $child.Name -cnotin $expectedNames) { throw 'Unexpected configuration entry.' }
    $expectedSddl=$script:WorkerReadOnlySddl
    if ($child.Name -ceq 'host-run.guard') { $expectedSddl=$script:WorkerStateSddl }
    if ((ConvertTo-CanonicalFileSddl ($native::GetFileSddl($child.FullName))) -cne (ConvertTo-CanonicalFileSddl $expectedSddl)) { throw 'Configuration security differs.' }
    if ($child.Name -cne 'state-writers.guard') { $leases.Add($files::OpenRead($child.FullName,2097152)) }
  }
  foreach ($inputFile in $handoff.inputs) {
    if ((Get-WorkerFileRecord (Join-Path $paths.Configuration $inputFile.path)).sha256 -cne $inputFile.sha256) { throw 'Retained public input differs.' }
  }
  $settings=Read-WorkerBytes (Join-Path $paths.Configuration 'worker.environment')
  if ((Get-WorkerBytesHash $settings) -cne $settingsHash) { throw 'Installed environment differs.' }
  $null=Get-WorkerInstalledSettings $paths $settings
  $areas=Get-WorkerCellCapacityPaths $paths.Root
  foreach ($directory in $areas.Values) {
    if ($directory -ceq $paths.Cells) { continue }
    Hold-RecoveryDirectory $directory $script:WorkerStateSddl
    if (@(Get-ChildItem -LiteralPath $directory -Force).Count -ne 0) { throw 'Worker state already contains data; preserve it.' }
  }
  Assert-WorkerCellControllerCustody $paths $inventory
  Assert-WorkerCellRuntimeCustody $paths $inventory
  Assert-WorkerCellCapacityCustody $paths
  if ((Get-WorkerFileRecord $paths.ControllerCustody).sha256 -cne $custodyHash) { throw 'Controller custody differs from failed installation.' }
    $enrollment=[ordered]@{schemaVersion='goatcitadel.controller-signing-enrollment.v1';keyName='GoatCitadel.CellController.Attestation.v1';
      publicPointHex=$point;keySha256=$keyHash;controllerCustodySha256=$custodyHash;installationId=$id}
    $receipt=[ordered]@{schemaVersion='goatcitadel.remote-worker.service-install.v1';installationId=$id;target='windows-x64';
      manifestSha256=$packageHash;settingsSha256=$settingsHash;serviceName=$script:WorkerServiceName;
      controllerServiceName=$script:CellControllerServiceName;controllerCustodySha256=$custodyHash;
      runtimeCustodySha256=(Get-WorkerFileRecord $paths.RuntimeCustody).sha256;
      capacityCustodySha256=(Get-WorkerFileRecord $paths.CapacityCustody).sha256;controllerKeySha256=$keyHash}
    foreach ($entry in @(@('controller-signing-enrollment.json',$enrollment),@('install-receipt.json',$receipt))) {
      $bytes=[Text.UTF8Encoding]::new($false).GetBytes(($entry[1] | ConvertTo-Json -Depth 5))
      if ((Get-WorkerFileRecord (Join-Path $paths.Configuration $entry[0])).sha256 -cne (Get-WorkerBytesHash $bytes)) {
        throw ('Retained recovery record differs: '+$entry[0])
      }
    }
  if ((ConvertTo-CanonicalFileSddl $sharedBefore) -cne (ConvertTo-CanonicalFileSddl $sharedAfter)) { throw 'Existing shared parent worker grant differs.' }
  $stage='preflight complete'
  if (-not $Apply) { $verdict='passed'; $detail='Recovery preflight passed; no installation changes.' }
  else {
    $verdict='failed'
    $leases.Add($files::AcquireInstalledStateWriterGate($paths.StateWriterGate))
    if ($native::ServiceExists($script:WorkerServiceName)) { throw 'Worker appeared; preserve it.' }
    Assert-WorkerCellControllerServiceReadBack $paths
    $stage='create stopped worker service'
    $serviceLease=$files::CreateStoppedWorkerService($paths.Image); $createdWorker=$true
    $native::SetServiceSidTypeUnrestricted($script:WorkerServiceName)
    $native::SetServiceRequiredPrivilegesChangeNotify($script:WorkerServiceName)
    $native::SetServiceSddl($script:WorkerServiceName,$script:WorkerServiceSddl)
    Assert-WorkerServiceReadBack $paths
    Assert-WorkerCellControllerServiceReadBack $paths
    $verdict='passed'; $stage='completed'; $detail='Retained installation recovered; both services are stopped and enrollment remains deferred.'
  }
} catch { $detail=$_.Exception.Message }
finally {
  if ($serviceLease) { $serviceLease.Dispose() }; if ($controllerLease) { $controllerLease.Dispose() }
  foreach ($lease in $leases) { $lease.Dispose() }
  $report=[ordered]@{schemaVersion='goatcitadel.goatbox-worker-recovery.v1';verdict=$verdict;stage=$stage;detail=$detail;
    apply=[bool]$Apply;createdWorker=$createdWorker;createdController=$createdController;servicesStarted=$false;
    keyChanged=$false;payloadReplaced=$false;newConfigurationFiles=@($owned.ToArray())}
  if ($output) { [IO.File]::WriteAllText((Join-Path $output 'recovery-report.json'),($report | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false)) }
  $report | ConvertTo-Json -Depth 5
  if ($output) { 'Evidence folder: '+$output }
}
if ($verdict -ne 'passed') { throw 'Recovery did not complete. Preserve all evidence and do not repeat.' }
