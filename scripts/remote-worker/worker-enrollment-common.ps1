#Requires -Version 5.1
Set-StrictMode -Version Latest
. (Join-Path $PSScriptRoot 'worker-install-common.ps1')
$script:WorkerEnrollmentSddl = 'O:SYD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)'

# The operator pins the complete ticket, including its one-time secret. Never emit its bytes.
function Assert-WorkerDeferredTicketChoice {
  param([string]$TicketFile,[string]$TicketSha256)
  if ([string]::IsNullOrWhiteSpace($TicketFile) -ne [string]::IsNullOrWhiteSpace($TicketSha256)) {
    throw 'REFUSED: deferred ticket requires both its path and SHA-256.'
  }
}
function Assert-WorkerDeferredTicketBytes {
  param([byte[]]$Bytes,[string]$ExpectedSha256)
  if ($ExpectedSha256 -cnotmatch '^[a-f0-9]{64}$' -or (Get-WorkerBytesHash $Bytes) -cne $ExpectedSha256) {
    throw 'REFUSED: deferred admission ticket hash differs.'
  }
  # Do not surface JSON parser errors, which may contain the bootstrap secret.
  try { $ticket=ConvertFrom-WorkerJson $Bytes } catch { throw 'REFUSED: invalid admission ticket JSON.' }
  if ($null -eq $ticket -or $ticket -isnot [pscustomobject] -or
      $ticket.PSObject.Properties.Name -contains 'protectedSignerPrivateKeyPem' -or
      $ticket.PSObject.Properties.Name -notcontains 'protectedSignerPublicKeySpkiBase64Url' -or
      $ticket.protectedSignerPublicKeySpkiBase64Url -isnot [string] -or
      [string]::IsNullOrWhiteSpace($ticket.protectedSignerPublicKeySpkiBase64Url)) {
    throw 'REFUSED: admission ticket must use the protected public signing key.'
  }
}
function Get-WorkerInstalledSettings {
  param($Paths, [byte[]]$Settings)
  if ($Settings.Length -lt 4 -or $Settings.Length -gt 65534 -or $Settings.Length % 2 -ne 0) { throw 'REFUSED: invalid enrollment settings.' }
  $entries = ([Text.UnicodeEncoding]::new($false,$false,$true)).GetString($Settings).Split([char]0)
  if ($entries.Count -ne 14 -or $entries[12] -cne '' -or $entries[13] -cne '') { throw 'REFUSED: invalid installed environment.' }
  $values = [Collections.Generic.Dictionary[string,string]]::new([StringComparer]::Ordinal)
  foreach ($entry in $entries[0..11]) {
    $parts = $entry.Split(@([char]'='),2)
    if ($parts.Count -ne 2 -or $values.ContainsKey($parts[0])) { throw 'REFUSED: invalid installed setting.' }
    $values.Add($parts[0],$parts[1])
  }
  $prefix = 'GOATCITADEL_CONNECTED_WORKER_'
  $port = 0
  if (-not [int]::TryParse($values[$prefix+'PORT'],[ref]$port)) { throw 'REFUSED: invalid installed port.' }
  $expected = Get-WorkerSettingsBytes $Paths $values[$prefix+'HOST'] $port $values[$prefix+'RUN_ID']
  if ((Get-WorkerBytesHash $expected) -cne (Get-WorkerBytesHash $Settings)) {
    $expected = Get-WorkerSettingsBytes $Paths $values[$prefix+'HOST'] $port $values[$prefix+'RUN_ID'] -CapacityLayout
    if ((Get-WorkerBytesHash $expected) -cne (Get-WorkerBytesHash $Settings)) { throw 'REFUSED: installed environment differs from the fixed service contract.' }
  }
  return ,$values
}
function Assert-WorkerCapacityEnrollmentReceipt {
  param([bool]$CapacityLayout, $Receipt, $CapacityRecord)
  $hasDigest = $Receipt.PSObject.Properties.Name -contains 'capacityCustodySha256'
  if (-not $CapacityLayout) {
    if ($hasDigest -or $null -ne $CapacityRecord) { throw 'REFUSED: capacity receipt requires the separate state layout.' }
    return
  }
  if (-not $hasDigest -or $Receipt.capacityCustodySha256 -cnotmatch '^[a-f0-9]{64}$' -or
      $null -eq $CapacityRecord -or $CapacityRecord.sizeBytes -ne 320 -or
      $CapacityRecord.sha256 -cne $Receipt.capacityCustodySha256) {
    throw 'REFUSED: capacity custody differs from the installation receipt.'
  }
}
function Get-WorkerEnrollmentStartInfo {
  param($Paths, [byte[]]$Settings, [string]$RunId)
  if ($RunId -cnotmatch '^[a-zA-Z0-9-]{1,80}$') { throw 'REFUSED: invalid enrollment run ID.' }
  $values = Get-WorkerInstalledSettings $Paths $Settings
  $prefix = 'GOATCITADEL_CONNECTED_WORKER_'
  $values[$prefix+'STATE_DIR'] = $Paths.Enrollment
  $values[$prefix+'REPORT_FILE'] = Join-Path $Paths.Enrollment 'report.json'
  $values[$prefix+'RUN_ID'] = $RunId
  $values[$prefix+'STOP_AFTER'] = 'admit'
  $values[$prefix+'RUN_MODE'] = 'once'
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $Paths.Image; $start.Arguments = '--foreground'; $start.WorkingDirectory = $Paths.Payload
  $start.UseShellExecute = $false; $start.CreateNoWindow = $true
  $start.RedirectStandardInput = $true; $start.RedirectStandardOutput = $true; $start.RedirectStandardError = $true
  $start.EnvironmentVariables.Clear()
  $start.EnvironmentVariables['SystemRoot'] = [Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
  foreach ($entry in $values.GetEnumerator()) { $start.EnvironmentVariables[$entry.Key] = $entry.Value }
  return $start
}

function Assert-WorkerEnrollmentPrivateSddl {
  param([string]$Sddl, [switch]$Directory)
  if ($Directory) {
    if ((ConvertTo-CanonicalFileSddl $Sddl) -cne (ConvertTo-CanonicalFileSddl $script:WorkerEnrollmentSddl)) {
      throw 'REFUSED: enrollment directory is not administrator-only.'
    }
    return
  }
  $descriptor = [Security.AccessControl.RawSecurityDescriptor]::new($Sddl)
  $operatorSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  if ($descriptor.Owner.Value -notin @('S-1-5-18','S-1-5-32-544',$operatorSid) -or $null -eq $descriptor.DiscretionaryAcl -or
      $descriptor.DiscretionaryAcl.Count -ne 2) {
    throw 'REFUSED: enrollment file owner or DACL differs.'
  }
  $seen=[Collections.Generic.HashSet[string]]::new([StringComparer]::Ordinal)
  foreach ($ace in $descriptor.DiscretionaryAcl) {
    if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed -or
        $ace.SecurityIdentifier.Value -notin @('S-1-5-18','S-1-5-32-544') -or $ace.AccessMask -ne 0x001f01ff -or
        -not $seen.Add($ace.SecurityIdentifier.Value)) {
      throw 'REFUSED: enrollment file grants non-administrator access.'
    }
  }
}

