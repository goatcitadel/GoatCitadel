<#
.SYNOPSIS
Exports a PPTX through desktop PowerPoint at 1600x900, validates every PNG,
and writes a contact sheet plus powerpoint-proof.json without editing the deck.

.EXAMPLE
powershell -NoProfile -NonInteractive -ExecutionPolicy Bypass -File scripts/verification/research-artifact-powerpoint.ps1 -DeckPath workspace/goatcitadel_out/ccg-competitive-landscape-2026-v2.pptx -OutputRoot artifacts/verification/ccg-powerpoint-proof
#>
[CmdletBinding()]
param(
  [string]$DeckPath,

  [string]$OutputRoot
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
  throw "PowerPoint proof requires Windows and the desktop PowerPoint application."
}

if ([string]::IsNullOrWhiteSpace($DeckPath) -and -not [string]::IsNullOrWhiteSpace($env:GOATCITADEL_VERIFY_RESEARCH_DECK)) {
  $DeckPath = $env:GOATCITADEL_VERIFY_RESEARCH_DECK
}

if ([string]::IsNullOrWhiteSpace($DeckPath)) {
  $repositoryRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot "..\.."))
  $preferredDeck = Join-Path $repositoryRoot "workspace\goatcitadel_out\ccg-competitive-landscape-2026-v2.pptx"
  if (Test-Path -LiteralPath $preferredDeck -PathType Leaf) {
    $DeckPath = $preferredDeck
  } else {
    $verificationRoot = Join-Path $repositoryRoot "artifacts\verification"
    $latestReliabilityDeck = @(
      Get-ChildItem -LiteralPath $verificationRoot -Filter "ccg-market-reliability-1.pptx" -File -Recurse -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTimeUtc -Descending |
        Select-Object -First 1
    )
    if ($latestReliabilityDeck.Count -gt 0) {
      $DeckPath = $latestReliabilityDeck[0].FullName
    } else {
      throw "No deck was supplied. Pass -DeckPath, set GOATCITADEL_VERIFY_RESEARCH_DECK, or create $preferredDeck."
    }
  }
}

$resolvedDeck = (Resolve-Path -LiteralPath $DeckPath -ErrorAction Stop).Path
if ([System.IO.Path]::GetExtension($resolvedDeck) -ine ".pptx") {
  throw "DeckPath must identify a .pptx file: $resolvedDeck"
}

$deckItem = Get-Item -LiteralPath $resolvedDeck -ErrorAction Stop
if ($deckItem.PSIsContainer -or $deckItem.Length -lt 4) {
  throw "DeckPath is not a non-empty PowerPoint file: $resolvedDeck"
}

$timestamp = [DateTime]::UtcNow.ToString("yyyy-MM-ddTHH-mm-ss-fffZ")
if ([string]::IsNullOrWhiteSpace($OutputRoot)) {
  $outputParent = $deckItem.DirectoryName
  $outputName = "{0}-powerpoint-proof-{1}" -f [System.IO.Path]::GetFileNameWithoutExtension($deckItem.Name), $timestamp
  $resolvedOutputRoot = [System.IO.Path]::GetFullPath((Join-Path $outputParent $outputName))
} else {
  $resolvedOutputRoot = [System.IO.Path]::GetFullPath($OutputRoot)
}

if (Test-Path -LiteralPath $resolvedOutputRoot) {
  throw "OutputRoot already exists; choose a new directory so proof is never overwritten: $resolvedOutputRoot"
}

$slideDirectory = Join-Path $resolvedOutputRoot "slides"
New-Item -ItemType Directory -Path $slideDirectory | Out-Null

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class GoatCitadelPowerPointWindow {
  [DllImport("user32.dll")]
  public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
}
"@

function Release-ComObject {
  param([object]$Value)
  if ($null -ne $Value -and [System.Runtime.InteropServices.Marshal]::IsComObject($Value)) {
    [void][System.Runtime.InteropServices.Marshal]::FinalReleaseComObject($Value)
  }
}

