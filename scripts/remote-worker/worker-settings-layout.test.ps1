#Requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$FixtureRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'worker-enrollment-common.ps1')
# Pure settings and ProcessStartInfo checks; no process, service or network starts.
New-Item -ItemType Directory -Path $FixtureRoot -ErrorAction Stop | Out-Null
$paths = Get-WorkerServicePaths 'F:\Windows'
$prefix = 'GOATCITADEL_CONNECTED_WORKER_'
$checks = 0
function Check { param([bool]$Condition); if (-not $Condition) { throw 'Settings layout check failed.' }; $script:checks++ }
function Refuse { param([byte[]]$Bytes); $failed=$false; try { Get-WorkerInstalledSettings $paths $Bytes | Out-Null } catch { $failed=$true }; Check $failed }
foreach ($capacity in @($false,$true)) {
  $bytes = Get-WorkerSettingsBytes $paths '127.0.0.1' 8787 'service-fixture' -CapacityLayout:$capacity
  $values = Get-WorkerInstalledSettings $paths $bytes
  $expectedState = $paths.State
  $expectedReport = Join-Path $paths.State 'service-report.json'
  if ($capacity) {
    $areas = Get-WorkerCellCapacityPaths $paths.Root
    $expectedState = $areas.retained_outbox
    $expectedReport = Join-Path $areas.diagnostic 'service-report.json'
  }
  Check ($values[$prefix+'STATE_DIR'] -ceq $expectedState)
  Check ($values[$prefix+'REPORT_FILE'] -ceq $expectedReport)
  $start = Get-WorkerEnrollmentStartInfo $paths $bytes 'enrollment-fixture'
  Check ($start.EnvironmentVariables[$prefix+'STATE_DIR'] -ceq $paths.Enrollment)
  Check ($start.EnvironmentVariables[$prefix+'REPORT_FILE'] -ceq (Join-Path $paths.Enrollment 'report.json'))
  Check ($start.EnvironmentVariables[$prefix+'RUN_MODE'] -ceq 'once')
  Check ($start.EnvironmentVariables[$prefix+'STOP_AFTER'] -ceq 'admit')
  $text = [Text.Encoding]::Unicode.GetString($bytes)
  $otherState = if ($capacity) { $paths.State } else { (Get-WorkerCellCapacityPaths $paths.Root).retained_outbox }
  $mixed = $text.Replace($prefix+'STATE_DIR='+$expectedState+[char]0,$prefix+'STATE_DIR='+$otherState+[char]0)
  Refuse ([Text.Encoding]::Unicode.GetBytes($mixed))
  $substituted = $text.Replace($prefix+'STATE_DIR='+$expectedState+[char]0,$prefix+'STATE_DIR='+$expectedState+'\..'+[char]0)
  Refuse ([Text.Encoding]::Unicode.GetBytes($substituted))
  [IO.File]::WriteAllBytes((Join-Path $FixtureRoot ('settings-'+$capacity+'.bin')),$bytes)
}
$legacyReceipt = [pscustomobject]@{schemaVersion='goatcitadel.remote-worker.service-install.v1'}
$capacityReceipt = [pscustomobject]@{capacityCustodySha256=('a'*64)}
$record = [pscustomobject]@{sizeBytes=320;sha256=('a'*64)}
Assert-WorkerCapacityEnrollmentReceipt $false $legacyReceipt $null
Check $true
Assert-WorkerCapacityEnrollmentReceipt $true $capacityReceipt $record
Check $true
foreach ($args in @(
    @($false,$capacityReceipt,$null), @($false,$legacyReceipt,$record),
    @($true,$legacyReceipt,$record), @($true,$capacityReceipt,$null),
    @($true,$capacityReceipt,[pscustomobject]@{sizeBytes=319;sha256=('a'*64)}),
    @($true,$capacityReceipt,[pscustomobject]@{sizeBytes=320;sha256=('b'*64)}),
    @($true,[pscustomobject]@{capacityCustodySha256=('A'*64)},[pscustomobject]@{sizeBytes=320;sha256=('A'*64)})
  )) {
  $failed=$false
  try { Assert-WorkerCapacityEnrollmentReceipt @args } catch { $failed=$true }
  Check $failed
}
foreach ($name in @('install-worker-service.ps1','enroll-worker-service.ps1')) {
  $tokens=$null; $parseErrors=$null
  $null=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $name),[ref]$tokens,[ref]$parseErrors)
  Check ($parseErrors.Count -eq 0)
}
[pscustomobject]@{passed=$true;checks=$checks;installRoot=$paths.Root;processStarted=$false;installedService=$false;volumeAttached=$false} | ConvertTo-Json -Compress
