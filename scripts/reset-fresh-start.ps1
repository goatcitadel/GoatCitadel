# Usage:
#   pnpm clear
#   pnpm clear -WhatIf
#   pnpm reset:fresh-start
#   pnpm reset:fresh-start -WhatIf
#   pnpm reset:fresh-start -IncludeWorkspaceOutputs
[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = "Medium")]
param(
  # Retain Windows PasswordVault entries only when testing a reset that keeps provider/channel credentials.
  [switch]$KeepCredentials,

  # Also archive generated Chat workspace data and generated output.
  # This deliberately leaves workspace fixtures and repository-managed skills untouched.
  [switch]$IncludeWorkspaceOutputs,

  # Reset GoatCitadel browser preferences/drafts on the next Vite dev launch.
  [switch]$ClearBrowserState
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

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss-fff"
$ResetId = [guid]::NewGuid().ToString()
$BackupDirectory = Join-Path $RepositoryRoot (".codex-tmp\fresh-reset-" + $timestamp + "-" + $ResetId)
$ArchivedPaths = New-Object System.Collections.Generic.List[string]

function Get-AbsolutePath([string]$RelativePath) {
  $resolved = [IO.Path]::GetFullPath((Join-Path $RepositoryRoot ($RelativePath -replace "/", "\")))
  if (-not $resolved.StartsWith($RepositoryRoot + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Reset path must stay inside this checkout: $RelativePath"
  }
  return $resolved
}

function Assert-NoReparsePoints([string]$RelativePath) {
  $absolute = Get-AbsolutePath $RelativePath
  # Check ancestors too: workspace/chat must not traverse a linked workspace.
  $cursor = $absolute
  while ($cursor -ne $RepositoryRoot) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to reset a symlink or junction: $cursor"
      }
    }
    $cursor = Split-Path -Parent $cursor
  }
  if (Test-Path -LiteralPath $absolute -PathType Container) {
    foreach ($item in @(Get-ChildItem -LiteralPath $absolute -Force -Recurse)) {
      if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
        throw "Refusing to reset a symlink or junction: $($item.FullName)"
      }
    }
  }
}

function Get-OptionalProperty($Object, [string]$Name) {
  if ($null -ne $Object -and $Object.PSObject.Properties[$Name]) {
    return $Object.$Name
  }
  return $null
}

function Assert-LocalDefaults {
  if ($env:NODE_ENV -eq "production") {
    throw "pnpm clear is for local development. Refusing NODE_ENV=production."
  }
  $overrideNames = @("GOATCITADEL_ROOT_DIR", "GOATCITADEL_BUNDLED_POSTGRES_DATA_DIR", "GOATCITADEL_DATABASE_DRIVER", "GOATCITADEL_POSTGRES_MODE", "GOATCITADEL_POSTGRES_CONNECTION_STRING", "GOATCITADEL_POSTGRES_CONNECTION_STRING_ENV", "GOATCITADEL_POSTGRES_HOST")
  foreach ($name in $overrideNames) {
    if ([Environment]::GetEnvironmentVariable($name)) {
      throw "Unset $name before clearing the default local development profile."
    }
  }
  $envFile = Get-AbsolutePath ".env"
  if (Test-Path -LiteralPath $envFile) {
    foreach ($line in @(Get-Content -LiteralPath $envFile)) {
      if ($line -match '^\s*(?:export\s+)?NODE_ENV\s*=\s*["'']?production(?:["'']?\s*(?:#.*)?)$') {
        throw "pnpm clear is for local development. Refusing NODE_ENV=production in .env."
      }
      if ($line -match '^\s*(?:export\s+)?([A-Z_]+)\s*=\s*(.+)$' -and $Matches[1] -in $overrideNames) {
        $value = $Matches[2].Trim().Trim('"').Trim("'")
        if ($value -and -not $value.StartsWith("#")) {
          throw "Remove $($Matches[1]) from .env before clearing the default local development profile."
        }
      }
    }
  }
  foreach ($relative in @("config/goatcitadel.json", "config/assistant.config.json")) {
    $absolute = Get-AbsolutePath $relative
    if (-not (Test-Path -LiteralPath $absolute)) { continue }
    try { $config = Get-Content -LiteralPath $absolute -Raw | ConvertFrom-Json } catch {
      throw "Unable to inspect $relative safely. Repair the config before resetting."
    }
    $assistant = if ($relative -eq "config/goatcitadel.json") { Get-OptionalProperty $config "assistant" } else { $config }
    $environment = Get-OptionalProperty $assistant "environment"
    if ($environment -and $environment -ne "local") {
      throw "pnpm clear is for the local development profile only."
    }
    foreach ($entry in @(@("dataDir", "data"), @("transcriptsDir", "data/transcripts"), @("auditDir", "data/audit"), @("workspaceDir", "workspace"))) {
      $configured = Get-OptionalProperty $assistant $entry[0]
      if ($configured -and [IO.Path]::GetFullPath((Join-Path $RepositoryRoot $configured)) -ne (Get-AbsolutePath $entry[1])) {
        throw "Custom $($entry[0]) is configured. Refusing an incomplete reset; use a separate default local checkout."
      }
    }
    $database = Get-OptionalProperty $assistant "database"
    $postgres = Get-OptionalProperty $database "postgres"
    $mode = Get-OptionalProperty $postgres "mode"
    if ($mode -and $mode -ne "bundled") {
      throw "An external database is configured. pnpm clear only resets bundled local storage."
    }
    if ((Get-OptionalProperty $postgres "connectionString") -or (Get-OptionalProperty $postgres "host")) {
      throw "An explicit PostgreSQL endpoint is configured. pnpm clear only resets bundled local storage."
    }
    $bundled = Get-OptionalProperty $database "bundledPostgres"
    $configured = Get-OptionalProperty $bundled "dataDir"
    if ($configured -and [IO.Path]::GetFullPath((Join-Path $RepositoryRoot $configured)) -ne (Get-AbsolutePath "data/postgres")) {
      throw "Custom bundled PostgreSQL storage is configured. Refusing an incomplete reset."
    }
  }
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
    Assert-NoReparsePoints $RelativePath
    Assert-NoReparsePoints ".codex-tmp"
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
        $_.CommandLine -match ($rootPattern + '[\\/]') -and
        $_.CommandLine -match '(?:[\\/]scripts[\\/]dev\.mjs|[\\/](?:src|dist)[\\/]dev-supervisor\.(?:ts|js)|[\\/]vite[\\/]bin[\\/]vite\.js)(?:["\s]|$)'
      }
  )

  foreach ($supervisor in $supervisors) {
    if (-not (Get-Process -Id $supervisor.ProcessId -ErrorAction SilentlyContinue)) { continue }
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
  if ((Test-Path -LiteralPath (Join-Path $dataDirectory "PG_VERSION")) -and
      -not (Test-Path -LiteralPath (Join-Path $dataDirectory ".goatcitadel-native-bundled-postgres"))) {
    throw "This cluster is not marked as GoatCitadel native PostgreSQL. Stop Docker or the custom database and reset it separately."
  }
  if (-not (Test-Path -LiteralPath (Join-Path $dataDirectory "postmaster.pid"))) {
    return
  }

  $pgCtl = @(Find-PgCtl)
  if ($pgCtl.Count -eq 0) {
    throw "data/postgres exists, but pg_ctl.exe was not found. Refusing to move a possibly running database."
  }

  & $pgCtl[0] -D $dataDirectory status *> $null
  if ($LASTEXITCODE -eq 3) {
    return
  }
  if ($LASTEXITCODE -ne 0) {
    throw "Unable to establish whether bundled PostgreSQL is stopped. Refusing to move it."
  }

  if ($PSCmdlet.ShouldProcess("Bundled PostgreSQL at $dataDirectory", "stop")) {
    & $pgCtl[0] -D $dataDirectory -w -t 30 stop -m fast | Out-Null
    if ($LASTEXITCODE -ne 0) {
      throw "Could not stop the bundled PostgreSQL instance."
    }
    Write-Host "Stopped bundled PostgreSQL."
  }
}

