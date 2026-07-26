[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$StageRoot,

  [Parameter(Mandatory = $true)]
  [ValidateSet("windows-x64", "windows-arm64")]
  [string]$Target,

  [Parameter(Mandatory = $true)]
  [ValidateNotNullOrEmpty()]
  [string]$Version,

  [switch]$InstalledRoot
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$maxManifestBytes = 16MB
$maxFiles = 100000
$maxTotalBytes = 8GB
$maxFileBytes = 2GB
$maxPathBytes = 1024
$expectedArch = if ($Target -eq "windows-arm64") { "arm64" } else { "x64" }
$expectedMachine = if ($Target -eq "windows-arm64") { 0xAA64 } else { 0x8664 }

function Assert-ExactStringArray {
  param(
    [AllowNull()]
    [object]$Actual,
    [string[]]$Expected,
    [string]$Label
  )

  $values = @($Actual)
  if ($values.Count -ne $Expected.Count) {
    throw "Release manifest $Label do not match the fixed installer policy."
  }
  for ($index = 0; $index -lt $Expected.Count; $index += 1) {
    if ($values[$index] -isnot [string] -or $values[$index] -cne $Expected[$index]) {
      throw "Release manifest $Label do not match the fixed installer policy."
    }
  }
}

function Compare-Utf8Bytes {
  param([string]$Left, [string]$Right)

  $leftBytes = [System.Text.Encoding]::UTF8.GetBytes($Left)
  $rightBytes = [System.Text.Encoding]::UTF8.GetBytes($Right)
  $length = [Math]::Min($leftBytes.Length, $rightBytes.Length)
  for ($index = 0; $index -lt $length; $index += 1) {
    if ($leftBytes[$index] -lt $rightBytes[$index]) { return -1 }
    if ($leftBytes[$index] -gt $rightBytes[$index]) { return 1 }
  }
  return $leftBytes.Length.CompareTo($rightBytes.Length)
}

function Assert-PayloadPath {
  param([object]$Value)

  if ($Value -isnot [string] -or
      [string]::IsNullOrEmpty($Value) -or
      [System.Text.Encoding]::UTF8.GetByteCount($Value) -gt $maxPathBytes -or
      $Value.Contains([char]0) -or
      $Value.Contains("\") -or
      $Value.StartsWith("/", [System.StringComparison]::Ordinal) -or
      $Value -match "^[a-zA-Z]:") {
    throw "Release manifest payload path is unsafe: $Value"
  }

  $segments = $Value.Split("/")
  if (($segments[0] -cne "app" -and $segments[0] -cne "bin") -or
      @($segments | Where-Object { $_.Length -eq 0 -or $_ -eq "." -or $_ -eq ".." }).Count -gt 0) {
    throw "Release manifest payload path is unsafe: $Value"
  }
  if ($Value.Equals("app/release-manifest.json", [System.StringComparison]::OrdinalIgnoreCase) -or
      $Value.StartsWith("app/release-evidence/", [System.StringComparison]::OrdinalIgnoreCase) -or
      $Value.Equals("app/release-evidence", [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Release manifest payload cannot include detached metadata: $Value"
  }
}

function Assert-PeMachine {
  param([string]$FilePath, [int]$ExpectedMachine, [string]$Label)

  $stream = [System.IO.File]::Open($FilePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  try {
    if ($stream.Length -lt 70) { throw "$Label is not a valid Windows PE executable." }
    $reader = [System.IO.BinaryReader]::new($stream)
    try {
      if ($reader.ReadUInt16() -ne 0x5A4D) { throw "$Label is missing the MZ header." }
      $stream.Position = 0x3C
      $peOffset = $reader.ReadInt32()
      if ($peOffset -lt 64 -or $peOffset -gt ($stream.Length - 6)) {
        throw "$Label has an invalid PE header offset."
      }
      $stream.Position = $peOffset
      if ($reader.ReadUInt32() -ne 0x00004550) { throw "$Label is missing the PE signature." }
      $machine = $reader.ReadUInt16()
      if ($machine -ne $ExpectedMachine) {
        throw "$Label targets machine 0x$($machine.ToString('X4')); expected 0x$($ExpectedMachine.ToString('X4'))."
      }
    }
    finally {
      $reader.Dispose()
    }
  }
  finally {
    $stream.Dispose()
  }
}

function Get-Sha256Hex {
  param([string]$FilePath)

  $stream = [System.IO.File]::Open($FilePath, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::Read)
  try {
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    try {
      return ([System.BitConverter]::ToString($sha256.ComputeHash($stream))).Replace("-", "").ToLowerInvariant()
    }
    finally {
      $sha256.Dispose()
    }
  }
  finally {
    $stream.Dispose()
  }
}

$stage = [System.IO.Path]::GetFullPath($StageRoot).TrimEnd("\")
if (-not (Test-Path -LiteralPath $stage -PathType Container)) {
  throw "Staged bundle root does not exist: $stage"
}
$stageInfo = Get-Item -LiteralPath $stage -Force
if (($stageInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Staged bundle root cannot be a symlink or junction."
}
$stagePrefix = $stage + [System.IO.Path]::DirectorySeparatorChar
$payloadRootNames = @("app", "bin")
if (-not $InstalledRoot) {
  foreach ($rootEntry in Get-ChildItem -LiteralPath $stage -Force) {
    if ($payloadRootNames -contains $rootEntry.Name) { continue }
    if (-not $rootEntry.PSIsContainer -and $rootEntry.Name -ceq ".goatcitadel-transaction") { continue }
    throw "Staged Windows bundle contains an unexpected root entry: $($rootEntry.Name)"
  }
}
$manifestPath = Join-Path $stage "app\release-manifest.json"
if (-not (Test-Path -LiteralPath $manifestPath -PathType Leaf)) {
  throw "Staged bundle is missing app/release-manifest.json."
}
$manifestInfo = Get-Item -LiteralPath $manifestPath -Force
if ($manifestInfo.Length -le 0 -or $manifestInfo.Length -gt $maxManifestBytes -or
    ($manifestInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
  throw "Staged release manifest is empty, oversized, or a reparse point."
}

try {
  $manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
}
catch {
  throw "Staged release manifest is not valid JSON: $($_.Exception.Message)"
}
if ($null -eq $manifest -or $manifest -is [System.Array]) {
  throw "Staged release manifest must be a JSON object."
}
if ($manifest.schemaVersion -ne 2 -or $manifest.product -cne "GoatCitadel") {
  throw "Staged release manifest must use GoatCitadel schema 2."
}
if ($manifest.version -isnot [string] -or $manifest.version -cne $Version) {
  throw "Staged release manifest version does not match installer version $Version."
}
if ($manifest.target -cne $Target -or $manifest.platform -cne "windows" -or $manifest.arch -cne $expectedArch) {
  throw "Staged release manifest target/platform/arch does not match $Target."
}
if ($manifest.sourceCommit -isnot [string] -or $manifest.sourceCommit -cnotmatch "^[a-f0-9]{40}$" -or
    $manifest.sourceModified -isnot [bool]) {
  throw "Staged release manifest source identity is invalid."
}
if ($null -eq $manifest.payload -or $manifest.payload.algorithm -cne "sha256") {
  throw "Staged release manifest payload must use SHA-256."
}
Assert-ExactStringArray $manifest.payload.roots @("app", "bin") "payload roots"
Assert-ExactStringArray $manifest.payload.detachedMetadataFiles @("app/release-manifest.json") "detached metadata files"
Assert-ExactStringArray $manifest.payload.detachedMetadataTrees @("app/release-evidence") "detached metadata trees"

$files = @($manifest.payload.files)
if ($files.Count -lt 1 -or $files.Count -gt $maxFiles) {
  throw "Staged release manifest payload must contain 1-$maxFiles file records."
}
$seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
$allowedDirectories = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
[void]$allowedDirectories.Add("app")
[void]$allowedDirectories.Add("bin")
$previousPath = $null
[long]$totalBytes = 0

foreach ($record in $files) {
  if ($null -eq $record -or $record -is [System.Array]) {
    throw "Staged release manifest contains a non-object file record."
  }
  Assert-PayloadPath $record.path
  $relativePath = [string]$record.path
  if (-not $seen.Add($relativePath)) {
    throw "Staged release manifest contains a duplicate or case-colliding path: $relativePath"
  }
  if ($null -ne $previousPath -and (Compare-Utf8Bytes $previousPath $relativePath) -ge 0) {
    throw "Staged release manifest payload file records must be strictly path-sorted."
  }
  $previousPath = $relativePath
  if ($record.sha256 -isnot [string] -or $record.sha256 -cnotmatch "^[a-f0-9]{64}$") {
    throw "Staged release manifest payload hash is invalid for $relativePath."
  }
  if (($record.sizeBytes -isnot [int] -and $record.sizeBytes -isnot [long]) -or
      $record.sizeBytes -lt 0 -or $record.sizeBytes -gt $maxFileBytes) {
    throw "Staged release manifest payload size is invalid for $relativePath."
  }
  $totalBytes += [long]$record.sizeBytes
  if ($totalBytes -gt $maxTotalBytes) {
    throw "Staged release manifest payload exceeds $maxTotalBytes bytes."
  }

  $segments = $relativePath.Split("/")
  for ($index = 1; $index -lt $segments.Count; $index += 1) {
    [void]$allowedDirectories.Add(($segments[0..($index - 1)] -join "/"))
  }
  $candidate = [System.IO.Path]::GetFullPath((Join-Path $stage ($relativePath.Replace("/", "\"))))
  if (-not $candidate.StartsWith($stagePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Staged payload file escapes the bundle root: $relativePath"
  }
  if (-not (Test-Path -LiteralPath $candidate -PathType Leaf)) {
    throw "Staged payload file is missing: $relativePath"
  }
  $candidateInfo = Get-Item -LiteralPath $candidate -Force
  if (($candidateInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
      $candidateInfo.Length -ne [long]$record.sizeBytes) {
    throw "Staged payload file size or type does not match its manifest record: $relativePath"
  }
  $actualHash = Get-Sha256Hex $candidate
  if ($actualHash -cne $record.sha256) {
    throw "Staged payload file hash does not match its manifest record: $relativePath"
  }
}

if (($manifest.payload.fileCount -isnot [int] -and $manifest.payload.fileCount -isnot [long]) -or
    [long]$manifest.payload.fileCount -ne $files.Count -or
    ($manifest.payload.totalBytes -isnot [int] -and $manifest.payload.totalBytes -isnot [long]) -or
    [long]$manifest.payload.totalBytes -ne $totalBytes) {
  throw "Staged release manifest payload count/byte summaries do not match its file records."
}

$requiredPaths = @(
  "app/desktop/GoatCitadel-Mission-Control-Windows.exe",
  "app/gateway/dist/main.js",
  "app/mission-control/dist/index.html",
  "app/runtime/node/node.exe",
  "bin/goatcitadel.cmd"
)
foreach ($requiredPath in $requiredPaths) {
  if (-not $seen.Contains($requiredPath)) {
    throw "Staged Windows bundle is missing required manifested file: $requiredPath"
  }
}

$actualFiles = 0
[long]$actualBytes = 0
$entryCount = 0
foreach ($payloadRootName in $payloadRootNames) {
  $payloadRoot = Join-Path $stage $payloadRootName
  if (-not (Test-Path -LiteralPath $payloadRoot -PathType Container)) {
    throw "Staged Windows bundle is missing required payload root: $payloadRootName"
  }
  $payloadRootInfo = Get-Item -LiteralPath $payloadRoot -Force
  if (($payloadRootInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw "Staged Windows bundle payload root cannot be a symlink or junction: $payloadRootName"
  }
  foreach ($entry in Get-ChildItem -LiteralPath $payloadRoot -Force -Recurse) {
    $entryCount += 1
    if ($entryCount -gt ($maxFiles * 4)) {
      throw "Staged Windows bundle contains too many filesystem entries."
    }
    if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "Staged Windows bundle contains a symlink or junction: $($entry.FullName)"
    }
    $relativePath = $entry.FullName.Substring($stagePrefix.Length).Replace("\", "/")
    $isDetachedEvidence = $relativePath.Equals("app/release-evidence", [System.StringComparison]::OrdinalIgnoreCase) -or
      $relativePath.StartsWith("app/release-evidence/", [System.StringComparison]::OrdinalIgnoreCase)
    if ($entry.PSIsContainer) {
      if (-not $isDetachedEvidence -and -not $allowedDirectories.Contains($relativePath)) {
        throw "Staged Windows bundle contains an unlisted directory: $relativePath"
      }
      continue
    }
    if ($relativePath.Equals("app/release-manifest.json", [System.StringComparison]::OrdinalIgnoreCase) -or
        $isDetachedEvidence) {
      continue
    }
    if (-not $seen.Contains($relativePath)) {
      throw "Staged Windows bundle contains an unlisted file: $relativePath"
    }
    $actualFiles += 1
    $actualBytes += [long]$entry.Length
  }
}
if ($actualFiles -ne $files.Count -or $actualBytes -ne $totalBytes) {
  throw "Staged Windows bundle filesystem totals do not match the release manifest."
}

Assert-PeMachine (Join-Path $stage "app\desktop\GoatCitadel-Mission-Control-Windows.exe") $expectedMachine "Windows desktop host"
Assert-PeMachine (Join-Path $stage "app\runtime\node\node.exe") $expectedMachine "Bundled Node runtime"

if ($InstalledRoot) {
  Write-Output "Validated installed GoatCitadel bundle $Target $Version ($actualFiles files, $actualBytes bytes)."
} else {
  Write-Output "Validated staged GoatCitadel bundle $Target $Version ($actualFiles files, $actualBytes bytes)."
}
