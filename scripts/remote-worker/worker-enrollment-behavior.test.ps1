#Requires -Version 5.1
param([Parameter(Mandatory=$true)][string]$FixtureRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'worker-enrollment-common.ps1')
Initialize-WorkerInstallNative
$cases = [Collections.Generic.List[string]]::new()
function Check-Case { param([bool]$Passed,[string]$Name); if (-not $Passed) { throw ('Behavior failed: '+$Name) }; $cases.Add($Name) }
function Check-Refusal { param([string]$Name,[scriptblock]$Body); $refused=$false; try { & $Body | Out-Null } catch { $refused=$true }; Check-Case $refused $Name }
function Json-Bytes { param($Value); return ,([Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 12 -Compress))) }
function Copy-Fields { param($Value); $copy=[ordered]@{}; foreach ($key in $Value.Keys) { $copy[$key]=$Value[$key] }; return $copy }
$owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$sddl = "O:${owner}D:P(A;;FA;;;$owner)"
try {
  Assert-WorkerDeferredTicketChoice '' ''
  Assert-WorkerDeferredTicketChoice 'ticket.json' ('a'*64)
  Check-Refusal 'deferred-ticket-requires-pin' { Assert-WorkerDeferredTicketChoice 'ticket.json' '' }
  Check-Refusal 'deferred-ticket-requires-path' { Assert-WorkerDeferredTicketChoice '' ('a'*64) }
  $ticketBytes=Json-Bytes ([ordered]@{protectedSignerPublicKeySpkiBase64Url='fixture-public';bootstrapSecret='fixture-only-secret'})
  Assert-WorkerDeferredTicketBytes $ticketBytes (Get-WorkerBytesHash $ticketBytes)
  Check-Refusal 'deferred-ticket-wrong-pin' { Assert-WorkerDeferredTicketBytes $ticketBytes ('a'*64) }
  foreach ($bad in @(@{protectedSignerPrivateKeyPem='fixture';protectedSignerPublicKeySpkiBase64Url='public'},@{protectedSignerPublicKeySpkiBase64Url=3},@{protectedSignerPublicKeySpkiBase64Url=''},@{workerId='x'})) {
    $bytes=Json-Bytes $bad
    Check-Refusal 'deferred-ticket-private-or-missing-public-key' { Assert-WorkerDeferredTicketBytes $bytes (Get-WorkerBytesHash $bytes) }
  }
  $malformed=[Text.Encoding]::UTF8.GetBytes('{"bootstrapSecret":"fixture-secret-do-not-echo",broken')
  try { Assert-WorkerDeferredTicketBytes $malformed (Get-WorkerBytesHash $malformed); throw 'unexpected success' } catch {
    Check-Case ($_.Exception.Message -ceq 'REFUSED: invalid admission ticket JSON.') 'deferred-ticket-parser-redacts-secret'
  }
  $paths = Get-WorkerServicePaths
  $settings = Get-WorkerSettingsBytes $paths '127.0.0.1' 8787 'installed-run'
  $env:GOATCITADEL_CONNECTED_WORKER_CLIENT_KEY_FILE = 'ambient-private-key'
  $env:NODE_OPTIONS = '--inspect=0.0.0.0'
  $start = Get-WorkerEnrollmentStartInfo $paths $settings 'enroll-fixture'
  Check-Case ($start.Arguments -ceq '--foreground' -and $start.FileName -ceq $paths.Image) 'fixed-native-host-and-argument'
  Check-Case ($start.EnvironmentVariables['GOATCITADEL_CONNECTED_WORKER_STOP_AFTER'] -ceq 'admit' -and
    $start.EnvironmentVariables['GOATCITADEL_CONNECTED_WORKER_RUN_MODE'] -ceq 'once') 'admission-only-execution'
  Check-Case ($start.EnvironmentVariables['GOATCITADEL_CONNECTED_WORKER_STATE_DIR'] -ceq $paths.Enrollment -and
    $start.EnvironmentVariables['GOATCITADEL_CONNECTED_WORKER_REPORT_FILE'] -ceq (Join-Path $paths.Enrollment 'report.json')) 'private-state-and-report'
  Check-Case (-not $start.EnvironmentVariables.ContainsKey('NODE_OPTIONS') -and
    -not $start.EnvironmentVariables.ContainsKey('GOATCITADEL_CONNECTED_WORKER_CLIENT_KEY_FILE')) 'ambient-settings-excluded'
  Check-Case ($start.CreateNoWindow -and -not $start.UseShellExecute -and $start.RedirectStandardInput) 'hidden-host-with-lifecycle-pipe'
  $drift = [Text.Encoding]::Unicode.GetBytes(([Text.Encoding]::Unicode.GetString($settings)).Replace('STOP_AFTER=complete','STOP_AFTER=claim'))
  Check-Refusal 'changed-installed-stage-refused' { Get-WorkerEnrollmentStartInfo $paths $drift 'enroll-fixture' }
  Check-Refusal 'run-id-injection-refused' { Get-WorkerEnrollmentStartInfo $paths $settings "run`nHOST=evil" }
  Check-Refusal 'truncated-environment-refused' { Get-WorkerEnrollmentStartInfo $paths ([byte[]]@(1,2,3)) 'enroll-fixture' }

  $credential = [ordered]@{ credentialId='credential-1'; credentialGeneration=1; workerGeneration=1;
    authorizationCredential=('a'*43); protectedKey=[ordered]@{fixture='public-reference'} }
  $credentialBytes = Json-Bytes $credential
  $digest = Get-WorkerBytesHash $credentialBytes
  $report = [ordered]@{runId='enroll-fixture';outcome='stopped';stagesCompleted=@('admit');admitted='bootstrap_exchange';
    credentialId='credential-1';credentialGeneration=1;workerGeneration=1;
    enrollment=[ordered]@{schemaVersion='goatcitadel.remote-worker.enrollment.v1';credentialSha256=$digest}}
  $proof = Get-WorkerEnrollmentProof (Json-Bytes $report) $credentialBytes 'enroll-fixture'
  Check-Case ($proof.sha256 -ceq $digest -and $proof.sizeBytes -eq $credentialBytes.Length) 'receipt-binds-exact-credential-bytes'
  Check-Case (($proof | ConvertTo-Json) -notmatch ('a'*43)) 'public-proof-omits-bearer'
  foreach ($field in @('runId','outcome','admitted','credentialId','credentialGeneration','workerGeneration')) {
    $changed = Copy-Fields $report; $changed[$field] = 'changed'
    Check-Refusal ('changed-report-'+$field) { Get-WorkerEnrollmentProof (Json-Bytes $changed) $credentialBytes 'enroll-fixture' }
  }
  $changed = Copy-Fields $report; $changed.stagesCompleted = @('admit','claim')
  Check-Refusal 'post-admission-work-refused' { Get-WorkerEnrollmentProof (Json-Bytes $changed) $credentialBytes 'enroll-fixture' }
  $changed = Copy-Fields $report; $changed.admitted='retained_credential'
  Check-Case ((Get-WorkerEnrollmentProof (Json-Bytes $changed) $credentialBytes 'enroll-fixture').sha256 -ceq $digest) 'retained-private-authority-resumes'
  Check-Refusal 'credential-drift-refused' { Get-WorkerEnrollmentProof (Json-Bytes $report) (Json-Bytes @{different='bytes'}) 'enroll-fixture' }
  $pem = Copy-Fields $credential; $pem.signingPrivateKeyPem='fixture-private-key'
  $changed=Copy-Fields $report; $changed.enrollment=[ordered]@{schemaVersion='goatcitadel.remote-worker.enrollment.v1';credentialSha256=(Get-WorkerBytesHash (Json-Bytes $pem))}
  Check-Refusal 'pem-credential-refused' { Get-WorkerEnrollmentProof (Json-Bytes $changed) (Json-Bytes $pem) 'enroll-fixture' }
  Check-Refusal 'untrusted-private-directory-acl-refused' { Assert-WorkerEnrollmentPrivateSddl 'O:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;BU)' -Directory }
  Check-Refusal 'empty-private-file-acl-refused' { Assert-WorkerEnrollmentPrivateSddl 'O:SYD:P' }
  Check-Case ($null -eq (Assert-WorkerEnrollmentPrivateSddl "O:${owner}D:AI(A;ID;FA;;;SY)(A;ID;FA;;;BA)")) 'inherited-private-file-permissions-accepted'

  $source = Join-Path $FixtureRoot 'private-credential.json'
  $destination = Join-Path $FixtureRoot 'runtime-credential.json'
  [IO.File]::WriteAllBytes($source,$credentialBytes)
  Check-Case ((Publish-WorkerEnrollmentCredential $source $destination $proof $sddl) -ceq 'published') 'atomic-credential-publication'
  Check-Case ((Get-WorkerFileRecord $destination).sha256 -ceq $digest) 'published-bytes-exact'
  Check-Case ((Publish-WorkerEnrollmentCredential $source $destination $proof $sddl) -ceq 'retained') 'identical-destination-retained'
  [IO.File]::WriteAllText($destination,'existing-worker-credential')
  Check-Refusal 'different-worker-credential-preserved' { Publish-WorkerEnrollmentCredential $source $destination $proof $sddl }
  Check-Case ([IO.File]::ReadAllText($destination) -ceq 'existing-worker-credential') 'no-overwrite-on-conflict'
  $native = [GoatCitadel.RemoteWorker.Install.NativeFiles]
  $lockFile=Join-Path $FixtureRoot 'enrollment.lock'
  $lock=$native::AcquireEnrollmentLock($lockFile)
  try {
    Check-Refusal 'concurrent-enrollment-refused' { $other=$native::AcquireEnrollmentLock($lockFile); $other.Dispose() }
    Check-Refusal 'active-enrollment-lock-cannot-be-replaced' { [IO.File]::Move($lockFile,(Join-Path $FixtureRoot 'lock-moved')) }
  } finally { $lock.Dispose() }
  $lock=$native::AcquireEnrollmentLock($lockFile); $lock.Dispose()
  Check-Case (Test-Path -LiteralPath $lockFile) 'inactive-enrollment-lock-resumes'
  $temporary = Join-Path $FixtureRoot 'held-publication.tmp'
  $created = $false
  $held = $native::CreateProtectedPublicationFile($temporary,$sddl,[ref]$created)
  try {
    $held.Write($credentialBytes,0,$credentialBytes.Length); $held.Flush($true)
    Check-Refusal 'publication-handle-excludes-writers' { [IO.File]::WriteAllText($temporary,'replacement') }
    Check-Refusal 'publication-handle-excludes-rename' { [IO.File]::Move($temporary,(Join-Path $FixtureRoot 'substitute.tmp')) }
    Check-Refusal 'racing-destination-preserved' { $native::PublishOpenedFile($held,$temporary,$destination) }
    Check-Refusal 'publication-directory-escape-refused' { $native::PublishOpenedFile($held,$temporary,(Join-Path $FixtureRoot '..\escaped-credential.json')) }
    Check-Case ([IO.File]::ReadAllText($destination) -ceq 'existing-worker-credential') 'racing-bytes-unchanged'
    $native::DeleteOpenedFile($held)
  } finally { $held.Dispose() }
  Check-Case (-not (Test-Path -LiteralPath $temporary)) 'only-owned-partial-file-removed'
  $hostFixture=Join-Path $FixtureRoot 'host-fixture.ps1'
  [IO.File]::WriteAllText($hostFixture,'Write-Output ''{"error":0,"childExitCode":0,"stopRequested":false,"forced":false,"jobEmpty":true}''; exit 0')
  $hostStart=[Diagnostics.ProcessStartInfo]::new()
  $hostStart.FileName=(Get-Process -Id $PID).Path
  $hostStart.Arguments='-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$hostFixture+'"'
  $hostStart.UseShellExecute=$false; $hostStart.CreateNoWindow=$true
  $hostStart.RedirectStandardInput=$true; $hostStart.RedirectStandardOutput=$true; $hostStart.RedirectStandardError=$true
  Invoke-WorkerEnrollmentHost $hostStart
  Check-Case $true 'clean-host-exit-accepted'
  [IO.File]::WriteAllText($hostFixture,'Write-Output ''{"error":0,"childExitCode":0,"stopRequested":true,"forced":false,"jobEmpty":true}''; exit 0')
  Check-Refusal 'clean-shutdown-is-not-admission-success' { Invoke-WorkerEnrollmentHost $hostStart }
  [IO.File]::WriteAllText($hostFixture,'exit 9')
  Check-Refusal 'failed-host-refused' { Invoke-WorkerEnrollmentHost $hostStart }
  $result = [ordered]@{passed=$true;cases=@($cases.ToArray());scmMutated=$false;networkUsed=$false;powershell=$PSVersionTable.PSVersion.ToString()}
  [IO.File]::WriteAllText((Join-Path $FixtureRoot 'acceptance.json'),($result | ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
  $result | ConvertTo-Json -Depth 5
} catch { Write-Output $_.ScriptStackTrace; throw }
