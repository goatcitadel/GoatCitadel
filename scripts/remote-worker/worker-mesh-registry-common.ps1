#Requires -Version 5.1
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'worker-install-common.ps1')

function Read-WorkerMeshBytes {
  param([string]$Path, [int]$Maximum)
  $stream = [GoatCitadel.RemoteWorker.Install.NativeFiles]::OpenRead($Path, $Maximum)
  try {
    $bytes = New-Object byte[] ([int]$stream.Length)
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $count = $stream.Read($bytes, $offset, $bytes.Length - $offset)
      if ($count -le 0) { throw 'REFUSED: incomplete mesh registry input.' }
      $offset += $count
    }
    return ,$bytes
  } finally { $stream.Dispose() }
}
function Assert-WorkerMeshFileSecurity {
  param([string]$Path, [string]$Sddl)
  if ((ConvertTo-CanonicalFileSddl ([GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::GetFileSddl($Path))) -cne
      (ConvertTo-CanonicalFileSddl $Sddl)) { throw 'REFUSED: mesh registry file ownership or permissions differ.' }
}
function Get-WorkerMeshSelection {
  param([string]$Configuration, [string]$Sddl)
  $file = Join-Path $Configuration 'mesh-registry.sha256'
  if (-not (Test-Path -LiteralPath $file)) { return 'none' }
  Assert-WorkerMeshFileSecurity $file $Sddl
  $bytes = Read-WorkerMeshBytes $file 64
  $value = [Text.Encoding]::ASCII.GetString($bytes)
  if ($value -cne 'disabled' -and $value -cnotmatch '^[a-f0-9]{64}$') { throw 'REFUSED: invalid mesh registry selection.' }
  return $value
}
function Read-WorkerMeshRegistryInput {
  param([string]$Path, [string]$Sha256, $Ticket)
  if ($Sha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'REFUSED: a mesh registry digest is required.' }
  $bytes = Read-WorkerMeshBytes ([IO.Path]::GetFullPath($Path)) 524288
  if ((Get-WorkerBytesHash $bytes) -cne $Sha256) { throw 'REFUSED: mesh registry input differs from its independent digest.' }
  $registry = ConvertFrom-WorkerJson $bytes
  if ($registry.schemaVersion -cne 'goatcitadel.worker-mesh-tools.v1' -or
      $registry.workspaceId -cne $Ticket.executionWorkspaceId -or $registry.nodeId -cne $Ticket.nodeId -or
      $registry.bindings -isnot [array] -or $registry.bindings.Count -lt 1 -or $registry.bindings.Count -gt 32 -or
      @($registry.PSObject.Properties.Name).Count -ne 4) { throw 'REFUSED: mesh registry identity or shape differs.' }
  foreach ($binding in $registry.bindings) {
    if ($binding.toolName -cnotin @('fs.read','fs.write','fs.list','mcp.http') -or
        $binding.manifest.workspaceId -cne $Ticket.executionWorkspaceId -or $binding.manifest.nodeId -cne $Ticket.nodeId) {
      throw 'REFUSED: mesh registry binding is outside this installed worker.'
    }
  }
  # The runtime remains the authority for exact manifest, native schema, root and
  # permission checks. This command grants no publication, activation or effects.
  return ,$bytes
}
function Publish-WorkerMeshSelection {
  param([string]$Configuration, [string]$Selection, [byte[]]$RegistryBytes,
    [string]$ExpectedCurrent, [string]$Sddl, [scriptblock]$AssertStopped)
  if (($Selection -cne 'disabled' -and $Selection -cnotmatch '^[a-f0-9]{64}$') -or
      ($ExpectedCurrent -cnotin @('none','disabled') -and $ExpectedCurrent -cnotmatch '^[a-f0-9]{64}$') -or
      -not $AssertStopped) { throw 'REFUSED: invalid registry selection request.' }
  if (($Selection -ceq 'disabled' -and $RegistryBytes.Length -ne 0) -or
      ($Selection -cne 'disabled' -and ($RegistryBytes.Length -lt 1 -or $RegistryBytes.Length -gt 524288 -or
        (Get-WorkerBytesHash $RegistryBytes) -cne $Selection))) { throw 'REFUSED: registry bytes do not match the requested selection.' }
  $files = [GoatCitadel.RemoteWorker.Install.NativeFiles]
  & $AssertStopped | Out-Null
  $lockPath = Join-Path $Configuration 'mesh-registry.lock'
  if (-not (Test-Path -LiteralPath $lockPath)) {
    $created = $false
    $createdLock = $files::CreateProtectedFile($lockPath, $Sddl, [ref]$created)
    $createdLock.Dispose()
  }
  $lock = $files::AcquireEnrollmentLock($lockPath)
  try {
    Assert-WorkerMeshFileSecurity $lockPath $Sddl
    & $AssertStopped | Out-Null
    if ((Get-WorkerMeshSelection $Configuration $Sddl) -cne $ExpectedCurrent) { throw 'REFUSED: the active registry selection changed.' }
    if ($Selection -cne 'disabled') {
      $destination = Join-Path $Configuration ('mesh-registry-' + $Selection + '.json')
      if (Test-Path -LiteralPath $destination) {
        Assert-WorkerMeshFileSecurity $destination $Sddl
        if ((Get-WorkerBytesHash (Read-WorkerMeshBytes $destination 524288)) -cne $Selection) {
          throw 'REFUSED: retained immutable registry bytes changed.'
        }
      } else {
        $temporary = Join-Path $Configuration ('mesh-registry-content-' + [guid]::NewGuid().ToString('N') + '.tmp')
        $created = $false
        $stream = $files::CreateProtectedPublicationFile($temporary, $Sddl, [ref]$created)
        try {
          $stream.Write($RegistryBytes, 0, $RegistryBytes.Length); $stream.Flush($true)
          $files::PublishOpenedFile($stream, $temporary, $destination)
        } finally { $stream.Dispose() }
      }
    }
    if ($ExpectedCurrent -ceq $Selection) { return [pscustomobject]@{ changed=$false; previous=$ExpectedCurrent; selected=$Selection } }
    $pointer = Join-Path $Configuration 'mesh-registry.sha256'
    $temporary = Join-Path $Configuration ('mesh-registry-selection-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $created = $false
    $stream = $files::CreateProtectedPublicationFile($temporary, $Sddl, [ref]$created)
    try {
      $bytes = [Text.Encoding]::ASCII.GetBytes($Selection)
      $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true)
      & $AssertStopped | Out-Null
      if ((Get-WorkerMeshSelection $Configuration $Sddl) -cne $ExpectedCurrent) { throw 'REFUSED: the active registry selection changed before publication.' }
      if ($ExpectedCurrent -ceq 'none') { $files::PublishOpenedFile($stream, $temporary, $pointer) }
      else { $files::ReplaceOpenedMeshRegistrySelection($stream, $temporary, $pointer) }
    } finally { $stream.Dispose() }
    if ((Get-WorkerMeshSelection $Configuration $Sddl) -cne $Selection) { throw 'REFUSED: registry publication needs reconciliation.' }
    return [pscustomobject]@{ changed=$true; previous=$ExpectedCurrent; selected=$Selection }
  } finally { $lock.Dispose() }
}
