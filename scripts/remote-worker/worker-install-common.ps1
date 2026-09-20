#Requires -Version 5.1
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'broker-coordinator-common.ps1')

$script:WorkerServiceName = 'GoatCitadelRemoteWorker'
$script:WorkerAccount = 'NT SERVICE\GoatCitadelRemoteWorker'
$script:WorkerSid = 'S-1-5-80-1804173726-3601835665-1843708740-3959121232-3866049905'
$script:WorkerServiceSddl = "O:SYD:P(A;;0x000f01ff;;;SY)(A;;0x000f01ff;;;BA)(A;;0x00020005;;;$script:WorkerSid)"
$script:WorkerReadOnlySddl = "O:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)(A;;0x001200a9;;;$script:WorkerSid)"
$script:WorkerStateSddl = "O:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;0x001301bf;;;$script:WorkerSid)"
$script:CellControllerServiceName = 'GoatCitadelRemoteWorkerCellController'
$script:CellControllerSid = 'S-1-5-80-1810587747-2867442932-4204439414-1143594691-3479143721'
$script:CellControllerParentSddl = "O:SYG:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;$script:CellControllerSid)(A;OICI;RC;;;OW)S:(ML;OICI;NW;;;ME)"
$script:WorkerPackageSchema = 'goatcitadel.remote-worker-windows-package.v3'
$script:WorkerMaximumFileBytes = 268435456L

function Assert-WorkerEnrollmentInputChoice {
  param([string]$TicketFile, [switch]$DeferEnrollment)
  if ($DeferEnrollment -and -not [string]::IsNullOrWhiteSpace($TicketFile)) {
    throw 'REFUSED: deferred enrollment cannot accept a ticket.'
  }
  if (-not $DeferEnrollment -and [string]::IsNullOrWhiteSpace($TicketFile)) {
    throw 'REFUSED: supply a ticket or explicitly defer enrollment.'
  }
}

