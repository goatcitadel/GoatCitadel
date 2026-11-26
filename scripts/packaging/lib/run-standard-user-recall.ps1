function Invoke-StandardUserRecall($Node, $App, $Scratch, $Evidence, $PackagingScripts) {
  # The elevated hosted runner cannot supply browser switches to WebView2.
  # Keep the installed executable unchanged and launch it as a standard user.
  $name = 'GoatRecall' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
  $password = ConvertTo-SecureString ([Guid]::NewGuid().ToString('N') + 'a!9A') -AsPlainText -Force
  $fixture = Join-Path $Scratch 'standard-user-recall'
  $fixtureEvidence = Join-Path $fixture 'evidence'
  $fixtureRuntime = Join-Path $fixture 'runtime'
  $localUser = $null
  $process = $null
  try {
    $localUser = New-LocalUser -Name $name -Password $password -AccountNeverExpires
    Add-LocalGroupMember -SID 'S-1-5-32-545' -Member $localUser
    $permission = '*' + $localUser.SID.Value
    New-Item -ItemType Directory -Path $fixtureEvidence, $fixtureRuntime -ErrorAction Stop | Out-Null
    $fixtureScripts = Join-Path $fixture 'scripts/packaging'
    $scenarioScripts = Join-Path $fixture 'scripts/verification/lib/scenarios'
    New-Item -ItemType Directory -Force -Path (Join-Path $fixtureScripts 'lib'), $scenarioScripts | Out-Null
    Copy-Item -LiteralPath (Join-Path $PackagingScripts 'windows-installed-live.mjs') -Destination $fixtureScripts
    Copy-Item -LiteralPath (Join-Path $PackagingScripts 'lib/windows-installed-recall.mjs') -Destination (Join-Path $fixtureScripts 'lib')
    Copy-Item -LiteralPath (Join-Path $PackagingScripts '../verification/lib/scenarios/deterministic-llm-stub.mjs') -Destination $scenarioScripts
    & icacls.exe $Scratch /grant "${permission}:(RX)" | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Could not grant the recall user access to the smoke directory.' }
    foreach ($directory in @((Split-Path -Parent $App), $fixture)) {
      & icacls.exe $directory /grant "${permission}:(OI)(CI)(RX)" | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'Could not grant read access to the installed app and recall scripts.' }
    }
    foreach ($directory in @($fixtureEvidence, $fixtureRuntime)) {
      & icacls.exe $directory /grant "${permission}:(OI)(CI)(M)" | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'Could not grant write access to the disposable recall profile and evidence.' }
    }

    $credential = [PSCredential]::new("$env:COMPUTERNAME\$name", $password)
    $argsForNode = @($Node, (Join-Path $fixtureScripts 'windows-installed-live.mjs'), $App, $fixtureRuntime, $fixtureEvidence, '--recall-only') |
      ForEach-Object { "'" + $_.Replace("'", "''") + "'" }
    $logPath = Join-Path $fixtureEvidence 'standard-user-recall.log'
    $quotedLog = "'" + $logPath.Replace("'", "''") + "'"
    $command = @"
`$ErrorActionPreference = 'Stop'
`$env:RUNNER_ENVIRONMENT = 'github-hosted'
try {
  `$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
  `$principal = [Security.Principal.WindowsPrincipal]::new(`$identity)
  if (`$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw 'Recall requires a standard Windows user.'
  }
  & $($argsForNode -join ' ') > $quotedLog
  exit `$LASTEXITCODE
} catch {
  `$_.Exception.Message | Out-File -LiteralPath $quotedLog -Append
  exit 1
}
"@
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
    $process = Start-Process -FilePath $powershell -Credential $credential -LoadUserProfile `
      -WorkingDirectory $fixtureRuntime -WindowStyle Hidden -PassThru `
      -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encoded)
    if (-not $process.WaitForExit(600000)) {
      throw 'The standard-user installed recall verification timed out.'
    }
    if (Test-Path -LiteralPath $logPath) { Get-Content -LiteralPath $logPath | Write-Host }
    if ($process.ExitCode -ne 0) { throw "Installed recall verification exited $($process.ExitCode)." }
  } finally {
    if ($process) {
      if (-not $process.HasExited) { & taskkill.exe /PID $process.Id /T /F | Out-Null }
      $process.Dispose()
    }
    if ($localUser) { Remove-LocalUser -SID $localUser.SID }
    if (Test-Path -LiteralPath $fixtureEvidence) {
      Get-ChildItem -LiteralPath $fixtureEvidence -File | Copy-Item -Destination $Evidence
    }
  }
}
