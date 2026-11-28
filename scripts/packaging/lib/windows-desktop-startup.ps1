function Test-DesktopStartupSnapshotOwner {
  param(
    [object]$Snapshot,
    [int]$ExpectedProcessId,
    [DateTimeOffset]$StartedAfter
  )

  if ($null -eq $Snapshot) { return $false }
  try {
    $timestamp = $Snapshot.recordedAt
    $recordedAt = [DateTimeOffset]::MinValue
    if ($timestamp -is [DateTime] -or $timestamp -is [DateTimeOffset]) {
      $recordedAt = [DateTimeOffset]$timestamp
    }
    elseif ($timestamp -isnot [string] -or
        -not [DateTimeOffset]::TryParse($timestamp, [ref]$recordedAt)) {
      return $false
    }
    return (($Snapshot.schemaVersion -is [int] -or $Snapshot.schemaVersion -is [long]) -and
      $Snapshot.schemaVersion -eq 1 -and
      ($Snapshot.processId -is [int] -or $Snapshot.processId -is [long]) -and
      $Snapshot.processId -eq $ExpectedProcessId -and
      $recordedAt -ge $StartedAfter)
  }
  catch {
    return $false
  }
}

function Get-VerifiedDesktopNavigation {
  param(
    [object]$Snapshot,
    [int]$ExpectedProcessId,
    [DateTimeOffset]$StartedAfter
  )

  if (-not (Test-DesktopStartupSnapshotOwner @PSBoundParameters)) { return $null }
  try {
    if ($Snapshot.phase -ne "navigation-completed" -or
        $Snapshot.navigationSucceeded -isnot [bool] -or
        $Snapshot.navigationSucceeded -ne $true -or
        [string]::IsNullOrWhiteSpace($Snapshot.title)) { return $null }
    $uri = $null
    if (-not [Uri]::TryCreate([string]$Snapshot.url, [UriKind]::Absolute, [ref]$uri) -or
        $uri.Scheme -notin @("http", "https") -or -not $uri.IsLoopback -or
        -not [string]::IsNullOrEmpty($uri.UserInfo) -or
        -not [string]::IsNullOrEmpty($uri.Query) -or
        -not [string]::IsNullOrEmpty($uri.Fragment)) { return $null }
    return [pscustomobject]@{ type = "page"; url = $uri.AbsoluteUri; title = $Snapshot.title }
  }
  catch {
    # A partial, malformed, or older snapshot cannot prove this host's navigation.
    return $null
  }
}

function Get-VerifiedDesktopStartupFailure {
  param(
    [object]$Snapshot,
    [int]$ExpectedProcessId,
    [DateTimeOffset]$StartedAfter
  )

  if (-not (Test-DesktopStartupSnapshotOwner @PSBoundParameters)) { return $null }
  try {
    if ($Snapshot.phase -isnot [string] -or
        $Snapshot.phase -cnotin @("webview-failed", "runtime-failed") -or
        $Snapshot.errorType -isnot [string] -or
        [string]::IsNullOrWhiteSpace($Snapshot.errorType) -or
        $Snapshot.errorCode -isnot [string] -or
        $Snapshot.errorCode -cnotmatch '^0x[0-9A-F]{8}$') { return $null }
    return [pscustomobject]@{
      phase = $Snapshot.phase
      errorType = $Snapshot.errorType
      errorCode = $Snapshot.errorCode
    }
  }
  catch {
    return $null
  }
}
