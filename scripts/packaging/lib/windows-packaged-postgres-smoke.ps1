function Test-PackagedPostgresRecovery {
  param([string]$Node, [string]$Launcher, [string]$AppHome, [string]$RuntimeBase)

  $bin = Join-Path $AppHome "runtime/pgsql/bin"
  $data = Join-Path $RuntimeBase "runtime-root/data/postgres"
  $missingHostBin = Join-Path $RuntimeBase "missing-host/PostgreSQL/16/bin"
  $pgCtl = Join-Path $bin "pg_ctl.exe"
  $pgControlData = Join-Path $bin "pg_controldata.exe"
  $version = & (Join-Path $bin "postgres.exe") --version
  if ($LASTEXITCODE -ne 0 -or $version -cnotmatch '^postgres \(PostgreSQL\) 16\.16\b') {
    throw "Packaged PostgreSQL 16.16 did not execute on this runner."
  }
  if ((Test-Path -LiteralPath $data) -or (Test-Path -LiteralPath $missingHostBin)) {
    throw "The PostgreSQL smoke fixture requires absent cluster and host tool directories."
  }

  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  $listener.Start()
  try { $port = $listener.LocalEndpoint.Port } finally { $listener.Stop() }
  $overrides = @{
    GOATCITADEL_DATABASE_DRIVER = "postgres"
    GOATCITADEL_POSTGRES_MODE = "bundled"
    GOATCITADEL_BUNDLED_POSTGRES_ENABLED = "true"
    GOATCITADEL_BUNDLED_POSTGRES_AUTOSTART = "true"
    GOATCITADEL_BUNDLED_POSTGRES_BIN_DIR = $missingHostBin
    GOATCITADEL_BUNDLED_POSTGRES_DATA_DIR = $data
    GOATCITADEL_BUNDLED_POSTGRES_PORT = [string]$port
    LC_ALL = "C"
  }
  $previous = @{}
  foreach ($name in $overrides.Keys) {
    $previous[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
    [Environment]::SetEnvironmentVariable($name, $overrides[$name], "Process")
  }

  function Read-ClusterIdentifier {
    $output = & $pgControlData $data
    $identifier = $output | Select-String -Pattern '^Database system identifier:\s+(\d+)$' | Select-Object -First 1
    if ($LASTEXITCODE -ne 0 -or -not $identifier) { throw "Could not verify the PostgreSQL test cluster's identity." }
    return $identifier.Matches[0].Groups[1].Value
  }

  try {
    $initialId = $null
    foreach ($attempt in 1, 2) {
      $output = & $Node $Launcher launch --no-open --wait --json
      if ($LASTEXITCODE -ne 0) { throw "PostgreSQL recovery smoke failed to start the packaged Gateway." }
      $status = $output | Where-Object { $_.TrimStart().StartsWith('{') } | Select-Object -Last 1 | ConvertFrom-Json
      if ($status.status -ne "ready" -or -not $status.readiness.gateway) { throw "The PostgreSQL Gateway did not become ready." }
      $identity = Read-ClusterIdentifier
      if ($attempt -eq 1) { $initialId = $identity }
      elseif ($identity -cne $initialId) { throw "Packaged PostgreSQL did not preserve the existing cluster." }
      & $Node $Launcher stop --json | Out-Null
      if ($LASTEXITCODE -ne 0 -or (Test-Path -LiteralPath (Join-Path $data "postmaster.pid"))) {
        throw "Packaged PostgreSQL did not stop cleanly with the Gateway."
      }
    }
    Write-Host "Packaged PostgreSQL initialized and reopened the same cluster with missing host PostgreSQL 16 tools."
  } finally {
    try {
      & $Node $Launcher stop --json | Out-Null
      if (Test-Path -LiteralPath (Join-Path $data "postmaster.pid")) {
        & $pgCtl -D $data stop -m fast -w | Out-Null
      }
    } finally {
      foreach ($name in $previous.Keys) {
        [Environment]::SetEnvironmentVariable($name, $previous[$name], "Process")
      }
    }
  }
}
