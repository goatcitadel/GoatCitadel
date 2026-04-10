param(
  [string]$RepoUrl = "https://github.com/goatcitadel/GoatCitadel.git",
  [string]$InstallDir = "",
  [ValidateSet("git")]
  [string]$InstallMethod = "git",
  [switch]$NoPathUpdate,
  [switch]$SkipVoice,
  [string]$VoiceModel = "base.en"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Require-Command {
  param([Parameter(Mandatory = $true)][string]$Name)
  if (-not (Get-Command $Name -ErrorAction SilentlyContinue)) {
    throw "Missing required command: $Name"
  }
}

function Invoke-NativeOrThrow {
  param(
    [Parameter(Mandatory = $true)][string]$FilePath,
    [string[]]$Arguments = @(),
    [string]$FailureMessage = ""
  )

  & $FilePath @Arguments
  $exitCode = $LASTEXITCODE
  if ($exitCode -ne 0) {
    $renderedArgs = if ($Arguments.Count -gt 0) { " $($Arguments -join ' ')" } else { "" }
    $message = if ([string]::IsNullOrWhiteSpace($FailureMessage)) {
      "Command failed with exit code ${exitCode}: ${FilePath}${renderedArgs}"
    } else {
      "$FailureMessage (exit code $exitCode)"
    }
    throw $message
  }
}

function Write-InstallExplanation {
  param(
    [Parameter(Mandatory = $true)][string]$Title,
    [Parameter(Mandatory = $true)][string]$What,
    [Parameter(Mandatory = $true)][string]$Why
  )

  Write-Host $Title
  Write-Host "  What: $What"
  Write-Host "  Why: $Why"
}

function Invoke-PnpmInstallWithRecovery {
  param([Parameter(Mandatory = $true)][string]$RepositoryPath)

  Write-InstallExplanation -Title "Installing workspace dependencies..." `
    -What "GoatCitadel's local package graph and command shims under node_modules/.bin" `
    -Why "GoatCitadel build, doctor, and verification commands depend on local tools like tsc, tsx, vitest, and other workspace executables."
  try {
    Invoke-NativeOrThrow -FilePath "pnpm" -Arguments @("--dir", $RepositoryPath, "install", "--frozen-lockfile") -FailureMessage "Failed to install GoatCitadel workspace dependencies"
    return
  } catch {
    Write-Warning "Frozen-lockfile install failed. GoatCitadel will retry with --no-frozen-lockfile so it can refresh lock metadata and restore the local toolchain if manifests moved ahead of pnpm-lock.yaml."
    Invoke-NativeOrThrow -FilePath "pnpm" -Arguments @("--dir", $RepositoryPath, "install", "--no-frozen-lockfile") -FailureMessage "Failed to install GoatCitadel workspace dependencies after lockfile recovery retry"
  }
}

function Get-DirtyTrackedPaths {
  param([Parameter(Mandatory = $true)][string]$RepositoryPath)

  $output = & git -C $RepositoryPath status --porcelain --untracked-files=no
  if ($LASTEXITCODE -ne 0) {
    throw "Failed to inspect GoatCitadel working tree state."
  }
  if ([string]::IsNullOrWhiteSpace($output)) {
    return @()
  }

  return @($output -split "`r?`n" | Where-Object { $_.Trim() -ne "" } | ForEach-Object {
    $_.Substring(3).Trim()
  })
}

function Preserve-ManagedConfigForUpdate {
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryPath,
    [Parameter(Mandatory = $true)][string[]]$ManagedPaths
  )

  $dirtyTrackedPaths = Get-DirtyTrackedPaths -RepositoryPath $RepositoryPath

  $managedSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($managedPath in $ManagedPaths) {
    [void]$managedSet.Add($managedPath)
  }

  $unexpected = @($dirtyTrackedPaths | Where-Object { -not $managedSet.Contains($_) })
  $existingConfigPaths = @($ManagedPaths | Where-Object { Test-Path (Join-Path $RepositoryPath $_) })
  if ($existingConfigPaths.Count -eq 0 -and $unexpected.Count -eq 0) {
    return $null
  }

  $backupRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("goatcitadel-update-" + [guid]::NewGuid())
  New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
  $pathsToArchive = @($existingConfigPaths + $unexpected | Select-Object -Unique)
  foreach ($relativePath in $pathsToArchive) {
    $sourcePath = Join-Path $RepositoryPath $relativePath
    if (-not (Test-Path $sourcePath)) {
      continue
    }
    $backupPath = Join-Path $backupRoot $relativePath
    $backupDir = Split-Path -Parent $backupPath
    if (-not [string]::IsNullOrWhiteSpace($backupDir)) {
      New-Item -ItemType Directory -Force -Path $backupDir | Out-Null
    }
    Copy-Item -Path $sourcePath -Destination $backupPath -Force
  }
  foreach ($relativePath in $dirtyTrackedPaths) {
    Invoke-NativeOrThrow -FilePath "git" -Arguments @("-C", $RepositoryPath, "restore", "--source=HEAD", "--", $relativePath) -FailureMessage "Failed to temporarily restore managed config before update"
  }

  return [pscustomobject]@{
    BackupRoot = $backupRoot
    Paths = $existingConfigPaths
    ArchivedPaths = $unexpected
  }
}

