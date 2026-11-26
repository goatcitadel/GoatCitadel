function Invoke-UpgradeProofRequest {
  param(
    [string]$GatewayUrl,
    [string]$Route,
    [string]$Method = "GET",
    [hashtable]$Body
  )

  $gateway = [Uri]$GatewayUrl
  if (-not $gateway.IsLoopback -or $gateway.Scheme -ne "http" -or $gateway.UserInfo) {
    throw "Installer upgrade proof requires a local HTTP Gateway."
  }
  $request = @{
    Uri = $gateway.GetLeftPart([UriPartial]::Authority) + $Route
    Method = $Method
    TimeoutSec = 30
    MaximumRedirection = 0
    Headers = @{
      Authorization = "Bearer $env:GOATCITADEL_AUTH_TOKEN"
      "Idempotency-Key" = [Guid]::NewGuid().ToString()
    }
  }
  if ($null -ne $Body) {
    $request.ContentType = "application/json"
    $request.Body = $Body | ConvertTo-Json -Depth 12 -Compress
  }
  Invoke-RestMethod @request
}

function Get-UpgradeProfileSnapshot {
  param([string]$GatewayUrl, [string]$WorkspaceId, [string]$SessionId, [string]$Marker)

  $workspaceRoute = "/api/v1/workspaces/$([Uri]::EscapeDataString($WorkspaceId))"
  $sessionRoute = "/api/v1/chat/sessions/$([Uri]::EscapeDataString($SessionId))"
  $workspace = Invoke-UpgradeProofRequest $GatewayUrl $workspaceRoute
  $conversation = Invoke-UpgradeProofRequest $GatewayUrl "$sessionRoute/messages?limit=25"
  $guidance = Invoke-UpgradeProofRequest $GatewayUrl "$workspaceRoute/guidance"
  $messages = @($conversation.items | ForEach-Object {
    [ordered]@{ id = $_.messageId; role = $_.role; content = $_.content }
  })
  if ($workspace.workspaceId -ne $WorkspaceId -or
      $workspace.workspacePrefs.technicalDetailsDefault -ne $true -or
      $messages.Count -lt 2 -or
      -not (@($messages | Where-Object role -eq "assistant").Count) -or
      -not (($guidance | ConvertTo-Json -Depth 14 -Compress).Contains($Marker))) {
    throw "Upgrade profile is missing its workspace, Chat transcript, guidance file, or preference."
  }
  @{
    WorkspaceId = $WorkspaceId
    SessionId = $SessionId
    WorkspaceName = $workspace.name
    Transcript = ($messages | ConvertTo-Json -Depth 10 -Compress)
    Marker = $Marker
  }
}

function New-BetaUpgradeProfile {
  param([string]$GatewayUrl)

  $seed = Invoke-UpgradeProofRequest $GatewayUrl "/api/v1/dev/verification/seed" "POST" @{
    workspaceName = "Installer upgrade verification"
    sessionTitle = "Installer upgrade transcript"
    sessionCount = 1
    longThreadTurns = 4
  }
  $workspaceId = [string]$seed.workspaceId
  $sessionId = [string]$seed.sessionId
  if (-not $workspaceId -or -not $sessionId) {
    throw "Beta fixture did not create a workspace and transcript."
  }
  $workspaceRoute = "/api/v1/workspaces/$([Uri]::EscapeDataString($workspaceId))"
  $workspace = Invoke-UpgradeProofRequest $GatewayUrl $workspaceRoute
  Invoke-UpgradeProofRequest $GatewayUrl $workspaceRoute "PATCH" @{
    expectedRevision = $workspace.revision
    workspacePrefs = @{ technicalDetailsDefault = $true }
  } | Out-Null
  $marker = "Installer upgrade file " + [Guid]::NewGuid().ToString()
  Invoke-UpgradeProofRequest $GatewayUrl "$workspaceRoute/guidance/product" "PUT" @{
    content = $marker
  } | Out-Null
  Get-UpgradeProfileSnapshot $GatewayUrl $workspaceId $sessionId $marker
}

function New-BetaArm64SeedModulePath {
  param([string]$BetaAppRoot, [string]$CandidateManifestPath, [string]$SeedModulePath)

  # The archived ARM64 beta omitted this optional package. Supply only the
  # identical locked package for profile seeding through a process-local NODE_PATH.
  $moduleName = "@img/sharp-win32-arm64"
  $betaSharp = Get-Content -LiteralPath (Join-Path $BetaAppRoot "gateway/node_modules/sharp/package.json") -Raw | ConvertFrom-Json
  $expectedVersion = $betaSharp.optionalDependencies.$moduleName
  $manifest = Get-Content -LiteralPath $CandidateManifestPath -Raw | ConvertFrom-Json
  $candidateRoot = Split-Path -Parent (Split-Path -Parent $CandidateManifestPath)
  $prefix = "app/gateway/node_modules/$moduleName/"
  $entries = @($manifest.payload.files | Where-Object { $_.path.StartsWith($prefix, [StringComparison]::Ordinal) })
  if (-not $expectedVersion -or $manifest.target -ne "windows-arm64" -or $entries.Count -eq 0) {
    throw "Cannot seed the archived ARM64 beta without its matching manifested Sharp module."
  }
  $destRoot = Join-Path $SeedModulePath $moduleName
  foreach ($entry in $entries) {
    $relative = $entry.path.Substring($prefix.Length)
    if ($relative -notmatch '^[a-zA-Z0-9._-]+(/[a-zA-Z0-9._-]+)*$' -or ($relative -split '/') -contains '..') {
      throw "Unsafe Sharp module path in the candidate manifest."
    }
    $source = Join-Path $candidateRoot $entry.path
    $dest = Join-Path $destRoot $relative
    if ((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -ne $entry.sha256) {
      throw "The candidate's Sharp seeding module hash differs from its manifest."
    }
    New-Item -ItemType Directory -Path (Split-Path -Parent $dest) -Force | Out-Null
    Copy-Item -LiteralPath $source -Destination $dest
  }
  $seedModule = Get-Content -LiteralPath (Join-Path $destRoot "package.json") -Raw | ConvertFrom-Json
  if ($seedModule.name -cne $moduleName -or $seedModule.version -cne $expectedVersion) {
    throw "The candidate's Sharp seeding module does not match the beta's locked dependency."
  }
  $SeedModulePath
}
