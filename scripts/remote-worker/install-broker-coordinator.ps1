#Requires -Version 5.1
<#
.SYNOPSIS
  Administrator-owned installer recipe for the GoatCitadel remote-worker
  availability-broker coordinator (M2 / HX-501). Production-dark: installs and
  pins, never starts.

.DESCRIPTION
  Freezes and, on a real administrator host, executes the M2 coordinator
  recipe derived from the availability broker's own validation code:

    1. preflight            - READ-ONLY. Refuses (exit 2) when the host, the
                              pins, or the staged package-proven trio do not
                              satisfy the recipe: not elevated, non-Windows,
                              malformed system drive, relocated ProgramData,
                              missing/conflicting SHA-256 pins, inconsistent
                              package result, missing or drifted staged
                              images, oversize images, alternate data streams,
                              an already-present broker or signer service, a
                              pre-existing install footprint, an untrusted
                              pre-existing GoatCitadel root owner, or a
                              coordinator-principal derivation mismatch.
    2. stage                - Creates the protected directory chain, copies
                              exactly the service, client and broker images,
                              re-verifies their SHA-256,
                              size, single-hard-link and single-stream
                              closure at the destination, then applies the
                              frozen owner+protected-DACL descriptors.
    3. initialize-state     - Exclusively creates state-v1 and its four empty
                              children: journal, keysets, controls, quarantine.
                              Reads back exact SYSTEM owner/group, protected
                              SYSTEM+signer DACL and directory-only attributes.
                              Existing state is never adopted or overwritten.
    4. install-services     - Creates the signer and broker services with the
                              exact demand-start configuration the broker
                              validates (own process, demand start, error
                              normal, quoted DOS binary path, LocalSystem),
                              sets SERVICE_SID_TYPE_UNRESTRICTED (which
                              materializes the distinct coordinator principal
                              NT SERVICE\GoatCitadelRemoteWorkerProvisionerAvailability),
                              the exact SeChangeNotifyPrivilege-only required
                              privilege list, and the frozen protected SCM
                              DACL on each service object.
    5. verify               - Reads back configuration, SID type, privileges,
                              SCM security descriptor, service state
                              (stopped, pid 0), file security descriptors and
                              hashes, and the OS translation of the
                              coordinator principal, and fails closed on any
                              drift. The services are left STOPPED; this
                              recipe never calls a service start.
    6. evidence             - Always writes the machine-readable bundle
                              broker-coordinator-install-evidence.json
                              (schema goatcitadel.remote-worker.broker-coordinator-install/1),
                              including on refusal and failure. The bundle is
                              never deleted.

  On a mid-install failure the script rolls back its own services, files and
  empty directories in reverse order, recording any rollback failure. State
  cleanup uses retained creation handles; nonempty state and uncertain service
  removal preserve the install footprint for investigation.

  Production-dark guarantees: no service is ever started; the untrusted
  helper/client is installed without service-control rights; the broker and
  one-exchange signer remain dark until the
  administrator-owned installed-host proof row completes.

  Exit codes: 0 = passed, 1 = failed, 2 = refused.

.EXAMPLE
  powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
    -File scripts\remote-worker\install-broker-coordinator.ps1 `
    -Target windows-x64 `
    -StagedTrioDir artifacts\remote-worker\windows-x64 `
    -PackageResultPath artifacts\remote-worker\windows-x64\app\provisioner\install-receipt.json

.EXAMPLE
  # Prove the refusal branches without touching the SCM or the filesystem.
  powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
    -File scripts\remote-worker\install-broker-coordinator.ps1 `
    -Target windows-x64 -StagedTrioDir artifacts\remote-worker\windows-x64 `
    -BrokerImageSha256 <64-hex> -SignerImageSha256 <64-hex> `
    -ClientImageSha256 <64-hex> -Preflight
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("windows-x64", "windows-arm64")]
  [string]$Target,

  [string]$StagedTrioDir,

  [string]$PackageResultPath,

  [ValidatePattern("^[0-9a-fA-F]{64}$")]
  [string]$BrokerImageSha256,

  [ValidatePattern("^[0-9a-fA-F]{64}$")]
  [string]$SignerImageSha256,

  [ValidatePattern("^[0-9a-fA-F]{64}$")]
  [string]$ClientImageSha256,

  [string]$OutputRoot,

  [switch]$Preflight
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "broker-coordinator-common.ps1")
. (Join-Path $PSScriptRoot "broker-state-common.ps1")

# --- Run state ---
$script:StartedAt = (Get-Date).ToUniversalTime()
$script:Steps = New-Object System.Collections.Generic.List[object]
$script:Refusals = New-Object System.Collections.Generic.List[string]
$script:CleanupFailures = New-Object System.Collections.Generic.List[string]
$script:CreatedServices = New-Object System.Collections.Generic.List[string]
$script:CreatedServiceLeases = New-Object System.Collections.Generic.List[System.IDisposable]
$script:CreatedDirectories = New-Object System.Collections.Generic.List[string]
$script:CopiedFiles = New-Object System.Collections.Generic.List[string]
$script:DirectoryLeases = New-Object System.Collections.Generic.List[System.IDisposable]
$script:ImageLeases = New-Object System.Collections.Generic.List[System.IDisposable]
$script:StateLeases = New-Object System.Collections.Generic.List[object]
$script:GoatCitadelRootWasPresent = $false
$script:ReadBack = $null
$script:Pins = $null
$script:Paths = $null
$script:Verdict = "failed"

