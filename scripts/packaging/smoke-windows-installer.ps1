[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,

  [Parameter(Mandatory = $true)]
  [string]$ExpectedReleaseManifestPath,

  [Parameter(Mandatory = $true)]
  [ValidateSet("windows-x64", "windows-arm64")]
  [string]$Target,

  [Parameter(Mandatory = $true)]
  [ValidateSet("signed", "unsigned")]
  [string]$TrustMode,

  [string]$ScratchRoot = $env:RUNNER_TEMP
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
$detachedReleaseManifestPath = (Resolve-Path -LiteralPath $ExpectedReleaseManifestPath -ErrorAction Stop).Path
$signedMode = $TrustMode -eq "signed"
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
$launchStdout = Join-Path $smokeRoot "goatcitadel-launch.out.json"
$launchStderr = Join-Path $smokeRoot "goatcitadel-launch.err.txt"
$statusStdout = Join-Path $smokeRoot "goatcitadel-status.out.json"
$statusStderr = Join-Path $smokeRoot "goatcitadel-status.err.txt"
$installPrefix = $installDir.TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
$protocolRegistryPath = "Registry::HKEY_CURRENT_USER\Software\Classes\goatcitadel"
$protocolCommandRegistryPath = "$protocolRegistryPath\shell\open\command"
$expectedProtocolCommand = '"{0}" "%1"' -f $desktop
$payloadValidatorPath = Join-Path $PSScriptRoot "validate-windows-bundle.ps1"

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
$previousWebViewDataFolder = [Environment]::GetEnvironmentVariable("WEBVIEW2_USER_DATA_FOLDER", "Process")
$previousWebViewBrowserArguments = [Environment]::GetEnvironmentVariable("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "Process")
$previousDesktopLauncher = [Environment]::GetEnvironmentVariable("GOATCITADEL_DESKTOP_LAUNCHER", "Process")
$previousGatewayUrl = [Environment]::GetEnvironmentVariable("GOATCITADEL_GATEWAY_URL", "Process")
$previousMissionControlUrl = [Environment]::GetEnvironmentVariable("GOATCITADEL_MISSION_CONTROL_URL", "Process")
$debugPortListener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
try {
  $debugPortListener.Start()
  $webViewDebugPort = ([System.Net.IPEndPoint]$debugPortListener.LocalEndpoint).Port
}
finally {
  $debugPortListener.Stop()
}
$env:GOATCITADEL_HOME = $runtimeBase
$env:GOATCITADEL_APP_DIR = $appHome
$env:WEBVIEW2_USER_DATA_FOLDER = $webViewDataDir
$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$webViewDebugPort"
Remove-Item Env:GOATCITADEL_DESKTOP_LAUNCHER -ErrorAction SilentlyContinue
Remove-Item Env:GOATCITADEL_GATEWAY_URL -ErrorAction SilentlyContinue
Remove-Item Env:GOATCITADEL_MISSION_CONTROL_URL -ErrorAction SilentlyContinue
$runtimeIsolationConfigured = $true
$hostProc = $null
$installed = $false
$uninstalled = $false
$cleanupFailures = [System.Collections.Generic.List[string]]::new()

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

  Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
    Where-Object {
      $_.ExecutablePath -and
      $_.ExecutablePath.StartsWith($installPrefix, [System.StringComparison]::OrdinalIgnoreCase)
    } |
    ForEach-Object {
      Write-Host "Backstop kill after installer smoke: PID $($_.ProcessId) $($_.Name) ($($_.ExecutablePath))"
      & taskkill.exe /PID $_.ProcessId /T /F 2>$null | Out-Null
    }
}

try {
  New-Item -ItemType Directory -Path $smokeRoot -ErrorAction Stop | Out-Null
  $install = Start-Process -FilePath $installer -ArgumentList @(
    "/VERYSILENT",
    "/SUPPRESSMSGBOXES",
    "/NORESTART",
    "/DIR=`"$installDir`""
  ) -Wait -PassThru
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
  $detachedManifestHash = (Get-FileHash -LiteralPath $detachedReleaseManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($installedManifestHash -cne $detachedManifestHash) {
    throw "Installed release manifest does not match the detached release manifest bytes."
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
  $webViewTargets = @()
  $webViewDeadline = (Get-Date).AddSeconds(40)
  while ((Get-Date) -lt $webViewDeadline) {
    $hostProc.Refresh()
    if ($hostProc.HasExited) {
      $hex = "0x{0:X8}" -f $hostProc.ExitCode
      throw "Desktop host exited during embedded Mission Control smoke with code $hex."
    }
    try {
      $webViewTargets = @(
        Invoke-RestMethod -Uri "http://127.0.0.1:$webViewDebugPort/json/list" -TimeoutSec 2 -ErrorAction Stop
      )
      $webViewTarget = $webViewTargets |
        Where-Object { $_.type -eq "page" -and $_.url -ne "about:blank" } |
        Select-Object -First 1
    }
    catch {
      $webViewTarget = $null
    }
    if ($webViewTarget) {
      break
    }
    Start-Sleep -Milliseconds 500
  }

  if (-not $webViewTarget) {
    $observedTargets = ($webViewTargets | ForEach-Object { "$($_.type):$($_.url)" }) -join ", "
    throw "Desktop host presented a titled window but its embedded Mission Control target remained blank. Observed WebView targets: $observedTargets"
  }
  $webViewUri = [Uri]$webViewTarget.url
  if ($webViewUri.Scheme -notin @("http", "https") -or
      $webViewUri.Host -notin @("127.0.0.1", "localhost", "::1", "[::1]")) {
    throw "Embedded Mission Control navigated outside the allowed loopback boundary: $($webViewTarget.url)"
  }
  if ($webViewTarget.title -ne "GoatCitadel Mission Control Next") {
    throw "Embedded Mission Control page title was '$($webViewTarget.title)'; expected 'GoatCitadel Mission Control Next'."
  }

  # Tear down the host and its WebView/runtime descendants before readiness and
  # uninstall checks so no file handle under the install directory remains open.
  if (-not $hostProc.HasExited) {
    & taskkill.exe /PID $hostProc.Id /T /F | Out-Null
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
  $launch = Start-Process -FilePath $bundledNode `
    -ArgumentList @($quotedLauncher, "launch", "--no-open", "--wait", "--json") `
    -WorkingDirectory $appHome `
    -RedirectStandardOutput $launchStdout `
    -RedirectStandardError $launchStderr `
    -NoNewWindow -PassThru
  if (-not $launch.WaitForExit(600000)) {
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
    throw "Runtime readiness smoke failed: 'goatcitadel launch --wait' did not exit within 10 minutes. Launcher output, runtime logs, and listener/process state are printed above."
  }
  if ($launch.ExitCode -ne 0) {
    Show-RuntimeLogs
    throw "Runtime readiness smoke failed: 'goatcitadel launch' exited $($launch.ExitCode) before the gateway/UI became healthy. The installed host would hang on 'Starting the local runtime…'. A gateway boot crash (for example ERR_MODULE_NOT_FOUND from stranded production dependencies) surfaces here."
  }

  # Re-poll both /health endpoints independently; this is the canonical ready assertion.
  $status = Start-Process -FilePath $bundledNode `
    -ArgumentList @($quotedLauncher, "status", "--json") `
    -WorkingDirectory $appHome `
    -RedirectStandardOutput $statusStdout `
    -RedirectStandardError $statusStderr `
    -NoNewWindow -Wait -PassThru
  $statusLine = $null
  if (Test-Path -LiteralPath $statusStdout) {
    $statusLine = Get-Content -LiteralPath $statusStdout -ErrorAction SilentlyContinue |
      Where-Object { $_.TrimStart().StartsWith("{") } |
      Select-Object -Last 1
  }
  if ($status.ExitCode -ne 0 -or -not $statusLine) {
    Show-RuntimeLogs
    throw "Runtime readiness smoke failed: 'goatcitadel status --json' exited $($status.ExitCode) without a JSON status line."
  }
  $runtimeStatus = $statusLine | ConvertFrom-Json
  if ($runtimeStatus.status -ne "ready" -or -not ($runtimeStatus.readiness.gateway -and $runtimeStatus.readiness.ui)) {
    Show-RuntimeLogs
    throw "Runtime readiness smoke failed: runtime status is '$($runtimeStatus.status)' (gateway healthy=$($runtimeStatus.readiness.gateway), ui healthy=$($runtimeStatus.readiness.ui)); expected 'ready' with both the gateway and Mission Control answering /health."
  }
  Write-Host "Runtime readiness smoke passed: gateway + Mission Control reached status=ready (gateway $($runtimeStatus.gatewayUrl)/health, ui $($runtimeStatus.uiUrl)/health)."

  Stop-InstalledProcesses
  Start-Sleep -Seconds 2

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
  if (Test-Path -LiteralPath $installDir) {
    Get-ChildItem -LiteralPath $installDir -Force -ErrorAction SilentlyContinue |
      ForEach-Object { Write-Host "Mutable state preserved by uninstall (expected): $($_.FullName)" }
    Remove-Item -LiteralPath $installDir -Recurse -Force -ErrorAction SilentlyContinue
  }

  Write-Host "Windows installer lifecycle smoke passed for $Target in $TrustMode trust mode."
}
finally {
  Stop-InstalledProcesses

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

  if ($cleanupFailures.Count -eq 0 -and (Test-Path -LiteralPath $smokeRoot)) {
    try {
      Remove-Item -LiteralPath $smokeRoot -Recurse -Force -ErrorAction Stop
    }
    catch {
      $cleanupFailures.Add("Installer smoke scratch cleanup failed: $($_.Exception.Message)")
    }
  }
  if (Test-Path -LiteralPath $smokeRoot) {
    if ($cleanupFailures.Count -eq 0) {
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
  if ($null -eq $previousWebViewBrowserArguments) {
    Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS -ErrorAction SilentlyContinue
  }
  else {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousWebViewBrowserArguments
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
  if ($cleanupFailures.Count -gt 0) {
    throw "Installer smoke cleanup failed: $($cleanupFailures -join ' ')"
  }
}