function Restore-PreservedManagedConfig {
  param(
    [Parameter(Mandatory = $true)][string]$RepositoryPath,
    $PreservedState
  )

  if ($null -eq $PreservedState) {
    return
  }

  foreach ($relativePath in $PreservedState.Paths) {
    $backupPath = Join-Path $PreservedState.BackupRoot $relativePath
    if (-not (Test-Path $backupPath)) {
      continue
    }
    $destinationPath = Join-Path $RepositoryPath $relativePath
    $destinationDir = Split-Path -Parent $destinationPath
    if (-not [string]::IsNullOrWhiteSpace($destinationDir)) {
      New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null
    }
    Copy-Item -Path $backupPath -Destination $destinationPath -Force
  }
}

if ([string]::IsNullOrWhiteSpace($InstallDir)) {
  $BaseDir = Join-Path $HOME ".GoatCitadel"
} else {
  $BaseDir = [System.IO.Path]::GetFullPath($InstallDir)
}

$AppDir = Join-Path $BaseDir "app"
$BinDir = Join-Path $BaseDir "bin"
$PnpmVersion = "10.31.0"
$WorkspaceRuntimeBuildPackages = @(
  "@goatcitadel/contracts"
  "@goatcitadel/extensions-sdk"
  "@goatcitadel/memory-core"
  "@goatcitadel/storage"
  "@goatcitadel/gateway-core"
  "@goatcitadel/mesh-core"
  "@goatcitadel/orchestration"
  "@goatcitadel/skills"
  "@goatcitadel/policy-engine"
)
$ManagedLocalConfigPaths = @(
  "config/assistant.config.json",
  "config/tool-policy.json",
  "config/budgets.json",
  "config/llm-providers.json",
  "config/cron-jobs.json",
  "config/goatcitadel.json",
  "config/private-beta.profile.json",
  "data/onboarding-state.json"
)
$preservedManagedConfig = $null

if ($InstallMethod -ne "git") {
  throw "Unsupported install method '$InstallMethod'. Only 'git' is supported."
}

Require-Command "git"
Require-Command "node"
Require-Command "corepack"
$corepackExecutable = (Get-Command "corepack").Source

New-Item -ItemType Directory -Force -Path $BaseDir | Out-Null
New-Item -ItemType Directory -Force -Path $BinDir | Out-Null

if (Test-Path (Join-Path $AppDir ".git")) {
  Write-Host "Updating existing GoatCitadel install in $AppDir..."
  Invoke-NativeOrThrow -FilePath "git" -Arguments @("-C", $AppDir, "fetch", "--all", "--prune") -FailureMessage "Failed to fetch latest GoatCitadel changes"
  $preservedManagedConfig = Preserve-ManagedConfigForUpdate -RepositoryPath $AppDir -ManagedPaths $ManagedLocalConfigPaths
  Invoke-NativeOrThrow -FilePath "git" -Arguments @("-C", $AppDir, "pull", "--ff-only") -FailureMessage "Failed to fast-forward GoatCitadel install"
  Restore-PreservedManagedConfig -RepositoryPath $AppDir -PreservedState $preservedManagedConfig
  if ($null -ne $preservedManagedConfig -and $preservedManagedConfig.ArchivedPaths.Count -gt 0) {
    Write-Warning "Archived local tracked changes before update to $($preservedManagedConfig.BackupRoot). Archived paths: $($preservedManagedConfig.ArchivedPaths -join ', ')"
  }
} else {
  if (Test-Path $AppDir) {
    Write-Host "Removing non-git directory at $AppDir..."
    Remove-Item -Path $AppDir -Recurse -Force
  }
  Write-Host "Cloning GoatCitadel from $RepoUrl..."
  Invoke-NativeOrThrow -FilePath "git" -Arguments @("clone", $RepoUrl, $AppDir) -FailureMessage "Failed to clone GoatCitadel repository"
}

