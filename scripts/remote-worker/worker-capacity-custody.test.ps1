#Requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$FixtureRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'worker-install-common.ps1')
Initialize-WorkerInstallNative
# Create-only ordinary fixtures. No service, privilege or virtual-disk calls.
New-Item -ItemType Directory -Path $FixtureRoot -ErrorAction Stop | Out-Null
$native = [GoatCitadel.RemoteWorker.Install.NativeFiles]
$pins = [Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
$checks = 0
function Check-Case { param([bool]$Valid); if (-not $Valid) { throw 'Capacity custody check failed.' }; $script:checks++ }
function Check-Refusal { param([scriptblock]$Body); $refused=$false; try { & $Body | Out-Null } catch { $refused=$true }; Check-Case $refused }
try {
  for ($index=0; $index -lt 13; $index++) {
    $directory = Join-Path $FixtureRoot ('area-' + $index)
    New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null
    $pins.Add([GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::PinDirectory($directory))
  }
  $roots = $pins.ToArray()
  $bytes = $native::CreateCellCapacityCustody($roots)
  Check-Case ($bytes.Length -eq 320)
  Check-Case ([Text.Encoding]::ASCII.GetString($bytes,0,8) -ceq 'GCCAPS01')
  for ($index=0; $index -lt 13; $index++) {
    $identity = $native::GetCellDirectoryIdentity($roots[$index])
    Check-Case ([Convert]::ToBase64String($bytes,8+24*$index,24) -ceq [Convert]::ToBase64String($identity))
  }
  Check-Refusal { $native::CreateCellCapacityCustody($null) }
  Check-Refusal { $native::CreateCellCapacityCustody([Microsoft.Win32.SafeHandles.SafeFileHandle[]]@()) }
  $duplicate = [Microsoft.Win32.SafeHandles.SafeFileHandle[]]$roots.Clone()
  $duplicate[12] = $duplicate[0]
  Check-Refusal { $native::CreateCellCapacityCustody($duplicate) }
  $missing = [Microsoft.Win32.SafeHandles.SafeFileHandle[]]$roots.Clone()
  $missing[12] = $null
  Check-Refusal { $native::CreateCellCapacityCustody($missing) }
  [IO.File]::WriteAllBytes((Join-Path $FixtureRoot 'capacity.identity'),$bytes)
  $layoutRoot = Join-Path $FixtureRoot 'installed-layout'
  $areas = Get-WorkerCellCapacityPaths $layoutRoot
  Check-Case (-not (Test-Path -LiteralPath $layoutRoot))
  Check-Case (($areas.Keys -join ',') -ceq 'mutable_root,input_staging,backup_staging,artifact_staging,immutable_artifact,retained_outbox,database_sidecar,backup_publication,manifest,proxy_sidecar,diagnostic,failed_cleanup,quarantine_evidence')
  Check-Case ($areas.mutable_root -ceq (Join-Path $layoutRoot 'cells'))
  foreach ($name in @('input_staging','backup_staging','artifact_staging','immutable_artifact',
      'retained_outbox','database_sidecar','backup_publication','manifest','proxy_sidecar',
      'diagnostic','failed_cleanup','quarantine_evidence')) {
    Check-Case ($areas[$name] -ceq (Join-Path (Join-Path $layoutRoot 'state') $name.Replace('_','-')))
  }
  Check-Refusal { Get-WorkerCellCapacityPaths '\\server\share\worker' }
  Check-Refusal { Get-WorkerCellCapacityPaths 'F:\worker:stream' }
  Check-Refusal { Get-WorkerCellCapacityCustodyBytes $layoutRoot }
  New-Item -ItemType Directory -Path $layoutRoot -ErrorAction Stop | Out-Null
  New-Item -ItemType Directory -Path (Join-Path $layoutRoot 'state') -ErrorAction Stop | Out-Null
  foreach ($directory in $areas.Values) { New-Item -ItemType Directory -Path $directory -ErrorAction Stop | Out-Null }
  $layoutPins = [Collections.Generic.List[Microsoft.Win32.SafeHandles.SafeFileHandle]]::new()
  try {
    foreach ($directory in $areas.Values) { $layoutPins.Add([GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::PinDirectory($directory)) }
    $layoutBytes = Get-WorkerCellCapacityCustodyBytes $layoutRoot
    Check-Case ([Convert]::ToBase64String($layoutBytes) -ceq [Convert]::ToBase64String($native::CreateCellCapacityCustody($layoutPins.ToArray())))
    for ($index=0; $index -lt 13; $index++) {
      Check-Case ([Convert]::ToBase64String($layoutBytes,8+24*$index,24) -ceq [Convert]::ToBase64String($native::GetCellDirectoryIdentity($layoutPins[$index])))
    }
  } finally { foreach ($pin in $layoutPins) { $pin.Dispose() } }
  $roots[12].Dispose()
  Check-Refusal { $native::CreateCellCapacityCustody($roots) }
  [pscustomobject]@{ passed=$true; checks=$checks; bytes=$bytes.Length; installedService=$false; volumeAttached=$false } | ConvertTo-Json -Compress
} finally { foreach ($pin in $pins) { $pin.Dispose() } }
