function Get-VerifiedDesktopNavigation {
  param(
    [object]$Snapshot,
    [int]$ExpectedProcessId,
    [DateTimeOffset]$StartedAfter
  )

  if ($null -eq $Snapshot) { return $null }
  try {
    if ($Snapshot.schemaVersion -ne 1 -or
        $Snapshot.processId -ne $ExpectedProcessId -or
        $Snapshot.phase -ne "navigation-completed" -or
        $Snapshot.navigationSucceeded -isnot [bool] -or
        $Snapshot.navigationSucceeded -ne $true -or
        [string]::IsNullOrWhiteSpace($Snapshot.title)) { return $null }
    $recordedAt = [DateTimeOffset]::MinValue
    if (-not [DateTimeOffset]::TryParse([string]$Snapshot.recordedAt, [ref]$recordedAt) -or
        $recordedAt -lt $StartedAfter) { return $null }
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
