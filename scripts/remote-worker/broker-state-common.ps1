#Requires -Version 5.1
Set-StrictMode -Version Latest

# protected_filesystem.cpp ExactAcl and OpenProtectedFilesystem: owner AND
# primary group SYSTEM; two explicit full-control ACEs, SYSTEM then signer.
# No Administrators, worker, broker, inherited ACEs or auto-inheritance flags.
$script:ProtectedStateSddl = 'O:SYG:SYD:P(A;;0x001f01ff;;;SY)(A;;0x001f01ff;;;S-1-5-80-1765223994-2719708455-3112291649-2938929260-976374647)'
$script:ProtectedStateChildren = [string[]]@('journal', 'keysets', 'controls', 'quarantine')

function Initialize-BrokerCoordinatorStateNativeType {
  if ('GoatCitadel.RemoteWorker.BrokerCoordinator.StateDirectoryLease' -as [type]) { return }
  Add-Type -Path (Join-Path $PSScriptRoot 'broker-state-native.cs')
}

function New-BrokerCoordinatorStateLayout {
  param(
    [Parameter(Mandatory = $true)][string]$ProvisionerDirectory,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Leases
  )
  if ($Leases.Count -ne 0) { throw 'State creation requires an empty ownership ledger.' }
  Initialize-BrokerCoordinatorStateNativeType
  $type = [GoatCitadel.RemoteWorker.BrokerCoordinator.StateDirectoryLease]
  $parent = $type::OpenParent($ProvisionerDirectory)
  try {
    # Exclusive FILE_CREATE refuses all pre-existing state, including empty
    # trees and reparse points. The held parent is never re-permissioned.
    $root = $type::CreateChild($parent, 'state-v1', $script:ProtectedStateSddl)
    $Leases.Add($root)
    foreach ($name in $script:ProtectedStateChildren) {
      $Leases.Add($type::CreateChild($root, $name, $script:ProtectedStateSddl))
    }
    Get-BrokerCoordinatorStateReadBack -Leases $Leases
  }
  finally { $parent.Dispose() }
}

function Get-BrokerCoordinatorStateReadBack {
  param([Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Leases)
  if ($Leases.Count -ne 5) { throw 'The signer requires exactly five protected state directories.' }
  $records = New-Object 'System.Collections.Generic.List[object]'
  for ($index = 0; $index -lt $Leases.Count; $index++) {
    $expected = [string[]]@()
    if ($index -eq 0) { $expected = $script:ProtectedStateChildren }
    $Leases[$index].Verify($script:ProtectedStateSddl, $expected)
    $records.Add([pscustomobject]@{
      path = $Leases[$index].Path
      identity = $Leases[$index].Identity
      securityDescriptor = $Leases[$index].ReadSecuritySddl()
      attributes = 'Directory'
      children = $expected
    })
  }
  return ,$records.ToArray()
}

function Undo-BrokerCoordinatorCreatedState {
  param(
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$Leases,
    [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[string]]$Failures
  )
  for ($index = $Leases.Count - 1; $index -ge 0; $index--) {
    try { $Leases[$index].RemoveCreatedEmpty() }
    catch { $Failures.Add(('rollback: preserving state directory {0}: {1}' -f $Leases[$index].Path, $_.Exception.Message)) }
    finally { $Leases[$index].Dispose() }
  }
  $Leases.Clear()
}