function Get-WorkerEnrollmentProof {
  param([byte[]]$ReportBytes, [byte[]]$CredentialBytes, [string]$RunId)
  $report = ConvertFrom-WorkerJson $ReportBytes
  $credential = ConvertFrom-WorkerJson $CredentialBytes
  $digest = Get-WorkerBytesHash $CredentialBytes
  if ($report.runId -cne $RunId -or $report.outcome -cne 'stopped' -or
      @($report.stagesCompleted).Count -ne 1 -or $report.stagesCompleted[0] -cne 'admit' -or
      $report.admitted -cnotin @('bootstrap_exchange','retained_credential') -or
      $report.enrollment.schemaVersion -cne 'goatcitadel.remote-worker.enrollment.v1' -or
      $report.enrollment.credentialSha256 -cne $digest -or
      $credential.PSObject.Properties.Name -notcontains 'protectedKey' -or
      $credential.credentialId -cne $report.credentialId -or
      $credential.credentialGeneration -ne $report.credentialGeneration -or
      $credential.workerGeneration -ne $report.workerGeneration) {
    throw 'REFUSED: successful protected enrollment does not bind the retained credential.'
  }
  foreach ($field in @('signingPrivateKeyPem','bootstrapSecret','bootstrap_secret','bootstrapToken','oneTimeSecret')) {
    if ($credential.PSObject.Properties.Name -contains $field) { throw 'REFUSED: forbidden material in enrollment credential.' }
  }
  # The pinned runtime validated credential authority and public native-key
  # bindings. This transfer verifies its exact bytes, not a second admission.
  return [pscustomobject]@{sha256=$digest;sizeBytes=$CredentialBytes.Length;credentialId=$report.credentialId;
    credentialGeneration=$report.credentialGeneration;workerGeneration=$report.workerGeneration}
}

