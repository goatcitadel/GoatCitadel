#Requires -Version 5.1
<#
.SYNOPSIS
  Administrator-owned uninstall/rollback for the GoatCitadel remote-worker
  availability-broker coordinator recipe (M2 / HX-501).

.DESCRIPTION
  Reverses install-broker-coordinator.ps1 with the same rigor:

    1. preflight            - READ-ONLY. Refuses (exit 2) when not elevated,
                              not on Windows, the system drive is malformed,
                              or an existing broker/signer service is NOT
                              bound to the pinned quoted image path (a
                              foreign or drifted service is never deleted by
                              name; wrong principal, operator intervenes).
    2. stop-services        - Sends SERVICE_CONTROL_STOP to each installed
                              service (the broker is one-shot; the signer
                              accepts stop) and waits, bounded at 30 seconds,
                              for SERVICE_STOPPED. Never starts anything.
    3. delete-services      - Deletes both service registrations and waits,
                              bounded at 10 seconds, for the SCM to release
                              them (a delete-pending residue is recorded, not
                              hidden).
    4. remove-files         - Restores an administrator-writable descriptor
                              (the frozen protected DACLs are intentionally
                              admin-read-only) and removes the two pinned
                              images, bin\, and RemoteWorkerProvisioner\.
                              GoatCitadel\ is removed only when empty; a
                              shared root with sibling content is preserved.
    5. verify + evidence    - Confirms the services and files are gone and
                              always writes
                              broker-coordinator-uninstall-evidence.json
                              (schema goatcitadel.remote-worker.broker-coordinator-uninstall/1).

  This script never starts a service and never touches the untrusted
  helper/client. Exit codes: 0 = passed, 1 = failed, 2 = refused.

.EXAMPLE
  powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
    -File scripts\remote-worker\uninstall-broker-coordinator.ps1

.EXAMPLE
  # Read-only: report what an uninstall would do and verify identity binding.
  powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
    -File scripts\remote-worker\uninstall-broker-coordinator.ps1 -Preflight
#>
[CmdletBinding()]
param(
  [string]$OutputRoot,

  [switch]$Preflight
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

. (Join-Path $PSScriptRoot "broker-coordinator-common.ps1")

$script:StartedAt = (Get-Date).ToUniversalTime()
$script:Steps = New-Object System.Collections.Generic.List[object]
$script:Refusals = New-Object System.Collections.Generic.List[string]
$script:CleanupFailures = New-Object System.Collections.Generic.List[string]
$script:Paths = $null
$script:Footprint = $null
$script:Verdict = "failed"
$script:StopWaitMilliseconds = 30000
$script:DeleteWaitMilliseconds = 10000

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
  try {
    $detail = & $Body
    if ($null -eq $detail) { $detail = "" }
    Add-StepRecord -Name $Name -Status "passed" -StartedAtUtc $stepStart -Detail ([string]$detail)
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
  param(
    [Parameter(Mandatory = $true)][string]$Message
  )
  $script:Refusals.Add($Message)
  if (-not $Preflight) {
    throw ("REFUSED: {0}" -f $Message)
  }
}

function Test-RecipePlatform {
  if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
    Add-RefusalFinding "This recipe composes Windows service security and only runs on Windows."
    return
  }
  Initialize-BrokerCoordinatorNativeType
}

function Test-RecipeElevation {
  if (-not (Test-BrokerCoordinatorElevation)) {
    Add-RefusalFinding "The uninstaller must run from an elevated administrator context."
  }
}

function Test-RecipeSystemDrive {
  try {
    $script:Paths = Get-BrokerCoordinatorPaths -SystemDrive $env:SystemDrive
  }
  catch {
    Add-RefusalFinding $_.Exception.Message.Replace("REFUSED: ", "")
  }
}

