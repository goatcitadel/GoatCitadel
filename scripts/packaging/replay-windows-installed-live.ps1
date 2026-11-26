[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[1-9][0-9]{0,19}$')]
  [string]$InstallerRunId,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{40}$')]
  [string]$CandidateCommit,

  [Parameter(Mandatory = $true)]
  [ValidatePattern('^[0-9a-f]{64}$')]
  [string]$InstallerSha256
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

if ($env:GITHUB_ACTIONS -ne "true" -or $env:RUNNER_ENVIRONMENT -ne "github-hosted" -or
    $env:RUNNER_OS -ne "Windows" -or $env:RUNNER_ARCH -ne "X64") {
  throw "This acceptance check installs an EXE on a disposable GitHub Windows x64 runner."
}

$runRoot = Join-Path $env:RUNNER_TEMP "installed-live"
$installer = Join-Path $runRoot "candidate/GoatCitadel-Setup-windows-x64.exe"
$installerHash = (Get-FileHash -LiteralPath $installer -Algorithm SHA256).Hash.ToLowerInvariant()
if ($installerHash -cne $InstallerSha256) {
  throw "The downloaded EXE does not match the independently pinned SHA-256."
}
Write-Host "Candidate EXE SHA-256 verified for $CandidateCommit."

function Get-VerifiedFixture(
  [string]$Name,
  [string]$Uri,
  [string]$Sha256,
  [string]$Executable
) {
  $archive = Join-Path $runRoot "$Name.zip"
  $destination = Join-Path $runRoot $Name
  New-Item -ItemType Directory -Path $destination | Out-Null
  curl.exe --fail --silent --show-error --location --proto '=https' --proto-redir '=https' `
    --retry 2 --max-time 240 --output $archive $Uri
  if ($LASTEXITCODE -ne 0 -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $Sha256) {
    throw "The $Name fixture archive could not be fetched with its pinned SHA-256."
  }
  tar.exe -xf $archive -C $destination
  if ($LASTEXITCODE -ne 0) { throw "Could not extract the verified $Name fixture." }
  Remove-Item -LiteralPath $archive
  $matches = @(Get-ChildItem -LiteralPath $destination -Recurse -File -Filter $Executable)
  if ($matches.Count -ne 1) { throw "Expected exactly one $Executable in the verified $Name fixture." }
  return $matches[0].FullName
}

$evidence = Join-Path $runRoot "evidence"
New-Item -ItemType Directory -Path $evidence | Out-Null
$ollama = Get-VerifiedFixture "ollama" `
  "https://github.com/ollama/ollama/releases/download/v0.40.18/ollama-windows-amd64.zip" `
  "ca97292ac1e9acc77fcf473bb2741fa6acd12e3798f261b419680068b7cc4c16" "ollama.exe"
$ntfy = Get-VerifiedFixture "ntfy" `
  "https://github.com/binwiederhier/ntfy/releases/download/v2.38.2/ntfy_2.38.2_windows_amd64.zip" `
  "3549ff885b65325e3ee35047a2d76a3c8be30aa045b478ca17309233f157c2e7" "ntfy.exe"

& (Join-Path $PSScriptRoot "smoke-windows-installer.ps1") `
  -InstallerPath $installer -Target windows-x64 -TrustMode unsigned -ScratchRoot $runRoot `
  -LiveAcceptance @{
    CandidateCommit = $CandidateCommit
    InstallerSha256 = $InstallerSha256
    InstallerRunId = $InstallerRunId
    EvidenceDirectory = $evidence
    OllamaExe = $ollama
    NtfyExe = $ntfy
  }
