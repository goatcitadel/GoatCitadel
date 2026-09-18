#Requires -Version 5.1
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'read-broker-target-diagnostic.ps1') -SelfTest | Out-Null
$reader = [GoatCitadel.BrokerTargetDiagnostic.Reader]
$checks = 0

function Assert-Result([bool]$Actual, [bool]$Expected, [string]$Label) {
  if ($Actual -ne $Expected) { throw "Diagnostic classification failed: $Label" }
  $script:checks++
}

foreach ($case in @(
  @{ label='running'; fields=@{ type=16; state=4; processId=42 }; expected=$true },
  @{ label='running has PID'; fields=@{ type=16; state=4 }; expected=$false },
  @{ label='clean stopped'; fields=@{ type=16; state=1 }; expected=$true },
  @{ label='never started'; fields=@{ type=16; state=1; win32ExitCode=1077 }; expected=$true },
  @{ label='never started cannot mask failure'; fields=@{ type=16; state=1; win32ExitCode=1077; serviceExitCode=9 }; expected=$false },
  @{ label='stopped cannot claim PID'; fields=@{ type=16; state=1; processId=42 }; expected=$false },
  @{ label='SCM bootstrap'; fields=@{ type=16; state=2; waitHint=2000 }; expected=$true },
  @{ label='unknown zero checkpoint'; fields=@{ type=16; state=2; waitHint=30000 }; expected=$false },
  @{ label='signer startup'; fields=@{ type=16; state=2; checkpoint=1; waitHint=15000 }; expected=$true },
  @{ label='signer shutdown'; fields=@{ type=16; state=3; checkpoint=1; waitHint=5000 }; expected=$true },
  @{ label='oversized wait'; fields=@{ type=16; state=3; checkpoint=1; waitHint=30001 }; expected=$false },
  @{ label='signer failure'; fields=@{ type=16; state=1; win32ExitCode=1066; serviceExitCode=9 }; expected=$false },
  @{ label='active previous failure'; fields=@{ type=16; state=4; processId=42; win32ExitCode=1077 }; expected=$false },
  @{ label='unexpected flags'; fields=@{ type=16; state=4; processId=42; flags=1 }; expected=$false },
  @{ label='unexpected service type'; fields=@{ type=32; state=4; processId=42 }; expected=$false },
  @{ label='running checkpoint drift'; fields=@{ type=16; state=4; processId=42; checkpoint=1 }; expected=$false }
)) {
  $status = New-Object GoatCitadel.BrokerTargetDiagnostic.Status -Property $case.fields
  Assert-Result ($reader::StatusAccepted($status, $true)) $case.expected $case.label
}
$status = New-Object GoatCitadel.BrokerTargetDiagnostic.Status -Property @{ type=16; state=2; waitHint=2000 }
Assert-Result ($reader::StatusAccepted($status, $false)) $false 'broker cannot use signer bootstrap exception'

function New-SignerToken {
  $item = New-Object GoatCitadel.BrokerTargetDiagnostic.Observation
  $item.tokenQuery = $true
  $item.tokenUserSid = 'S-1-5-18'
  $item.tokenType = 1
  $item.tokenSession = 0
  $item.tokenAppContainer = 0
  $item.tokenRestricted = $false
  $item.tokenServiceGroups = @(
    (New-Object GoatCitadel.BrokerTargetDiagnostic.LogonGroup -Property @{ sid='S-1-5-80-1765223994-2719708455-3112291649-2938929260-976374647'; attributes=12 }),
    (New-Object GoatCitadel.BrokerTargetDiagnostic.LogonGroup -Property @{ sid='S-1-5-6'; attributes=4 })
  )
  $item.tokenPrivileges = @((New-Object GoatCitadel.BrokerTargetDiagnostic.Privilege -Property @{ isChangeNotify=$true; attributes=2 }))
  return $item
}
$item = New-SignerToken
Assert-Result ($reader::TokenMatchesSigner($item)) $true 'expected signer token'
foreach ($change in @('user', 'session', 'type', 'restricted', 'appcontainer', 'owner', 'deny', 'duplicate', 'privilege', 'missing')) {
  $item = New-SignerToken
  switch ($change) {
    'user' { $item.tokenUserSid = 'S-1-5-19' }
    'session' { $item.tokenSession = 1 }
    'type' { $item.tokenType = 2 }
    'restricted' { $item.tokenRestricted = $true }
    'appcontainer' { $item.tokenAppContainer = 1 }
    'owner' { $item.tokenServiceGroups[0].attributes = 4 }
    'deny' { $item.tokenServiceGroups[0].attributes = 28 }
    'duplicate' { $item.tokenServiceGroups = @($item.tokenServiceGroups[0], $item.tokenServiceGroups[0], $item.tokenServiceGroups[1]) }
    'privilege' { $item.tokenPrivileges[0].attributes = 0 }
    'missing' { $item.tokenRestricted = $null }
  }
  Assert-Result ($reader::TokenMatchesSigner($item)) $false $change
}
[pscustomobject]@{ passed=$true; checks=$checks } | ConvertTo-Json -Compress