Write-InstallExplanation -Title "Preparing pnpm ($PnpmVersion)..." `
  -What "the managed pnpm launcher for GoatCitadel's workspace" `
  -Why "GoatCitadel uses pnpm to materialize local package binaries and run workspace build, doctor, and verification commands."
Invoke-NativeOrThrow -FilePath "corepack" -Arguments @("enable") -FailureMessage "Failed to enable Corepack"
Invoke-NativeOrThrow -FilePath "corepack" -Arguments @("prepare", "pnpm@$PnpmVersion", "--activate") -FailureMessage "Failed to activate pnpm $PnpmVersion"

$lockfilePath = Join-Path $AppDir "pnpm-lock.yaml"
if (-not (Test-Path $lockfilePath)) {
  throw "Install source is missing pnpm-lock.yaml; this build cannot be installed with --frozen-lockfile."
}
Invoke-PnpmInstallWithRecovery -RepositoryPath $AppDir
foreach ($workspacePackage in $WorkspaceRuntimeBuildPackages) {
  Write-Host "Building runtime package $workspacePackage..."
  Invoke-NativeOrThrow -FilePath "pnpm" -Arguments @("--dir", $AppDir, "--filter", $workspacePackage, "build") -FailureMessage "Failed to build required GoatCitadel workspace package $workspacePackage"
}
Write-Host "Materializing local config from tracked examples..."
Invoke-NativeOrThrow -FilePath "pnpm" -Arguments @("--dir", $AppDir, "config:sync") -FailureMessage "Failed to materialize GoatCitadel config from tracked examples"
$privateBetaExample = Join-Path $AppDir "config\private-beta.profile.example.json"
$privateBetaConfig = Join-Path $AppDir "config\private-beta.profile.json"
if ((Test-Path $privateBetaExample) -and -not (Test-Path $privateBetaConfig)) {
  Copy-Item -Path $privateBetaExample -Destination $privateBetaConfig -Force
}
$envExamplePath = Join-Path $AppDir ".env.example"
$envPath = Join-Path $AppDir ".env"
if ((Test-Path $envExamplePath) -and -not (Test-Path $envPath)) {
  Write-Host "Materializing local .env from .env.example..."
  Copy-Item -Path $envExamplePath -Destination $envPath -Force
}
Write-InstallExplanation -Title "Installing Playwright Chromium runtime..." `
  -What "the managed Chromium browser used by GoatCitadel browser automation" `
  -Why "Browser tools, screenshot capture, and Playwright-backed verification flows need a local browser runtime to run safely and predictably."
Invoke-NativeOrThrow -FilePath "pnpm" -Arguments @("--dir", $AppDir, "--filter", "@goatcitadel/policy-engine", "exec", "playwright", "install", "chromium") -FailureMessage "Failed to install required Playwright Chromium runtime"
if (-not $SkipVoice) {
  Write-InstallExplanation -Title "Installing managed local voice runtime ($VoiceModel)..." `
    -What "the managed local whisper.cpp voice runtime" `
    -Why "Voice transcription and local speech features need a downloaded runtime before GoatCitadel can use them."
  try {
    Invoke-NativeOrThrow -FilePath "pnpm" -Arguments @("--dir", $AppDir, "--filter", "@goatcitadel/gateway", "run", "voice:runtime", "install", "--model", $VoiceModel) -FailureMessage "Failed to install managed voice runtime"
  } catch {
    Write-Warning "Managed voice runtime install failed. Core GoatCitadel install is complete. Repair later with '$BinDir\goatcitadel.cmd voice install'."
  }
}

$launcherCmd = @"
@echo off
setlocal
set "GOATCITADEL_HOME=$($BaseDir)"
set "PATH=$($BinDir);%PATH%"
node "$($AppDir)\bin\goatcitadel.mjs" %*
exit /b %ERRORLEVEL%
"@

