#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
Add-Type -TypeDefinition ([IO.File]::ReadAllText((Join-Path $PSScriptRoot 'broker-image-maintenance.cs')))
$leaseType = [GoatCitadel.RemoteWorker.BrokerCoordinator.ImageMaintenanceLease]
$root = Join-Path ([IO.Path]::GetTempPath()) ('goat-broker-image-test-' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $root
$path = Join-Path $root 'GoatCitadelRemoteWorkerProvisioner.exe'
$original = [Text.Encoding]::UTF8.GetBytes('original executable fixture')
$replacement = [Text.Encoding]::UTF8.GetBytes('replacement fixture with different length')
$checks = 0
function Hash-Bytes([byte[]]$Bytes) {
  $sha = [Security.Cryptography.SHA256]::Create()
  try { return ([BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant() }
  finally { $sha.Dispose() }
}
function Expect-Refusal([scriptblock]$Action, [string]$Label) {
  $refused = $false
  try { & $Action | Out-Null } catch { $refused = $true }
  if (-not $refused) { throw "Expected refusal: $Label" }
  $script:checks++
}
function Check([bool]$Value, [string]$Label) {
  if (-not $Value) { throw $Label }
  $script:checks++
}
$oldHash = Hash-Bytes $original
$newHash = Hash-Bytes $replacement
$lease = $null
try {
  [IO.File]::WriteAllBytes($path, $original)
  $sddl = (Get-Acl -LiteralPath $path).Sddl
  $state = Join-Path $root 'state-v1'
  $null = New-Item -ItemType Directory -Path $state
  $sentinel = Join-Path $state 'retain.txt'
  [IO.File]::WriteAllText($sentinel, 'untouched')
  $lease = $leaseType::Open($path, $oldHash, $sddl, $false)
  Expect-Refusal { $lease.Replace($replacement, $newHash) } 'read-only preflight cannot write'
  Check ($lease.CurrentSha256 -eq $oldHash) 'preflight preserved original'
  $lease.Dispose(); $lease = $null
  Expect-Refusal { $leaseType::Open($path, $newHash, $sddl, $true) } 'wrong installed hash'
  $lease = $leaseType::Open($path, $oldHash, $sddl, $true)
  $identity = $lease.Identity
  $security = $lease.SecuritySddl
  Expect-Refusal { $opened = [IO.File]::OpenRead($path); $opened.Dispose() } 'exclusive maintenance excludes loaders/readers'
  Expect-Refusal { [IO.File]::Move($path, ($path + '.moved')) } 'held image cannot be renamed'
  Expect-Refusal { $lease.Replace($replacement, $oldHash) } 'wrong replacement hash'
  $backup = Join-Path $root 'original-backup.exe'
  $lease.SaveOriginal($backup)
  Check ((Get-FileHash -LiteralPath $backup).Hash -eq $oldHash) 'retained backup matches original'
  Expect-Refusal { $lease.SaveOriginal($backup) } 'backup is never overwritten'
  $lease.Replace($replacement, $newHash)
  Check ($lease.CurrentSha256 -eq $newHash -and $lease.Identity -eq $identity -and $lease.SecuritySddl -eq $security) 'new bytes retain file identity and security'
  $lease.RestoreOriginal()
  Check ($lease.CurrentSha256 -eq $oldHash) 'rollback restores original bytes'
  $lease.Dispose(); $lease = $null
  Check ([IO.File]::ReadAllText($sentinel) -eq 'untouched') 'sibling state preserved'
  Set-Content -LiteralPath $path -Stream 'unexpected' -Value 'fixture'
  Expect-Refusal { $leaseType::Open($path, $oldHash, $sddl, $true) } 'extra data stream'
  Remove-Item -LiteralPath $path -Stream 'unexpected'
  $link = Join-Path $root 'second-link.exe'
  $null = New-Item -ItemType HardLink -Path $link -Target $path
  Expect-Refusal { $leaseType::Open($path, $oldHash, $sddl, $true) } 'hard-linked executable'
  Remove-Item -LiteralPath $link
  Expect-Refusal { $leaseType::Open($sentinel, $oldHash, $sddl, $true) } 'state or arbitrary files cannot be updated'
  $client = Join-Path $root 'GoatCitadelRemoteWorkerProvisionerClient.exe'
  [IO.File]::WriteAllBytes($client, $original)
  $clientSddl = (Get-Acl -LiteralPath $client).Sddl
  Expect-Refusal { $leaseType::Open($client, $oldHash, $clientSddl, $true) } 'ordinary maintenance cannot write client'
  Expect-Refusal { $leaseType::OpenClientReplacement($path, $oldHash, $sddl) } 'explicit client maintenance refuses signer or arbitrary files'
  $lease = $leaseType::OpenClientReplacement($client, $oldHash, $clientSddl)
  $lease.Replace($replacement, $newHash)
  Check ($lease.CurrentSha256 -eq $newHash) 'explicit pinned client replacement reads back'
  $lease.RestoreOriginal()
  Check ($lease.CurrentSha256 -eq $oldHash) 'explicit client replacement rolls back'
  $lease.Dispose(); $lease = $null
  [pscustomobject]@{ passed=$true; checks=$checks } | ConvertTo-Json -Compress
} finally {
  if ($null -ne $lease) { $lease.Dispose() }
  # This invocation created this unique temp root. Resolve and bound it before cleanup.
  $resolved = [IO.Path]::GetFullPath($root)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  if (-not $resolved.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolved) -notmatch '^goat-broker-image-test-[a-f0-9]{32}$') { throw 'Unsafe test cleanup path.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
