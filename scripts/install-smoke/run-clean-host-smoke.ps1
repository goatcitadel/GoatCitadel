#Requires -Version 5.1
<#
.SYNOPSIS
  One-command clean-host installer lifecycle smoke for GoatCitadel (M9 / GC-P1-09).

.DESCRIPTION
  Runs the full isolated Windows installer journey on a clean VM or clean user
  profile, fail-fast, with per-step evidence and a machine-readable verdict:

    1. preflight                  - READ-ONLY. Refuses (exit 2) when any
                                    GoatCitadel protocol/package identity or
                                    install footprint already exists on the host.
    2. lifecycle-pass-1           - Shared scripts/packaging/smoke-windows-installer.ps1:
                                    install, payload + signature + protocol
                                    registration validation, first desktop launch,
                                    embedded Mission Control, runtime launch +
                                    status, stop, uninstall, deregistration.
    3. lifecycle-pass-2-reinstall - The same shared lifecycle smoke again with a
                                    fresh scratch root: proves reinstall after
                                    uninstall behaves identically.
    4. extended-install           - Wrapper-owned third install; asserts the
                                    goatcitadel:// protocol and uninstall entry
                                    registration is rebound to this install.
    5. extended-restart-journey   - launch --wait, status=ready, stop,
                                    status=stopped, launch --wait again,
                                    status=ready (packaged runtime restart).
    6. extended-single-instance   - Starts the installed desktop host twice; the
                                    second instance must redirect activation and
                                    exit while exactly one host process remains.
    7. extended-stop-and-uninstall- Stops everything, uninstalls, and asserts the
                                    protocol key, uninstall entry, package
                                    identity, and immutable payload are gone.

  The wrapper is read-only until its preflight passes: before the preflight
  verdict the only writes are its own evidence files under -OutputRoot. The
  evidence bundle (clean-host-smoke-verdict.json plus logs/) is always
  preserved, including on failure.

  Exit codes: 0 = passed, 1 = failed, 2 = preflight refused (host not clean).

.EXAMPLE
  powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
    -File scripts\install-smoke\run-clean-host-smoke.ps1 `
    -InstallerPath artifacts\installers\windows\GoatCitadel-Setup-windows-x64.exe `
    -ReleaseManifestPath artifacts\installers\bundles\GoatCitadel-<version>-windows-x64\app\release-manifest.json `
    -Target windows-x64 -TrustMode unsigned

.EXAMPLE
  # Prove the preflight refuses on a non-clean host without touching anything.
  powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass `
    -File scripts\install-smoke\run-clean-host-smoke.ps1 -PreflightOnly
#>
[CmdletBinding()]
param(
  [string]$InstallerPath,

  [string]$ReleaseManifestPath,

  [ValidateSet("windows-x64", "windows-arm64")]
  [string]$Target,

  [ValidateSet("signed", "unsigned")]
  [string]$TrustMode = "unsigned",

  [string]$OutputRoot,

  [string]$PackagingScriptsDir,

  [int]$LifecyclePassTimeoutSeconds = 5400,

  [switch]$PreflightOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# --- Identity signal constants (must stay aligned with the installer builder) ---
$script:ProtocolClassKeys = @(
  "Registry::HKEY_CURRENT_USER\Software\Classes\goatcitadel",
  "Registry::HKEY_LOCAL_MACHINE\Software\Classes\goatcitadel",
  "Registry::HKEY_CLASSES_ROOT\goatcitadel"
)
$script:AppxIdentityName = "GoatCitadel.MissionControl.Windows"
$script:InnoAppIdPrefix = "com.goatcitadel.installer."
$script:UninstallRegistryRoots = @(
  "Registry::HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\Uninstall",
  "Registry::HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\Uninstall",
  "Registry::HKEY_LOCAL_MACHINE\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall"
)
$script:DefaultInstallDir = Join-Path $env:LOCALAPPDATA "GoatCitadel"
$script:DefaultOperatorHome = Join-Path $env:USERPROFILE ".GoatCitadel"
$script:InstallMarkerName = ".goatcitadel-install"

# --- Run state ---
$script:StartedAt = (Get-Date).ToUniversalTime()
$script:Steps = New-Object System.Collections.Generic.List[object]
$script:CleanupFailures = New-Object System.Collections.Generic.List[string]
$script:InstallerEvidence = $null
$script:ManifestEvidence = $null
$script:ExtendedInstalled = $false
$script:ExtendedUninstalled = $false
$script:TranscriptStarted = $false

$previousGoatCitadelHome = [Environment]::GetEnvironmentVariable("GOATCITADEL_HOME", "Process")
$previousGoatCitadelAppDir = [Environment]::GetEnvironmentVariable("GOATCITADEL_APP_DIR", "Process")
$previousWebViewDataFolder = [Environment]::GetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", "Process")
$previousDesktopLauncher = [Environment]::GetEnvironmentVariable("GOATCITADEL_DESKTOP_LAUNCHER", "Process")
$previousGatewayUrl = [Environment]::GetEnvironmentVariable("GOATCITADEL_GATEWAY_URL", "Process")
$previousMissionControlUrl = [Environment]::GetEnvironmentVariable("GOATCITADEL_MISSION_CONTROL_URL", "Process")

function Restore-ProcessEnvironmentVariable {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    $PreviousValue
  )
  if ($null -eq $PreviousValue) {
    Remove-Item -Path ("Env:{0}" -f $Name) -ErrorAction SilentlyContinue
  }
  else {
    Set-Item -Path ("Env:{0}" -f $Name) -Value $PreviousValue
  }
}

