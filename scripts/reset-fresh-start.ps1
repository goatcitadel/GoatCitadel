# Usage:
#   pnpm reset:fresh-start
#   pnpm reset:fresh-start -- -WhatIf
#   pnpm reset:fresh-start -- -IncludeWorkspaceOutputs
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
  # Retain Windows PasswordVault entries only when testing a reset that keeps provider/channel credentials.
  [switch]$KeepCredentials,

  # Also archive generated Chat workspace data, generated output, and disposable Code Mode worktrees.
  # This deliberately leaves workspace fixtures and repository-managed skills untouched.
  [switch]$IncludeWorkspaceOutputs
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$RepositoryRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot "..")).Path
$PackagePath = Join-Path $RepositoryRoot "package.json"
if (-not (Test-Path -LiteralPath $PackagePath)) {
  throw "Refusing to run outside a GoatCitadel repository: $RepositoryRoot"
}

$Package = Get-Content -LiteralPath $PackagePath -Raw | ConvertFrom-Json
if ($Package.name -ne "goatcitadel") {
  throw "Refusing to run against an unexpected package: $($Package.name)"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$BackupDirectory = Join-Path $RepositoryRoot (".codex-tmp\fresh-reset-" + $timestamp)
$ArchivedPaths = New-Object System.Collections.Generic.List[string]

function Get-AbsolutePath([string]$RelativePath) {
  return Join-Path $RepositoryRoot ($RelativePath -replace "/", "\")
}

function Get-TrackedPaths([string]$RelativePath) {
  $paths = @(& git -C $RepositoryRoot ls-files -- $RelativePath 2>$null)
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to inspect tracked paths before reset: $RelativePath"
  }
  return @($paths | Where-Object { $_ })
}

function Archive-UntrackedPath([string]$RelativePath) {
  $sourcePath = Get-AbsolutePath $RelativePath
  if (-not (Test-Path -LiteralPath $sourcePath)) {
    return
  }

  $trackedPaths = @(Get-TrackedPaths $RelativePath)
  $item = Get-Item -LiteralPath $sourcePath -Force
  if ($item.PSIsContainer -and $trackedPaths.Count -gt 0) {
    foreach ($child in @(Get-ChildItem -LiteralPath $sourcePath -Force)) {
      Archive-UntrackedPath ((Join-Path $RelativePath $child.Name) -replace "\\", "/")
    }
    return
  }

  if (-not $item.PSIsContainer -and $trackedPaths.Count -gt 0) {
    return
  }

  $destinationPath = Join-Path $BackupDirectory ($RelativePath -replace "/", "\")
  $destinationParent = Split-Path -Parent $destinationPath
  if ($PSCmdlet.ShouldProcess($sourcePath, "archive to $destinationPath")) {
    New-Item -ItemType Directory -Path $destinationParent -Force | Out-Null
    Move-Item -LiteralPath $sourcePath -Destination $destinationPath -Force
    $ArchivedPaths.Add($RelativePath)
  }
}

function Stop-DevSupervisor {
  $rootPattern = [regex]::Escape($RepositoryRoot)
  # Process enumeration is read-only. Disable WhatIf just for this query so PowerShell
  # does not print module auto-import noise when the caller is previewing a reset.
  $savedWhatIfPreference = $WhatIfPreference
  try {
    $WhatIfPreference = $false
    $nodeProcesses = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'")
  } finally {
    $WhatIfPreference = $savedWhatIfPreference
  }
  $supervisors = @(
    $nodeProcesses |
      Where-Object {
        $_.CommandLine -and
        $_.CommandLine -match $rootPattern -and
        $_.CommandLine -match '[\\/]scripts[\\/]dev\.mjs(?:\s|$)'
      }
  )

  foreach ($supervisor in $supervisors) {
    $target = "GoatCitadel dev supervisor PID $($supervisor.ProcessId)"
    if ($PSCmdlet.ShouldProcess($target, "stop process tree")) {
      & "$env:SystemRoot\System32\taskkill.exe" /PID $supervisor.ProcessId /T /F | Out-Null
      if ($LASTEXITCODE -ne 0) {
        throw "Could not stop $target. Stop pnpm dev manually, then rerun the reset."
      }
      Write-Host "Stopped $target."
    }
  }
}

function Find-PgCtl {
  $candidates = @()
  if ($env:ProgramFiles) {
    $candidates += Get-ChildItem -Path (Join-Path $env:ProgramFiles "PostgreSQL") -Filter "pg_ctl.exe" -Recurse -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty FullName
  }
  # Get-Command is non-throwing when PostgreSQL is not installed. `where.exe`
  # reports its ordinary "not found" result as a native-command error under
  # the script's strict error policy, which would make even a safe -WhatIf
  # reset fail on a machine without pg_ctl on PATH.
  $candidates += @(Get-Command -Name "pg_ctl.exe" -CommandType Application -All -ErrorAction SilentlyContinue |
      Select-Object -ExpandProperty Source)
  return @($candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1)
}

function Stop-BundledPostgres {
  $dataDirectory = Get-AbsolutePath "data/postgres"
  if (-not (Test-Path -LiteralPath $dataDirectory)) {
    return
  }

  $pgCtl = @(Find-PgCtl)
  if ($pgCtl.Count -eq 0) {
    throw "data/postgres exists, but pg_ctl.exe was not found. Refusing to move a possibly running database."
  }

  & $pgCtl[0] -D $dataDirectory status *> $null
  if ($LASTEXITCODE -ne 0) {
    return
  }

  if ($PSCmdlet.ShouldProcess("Bundled PostgreSQL at $dataDirectory", "stop")) {
    & $pgCtl[0] -D $dataDirectory -w -t 60 stop -m fast | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Could not stop the bundled PostgreSQL instance."
    }
    Write-Host "Stopped bundled PostgreSQL."
  }
}

function Clear-GoatCitadelCredentials {
  if ($KeepCredentials) {
    Write-Host "Kept Windows PasswordVault credentials by request."
    return
  }

  $windowsPowerShell = Join-Path $env:SystemRoot "System32\WindowsPowerShell\v1.0\powershell.exe"
  if (-not (Test-Path -LiteralPath $windowsPowerShell)) {
    throw "Windows PowerShell is required to clear GoatCitadel PasswordVault entries."
  }

  $vaultCommand = @'
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$vault = [Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new()
$matches = @($vault.RetrieveAll() | Where-Object { $_.Resource -eq "goatcitadel" })
foreach ($entry in $matches) { $vault.Remove($entry) }
Write-Output ("Removed {0} GoatCitadel PasswordVault credential(s)." -f $matches.Count)
'@

  if ($PSCmdlet.ShouldProcess("Windows PasswordVault entries where Resource is goatcitadel", "remove")) {
    & $windowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command $vaultCommand
    if ($LASTEXITCODE -ne 0) {
      throw "Could not clear GoatCitadel PasswordVault entries."
    }
  }
}

Write-Host "Preparing fresh GoatCitadel startup reset in $RepositoryRoot"
Stop-DevSupervisor
Stop-BundledPostgres

# These roots contain runtime state. Archive only untracked entries so that examples,
# metadata, and tracked .gitkeep placeholders remain present after the reset.
foreach ($path in @("config", "data", "runtime", ".env")) {
  Archive-UntrackedPath $path
}

if ($IncludeWorkspaceOutputs) {
  foreach ($path in @("workspace/chat", "workspace/goatcitadel_out", ".worktrees")) {
    Archive-UntrackedPath $path
  }
}

Clear-GoatCitadelCredentials

if ($PSCmdlet.ShouldProcess($BackupDirectory, "write reset manifest")) {
  New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
  [ordered]@{
    resetAtUtc = (Get-Date).ToUniversalTime().ToString("o")
    repositoryRoot = $RepositoryRoot
    includeWorkspaceOutputs = [bool]$IncludeWorkspaceOutputs
    credentialsCleared = -not [bool]$KeepCredentials
    archivedPaths = @($ArchivedPaths)
    browserNote = "Use a private browser window or clear localhost site data for a fully clean browser session."
  } | ConvertTo-Json -Depth 3 | Set-Content -LiteralPath (Join-Path $BackupDirectory "reset-manifest.json") -Encoding utf8
}

Write-Host "Fresh startup reset complete. Backup: $BackupDirectory"
Write-Host "Run pnpm dev, then open GoatCitadel in a private browser window."
if (-not $IncludeWorkspaceOutputs) {
  Write-Host "Workspace, generated output, and Code Mode worktrees were preserved. Add -IncludeWorkspaceOutputs to archive those too."
}