function Add-StepRecord {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][ValidateSet("passed", "failed", "refused", "skipped")][string]$Status,
    [Parameter(Mandatory = $true)][datetime]$StartedAtUtc,
    [string]$Detail = ""
  )
  $finished = (Get-Date).ToUniversalTime()
  $record = [ordered]@{
    name = $Name
    status = $Status
    startedAt = $StartedAtUtc.ToString("o")
    finishedAt = $finished.ToString("o")
    detail = $Detail
  }
  $script:Steps.Add([pscustomobject]$record)
}

function Invoke-RecipeStep {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$Body
  )
  $stepStart = (Get-Date).ToUniversalTime()
  $refusalCountBefore = $script:Refusals.Count
  try {
    $detail = & $Body
    if ($null -eq $detail) { $detail = "" }
    $status = "passed"
    if ($script:Refusals.Count -gt $refusalCountBefore) {
      $status = "refused"
      $detail = $script:Refusals.GetRange($refusalCountBefore, $script:Refusals.Count - $refusalCountBefore).ToArray() -join "; "
    }
    Add-StepRecord -Name $Name -Status $status -StartedAtUtc $stepStart -Detail ([string]$detail)
  }
  catch {
    $message = $_.Exception.Message
    if ($message -like "REFUSED:*") {
      Add-StepRecord -Name $Name -Status "refused" -StartedAtUtc $stepStart -Detail $message
    }
    else {
      Add-StepRecord -Name $Name -Status "failed" -StartedAtUtc $stepStart -Detail $message
    }
    throw
  }
}

function Add-RefusalFinding {
  <#
    Preflight mode collects every refusal before the verdict; install mode
    fails fast on the first refusal so no mutation can follow a bad check.
  #>
  param(
    [Parameter(Mandatory = $true)][string]$Message
  )
  $script:Refusals.Add($Message)
  if (-not $Preflight) {
    throw ("REFUSED: {0}" -f $Message)
  }
}

# --- Preflight checks (READ-ONLY: every check below only queries the
# --- environment, the staged files, and the Service Control Manager) --------

function Test-RecipePlatform {
  if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    Add-RefusalFinding "This recipe composes Windows service security and only runs on Windows."
    return
  }
  Initialize-BrokerCoordinatorNativeType
}

function Test-RecipeElevation {
  if (-not (Test-BrokerCoordinatorElevation)) {
    Add-RefusalFinding "The installer must run from an elevated administrator context; the broker SCM DACL and LocalSystem-owned image ACLs cannot be composed otherwise."
  }
}