function Invoke-ProcessTreeKill {
  param([Parameter(Mandatory = $true)][int]$ProcessId)
  # Windows PowerShell 5.1 can convert native stderr into a terminating error
  # under $ErrorActionPreference = "Stop"; the target may also already be gone.
  $previousPreference = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    & taskkill.exe /PID $ProcessId /T /F 2>$null | Out-Null
  }
  finally {
    $ErrorActionPreference = $previousPreference
  }
}

function Add-StepRecord {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][ValidateSet("passed", "failed", "refused")][string]$Status,
    [Parameter(Mandatory = $true)][datetime]$StartedAtUtc,
    [string]$Detail = "",
    [string[]]$Logs = @()
  )
  $finished = (Get-Date).ToUniversalTime()
  $record = [ordered]@{
    name = $Name
    status = $Status
    startedAt = $StartedAtUtc.ToString("o")
    finishedAt = $finished.ToString("o")
    durationSeconds = [Math]::Round(($finished - $StartedAtUtc).TotalSeconds, 1)
    detail = $Detail
    logs = @($Logs)
  }
  $script:Steps.Add([pscustomobject]$record)
}

function Invoke-SmokeStep {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][scriptblock]$Action,
    [string[]]$Logs = @()
  )
  Write-Host ("=== clean-host smoke step: {0} ===" -f $Name)
  $stepStartedAt = (Get-Date).ToUniversalTime()
  try {
    $output = & $Action
    $detail = (@($output) | Where-Object { $_ -is [string] }) -join " | "
    Add-StepRecord -Name $Name -Status "passed" -StartedAtUtc $stepStartedAt -Detail $detail -Logs $Logs
    Write-Host ("--- step {0} passed ---" -f $Name)
  }
  catch {
    Add-StepRecord -Name $Name -Status "failed" -StartedAtUtc $stepStartedAt -Detail $_.Exception.Message -Logs $Logs
    throw
  }
}

function Write-SmokeVerdict {
  param(
    [Parameter(Mandatory = $true)][ValidateSet("passed", "failed", "refused")][string]$Verdict,
    [string]$Failure = $null
  )
  $hostEvidence = [ordered]@{
    computerName = $env:COMPUTERNAME
    userName = $env:USERNAME
    osVersion = [string][Environment]::OSVersion.VersionString
    powershellVersion = [string]$PSVersionTable.PSVersion
  }
  $payload = [ordered]@{
    schema = "goatcitadel.clean-host-installer-smoke/1"
    verdict = $Verdict
    startedAt = $script:StartedAt.ToString("o")
    finishedAt = (Get-Date).ToUniversalTime().ToString("o")
    hostContext = $hostEvidence
    parameters = [ordered]@{
      target = $Target
      trustMode = $TrustMode
      preflightOnly = [bool]$PreflightOnly
      outputRoot = $script:ResolvedOutputRoot
    }
    installer = $script:InstallerEvidence
    releaseManifest = $script:ManifestEvidence
    # ToArray(): Windows PowerShell 5.1's ConvertTo-Json rejects a List[object]
    # enumerated via @() inside a nested dictionary ("Argument types do not match").
    steps = $script:Steps.ToArray()
    cleanupFailures = $script:CleanupFailures.ToArray()
    failure = $Failure
  }
  $json = ConvertTo-Json -InputObject $payload -Depth 8
  [System.IO.File]::WriteAllText(
    $script:VerdictPath,
    $json + "`n",
    [System.Text.UTF8Encoding]::new($false)
  )
  Write-Host ("Verdict '{0}' written to {1}" -f $Verdict, $script:VerdictPath)
}

function Get-InnoUninstallEntries {
  $entries = @()
  foreach ($root in $script:UninstallRegistryRoots) {
    $children = @(Get-ChildItem -Path $root -ErrorAction SilentlyContinue)
    foreach ($child in $children) {
      $displayName = ""
      try {
        $displayName = [string]$child.GetValue("DisplayName")
      }
      catch {
        $displayName = ""
      }
      $matchesAppId = $child.PSChildName -like ($script:InnoAppIdPrefix + "*")
      $matchesDisplayName = $displayName -like "GoatCitadel*"
      if ($matchesAppId -or $matchesDisplayName) {
        $entries += ("{0}\{1} (DisplayName='{2}')" -f $root, $child.PSChildName, $displayName)
      }
    }
  }
  return @($entries)
}

function Get-GoatCitadelRunningProcesses {
  $processes = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $byName = $_.Name -like "GoatCitadel*"
        $byPath = $false
        if ($_.ExecutablePath) {
          $byPath = $_.ExecutablePath -match "(?i)[\\/]GoatCitadel[\\/]"
        }
        $byName -or $byPath
      }
  )
  return @($processes)
}