function Write-ResetManifest([string]$Status, [string]$CredentialStatus, $BrowserResetId) {
  if ($PSCmdlet.ShouldProcess($BackupDirectory, "write reset manifest")) {
    New-Item -ItemType Directory -Path $BackupDirectory -Force | Out-Null
    $manifest = [ordered]@{
      resetAtUtc = (Get-Date).ToUniversalTime().ToString("o")
      repositoryRoot = $RepositoryRoot
      resetStatus = $Status
      includeWorkspaceOutputs = [bool]$IncludeWorkspaceOutputs
      credentialResetStatus = $CredentialStatus
      credentialsCleared = $CredentialStatus -eq "cleared"
      browserResetId = $BrowserResetId
      archivedPaths = @($ArchivedPaths)
      browserNote = "Use a private browser window or clear localhost site data for a fully clean browser session."
    } | ConvertTo-Json -Depth 3
    [IO.File]::WriteAllText((Join-Path $BackupDirectory "reset-manifest.json"), $manifest + [Environment]::NewLine, [Text.UTF8Encoding]::new($false))
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
$entries = @()
try { $entries = @($vault.RetrieveAll()) } catch {
  # PasswordVault reports ERROR_NOT_FOUND when the entire vault is empty.
  if ($_.Exception.GetBaseException().HResult -ne -2147023728) { throw }
}
$matches = @($entries | Where-Object { $_.Resource -eq "goatcitadel" })
foreach ($entry in $matches) { $vault.Remove($entry) }
Write-Output ("Removed {0} GoatCitadel PasswordVault credential(s)." -f $matches.Count)
'@

  if ($PSCmdlet.ShouldProcess("Windows PasswordVault entries where Resource is goatcitadel", "remove")) {
    # Windows PowerShell flattens native argv; -Command loses embedded double
    # quotes when this helper is launched from another PowerShell process.
    $encodedCommand = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($vaultCommand))
    & $windowsPowerShell -NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encodedCommand
    if ($LASTEXITCODE -ne 0) {
      throw "Could not clear GoatCitadel PasswordVault entries."
    }
  }
}

