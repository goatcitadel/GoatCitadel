#Requires -Version 5.1
param([Parameter(Mandatory = $true)][string]$RepositoryRoot, [Parameter(Mandatory = $true)][string]$ArtifactRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$artifact = [IO.Path]::GetFullPath($ArtifactRoot)
$temp = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $artifact.StartsWith($temp, [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $artifact)) {
  throw 'Use a fresh test directory below the system temporary directory.'
}
[void][IO.Directory]::CreateDirectory($artifact)
. (Join-Path $RepositoryRoot 'scripts\remote-worker\broker-state-common.ps1')
Initialize-BrokerCoordinatorStateNativeType
$type = [GoatCitadel.RemoteWorker.BrokerCoordinator.StateDirectoryLease]
$outcomes = New-Object 'Collections.Generic.List[string]'
function Check { param([bool]$Value, [string]$Message); if (-not $Value) { throw $Message } }
function Refuses { param([scriptblock]$Action); $refused = $false; try { & $Action } catch { $refused = $true }; Check $refused 'Expected refusal.' }
function Case { param([string]$Name, [scriptblock]$Action); try { & $Action; $outcomes.Add($Name) } catch { throw ($Name + ': ' + $_.Exception.Message + ' ' + $_.ScriptStackTrace) } }
function Leases { return ,(New-Object 'Collections.Generic.List[object]') }
function Failures { return ,(New-Object 'Collections.Generic.List[string]') }
function Fixture { param([string]$Name); $path = Join-Path $artifact $Name; [void][IO.Directory]::CreateDirectory($path); return $path }

$productionSddl = $script:ProtectedStateSddl
Case 'production-state-owner-group-and-two-ace-contract' {
  $descriptor = New-Object Security.AccessControl.RawSecurityDescriptor($productionSddl)
  Check ($descriptor.Owner.Value -ceq 'S-1-5-18' -and $descriptor.Group.Value -ceq 'S-1-5-18') 'State owner/group is not SYSTEM.'
  Check ($descriptor.DiscretionaryAcl.Count -eq 2) 'State ACE count changed.'
  Check ($descriptor.DiscretionaryAcl[0].SecurityIdentifier.Value -ceq 'S-1-5-18') 'SYSTEM must be first.'
  Check ($descriptor.DiscretionaryAcl[1].SecurityIdentifier.Value -ceq 'S-1-5-80-1765223994-2719708455-3112291649-2938929260-976374647') 'Signer SID differs.'
  foreach ($ace in $descriptor.DiscretionaryAcl) { Check ($ace.AccessMask -eq 0x001f01ff -and [int]$ace.AceFlags -eq 0 -and [int]$ace.AceType -eq 0) 'State grants differ.' }
  $type::AssertSecurity($productionSddl, $productionSddl)
}
Case 'state-security-refuses-owner-group-mask-flags-and-extra-grants' {
  foreach ($bad in @(
      $productionSddl.Replace('O:SY', 'O:BA'), $productionSddl.Replace('G:SY', 'G:BA'),
      $productionSddl.Replace('D:P', 'D:PAI'), $productionSddl.Replace('D:P', 'D:'),
      $productionSddl.Replace('(A;;', '(A;CI;'), $productionSddl.Replace('0x001f01ff', '0x001200a9'),
      ($productionSddl + '(A;;FA;;;BA)'))) { Refuses { $type::AssertSecurity($bad, $productionSddl) } }
  foreach ($flag in @(1, 2, 8, 256, 1024)) {
    $descriptor = New-Object Security.AccessControl.RawSecurityDescriptor($productionSddl)
    $descriptor.SetFlags([Security.AccessControl.ControlFlags]([int]$descriptor.ControlFlags -bor $flag))
    $bytes = New-Object byte[] $descriptor.BinaryLength; $descriptor.GetBinaryForm($bytes, 0)
    Refuses { $type::AssertSecurityBytes($bytes, $productionSddl) }
  }
}

# Exercise the same real native creation/read-back/rollback under a temporary
# owner. Assigning SYSTEM ownership requires the separate elevated host proof.
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$script:ProtectedStateSddl = $productionSddl.Replace('O:SYG:SY', ('O:' + $sid + 'G:' + $sid)).Replace(';;;SY)', (';;;' + $sid + ')'))
try {
  Case 'five-directories-normalize-inherited-indexing-and-verify-exact-layout' {
    $root = Fixture 'complete'; [IO.File]::SetAttributes($root, [IO.FileAttributes]::Directory -bor [IO.FileAttributes]::NotContentIndexed)
    $owned = Leases; $failures = Failures
    try {
      $records = New-BrokerCoordinatorStateLayout -ProvisionerDirectory $root -Leases $owned
      Check ($records.Count -eq 5 -and $owned.Count -eq 5) 'Fixed state inventory is incomplete.'
      Check ((Get-BrokerCoordinatorStateReadBack -Leases $owned).Count -eq 5) 'Final state read-back failed.'
      foreach ($record in $records) { Check ([int][IO.File]::GetAttributes($record.path) -eq 16) 'Unexpected state attributes.' }
      Check ([int][IO.File]::GetAttributes($root) -eq 8208) 'Parent attributes changed.'
      Refuses { [IO.Directory]::Move($owned[0].Path, ($owned[0].Path + '-moved')) }
    } finally { Undo-BrokerCoordinatorCreatedState -Leases $owned -Failures $failures }
    Check ($failures.Count -eq 0 -and -not (Test-Path -LiteralPath (Join-Path $root 'state-v1'))) 'Owned empty state cleanup failed.'
  }
  Case 'existing-state-is-never-adopted-or-overwritten' {
    $root = Fixture 'existing'; $state = Join-Path $root 'state-v1'; [void][IO.Directory]::CreateDirectory($state)
    $marker = Join-Path $state 'keep.txt'; [IO.File]::WriteAllText($marker, 'preserve')
    $owned = Leases
    Refuses { New-BrokerCoordinatorStateLayout -ProvisionerDirectory $root -Leases $owned }
    Check ($owned.Count -eq 0 -and [IO.File]::ReadAllText($marker) -ceq 'preserve') 'Pre-existing state changed or was claimed.'
  }
  Case 'partial-state-rollback-removes-only-owned-empty-directories' {
    $root = Fixture 'partial'; $marker = Join-Path $root 'sibling.txt'; [IO.File]::WriteAllText($marker, 'keep')
    $owned = Leases; $failures = Failures; $parent = $type::OpenParent($root)
    try {
      $state = $type::CreateChild($parent, 'state-v1', $script:ProtectedStateSddl); $owned.Add($state)
      $owned.Add($type::CreateChild($state, 'journal', $script:ProtectedStateSddl))
      Undo-BrokerCoordinatorCreatedState -Leases $owned -Failures $failures
    } finally { $parent.Dispose() }
    Check ($failures.Count -eq 0 -and [IO.File]::ReadAllText($marker) -ceq 'keep') 'Partial rollback lost unrelated content.'
    Check (-not (Test-Path -LiteralPath (Join-Path $root 'state-v1'))) 'Partial state remained.'
  }
  Case 'rollback-preserves-nonempty-state-and-reports-it' {
    $root = Fixture 'nonempty'; $owned = Leases; $failures = Failures
    $null = New-BrokerCoordinatorStateLayout -ProvisionerDirectory $root -Leases $owned
    $marker = Join-Path $owned[1].Path 'keep.txt'; [IO.File]::WriteAllText($marker, 'preserve state')
    Refuses { Get-BrokerCoordinatorStateReadBack -Leases $owned }
    Undo-BrokerCoordinatorCreatedState -Leases $owned -Failures $failures
    Check ($failures.Count -eq 2 -and [IO.File]::ReadAllText($marker) -ceq 'preserve state') 'Nonempty state was removed or not reported.'
  }
  Case 'relative-state-creation-rejects-unknown-or-escaping-components' {
    $root = Fixture 'components'; $parent = $type::OpenParent($root)
    try {
      foreach ($name in @('..', '..\journal', 'C:\journal', 'other', 'Journal')) { Refuses { $type::CreateChild($parent, $name, $script:ProtectedStateSddl) } }
      Refuses { $parent.RemoveCreatedEmpty() }
      Check ($parent.ReadEntries().Length -eq 0) 'Invalid component created content.'
    } finally { $parent.Dispose() }
  }
  Case 'aliased-parent-is-refused-before-state-creation' {
    $root = Fixture 'alias-target'; $alias = Join-Path $artifact 'alias'
    New-Item -ItemType Junction -Path $alias -Target $root | Out-Null
    Refuses { $lease = $type::OpenParent($alias); $lease.Dispose() }
    Check (@(Get-ChildItem -LiteralPath $root -Force).Count -eq 0) 'Alias target changed.'
  }
} finally { $script:ProtectedStateSddl = $productionSddl }

$receipt = [ordered]@{ passed = $true; powershell = $PSVersionTable.PSVersion.ToString(); scenarios = $outcomes.ToArray(); scenarioCount = $outcomes.Count; serviceMutations = 0; installedPathMutations = 0; boundary = 'Real native temporary-directory proof with current-user ownership; SYSTEM-owned installed startup requires GOATBOX.' }
$json = $receipt | ConvertTo-Json -Depth 4
[IO.File]::WriteAllText((Join-Path $artifact 'state-behavior-receipt.json'), $json)
Write-Output $json