function Get-GoatCitadelIdentityFindings {
  # READ-ONLY: every check below only queries registry, filesystem, package, and
  # process state. Nothing on the host is created, changed, or removed here.
  $findings = @()

  foreach ($key in $script:ProtocolClassKeys) {
    if (Test-Path -LiteralPath $key) {
      $findings += ("goatcitadel:// protocol registration exists at {0}" -f $key)
    }
  }

  $appxPackage = $null
  try {
    $appxPackage = Get-AppxPackage $script:AppxIdentityName -ErrorAction Stop | Select-Object -First 1
  }
  catch {
    Write-Host ("Preflight note: Get-AppxPackage unavailable ({0}); package identity check skipped." -f $_.Exception.Message)
  }
  if ($appxPackage) {
    $findings += ("GoatCitadel package identity '{0}' is registered ({1})" -f $script:AppxIdentityName, $appxPackage.PackageFullName)
  }

  foreach ($entry in (Get-InnoUninstallEntries)) {
    $findings += ("Installer uninstall registration exists: {0}" -f $entry)
  }

  if (Test-Path -LiteralPath $script:DefaultInstallDir) {
    $signals = @()
    if (Test-Path -LiteralPath (Join-Path $script:DefaultInstallDir $script:InstallMarkerName)) {
      $signals += $script:InstallMarkerName
    }
    if (Test-Path -LiteralPath (Join-Path $script:DefaultInstallDir "unins000.exe")) {
      $signals += "unins000.exe"
    }
    if (Test-Path -LiteralPath (Join-Path $script:DefaultInstallDir "app\desktop\GoatCitadel-Mission-Control-Windows.exe")) {
      $signals += "app\desktop host"
    }
    $signalSummary = "directory present"
    if ($signals.Count -gt 0) {
      $signalSummary = "contains " + ($signals -join ", ")
    }
    $findings += ("Default install directory exists at {0} ({1})" -f $script:DefaultInstallDir, $signalSummary)
  }

  if (Test-Path -LiteralPath $script:DefaultOperatorHome) {
    $findings += ("Operator home exists at {0}" -f $script:DefaultOperatorHome)
  }

  foreach ($scope in @("Process", "User", "Machine")) {
    $homeOverride = [Environment]::GetEnvironmentVariable("GOATCITADEL_HOME", $scope)
    if (-not [string]::IsNullOrWhiteSpace($homeOverride)) {
      $findings += ("GOATCITADEL_HOME is set at {0} scope ({1})" -f $scope, $homeOverride)
    }
  }

  foreach ($processInfo in (Get-GoatCitadelRunningProcesses)) {
    $findings += ("GoatCitadel process is running: PID {0} {1} ({2})" -f $processInfo.ProcessId, $processInfo.Name, $processInfo.ExecutablePath)
  }

  return @($findings)
}

function Invoke-CapturedProcess {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [Parameter(Mandatory = $true)][string]$Arguments,
    [string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$StdoutPath,
    [Parameter(Mandatory = $true)][string]$StderrPath,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )
  # Windows PowerShell 5.1 loses the owned handle (and ExitCode) when
  # Start-Process redirects output, so own the Process and drain both streams
  # asynchronously; mirrors scripts/packaging/smoke-windows-installer.ps1.
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $FilePath
  $startInfo.Arguments = $Arguments
  if (-not [string]::IsNullOrWhiteSpace($WorkingDirectory)) {
    $startInfo.WorkingDirectory = $WorkingDirectory
  }
  $startInfo.UseShellExecute = $false
  $startInfo.CreateNoWindow = $true
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true

  $process = [System.Diagnostics.Process]::new()
  $process.StartInfo = $startInfo
  [void]$process.Start()
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  $exited = $process.WaitForExit($TimeoutSeconds * 1000)
  if (-not $exited) {
    Invoke-ProcessTreeKill -ProcessId $process.Id
  }
  $process.WaitForExit()
  $utf8NoBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($StdoutPath, $stdoutTask.Result, $utf8NoBom)
  [System.IO.File]::WriteAllText($StderrPath, $stderrTask.Result, $utf8NoBom)
  return [pscustomobject]@{
    ExitCode = $process.ExitCode
    TimedOut = (-not $exited)
    StdoutPath = $StdoutPath
    StderrPath = $StderrPath
  }
}

function Write-LogTail {
  param(
    [Parameter(Mandatory = $true)][string]$Path,
    [int]$Lines = 40
  )
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    Write-Host ("----- tail of {0} -----" -f (Split-Path $Path -Leaf))
    Get-Content -LiteralPath $Path -Tail $Lines -ErrorAction SilentlyContinue | ForEach-Object { Write-Host $_ }
  }
}

function Get-LastJsonLine {
  param([Parameter(Mandatory = $true)][string]$Path)
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    return $null
  }
  $line = Get-Content -LiteralPath $Path -ErrorAction SilentlyContinue |
    Where-Object { $_.TrimStart().StartsWith("{") } |
    Select-Object -Last 1
  if ([string]::IsNullOrWhiteSpace($line)) {
    return $null
  }
  return ($line | ConvertFrom-Json)
}

