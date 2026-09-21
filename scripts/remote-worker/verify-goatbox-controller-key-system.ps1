#Requires -Version 5.1
# Runs a single SYSTEM review of the already-created controller key. The key
# and its permissions are never changed. Only a protected review directory,
# public report, and temporary (subsequently removed) scheduled task are created.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ([Environment]::MachineName -cne 'GOATBOX' -or $env:COMPUTERNAME -cne 'GOATBOX') { throw 'GOATBOX only.' }
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator PowerShell required.' }
$worker=@'
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
function Assert-ControllerReviewSecurity([byte[]]$Bytes, [switch]$ProviderDescriptor) {
  $sd=[Security.AccessControl.RawSecurityDescriptor]::new($Bytes,0)
  if ($sd.Owner.Value -cne 'S-1-5-18' -or
      ($sd.ControlFlags -band [Security.AccessControl.ControlFlags]::DiscretionaryAclProtected) -eq 0 -or
      $null -eq $sd.DiscretionaryAcl -or $sd.DiscretionaryAcl.Count -ne 2) { throw 'Controller key owner/DACL differs.' }
  $expected=@('S-1-5-18','S-1-5-80-1810587747-2867442932-4204439414-1143594691-3479143721')
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  $allowedMasks=@(0x10000000,0x001f01ff)
  # Provider-only representation observed on GOATBOX; file ACLs stay strict.
  if ($ProviderDescriptor) { $allowedMasks+=([BitConverter]::ToInt32([byte[]]@(255,1,31,208),0)) }
  foreach ($ace in $sd.DiscretionaryAcl) {
    if ($ace -isnot [Security.AccessControl.CommonAce] -or $ace.IsCallback -or
        $ace.AceQualifier -ne [Security.AccessControl.AceQualifier]::AccessAllowed -or
        $ace.AceFlags -ne [Security.AccessControl.AceFlags]::None -or
        $ace.AccessMask -notin $allowedMasks -or
        $ace.SecurityIdentifier.Value -cnotin $expected -or -not $seen.Add($ace.SecurityIdentifier.Value)) {
      throw 'Controller key grants differ.'
    }
  }
}
function Get-ControllerReviewSecurityReport([byte[]]$Bytes) {
  $sd=[Security.AccessControl.RawSecurityDescriptor]::new($Bytes,0)
  $aces=@(foreach ($ace in $sd.DiscretionaryAcl) {
    [ordered]@{type=[string]$ace.AceType;flags=[string]$ace.AceFlags;
      mask=('0x{0:X8}' -f $ace.AccessMask);sid=$ace.SecurityIdentifier.Value}
  })
  return [ordered]@{sddl=$sd.GetSddlForm([Security.AccessControl.AccessControlSections]::All);
    owner=$sd.Owner.Value;controlFlags=[string]$sd.ControlFlags;aces=$aces}
}
function ConvertTo-ControllerPublicPoint([byte[]]$Blob) {
  if ($Blob.Length -ne 72 -or [BitConverter]::ToUInt32($Blob,0) -ne 0x31534345 -or
      [BitConverter]::ToUInt32($Blob,4) -ne 32) { throw 'Expected ECDSA P-256 public blob.' }
  return ,([byte[]](@(4)+@($Blob[8..71])))
}
# Execute only in the dedicated SYSTEM task, never in an administrator shell.
if ([Environment]::MachineName -cne 'GOATBOX' -or [Security.Principal.WindowsIdentity]::GetCurrent().User.Value -cne 'S-1-5-18') {
  throw 'SYSTEM on GOATBOX required.'
}
$key=$null
$report=[ordered]@{schemaVersion='goatcitadel.controller-key-system-review.v1';verdict='failed';stage='open existing machine key';
  computerName='GOATBOX';keyName='GoatCitadel.CellController.Attestation.v1';
  keyCreated=$false;keyPermissionsChanged=$false;privateKeyExported=$false}
