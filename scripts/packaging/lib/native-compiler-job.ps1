param([Parameter(Mandatory=$true)][string]$RequestPath)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
$caller = $null
$resultPath = $null
$compilerEntered = $false
try {
    $requestFile = Get-Item -LiteralPath $RequestPath
    if ($requestFile.Length -gt 1048576 -or ($requestFile.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Invalid compiler request' }
    $request = [IO.File]::ReadAllText($RequestPath) | ConvertFrom-Json
    $candidateResult = [string]$request.resultPath
    if ([IO.Path]::GetDirectoryName($candidateResult) -ne [IO.Path]::GetDirectoryName($RequestPath) -or
        [IO.Path]::GetFileName($candidateResult) -notmatch '^native-compiler-result-[0-9]+-[a-f0-9]{16}[.]json$') { throw 'Invalid result ownership' }
    if ([IO.File]::Exists($candidateResult)) { throw 'Result must be new' }
    $resultPath = $candidateResult
    # Retain this exact OS process HANDLE before Add-Type. Creation time and image
    # are pinned by a prior caller-side query, never accepted from a reused PID.
    $caller = [Diagnostics.Process]::GetProcessById([int]$request.callerPid)
    $callerHandle = $caller.Handle
    if ($caller.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne [string]$request.callerCreation -or
        $caller.MainModule.FileName -ne [string]$request.callerImage) { throw 'Caller identity mismatch' }
    $source = Join-Path $PSScriptRoot 'NativeCompilerJob.cs'
    $sourceItem = Get-Item -LiteralPath $source
    if ($sourceItem.Length -gt 131072 -or ($sourceItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        (Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash.ToLowerInvariant() -ne [string]$request.sourceSha256) { throw 'Compiler owner source changed' }
    # Windows PowerShell can invoke the system C# compiler for Add-Type. That
    # bootstrap is outside the compiler-private Job; no requested compiler may
    # start before Add-Type and revalidation of the retained caller HANDLE.
    Add-Type -TypeDefinition ([IO.File]::ReadAllText($source)) -Language CSharp -ErrorAction Stop -WarningAction SilentlyContinue
    $keys = New-Object 'System.Collections.Generic.List[string]'
    $values = New-Object 'System.Collections.Generic.List[string]'
    foreach ($property in $request.environment.PSObject.Properties) {
        $keys.Add([string]$property.Name)
        $values.Add([string]$property.Value)
    }
    $compilerEntered = $true
    $owned = [NativeCompilerJob]::Run([string]$request.command, [string[]]$request.arguments,
        [string]$request.cwd, $keys.ToArray(), $values.ToArray(), $callerHandle, [uint32]$request.callerPid,
        [long]$request.callerCreation, [string]$request.callerImage, [long]$request.deadlineUnixMs, [int]$request.maxBuffer)
    $record = @{
        ExitCode = $owned.ExitCode; Deadline = $owned.Deadline; ParentExited = $owned.ParentExited
        JobEmpty = $owned.JobEmpty; RootExited = $owned.RootExited; AtomicMembership = $owned.AtomicMembership; CallerVerified = $owned.CallerVerified
        DescendantsRetired = $owned.DescendantsRetired; ErrorCode = $owned.ErrorCode; NativeError = $owned.NativeError
        StdoutBase64 = [Convert]::ToBase64String($owned.Stdout); StderrBase64 = [Convert]::ToBase64String($owned.Stderr)
        BootstrapComplete = $true; BootstrapInsideCompilerJob = $false
    }
} catch {
    # Never print request, argv, environment, source or raw exception text.
    $record = @{ ErrorCode = 'ECOMPILERBOOTSTRAP'; JobEmpty = !$compilerEntered; RootExited = $false
        Deadline = $false; ParentExited = ($caller -and $caller.HasExited); AtomicMembership = $false; CallerVerified = $false
        DescendantsRetired = 0; NativeError = 0; ExitCode = $null; StdoutBase64 = ''; StderrBase64 = ''
        BootstrapComplete = $false; BootstrapInsideCompilerJob = $false }
} finally {
    if ($caller) { $caller.Dispose() }
}
if (!$resultPath) { exit 1 }
$utf8 = New-Object -TypeName System.Text.UTF8Encoding -ArgumentList $false
$encoded = $utf8.GetBytes(($record | ConvertTo-Json -Compress -Depth 4))
$pending = $resultPath + '.pending'
$stream = [IO.File]::Open($pending, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
try { $stream.Write($encoded, 0, $encoded.Length) } finally { $stream.Dispose() }
[IO.File]::Move($pending, $resultPath)
if ($record.ErrorCode) { exit 1 }
exit 0
