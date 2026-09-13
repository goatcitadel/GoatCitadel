#Requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$FixtureRoot, [Parameter(Mandatory=$true)][string]$PackageFixture)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'worker-install-common.ps1')
. (Join-Path $PSScriptRoot 'worker-mesh-registry-common.ps1')
Initialize-WorkerInstallNative
New-Item -ItemType Directory -Path $FixtureRoot -ErrorAction Stop | Out-Null
$native=[GoatCitadel.RemoteWorker.Install.NativeFiles]
$owner=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sddl="O:${owner}D:P(A;;FA;;;$owner)"
$owned=[Collections.Generic.List[string]]::new()
$leases=[Collections.Generic.List[IDisposable]]::new()
$cases=[Collections.Generic.List[string]]::new()
function Check-Case { param([bool]$Passed,[string]$Name); if (-not $Passed) { throw ('Behavior failed: '+$Name) }; $cases.Add($Name) }
function Check-Refusal { param([string]$Name,[scriptblock]$Body); $refused=$false; try { & $Body | Out-Null } catch { $refused=$true }; Check-Case $refused $Name }
try {
  $source=Join-Path $FixtureRoot 'source.bin'
  [IO.File]::WriteAllText($source,'fixture-source',[Text.UTF8Encoding]::new($false))
  $expected=Get-WorkerFileRecord $source
  $destination=Join-Path $FixtureRoot 'copy.bin'
  Copy-WorkerPinnedFile $source $destination $expected $sddl $owned $leases
  Check-Case ((Get-WorkerFileRecord $destination).sha256 -ceq $expected.sha256) 'exact-pinned-copy'
  Check-Case ((ConvertTo-CanonicalFileSddl ([GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::GetFileSddl($destination))) -ceq (ConvertTo-CanonicalFileSddl $sddl)) 'atomic-file-owner-and-dacl'
  Check-Refusal 'destination-writer-excluded' { [IO.File]::AppendAllText($destination,'drift') }
  Check-Refusal 'destination-rename-excluded' { [IO.File]::Move($destination,(Join-Path $FixtureRoot 'renamed.bin')) }
  Check-Refusal 'active-host-read-prevents-removal' { $stream=$native::OpenForRemoval($destination,1024); $stream.Dispose() }
  foreach ($lease in $leases) { $lease.Dispose() }; $leases.Clear()
  Check-Refusal 'existing-destination-preserved' { Copy-WorkerPinnedFile $source $destination $expected $sddl $owned $leases }
  Check-Case ((Get-WorkerFileRecord $destination).sha256 -ceq $expected.sha256) 'existing-destination-bytes-retained'
  [IO.File]::WriteAllText($source,'changed-input')
  $driftDestination=Join-Path $FixtureRoot 'drift-copy.bin'
  Check-Refusal 'changed-input-refused' { Copy-WorkerPinnedFile $source $driftDestination $expected $sddl $owned $leases }
  Check-Case (-not (Test-Path -LiteralPath $driftDestination)) 'no-destination-created-on-input-drift'
  $writer=[IO.File]::Open($source,[IO.FileMode]::Open,[IO.FileAccess]::Write,[IO.FileShare]::ReadWrite)
  try { Check-Refusal 'existing-input-writer-refused' { $stream=$native::OpenRead($source,1024); $stream.Dispose() } }
  finally { $writer.Dispose() }
  Check-Refusal 'oversized-input-refused' { $stream=$native::OpenRead($source,1); $stream.Dispose() }
  $alias=Join-Path $FixtureRoot 'hardlink.bin'
  New-Item -ItemType HardLink -Path $alias -Target $source | Out-Null
  Check-Refusal 'hard-linked-input-refused' { $stream=$native::OpenRead($source,1024); $stream.Dispose() }
  $target=Join-Path $FixtureRoot 'target'
  New-Item -ItemType Directory -Path $target | Out-Null
  [IO.File]::WriteAllText((Join-Path $target 'file.bin'),'fixture')
  $junction=Join-Path $FixtureRoot 'junction'
  New-Item -ItemType Junction -Path $junction -Target $target | Out-Null
  Check-Refusal 'reparse-ancestor-refused' { $stream=$native::OpenRead((Join-Path $junction 'file.bin'),1024); $stream.Dispose() }
  $ads=Join-Path $FixtureRoot 'alternate.bin'
  [IO.File]::WriteAllText($ads,'fixture')
  Set-Content -LiteralPath $ads -Stream 'extra' -Value 'fixture-stream'
  Check-Refusal 'alternate-stream-refused' { Get-WorkerFileRecord $ads }
  Check-Refusal 'path-escape-refused' { Assert-WorkerContainedPath $FixtureRoot (Join-Path $FixtureRoot '..\outside.bin') }
  Check-Refusal 'device-path-refused' { $stream=$native::OpenRead(('\\?\'+$destination),1024); $stream.Dispose() }
  $removal=$native::OpenForRemoval($destination,1024)
  try {
    Check-Refusal 'removal-handle-prevents-name-substitution' { [IO.File]::Move($destination,(Join-Path $FixtureRoot 'substituted.bin')) }
    $native::DeleteOpenedFile($removal)
  } finally { $removal.Dispose() }
  Check-Case (-not (Test-Path -LiteralPath $destination)) 'delete-uses-verified-handle'
  Check-Case (Test-Path -LiteralPath $source) 'unrelated-source-retained'
  $packageInfo=ConvertFrom-WorkerJson (Read-WorkerBytes (Join-Path $PackageFixture 'fixture-pin.json'))
  $inventory=Get-WorkerPackage $packageInfo.root $packageInfo.sha256 'windows-x64'
  Check-Case ($inventory.Files.Count -gt 15) 'pinned-package-inventory'
  $cellsFixture=Join-Path $FixtureRoot 'cells'
  New-Item -ItemType Directory -Path $cellsFixture | Out-Null
  $custodyPaths=[pscustomobject]@{NativeDirectory=(Join-Path $packageInfo.root 'app\worker\native');Cells=$cellsFixture}
  $custodyBytes=Get-WorkerCellControllerCustodyBytes $custodyPaths $inventory
  Check-Case ($custodyBytes.Length -eq 120 -and [Text.Encoding]::ASCII.GetString($custodyBytes,0,8) -ceq 'GCCUST01') 'controller-custody-native-record'
  $custodyFile=Join-Path $FixtureRoot 'cell-controller.identity'
  [IO.File]::WriteAllBytes($custodyFile,$custodyBytes)
  [IO.File]::WriteAllText((Join-Path $FixtureRoot 'cell-parent.sddl'),$script:CellControllerParentSddl,[Text.UTF8Encoding]::new($false))
  $directoryLease=[GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::PinDirectory($cellsFixture)
  try {
    Check-Case (([Security.AccessControl.RawSecurityDescriptor]::new($native::GetCellDirectorySddl($directoryLease))).Owner.Value -ceq $owner) 'controller-custody-reads-actual-directory-security'
    Check-Refusal 'controller-custody-identical-directories-refused' { $native::CreateCellControllerCustody(('1'*64),('2'*64),$directoryLease,$directoryLease) }
    Check-Refusal 'controller-custody-empty-image-pin-refused' { $native::CreateCellControllerCustody(('0'*64),('2'*64),$directoryLease,$directoryLease) }
    Check-Refusal 'controller-custody-identical-image-pins-refused' { $native::CreateCellControllerCustody(('1'*64),('1'*64),$directoryLease,$directoryLease) }
    Check-Refusal 'controller-custody-directory-replacement-excluded' { [IO.Directory]::Move($cellsFixture,(Join-Path $FixtureRoot 'cells-moved')) }
  } finally { $directoryLease.Dispose() }
  Check-Refusal 'controller-arbitrary-service-path-refused' { $native::CreateStoppedCellControllerService((Join-Path $FixtureRoot 'controller.exe')) }
  Check-Refusal 'controller-privileges-require-owned-service-handle' { $native::ConfigureCellControllerPrivileges($null) }
  $foreignPins=[pscustomobject]@{Files=@($inventory.Files | Where-Object { $_.path -cne 'app/worker/native/GoatCitadelRemoteWorkerCellController.exe' })}
  Check-Refusal 'controller-custody-missing-independent-pin-refused' { Get-WorkerCellControllerCustodyBytes $custodyPaths $foreignPins }
  $duplicatePins=[pscustomobject]@{Files=@($inventory.Files)+@($inventory.Files | Where-Object { $_.path -ceq 'app/worker/native/GoatCitadelRemoteWorkerCellController.exe' })}
  Check-Refusal 'controller-custody-duplicate-independent-pin-refused' { Get-WorkerCellControllerCustodyBytes $custodyPaths $duplicatePins }
  $missingHelpers=ConvertFrom-WorkerJson (Read-WorkerBytes (Join-Path $PackageFixture 'missing-helper-fixtures.json'))
  foreach ($missing in $missingHelpers.cases) {
    $reason=''
    try { Get-WorkerPackage $missing.root $missing.sha256 'windows-x64' | Out-Null }
    catch { $reason=$_.Exception.Message }
    Check-Case ($reason -ceq 'REFUSED: required worker package file is missing.') ('required-native-helper-'+$missing.helper)
  }
  [IO.File]::WriteAllText((Join-Path $packageInfo.root 'extra.txt'),'untracked')
  Check-Refusal 'untracked-package-file-refused' { Get-WorkerPackage $packageInfo.root $packageInfo.sha256 'windows-x64' }
  $paths=Get-WorkerServicePaths
  $settings=Get-WorkerSettingsBytes $paths '127.0.0.1' 8787 'service-fixture'
  [IO.File]::WriteAllBytes((Join-Path $FixtureRoot 'worker.environment'),$settings)
  Check-Case ($settings.Length -gt 0 -and $settings[$settings.Length-1] -eq 0) 'bounded-native-environment-produced'
  Check-Refusal 'environment-injection-refused' { Get-WorkerSettingsBytes $paths "host`nNODE_OPTIONS=x" 8787 'service-fixture' }
  Check-Refusal 'invalid-port-refused' { Get-WorkerSettingsBytes $paths 'localhost' 0 'service-fixture' }
  Check-Refusal 'private-json-error-is-redacted' { ConvertFrom-WorkerJson ([Text.Encoding]::UTF8.GetBytes('{"fixturePrivateValue":')) }
  $before='O:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;FR;;;BU)'
  $grant=Get-WorkerSharedRootGrant $before
  $descriptor=[Security.AccessControl.RawSecurityDescriptor]::new($grant)
  Check-Case ($descriptor.DiscretionaryAcl.Count -eq 4 -and $descriptor.DiscretionaryAcl[3].AccessMask -eq 0x001200a9) 'shared-root-adds-read-only-worker-access'
  Check-Case ((Get-WorkerSharedRootGrant $grant) -ceq $grant) 'existing-exact-shared-grant-is-stable'
  $broader="O:SYD:P(A;;FA;;;SY)(A;;FA;;;$script:WorkerSid)"
  Check-Refusal 'broader-existing-worker-grant-refused' { Get-WorkerSharedRootGrant $broader }
  $meshConfiguration = Join-Path $FixtureRoot 'mesh-configuration'
  New-Item -ItemType Directory -Path $meshConfiguration | Out-Null
  $firstBytes = [Text.Encoding]::UTF8.GetBytes('{"schemaVersion":"goatcitadel.worker-mesh-tools.v1","workspaceId":"workspace-a","nodeId":"node-a","bindings":[{"toolName":"fs.read","manifest":{"workspaceId":"workspace-a","nodeId":"node-a"}}]}')
  $firstHash = Get-WorkerBytesHash $firstBytes
  $sourceRegistry = Join-Path $FixtureRoot 'reviewed-registry.json'
  [IO.File]::WriteAllBytes($sourceRegistry,$firstBytes)
  $ticket = [pscustomobject]@{executionWorkspaceId='workspace-a';nodeId='node-a'}
  Check-Case ((Get-WorkerBytesHash (Read-WorkerMeshRegistryInput $sourceRegistry $firstHash $ticket)) -ceq $firstHash) 'registry-scope-and-digest-preflight'
  Check-Refusal 'registry-input-drift-refused' { Read-WorkerMeshRegistryInput $sourceRegistry ('a'*64) $ticket }
  Check-Refusal 'registry-foreign-node-refused' { Read-WorkerMeshRegistryInput $sourceRegistry $firstHash ([pscustomobject]@{executionWorkspaceId='workspace-a';nodeId='node-b'}) }
  Check-Case ((Get-WorkerMeshSelection $meshConfiguration $sddl) -ceq 'none') 'registry-initially-unconfigured'
  $initial = Publish-WorkerMeshSelection $meshConfiguration $firstHash $firstBytes 'none' $sddl {}
  Check-Case ($initial.changed -and (Get-WorkerMeshSelection $meshConfiguration $sddl) -ceq $firstHash) 'registry-initial-atomic-selection'
  $replay = Publish-WorkerMeshSelection $meshConfiguration $firstHash $firstBytes $firstHash $sddl {}
  Check-Case (-not $replay.changed) 'registry-idempotent-selection'
  $secondBytes = [Text.Encoding]::UTF8.GetBytes([Text.Encoding]::UTF8.GetString($firstBytes).Replace('fs.read','fs.write'))
  $secondHash = Get-WorkerBytesHash $secondBytes
  Check-Refusal 'registry-stale-selection-refused' { Publish-WorkerMeshSelection $meshConfiguration $secondHash $secondBytes 'none' $sddl {} }
  Check-Refusal 'registry-live-service-refused' { Publish-WorkerMeshSelection $meshConfiguration $secondHash $secondBytes $firstHash $sddl { throw 'service running' } }
  $script:meshChecks = 0
  Check-Refusal 'registry-service-start-during-staging-refused' {
    Publish-WorkerMeshSelection $meshConfiguration $secondHash $secondBytes $firstHash $sddl {
      $script:meshChecks++; if ($script:meshChecks -eq 3) { throw 'service started during staging' }
    }
  }
  Check-Case ((Get-WorkerMeshSelection $meshConfiguration $sddl) -ceq $firstHash) 'registry-late-service-start-preserves-selection'
  $lockPath = Join-Path $meshConfiguration 'mesh-registry.lock'
  $configLock = $native::AcquireEnrollmentLock($lockPath)
  try { Check-Refusal 'registry-concurrent-writer-refused' { Publish-WorkerMeshSelection $meshConfiguration $secondHash $secondBytes $firstHash $sddl {} } }
  finally { $configLock.Dispose() }
  $pointer = Join-Path $meshConfiguration 'mesh-registry.sha256'
  $runningHost = $native::OpenRead($pointer,64)
  try { Check-Refusal 'registry-running-host-pin-prevents-replacement' { Publish-WorkerMeshSelection $meshConfiguration $secondHash $secondBytes $firstHash $sddl {} } }
  finally { $runningHost.Dispose() }
  Check-Case ((Get-WorkerMeshSelection $meshConfiguration $sddl) -ceq $firstHash) 'registry-failed-update-preserves-active-selection'
  $updated = Publish-WorkerMeshSelection $meshConfiguration $secondHash $secondBytes $firstHash $sddl {}
  Check-Case ($updated.changed -and (Get-WorkerMeshSelection $meshConfiguration $sddl) -ceq $secondHash) 'registry-update-publishes-one-complete-selection'
  $firstGeneration = Join-Path $meshConfiguration ('mesh-registry-'+$firstHash+'.json')
  Check-Case ((Get-WorkerBytesHash (Read-WorkerMeshBytes $firstGeneration 524288)) -ceq $firstHash) 'registry-old-generation-retained'
  $disabled = Publish-WorkerMeshSelection $meshConfiguration 'disabled' ([byte[]]@()) $secondHash $sddl {}
  Check-Case ($disabled.changed -and (Get-WorkerMeshSelection $meshConfiguration $sddl) -ceq 'disabled' -and
    (Test-Path -LiteralPath $firstGeneration)) 'registry-disable-preserves-generations'
  [IO.File]::WriteAllText($firstGeneration,'corrupted retained bytes')
  Check-Refusal 'registry-corrupt-generation-refused' { Publish-WorkerMeshSelection $meshConfiguration $firstHash $firstBytes 'disabled' $sddl {} }
  Check-Case ((Get-WorkerMeshSelection $meshConfiguration $sddl) -ceq 'disabled') 'registry-corruption-never-reactivates-tools'
  $result=[ordered]@{passed=$true;cases=@($cases.ToArray());settingsFile=(Join-Path $FixtureRoot 'worker.environment');installRoot=$paths.Root;
    powershell=$PSVersionTable.PSVersion.ToString();scmMutated=$false;systemOwnershipClaimed=$false;
    custodyFile=$custodyFile;nativeDirectory=$custodyPaths.NativeDirectory;cellsDirectory=$cellsFixture;parentSddlFile=(Join-Path $FixtureRoot 'cell-parent.sddl')}
  [IO.File]::WriteAllText((Join-Path $FixtureRoot 'acceptance.json'),($result | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
  $result | ConvertTo-Json -Depth 5
} catch { Write-Output $_.ScriptStackTrace; throw }
finally { foreach ($lease in $leases) { $lease.Dispose() } }
