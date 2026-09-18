#Requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$FixtureRoot,[switch]$Reader,[switch]$ExpectRefusal)
Set-StrictMode -Version Latest
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'worker-install-common.ps1')
Initialize-WorkerInstallNative
$native=[GoatCitadel.RemoteWorker.Install.NativeFiles]
$gate=Join-Path $FixtureRoot 'state-writers.guard'
$ready=Join-Path $FixtureRoot 'reader-ready'
$release=Join-Path $FixtureRoot 'reader-release'
if ($Reader) {
  if ($ExpectRefusal) {
    try { $unexpected=$native::OpenRead($gate,0); $unexpected.Dispose() } catch { exit 0 }
    throw 'Reader unexpectedly bypassed the enrollment lease.'
  }
  $held=$native::OpenRead($gate,0)
  try {
    [IO.File]::WriteAllText($ready,'ready')
    $until=[DateTime]::UtcNow.AddSeconds(20)
    while (-not (Test-Path -LiteralPath $release)) {
      if ([DateTime]::UtcNow -ge $until) { throw 'Reader fixture timed out.' }
      Start-Sleep -Milliseconds 10
    }
  } finally { $held.Dispose() }
  exit 0
}
New-Item -ItemType Directory -Path $FixtureRoot -ErrorAction Stop | Out-Null
[IO.File]::WriteAllBytes($gate,[byte[]]@())
$checks=0
function Check { param([bool]$Condition); if (-not $Condition) { throw 'State writer gate check failed.' }; $script:checks++ }
function Refuse { param([scriptblock]$Body); $failed=$false; try { & $Body | Out-Null } catch { $failed=$true }; Check $failed }
$child=$null; $exclusive=$null
try {
  Refuse { $h=$native::AcquireInstalledStateWriterGate((Join-Path $FixtureRoot 'missing.guard')); $h.Dispose() }
  Check (-not (Test-Path -LiteralPath (Join-Path $FixtureRoot 'missing.guard')))
  $exclusive=$native::AcquireInstalledStateWriterGate($gate)
  Refuse { $h=$native::OpenRead($gate,0); $h.Dispose() }
  Refuse { $h=$native::AcquireInstalledStateWriterGate($gate); $h.Dispose() }
  Refuse { [IO.File]::Move($gate,(Join-Path $FixtureRoot 'replacement.guard')) }
  Check (([GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::GetFileSddl($gate)).Length -gt 0)
  $exclusive.Dispose(); $exclusive=$null
  $start=[Diagnostics.ProcessStartInfo]::new()
  $start.FileName=(Get-Process -Id $PID).Path
  $start.Arguments='-NoProfile -NonInteractive -File "'+$PSCommandPath+'" -FixtureRoot "'+$FixtureRoot+'" -Reader'
  $start.UseShellExecute=$false; $start.CreateNoWindow=$true
  $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
  $exclusive=$native::AcquireInstalledStateWriterGate($gate)
  $start.Arguments += ' -ExpectRefusal'
  $child=[Diagnostics.Process]::Start($start)
  $stdout=$child.StandardOutput.ReadToEndAsync(); $stderr=$child.StandardError.ReadToEndAsync()
  Check ($child.WaitForExit(10000))
  Check ($child.ExitCode -eq 0 -and $stderr.Result.Length -eq 0)
  $child.Dispose(); $child=$null
  $exclusive.Dispose(); $exclusive=$null
  $start.Arguments=$start.Arguments.Replace(' -ExpectRefusal','')
  $child=[Diagnostics.Process]::Start($start)
  $stdout=$child.StandardOutput.ReadToEndAsync(); $stderr=$child.StandardError.ReadToEndAsync()
  $until=[DateTime]::UtcNow.AddSeconds(15)
  while (-not (Test-Path -LiteralPath $ready)) {
    if ($child.HasExited -or [DateTime]::UtcNow -ge $until) { throw 'Reader did not acquire its lease.' }
    Start-Sleep -Milliseconds 10
  }
  Refuse { $h=$native::AcquireInstalledStateWriterGate($gate); $h.Dispose() }
  $otherReader=$native::OpenRead($gate,0); Check ($otherReader.Length -eq 0); $otherReader.Dispose()
  [IO.File]::WriteAllText($release,'release')
  Check ($child.WaitForExit(10000))
  Check ($child.ExitCode -eq 0 -and $stderr.Result.Length -eq 0)
  $exclusive=$native::AcquireInstalledStateWriterGate($gate)
  Check ($exclusive.Length -eq 0)
  $exclusive.Dispose(); $exclusive=$null
  $aliased=Join-Path $FixtureRoot 'aliased.guard'
  [IO.File]::WriteAllBytes($aliased,[byte[]]@())
  New-Item -ItemType HardLink -Path (Join-Path $FixtureRoot 'alias.guard') -Target $aliased | Out-Null
  Refuse { $h=$native::AcquireInstalledStateWriterGate($aliased); $h.Dispose() }
  Check ((Get-Item -LiteralPath $aliased).Length -eq 0)
  [IO.File]::WriteAllText($gate,'unexpected')
  Refuse { $h=$native::AcquireInstalledStateWriterGate($gate); $h.Dispose() }
  Check ([IO.File]::ReadAllText($gate) -ceq 'unexpected')
  [pscustomobject]@{passed=$true;checks=$checks;crossProcess=$true;installedService=$false;volumeAttached=$false} | ConvertTo-Json -Compress
} finally {
  if ($exclusive) { $exclusive.Dispose() }
  if ($child) {
    if (-not $child.HasExited) {
      [IO.File]::WriteAllText($release,'release')
      if (-not $child.WaitForExit(10000)) { $child.Kill(); $child.WaitForExit() }
    }
    $child.Dispose()
  }
}