function Test-RecipeFootprintIdentity {
  <#
    READ-ONLY identity binding: a service by the pinned name is deleted only
    when its configured binary path is exactly the pinned quoted image path.
    Anything else is a foreign or drifted registration and is refused.
  #>
  if ($null -eq $script:Paths) {
    return
  }
  if (-not ("GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe" -as [type])) {
    # The platform preflight already recorded its refusal; there is no SCM to
    # query here.
    return
  }
  $native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
  $footprint = [ordered]@{
    brokerServicePresent = $false
    signerServicePresent = $false
    brokerImagePresent = (Test-Path -LiteralPath $script:Paths.BrokerImagePath)
    signerImagePresent = (Test-Path -LiteralPath $script:Paths.SignerImagePath)
    binDirectoryPresent = (Test-Path -LiteralPath $script:Paths.BinDirectory)
    provisionerDirectoryPresent = (Test-Path -LiteralPath $script:Paths.ProvisionerDirectory)
  }
  foreach ($entry in @(
      @{ Name = $script:BrokerServiceName; Quoted = $script:Paths.BrokerQuotedBinaryPath; Key = "brokerServicePresent" },
      @{ Name = $script:SignerServiceName; Quoted = $script:Paths.SignerQuotedBinaryPath; Key = "signerServicePresent" })) {
    if ($native::ServiceExists($entry.Name)) {
      $footprint[$entry.Key] = $true
      $configLine = $native::GetServiceConfigLine($entry.Name)
      $binaryPath = ($configLine -split "\|", 7)[3]
      if (-not [string]::Equals($binaryPath, $entry.Quoted, [System.StringComparison]::Ordinal)) {
        Add-RefusalFinding ("The service '{0}' is bound to '{1}', not the pinned image path '{2}'; refusing to delete a service this recipe did not compose." -f $entry.Name, $binaryPath, $entry.Quoted)
      }
    }
  }
  $script:Footprint = $footprint
}

function Wait-ForServiceStopped {
  param(
    [Parameter(Mandatory = $true)][string]$ServiceName
  )
  $native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
  $deadline = [System.Diagnostics.Stopwatch]::StartNew()
  while ($true) {
    $status = $native::GetServiceStatusLine($ServiceName) -split "\|"
    if ([int]$status[0] -eq $script:ServiceStoppedState) {
      return
    }
    if ($deadline.ElapsedMilliseconds -ge $script:StopWaitMilliseconds) {
      throw ("The service '{0}' did not reach SERVICE_STOPPED within {1} ms (state {2})." -f $ServiceName, $script:StopWaitMilliseconds, $status[0])
    }
    Start-Sleep -Milliseconds 250
  }
}

function Invoke-RecipeStopServices {
  $native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
  $stopped = New-Object System.Collections.Generic.List[string]
  foreach ($serviceName in @($script:BrokerServiceName, $script:SignerServiceName)) {
    if ($native::ServiceExists($serviceName)) {
      $native::StopServiceOnce($serviceName)
      Wait-ForServiceStopped -ServiceName $serviceName
      $stopped.Add($serviceName)
    }
  }
  return "stopped: " + ($stopped -join ", ")
}

function Invoke-RecipeDeleteServices {
  $native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
  $pending = New-Object System.Collections.Generic.List[string]
  foreach ($serviceName in @($script:BrokerServiceName, $script:SignerServiceName)) {
    if ($native::ServiceExists($serviceName)) {
      $native::RemoveService($serviceName)
      $deadline = [System.Diagnostics.Stopwatch]::StartNew()
      while ($native::ServiceExists($serviceName)) {
        if ($deadline.ElapsedMilliseconds -ge $script:DeleteWaitMilliseconds) {
          $pending.Add($serviceName)
          break
        }
        Start-Sleep -Milliseconds 250
      }
    }
  }
  if ($pending.Count -gt 0) {
    return "delete pending (SCM releases on last handle close): " + ($pending -join ", ")
  }
  return "both service registrations removed"
}