try {
  $key=[Security.Cryptography.CngKey]::Open($report.keyName,[Security.Cryptography.CngProvider]::MicrosoftSoftwareKeyStorageProvider,
    ([Security.Cryptography.CngKeyOpenOptions]::MachineKey -bor [Security.Cryptography.CngKeyOpenOptions]::Silent))
  $report.stage='validate persisted key identity and policy'
  $expectedName='5e73bfd4cd51dfdc788ed3095838b24d_b73bf112-8305-4217-a84f-f751c7d78199'
  if ($key.UniqueName -cne $expectedName -or -not $key.IsMachineKey -or
      $key.Algorithm.Algorithm -cne 'ECDSA_P256' -or [int]$key.ExportPolicy -ne 0 -or [int]$key.KeyUsage -ne 2) {
    throw 'Existing controller key identity or policy differs.'
  }
  $report.stage='read provider security descriptor'
  $providerSecurity=$key.GetProperty('Security Descr',[Security.Cryptography.CngPropertyOptions]5).GetValue()
  $report.providerSecurity=Get-ControllerReviewSecurityReport $providerSecurity
  $report.stage='read key-file security descriptor'
  $acl=Get-Acl -LiteralPath (Join-Path 'C:\ProgramData\Microsoft\Crypto\Keys' $expectedName)
  $fileSecurity=$acl.GetSecurityDescriptorBinaryForm()
  $report.fileSecurity=Get-ControllerReviewSecurityReport $fileSecurity
  $report.stage='verify provider SYSTEM/controller-only permissions'
  Assert-ControllerReviewSecurity $providerSecurity -ProviderDescriptor
  $report.stage='verify file SYSTEM/controller-only permissions'
  Assert-ControllerReviewSecurity $fileSecurity
  $report.stage='export public point only'
  $point=ConvertTo-ControllerPublicPoint ($key.Export([Security.Cryptography.CngKeyBlobFormat]::EccPublicBlob))
  $hash=[Security.Cryptography.SHA256]::Create()
  try { $digest=[BitConverter]::ToString($hash.ComputeHash([byte[]]([Text.Encoding]::UTF8.GetBytes("goatcitadel.controller-attestation-key.v1`0")+$point))).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
  $report.publicPointHex=[BitConverter]::ToString($point).Replace('-','').ToLowerInvariant()
  $report.keySha256=$digest
  $report.uniqueName=$expectedName
  $report.securitySddl=$acl.Sddl
  $report.verdict='passed'; $report.stage='completed'
} catch {
  $errorDetail=$_.Exception
  while ($errorDetail.InnerException) { $errorDetail=$errorDetail.InnerException }
  $report.error=$errorDetail.Message
  $report.errorCode='0x{0:X8}' -f $errorDetail.HResult
} finally { if ($null -ne $key) { $key.Dispose() } }
$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($report | ConvertTo-Json -Depth 7))
$file=[IO.File]::Open((Join-Path $PSScriptRoot 'public-review.json'),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $file.Write($bytes,0,$bytes.Length); $file.Flush($true) } finally { $file.Dispose() }
if ($report.verdict -ne 'passed') { exit 1 }
'@
$parent='C:\ProgramData\GoatCitadel'
foreach ($path in @('C:\','C:\ProgramData',$parent)) {
  $item=Get-Item -LiteralPath $path -Force
  if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected parent directory.' }
}
$id=[guid]::NewGuid().ToString('N')
$directory=Join-Path $parent ('ControllerKeyReview-'+$id)
$taskName='GoatCitadel-ControllerKeyReview-'+$id
$security=[Security.AccessControl.DirectorySecurity]::new()
$security.SetSecurityDescriptorSddlForm('O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)')
if (Test-Path -LiteralPath $directory) { throw 'Review directory already exists.' }
# Windows PowerShell 5.1 creates the directory with its protected DACL atomically.
$null=[IO.Directory]::CreateDirectory($directory,$security)
$scriptPath=Join-Path $directory 'review.ps1'
$bytes=[Text.UTF8Encoding]::new($false).GetBytes($worker)
$stream=[IO.File]::Open($scriptPath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
try { $stream.Write($bytes,0,$bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
$lease=[IO.File]::Open($scriptPath,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
$registered=$false
try {
  $exe=Join-Path ([Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)) 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $action=New-ScheduledTaskAction -Execute $exe -Argument ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$scriptPath+'"')
  $system=New-ScheduledTaskPrincipal -UserId 'S-1-5-18' -LogonType ServiceAccount -RunLevel Highest
  $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
  Register-ScheduledTask -TaskName $taskName -Action $action -Principal $system -Settings $settings -ErrorAction Stop | Out-Null
  $registered=$true
  'Validating the existing controller key as SYSTEM; no key changes...'
  Start-ScheduledTask -TaskName $taskName -ErrorAction Stop
  $deadline=[DateTime]::UtcNow.AddSeconds(55)
  $reportPath=Join-Path $directory 'public-review.json'
  do {
    Start-Sleep -Milliseconds 500
    $task=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if ((Test-Path -LiteralPath $reportPath) -and $task.State -ne 'Running') { break }
  } while ([DateTime]::UtcNow -lt $deadline)
  if ($task.State -eq 'Running' -or -not (Test-Path -LiteralPath $reportPath)) { throw ('Review did not complete. Preserve '+$directory) }
  $report=Get-Content -Raw -LiteralPath $reportPath | ConvertFrom-Json
  $report | ConvertTo-Json -Depth 7
  'Public evidence: '+$reportPath
  if ($report.verdict -cne 'passed') { throw 'Key review failed. Preserve the report; do not repeat.' }
} finally {
  if ($registered) {
    $task=Get-ScheduledTask -TaskName $taskName -ErrorAction Stop
    if ($task.State -eq 'Running') { Stop-ScheduledTask -TaskName $taskName -ErrorAction Stop }
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction Stop
  }
  $lease.Dispose()
}