function Test-RecipeSystemDrive {
  try {
    $systemRoot = [System.Environment]::GetFolderPath("Windows")
    $systemDrive = [System.IO.Path]::GetPathRoot($systemRoot).TrimEnd("\")
    $script:Paths = Get-BrokerCoordinatorPaths -SystemDrive $systemDrive
    if (-not [string]::Equals($env:SystemDrive, $systemDrive, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw "REFUSED: SystemDrive does not match the Windows system directory volume."
    }
  }
  catch {
    Add-RefusalFinding $_.Exception.Message.Replace("REFUSED: ", "")
    return
  }
  $expectedProgramData = $script:Paths.Drive + "\ProgramData"
  if (-not [string]::Equals($env:ProgramData, $expectedProgramData, [System.StringComparison]::OrdinalIgnoreCase)) {
    Add-RefusalFinding ("ProgramData is relocated ('{0}' expected '{1}'); the broker resolves its fixed image path from the SystemRoot volume and a relocated host is outside this recipe." -f $env:ProgramData, $expectedProgramData)
  }
}

function Resolve-RecipePins {
  $manifestBroker = $null
  $manifestSigner = $null
  $manifestClient = $null
  $packageConsistent = $null
  $packageClientConsistent = $null
  if ($PackageResultPath) {
    if (-not (Test-Path -LiteralPath $PackageResultPath)) {
      Add-RefusalFinding ("The package result '{0}' does not exist; the deterministic package proof is the only pin source." -f $PackageResultPath)
      return
    }
    if ((Get-Item -LiteralPath $PackageResultPath).Length -gt 2097152) {
      Add-RefusalFinding "The package result exceeds the 2 MiB limit. Use app/provisioner/install-receipt.json from the portable package."
      return
    }
    try {
      $manifest = Get-Content -LiteralPath $PackageResultPath -Raw | ConvertFrom-Json
    }
    catch {
      Add-RefusalFinding "The package result is not readable JSON."
      return
    }
    if ($null -eq $manifest -or $manifest -isnot [System.Management.Automation.PSCustomObject]) {
      Add-RefusalFinding "The package result must be a JSON object."
      return
    }
    $availabilityProperty = $manifest.PSObject.Properties["availability"]
    $serviceProperty = $manifest.PSObject.Properties["service"]
    $clientProperty = $manifest.PSObject.Properties["client"]
    $targetProperty = $manifest.PSObject.Properties["target"]
    if ($null -eq $availabilityProperty -or $null -eq $serviceProperty -or $null -eq $clientProperty -or $null -eq $targetProperty) {
      Add-RefusalFinding "The package result does not carry the target and availability/service/client trio sections."
      return
    }
    if ($manifest.target -cne $Target) {
      Add-RefusalFinding "The package result target does not match -Target."
      return
    }
    foreach ($section in @($manifest.availability, $manifest.service, $manifest.client)) {
      if ($null -eq $section -or $null -eq $section.PSObject.Properties["sha256"] -or [string]$section.sha256 -cnotmatch '^[0-9a-f]{64}$') {
        Add-RefusalFinding "The package result carries a missing or malformed image SHA-256."
        return
      }
    }
    if ($null -eq $manifest.availability.PSObject.Properties["targetServiceSha256"] -or
        $null -eq $manifest.service.PSObject.Properties["targetClientSha256"]) {
      Add-RefusalFinding "The package result does not bind both broker-to-signer and signer-to-client image pins. Rebuild the trio."
      return
    }
    $manifestBroker = ([string]$manifest.availability.sha256).ToLowerInvariant()
    $manifestSigner = ([string]$manifest.service.sha256).ToLowerInvariant()
    $manifestClient = ([string]$manifest.client.sha256).ToLowerInvariant()
    $embeddedPin = ([string]$manifest.availability.targetServiceSha256).ToLowerInvariant()
    $packageConsistent = [string]::Equals($embeddedPin, $manifestSigner, [System.StringComparison]::Ordinal)
    if (-not $packageConsistent) {
      Add-RefusalFinding ("The package result is internally inconsistent: availability.targetServiceSha256 '{0}' does not equal service.sha256 '{1}'." -f $embeddedPin, $manifestSigner)
    }
    $packageClientConsistent = [string]::Equals([string]$manifest.service.targetClientSha256, $manifestClient, [System.StringComparison]::Ordinal)
    if (-not $packageClientConsistent) {
      Add-RefusalFinding "The package result is internally inconsistent: service.targetClientSha256 does not equal client.sha256."
    }
  }
  $resolvedBroker = $null
  $resolvedSigner = $null
  $resolvedClient = $null
  if ($BrokerImageSha256) { $resolvedBroker = $BrokerImageSha256.ToLowerInvariant() }
  if ($SignerImageSha256) { $resolvedSigner = $SignerImageSha256.ToLowerInvariant() }
  if ($ClientImageSha256) { $resolvedClient = $ClientImageSha256.ToLowerInvariant() }
  if ($manifestBroker) {
    if ($resolvedBroker -and -not [string]::Equals($resolvedBroker, $manifestBroker, [System.StringComparison]::Ordinal)) {
      Add-RefusalFinding "The explicit -BrokerImageSha256 pin conflicts with the package result; refusing to guess which pin is authoritative."
    }
    $resolvedBroker = $manifestBroker
  }
  if ($manifestSigner) {
    if ($resolvedSigner -and -not [string]::Equals($resolvedSigner, $manifestSigner, [System.StringComparison]::Ordinal)) {
      Add-RefusalFinding "The explicit -SignerImageSha256 pin conflicts with the package result; refusing to guess which pin is authoritative."
    }
    $resolvedSigner = $manifestSigner
  }
  if ($manifestClient) {
    if ($resolvedClient -and -not [string]::Equals($resolvedClient, $manifestClient, [System.StringComparison]::Ordinal)) {
      Add-RefusalFinding "The explicit -ClientImageSha256 pin conflicts with the package result; refusing to guess which pin is authoritative."
    }
    $resolvedClient = $manifestClient
  }
  if (-not $resolvedBroker -or -not $resolvedSigner -or -not $resolvedClient) {
    Add-RefusalFinding "No SHA-256 pin source: provide -PackageResultPath from the deterministic package proof, or all three -BrokerImageSha256, -SignerImageSha256 and -ClientImageSha256 pins."
    return
  }
  $script:Pins = [ordered]@{
    brokerImageSha256 = $resolvedBroker
    signerImageSha256 = $resolvedSigner
    clientImageSha256 = $resolvedClient
    packageResultPath = $PackageResultPath
    packageTargetServiceSha256Consistent = $packageConsistent
    packageTargetClientSha256Consistent = $packageClientConsistent
  }
}

function Test-RecipeCoordinatorDerivation {
  $derivedBroker = Get-VirtualServiceAccountSid -ServiceName $script:BrokerServiceName
  $derivedSigner = Get-VirtualServiceAccountSid -ServiceName $script:SignerServiceName
  if (-not [string]::Equals($derivedBroker, $script:BrokerServiceSid, [System.StringComparison]::Ordinal)) {
    Add-RefusalFinding ("Coordinator principal derivation mismatch: derived '{0}' but the broker binary pins '{1}'; wrong principal, refusing." -f $derivedBroker, $script:BrokerServiceSid)
  }
  if (-not [string]::Equals($derivedSigner, $script:SignerServiceSid, [System.StringComparison]::Ordinal)) {
    Add-RefusalFinding ("Signer principal derivation mismatch: derived '{0}' but the broker binary pins '{1}'; wrong principal, refusing." -f $derivedSigner, $script:SignerServiceSid)
  }
}

function Test-RecipeStagedImage {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [Parameter(Mandatory = $true)][string]$ExpectedSha256,
    [Parameter(Mandatory = $true)][string]$Description
  )
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    Add-RefusalFinding ("The staged {0} '{1}' does not exist." -f $Description, $Path)
    return
  }
  $item = Get-Item -LiteralPath $Path
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    Add-RefusalFinding ("The staged {0} is a reparse point." -f $Description)
    return
  }
  if ([GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::GetFileHardLinkCount($Path) -ne 1) {
    Add-RefusalFinding ("The staged {0} does not have exactly one hard link." -f $Description)
    return
  }
  if ($item.Length -le 0 -or $item.Length -gt $script:MaximumImageBytes) {
    Add-RefusalFinding ("The staged {0} is {1} bytes; the broker only accepts images between 1 and {2} bytes." -f $Description, $item.Length, $script:MaximumImageBytes)
    return
  }
  $actual = Get-BrokerCoordinatorFileSha256 -Path $Path
  if (-not [string]::Equals($actual, $ExpectedSha256, [System.StringComparison]::Ordinal)) {
    Add-RefusalFinding ("Image hash mismatch for the staged {0}: expected '{1}' but computed '{2}'; the package-verified pin is authoritative." -f $Description, $ExpectedSha256, $actual)
    return
  }
  $streams = Get-BrokerCoordinatorStreamNames -Path $Path
  if ($streams.Count -ne 1 -or $streams[0] -ne ':$DATA') {
    Add-RefusalFinding ("The staged {0} carries alternate data streams ({1}); the broker requires exactly the unnamed data stream." -f $Description, ($streams -join ", "))
  }
}