Write-Host "Preparing fresh GoatCitadel startup reset in $RepositoryRoot"
Write-Host "Saved settings, chats, memory, and local database files will be archived. Source and dependencies are preserved."
Write-Host "File backup destination: $BackupDirectory"
if (-not $KeepCredentials) {
  Write-Host "GoatCitadel PasswordVault credentials are shared by all GoatCitadel installs for this Windows account and will be removed."
}
$ResetPaths = @("config", "data", "runtime", ".env")
if ($IncludeWorkspaceOutputs) {
  $ResetPaths += @("workspace/chat", "workspace/memory", "workspace/goatcitadel_out", ".goatcitadel/self-improvement")
}
# Validate every root before stopping processes or moving anything.
foreach ($path in @($ResetPaths) + @(".codex-tmp")) { Assert-NoReparsePoints $path }
Assert-LocalDefaults
# Verify Git is available before any side effects.
$null = Get-TrackedPaths "config"
Stop-DevSupervisor

if (-not $WhatIfPreference) {
  $listeners = @(Get-NetTCPConnection -State Listen -ErrorAction Stop | Where-Object { $_.LocalPort -in @(5173, 8787) })
  if ($listeners.Count -gt 0) {
    throw "A UI or gateway is still listening on a default dev port. Stop pnpm dev (or the installed app) manually, then rerun pnpm clear."
  }
}
Stop-BundledPostgres

# These roots contain runtime state. Archive only untracked entries so that examples,
# metadata, and tracked .gitkeep placeholders remain present after the reset.
foreach ($path in $ResetPaths) {
  Archive-UntrackedPath $path
}

$CredentialStatus = if ($KeepCredentials) { "kept" } else { "pending" }
$BrowserResetId = $null
if (-not $WhatIfPreference) { Write-ResetManifest "pending" $CredentialStatus $null }
try {
  Clear-GoatCitadelCredentials
  if (-not $KeepCredentials -and -not $WhatIfPreference) { $CredentialStatus = "cleared" }

  if ($ClearBrowserState -and $PSCmdlet.ShouldProcess("runtime/dev-reset-id", "request browser preference and draft reset on next dev launch")) {
    $runtimeDirectory = Get-AbsolutePath "runtime"
    New-Item -ItemType Directory -Path $runtimeDirectory -Force | Out-Null
    $ResetId | Set-Content -LiteralPath (Join-Path $runtimeDirectory "dev-reset-id") -Encoding ascii
    $BrowserResetId = $ResetId
  }
  Write-ResetManifest "complete" $CredentialStatus $BrowserResetId
} catch {
  if ($CredentialStatus -eq "pending") { $CredentialStatus = "failed" }
  Write-ResetManifest "failed" $CredentialStatus $BrowserResetId
  Write-Host "Reset incomplete. Archived files and reset manifest are preserved at $BackupDirectory"
  throw
}

if ($WhatIfPreference) {
  Write-Host "Preview complete. Nothing was stopped, moved, or cleared."
  return
}
Write-Host "Fresh startup reset complete. Backup: $BackupDirectory"
Write-Host "Run pnpm dev, then reload GoatCitadel. Reconnect providers, including ChatGPT OAuth, in Settings."
if ($ClearBrowserState) {
  Write-Host "GoatCitadel browser preferences and drafts will reset on next dev page load. ChatGPT website cookies are preserved."
} else {
  Write-Host "Use a private browser window or clear localhost site data to reset browser preferences too."
}
if (-not $IncludeWorkspaceOutputs) {
  Write-Host "Generated Chat output was preserved. Add -IncludeWorkspaceOutputs to archive it too."
}
Write-Host "Git worktrees, workspace fixtures, skills, models outside the reset roots, and installed-app data are preserved."
