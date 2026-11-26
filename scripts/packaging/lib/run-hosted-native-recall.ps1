function Invoke-HostedNativeRecall($Node, $App, $Scratch, $Evidence, $Desktop) {
  if ($env:GITHUB_ACTIONS -ne 'true' -or $env:RUNNER_ENVIRONMENT -ne 'github-hosted') {
    throw 'The native recall fixture requires a disposable GitHub-hosted runner.'
  }
  $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    $debugPort = $listener.LocalEndpoint.Port
  } finally {
    $listener.Stop()
  }
  # Elevated WebView2 ignores per-user overrides. Use an executable-specific
  # machine policy only while the isolated runner exercises the installed host.
  $browserArgumentsPolicy = 'HKLM:\SOFTWARE\Policies\Microsoft\Edge\WebView2\AdditionalBrowserArguments'
  $desktopName = [System.IO.Path]::GetFileName($Desktop)
  if (-not (Test-Path -LiteralPath $browserArgumentsPolicy)) {
    New-Item -Path $browserArgumentsPolicy -Force | Out-Null
  }
  if ((Get-Item -LiteralPath $browserArgumentsPolicy).GetValueNames() -contains $desktopName) {
    throw 'The hosted runner already has a GoatCitadel WebView2 browser arguments policy.'
  }
  New-ItemProperty -LiteralPath $browserArgumentsPolicy -Name $desktopName -PropertyType String `
    -Value "--remote-debugging-address=127.0.0.1 --remote-debugging-port=$debugPort" | Out-Null
  try {
    & $Node (Join-Path $PSScriptRoot '../windows-installed-live.mjs') $App $Scratch $Evidence '--recall-only' $debugPort
    if ($LASTEXITCODE -ne 0) { throw 'Installed recall verification failed. See the retained recall evidence.' }
  } finally {
    Remove-ItemProperty -LiteralPath $browserArgumentsPolicy -Name $desktopName
  }
}