function Publish-WorkerEnrollmentCredential {
  param([string]$Source, [string]$Destination, $Expected, [string]$Sddl)
  $native = [GoatCitadel.RemoteWorker.Install.NativeFiles]
  $inputFile = $native::OpenRead($Source,2097152)
  $outputFile = $null; $published = $false
  $hash = [Security.Cryptography.SHA256]::Create()
  try {
    $actual = [BitConverter]::ToString($hash.ComputeHash($inputFile)).Replace('-','').ToLowerInvariant()
    if ($inputFile.Length -ne $Expected.sizeBytes -or $actual -cne $Expected.sha256) { throw 'REFUSED: enrollment credential changed before transfer.' }
    if (Test-Path -LiteralPath $Destination) {
      $retained = Get-WorkerFileRecord $Destination
      if ($retained.sha256 -cne $Expected.sha256 -or $retained.sizeBytes -ne $Expected.sizeBytes -or
          (ConvertTo-CanonicalFileSddl ([GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::GetFileSddl($Destination))) -cne
          (ConvertTo-CanonicalFileSddl $Sddl)) { throw 'REFUSED: existing worker credential differs; it was preserved.' }
      return 'retained'
    }
    $temporary = Join-Path ([IO.Path]::GetDirectoryName($Destination)) ('.enrollment-' + [guid]::NewGuid().ToString('N') + '.tmp')
    $created = $false
    $outputFile = $native::CreateProtectedPublicationFile($temporary,$Sddl,[ref]$created)
    $inputFile.Position = 0; $inputFile.CopyTo($outputFile,65536); $outputFile.Flush($true)
    if ($outputFile.Length -ne $Expected.sizeBytes) { throw 'REFUSED: incomplete credential transfer.' }
    $native::PublishOpenedFile($outputFile,$temporary,$Destination)
    $published = $true
    return 'published'
  } finally {
    try {
      if ($outputFile) {
        try { if (-not $published) { $native::DeleteOpenedFile($outputFile) } } finally { $outputFile.Dispose() }
      }
    } finally { $hash.Dispose(); $inputFile.Dispose() }
  }
}

function Invoke-WorkerEnrollmentHost {
  param([Diagnostics.ProcessStartInfo]$Start)
  $child = $null
  try {
    $child = [Diagnostics.Process]::Start($Start)
    $stdout = $child.StandardOutput.ReadToEndAsync(); $stderr = $child.StandardError.ReadToEndAsync()
    if (-not $child.WaitForExit(120000)) { throw 'REFUSED: enrollment timed out; private state is retained.' }
    if ($child.ExitCode -ne 0 -or $stdout.Result.Length -gt 4096 -or $stderr.Result.Length -ne 0) {
      throw 'REFUSED: enrollment host failed; inspect the private report and reconcile retained authority.'
    }
    $summary = ConvertFrom-WorkerJson ([Text.Encoding]::UTF8.GetBytes($stdout.Result))
    if ($summary.error -ne 0 -or $summary.childExitCode -ne 0 -or $summary.stopRequested -ne $false -or
        $summary.forced -ne $false -or $summary.jobEmpty -ne $true) { throw 'REFUSED: enrollment host did not finish cleanly.' }
  } finally {
    if ($child) {
      try {
        if (-not $child.HasExited) {
          $child.StandardInput.Close()
          if (-not $child.WaitForExit(20000)) {
            $child.Kill()
            if (-not $child.WaitForExit(5000)) { throw 'Enrollment host termination remains unresolved.' }
          }
        }
      } finally { $child.Dispose() }
    }
  }
}