function Invoke-PackagedLauncher {
  param(
    [Parameter(Mandatory = $true)][string]$CommandLine,
    [Parameter(Mandatory = $true)][string]$LogBaseName,
    [Parameter(Mandatory = $true)][int]$TimeoutSeconds
  )
  $stdoutPath = Join-Path $script:LogsDir ($LogBaseName + ".stdout.log")
  $stderrPath = Join-Path $script:LogsDir ($LogBaseName + ".stderr.log")
  $arguments = ('"{0}" {1}' -f $script:ExtendedLauncher, $CommandLine)
  $result = Invoke-CapturedProcess `
    -FilePath $script:ExtendedBundledNode `
    -Arguments $arguments `
    -WorkingDirectory $script:ExtendedAppHome `
    -StdoutPath $stdoutPath `
    -StderrPath $stderrPath `
    -TimeoutSeconds $TimeoutSeconds
  if ($result.TimedOut) {
    Write-LogTail -Path $stderrPath
    throw ("Packaged launcher '{0}' did not exit within {1}s." -f $CommandLine, $TimeoutSeconds)
  }
  if ($result.ExitCode -ne 0) {
    Write-LogTail -Path $stdoutPath
    Write-LogTail -Path $stderrPath
    throw ("Packaged launcher '{0}' exited {1}." -f $CommandLine, $result.ExitCode)
  }
  return (Get-LastJsonLine -Path $stdoutPath)
}

function Assert-RuntimeStatusState {
  param(
    $StatusResult,
    [Parameter(Mandatory = $true)][string]$ExpectedState,
    [Parameter(Mandatory = $true)][string]$Context
  )
  if ($null -eq $StatusResult) {
    throw ("{0} did not produce a JSON status line." -f $Context)
  }
  if ($ExpectedState -eq "ready") {
    if ($StatusResult.status -ne "ready" -or -not ($StatusResult.readiness.gateway -and $StatusResult.readiness.ui)) {
      throw ("{0} expected status=ready with gateway and ui healthy; got status='{1}'." -f $Context, $StatusResult.status)
    }
    return
  }
  if ($StatusResult.status -ne $ExpectedState) {
    throw ("{0} expected status={1}; got status='{2}'." -f $Context, $ExpectedState, $StatusResult.status)
  }
}

function Get-ExtendedInstalledProcesses {
  $prefix = $script:ExtendedInstallPrefix
  $processes = @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
      }
  )
  return @($processes)
}

function Stop-ExtendedInstalledProcesses {
  if ((Test-Path -LiteralPath $script:ExtendedBundledNode -PathType Leaf) -and
      (Test-Path -LiteralPath $script:ExtendedLauncher -PathType Leaf)) {
    try {
      [void](Invoke-PackagedLauncher -CommandLine "stop --json" -LogBaseName "extended-backstop-stop" -TimeoutSeconds 120)
    }
    catch {
      Write-Warning ("Backstop launcher stop failed: {0}" -f $_.Exception.Message)
    }
  }
  foreach ($processInfo in (Get-ExtendedInstalledProcesses)) {
    Write-Host ("Backstop kill under extended install: PID {0} {1} ({2})" -f $processInfo.ProcessId, $processInfo.Name, $processInfo.ExecutablePath)
    Invoke-ProcessTreeKill -ProcessId $processInfo.ProcessId
  }
  $deadline = (Get-Date).AddSeconds(20)
  do {
    $remaining = @(Get-ExtendedInstalledProcesses)
    if ($remaining.Count -eq 0) {
      return
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $deadline)
  $summary = ($remaining | ForEach-Object { "PID $($_.ProcessId) $($_.Name)" }) -join "; "
  throw ("Extended install process teardown did not complete within 20 seconds: {0}" -f $summary)
}

function Remove-ExtendedProtocolRegistrationIfOwned {
  # Remove the goatcitadel protocol key only when it is bound to the wrapper's
  # own extended install; never delete a registration this run does not own.
  $protocolKey = $script:ProtocolClassKeys[0]
  $commandKey = Join-Path $protocolKey "shell\open\command"
  if (-not (Test-Path -LiteralPath $protocolKey)) {
    return
  }
  $boundCommand = $null
  if (Test-Path -LiteralPath $commandKey) {
    $boundCommand = (Get-Item -LiteralPath $commandKey -ErrorAction Stop).GetValue("")
  }
  if ([string]::Equals($boundCommand, $script:ExtendedProtocolCommand, [System.StringComparison]::OrdinalIgnoreCase)) {
    Remove-Item -LiteralPath $protocolKey -Recurse -Force -ErrorAction Stop
  }
  else {
    $script:CleanupFailures.Add("Refused to remove a goatcitadel protocol registration not bound to the extended smoke install.")
  }
}

function Invoke-SharedLifecyclePass {
  param(
    [Parameter(Mandatory = $true)][string]$PassName
  )
  $passScratchRoot = Join-Path $script:ResolvedOutputRoot $PassName
  New-Item -ItemType Directory -Path $passScratchRoot -ErrorAction Stop | Out-Null
  $stdoutPath = Join-Path $script:LogsDir ($PassName + ".stdout.log")
  $stderrPath = Join-Path $script:LogsDir ($PassName + ".stderr.log")
  $psHostPath = (Get-Process -Id $PID).Path
  $arguments = ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "{0}" -InstallerPath "{1}" -ExpectedReleaseManifestPath "{2}" -Target {3} -TrustMode {4} -ScratchRoot "{5}"' -f `
      $script:SharedSmokeScript, $script:ResolvedInstallerPath, $script:ResolvedManifestPath, $Target, $TrustMode, $passScratchRoot)
  Write-Host ("Delegating {0} to the shared installer lifecycle smoke (log: {1})" -f $PassName, $stdoutPath)
  $result = Invoke-CapturedProcess `
    -FilePath $psHostPath `
    -Arguments $arguments `
    -WorkingDirectory $script:ResolvedOutputRoot `
    -StdoutPath $stdoutPath `
    -StderrPath $stderrPath `
    -TimeoutSeconds $LifecyclePassTimeoutSeconds
  Write-LogTail -Path $stdoutPath -Lines 12
  if ($result.TimedOut) {
    Write-LogTail -Path $stderrPath -Lines 80
    throw ("Shared installer lifecycle smoke {0} did not exit within {1}s." -f $PassName, $LifecyclePassTimeoutSeconds)
  }
  if ($result.ExitCode -ne 0) {
    Write-LogTail -Path $stderrPath -Lines 80
    throw ("Shared installer lifecycle smoke {0} failed with exit code {1}; see {2}" -f $PassName, $result.ExitCode, $stderrPath)
  }
  return ("shared lifecycle smoke {0} passed" -f $PassName)
}