function Initialize-WorkerInstallNative {
  Initialize-BrokerCoordinatorNativeType
  if (-not ('GoatCitadel.RemoteWorker.Install.NativeFiles' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'worker-install-native.cs')
  }
  if (-not ('GoatCitadel.RemoteWorker.Install.ControllerKey' -as [type])) {
    Add-Type -Path (Join-Path $PSScriptRoot 'worker-controller-key.cs')
  }
}
function Get-WorkerServicePaths {
  param([string]$WindowsDirectory = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows))
  $drive = [IO.Path]::GetPathRoot($WindowsDirectory)
  if ($drive -notmatch '^[A-Za-z]:\\$') { throw 'REFUSED: the Windows directory has no supported local drive.' }
  $programData = $drive.Substring(0, 1).ToUpperInvariant() + ':\ProgramData'
  $shared = Join-Path $programData 'GoatCitadel'
  $root = Join-Path $shared 'RemoteWorker'
  return [pscustomobject]@{
    Drive = $drive; ProgramData = $programData; Shared = $shared; Root = $root
    Payload = (Join-Path $root 'payload'); Configuration = (Join-Path $root 'configuration')
    State = (Join-Path $root 'state'); Image = (Join-Path $root 'payload\bin\GoatCitadelRemoteWorkerHost.exe')
    Enrollment = (Join-Path $root 'enrollment')
    Cells = (Join-Path $root 'cells'); NativeDirectory = (Join-Path $root 'payload\app\worker\native')
    ControllerImage = (Join-Path $root 'payload\app\worker\native\GoatCitadelRemoteWorkerCellController.exe')
    ControllerCustody = (Join-Path $root 'configuration\cell-controller.identity')
    RuntimeCustody = (Join-Path $root 'configuration\cell-runtime.identity')
    CapacityCustody = (Join-Path $root 'configuration\cell-capacity.identity')
    StateWriterGate = (Join-Path $root 'configuration\state-writers.guard')
    HostRunGuard = (Join-Path $root 'configuration\host-run.guard')
    RuntimeDirectory = (Join-Path $root 'payload\app\runtime')
  }
}
# Fixed order matches CellCapacityArea and GCCAPS01. These paths are planning
# metadata only; callers must retain verified ancestor and directory custody.
function Get-WorkerCellCapacityPaths {
  param([Parameter(Mandatory=$true)][string]$InstallRoot)
  $root = [IO.Path]::GetFullPath($InstallRoot).TrimEnd('\')
  if ($root -notmatch '^[A-Za-z]:\\' -or $root.Substring(2).Contains(':')) {
    throw 'REFUSED: capacity roots require an ordinary local installation path.'
  }
  $areas = [ordered]@{ mutable_root = (Join-Path $root 'cells') }
  foreach ($name in @('input_staging','backup_staging','artifact_staging','immutable_artifact',
      'retained_outbox','database_sidecar','backup_publication','manifest','proxy_sidecar',
      'diagnostic','failed_cleanup','quarantine_evidence')) {
    $areas[$name] = Join-Path (Join-Path $root 'state') $name.Replace('_','-')
  }
  return $areas
}
function Get-WorkerCellCapacityCustodyBytes {
  param([Parameter(Mandatory=$true)][string]$InstallRoot)
  $areas = Get-WorkerCellCapacityPaths $InstallRoot
  $pins = [Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
  $ancestors = [Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
  try {
    # Pin the installation and state parents before collecting child identities.
    # Callers retain higher ancestors and verify installed ACLs separately.
    $ancestors.Add([GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::PinDirectory($InstallRoot))
    $ancestors.Add([GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::PinDirectory((Join-Path $InstallRoot 'state')))
    foreach ($directory in $areas.Values) {
      $pins.Add([GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::PinDirectory($directory))
    }
    return ,([GoatCitadel.RemoteWorker.Install.NativeFiles]::CreateCellCapacityCustody($pins.ToArray()))
  } finally {
    foreach ($pin in $pins) { $pin.Dispose() }
    foreach ($ancestor in $ancestors) { $ancestor.Dispose() }
  }
}
function Assert-WorkerContainedPath {
  param([string]$Root, [string]$Path)
  $parent = [IO.Path]::GetFullPath($Root).TrimEnd('\')
  $full = [IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith($parent + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'REFUSED: a worker file escapes its assigned directory.'
  }
  return $full
}
function Assert-WorkerRelativePath {
  param([string]$Path)
  if (-not $Path -or $Path.Length -gt 380 -or $Path.Contains('\') -or $Path -match '[<>:"|?*\x00-\x1f]') {
    throw 'REFUSED: invalid package path.'
  }
  foreach ($part in $Path.Split('/')) {
    if (-not $part -or $part -in @('.', '..') -or $part.EndsWith('.') -or $part.EndsWith(' ') -or
        $part -match '^(?i:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') { throw 'REFUSED: ambiguous package path.' }
  }
}
function Read-WorkerBytes {
  param([string]$Path, [long]$Maximum = 2097152)
  $stream = [GoatCitadel.RemoteWorker.Install.NativeFiles]::OpenRead($Path, $Maximum)
  try {
    $bytes = New-Object byte[] ([int]$stream.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $read = $stream.Read($bytes, $offset, $bytes.Length - $offset)
      if ($read -le 0) { throw 'REFUSED: incomplete file read.' }
      $offset += $read
    }
    if ($stream.ReadByte() -ne -1) { throw 'REFUSED: file changed while reading.' }
    return ,$bytes
  } finally { $stream.Dispose() }
}
function Get-WorkerBytesHash {
  param([byte[]]$Bytes)
  $hash = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($hash.ComputeHash($Bytes)).Replace('-', '').ToLowerInvariant() }
  finally { $hash.Dispose() }
}
function Get-WorkerFileRecord {
  param([string]$Path)
  $stream = [GoatCitadel.RemoteWorker.Install.NativeFiles]::OpenRead($Path, $script:WorkerMaximumFileBytes)
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    $streams = Get-BrokerCoordinatorStreamNames -Path $Path
    if ($streams.Count -ne 1 -or $streams[0] -ne ':$DATA') { throw 'REFUSED: file has an alternate data stream.' }
    return [pscustomobject]@{
      sha256 = [BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-', '').ToLowerInvariant()
      sizeBytes = $stream.Length
    }
  } finally { $hash.Dispose(); $stream.Dispose() }
}
function ConvertFrom-WorkerJson {
  param([byte[]]$Bytes)
  try {
    $text = ([Text.UTF8Encoding]::new($false, $true)).GetString($Bytes).TrimStart([char]0xfeff)
    $value = ConvertFrom-Json -InputObject $text
    if ($null -eq $value -or $value -is [array] -or $value -isnot [pscustomobject]) { throw 'object required' }
    return $value
  } catch { throw 'REFUSED: input is not a valid UTF-8 JSON object.' }
}
function Assert-WorkerProtectedKeyInput {
  param([byte[]]$Bytes, [string]$PackageRoot)
  # The runtime consumes a canonical GCTK identifier, not a JSON object. Validate
  # with the same decoder from the already inventory-verified package.
  if ($Bytes.Length -eq 0 -or $Bytes.Length -gt 5000) { throw 'REFUSED: protected key reference size is invalid.' }
  $code = @'
import { pathToFileURL } from 'node:url';
const { decodeWindowsTlsKeyIdentifier } = await import(pathToFileURL(process.argv[1]).href);
try {
  const bytes = Buffer.from(process.argv[2], 'base64');
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw Error('noncanonical encoding');
  decodeWindowsTlsKeyIdentifier(text);
} catch { process.exitCode = 2; }
'@
  $decoder = Join-Path $PackageRoot 'app/worker/node_modules/@goatcitadel/remote-worker-provisioner/dist/windows-tls-key-identifier.js'
  & (Join-Path $PackageRoot 'app/runtime/node.exe') --input-type=module -e $code $decoder ([Convert]::ToBase64String($Bytes))
  if ($LASTEXITCODE -ne 0) { throw 'REFUSED: protected key input is not a canonical public TLS key identifier.' }
}
function Get-WorkerPackage {
  param([string]$Root, [string]$ManifestSha256, [string]$Target)
  $lease = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::PinDirectory($Root)
  try {
    if ($ManifestSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'REFUSED: an independent package manifest hash is required.' }
    $manifestBytes = Read-WorkerBytes -Path (Join-Path $Root 'worker-package.json')
    if ((Get-WorkerBytesHash $manifestBytes) -cne $ManifestSha256) { throw 'REFUSED: package manifest differs from its independent pin.' }
    $manifest = ConvertFrom-WorkerJson $manifestBytes
    if ($manifest.schemaVersion -cne $script:WorkerPackageSchema -or $manifest.target -cne $Target -or
        $manifest.nodeVersion -cne '24.19.0' -or $manifest.opensslVersion -cne '3.5.7' -or
        $manifest.entrypoint -cne 'app/worker/dist/main.js' -or $manifest.nodeExecutable -cne 'app/runtime/node.exe' -or
        $manifest.hostExecutable -cne 'bin/GoatCitadelRemoteWorkerHost.exe') { throw 'REFUSED: unsupported worker package contract.' }
    $expected = [Collections.Generic.Dictionary[string,object]]::new([StringComparer]::OrdinalIgnoreCase)
    $items = @($manifest.files)
    if ($items.Count -lt 1 -or $items.Count -gt 10000) { throw 'REFUSED: package inventory exceeds its bound.' }
    $total = 0L
    foreach ($item in $items) {
      Assert-WorkerRelativePath $item.path
      if ($item.path -ceq 'worker-package.json' -or $expected.ContainsKey($item.path) -or
          $item.sha256 -cnotmatch '^[a-f0-9]{64}$' -or $item.sizeBytes -isnot [ValueType] -or
          [decimal]$item.sizeBytes -ne [long]$item.sizeBytes -or $item.sizeBytes -lt 0 -or
          $item.sizeBytes -gt $script:WorkerMaximumFileBytes) { throw 'REFUSED: invalid or duplicate package inventory row.' }
      $total += [long]$item.sizeBytes
      if ($total -gt 536870912L) { throw 'REFUSED: package exceeds its total byte bound.' }
      $expected.Add($item.path, $item)
    }
    foreach ($required in @('bin/GoatCitadelRemoteWorkerHost.exe', 'bin/worker.ps1', 'app/runtime/node.exe',
        'app/runtime/worker-host-receipt.json', 'app/worker/dist/main.js', 'app/worker/dist/index.js',
        'app/install/install-worker-service.ps1', 'app/install/uninstall-worker-service.ps1',
        'app/install/enroll-worker-service.ps1', 'app/install/worker-enrollment-common.ps1',
        'app/install/worker-install-common.ps1', 'app/install/worker-install-native.cs', 'app/install/worker-controller-key.cs',
        'app/install/configure-worker-mesh-registry.ps1', 'app/install/worker-mesh-registry-common.ps1',
        'app/install/broker-coordinator-common.ps1', 'app/install/install-broker-coordinator.ps1',
        'app/install/uninstall-broker-coordinator.ps1', 'app/pnpm-lock.yaml',
        'app/worker/native/GoatCitadelRemoteWorkerImageGuard.node', 'app/worker/native/GoatCitadelRemoteWorkerTlsKey.dll',
        'app/worker/native/GoatCitadelRemoteWorkerFiles.exe', 'app/worker/native/GoatCitadelRemoteWorkerStdio.exe',
        'app/worker/native/GoatCitadelRemoteWorkerCellProvisioning.exe',
        'app/worker/native/GoatCitadelRemoteWorkerCellController.exe',
        'app/provisioner/GoatCitadelRemoteWorkerProvisioner.exe', 'app/provisioner/GoatCitadelRemoteWorkerProvisionerClient.exe',
        'app/provisioner/GoatCitadelRemoteWorkerProvisionerAvailability.exe')) {
      if (-not $expected.ContainsKey($required)) { throw 'REFUSED: required worker package file is missing.' }
    }
    $queue = [Collections.Generic.Queue[string]]::new()
    $queue.Enqueue($Root)
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $seenEntries = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $directories = [Collections.Generic.List[string]]::new()
    while ($queue.Count -gt 0) {
      $directory = $queue.Dequeue()
      foreach ($child in @(Get-ChildItem -LiteralPath $directory -Force)) {
        if (($child.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'REFUSED: package has a reparse entry.' }
        $relative = $child.FullName.Substring($Root.TrimEnd('\').Length + 1).Replace('\', '/')
        Assert-WorkerRelativePath $relative
        if (-not $seenEntries.Add($relative)) { throw 'REFUSED: package has a case-fold collision.' }
        if ($child.PSIsContainer) {
          if ($directories.Count -ge 10000) { throw 'REFUSED: package directory count exceeds its bound.' }
          $directories.Add($relative); $queue.Enqueue($child.FullName); continue
        }
        if ($relative -ceq 'worker-package.json') { continue }
        if (-not $expected.ContainsKey($relative) -or -not $seen.Add($relative) -or
            $expected[$relative].path -cne $relative) { throw 'REFUSED: unexpected package file.' }
        $actual = Get-WorkerFileRecord $child.FullName
        if ($actual.sha256 -cne $expected[$relative].sha256 -or $actual.sizeBytes -ne $expected[$relative].sizeBytes) {
          throw 'REFUSED: package file differs from its pinned inventory.'
        }
      }
    }
    if ($seen.Count -ne $expected.Count) { throw 'REFUSED: a pinned package file is missing.' }
    $hostReceipt = ConvertFrom-WorkerJson (Read-WorkerBytes (Join-Path $Root 'app/runtime/worker-host-receipt.json'))
    if ($hostReceipt.schemaVersion -cne 'goatcitadel.remote-worker.windows-host.v3' -or $hostReceipt.target -cne $Target -or
        $hostReceipt.serviceName -cne $script:WorkerServiceName -or $hostReceipt.serviceIdentity.account -cne $script:WorkerAccount -or
        $hostReceipt.serviceIdentity.sid -cne $script:WorkerSid -or
        $hostReceipt.serviceIdentity.configuration -cne 'configuration/worker.environment' -or
        $hostReceipt.artifact.sha256 -cne $expected['bin/GoatCitadelRemoteWorkerHost.exe'].sha256 -or
        $hostReceipt.nodeSha256 -cne $expected['app/runtime/node.exe'].sha256 -or
        $hostReceipt.entrypointSha256 -cne $expected['app/worker/dist/main.js'].sha256) { throw 'REFUSED: native host receipt bindings differ.' }
    return [pscustomobject]@{ Manifest = $manifest; ManifestBytes = $manifestBytes; Files = $items; Directories = $directories.ToArray(); TotalBytes = $total }
  } finally { $lease.Dispose() }
}
function Get-WorkerSettingsBytes {
  param($Paths, [string]$GatewayHost, [int]$GatewayPort, [string]$RunId, [switch]$CapacityLayout)
  if (-not $GatewayHost -or $GatewayHost.Length -gt 253 -or $GatewayHost -match '[\s\x00-\x1f=]' -or
      $GatewayPort -lt 1 -or $GatewayPort -gt 65535 -or $RunId -cnotmatch '^[a-zA-Z0-9-]{1,80}$') {
    throw 'REFUSED: invalid worker connection settings.'
  }
  $stateDirectory = $Paths.State
  $reportFile = Join-Path $Paths.State 'service-report.json'
  if ($CapacityLayout) {
    $areas = Get-WorkerCellCapacityPaths $Paths.Root
    $stateDirectory = $areas.retained_outbox
    $reportFile = Join-Path $areas.diagnostic 'service-report.json'
  }
  $entries = @(
    "GOATCITADEL_CONNECTED_WORKER_HOST=$GatewayHost"
    "GOATCITADEL_CONNECTED_WORKER_PORT=$GatewayPort"
    ('GOATCITADEL_CONNECTED_WORKER_CLIENT_CERT_FILE=' + (Join-Path $Paths.Configuration 'client-cert.pem'))
    ('GOATCITADEL_CONNECTED_WORKER_CA_FILE=' + (Join-Path $Paths.Configuration 'ca.pem'))
    ('GOATCITADEL_CONNECTED_WORKER_TICKET_FILE=' + (Join-Path $Paths.Configuration 'ticket.json'))
    ('GOATCITADEL_CONNECTED_WORKER_PROTECTED_KEY_FILE=' + (Join-Path $Paths.Configuration 'protected-key.json'))
    ('GOATCITADEL_CONNECTED_WORKER_STATE_DIR=' + $stateDirectory)
    ('GOATCITADEL_CONNECTED_WORKER_REPORT_FILE=' + $reportFile)
    "GOATCITADEL_CONNECTED_WORKER_RUN_ID=$RunId"
    'GOATCITADEL_CONNECTED_WORKER_STOP_AFTER=complete'
    'GOATCITADEL_CONNECTED_WORKER_EXECUTION_MODE=gateway_inference'
    'GOATCITADEL_CONNECTED_WORKER_RUN_MODE=continuous'
  )
  return ,([Text.Encoding]::Unicode.GetBytes(($entries -join [char]0) + [char]0 + [char]0))
}
function New-WorkerProtectedFile {
  param([string]$Path, [string]$Sddl, $OwnedFiles)
  $created = $false
  try { return [GoatCitadel.RemoteWorker.Install.NativeFiles]::CreateProtectedFile($Path, $Sddl, [ref]$created) }
  finally { if ($created) { $OwnedFiles.Add($Path) } }
}
function Write-WorkerProtectedBytes {
  param([string]$Path, [byte[]]$Bytes, [string]$Sddl, $OwnedFiles, $Leases)
  $stream = New-WorkerProtectedFile $Path $Sddl $OwnedFiles
  try { $stream.Write($Bytes, 0, $Bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
  $Leases.Add([GoatCitadel.RemoteWorker.Install.NativeFiles]::OpenRead($Path, $script:WorkerMaximumFileBytes))
}
function Copy-WorkerPinnedFile {
  param([string]$Source, [string]$Destination, $Expected, [string]$Sddl, $OwnedFiles, $Leases)
  $inputFile = [GoatCitadel.RemoteWorker.Install.NativeFiles]::OpenRead($Source, $script:WorkerMaximumFileBytes)
  $outputFile = $null; $hash = [Security.Cryptography.SHA256]::Create()
  try {
    if ($inputFile.Length -ne $Expected.sizeBytes) { throw 'REFUSED: copy input length changed.' }
    $actualHash = [BitConverter]::ToString($hash.ComputeHash($inputFile)).Replace('-', '').ToLowerInvariant()
    if ($actualHash -cne $Expected.sha256) { throw 'REFUSED: copy input hash changed.' }
    $inputFile.Position = 0
    $outputFile = New-WorkerProtectedFile $Destination $Sddl $OwnedFiles
    $inputFile.CopyTo($outputFile, 65536); $outputFile.Flush($true)
    if ($outputFile.Length -ne $Expected.sizeBytes) { throw 'REFUSED: copied file length differs.' }
  } finally { if ($outputFile) { $outputFile.Dispose() }; $hash.Dispose(); $inputFile.Dispose() }
  $Leases.Add([GoatCitadel.RemoteWorker.Install.NativeFiles]::OpenRead($Destination, $script:WorkerMaximumFileBytes))
  $actual = Get-WorkerFileRecord $Destination
  if ($actual.sha256 -cne $Expected.sha256 -or $actual.sizeBytes -ne $Expected.sizeBytes) { throw 'REFUSED: copied file verification failed.' }
}
function Assert-WorkerServiceReadBack {
  param($Paths)
  $native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
  $expectedConfig = '16|3|1|"' + $Paths.Image + '"|' + $script:WorkerAccount + '||1'
  if ($native::GetServiceConfigLine($script:WorkerServiceName) -cne $expectedConfig -or
      $native::GetServiceSidType($script:WorkerServiceName) -ne 1 -or
      $native::GetServiceRequiredPrivileges($script:WorkerServiceName) -cne 'SeChangeNotifyPrivilege' -or
      (ConvertTo-CanonicalSddl ($native::GetServiceSddl($script:WorkerServiceName))) -cne (ConvertTo-CanonicalSddl $script:WorkerServiceSddl)) {
    throw 'REFUSED: worker SCM identity/configuration differs.'
  }
  $status = $native::GetServiceStatusLine($script:WorkerServiceName).Split('|')
  # A newly installed stopped worker can report ERROR_SERVICE_NEVER_STARTED (1077).
  # This recipe does not change the separate signer's first-boot contract.
  if ($status.Count -ne 8 -or $status[0] -ne '1' -or $status[1] -ne '0' -or $status[2] -ne '0' -or
      $status[3] -ne '16' -or $status[4] -notin @('0', '1077') -or $status[5] -ne '0' -or
      $status[6] -ne '0' -or $status[7] -ne '0') { throw 'REFUSED: worker service is not cleanly stopped.' }
}
function Get-WorkerSharedRootGrant {
  param([string]$Sddl)
  $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
  $count = 0
  foreach ($ace in $descriptor.DiscretionaryAcl) {
    if ($ace -is [Security.AccessControl.KnownAce] -and $ace.SecurityIdentifier.Value -ceq $script:WorkerSid) {
      $count++
      if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or [int]$ace.AceFlags -ne 0 -or
          $ace.AccessMask -ne 0x001200a9) { throw 'REFUSED: existing worker permissions on the shared root differ.' }
    }
  }
  if ($count -gt 1) { throw 'REFUSED: duplicate worker shared-root grants.' }
  if ($count -eq 0) {
    $sid = [Security.Principal.SecurityIdentifier]::new($script:WorkerSid)
    $ace = [Security.AccessControl.CommonAce]::new([Security.AccessControl.AceFlags]::None,
      [Security.AccessControl.AceQualifier]::AccessAllowed, 0x001200a9, $sid, $false, $null)
    $descriptor.DiscretionaryAcl.InsertAce($descriptor.DiscretionaryAcl.Count, $ace)
  }
  return $descriptor.GetSddlForm([Security.AccessControl.AccessControlSections]::Owner -bor [Security.AccessControl.AccessControlSections]::Access)
}

function Get-WorkerCellControllerCustodyBytes {
  param($Paths, $Inventory)
  $nativeDirectory = $null; $cellsDirectory = $null
  $pins = [Collections.Generic.List[string]]::new()
  try {
    $nativeDirectory = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::PinDirectory($Paths.NativeDirectory)
    $cellsDirectory = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::PinDirectory($Paths.Cells)
    foreach ($name in @('GoatCitadelRemoteWorkerCellController.exe', 'GoatCitadelRemoteWorkerCellProvisioning.exe')) {
      $relative = 'app/worker/native/' + $name
      $expected = @($Inventory.Files | Where-Object { $_.path -ceq $relative })
      if ($expected.Count -ne 1) { throw 'REFUSED: a controller custody image pin is missing or duplicated.' }
      $actual = Get-WorkerFileRecord (Join-Path $Paths.NativeDirectory $name)
      if ($actual.sha256 -cne $expected[0].sha256 -or $actual.sizeBytes -ne $expected[0].sizeBytes) {
        throw 'REFUSED: a controller custody image differs from the package.'
      }
      $pins.Add($actual.sha256)
    }
    return ,([GoatCitadel.RemoteWorker.Install.NativeFiles]::CreateCellControllerCustody($pins[0], $pins[1], $nativeDirectory, $cellsDirectory))
  } finally {
    if ($cellsDirectory) { $cellsDirectory.Dispose() }
    if ($nativeDirectory) { $nativeDirectory.Dispose() }
  }
}
function Get-WorkerCellRuntimeCustodyBytes {
  param($Paths, $Inventory)
  # The source is the independently verified package's fixed Node runtime tree.
  # Workloads never select this directory or supply its manifest.
  $names = @('node.exe', 'worker-host-receipt.json')
  $rows = @($Inventory.Files | Where-Object { $_.path.StartsWith('app/runtime/', [StringComparison]::Ordinal) })
  if ($rows.Count -ne $names.Count) { throw 'REFUSED: runtime source inventory differs from the supported package.' }
  $directory = $null; $stream = [IO.MemoryStream]::new(); $writer = [IO.BinaryWriter]::new($stream)
  try {
    $directory = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::PinDirectory($Paths.RuntimeDirectory)
    $writer.Write([Text.Encoding]::ASCII.GetBytes("goatcitadel.worker-runtime-bundle.v1`0"))
    $writer.Write([uint32]$names.Count)
    foreach ($name in $names) {
      $expected = @($rows | Where-Object { $_.path -ceq ('app/runtime/' + $name) })
      if ($expected.Count -ne 1) { throw 'REFUSED: runtime source pin is missing or duplicated.' }
      $actual = Get-WorkerFileRecord (Join-Path $Paths.RuntimeDirectory $name)
      if ($actual.sha256 -cne $expected[0].sha256 -or $actual.sizeBytes -ne $expected[0].sizeBytes) {
        throw 'REFUSED: runtime source differs from the verified package.'
      }
      $pathBytes = [Text.Encoding]::ASCII.GetBytes($name)
      $writer.Write([uint32]$pathBytes.Length); $writer.Write($pathBytes); $writer.Write([uint64]$actual.sizeBytes)
      for ($index = 0; $index -lt 32; $index++) { $writer.Write([Convert]::ToByte($actual.sha256.Substring($index * 2, 2), 16)) }
    }
    $writer.Flush()
    $bundleHash = Get-WorkerBytesHash $stream.ToArray()
    $packageHash = Get-WorkerBytesHash $Inventory.ManifestBytes
    return ,([GoatCitadel.RemoteWorker.Install.NativeFiles]::CreateCellRuntimeCustody($packageHash, $bundleHash, $directory))
  } finally { $writer.Dispose(); $stream.Dispose(); if ($directory) { $directory.Dispose() } }
}
function Assert-WorkerCellCapacityCustody {
  param($Paths)
  # The installer retains all created directory/file handles through service creation.
  $expected = Get-WorkerCellCapacityCustodyBytes $Paths.Root
  $actual = Read-WorkerBytes $Paths.CapacityCustody
  if ($actual.Length -ne 320 -or (Get-WorkerBytesHash $actual) -cne (Get-WorkerBytesHash $expected) -or
      (ConvertTo-CanonicalFileSddl ([GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::GetFileSddl($Paths.CapacityCustody))) -cne
        (ConvertTo-CanonicalFileSddl $script:WorkerReadOnlySddl)) { throw 'REFUSED: installed capacity custody differs.' }
}
function Assert-WorkerCellRuntimeCustody {
  param($Paths, $Inventory)
  $expected = Get-WorkerCellRuntimeCustodyBytes $Paths $Inventory
  $actual = Read-WorkerBytes $Paths.RuntimeCustody
  if ($actual.Length -ne 96 -or (Get-WorkerBytesHash $actual) -cne (Get-WorkerBytesHash $expected) -or
      (ConvertTo-CanonicalFileSddl ([GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::GetFileSddl($Paths.RuntimeCustody))) -cne
        (ConvertTo-CanonicalFileSddl $script:WorkerReadOnlySddl)) { throw 'REFUSED: installed runtime custody differs.' }
}
function Assert-WorkerCellParentSecurity {
  param([string]$Sddl)
  $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
  $expectedDescriptor = [Security.AccessControl.RawSecurityDescriptor]::new($script:CellControllerParentSddl)
  # Windows may mark the explicit mandatory-label SACL auto-inherited. Ignore
  # only that bookkeeping flag, not ACE inheritance flags, protection or rights.
  $flags = [int]$descriptor.ControlFlags -band (-bnot [int][Security.AccessControl.ControlFlags]::SystemAclAutoInherited)
  $descriptor.SetFlags([Security.AccessControl.ControlFlags]$flags)
  # GetSddlForm(All) may omit mandatory-label ACEs; compare serialized bytes
  # so label SID, policy and ACE inheritance flags cannot disappear from proof.
  $actualBytes=[byte[]]::new($descriptor.BinaryLength)
  $expectedBytes=[byte[]]::new($expectedDescriptor.BinaryLength)
  $descriptor.GetBinaryForm($actualBytes,0)
  $expectedDescriptor.GetBinaryForm($expectedBytes,0)
  if ([Convert]::ToBase64String($actualBytes) -cne [Convert]::ToBase64String($expectedBytes)) {
    throw 'REFUSED: cell parent owner, group, DACL or integrity label differs.'
  }
}
function Assert-WorkerCellControllerCustody {
  param($Paths, $Inventory)
  $expected = Get-WorkerCellControllerCustodyBytes $Paths $Inventory
  $actual = Read-WorkerBytes $Paths.ControllerCustody
  if ($actual.Length -ne 120 -or (Get-WorkerBytesHash $actual) -cne (Get-WorkerBytesHash $expected) -or
      (ConvertTo-CanonicalFileSddl ([GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::GetFileSddl($Paths.ControllerCustody))) -cne
        (ConvertTo-CanonicalFileSddl $script:WorkerReadOnlySddl)) { throw 'REFUSED: installed controller custody differs.' }
  $parent = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::PinDirectory($Paths.Cells)
  try {
    Assert-WorkerCellParentSecurity ([GoatCitadel.RemoteWorker.Install.NativeFiles]::GetCellDirectorySddl($parent))
  } finally { $parent.Dispose() }
}
function Assert-WorkerCellControllerServiceReadBack {
  param($Paths)
  $native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
  $expected = '16|3|1|"' + $Paths.ControllerImage + '"|LocalSystem||1'
  if ($native::GetServiceConfigLine($script:CellControllerServiceName) -cne $expected -or
      $native::GetServiceSidType($script:CellControllerServiceName) -ne 1 -or
      $native::GetServiceRequiredPrivileges($script:CellControllerServiceName) -cne "SeChangeNotifyPrivilege`nSeManageVolumePrivilege" -or
      (ConvertTo-CanonicalSddl ($native::GetServiceSddl($script:CellControllerServiceName))) -cne (ConvertTo-CanonicalSddl $script:WorkerServiceSddl)) {
    throw 'REFUSED: cell controller SCM identity/configuration differs.'
  }
  $status = $native::GetServiceStatusLine($script:CellControllerServiceName).Split('|')
  if ($status.Count -ne 8 -or $status[0] -ne '1' -or $status[1] -ne '0' -or $status[2] -ne '0' -or
      $status[3] -ne '16' -or $status[4] -notin @('0', '1077') -or $status[5] -ne '0' -or
      $status[6] -ne '0' -or $status[7] -ne '0') { throw 'REFUSED: cell controller service is not cleanly stopped.' }
}