function Get-PortableRelativePath {
  param(
    [Parameter(Mandatory = $true)]
    [string]$BasePath,
    [Parameter(Mandatory = $true)]
    [string]$TargetPath
  )
  $normalizedBase = [System.IO.Path]::GetFullPath($BasePath).TrimEnd("\", "/") + [System.IO.Path]::DirectorySeparatorChar
  $normalizedTarget = [System.IO.Path]::GetFullPath($TargetPath)
  $baseUri = New-Object System.Uri($normalizedBase)
  $targetUri = New-Object System.Uri($normalizedTarget)
  return [System.Uri]::UnescapeDataString($baseUri.MakeRelativeUri($targetUri).ToString()).Replace("/", "\")
}

function Get-Sha256Hex {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )
  $stream = $null
  $sha256 = $null
  try {
    $stream = [System.IO.File]::OpenRead([System.IO.Path]::GetFullPath($Path))
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    return [System.BitConverter]::ToString($sha256.ComputeHash($stream)).Replace("-", "").ToLowerInvariant()
  } finally {
    if ($null -ne $stream) { $stream.Dispose() }
    if ($null -ne $sha256) { $sha256.Dispose() }
  }
}

$existingPowerPointProcessIds = [System.Collections.Generic.HashSet[int]]::new()
foreach ($process in [System.Diagnostics.Process]::GetProcessesByName("POWERPNT")) {
  [void]$existingPowerPointProcessIds.Add($process.Id)
  $process.Dispose()
}

$application = $null
$presentation = $null
$powerPointProcessId = 0
$ownsApplicationProcess = $false
$slideCount = 0

try {
  try {
    $application = New-Object -ComObject PowerPoint.Application
  } catch {
    throw "Could not start desktop PowerPoint through COM. Install Microsoft PowerPoint and retry. $($_.Exception.Message)"
  }

  $nativeProcessId = [uint32]0
  [void][GoatCitadelPowerPointWindow]::GetWindowThreadProcessId([IntPtr]$application.HWND, [ref]$nativeProcessId)
  $powerPointProcessId = [int]$nativeProcessId
  $ownsApplicationProcess = $powerPointProcessId -gt 0 -and -not $existingPowerPointProcessIds.Contains($powerPointProcessId)

  # ReadOnly=true, Untitled=false, WithWindow=false. The deck never becomes an
  # editable document and no presentation window is shown.
  $presentation = $application.Presentations.Open($resolvedDeck, -1, 0, 0)
  $slideCount = [int]$presentation.Slides.Count
  if ($slideCount -lt 1) {
    throw "PowerPoint opened the deck, but it contains no slides."
  }

  for ($index = 1; $index -le $slideCount; $index += 1) {
    $slide = $null
    try {
      $slide = $presentation.Slides.Item($index)
      $slidePath = Join-Path $slideDirectory ("slide-{0:D3}.png" -f $index)
      $slide.Export($slidePath, "PNG", 1600, 900)
    } finally {
      Release-ComObject $slide
    }
  }
} finally {
  if ($null -ne $presentation) {
    try { $presentation.Close() } finally { Release-ComObject $presentation }
  }

  if ($null -ne $application) {
    try {
      # Quit only a process created by this lane, and only when it owns no
      # other presentations. A pre-existing PowerPoint process is never quit.
      if ($ownsApplicationProcess -and [int]$application.Presentations.Count -eq 0) {
        $application.Quit()
      }
    } finally {
      Release-ComObject $application
    }
  }

  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
  [GC]::Collect()
  [GC]::WaitForPendingFinalizers()
}

Add-Type -AssemblyName System.Drawing

$slideFiles = @(Get-ChildItem -LiteralPath $slideDirectory -Filter "slide-*.png" | Sort-Object Name)
if ($slideFiles.Count -ne $slideCount) {
  throw "PowerPoint exported $($slideFiles.Count) image(s), but the deck contains $slideCount slide(s)."
}

$slideEvidence = @()
foreach ($slideFile in $slideFiles) {
  if ($slideFile.Length -lt 1024) {
    throw "Exported slide is unexpectedly small: $($slideFile.FullName) ($($slideFile.Length) bytes)"
  }

  $bitmap = $null
  try {
    $bitmap = [System.Drawing.Bitmap]::FromFile($slideFile.FullName)
    if ($bitmap.Width -ne 1600 -or $bitmap.Height -ne 900) {
      throw "Exported slide has unexpected dimensions: $($slideFile.FullName) ($($bitmap.Width)x$($bitmap.Height))"
    }

    $sampledColors = [System.Collections.Generic.HashSet[int]]::new()
    for ($y = 0; $y -lt $bitmap.Height; $y += 75) {
      for ($x = 0; $x -lt $bitmap.Width; $x += 100) {
        [void]$sampledColors.Add($bitmap.GetPixel($x, $y).ToArgb())
      }
    }
    if ($sampledColors.Count -lt 2) {
      throw "Exported slide appears blank or single-color: $($slideFile.FullName)"
    }

    $slideEvidence += [ordered]@{
      index = $slideEvidence.Count + 1
      path = (Get-PortableRelativePath -BasePath $resolvedOutputRoot -TargetPath $slideFile.FullName).Replace("\", "/")
      bytes = $slideFile.Length
      width = $bitmap.Width
      height = $bitmap.Height
      sampledColorCount = $sampledColors.Count
      sha256 = Get-Sha256Hex -Path $slideFile.FullName
    }
  } finally {
    if ($null -ne $bitmap) { $bitmap.Dispose() }
  }
}

$thumbWidth = 400
$thumbHeight = 225
$labelHeight = 24
$cellHeight = $thumbHeight + $labelHeight
$columns = [Math]::Min(4, $slideCount)
$rows = [Math]::Ceiling($slideCount / $columns)
$contactSheetPath = Join-Path $resolvedOutputRoot "contact-sheet.png"
$contactSheet = [System.Drawing.Bitmap]::new([int]($columns * $thumbWidth), [int]($rows * $cellHeight))
$graphics = [System.Drawing.Graphics]::FromImage($contactSheet)
$indexBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::FromArgb(190, 0, 0, 0))
$textBrush = [System.Drawing.SolidBrush]::new([System.Drawing.Color]::White)
$font = [System.Drawing.Font]::new("Segoe UI", 12, [System.Drawing.FontStyle]::Bold)

try {
  $graphics.Clear([System.Drawing.Color]::FromArgb(24, 28, 36))
  $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  for ($index = 0; $index -lt $slideFiles.Count; $index += 1) {
    $slideBitmap = $null
    try {
      $slideBitmap = [System.Drawing.Bitmap]::FromFile($slideFiles[$index].FullName)
      $column = $index % $columns
      $row = [Math]::Floor($index / $columns)
      $destination = [System.Drawing.Rectangle]::new(
        [int]($column * $thumbWidth),
        [int](($row * $cellHeight) + $labelHeight),
        $thumbWidth,
        $thumbHeight
      )
      $graphics.DrawImage($slideBitmap, $destination)
      $label = "{0:D2}" -f ($index + 1)
      $labelRectangle = [System.Drawing.RectangleF]::new(
        [single](($column * $thumbWidth) + 6),
        [single](($row * $cellHeight) + 2),
        36,
        24
      )
      $graphics.FillRectangle($indexBrush, $labelRectangle)
      $graphics.DrawString($label, $font, $textBrush, $labelRectangle)
    } finally {
      if ($null -ne $slideBitmap) { $slideBitmap.Dispose() }
    }
  }
  $contactSheet.Save($contactSheetPath, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
  $font.Dispose()
  $textBrush.Dispose()
  $indexBrush.Dispose()
  $graphics.Dispose()
  $contactSheet.Dispose()
}

$manifest = [ordered]@{
  schemaVersion = 1
  generatedAtUtc = [DateTime]::UtcNow.ToString("o")
  deckPath = $resolvedDeck
  deckBytes = $deckItem.Length
  deckSha256 = Get-Sha256Hex -Path $resolvedDeck
  powerpointProcessId = $powerPointProcessId
  ownedApplicationProcess = $ownsApplicationProcess
  readOnly = $true
  withWindow = $false
  slideCount = $slideCount
  exportWidth = 1600
  exportHeight = 900
  contactSheet = (Get-PortableRelativePath -BasePath $resolvedOutputRoot -TargetPath $contactSheetPath).Replace("\", "/")
  slides = $slideEvidence
}

$manifestPath = Join-Path $resolvedOutputRoot "powerpoint-proof.json"
$manifest | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $manifestPath -Encoding utf8

Write-Host "PowerPoint proof passed."
Write-Host "Artifact: $resolvedOutputRoot"
Write-Host "Slides: $slideCount"
Write-Host "Contact sheet: $contactSheetPath"