# --- Parameter validation and evidence layout ---
if (-not $PreflightOnly) {
  if ([string]::IsNullOrWhiteSpace($InstallerPath)) {
    throw "-InstallerPath is required unless -PreflightOnly is set."
  }
  if ([string]::IsNullOrWhiteSpace($ReleaseManifestPath)) {
    throw "-ReleaseManifestPath is required unless -PreflightOnly is set."
  }
  if ([string]::IsNullOrWhiteSpace($Target)) {
    throw "-Target is required unless -PreflightOnly is set."
  }
}

if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $OutputRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("GoatCitadel-clean-host-smoke-" + (Get-Date -Format "yyyyMMdd-HHmmss"))
}
$script:ResolvedOutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
if (Test-Path -LiteralPath $script:ResolvedOutputRoot) {
  throw ("Refusing to reuse an existing evidence output root: {0}" -f $script:ResolvedOutputRoot)
}
New-Item -ItemType Directory -Path $script:ResolvedOutputRoot -ErrorAction Stop | Out-Null
$script:LogsDir = Join-Path $script:ResolvedOutputRoot "logs"
New-Item -ItemType Directory -Path $script:LogsDir -ErrorAction Stop | Out-Null
$script:VerdictPath = Join-Path $script:ResolvedOutputRoot "clean-host-smoke-verdict.json"

if ([string]::IsNullOrWhiteSpace($PackagingScriptsDir)) {
  $PackagingScriptsDir = Join-Path $PSScriptRoot "..\packaging"
}
$script:SharedSmokeScript = [System.IO.Path]::GetFullPath((Join-Path $PackagingScriptsDir "smoke-windows-installer.ps1"))
$sharedPayloadValidator = [System.IO.Path]::GetFullPath((Join-Path $PackagingScriptsDir "validate-windows-bundle.ps1"))