function Invoke-RecipeRemoveFiles {
  $native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
  $native::EnablePrivilege("SeRestorePrivilege")
  $native::EnablePrivilege("SeTakeOwnershipPrivilege")
  # Restore an administrator-writable descriptor before deletion: the frozen
  # protected DACLs are intentionally admin-read-only.
  foreach ($path in @(
      $script:Paths.BrokerImagePath,
      $script:Paths.SignerImagePath,
      $script:Paths.BinDirectory,
      $script:Paths.ProvisionerDirectory)) {
    if (Test-Path -LiteralPath $path) {
      $native::SetFileSddl($path, $script:UninstallRestoreSddl)
    }
  }
  foreach ($filePath in @($script:Paths.BrokerImagePath, $script:Paths.SignerImagePath)) {
    if (Test-Path -LiteralPath $filePath) {
      Remove-Item -LiteralPath $filePath -Force
    }
  }
  foreach ($directory in @($script:Paths.BinDirectory, $script:Paths.ProvisionerDirectory)) {
    if (Test-Path -LiteralPath $directory) {
      Remove-Item -LiteralPath $directory -Force
    }
  }
  if (Test-Path -LiteralPath $script:Paths.GoatCitadelDirectory) {
    $children = @(Get-ChildItem -LiteralPath $script:Paths.GoatCitadelDirectory -Force)
    if ($children.Count -eq 0) {
      $native::SetFileSddl($script:Paths.GoatCitadelDirectory, $script:UninstallRestoreSddl)
      Remove-Item -LiteralPath $script:Paths.GoatCitadelDirectory -Force
      return "footprint removed including the empty GoatCitadel root"
    }
    return "footprint removed; GoatCitadel root preserved (contains sibling content)"
  }
  return "footprint removed"
}

function Invoke-RecipeVerifyRemoved {
  $native = [GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]
  $residue = New-Object System.Collections.Generic.List[string]
  foreach ($serviceName in @($script:BrokerServiceName, $script:SignerServiceName)) {
    if ($native::ServiceExists($serviceName)) {
      $residue.Add("service:" + $serviceName)
    }
  }
  foreach ($path in @($script:Paths.BrokerImagePath, $script:Paths.SignerImagePath, $script:Paths.BinDirectory, $script:Paths.ProvisionerDirectory)) {
    if (Test-Path -LiteralPath $path) {
      $residue.Add("path:" + $path)
    }
  }
  if ($residue.Count -gt 0) {
    # A freshly deleted service can remain visible until the SCM releases it;
    # that residue is recorded truthfully rather than masked.
    $script:CleanupFailures.Add("post-uninstall residue: " + ($residue -join ", "))
    return "residue recorded: " + ($residue -join ", ")
  }
  return "no residue: services and footprint are gone"
}

function Write-UninstallEvidence {
  $finished = (Get-Date).ToUniversalTime()
  $payload = [ordered]@{
    schema = $script:UninstallEvidenceSchema
    mode = $(if ($Preflight) { "preflight" } else { "uninstall" })
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
      signerServiceName = $script:SignerServiceName
      uninstallRestoreSddl = $script:UninstallRestoreSddl
      startsAnyService = $false
      deploysUntrustedClient = $false
    }
    paths = $(if ($null -ne $script:Paths) {
      [ordered]@{
        binDirectory = $script:Paths.BinDirectory
        brokerImagePath = $script:Paths.BrokerImagePath
        signerImagePath = $script:Paths.SignerImagePath
      }
    } else { $null })
    footprint = $script:Footprint
    refusals = $script:Refusals.ToArray()
    steps = $script:Steps.ToArray()
    cleanupFailures = $script:CleanupFailures.ToArray()
  }
  Write-BrokerCoordinatorEvidenceBundle -Payload $payload -Path (Join-Path $script:ResolvedOutputRoot "broker-coordinator-uninstall-evidence.json")
}

# --- Main --------------------------------------------------------------------

if (-not $OutputRoot) {
  $OutputRoot = Join-Path $env:TEMP ("goatcitadel-broker-coordinator-uninstall-" + $script:StartedAt.ToString("yyyyMMdd-HHmmss"))
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
    Invoke-RecipeStep -Name "preflight-footprint-identity" -Body { Test-RecipeFootprintIdentity }

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
      Invoke-RecipeStep -Name "stop-services" -Body { Invoke-RecipeStopServices }
      Invoke-RecipeStep -Name "delete-services" -Body { Invoke-RecipeDeleteServices }
      Invoke-RecipeStep -Name "remove-files" -Body { Invoke-RecipeRemoveFiles }
      Invoke-RecipeStep -Name "verify-removed" -Body { Invoke-RecipeVerifyRemoved }
      $script:Verdict = "passed"
      $exitCode = 0
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
    Write-Error $message -ErrorAction Continue
  }
}
finally {
  Write-UninstallEvidence
}

exit $exitCode
