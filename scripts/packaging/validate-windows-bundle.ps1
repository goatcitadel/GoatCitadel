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

  [switch]$InstalledRoot,

  [switch]$ProgressOutput,

  [string]$ArchivePath,

  [ValidateRange(1, 16)]
  [int]$HashWorkers = 4
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

# UTF-8 byte order differs from UTF-16 ordinal order for supplementary characters.
# Compile the hot byte loop without changing the manifest ordering contract.
Add-Type -ReferencedAssemblies System.dll, System.Core.dll, System.IO.Compression.dll, System.IO.Compression.FileSystem.dll -TypeDefinition @"
using System;
using System.Text;
using System.IO;
using System.Security.Cryptography;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.IO.Compression;
public static class GoatCitadelInstallerPaths {
  public static int CompareUtf8(string left, string right) {
    byte[] a = Encoding.UTF8.GetBytes(left), b = Encoding.UTF8.GetBytes(right);
    for (int i = 0; i < Math.Min(a.Length, b.Length); i++) {
      int result = a[i].CompareTo(b[i]);
      if (result != 0) return result;
    }
    return a.Length.CompareTo(b.Length);
  }
  public static void ValidateHashes(string[] paths, string[] expected, bool progress, int workers) {
    int completed = 0;
    object progressLock = new object();
    // Bound disk pressure and memory while overlapping Windows' per-file read latency.
    try {
      Parallel.For(0, paths.Length, new ParallelOptions { MaxDegreeOfParallelism = workers }, i => {
        using (var stream = File.Open(paths[i], FileMode.Open, FileAccess.Read, FileShare.Read))
        using (var sha256 = SHA256.Create()) {
          string actual = BitConverter.ToString(sha256.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
          if (!String.Equals(actual, expected[i], StringComparison.Ordinal))
            throw new InvalidDataException("Staged payload file hash does not match its manifest record: " + paths[i]);
        }
        lock (progressLock) {
          completed++;
          if (progress && (completed % 256 == 0 || completed == paths.Length))
            Console.WriteLine("GOATCITADEL_PROGRESS Hashing " + completed + "/" + paths.Length);
        }
      });
    } catch (AggregateException error) {
      throw new InvalidDataException(error.Flatten().InnerExceptions[0].Message, error);
    }
  }
  static string EntryPath(ZipArchiveEntry entry) {
    int mode = (entry.ExternalAttributes >> 16) & 0xF000;
    if ((entry.ExternalAttributes & 0x400) != 0 || (mode != 0 && mode != 0x8000 && mode != 0x4000))
      throw new InvalidDataException("Archive contains a symlink, junction or special file: " + entry.FullName);
    string name = entry.FullName;
    if (name.StartsWith("./", StringComparison.Ordinal)) name = name.Substring(2);
    if (name == "" && entry.FullName.EndsWith("/", StringComparison.Ordinal) && entry.Length == 0) return "";
    if (name == "") throw new InvalidDataException("Archive payload path is empty.");
    if (name.EndsWith("/", StringComparison.Ordinal)) name = name.Substring(0, name.Length - 1);
    if (Encoding.UTF8.GetByteCount(name) > 1024 || name.IndexOf('\\') >= 0 || name.StartsWith("/", StringComparison.Ordinal))
      throw new InvalidDataException("Archive payload path is unsafe: " + name);
    string[] segments = name.Split('/');
    if (segments[0] != "app" && segments[0] != "bin") throw new InvalidDataException("Archive contains an unexpected root entry: " + name);
    foreach (string segment in segments) {
      if (segment == "" || segment == "." || segment == ".." || segment.EndsWith(".") || segment.EndsWith(" ") || segment.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
        throw new InvalidDataException("Archive payload path is unsafe: " + name);
    }
    return name;
  }
  static string ReadManifestEntry(ZipArchiveEntry entry) {
    if (entry.Length <= 0 || entry.Length > 16 * 1024 * 1024) throw new InvalidDataException("Archive manifest is empty or oversized.");
    using (var input = entry.Open())
    using (var bytes = new MemoryStream()) {
      byte[] buffer = new byte[65536]; int count;
      while ((count = input.Read(buffer, 0, buffer.Length)) != 0) {
        if (bytes.Length + count > 16 * 1024 * 1024) throw new InvalidDataException("Archive manifest is oversized.");
        bytes.Write(buffer, 0, count);
      }
      string text = new UTF8Encoding(false, true).GetString(bytes.ToArray());
      return text.TrimStart('\uFEFF');
    }
  }
  public static string ReadArchiveManifest(string archivePath) {
    using (var archive = ZipFile.OpenRead(archivePath)) {
      if (archive.Entries.Count > 400000) throw new InvalidDataException("Archive contains too many filesystem entries.");
      ZipArchiveEntry manifest = null;
      foreach (var entry in archive.Entries) {
        if (EntryPath(entry) != "app/release-manifest.json") continue;
        if (manifest != null) throw new InvalidDataException("Archive contains a duplicate manifest.");
        manifest = entry;
      }
      if (manifest == null) throw new InvalidDataException("Archive is missing app/release-manifest.json.");
      return ReadManifestEntry(manifest);
    }
  }
  static void CreateSafeParents(string stage, string destination) {
    string parent = Path.GetDirectoryName(destination);
    var missing = new Stack<string>();
    while (!String.Equals(parent, stage, StringComparison.OrdinalIgnoreCase)) {
      if (parent == null || !parent.StartsWith(stage + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
        throw new InvalidDataException("Archive destination escapes the staging root.");
      if (Directory.Exists(parent)) {
        if ((File.GetAttributes(parent) & FileAttributes.ReparsePoint) != 0) throw new InvalidDataException("Archive parent cannot be a symlink or junction.");
      } else missing.Push(parent);
      parent = Path.GetDirectoryName(parent);
    }
    while (missing.Count != 0) Directory.CreateDirectory(missing.Pop());
  }
  public static void ExtractAndValidate(string archivePath, string stage, string manifestText, string[] paths, string[] hashes, long[] sizes, bool progress) {
    var records = new Dictionary<string, int>(StringComparer.Ordinal);
    var directories = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
    for (int i = 0; i < paths.Length; i++) {
      records.Add(paths[i], i);
      string parent = paths[i]; int slash;
      while ((slash = parent.LastIndexOf('/')) >= 0) { parent = parent.Substring(0, slash); directories.Add(parent); }
    }
    using (var archive = ZipFile.OpenRead(archivePath)) {
      if (archive.Entries.Count > 400000) throw new InvalidDataException("Archive contains too many filesystem entries.");
      var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
      int payloadCount = 0;
      // Preflight the entire archive before creating any payload file.
      foreach (var entry in archive.Entries) {
        string name = EntryPath(entry);
        if (name == "") continue;
        if (!seen.Add(name)) throw new InvalidDataException("Archive contains a duplicate or case-colliding path: " + name);
        bool directory = entry.FullName.EndsWith("/", StringComparison.Ordinal);
        bool evidence = name.Equals("app/release-evidence", StringComparison.OrdinalIgnoreCase) || name.StartsWith("app/release-evidence/", StringComparison.OrdinalIgnoreCase);
        if (evidence) continue; // Installer copies only its explicit adjacent evidence after validation.
        if (directory) {
          if (!directories.Contains(name) || entry.Length != 0) throw new InvalidDataException("Archive contains an unlisted directory: " + name);
        } else if (name == "app/release-manifest.json") {
          if (ReadManifestEntry(entry) != manifestText) throw new InvalidDataException("Archive manifest changed during validation.");
        } else {
          int index;
          if (!records.TryGetValue(name, out index)) throw new InvalidDataException("Archive contains an unlisted file: " + name);
          if (entry.Length != sizes[index]) throw new InvalidDataException("Archive payload file size does not match its manifest record: " + name);
          payloadCount++;
        }
      }
      if (payloadCount != paths.Length || !seen.Contains("app/release-manifest.json")) throw new InvalidDataException("Archive is missing a manifested payload file.");
      byte[] buffer = new byte[131072]; int completed = 0;
      foreach (var entry in archive.Entries) {
        string name = EntryPath(entry);
        if (name == "" || entry.FullName.EndsWith("/", StringComparison.Ordinal) || name.StartsWith("app/release-evidence/", StringComparison.OrdinalIgnoreCase)) continue;
        int index; bool payload = records.TryGetValue(name, out index);
        if (!payload && name != "app/release-manifest.json") continue;
        string destination = Path.GetFullPath(Path.Combine(stage, name.Replace('/', Path.DirectorySeparatorChar)));
        if (!destination.StartsWith(stage + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) throw new InvalidDataException("Archive payload escapes the staging root.");
        CreateSafeParents(stage, destination);
        using (var input = entry.Open())
        using (var output = new FileStream(destination, FileMode.CreateNew, FileAccess.Write, FileShare.None))
        using (var sha256 = SHA256.Create()) {
          long written = 0; int count;
          long expectedSize = payload ? sizes[index] : entry.Length;
          while ((count = input.Read(buffer, 0, buffer.Length)) != 0) {
            written += count;
            if (written > expectedSize) throw new InvalidDataException("Archive payload exceeds its declared size: " + name);
            output.Write(buffer, 0, count);
            sha256.TransformBlock(buffer, 0, count, buffer, 0);
          }
          sha256.TransformFinalBlock(new byte[0], 0, 0);
          if (written != expectedSize) throw new InvalidDataException("Archive payload size does not match its manifest record: " + name);
          if (payload && !String.Equals(BitConverter.ToString(sha256.Hash).Replace("-", "").ToLowerInvariant(), hashes[index], StringComparison.Ordinal))
            throw new InvalidDataException("Staged payload file hash does not match its manifest record: " + name);
        }
        if (payload) {
          completed++;
          if (progress && (completed % 128 == 0 || completed == paths.Length)) Console.WriteLine("GOATCITADEL_PROGRESS Extracting-and-hashing " + completed + "/" + paths.Length);
        }
      }
    }
  }
}
"@

function Report-ValidationProgress {
  param([string]$Phase, [int]$Completed, [int]$Total)
  if ($ProgressOutput) { Write-Output "GOATCITADEL_PROGRESS $Phase $Completed/$Total" }
}

function Compare-Utf8Bytes {
  param([string]$Left, [string]$Right)

  return [GoatCitadelInstallerPaths]::CompareUtf8($Left, $Right)
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
  if ($segments[0] -cne "app" -and $segments[0] -cne "bin") {
    throw "Release manifest payload path is unsafe: $Value"
  }
  foreach ($segment in $segments) {
    if ($segment.Length -eq 0 -or $segment -eq "." -or $segment -eq ".." -or $segment -match '[<>:"|?*\x00-\x1F]' -or $segment.EndsWith(".") -or $segment.EndsWith(" ") -or $segment -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])($|\.)') {
      throw "Release manifest payload path is unsafe: $Value"
    }
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

if ($ArchivePath -and $InstalledRoot) { throw "Archive extraction cannot target an installed root." }
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
    if ($payloadRootNames -contains $rootEntry.Name) {
      if ($ArchivePath) { throw "Archive extraction requires an empty transaction stage." }
      continue
    }
    if (-not $rootEntry.PSIsContainer -and $rootEntry.Name -ceq ".goatcitadel-transaction") { continue }
    throw "Staged Windows bundle contains an unexpected root entry: $($rootEntry.Name)"
  }
}
$manifestPath = Join-Path $stage "app\release-manifest.json"
try {
  if ($ArchivePath) {
    $ArchivePath = [System.IO.Path]::GetFullPath($ArchivePath)
    $archiveInfo = [System.IO.FileInfo]::new($ArchivePath)
    if (-not $archiveInfo.Exists -or ($archiveInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or $archiveInfo.Length -gt $maxTotalBytes) { throw "Bundle archive is missing, oversized, or a reparse point." }
    $manifestText = [GoatCitadelInstallerPaths]::ReadArchiveManifest($ArchivePath)
  } else {
    $manifestInfo = [System.IO.FileInfo]::new($manifestPath)
    if (-not $manifestInfo.Exists) { throw "Staged bundle is missing app/release-manifest.json." }
    if ($manifestInfo.Length -le 0 -or $manifestInfo.Length -gt $maxManifestBytes -or ($manifestInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Staged release manifest is empty, oversized, or a reparse point." }
    $manifestText = [System.IO.File]::ReadAllText($manifestPath)
  }
  $manifest = $manifestText | ConvertFrom-Json
} catch { throw "Bundle manifest could not be read: $($_.Exception.Message)" }
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

$completedFiles = 0
$hashPaths = [System.Collections.Generic.List[string]]::new()
$expectedHashes = [System.Collections.Generic.List[string]]::new()
$relativePaths = [System.Collections.Generic.List[string]]::new()
$expectedSizes = [System.Collections.Generic.List[long]]::new()
$remainingFiles = [System.Collections.Generic.Dictionary[string,long]]::new([System.StringComparer]::OrdinalIgnoreCase)
Report-ValidationProgress "Manifest" 0 $files.Count
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
  $candidate = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($stage, $relativePath.Replace("/", "\")))
  if (-not $candidate.StartsWith($stagePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Staged payload file escapes the bundle root: $relativePath"
  }
  $hashPaths.Add($candidate)
  $expectedHashes.Add($record.sha256)
  $relativePaths.Add($relativePath)
  $expectedSizes.Add([long]$record.sizeBytes)
  $remainingFiles.Add($relativePath, [long]$record.sizeBytes)
  $completedFiles += 1
  if (($completedFiles % 256) -eq 0 -or $completedFiles -eq $files.Count) {
    Report-ValidationProgress "Manifest" $completedFiles $files.Count
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

if ($ArchivePath) {
  Report-ValidationProgress "Extracting-and-hashing" 0 $files.Count
  [GoatCitadelInstallerPaths]::ExtractAndValidate($ArchivePath, $stage, $manifestText, $relativePaths.ToArray(), $expectedHashes.ToArray(), $expectedSizes.ToArray(), $ProgressOutput.IsPresent)
}
Report-ValidationProgress "Inventory" 0 $files.Count
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
    [long]$expectedSize = 0
    if (-not $remainingFiles.TryGetValue($relativePath, [ref]$expectedSize)) {
      throw "Staged Windows bundle contains an unlisted file: $relativePath"
    }
    [string]$manifestPathKey = $null
    [void]$seen.TryGetValue($relativePath, [ref]$manifestPathKey)
    # Preserve exact-path existence checks on case-sensitive Windows directories,
    # without reopening metadata for the normal case-preserving archive layout.
    if ($relativePath -cne $manifestPathKey -and -not [System.IO.File]::Exists([System.IO.Path]::Combine($stage, $manifestPathKey))) {
      throw "Staged payload file is missing: $manifestPathKey"
    }
    if ($entry.Length -ne $expectedSize) {
      throw "Staged payload file size or type does not match its manifest record: $relativePath"
    }
    [void]$remainingFiles.Remove($relativePath)
    $actualFiles += 1
    if (($actualFiles % 256) -eq 0) { Report-ValidationProgress "Inventory" $actualFiles $files.Count }
    $actualBytes += [long]$entry.Length
  }
}
if ($remainingFiles.Count -ne 0) {
  $missingPath = $remainingFiles.Keys | Select-Object -First 1
  throw "Staged payload file is missing: $missingPath"
}
if ($actualFiles -ne $files.Count -or $actualBytes -ne $totalBytes) {
  throw "Staged Windows bundle filesystem totals do not match the release manifest."
}

Assert-PeMachine (Join-Path $stage "app\desktop\GoatCitadel-Mission-Control-Windows.exe") $expectedMachine "Windows desktop host"
Assert-PeMachine (Join-Path $stage "app\runtime\node\node.exe") $expectedMachine "Bundled Node runtime"

# Validate all paths and the filesystem inventory before opening payloads for hashing.
if (-not $ArchivePath) {
  Report-ValidationProgress "Hashing" 0 $files.Count
  [GoatCitadelInstallerPaths]::ValidateHashes($hashPaths.ToArray(), $expectedHashes.ToArray(), $ProgressOutput.IsPresent, $HashWorkers)
}
Report-ValidationProgress "Verified" $files.Count $files.Count
if ($InstalledRoot) {
  Write-Output "Validated installed GoatCitadel bundle $Target $Version ($actualFiles files, $actualBytes bytes)."
} else {
  Write-Output "Validated staged GoatCitadel bundle $Target $Version ($actualFiles files, $actualBytes bytes)."
}