$script:ResolvedInstallerPath = $null
$script:ResolvedManifestPath = $null
if (-not $PreflightOnly) {
  foreach ($required in @($script:SharedSmokeScript, $sharedPayloadValidator)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
      throw ("Required shared packaging script was not found at {0}. Copy scripts/packaging alongside scripts/install-smoke or pass -PackagingScriptsDir." -f $required)
    }
  }
  $script:ResolvedInstallerPath = (Resolve-Path -LiteralPath $InstallerPath -ErrorAction Stop).Path
  $script:ResolvedManifestPath = (Resolve-Path -LiteralPath $ReleaseManifestPath -ErrorAction Stop).Path
  $script:InstallerEvidence = [ordered]@{
    path = $script:ResolvedInstallerPath
    sha256 = (Get-FileHash -LiteralPath $script:ResolvedInstallerPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
  $script:ManifestEvidence = [ordered]@{
    path = $script:ResolvedManifestPath
    sha256 = (Get-FileHash -LiteralPath $script:ResolvedManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  }
}

# --- Extended pass layout (only used after both shared lifecycle passes) ---
$script:ExtendedRoot = Join-Path $script:ResolvedOutputRoot "extended"
$script:ExtendedInstallDir = Join-Path $script:ExtendedRoot "install"
$script:ExtendedInstallPrefix = $script:ExtendedInstallDir.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$script:ExtendedRuntimeHome = Join-Path $script:ExtendedRoot "runtime"
$script:ExtendedWebViewDataDir = Join-Path $script:ExtendedRoot "webview2"
$script:ExtendedAppHome = Join-Path $script:ExtendedInstallDir "app"
$script:ExtendedDesktopExe = Join-Path $script:ExtendedInstallDir "app\desktop\GoatCitadel-Mission-Control-Windows.exe"
$script:ExtendedBundledNode = Join-Path $script:ExtendedInstallDir "app\runtime\node\node.exe"
$script:ExtendedLauncher = Join-Path $script:ExtendedInstallDir "app\bin\goatcitadel.mjs"
$script:ExtendedUninstaller = Join-Path $script:ExtendedInstallDir "unins000.exe"
$script:ExtendedProtocolCommand = ('"{0}" "%1"' -f $script:ExtendedDesktopExe)

$exitCode = 1
try {
  try {
    Start-Transcript -Path (Join-Path $script:LogsDir "clean-host-smoke.transcript.log") | Out-Null
    $script:TranscriptStarted = $true
  }
  catch {
    Write-Warning ("Transcript capture unavailable: {0}" -f $_.Exception.Message)
  }

  Write-Host ("GoatCitadel clean-host installer smoke starting at {0} (evidence: {1})" -f $script:StartedAt.ToString("o"), $script:ResolvedOutputRoot)

  # Step 1: preflight (read-only; refuses on any GoatCitadel identity signal).
  $preflightStartedAt = (Get-Date).ToUniversalTime()
  $preflightLog = Join-Path $script:LogsDir "preflight.findings.log"
  $findings = Get-GoatCitadelIdentityFindings
  $findingLines = @("Preflight identity findings: " + $findings.Count) + @($findings)
  [System.IO.File]::WriteAllLines($preflightLog, [string[]]$findingLines)
  foreach ($finding in $findings) {
    Write-Host ("PREFLIGHT FINDING: {0}" -f $finding)
  }
  if ($findings.Count -gt 0) {
    Add-StepRecord -Name "preflight" -Status "refused" -StartedAtUtc $preflightStartedAt `
      -Detail ("Host is not clean: {0} GoatCitadel identity signal(s) found. Nothing was modified." -f $findings.Count) `
      -Logs @("logs/preflight.findings.log")
    Write-SmokeVerdict -Verdict "refused" -Failure "Preflight refused: existing GoatCitadel protocol/package identity or install footprint detected."
    Write-Host "Preflight REFUSED: this host already carries GoatCitadel identity. Run on a clean VM or clean user profile."
    $exitCode = 2
    exit 2
  }
  Add-StepRecord -Name "preflight" -Status "passed" -StartedAtUtc $preflightStartedAt `
    -Detail "No GoatCitadel protocol, package identity, install footprint, or runtime processes found." `
    -Logs @("logs/preflight.findings.log")
  Write-Host "Preflight passed: host is clean."

  if ($PreflightOnly) {
    Write-SmokeVerdict -Verdict "passed"
    $exitCode = 0
    exit 0
  }

  # Steps 2-3: full lifecycle via the shared installer smoke, then again to
  # prove reinstall-after-uninstall. Each pass owns install through uninstall,
  # signature/identity validation, protocol registration binding, first desktop
  # launch, embedded Mission Control, runtime readiness, and deregistration.
  Invoke-SmokeStep -Name "lifecycle-pass-1" -Logs @("logs/pass1.stdout.log", "logs/pass1.stderr.log") -Action {
    Invoke-SharedLifecyclePass -PassName "pass1"
  }
  Invoke-SmokeStep -Name "lifecycle-pass-2-reinstall" -Logs @("logs/pass2.stdout.log", "logs/pass2.stderr.log") -Action {
    Invoke-SharedLifecyclePass -PassName "pass2"
  }

  # Steps 4-7: wrapper-owned extended journeys the shared smoke does not cover.
  $env:GOATCITADEL_HOME = $script:ExtendedRuntimeHome
  $env:GOATCITADEL_APP_DIR = $script:ExtendedAppHome
  $env:WEBVIEW2_USER_DATA_FOLDER = $script:ExtendedWebViewDataDir
  Remove-Item Env:GOATCITADEL_DESKTOP_LAUNCHER -ErrorAction SilentlyContinue
  Remove-Item Env:GOATCITADEL_GATEWAY_URL -ErrorAction SilentlyContinue
  Remove-Item Env:GOATCITADEL_MISSION_CONTROL_URL -ErrorAction SilentlyContinue

  Invoke-SmokeStep -Name "extended-install" -Action {
    New-Item -ItemType Directory -Path $script:ExtendedRoot -ErrorAction Stop | Out-Null
    $install = Start-Process -FilePath $script:ResolvedInstallerPath -ArgumentList @(
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART",
      "/DIR=`"$($script:ExtendedInstallDir)`""
    ) -Wait -PassThru
    if ($install.ExitCode -ne 0) {
      throw ("Extended reinstall exited with {0}" -f $install.ExitCode)
    }
    $script:ExtendedInstalled = $true
    if (-not (Test-Path -LiteralPath $script:ExtendedDesktopExe -PathType Leaf)) {
      throw ("Extended install did not place the desktop host at {0}" -f $script:ExtendedDesktopExe)
    }
    $protocolKey = $script:ProtocolClassKeys[0]
    $commandKey = Join-Path $protocolKey "shell\open\command"
    if (-not (Test-Path -LiteralPath $commandKey)) {
      throw "Extended install did not register the goatcitadel protocol command."
    }
    $boundCommand = (Get-Item -LiteralPath $commandKey -ErrorAction Stop).GetValue("")
    if (-not [string]::Equals($boundCommand, $script:ExtendedProtocolCommand, [System.StringComparison]::OrdinalIgnoreCase)) {
      throw ("Extended install protocol command '{0}' is not bound to this install's desktop executable." -f $boundCommand)
    }
    $uninstallEntries = @(Get-InnoUninstallEntries)
    if ($uninstallEntries.Count -eq 0) {
      throw "Extended install did not register an uninstall entry."
    }
    return "extended reinstall registered the protocol handler and uninstall entry"
  }

  Invoke-SmokeStep -Name "extended-restart-journey" -Logs @(
    "logs/extended-launch-1.stdout.log",
    "logs/extended-status-1.stdout.log",
    "logs/extended-stop-1.stdout.log",
    "logs/extended-status-2.stdout.log",
    "logs/extended-launch-2.stdout.log",
    "logs/extended-status-3.stdout.log"
  ) -Action {
    if (-not (Test-Path -LiteralPath $script:ExtendedBundledNode -PathType Leaf)) {
      throw ("Bundled Node runtime was not installed at {0}" -f $script:ExtendedBundledNode)
    }
    if (-not (Test-Path -LiteralPath $script:ExtendedLauncher -PathType Leaf)) {
      throw ("Launcher was not installed at {0}" -f $script:ExtendedLauncher)
    }
    [void](Invoke-PackagedLauncher -CommandLine "launch --no-open --wait --json" -LogBaseName "extended-launch-1" -TimeoutSeconds 900)
    $statusReady = Invoke-PackagedLauncher -CommandLine "status --json" -LogBaseName "extended-status-1" -TimeoutSeconds 120
    Assert-RuntimeStatusState -StatusResult $statusReady -ExpectedState "ready" -Context "First packaged status"

    $stopResult = Invoke-PackagedLauncher -CommandLine "stop --json" -LogBaseName "extended-stop-1" -TimeoutSeconds 180
    Assert-RuntimeStatusState -StatusResult $stopResult -ExpectedState "stopped" -Context "Packaged stop"
    $statusStopped = Invoke-PackagedLauncher -CommandLine "status --json" -LogBaseName "extended-status-2" -TimeoutSeconds 120
    Assert-RuntimeStatusState -StatusResult $statusStopped -ExpectedState "stopped" -Context "Post-stop status"

    [void](Invoke-PackagedLauncher -CommandLine "launch --no-open --wait --json" -LogBaseName "extended-launch-2" -TimeoutSeconds 900)
    $statusRestarted = Invoke-PackagedLauncher -CommandLine "status --json" -LogBaseName "extended-status-3" -TimeoutSeconds 120
    Assert-RuntimeStatusState -StatusResult $statusRestarted -ExpectedState "ready" -Context "Post-restart status"
    return "packaged runtime restart journey passed (ready -> stopped -> ready)"
  }

  Invoke-SmokeStep -Name "extended-single-instance" -Action {
    $desktopDir = Split-Path -Parent $script:ExtendedDesktopExe
    $firstInstance = Start-Process -FilePath $script:ExtendedDesktopExe -WorkingDirectory $desktopDir -PassThru
    if (-not $firstInstance) {
      throw ("Failed to start the desktop host at {0}" -f $script:ExtendedDesktopExe)
    }
    try {
      $windowDeadline = (Get-Date).AddSeconds(90)
      $windowPresented = $false
      while ((Get-Date) -lt $windowDeadline) {
        $firstInstance.Refresh()
        if ($firstInstance.HasExited) {
          $hex = "0x{0:X8}" -f $firstInstance.ExitCode
          throw ("Primary desktop host exited with {0} before presenting a window." -f $hex)
        }
        if ($firstInstance.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($firstInstance.MainWindowTitle)) {
          $windowPresented = $true
          Write-Host ("Primary desktop host presented window '{0}' (PID {1})." -f $firstInstance.MainWindowTitle, $firstInstance.Id)
          break
        }
        Start-Sleep -Milliseconds 500
      }
      if (-not $windowPresented) {
        throw "Primary desktop host did not present a window within 90s."
      }

      $secondInstance = Start-Process -FilePath $script:ExtendedDesktopExe -WorkingDirectory $desktopDir -PassThru
      if (-not $secondInstance) {
        throw "Failed to start the second desktop host instance."
      }
      $redirectDeadline = (Get-Date).AddSeconds(45)
      while ((Get-Date) -lt $redirectDeadline) {
        $secondInstance.Refresh()
        if ($secondInstance.HasExited) {
          break
        }
        Start-Sleep -Milliseconds 250
      }
      if (-not $secondInstance.HasExited) {
        Invoke-ProcessTreeKill -ProcessId $secondInstance.Id
        throw "Second desktop instance did not exit within 45s; single-instance activation redirect failed."
      }
      if ($secondInstance.ExitCode -ne 0) {
        throw ("Second desktop instance exited with {0}; expected a clean single-instance redirect exit." -f $secondInstance.ExitCode)
      }
      $firstInstance.Refresh()
      if ($firstInstance.HasExited) {
        throw "Primary desktop instance exited during the single-instance redirect."
      }
      $desktopProcesses = @(
        Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
          Where-Object {
            $_.ExecutablePath -and
            [string]::Equals($_.ExecutablePath, $script:ExtendedDesktopExe, [System.StringComparison]::OrdinalIgnoreCase)
          }
      )
      if ($desktopProcesses.Count -ne 1) {
        throw ("Expected exactly one desktop host process after the redirect; found {0}." -f $desktopProcesses.Count)
      }
      return "single-instance journey passed: second instance redirected and exited; one host process remained"
    }
    finally {
      $firstInstance.Refresh()
      if (-not $firstInstance.HasExited) {
        Invoke-ProcessTreeKill -ProcessId $firstInstance.Id
      }
    }
  }

  Invoke-SmokeStep -Name "extended-stop-and-uninstall" -Action {
    Stop-ExtendedInstalledProcesses
    Start-Sleep -Seconds 2
    if (-not (Test-Path -LiteralPath $script:ExtendedUninstaller -PathType Leaf)) {
      throw ("Extended install did not provide an uninstaller at {0}" -f $script:ExtendedUninstaller)
    }
    $uninstall = Start-Process -FilePath $script:ExtendedUninstaller -ArgumentList @(
      "/VERYSILENT",
      "/SUPPRESSMSGBOXES",
      "/NORESTART"
    ) -Wait -PassThru
    if ($uninstall.ExitCode -ne 0) {
      throw ("Extended uninstaller exited with {0}" -f $uninstall.ExitCode)
    }
    $script:ExtendedUninstalled = $true

    if (Test-Path -LiteralPath $script:ProtocolClassKeys[0]) {
      throw "goatcitadel protocol registration remained after the extended uninstall."
    }
    $appxRemaining = $null
    try {
      $appxRemaining = Get-AppxPackage $script:AppxIdentityName -ErrorAction Stop | Select-Object -First 1
    }
    catch {
      $appxRemaining = $null
    }
    if ($appxRemaining) {
      throw "GoatCitadel package identity remained registered after the extended uninstall."
    }
    $uninstallEntries = @(Get-InnoUninstallEntries)
    if ($uninstallEntries.Count -ne 0) {
      throw ("Installer uninstall entries remained after the extended uninstall: {0}" -f ($uninstallEntries -join "; "))
    }
    if (Test-Path -LiteralPath $script:ExtendedDesktopExe) {
      throw ("Installed desktop executable remained after the extended uninstall at {0}" -f $script:ExtendedDesktopExe)
    }
    foreach ($payloadEntry in @("app", "bin")) {
      $payloadPath = Join-Path $script:ExtendedInstallDir $payloadEntry
      if (Test-Path -LiteralPath $payloadPath) {
        throw ("Extended uninstall left immutable payload at {0}" -f $payloadPath)
      }
    }
    if (Test-Path -LiteralPath $script:ExtendedInstallDir) {
      Get-ChildItem -LiteralPath $script:ExtendedInstallDir -Force -ErrorAction SilentlyContinue |
        ForEach-Object { Write-Host ("Mutable state preserved by uninstall (expected): {0}" -f $_.FullName) }
    }
    return "extended uninstall deregistered the protocol handler, uninstall entry, and immutable payload"
  }

  Write-SmokeVerdict -Verdict "passed"
  Write-Host "Clean-host installer smoke PASSED. Evidence bundle preserved at $script:ResolvedOutputRoot"
  $exitCode = 0
  exit 0
}
catch {
  $primaryFailure = $_.Exception.Message
  Write-Host ("Clean-host installer smoke FAILED: {0}" -f $primaryFailure)

  # Recovery cleanup for the wrapper-owned extended install only; the shared
  # lifecycle passes clean up after themselves. Evidence is never deleted.
  if ($script:ExtendedInstalled -and -not $script:ExtendedUninstalled) {
    try {
      Stop-ExtendedInstalledProcesses
    }
    catch {
      $script:CleanupFailures.Add(("Extended process cleanup failed: {0}" -f $_.Exception.Message))
    }
    if (Test-Path -LiteralPath $script:ExtendedUninstaller -PathType Leaf) {
      try {
        $cleanup = Start-Process -FilePath $script:ExtendedUninstaller -ArgumentList @(
          "/VERYSILENT",
          "/SUPPRESSMSGBOXES",
          "/NORESTART"
        ) -Wait -PassThru
        if ($cleanup.ExitCode -eq 0) {
          $script:ExtendedUninstalled = $true
        }
        else {
          $script:CleanupFailures.Add(("Extended cleanup uninstaller exited with {0}." -f $cleanup.ExitCode))
        }
      }
      catch {
        $script:CleanupFailures.Add(("Extended cleanup uninstall failed: {0}" -f $_.Exception.Message))
      }
    }
    else {
      $script:CleanupFailures.Add("Extended install is missing its cleanup uninstaller; recovery payload was preserved.")
    }
    try {
      Remove-ExtendedProtocolRegistrationIfOwned
    }
    catch {
      $script:CleanupFailures.Add(("Extended protocol cleanup failed: {0}" -f $_.Exception.Message))
    }
  }

  Write-SmokeVerdict -Verdict "failed" -Failure $primaryFailure
  $exitCode = 1
  exit 1
}
finally {
  Restore-ProcessEnvironmentVariable -Name "GOATCITADEL_HOME" -PreviousValue $previousGoatCitadelHome
  Restore-ProcessEnvironmentVariable -Name "GOATCITADEL_APP_DIR" -PreviousValue $previousGoatCitadelAppDir
  Restore-ProcessEnvironmentVariable -Name "WEBVIEW2_USER_DATA_FOLDER" -PreviousValue $previousWebViewDataFolder
  Restore-ProcessEnvironmentVariable -Name "GOATCITADEL_DESKTOP_LAUNCHER" -PreviousValue $previousDesktopLauncher
  Restore-ProcessEnvironmentVariable -Name "GOATCITADEL_GATEWAY_URL" -PreviousValue $previousGatewayUrl
  Restore-ProcessEnvironmentVariable -Name "GOATCITADEL_MISSION_CONTROL_URL" -PreviousValue $previousMissionControlUrl
  if ($script:TranscriptStarted) {
    try {
      Stop-Transcript | Out-Null
    }
    catch {
      Write-Warning ("Transcript stop failed: {0}" -f $_.Exception.Message)
    }
  }
}