function Test-RecipeStagedTrio {
  if (-not $StagedTrioDir) {
    Add-RefusalFinding "-StagedTrioDir is required: it must point at the deterministic package output containing the proven service/client/broker images."
    return
  }
  if (-not (Test-Path -LiteralPath $StagedTrioDir -PathType Container)) {
    Add-RefusalFinding ("The staged trio directory '{0}' does not exist." -f $StagedTrioDir)
    return
  }
  if ($null -eq $script:Pins) {
    return
  }
  Test-RecipeStagedImage -Path (Join-Path $StagedTrioDir $script:BrokerExecutableName) -ExpectedSha256 $script:Pins.brokerImageSha256 -Description "availability-broker image"
  Test-RecipeStagedImage -Path (Join-Path $StagedTrioDir $script:SignerExecutableName) -ExpectedSha256 $script:Pins.signerImageSha256 -Description "signer image"
  Test-RecipeStagedImage -Path (Join-Path $StagedTrioDir $script:ClientExecutableName) -ExpectedSha256 $script:Pins.clientImageSha256 -Description "client image"
}

function Test-RecipeScmClean {
  if (-not ("GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe" -as [type])) {
    # The platform preflight already recorded its refusal; there is no SCM to
    # query here.
    return
  }
  foreach ($serviceName in @($script:BrokerServiceName, $script:SignerServiceName)) {
    if ([GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::ServiceExists($serviceName)) {
      Add-RefusalFinding ("The service '{0}' already exists; this recipe never reconfigures an existing service. Run uninstall-broker-coordinator.ps1 first." -f $serviceName)
    }
  }
}

function Test-RecipeFilesystemClean {
  if ($null -eq $script:Paths) {
    return
  }
  if (Test-Path -LiteralPath $script:Paths.ProvisionerDirectory) {
    Add-RefusalFinding ("The install footprint '{0}' already exists; refusing to compose over a pre-existing tree." -f $script:Paths.ProvisionerDirectory)
  }
  foreach ($directory in @(($script:Paths.Drive + "\"), ($script:Paths.Drive + "\ProgramData"), $script:Paths.GoatCitadelDirectory)) {
    if (Test-Path -LiteralPath $directory) {
      try {
        $lease = Get-BrokerCoordinatorDirectoryLease -Path $directory -GoatCitadelLevel:($directory -eq $script:Paths.GoatCitadelDirectory)
        $script:DirectoryLeases.Add($lease)
        if ($directory -eq $script:Paths.GoatCitadelDirectory) { $script:GoatCitadelRootWasPresent = $true }
      }
      catch {
        Add-RefusalFinding $_.Exception.Message
      }
    }
  }
}

# --- Mutating phases (install mode only, after a clean preflight) ------------

function Copy-RecipePinnedImage {
  param(
    [Parameter(Mandatory = $true)][string]$Source,
    [Parameter(Mandatory = $true)][string]$Destination,
    [Parameter(Mandatory = $true)][string]$Sddl
  )
  $inputStream = $null
  $outputStream = $null
  try {
    $inputStream = [System.IO.File]::Open($Source, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
    if ($inputStream.Length -le 0 -or $inputStream.Length -gt $script:MaximumImageBytes) {
      throw "The staged image changed outside the accepted size bound."
    }
    $outputStream = [System.IO.File]::Open($Destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::Read)
    $script:CopiedFiles.Add($Destination)
    # A held source excludes writers; CREATE_NEW refuses any raced destination.
    $buffer = New-Object byte[] 65536
    $total = 0L
    while (($count = $inputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
      $total += $count
      if ($total -gt $script:MaximumImageBytes) { throw "The staged image grew outside the accepted size bound." }
      $outputStream.Write($buffer, 0, $count)
    }
    if ($total -eq 0) { throw "The staged image became empty." }
    $outputStream.Flush($true)
    # Protect before releasing the destination writer, so another caller cannot
    # retain a writable handle across the ACL transition.
    [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::SetFileSddl($Destination, $Sddl)
  }
  finally {
    if ($null -ne $outputStream) { $outputStream.Dispose() }
    if ($null -ne $inputStream) { $inputStream.Dispose() }
  }
  $script:ImageLeases.Add([System.IO.File]::Open($Destination, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read))
}

function Close-RecipeLeases {
  param([switch]$ImagesOnly)
  foreach ($lease in $script:ImageLeases) { $lease.Dispose() }
  $script:ImageLeases.Clear()
  if (-not $ImagesOnly) {
    for ($index = $script:StateLeases.Count - 1; $index -ge 0; $index--) { $script:StateLeases[$index].Dispose() }
    $script:StateLeases.Clear()
    foreach ($lease in $script:CreatedServiceLeases) { $lease.Dispose() }
    $script:CreatedServiceLeases.Clear()
    for ($index = $script:DirectoryLeases.Count - 1; $index -ge 0; $index--) {
      $script:DirectoryLeases[$index].Dispose()
    }
    $script:DirectoryLeases.Clear()
  }
}

function New-RecipeInstallDirectories {
  $native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
  foreach ($directory in @($script:Paths.GoatCitadelDirectory, $script:Paths.ProvisionerDirectory, $script:Paths.BinDirectory)) {
    # Only a root already verified and held during preflight can be reused.
    # A root planted after preflight must fail exclusive creation.
    if ($directory -eq $script:Paths.GoatCitadelDirectory -and $script:GoatCitadelRootWasPresent) { continue }
    $native::CreateProtectedDirectory($directory, $script:SharedRootSddl)
    $script:CreatedDirectories.Add($directory)
    $script:DirectoryLeases.Add((Get-BrokerCoordinatorDirectoryLease -Path $directory -GoatCitadelLevel))
  }
}

function Invoke-RecipeStage {
  $native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
  # SYSTEM ownership is present at creation, before any child is staged.
  $native::EnablePrivilege("SeRestorePrivilege")
  $native::EnablePrivilege("SeTakeOwnershipPrivilege")
  New-RecipeInstallDirectories
  Copy-RecipePinnedImage -Source (Join-Path $StagedTrioDir $script:BrokerExecutableName) -Destination $script:Paths.BrokerImagePath -Sddl $script:BrokerImageSddl
  Copy-RecipePinnedImage -Source (Join-Path $StagedTrioDir $script:SignerExecutableName) -Destination $script:Paths.SignerImagePath -Sddl $script:SignerImageSddl
  Copy-RecipePinnedImage -Source (Join-Path $StagedTrioDir $script:ClientExecutableName) -Destination $script:Paths.ClientImagePath -Sddl $script:ClientImageSddl

  foreach ($image in @(
      @{ Path = $script:Paths.BrokerImagePath; Sha256 = $script:Pins.brokerImageSha256; Sddl = $script:BrokerImageSddl },
      @{ Path = $script:Paths.SignerImagePath; Sha256 = $script:Pins.signerImageSha256; Sddl = $script:SignerImageSddl },
      @{ Path = $script:Paths.ClientImagePath; Sha256 = $script:Pins.clientImageSha256; Sddl = $script:ClientImageSddl })) {
    $destinationHash = Get-BrokerCoordinatorFileSha256 -Path $image.Path
    if (-not [string]::Equals($destinationHash, $image.Sha256, [System.StringComparison]::Ordinal)) {
      throw ("The copied image '{0}' hash '{1}' does not match the pin '{2}'." -f $image.Path, $destinationHash, $image.Sha256)
    }
    $length = (Get-Item -LiteralPath $image.Path).Length
    if ($length -le 0 -or $length -gt $script:MaximumImageBytes) {
      throw ("The copied image '{0}' is {1} bytes; outside the broker's accepted bounds." -f $image.Path, $length)
    }
    $streams = Get-BrokerCoordinatorStreamNames -Path $image.Path
    if ($streams.Count -ne 1 -or $streams[0] -ne ':$DATA') {
      throw ("The copied image '{0}' carries alternate data streams." -f $image.Path)
    }
    $links = $native::GetFileHardLinkCount($image.Path)
    if ($links -ne 1) {
      throw ("The copied image '{0}' has {1} hard links; the broker requires exactly one." -f $image.Path, $links)
    }
  }

  $native::SetFileSddl($script:Paths.BinDirectory, $script:ProtectedDirectorySddl)
  $native::SetFileSddl($script:Paths.ProvisionerDirectory, $script:ProtectedDirectorySddl)
  if ($script:CreatedDirectories -contains $script:Paths.GoatCitadelDirectory) {
    $native::SetFileSddl($script:Paths.GoatCitadelDirectory, $script:SharedRootSddl)
  }
  return "images pinned and protected under " + $script:Paths.BinDirectory
}

function Invoke-RecipeInstallServices {
  $native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
  # Signer first so a mid-failure can never leave a broker installed without
  # its validated target.
  $script:CreatedServiceLeases.Add($native::CreateCoordinatorService($script:SignerServiceName, $script:SignerDisplayName, $script:Paths.SignerQuotedBinaryPath))
  $script:CreatedServices.Add($script:SignerServiceName)
  $native::SetServiceSidTypeUnrestricted($script:SignerServiceName)
  $native::SetServiceRequiredPrivilegesChangeNotify($script:SignerServiceName)
  $native::SetServiceSddl($script:SignerServiceName, $script:SignerServiceObjectSddl)

  $script:CreatedServiceLeases.Add($native::CreateCoordinatorService($script:BrokerServiceName, $script:BrokerDisplayName, $script:Paths.BrokerQuotedBinaryPath))
  $script:CreatedServices.Add($script:BrokerServiceName)
  $native::SetServiceSidTypeUnrestricted($script:BrokerServiceName)
  $native::SetServiceRequiredPrivilegesChangeNotify($script:BrokerServiceName)
  $native::SetServiceSddl($script:BrokerServiceName, $script:ServiceObjectSddl)
  return "coordinator principal materialized as " + $script:CoordinatorPrincipalName
}

function Invoke-RecipeInitializeState {
  $native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
  $native::EnablePrivilege("SeBackupPrivilege")
  $native::EnablePrivilege("SeRestorePrivilege")
  $null = New-BrokerCoordinatorStateLayout -ProvisionerDirectory $script:Paths.ProvisionerDirectory -Leases $script:StateLeases
  return "created and verified empty state-v1, journal, keysets, controls and quarantine with the signer's exact owner, group, DACL and attributes"
}

function Get-ServiceReadBack {
  param(
    [Parameter(Mandatory = $true)][string]$ServiceName,
    [Parameter(Mandatory = $true)][string]$ExpectedQuotedBinaryPath,
    [Parameter(Mandatory = $true)][string]$ExpectedServiceSddl
  )
  $native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
  $configLine = $native::GetServiceConfigLine($ServiceName)
  $config = $configLine -split "\|", 7
  $sidType = $native::GetServiceSidType($ServiceName)
  $privileges = $native::GetServiceRequiredPrivileges($ServiceName)
  $sddl = $native::GetServiceSddl($ServiceName)
  $statusLine = $native::GetServiceStatusLine($ServiceName)
  $status = $statusLine -split "\|"
  $canonicalExpectedSddl = ConvertTo-CanonicalSddl -Sddl $ExpectedServiceSddl

  if ([int]$config[0] -ne $script:ExpectedServiceType) { throw ("Service '{0}' type read back {1}, expected {2} (SERVICE_WIN32_OWN_PROCESS)." -f $ServiceName, $config[0], $script:ExpectedServiceType) }
  if ([int]$config[1] -ne $script:ExpectedStartType) { throw ("Service '{0}' start type read back {1}, expected {2} (SERVICE_DEMAND_START)." -f $ServiceName, $config[1], $script:ExpectedStartType) }
  if ([int]$config[2] -ne $script:ExpectedErrorControl) { throw ("Service '{0}' error control read back {1}, expected {2} (SERVICE_ERROR_NORMAL)." -f $ServiceName, $config[2], $script:ExpectedErrorControl) }
  if (-not [string]::Equals($config[3], $ExpectedQuotedBinaryPath, [System.StringComparison]::Ordinal)) { throw ("Service '{0}' binary path read back '{1}', expected the exact quoted path '{2}'." -f $ServiceName, $config[3], $ExpectedQuotedBinaryPath) }
  if (-not [string]::Equals($config[4], $script:ExpectedServiceAccount, [System.StringComparison]::Ordinal)) { throw ("Service '{0}' account read back '{1}', expected the exact literal '{2}'." -f $ServiceName, $config[4], $script:ExpectedServiceAccount) }
  if ($config[5] -ne "") { throw ("Service '{0}' carries a load-order group; the broker requires none." -f $ServiceName) }
  if ($config[6] -ne "1") { throw ("Service '{0}' carries dependencies; the broker requires none." -f $ServiceName) }
  if ($sidType -ne $script:ExpectedServiceSidType) { throw ("Service '{0}' SID type read back {1}, expected {2} (SERVICE_SID_TYPE_UNRESTRICTED)." -f $ServiceName, $sidType, $script:ExpectedServiceSidType) }
  if (-not [string]::Equals($privileges, $script:ExpectedRequiredPrivilege, [System.StringComparison]::Ordinal)) { throw ("Service '{0}' required privileges read back '{1}', expected exactly '{2}'." -f $ServiceName, $privileges, $script:ExpectedRequiredPrivilege) }
  if (-not [string]::Equals($sddl, $canonicalExpectedSddl, [System.StringComparison]::Ordinal)) { throw ("Service '{0}' SCM security descriptor read back '{1}', expected canonical '{2}'." -f $ServiceName, $sddl, $canonicalExpectedSddl) }
  if ([int]$status[0] -ne $script:ServiceStoppedState) { throw ("Service '{0}' state read back {1}; a production-dark install must leave it SERVICE_STOPPED." -f $ServiceName, $status[0]) }
  if ([int]$status[1] -ne 0) { throw ("Service '{0}' reports process id {1}; a production-dark install must leave no process." -f $ServiceName, $status[1]) }
  if ([int]$status[2] -ne 0) { throw ("Service '{0}' reports service flags {1}; expected 0." -f $ServiceName, $status[2]) }

  return [ordered]@{
    serviceName = $ServiceName
    serviceType = [int]$config[0]
    startType = [int]$config[1]
    errorControl = [int]$config[2]
    binaryPath = $config[3]
    account = $config[4]
    serviceSidType = [int]$sidType
    requiredPrivileges = @($privileges)
    scmSecurityDescriptor = $sddl
    state = [int]$status[0]
    processId = [int]$status[1]
    serviceFlags = [int]$status[2]
    # ERROR_SERVICE_NEVER_STARTED (1077) is the expected value on a service
    # that has never started since boot. The broker permits this only for a
    # stopped signer with no process or failure metadata; active states
    # still require NO_ERROR. Real first-start acceptance remains unproven.
    win32ExitCode = [int]$status[4]
  }
}

function Invoke-RecipeVerify {
  $native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
  $signerReadBack = Get-ServiceReadBack -ServiceName $script:SignerServiceName -ExpectedQuotedBinaryPath $script:Paths.SignerQuotedBinaryPath -ExpectedServiceSddl $script:SignerServiceObjectSddl
  $brokerReadBack = Get-ServiceReadBack -ServiceName $script:BrokerServiceName -ExpectedQuotedBinaryPath $script:Paths.BrokerQuotedBinaryPath -ExpectedServiceSddl $script:ServiceObjectSddl

  $fileReadBack = New-Object System.Collections.Generic.List[object]
  foreach ($entry in @(
      @{ Path = $script:Paths.BrokerImagePath; Sddl = $script:BrokerImageSddl; Sha256 = $script:Pins.brokerImageSha256 },
      @{ Path = $script:Paths.SignerImagePath; Sddl = $script:SignerImageSddl; Sha256 = $script:Pins.signerImageSha256 },
      @{ Path = $script:Paths.ClientImagePath; Sddl = $script:ClientImageSddl; Sha256 = $script:Pins.clientImageSha256 },
      @{ Path = $script:Paths.BinDirectory; Sddl = $script:ProtectedDirectorySddl; Sha256 = $null },
      @{ Path = $script:Paths.ProvisionerDirectory; Sddl = $script:ProtectedDirectorySddl; Sha256 = $null })) {
    $actualSddl = $native::GetFileSddl($entry.Path)
    $canonical = ConvertTo-CanonicalFileSddl -Sddl $entry.Sddl
    if (-not [string]::Equals((ConvertTo-CanonicalFileSddl -Sddl $actualSddl), $canonical, [System.StringComparison]::Ordinal)) {
      throw ("The path '{0}' security descriptor read back '{1}', expected canonical '{2}'." -f $entry.Path, $actualSddl, $canonical)
    }
    $record = [ordered]@{ path = $entry.Path; securityDescriptor = $actualSddl }
    if ($entry.Sha256) {
      $finalHash = Get-BrokerCoordinatorFileSha256 -Path $entry.Path
      if (-not [string]::Equals($finalHash, $entry.Sha256, [System.StringComparison]::Ordinal)) {
        throw ("The pinned image '{0}' drifted after protection: hash '{1}' expected '{2}'." -f $entry.Path, $finalHash, $entry.Sha256)
      }
      $record["sha256"] = $finalHash
    }
    $fileReadBack.Add([pscustomobject]$record)
  }

  $translatedSid = $null
  try {
    $account = New-Object System.Security.Principal.NTAccount($script:CoordinatorPrincipalName)
    $translatedSid = $account.Translate([System.Security.Principal.SecurityIdentifier]).Value
  }
  catch {
    throw ("The coordinator principal '{0}' did not translate to a SID after service creation: {1}" -f $script:CoordinatorPrincipalName, $_.Exception.Message)
  }
  if (-not [string]::Equals($translatedSid, $script:BrokerServiceSid, [System.StringComparison]::Ordinal)) {
    throw ("The OS translated the coordinator principal to '{0}' but the broker binary pins '{1}'; wrong principal." -f $translatedSid, $script:BrokerServiceSid)
  }

  $script:ReadBack = [ordered]@{
    coordinatorPrincipal = [ordered]@{
      name = $script:CoordinatorPrincipalName
      pinnedSid = $script:BrokerServiceSid
      osTranslatedSid = $translatedSid
    }
    broker = [pscustomobject]$brokerReadBack
    signer = [pscustomobject]$signerReadBack
    files = $fileReadBack.ToArray()
    protectedState = Get-BrokerCoordinatorStateReadBack -Leases $script:StateLeases
  }
  return "read-back matched the frozen recipe; both services left SERVICE_STOPPED"
}

function Invoke-RecipeRollback {
  $native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
  Close-RecipeLeases -ImagesOnly
  for ($index = $script:CreatedServices.Count - 1; $index -ge 0; $index--) {
    $serviceName = $script:CreatedServices[$index]
    try {
      $native::RemoveCreatedService($script:CreatedServiceLeases[$index])
    }
    catch {
      $script:CleanupFailures.Add(("rollback: failed to delete service '{0}': {1}" -f $serviceName, $_.Exception.Message))
    }
  }
  if ($script:CleanupFailures.Count -gt 0) {
    $script:CleanupFailures.Add('rollback: preserving installed files because service removal is uncertain')
    return
  }
  Undo-BrokerCoordinatorCreatedState -Leases $script:StateLeases -Failures $script:CleanupFailures
  if ($script:CleanupFailures.Count -gt 0) {
    $script:CleanupFailures.Add('rollback: preserving the install footprint because protected state cleanup is uncertain')
    return
  }
  try {
    $native::EnablePrivilege("SeRestorePrivilege")
    $native::EnablePrivilege("SeTakeOwnershipPrivilege")
  }
  catch {
    $script:CleanupFailures.Add(("rollback: failed to enable restore privileges: {0}" -f $_.Exception.Message))
  }
  for ($index = $script:CopiedFiles.Count - 1; $index -ge 0; $index--) {
    $filePath = $script:CopiedFiles[$index]
    try {
      if (Test-Path -LiteralPath $filePath) {
        $native::SetFileSddl($filePath, $script:UninstallRestoreSddl)
        Remove-Item -LiteralPath $filePath -Force
      }
    }
    catch {
      $script:CleanupFailures.Add(("rollback: failed to remove file '{0}': {1}" -f $filePath, $_.Exception.Message))
    }
  }
  Close-RecipeLeases
  for ($index = $script:CreatedDirectories.Count - 1; $index -ge 0; $index--) {
    $directory = $script:CreatedDirectories[$index]
    try {
      if (Test-Path -LiteralPath $directory) {
        $native::SetFileSddl($directory, $script:UninstallRestoreSddl)
        Remove-Item -LiteralPath $directory -Force
      }
    }
    catch {
      $script:CleanupFailures.Add(("rollback: failed to remove directory '{0}': {1}" -f $directory, $_.Exception.Message))
    }
  }
}

function Write-InstallEvidence {
  $finished = (Get-Date).ToUniversalTime()
  $payload = [ordered]@{
    schema = $script:InstallEvidenceSchema
    mode = $(if ($Preflight) { "preflight" } else { "install" })
    target = $Target
    verdict = $script:Verdict
    startedAt = $script:StartedAt.ToString("o")
    finishedAt = $finished.ToString("o")
    host = [ordered]@{
      machineName = [System.Environment]::MachineName
      osVersion = [System.Environment]::OSVersion.VersionString
      psEdition = $PSVersionTable.PSEdition
      psVersion = $PSVersionTable.PSVersion.ToString()
      elevated = (Test-BrokerCoordinatorElevation)
    }
    recipe = [ordered]@{
      coordinatorPrincipal = $script:CoordinatorPrincipalName
      brokerServiceName = $script:BrokerServiceName
      brokerServiceSid = $script:BrokerServiceSid
      signerServiceName = $script:SignerServiceName
      signerServiceSid = $script:SignerServiceSid
      serviceObjectSddl = $script:ServiceObjectSddl
      signerServiceObjectSddl = $script:SignerServiceObjectSddl
      runtimeWorkerServiceSid = $script:RuntimeWorkerServiceSid
      brokerImageSddl = $script:BrokerImageSddl
      signerImageSddl = $script:SignerImageSddl
      clientImageSddl = $script:ClientImageSddl
      protectedDirectorySddl = $script:ProtectedDirectorySddl
      sharedRootSddl = $script:SharedRootSddl
      serviceType = "SERVICE_WIN32_OWN_PROCESS"
      startType = "SERVICE_DEMAND_START"
      errorControl = "SERVICE_ERROR_NORMAL"
      account = $script:ExpectedServiceAccount
      serviceSidType = "SERVICE_SID_TYPE_UNRESTRICTED"
      requiredPrivileges = @($script:ExpectedRequiredPrivilege)
      neverStartedWin32ExitCode = $script:ServiceNeverStartedExitCode
      startsAnyService = $false
      deploysUntrustedClient = $true
      clientServiceControlRights = "none"
      runtimeWorkerSignerQueryRights = "SERVICE_QUERY_CONFIG | SERVICE_QUERY_STATUS | READ_CONTROL"
      runtimeWorkerBrokerRights = "none"
      protectedStateSddl = $script:ProtectedStateSddl
      protectedStateChildren = $script:ProtectedStateChildren
    }
    paths = $(if ($null -ne $script:Paths) {
      [ordered]@{
        binDirectory = $script:Paths.BinDirectory
        stateDirectory = Join-Path $script:Paths.ProvisionerDirectory 'state-v1'
        brokerImagePath = $script:Paths.BrokerImagePath
        signerImagePath = $script:Paths.SignerImagePath
        clientImagePath = $script:Paths.ClientImagePath
        brokerQuotedBinaryPath = $script:Paths.BrokerQuotedBinaryPath
        signerQuotedBinaryPath = $script:Paths.SignerQuotedBinaryPath
      }
    } else { $null })
    pins = $script:Pins
    refusals = $script:Refusals.ToArray()
    steps = $script:Steps.ToArray()
    readBack = $script:ReadBack
    cleanupFailures = $script:CleanupFailures.ToArray()
  }
  Write-BrokerCoordinatorEvidenceBundle -Payload $payload -Path (Join-Path $script:ResolvedOutputRoot "broker-coordinator-install-evidence.json")
}

# --- Main --------------------------------------------------------------------

if (-not $OutputRoot) {
  $OutputRoot = Join-Path $env:TEMP ("goatcitadel-broker-coordinator-install-" + $script:StartedAt.ToString("yyyyMMdd-HHmmss"))
}
if (Test-Path -LiteralPath $OutputRoot) {
  Write-Error "Refusing to reuse an existing evidence output root: $OutputRoot" -ErrorAction Continue
  exit 2
}
New-Item -ItemType Directory -Path $OutputRoot -Force | Out-Null
$script:ResolvedOutputRoot = (Resolve-Path -LiteralPath $OutputRoot).Path

$exitCode = 1
try {
  try {
    Invoke-RecipeStep -Name "preflight-platform" -Body { Test-RecipePlatform }
    Invoke-RecipeStep -Name "preflight-elevation" -Body { Test-RecipeElevation }
    Invoke-RecipeStep -Name "preflight-system-drive" -Body { Test-RecipeSystemDrive }
    Invoke-RecipeStep -Name "preflight-pins" -Body { Resolve-RecipePins }
    Invoke-RecipeStep -Name "preflight-coordinator-derivation" -Body { Test-RecipeCoordinatorDerivation }
    Invoke-RecipeStep -Name "preflight-staged-trio" -Body { Test-RecipeStagedTrio }
    Invoke-RecipeStep -Name "preflight-scm-clean" -Body { Test-RecipeScmClean }
    Invoke-RecipeStep -Name "preflight-filesystem-clean" -Body { Test-RecipeFilesystemClean }

    if ($Preflight) {
      if ($script:Refusals.Count -gt 0) {
        $script:Verdict = "refused"
        $exitCode = 2
      }
      else {
        $script:Verdict = "passed"
        $exitCode = 0
      }
    }
    else {
      if ($script:Refusals.Count -gt 0) {
        # Unreachable in install mode (Add-RefusalFinding throws), kept as a
        # defensive fence.
        $script:Verdict = "refused"
        $exitCode = 2
      }
      else {
        Invoke-RecipeStep -Name "stage" -Body { Invoke-RecipeStage }
        Invoke-RecipeStep -Name "initialize-protected-state" -Body { Invoke-RecipeInitializeState }
        Invoke-RecipeStep -Name "install-services" -Body { Invoke-RecipeInstallServices }
        Invoke-RecipeStep -Name "verify" -Body { Invoke-RecipeVerify }
        $script:Verdict = "passed"
        $exitCode = 0
      }
    }
  }
  catch {
    $message = $_.Exception.Message
    if ($message -like "REFUSED:*") {
      $script:Verdict = "refused"
      $exitCode = 2
    }
    else {
      $script:Verdict = "failed"
      $exitCode = 1
    }
    if (-not $Preflight -and ($script:CreatedServices.Count -gt 0 -or $script:CopiedFiles.Count -gt 0 -or $script:CreatedDirectories.Count -gt 0)) {
      Invoke-RecipeRollback
    }
    Write-Error $message -ErrorAction Continue
  }
}
finally {
  try { Write-InstallEvidence }
  finally { Close-RecipeLeases }
}

exit $exitCode
