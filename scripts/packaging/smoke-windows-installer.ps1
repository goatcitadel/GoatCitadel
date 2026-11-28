[CmdletBinding(DefaultParameterSetName = "DetachedManifest")]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true, ParameterSetName = "DetachedManifest")]
  [string]$ExpectedReleaseManifestPath,

  [Parameter(Mandatory = $true, ParameterSetName = "InstalledLive")]
  [hashtable]$LiveAcceptance,

  [Parameter(Mandatory = $true)]
  [ValidateSet("windows-x64", "windows-arm64")]
  [string]$Target,

  [Parameter(Mandatory = $true)]
  [ValidateSet("signed", "unsigned")]
  [string]$TrustMode,

  [string]$ScratchRoot = $env:RUNNER_TEMP,

  [Parameter(ParameterSetName = "DetachedManifest")]
  [string]$RecallEvidenceDirectory,

  [string]$BetaInstallerPath,

  [ValidatePattern("^[0-9a-f]{64}$")]
  [string]$BetaInstallerSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($ScratchRoot)) {
  $ScratchRoot = [System.IO.Path]::GetTempPath()
}

$scratchFullPath = [System.IO.Path]::GetFullPath($ScratchRoot).TrimEnd(
  [System.IO.Path]::DirectorySeparatorChar,
  [System.IO.Path]::AltDirectorySeparatorChar
)
$smokeRoot = [System.IO.Path]::GetFullPath((Join-Path $scratchFullPath "GoatCitadel-installer-smoke-$Target"))
$expectedPrefix = $scratchFullPath + [System.IO.Path]::DirectorySeparatorChar
if (-not $smokeRoot.StartsWith($expectedPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to smoke an installer outside the scratch root: $smokeRoot"
}
if (Test-Path -LiteralPath $smokeRoot) {
  throw "Refusing to overwrite an existing installer smoke directory: $smokeRoot"
}

$installer = (Resolve-Path -LiteralPath $InstallerPath -ErrorAction Stop).Path
$signedMode = $TrustMode -eq "signed"
$upgradeMode = -not [string]::IsNullOrWhiteSpace($BetaInstallerPath)
$liveMode = $PSCmdlet.ParameterSetName -eq "InstalledLive"
$recallMode = -not [string]::IsNullOrWhiteSpace($RecallEvidenceDirectory)
if ($recallMode) {
  if ($env:GITHUB_ACTIONS -ne "true" -or $env:RUNNER_ENVIRONMENT -ne "github-hosted" -or
      $Target -ne "windows-x64" -or $signedMode -or $upgradeMode) {
    throw "Recall acceptance requires a disposable hosted Windows x64 clean install."
  }
  $installerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
}
if ($liveMode) {
  if ($env:GITHUB_ACTIONS -ne "true" -or $env:RUNNER_ENVIRONMENT -ne "github-hosted" -or
      $Target -ne "windows-x64" -or $signedMode -or $upgradeMode -or
      $LiveAcceptance.CandidateCommit -cnotmatch '^[a-f0-9]{40}$' -or
      $LiveAcceptance.InstallerSha256 -cnotmatch '^[a-f0-9]{64}$') {
    throw "Installed live acceptance requires a disposable x64 GitHub runner and a pinned unsigned EXE."
  }
  $installerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($installerHash -cne $LiveAcceptance.InstallerSha256) {
    throw "The installer bytes do not match the pinned acceptance digest."
  }
}
else {
  $detachedReleaseManifestPath = (Resolve-Path -LiteralPath $ExpectedReleaseManifestPath -ErrorAction Stop).Path
}
if ($upgradeMode -ne (-not [string]::IsNullOrWhiteSpace($BetaInstallerSha256)) -or ($upgradeMode -and $signedMode)) {
  throw "Beta upgrade proof needs an installer and its SHA-256 in unsigned smoke mode."
}
if ($upgradeMode) {
  $betaInstaller = (Resolve-Path -LiteralPath $BetaInstallerPath -ErrorAction Stop).Path
  $observedBetaHash = (Get-FileHash -LiteralPath $betaInstaller -Algorithm SHA256).Hash
  if ($observedBetaHash -ne $BetaInstallerSha256) {
    throw "The beta installer SHA-256 does not match its pinned release asset."
  }
  . (Join-Path $PSScriptRoot "lib/windows-beta-upgrade-proof.ps1")
}
$installerSignature = Get-AuthenticodeSignature -LiteralPath $installer
if ($signedMode -and $installerSignature.Status -ne "Valid") {
  throw "Signed installer smoke requires a valid Authenticode signature; '$installer' is $($installerSignature.Status)."
}
Write-Host "Installer trust mode '$TrustMode': Authenticode status is $($installerSignature.Status)."

$installDir = Join-Path $smokeRoot "install"
$desktop = Join-Path $installDir "app/desktop/GoatCitadel-Mission-Control-Windows.exe"
$identityPackage = Join-Path $installDir "app/identity/GoatCitadel-Mission-Control-Windows-Identity.msix"
$bundledNode = Join-Path $installDir "app/runtime/node/node.exe"
$launcher = Join-Path $installDir "app/bin/goatcitadel.mjs"
$appHome = Join-Path $installDir "app"
$runtimeBase = Join-Path $smokeRoot "runtime"
$webViewDataDir = Join-Path $runtimeBase "webview2"
$runtimeLogDir = Join-Path $runtimeBase "runtime/logs"
$desktopStartupPath = Join-Path $runtimeLogDir "desktop-startup.json"
$launchStdout = Join-Path $smokeRoot "goatcitadel-launch.out.json"
$launchStderr = Join-Path $smokeRoot "goatcitadel-launch.err.txt"
$statusStdout = Join-Path $smokeRoot "goatcitadel-status.out.json"
$statusStderr = Join-Path $smokeRoot "goatcitadel-status.err.txt"
$installPrefix = $installDir.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$protocolRegistryPath = "Registry::HKEY_CURRENT_USER\Software\Classes\goatcitadel"
$protocolCommandRegistryPath = "$protocolRegistryPath\shell\open\command"
$expectedProtocolCommand = '"{0}" "%1"' -f $desktop
$payloadValidatorPath = Join-Path $PSScriptRoot "validate-windows-bundle.ps1"
. (Join-Path $PSScriptRoot "lib/windows-desktop-startup.ps1")

if (Test-Path -LiteralPath $protocolRegistryPath) {
  throw "Refusing to overwrite an existing goatcitadel protocol registration during isolated installer smoke."
}
if (Get-AppxPackage GoatCitadel.MissionControl.Windows -ErrorAction SilentlyContinue) {
  throw "Refusing to replace an existing GoatCitadel package identity during isolated installer smoke."
}
if (-not (Test-Path -LiteralPath $payloadValidatorPath -PathType Leaf)) {
  throw "Installed payload validator was not found at $payloadValidatorPath"
}

$previousGoatCitadelHome = [Environment]::GetEnvironmentVariable("GOATCITADEL_HOME", "Process")
$previousGoatCitadelAppDir = [Environment]::GetEnvironmentVariable("GOATCITADEL_APP_DIR", "Process")
$previousDatabaseDriver = [Environment]::GetEnvironmentVariable("GOATCITADEL_DATABASE_DRIVER", "Process")
$previousWebViewDataFolder = [Environment]::GetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", "Process")
$previousDesktopLauncher = [Environment]::GetEnvironmentVariable("GOATCITADEL_DESKTOP_LAUNCHER", "Process")
$previousGatewayUrl = [Environment]::GetEnvironmentVariable("GOATCITADEL_GATEWAY_URL", "Process")
$previousMissionControlUrl = [Environment]::GetEnvironmentVariable("GOATCITADEL_MISSION_CONTROL_URL", "Process")
$env:GOATCITADEL_HOME = $runtimeBase
$env:GOATCITADEL_APP_DIR = $appHome
# Exercise the shipped database default on a clean install. Pin SQLite only for
# the historical beta upgrade fixture.
Remove-Item Env:GOATCITADEL_DATABASE_DRIVER -ErrorAction SilentlyContinue
if ($upgradeMode) {
  $env:GOATCITADEL_DATABASE_DRIVER = "sqlite"
}
$env:WEBVIEW2_USER_DATA_FOLDER = $webViewDataDir
Remove-Item Env:GOATCITADEL_DESKTOP_LAUNCHER -ErrorAction SilentlyContinue
Remove-Item Env:GOATCITADEL_GATEWAY_URL -ErrorAction SilentlyContinue
Remove-Item Env:GOATCITADEL_MISSION_CONTROL_URL -ErrorAction SilentlyContinue
$runtimeIsolationConfigured = $true
$hostProc = $null
$installed = $false
$uninstalled = $false
$cleanupFailures = [System.Collections.Generic.List[string]]::new()
$primaryFailure = $null
$upgradeEnvironment = @{}
$betaSnapshot = $null

function Redact-DiagnosticLine([string]$Line) {
  return ($Line `
    -replace '("token"\s*:\s*")[^"]+(")', '$1[REDACTED]$2' `
    -replace '("authorization"\s*:\s*")[^"]+(")', '$1[REDACTED]$2' `
    -replace '(?i)(Bearer\s+)[A-Za-z0-9._~+/=-]{12,}', '$1[REDACTED]' `
    -replace '(?i)(--(?:auth-)?token(?:=|\s+))\S+', '$1[REDACTED]' `
    -replace '(?i)((?:token|api[_-]?key|secret|authorization)=)[^&\s"]+', '$1[REDACTED]')
}

function Write-RedactedContent([string]$Path, [int]$Tail = 0) {
  $contentArgs = @{ LiteralPath = $Path; ErrorAction = "SilentlyContinue" }
  if ($Tail -gt 0) {
    $contentArgs["Tail"] = $Tail
  }
  Get-Content @contentArgs | ForEach-Object { Write-Host (Redact-DiagnosticLine $_) }
}

function Show-RuntimeLogs {
  Write-Host "::group::GoatCitadel runtime logs"
  foreach ($capture in @($launchStdout, $launchStderr, $statusStdout, $statusStderr)) {
    if (Test-Path -LiteralPath $capture) {
      Write-Host "----- $(Split-Path $capture -Leaf) -----"
      Write-RedactedContent $capture
    }
  }
  foreach ($name in @(
      "desktop-startup.json",
      "gateway.stderr.log",
      "gateway.stdout.log",
      "mission-control.stderr.log",
      "mission-control.stdout.log"
    )) {
    $logPath = Join-Path $runtimeLogDir $name
    if (Test-Path -LiteralPath $logPath) {
      Write-Host "----- $name (tail) -----"
      Write-RedactedContent $logPath 80
    }
  }
  Write-Host "::endgroup::"
}

function Get-InstalledProcesses {
  return @(
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($installPrefix, [System.StringComparison]::OrdinalIgnoreCase)
      }
  )
}

function Stop-InstalledProcesses {
  if ($null -ne $hostProc) {
    try {
      $hostProc.Refresh()
      if (-not $hostProc.HasExited) {
        & taskkill.exe /PID $hostProc.Id /T /F 2>$null | Out-Null
      }
    }
    catch {
      Write-Warning "Could not stop the desktop host process tree: $($_.Exception.Message)"
    }
  }

  if ($runtimeIsolationConfigured -and
      (Test-Path -LiteralPath $bundledNode -PathType Leaf) -and
      (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    try {
      & $bundledNode $launcher stop --json 1>$null 2>$null
    }
    catch {
      Write-Warning "Could not stop the packaged runtime through the launcher: $($_.Exception.Message)"
    }
  }

  Get-InstalledProcesses |
    ForEach-Object {
      Write-Host "Backstop kill after installer smoke: PID $($_.ProcessId) $($_.Name) ($($_.ExecutablePath))"
      & taskkill.exe /PID $_.ProcessId /T /F 2>$null | Out-Null
    }

  $stopDeadline = (Get-Date).AddSeconds(15)
  do {
    $remainingProcesses = @(Get-InstalledProcesses)
    if ($remainingProcesses.Count -eq 0) {
      return
    }
    Start-Sleep -Milliseconds 250
  } while ((Get-Date) -lt $stopDeadline)

  $remainingSummary = ($remainingProcesses |
      ForEach-Object { "PID $($_.ProcessId) $($_.Name) ($($_.ExecutablePath))" }) -join "; "
  throw "Installed process teardown did not complete within 15 seconds: $remainingSummary"
}

try {
  New-Item -ItemType Directory -Path $smokeRoot -ErrorAction Stop | Out-Null
  $installerArgs = @(
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/DIR=`"$installDir`""
  )
  if ($upgradeMode) {
    $upgradeSettings = @{
      GOATCITADEL_AUTH_MODE = "token"
      GOATCITADEL_AUTH_TOKEN = [Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N")
      GOATCITADEL_DISABLE_SECRET_STORE = "true"
      GOATCITADEL_DEV_DIAGNOSTICS_ENABLED = "true"
    }
    foreach ($name in $upgradeSettings.Keys) {
      $upgradeEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
      [Environment]::SetEnvironmentVariable($name, $upgradeSettings[$name], "Process")
    }
    $betaInstall = Start-Process -FilePath $betaInstaller -ArgumentList $installerArgs -Wait -PassThru
    if ($betaInstall.ExitCode -ne 0) {
      throw "Beta installer exited with $($betaInstall.ExitCode)"
    }
    $betaManifest = Get-Content -LiteralPath (Join-Path $appHome "release-manifest.json") -Raw | ConvertFrom-Json
    if ($betaManifest.target -cne $Target -or $betaManifest.version -cne "0.9.2-beta.2" -or
        $betaManifest.sourceCommit -cne "627c83d8afa870f5278816a30b1677e29d7fda83" -or $betaManifest.sourceModified -ne $false) {
      throw "Installed beta manifest does not match the pinned upgrade source."
    }
    $originalNodePath = [Environment]::GetEnvironmentVariable("NODE_PATH", "Process")
    try {
      if ($Target -eq "windows-arm64") {
        $env:NODE_PATH = New-BetaArm64SeedModulePath $appHome $detachedReleaseManifestPath (Join-Path $smokeRoot "beta-seed-modules")
      }
      $betaLaunchOutput = & $bundledNode $launcher launch --no-open --wait --json 2>$launchStderr
      $betaLaunchExitCode = $LASTEXITCODE
    }
    finally {
      [Environment]::SetEnvironmentVariable("NODE_PATH", $originalNodePath, "Process")
    }
    $betaLaunchOutput | ForEach-Object { Redact-DiagnosticLine $_ } | Set-Content -LiteralPath $launchStdout -Encoding UTF8
    $betaLaunchLine = $betaLaunchOutput | Where-Object { $_.TrimStart().StartsWith("{") } | Select-Object -Last 1
    if ($betaLaunchExitCode -ne 0 -or -not $betaLaunchLine) {
      throw "The pinned beta launcher exited with code $betaLaunchExitCode or omitted JSON readiness."
    }
    $betaLaunch = $betaLaunchLine | ConvertFrom-Json
    if ($betaLaunch.status -ne "ready") {
      throw "The pinned beta did not reach packaged runtime readiness."
    }
    $betaSnapshot = New-BetaUpgradeProfile $betaLaunch.gatewayUrl
    Stop-InstalledProcesses
    $env:GOATCITADEL_DEV_DIAGNOSTICS_ENABLED = "false"
  }
  $install = Start-Process -FilePath $installer -ArgumentList $installerArgs -Wait -PassThru
  if ($install.ExitCode -ne 0) {
    throw "Installer exited with $($install.ExitCode)"
  }
  $installed = $true

  if (-not (Test-Path -LiteralPath $desktop -PathType Leaf)) {
    throw "Installed desktop executable was not found at $desktop"
  }
  $desktopSignature = Get-AuthenticodeSignature -LiteralPath $desktop
  if ($signedMode -and $desktopSignature.Status -ne "Valid") {
    throw "Signed installer smoke requires a valid installed desktop signature; '$desktop' is $($desktopSignature.Status)."
  }
  if ($signedMode -and
      $desktopSignature.SignerCertificate.Thumbprint -cne $installerSignature.SignerCertificate.Thumbprint) {
    throw "Installed desktop and installer signatures do not have the same signer."
  }
  Write-Host "Installed desktop Authenticode status is $($desktopSignature.Status)."

  if (-not (Test-Path -LiteralPath $protocolCommandRegistryPath)) {
    throw "Installer did not register the goatcitadel protocol command."
  }
  $protocolKey = Get-Item -LiteralPath $protocolRegistryPath -ErrorAction Stop
  if (-not ($protocolKey.GetValueNames() -contains "URL Protocol")) {
    throw "Installer protocol registration is missing the URL Protocol marker."
  }
  $protocolCommand = (Get-Item -LiteralPath $protocolCommandRegistryPath -ErrorAction Stop).GetValue("")
  if (-not [string]::Equals($protocolCommand, $expectedProtocolCommand, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Installer protocol command is not bound to the exact installed desktop executable."
  }

  if (Test-Path -LiteralPath $identityPackage -PathType Leaf) {
    $identitySignature = Get-AuthenticodeSignature -LiteralPath $identityPackage
    if ($signedMode -and $identitySignature.Status -ne "Valid") {
      throw "Signed installer smoke requires a valid installed identity signature; '$identityPackage' is $($identitySignature.Status)."
    }
    if ($signedMode -and
        $identitySignature.SignerCertificate.Thumbprint -cne $installerSignature.SignerCertificate.Thumbprint) {
      throw "Installed identity and installer signatures do not have the same signer."
    }

    $identity = Get-AppxPackage GoatCitadel.MissionControl.Windows -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($signedMode -and -not $identity) {
      throw "GoatCitadel package identity was not registered."
    }
    if ($identity) {
      $identityManifest = Get-AppxPackageManifest -Package $identity.PackageFullName
      $identityNode = $identityManifest.SelectSingleNode("/*[local-name()='Package']/*[local-name()='Identity']")
      $applicationNode = $identityManifest.SelectSingleNode("//*[local-name()='Application' and @Id='App']")
      $protocolNode = $identityManifest.SelectSingleNode("//*[local-name()='Protocol' and translate(@Name,'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz')='goatcitadel']")
      $externalContentNode = $identityManifest.SelectSingleNode("//*[local-name()='AllowExternalContent' and translate(text(),'TRUE','true')='true']")
      if (-not $identityNode -or
          $identityNode.GetAttribute("Name") -ne $identity.Name -or
          $identityNode.GetAttribute("Publisher") -ne $identity.Publisher -or
          $identityNode.GetAttribute("Version") -ne $identity.Version.ToString()) {
        throw "Registered package identity does not match its installed manifest identity."
      }
      if ($signedMode -and
          $identityNode.GetAttribute("Publisher") -cne $identitySignature.SignerCertificate.Subject) {
        throw "Registered package publisher does not match the installed identity signer subject."
      }
      $expectedManifestExecutable = "app\desktop\GoatCitadel-Mission-Control-Windows.exe"
      if (-not $applicationNode -or
          $applicationNode.GetAttribute("Executable").Replace("/", "\") -ne $expectedManifestExecutable) {
        throw "Registered package identity is not bound to the installed desktop executable path."
      }
      if (-not $protocolNode -or -not $externalContentNode) {
        throw "Registered package identity does not expose the exact goatcitadel protocol through external content."
      }
    }
    else {
      Write-Host "Unsigned installer carried an unregistered identity package with Authenticode status $($identitySignature.Status); registration is optional in unsigned smoke mode."
    }
  }
  elseif ($signedMode) {
    throw "Signed installer smoke requires the installed package identity at $identityPackage"
  }
  else {
    Write-Host "Unsigned installer omitted the optional package identity, as permitted."
  }

  $installedReleaseManifestPath = Join-Path $appHome "release-manifest.json"
  if (-not (Test-Path -LiteralPath $installedReleaseManifestPath -PathType Leaf)) {
    throw "Installed release manifest was not found at $installedReleaseManifestPath"
  }
  $installedManifestHash = (Get-FileHash -LiteralPath $installedReleaseManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if (-not $liveMode) {
    $detachedManifestHash = (Get-FileHash -LiteralPath $detachedReleaseManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($installedManifestHash -cne $detachedManifestHash) {
      throw "Installed release manifest does not match the detached release manifest bytes."
    }
  }
  $releaseManifest = Get-Content -LiteralPath $installedReleaseManifestPath -Raw -ErrorAction Stop | ConvertFrom-Json
  $expectedArch = if ($Target -eq "windows-arm64") { "arm64" } else { "x64" }
  if ($releaseManifest.target -cne $Target -or
      $releaseManifest.platform -cne "windows" -or
      $releaseManifest.arch -cne $expectedArch -or
      $releaseManifest.sourceModified -ne $false -or
      [string]$releaseManifest.sourceCommit -cnotmatch '^[0-9a-f]{40}$' -or
      [string]::IsNullOrWhiteSpace([string]$releaseManifest.version)) {
    throw "Installed release manifest target, architecture, commit, version, or clean-source truth is invalid."
  }
  if ($liveMode -and $releaseManifest.sourceCommit -cne $LiveAcceptance.CandidateCommit) {
    throw "The installed manifest does not identify the requested candidate commit."
  }
  & $payloadValidatorPath `
    -StageRoot $installDir `
    -Target $Target `
    -Version ([string]$releaseManifest.version) `
    -InstalledRoot

  # Prove the installed WinUI host starts and presents its window. A file-only smoke
  # cannot detect missing resources.pri / compiled XAML startup crashes such as 0xC000027B.
  $launchDir = Split-Path -Parent $desktop
  $hostProc = Start-Process -FilePath $desktop -WorkingDirectory $launchDir -PassThru
  if (-not $hostProc) {
    throw "Failed to start the desktop host at $desktop"
  }
  $windowTitle = $null
  $deadline = (Get-Date).AddSeconds(40)
  while ((Get-Date) -lt $deadline) {
    $hostProc.Refresh()
    if ($hostProc.HasExited) {
      $hex = "0x{0:X8}" -f $hostProc.ExitCode
      throw "Desktop host exited during launch smoke with code $hex before presenting a window (0xC000027B indicates the WinUI startup resource crash: missing resources.pri or compiled XAML)."
    }
    if ($hostProc.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($hostProc.MainWindowTitle)) {
      $windowTitle = $hostProc.MainWindowTitle
      break
    }
    Start-Sleep -Milliseconds 500
  }

  $webViewTarget = $null
  $desktopStartup = $null
  $expectedWebViewPath = "/settings/onboarding"
  $expectedWebViewTitle = "GoatCitadel Settings · Get started"
  if ($upgradeMode) {
    $expectedWebViewPath = "/"
    $expectedWebViewTitle = "GoatCitadel"
  }
  # Each cold launcher endpoint has a three-minute bound. Allow both plus page
  # navigation, while rejecting native failures immediately. Debug-port flags are
  # intentionally ignored by elevated WebView2 hosts on hosted Windows runners.
  $webViewDeadline = (Get-Date).AddMinutes(7)
  while ((Get-Date) -lt $webViewDeadline) {
    $hostProc.Refresh()
    if ($hostProc.HasExited) {
      $hex = "0x{0:X8}" -f $hostProc.ExitCode
      throw "Desktop host exited during embedded Mission Control smoke with code $hex."
    }
    try {
      $desktopStartup = Get-Content -LiteralPath $desktopStartupPath -Raw -ErrorAction Stop | ConvertFrom-Json
      $webViewTarget = Get-VerifiedDesktopNavigation -Snapshot $desktopStartup `
        -ExpectedProcessId $hostProc.Id -StartedAfter $hostProc.StartTime.ToUniversalTime()
    }
    catch {
      $webViewTarget = $null
    }
    if ($desktopStartup -and $desktopStartup.processId -eq $hostProc.Id -and
        $desktopStartup.phase -in @("webview-failed", "runtime-failed")) {
      throw "Native startup failed: $($desktopStartup.phase) ($($desktopStartup.errorType), $($desktopStartup.errorCode)). See startup and runtime logs."
    }
    if ($webViewTarget) {
      try {
        $candidateWebViewUri = [Uri]$webViewTarget.url
        if ($candidateWebViewUri.AbsolutePath -eq $expectedWebViewPath -and
            $webViewTarget.title -eq $expectedWebViewTitle) {
          break
        }
      }
      catch {
        # Retain the candidate for the bounded, operator-readable failure below.
      }
    }
    Start-Sleep -Milliseconds 500
  }

  if (-not $webViewTarget) {
    throw "Desktop host presented a titled window but its embedded Mission Control target remained blank. No successful navigation snapshot from the launched native process."
  }
  $webViewUri = [Uri]$webViewTarget.url
  if ($webViewUri.Scheme -notin @("http", "https") -or
      $webViewUri.Host -notin @("127.0.0.1", "localhost", "::1", "[::1]")) {
    throw "Embedded Mission Control navigated outside the allowed loopback boundary: $($webViewTarget.url)"
  }
  if ($webViewUri.AbsolutePath -ne $expectedWebViewPath) {
    throw "Embedded Mission Control first launch navigated to '$($webViewUri.AbsolutePath)'; expected '$expectedWebViewPath'."
  }
  if ($webViewTarget.title -ne $expectedWebViewTitle) {
    throw "Embedded Mission Control page title was '$($webViewTarget.title)'; expected '$expectedWebViewTitle'."
  }

  $nativeRuntimeEvidence = @(
    @(
      "gateway.stdout.log",
      "mission-control.stdout.log"
    ) | ForEach-Object { Join-Path $runtimeLogDir $_ } | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
  )
  if ($nativeRuntimeEvidence.Count -ne 2) {
    throw "Native desktop did not place Gateway and Mission Control logs under the isolated runtime home '$runtimeBase'."
  }
  $installRuntimeLogDir = Join-Path $installDir "runtime/logs"
  if (Test-Path -LiteralPath $installRuntimeLogDir) {
    throw "Native desktop wrote mutable runtime logs under the immutable install root '$installRuntimeLogDir'."
  }

  # Tear down the host and its WebView/runtime descendants before readiness and
  # uninstall checks so no file handle under the install directory remains open.
  if (-not $hostProc.HasExited) {
    # A child can exit between taskkill's tree snapshot and termination. Ignore
    # that native stderr here; the exact installed-path reread below remains the
    # authoritative cleanup check and kills any process that actually survived.
    & taskkill.exe /PID $hostProc.Id /T /F 2>$null | Out-Null
  }
  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ExecutablePath -and
      $_.ExecutablePath.StartsWith($installPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    } |
    ForEach-Object {
      Write-Host "Backstop kill after host smoke: PID $($_.ProcessId) $($_.Name) ($($_.ExecutablePath))"
      & taskkill.exe /PID $_.ProcessId /T /F 2>$null | Out-Null
    }
  Start-Sleep -Seconds 2

  if (-not $windowTitle) {
    throw "Desktop host did not present a top-level window within 40s; it started but never reached its UI."
  }
  if ($windowTitle -ne "GoatCitadel Mission Control") {
    throw "Desktop host window title was '$windowTitle'; expected 'GoatCitadel Mission Control'."
  }
  Write-Host "Launch smoke passed: host presented window '$windowTitle'."
  Write-Host "Embedded Mission Control smoke passed: WebView navigated to $($webViewTarget.url)."

  # Drive the same packaged launcher used by the desktop host. This proves the
  # installed gateway and Mission Control become healthy with bundled production deps.
  if (-not (Test-Path -LiteralPath $bundledNode -PathType Leaf)) {
    throw "Bundled Node runtime was not installed at $bundledNode"
  }
  if (-not (Test-Path -LiteralPath $launcher -PathType Leaf)) {
    throw "Launcher was not installed at $launcher"
  }
  Write-Host "Runtime readiness smoke: launching packaged gateway + UI via $launcher"
  $quotedLauncher = '"' + $launcher + '"'
  # Windows PowerShell 5.1 reconstructs a redirected Start-Process result by
  # PID and loses the owned process handle after exit, leaving ExitCode null.
  # Own the Process directly while draining both streams asynchronously so the
  # timeout and the fail-closed integer exit-code check remain authoritative.
  $launchStartInfo = [System.Diagnostics.ProcessStartInfo]::new()
  $launchStartInfo.FileName = $bundledNode
  $launchStartInfo.Arguments = "$quotedLauncher launch --no-open --wait --json"
  $launchStartInfo.WorkingDirectory = $appHome
  $launchStartInfo.UseShellExecute = $false
  $launchStartInfo.CreateNoWindow = $true
  $launchStartInfo.RedirectStandardOutput = $true
  $launchStartInfo.RedirectStandardError = $true
  $launch = [System.Diagnostics.Process]::new()
  $launch.StartInfo = $launchStartInfo
  [void]$launch.Start()
  $launchStdoutTask = $launch.StandardOutput.ReadToEndAsync()
  $launchStderrTask = $launch.StandardError.ReadToEndAsync()
  $launchExited = $launch.WaitForExit(600000)
  if (-not $launchExited) {
    Show-RuntimeLogs
    Write-Host "::group::Readiness hang diagnostics"
    netstat -ano | Select-String ":8787|:5173" | ForEach-Object { Write-Host $_ }
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
      Where-Object {
        $_.ExecutablePath -and
        $_.ExecutablePath.StartsWith($installPrefix, [System.StringComparison]::OrdinalIgnoreCase)
      } |
      ForEach-Object { Write-Host "PID $($_.ProcessId) $($_.Name): $(Redact-DiagnosticLine ([string]$_.CommandLine))" }
    Write-Host "::endgroup::"
    & taskkill.exe /PID $launch.Id /T /F 2>$null | Out-Null
  }
  $launch.WaitForExit()
  $utf8WithoutBom = [System.Text.UTF8Encoding]::new($false)
  [System.IO.File]::WriteAllText($launchStdout, $launchStdoutTask.Result, $utf8WithoutBom)
  [System.IO.File]::WriteAllText($launchStderr, $launchStderrTask.Result, $utf8WithoutBom)
  $launchExitCode = $launch.ExitCode
  $launch.Dispose()
  if (-not $launchExited) {
    Show-RuntimeLogs
    throw "Runtime readiness smoke failed: 'goatcitadel launch --wait' did not exit within 10 minutes. Launcher output, runtime logs, and listener/process state are printed above."
  }
  if ($launchExitCode -ne 0) {
    Show-RuntimeLogs
    throw "Runtime readiness smoke failed: 'goatcitadel launch' exited $launchExitCode before the gateway/UI became healthy. The installed host would hang on 'Starting the local runtime…'. A gateway boot crash (for example ERR_MODULE_NOT_FOUND from stranded production dependencies) surfaces here."
  }

  # Re-poll both /health endpoints independently; this is the canonical ready assertion.
  $launchStartInfo.Arguments = "$quotedLauncher status --json"
  $status = [System.Diagnostics.Process]::new()
  try {
    $status.StartInfo = $launchStartInfo
    [void]$status.Start()
    $statusStdoutTask = $status.StandardOutput.ReadToEndAsync()
    $statusStderrTask = $status.StandardError.ReadToEndAsync()
    if (-not $status.WaitForExit(60000)) {
      $status.Kill()
      Show-RuntimeLogs
      throw "Runtime readiness smoke failed: 'goatcitadel status --json' did not exit within 60 seconds."
    }
    $statusExitCode = $status.ExitCode
    [System.IO.File]::WriteAllText($statusStdout, $statusStdoutTask.Result, $utf8WithoutBom)
    [System.IO.File]::WriteAllText($statusStderr, $statusStderrTask.Result, $utf8WithoutBom)
  } finally {
    $status.Dispose()
  }
  $statusLine = $null
  if (Test-Path -LiteralPath $statusStdout) {
    $statusLine = Get-Content -LiteralPath $statusStdout -Encoding UTF8 -ErrorAction SilentlyContinue |
      Where-Object { $_.TrimStart().StartsWith("{") } |
      Select-Object -Last 1
  }
  if ($statusExitCode -ne 0 -or -not $statusLine) {
    Show-RuntimeLogs
    throw "Runtime readiness smoke failed: 'goatcitadel status --json' exited $statusExitCode or omitted a JSON status line."
  }
  $runtimeStatus = $statusLine | ConvertFrom-Json
  if ($runtimeStatus.status -ne "ready" -or -not ($runtimeStatus.readiness.gateway -and $runtimeStatus.readiness.ui)) {
    Show-RuntimeLogs
    throw "Runtime readiness smoke failed: runtime status is '$($runtimeStatus.status)' (gateway healthy=$($runtimeStatus.readiness.gateway), ui healthy=$($runtimeStatus.readiness.ui)); expected 'ready' with both the gateway and Mission Control answering /health."
  }
  Write-Host "Runtime readiness smoke passed: gateway + Mission Control reached status=ready (gateway $($runtimeStatus.gatewayUrl)/health, ui $($runtimeStatus.uiUrl)/health)."
  if ($upgradeMode) {
    $current = Get-UpgradeProfileSnapshot $runtimeStatus.gatewayUrl $betaSnapshot.WorkspaceId $betaSnapshot.SessionId $betaSnapshot.Marker
    if ($current.WorkspaceName -cne $betaSnapshot.WorkspaceName -or $current.Transcript -cne $betaSnapshot.Transcript) {
      throw "Unattended upgrade changed the beta workspace or saved transcript."
    }
    Write-Host "Beta upgrade preserved the workspace, transcript, guidance file, and setting in SQLite."
  }

  if (-not $upgradeMode -and -not (Test-Path -LiteralPath (Join-Path $runtimeBase "runtime-root/data/index.db") -PathType Leaf)) {
    throw "Clean Windows install did not create its default SQLite database."
  }

  Stop-InstalledProcesses
  Start-Sleep -Seconds 2

  if ($Target -eq "windows-arm64" -and -not $upgradeMode) {
    . (Join-Path $PSScriptRoot "lib/windows-packaged-postgres-smoke.ps1")
    Test-PackagedPostgresRecovery -Node $bundledNode -Launcher $launcher -AppHome $appHome -RuntimeBase $runtimeBase
  }

  if ($liveMode) {
    & $bundledNode (Join-Path $PSScriptRoot "windows-installed-live.mjs") `
      $appHome $smokeRoot $LiveAcceptance.EvidenceDirectory $LiveAcceptance.OllamaExe $LiveAcceptance.NtfyExe
    if ($LASTEXITCODE -ne 0) {
      throw "One or more installed live feature checks failed. See the retained feature records."
    }
  }
  if ($recallMode) {
    New-Item -ItemType Directory -Force -Path $RecallEvidenceDirectory | Out-Null
    . (Join-Path $PSScriptRoot 'lib/run-hosted-native-recall.ps1')
    Invoke-HostedNativeRecall $bundledNode $appHome $smokeRoot $RecallEvidenceDirectory $desktop
  }

  $uninstaller = Join-Path $installDir "unins000.exe"
  if (-not (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    throw "Installed candidate did not provide an uninstaller at $uninstaller"
  }
  $uninstall = Start-Process -FilePath $uninstaller -ArgumentList @(
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART"
  ) -Wait -PassThru
  if ($uninstall.ExitCode -ne 0) {
    throw "Uninstaller exited with $($uninstall.ExitCode)"
  }
  $uninstalled = $true

  if (Get-AppxPackage GoatCitadel.MissionControl.Windows -ErrorAction SilentlyContinue) {
    throw "GoatCitadel package identity remained registered after uninstall."
  }
  if (Test-Path -LiteralPath $protocolRegistryPath) {
    throw "goatcitadel protocol registration remained after uninstall."
  }
  if (Test-Path -LiteralPath $desktop) {
    throw "Installed desktop executable remained after uninstall at $desktop"
  }

  # Mutable operator state is intentionally preserved by uninstall. Require only the
  # immutable app/bin payload to be gone, list preserved state, then scrub runner state.
  foreach ($payloadEntry in @("app", "bin")) {
    $payloadPath = Join-Path $installDir $payloadEntry
    if (Test-Path -LiteralPath $payloadPath) {
      $sample = (Get-ChildItem -LiteralPath $payloadPath -Recurse -Force -File -ErrorAction SilentlyContinue |
          Select-Object -First 5 -ExpandProperty FullName) -join "`n"
      throw "Uninstall left immutable payload at $payloadPath`n$sample"
    }
  }
  if ($upgradeMode) {
    $dataPreserved = Test-Path -LiteralPath (Join-Path $runtimeBase "runtime-root/data/index.db") -PathType Leaf
    if (-not $dataPreserved) {
      throw "Uninstaller did not retain the upgrade profile's SQLite data."
    }
    $upgradeProofPath = Join-Path $scratchFullPath "$Target-beta-upgrade-proof.json"
    [ordered]@{
      target = $Target
      storageBackend = "sqlite"
      fromVersion = $betaManifest.version
      fromCommit = $betaManifest.sourceCommit
      fromInstallerSha256 = $observedBetaHash.ToLowerInvariant()
      candidateVersion = $releaseManifest.version
      candidateCommit = $releaseManifest.sourceCommit
      candidateInstallerSha256 = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
      betaSeedDependency = if ($Target -eq "windows-arm64") { "@img/sharp-win32-arm64 from the manifested candidate" } else { $null }
      retained = @("workspace", "chat transcript", "guidance file", "workspace setting", "uninstalled profile data")
    } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $upgradeProofPath -Encoding UTF8
  }
  if ($liveMode -or $recallMode) {
    $lifecycleEvidence = if ($liveMode) { $LiveAcceptance.EvidenceDirectory } else { $RecallEvidenceDirectory }
    [ordered]@{
      sourceCommit = $releaseManifest.sourceCommit
      sourceModified = $releaseManifest.sourceModified
      candidateVersion = $releaseManifest.version
      target = $Target
      installerSha256 = $installerHash
      installedManifestSha256 = $installedManifestHash
      authenticode = [string]$installerSignature.Status
      windowsVersion = [System.Environment]::OSVersion.Version.ToString()
      runnerArchitecture = $env:RUNNER_ARCH
      installerRunId = if ($liveMode) { $LiveAcceptance.InstallerRunId } else { $env:GITHUB_RUN_ID }
      nativeFirstLaunch = $true
      installedPayloadValidated = $true
      uninstallVerified = $true
    } | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $lifecycleEvidence "lifecycle.json") -Encoding UTF8
  }
  if (Test-Path -LiteralPath $installDir) {
    Get-ChildItem -LiteralPath $installDir -Force -ErrorAction SilentlyContinue |
      ForEach-Object { Write-Host "Mutable state preserved by uninstall (expected): $($_.FullName)" }
    Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  Write-Host "Windows installer lifecycle smoke passed for $Target in $TrustMode trust mode."
}
catch {
  $primaryFailure = $_.Exception.Message
  try { Show-RuntimeLogs }
  catch { Write-Warning "Could not read startup diagnostics: $($_.Exception.Message)" }
}
finally {
  try {
    Stop-InstalledProcesses
  }
  catch {
    $cleanupFailures.Add("Installed process cleanup failed: $($_.Exception.Message)")
  }

  $uninstaller = Join-Path $installDir "unins000.exe"
  if (-not $uninstalled -and (Test-Path -LiteralPath $uninstaller -PathType Leaf)) {
    try {
      $cleanup = Start-Process -FilePath $uninstaller -ArgumentList @(
        "/VERYSILENT",
        "/SUPPRESSMSGBOXES",
        "/NORESTART"
      ) -Wait -PassThru
      if ($cleanup.ExitCode -eq 0) {
        $uninstalled = $true
      }
      else {
        $cleanupFailures.Add("Cleanup uninstaller exited with $($cleanup.ExitCode).")
      }
    }
    catch {
      $cleanupFailures.Add("Cleanup uninstall failed: $($_.Exception.Message)")
    }
  }
  elseif ($installed -and -not $uninstalled) {
    $cleanupFailures.Add("Installed candidate is missing its cleanup uninstaller; recovery payload was preserved.")
  }

  # Preflight proved that no identity or protocol registration existed. Remove
  # only the exact candidate-owned registrations even when setup failed before
  # reporting success, then verify they are gone before deleting recovery files.
  foreach ($candidateIdentity in @(Get-AppxPackage GoatCitadel.MissionControl.Windows -ErrorAction SilentlyContinue)) {
    try {
      Remove-AppxPackage -Package $candidateIdentity.PackageFullName -ErrorAction Stop
    }
    catch {
      $cleanupFailures.Add("Candidate package identity cleanup failed: $($_.Exception.Message)")
    }
  }
  if (Get-AppxPackage GoatCitadel.MissionControl.Windows -ErrorAction SilentlyContinue) {
    $cleanupFailures.Add("Candidate package identity remained registered after cleanup.")
  }

  if (Test-Path -LiteralPath $protocolRegistryPath) {
    try {
      $cleanupProtocolCommand = if (Test-Path -LiteralPath $protocolCommandRegistryPath) {
        (Get-Item -LiteralPath $protocolCommandRegistryPath -ErrorAction Stop).GetValue("")
      }
      else {
        $null
      }
      if ([string]::Equals($cleanupProtocolCommand, $expectedProtocolCommand, [System.StringComparison]::OrdinalIgnoreCase)) {
        Remove-Item -LiteralPath $protocolRegistryPath -Recurse -Force -ErrorAction Stop
      }
      else {
        $cleanupFailures.Add("Refused to remove a goatcitadel protocol registration not bound to this smoke install.")
      }
    }
    catch {
      $cleanupFailures.Add("Candidate protocol cleanup failed: $($_.Exception.Message)")
    }
  }
  if (Test-Path -LiteralPath $protocolRegistryPath) {
    $cleanupFailures.Add("Candidate protocol registration remained after cleanup.")
  }

  if ($null -eq $primaryFailure -and
      $cleanupFailures.Count -eq 0 -and
      (Test-Path -LiteralPath $smokeRoot)) {
    try {
      Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction Stop
    }
    catch {
      $cleanupFailures.Add("Installer smoke scratch cleanup failed: $($_.Exception.Message)")
    }
  }
  if (Test-Path -LiteralPath $smokeRoot) {
    if ($null -eq $primaryFailure -and $cleanupFailures.Count -eq 0) {
      $cleanupFailures.Add("Installer smoke scratch root remained after cleanup.")
    }
    Write-Warning "Preserving installer smoke recovery payload at $smokeRoot"
  }

  if ($null -eq $previousGoatCitadelHome) {
    Remove-Item Env:GOATCITADEL_HOME -ErrorAction SilentlyContinue
  }
  else {
    $env:GOATCITADEL_HOME = $previousGoatCitadelHome
  }
  if ($null -eq $previousGoatCitadelAppDir) {
    Remove-Item Env:GOATCITADEL_APP_DIR -ErrorAction SilentlyContinue
  }
  else {
    $env:GOATCITADEL_APP_DIR = $previousGoatCitadelAppDir
  }
  if ($null -eq $previousWebViewDataFolder) {
    Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER -ErrorAction SilentlyContinue
  }
  else {
    $env:WEBVIEW2_USER_DATA_FOLDER = $previousWebViewDataFolder
  }
  if ($null -eq $previousDatabaseDriver) {
    Remove-Item Env:GOATCITADEL_DATABASE_DRIVER -ErrorAction SilentlyContinue
  }
  else {
    $env:GOATCITADEL_DATABASE_DRIVER = $previousDatabaseDriver
  }
  if ($null -eq $previousDesktopLauncher) {
    Remove-Item Env:GOATCITADEL_DESKTOP_LAUNCHER -ErrorAction SilentlyContinue
  }
  else {
    $env:GOATCITADEL_DESKTOP_LAUNCHER = $previousDesktopLauncher
  }
  if ($null -eq $previousGatewayUrl) {
    Remove-Item Env:GOATCITADEL_GATEWAY_URL -ErrorAction SilentlyContinue
  }
  else {
    $env:GOATCITADEL_GATEWAY_URL = $previousGatewayUrl
  }
  if ($null -eq $previousMissionControlUrl) {
    Remove-Item Env:GOATCITADEL_MISSION_CONTROL_URL -ErrorAction SilentlyContinue
  }
  else {
    $env:GOATCITADEL_MISSION_CONTROL_URL = $previousMissionControlUrl
  }
  foreach ($name in $upgradeEnvironment.Keys) {
    [Environment]::SetEnvironmentVariable($name, $upgradeEnvironment[$name], "Process")
  }
  if ($null -ne $primaryFailure) {
    $failureMessage = "Installer smoke failed: $primaryFailure"
    if ($cleanupFailures.Count -gt 0) {
      $failureMessage += " Cleanup also failed: $($cleanupFailures -join ' ')"
    }
    throw $failureMessage
  }
  if ($cleanupFailures.Count -gt 0) {
    throw "Installer smoke cleanup failed: $($cleanupFailures -join ' ')"
  }
}
