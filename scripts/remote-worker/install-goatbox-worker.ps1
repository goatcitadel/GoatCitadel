#Requires -Version 5.1
<# Install the retained GOATBOX worker package stopped, without an enrollment ticket.
   The separately hash-pinned handoff supplies only public certificates and a
   protected-key identifier. It never changes the existing signer installation. #>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][ValidatePattern('^[a-f0-9]{64}$')][string]$HandoffManifestSha256,
  [switch]$Apply
)
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ([Environment]::MachineName -cne 'GOATBOX' -or $env:COMPUTERNAME -cne 'GOATBOX') { throw 'GOATBOX only.' }
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator PowerShell required.' }
$package='C:\worker-candidates\client-token-fixed\payload'
$packageHash='d80b8d70375b40962947689e2cfc4787ae28aa9dc64a8ebc9e0fed3c5559256b'
$leases=[Collections.Generic.List[IDisposable]]::new()
function Hold-VerifiedFile([string]$Path,[string]$Expected) {
  if ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse file refused.' }
  $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
  $leases.Add($stream)
  $hash=[Security.Cryptography.SHA256]::Create()
  try { $actual=[BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
  if ($actual -cne $Expected) { throw ('Hash mismatch: '+$Path) }
}
try {
  $manifestPath=Join-Path $PSScriptRoot 'handoff-files.json'
  Hold-VerifiedFile $manifestPath $HandoffManifestSha256
  $manifest=Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
  foreach ($file in $manifest.files) {
    $path=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot $file.path))
    if (-not $path.StartsWith($PSScriptRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Handoff path escapes its root.' }
    Hold-VerifiedFile $path $file.sha256
  }
  Hold-VerifiedFile (Join-Path $package 'worker-package.json') $packageHash
  $bin='C:\ProgramData\GoatCitadel\RemoteWorkerProvisioner\bin'
  Hold-VerifiedFile (Join-Path $bin 'GoatCitadelRemoteWorkerProvisioner.exe') '5b462d106464b6cbf089572f91cf64c3c8d5fe3132616f4d2ad89bb744e894b1'
  Hold-VerifiedFile (Join-Path $bin 'GoatCitadelRemoteWorkerProvisionerAvailability.exe') '4ac5adb9cb5a782fd46f31e19b0096261b37889d462ae7beffcba3fb99633ba4'
  Hold-VerifiedFile (Join-Path $bin 'GoatCitadelRemoteWorkerProvisionerClient.exe') '9fb70095d3c4c473d0be1d3ec67eb17e892ae4870911e7773e11df26d6ac46d0'
  $stamp=Get-Date -Format 'yyyyMMdd-HHmmss-fff'
  $installer=Join-Path $PSScriptRoot 'install-worker-service.ps1'
  $baseArgs=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$installer,
    '-Target','windows-x64','-PackageRoot',$package,'-ManifestSha256',$packageHash,
    '-GatewayHost','192.168.0.219','-GatewayPort','9443',
    '-ClientCertificateFile',(Join-Path $PSScriptRoot 'client-cert.pem'),
    '-TrustAnchorFile',(Join-Path $PSScriptRoot 'ca.pem'),
    '-ProtectedKeyFile',(Join-Path $PSScriptRoot 'protected-key.json'),'-DeferEnrollment')
  $preflight='C:\worker-evidence\worker-install-preflight-'+$stamp
  'Verifying the retained package and checking worker installation prerequisites...'
  & powershell.exe @baseArgs -OutputRoot $preflight -Preflight
  if ($LASTEXITCODE -ne 0) { throw ('Preflight failed. Preserve '+$preflight+' and paste the output; do not repeat.') }
  if (-not $Apply) { 'Preflight passed. No installation performed.'; return }
  $output='C:\worker-evidence\worker-install-'+$stamp
  'Installing the worker and cell controller in a stopped state; enrollment is deferred...'
  & powershell.exe @baseArgs -OutputRoot $output
  if ($LASTEXITCODE -ne 0) { throw ('Installation failed. Preserve '+$output+' and paste the output; do not repeat.') }
  'Public installation evidence:'
  Get-Content -Raw -LiteralPath (Join-Path $output 'pending-enrollment.json')
  'Installation evidence folder: '+$output
  'Paste this output back. Do not start the worker or repeat installation; the enrollment ticket is next.'
} finally { foreach ($lease in $leases) { $lease.Dispose() } }