$launcherPs1 = @"
param(
  [Parameter(ValueFromRemainingArguments = `$true)]
  [string[]]`$Args
)
`$cmd = "help"
if (`$Args.Count -gt 0) {
  `$cmd = `$Args[0]
  if (`$Args.Count -gt 1) {
    `$Args = `$Args[1..(`$Args.Count - 1)]
  } else {
    `$Args = @()
  }
}
& "$($BinDir)\goatcitadel.cmd" `$cmd @Args
"@

$pnpmCmd = @"
@echo off
setlocal
"$($corepackExecutable)" pnpm %*
exit /b %ERRORLEVEL%
"@

$pnpmPs1 = @"
param(
  [Parameter(ValueFromRemainingArguments = `$true)]
  [string[]]`$Args
)
& "$($corepackExecutable)" "pnpm" @Args
"@

$launcherCmdPath = Join-Path $BinDir "goatcitadel.cmd"
$launcherPs1Path = Join-Path $BinDir "goatcitadel.ps1"
$launcherGoatCmdPath = Join-Path $BinDir "goat.cmd"
$launcherGoatPs1Path = Join-Path $BinDir "goat.ps1"
$pnpmCmdPath = Join-Path $BinDir "pnpm.cmd"
$pnpmPs1Path = Join-Path $BinDir "pnpm.ps1"
$launcherGcCmdPath = Join-Path $BinDir "gc.cmd"
$launcherGcPs1Path = Join-Path $BinDir "gc.ps1"

Set-Content -Path $launcherCmdPath -Value $launcherCmd -Encoding Ascii
Set-Content -Path $launcherPs1Path -Value $launcherPs1 -Encoding Ascii
Set-Content -Path $launcherGoatCmdPath -Value $launcherCmd -Encoding Ascii
Set-Content -Path $launcherGoatPs1Path -Value $launcherPs1 -Encoding Ascii
Set-Content -Path $pnpmCmdPath -Value $pnpmCmd -Encoding Ascii
Set-Content -Path $pnpmPs1Path -Value $pnpmPs1 -Encoding Ascii
Set-Content -Path $launcherGcCmdPath -Value $launcherCmd -Encoding Ascii
Set-Content -Path $launcherGcPs1Path -Value $launcherPs1 -Encoding Ascii

if (-not $NoPathUpdate) {
  $currentPath = [Environment]::GetEnvironmentVariable("Path", "User")
  $parts = @()
  if (-not [string]::IsNullOrWhiteSpace($currentPath)) {
    $parts = $currentPath -split ";" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
  }
  if (-not ($parts -contains $BinDir)) {
    $next = if ($parts.Count -eq 0) { $BinDir } else { ($parts + $BinDir) -join ";" }
    [Environment]::SetEnvironmentVariable("Path", $next, "User")
  }
  if (-not (($env:Path -split ";") -contains $BinDir)) {
    $env:Path = "$BinDir;$env:Path"
  }
}

Write-Host ""
Write-Host "GoatCitadel install complete."
Write-Host "Install directory: $AppDir"
Write-Host "Launcher: $launcherCmdPath"
Write-Host ""
Write-Host "Run:"
Write-Host "  goatcitadel verify install"
Write-Host "  goatcitadel up"
Write-Host "  goatcitadel onboard"
Write-Host "  goatcitadel doctor --deep"
Write-Host "  goatcitadel voice status"
Write-Host "  goat verify install"
Write-Host "  goat onboard"
Write-Host "  goat up"
Write-Host "  goat doctor --deep"
Write-Host "  goat voice status"
Write-Host ""
Write-Host "PowerShell notes:"
Write-Host "  - Open a new PowerShell window if 'goatcitadel' is not found yet."
Write-Host "  - The installer updates your user PATH for new shells, not the already-running parent shell."
Write-Host "  - Use 'goatcitadel' or 'goat' in PowerShell. Do not use 'gc' there because it maps to Get-Content."
Write-Host "  - Onboarding uses the live gateway API. Start with 'goat up' first, then run onboarding."
Write-Host "  - Managed GoatCitadel config is preserved across installer updates."
Write-Host "  - Immediate fallback: & `"$launcherCmdPath`" onboard"
