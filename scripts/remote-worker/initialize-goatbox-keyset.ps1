#Requires -Version 5.1
# Creates generation 1 through the installed protected signer. No private-key export.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ([Environment]::MachineName -cne 'GOATBOX' -or $env:COMPUTERNAME -cne 'GOATBOX') { throw 'GOATBOX only.' }
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator PowerShell required.' }
$package='C:\worker-candidates\client-token-fixed\payload'
$helper=Join-Path $PSScriptRoot 'goatbox-create-keyset.mjs'
$manifestPath=Join-Path $package 'worker-package.json'
$leases=[Collections.Generic.List[IDisposable]]::new()
function Hold-VerifiedFile([string]$Path,[string]$Expected) {
  $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $leases.Add($stream)
  $sha=[Security.Cryptography.SHA256]::Create()
  try { $actual=([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
  if ($actual -cne $Expected) { throw ('File hash mismatch: '+$Path) }
}
try {
  Hold-VerifiedFile $helper '68ee3c03b8ed61de51e6a6e34130081bfa406f31cd8a19c46e33475d0b16a91b'
  Hold-VerifiedFile $manifestPath 'd80b8d70375b40962947689e2cfc4787ae28aa9dc64a8ebc9e0fed3c5559256b'
  $manifest=Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  foreach ($file in $manifest.files) {
    $path=[IO.Path]::GetFullPath((Join-Path $package $file.path))
    if (-not $path.StartsWith($package+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid inventory path.' }
    Hold-VerifiedFile $path $file.sha256
  }
  $bin='C:\ProgramData\GoatCitadel\RemoteWorkerProvisioner\bin'
  Hold-VerifiedFile (Join-Path $bin 'GoatCitadelRemoteWorkerProvisioner.exe') '5b462d106464b6cbf089572f91cf64c3c8d5fe3132616f4d2ad89bb744e894b1'
  Hold-VerifiedFile (Join-Path $bin 'GoatCitadelRemoteWorkerProvisionerAvailability.exe') '4ac5adb9cb5a782fd46f31e19b0096261b37889d462ae7beffcba3fb99633ba4'
  Hold-VerifiedFile (Join-Path $bin 'GoatCitadelRemoteWorkerProvisionerClient.exe') '9fb70095d3c4c473d0be1d3ec67eb17e892ae4870911e7773e11df26d6ac46d0'
  'Package and installed images verified. Creating the first protected keyset once.'
  & (Join-Path $package 'app\runtime\node.exe') $helper
  if ($LASTEXITCODE -ne 0) { throw 'Preserve C:\worker-evidence\first-protected-keyset-v1 and paste the output. Do not repeat.' }
  'Public evidence: C:\worker-evidence\first-protected-keyset-v1\verified-public-keyset.json'
} finally { foreach ($lease in $leases) { $lease.Dispose() } }
