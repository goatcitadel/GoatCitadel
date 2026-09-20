#Requires -Version 5.1
# Read-only installation survey: no service, key, disk, or installed-file mutations.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ([Environment]::MachineName -cne 'GOATBOX' -or $env:COMPUTERNAME -cne 'GOATBOX') { throw 'GOATBOX only.' }
$principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Administrator PowerShell required.' }
$leases=[Collections.Generic.List[IDisposable]]::new()
function Invoke-SurveyProcess([Diagnostics.ProcessStartInfo]$Start) {
    $Start.RedirectStandardOutput=$true
    $Start.RedirectStandardError=$true
    $child=[Diagnostics.Process]::Start($Start)
    try {
        # Drain both pipes concurrently so either output stream can report failure.
        $stdout=$child.StandardOutput.ReadToEndAsync()
        $stderr=$child.StandardError.ReadToEndAsync()
        $child.WaitForExit()
        $outText=$stdout.GetAwaiter().GetResult()
        $errText=$stderr.GetAwaiter().GetResult()
        return [pscustomobject]@{
            exitCode=$child.ExitCode
            stdout=$outText.Substring(0,[Math]::Min(65536,$outText.Length))
            stderr=$errText.Substring(0,[Math]::Min(65536,$errText.Length))
            outputTruncated=($outText.Length -gt 65536 -or $errText.Length -gt 65536)
        }
    } finally { $child.Dispose() }
}
function Hold-SurveyFile([string]$Path,[string]$Expected) {
    $stream=[IO.File]::Open($Path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $leases.Add($stream)
    $hash=[Security.Cryptography.SHA256]::Create()
    try { $actual=[BitConverter]::ToString($hash.ComputeHash($stream)).Replace('-','').ToLowerInvariant() } finally { $hash.Dispose() }
    if ($actual -cne $Expected) { throw 'Survey input hash differs. Stop.' }
}
try {
    foreach ($name in @('GoatCitadelRemoteWorker','GoatCitadelRemoteWorkerCellController')) {
        if ((Get-Service -Name $name).Status -ne 'Stopped') { throw 'Worker and controller must remain stopped.' }
    }
    $payload='C:\ProgramData\GoatCitadel\RemoteWorker\payload'
    $node=Join-Path $payload 'app\runtime\node.exe'
    $bundle=Join-Path $PSScriptRoot 'survey.mjs'
    Hold-SurveyFile (Join-Path $payload 'worker-package.json') 'd80b8d70375b40962947689e2cfc4787ae28aa9dc64a8ebc9e0fed3c5559256b'
    Hold-SurveyFile $node '3602f2bb1a10f2cbab4c36886218a33c1ab3db87290e73b033c46c77147d0237'
    Hold-SurveyFile $bundle '__SURVEY_BUNDLE_SHA256__'
    $output='C:\worker-evidence\installed-survey-'+(Get-Date -Format 'yyyyMMdd-HHmmss-fff')
    if (Test-Path -LiteralPath $output) { throw 'Evidence directory already exists.' }
    New-Item -ItemType Directory -Path $output | Out-Null
    $start=[Diagnostics.ProcessStartInfo]::new()
    $start.FileName=$node
    $start.Arguments='"'+$bundle+'" "'+(Join-Path $output 'installed-survey.json')+'"'
    $start.UseShellExecute=$false
    $start.CreateNoWindow=$true
    $start.EnvironmentVariables.Clear()
    $start.EnvironmentVariables['SystemRoot']=[Environment]::GetFolderPath([Environment+SpecialFolder]::Windows)
    'Surveying installed files; allow up to two minutes. No installation changes...'
    $result=Invoke-SurveyProcess $start
    $report=Join-Path $output 'survey-process.json'
    [IO.File]::WriteAllText($report,($result | ConvertTo-Json -Depth 3),[Text.UTF8Encoding]::new($false))
    $result | ConvertTo-Json -Depth 3
    'Process evidence: '+$report
    if ($result.exitCode -ne 0 -or $result.outputTruncated) { throw 'Survey failed. Preserve the diagnostic above and stop.' }
} finally { foreach ($lease in $leases) { $lease.Dispose() } }
