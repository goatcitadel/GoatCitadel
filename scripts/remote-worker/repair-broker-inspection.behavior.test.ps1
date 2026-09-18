#Requires -Version 5.1
param([ValidateSet('preflight','apply','rollback','running')][string]$Case='preflight')
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
# Execute the production orchestration against real NTFS fixture images and
# real retained directory handles. Only host/elevation, fixed roots, old hash
# pins and SCM queries/privilege enabling are substituted in this test copy.
$root=Join-Path ([IO.Path]::GetTempPath()) ('goat-broker-repair-test-'+[guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path $root
try {
  $package=Join-Path $root 'package'
  $bin=Join-Path $root 'ProgramData\GoatCitadel\RemoteWorkerProvisioner\bin'
  $state=Join-Path ([IO.Path]::GetDirectoryName($bin)) 'state-v1'
  foreach ($dir in @($bin,$state,(Join-Path $package 'app\provisioner'),(Join-Path $root 'worker-evidence'))) { $null=New-Item -ItemType Directory -Path $dir -Force }
  foreach ($leaf in @('journal','keysets','controls','quarantine')) { $null=New-Item -ItemType Directory -Path (Join-Path $state $leaf) }
  $sentinel=Join-Path $state 'journal\retain.txt'
  [IO.File]::WriteAllText($sentinel,'protected fixture must survive')
  $names=@('GoatCitadelRemoteWorkerProvisioner.exe','GoatCitadelRemoteWorkerProvisionerAvailability.exe','GoatCitadelRemoteWorkerProvisionerClient.exe')
  $files=@(); $original=@{}
  foreach ($name in $names) {
    [IO.File]::WriteAllText((Join-Path $bin $name),('original '+$name))
    $original[$name]=(Get-FileHash -LiteralPath (Join-Path $bin $name)).Hash.ToLowerInvariant()
    $next=Join-Path $package ('app\provisioner\'+$name)
    [IO.File]::WriteAllText($next,($(if ($name -like '*Client.exe') { 'original ' } else { 'replacement ' })+$name))
    $files+=@{ path=('app/provisioner/'+$name); sha256=(Get-FileHash -LiteralPath $next).Hash.ToLowerInvariant() }
  }
  $manifest=Join-Path $package 'worker-package.json'
  [IO.File]::WriteAllText($manifest,(@{files=$files}|ConvertTo-Json -Depth 4))
  $hash=(Get-FileHash -LiteralPath $manifest).Hash
  $source=[IO.File]::ReadAllText((Join-Path $PSScriptRoot 'repair-broker-inspection.ps1'))
  $source=$source.Replace("if ([Environment]::MachineName -cne 'GOATBOX' -or `$env:COMPUTERNAME -cne 'GOATBOX') { throw 'Run this repair on GOATBOX only.' }",'')
  $source=$source.Replace("if (-not (Test-BrokerCoordinatorElevation)) { throw 'Use Administrator PowerShell.' }",'')
  $source=$source.Replace('$PSScriptRoot',("'"+$PSScriptRoot+"'"))
  $source=$source.Replace('C:\',($root+'\'))
  $pins=@('b3b056ef523b57bce4e6f3aec20ceefcd69e524961bc0d1167c1184fa6235381','48402f8212e1e0a57d1d36ff546ab781b1ed0731a89470d6628e3c5fec0196b0','6f7309533bf1034c537e9e4c50a19c31d07354490092e8b97d9a29ba3af05948')
  for ($i=0;$i -lt 3;$i++) { $source=$source.Replace($pins[$i],$original[$names[$i]]) }
  $shim=@'
Add-Type -TypeDefinition @"
using System;
public class FixtureService : IDisposable {
 public static bool Running;
 public FixtureService(string name) { }
 public void AssertStopped() { if (Running) throw new Exception("fixture service is running"); }
 public void Dispose() { }
}
public static class FixtureNative {
 public static string Root, BrokerSddl, SignerSddl;
 public static void EnablePrivilege(string name) { }
 public static string GetServiceConfigLine(string name) { return "16|3|1|\""+Root+"\\ProgramData\\GoatCitadel\\RemoteWorkerProvisioner\\bin\\"+name+".exe\"|LocalSystem||1"; }
 public static int GetServiceSidType(string name) { return 1; }
 public static string GetServiceRequiredPrivileges(string name) { return "SeChangeNotifyPrivilege"; }
 public static string GetServiceSddl(string name) { return CanonicalizeSddl(name.EndsWith("Availability") ? BrokerSddl : SignerSddl); }
 public static string CanonicalizeSddl(string value) { return GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe.CanonicalizeSddl(value); }
 public static string GetFileSddl(string value) { return GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe.GetFileSddl(value); }
}
"@ -ReferencedAssemblies ([GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe].Assembly.Location)
[FixtureNative]::Root='ROOT_FIXTURE'
[FixtureNative]::BrokerSddl=$script:ServiceObjectSddl
[FixtureNative]::SignerSddl=$script:SignerServiceObjectSddl
[FixtureService]::Running=RUNNING_FIXTURE
$native=[FixtureNative]
$fixtureRoot='ROOT_FIXTURE'
$fixtureBin=Join-Path $fixtureRoot 'ProgramData\GoatCitadel\RemoteWorkerProvisioner\bin'
$script:SignerImageSddl=(Get-Acl -LiteralPath (Join-Path $fixtureBin 'GoatCitadelRemoteWorkerProvisioner.exe')).Sddl
$script:BrokerImageSddl=$script:SignerImageSddl
$script:ProtectedDirectorySddl=(Get-Acl -LiteralPath $fixtureBin).Sddl
$script:ProtectedStateSddl=(Get-Acl -LiteralPath (Join-Path ([IO.Path]::GetDirectoryName($fixtureBin)) 'state-v1')).Sddl
function Get-BrokerCoordinatorDirectoryLease { param($Path,[switch]$GoatCitadelLevel); return [GoatCitadel.RemoteWorker.BrokerCoordinator.StateDirectoryLease]::OpenParent($Path) }
function Get-BrokerCoordinatorPaths { param($SystemDrive); return [pscustomobject]@{
 GoatCitadelDirectory=(Join-Path $fixtureRoot 'ProgramData\GoatCitadel'); ProvisionerDirectory=[IO.Path]::GetDirectoryName($fixtureBin); BinDirectory=$fixtureBin;
 BrokerQuotedBinaryPath=('"'+(Join-Path $fixtureBin 'GoatCitadelRemoteWorkerProvisionerAvailability.exe')+'"');
 SignerQuotedBinaryPath=('"'+(Join-Path $fixtureBin 'GoatCitadelRemoteWorkerProvisioner.exe')+'"')
} }
'@
  # Add-Type's in-memory assemblies cannot be referenced by path on PowerShell 7.
  # Compile the SCM shim without references and delegate only file methods via
  # the existing PowerShell-native type at the call sites below.
  $shim=$shim.Replace('return GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe.CanonicalizeSddl(value);','return value;')
  $shim=$shim.Replace('return GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe.GetFileSddl(value);','return value;')
  $shim=$shim.Replace(' -ReferencedAssemblies ([GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe].Assembly.Location)','')
  $shim=$shim.Replace('ROOT_FIXTURE',$root).Replace('RUNNING_FIXTURE',($(if ($Case -eq 'running') { '$true' } else { '$false' })))
  $source=$source.Replace("`$paths = Get-BrokerCoordinatorPaths -SystemDrive 'C:'",($shim+"`n`$paths = Get-BrokerCoordinatorPaths -SystemDrive '"+$root+"'"))
  $source=$source.Replace('New-Object GoatCitadel.RemoteWorker.BrokerCoordinator.ExistingServiceLease($name)','New-Object FixtureService($name)')
  $source=$source.Replace('$native::GetFileSddl($directory)','[GoatCitadel.RemoteWorker.BrokerCoordinator.NativeRecipe]::GetFileSddl($directory)')
  if ($Case -eq 'rollback') { $source=$source.Replace('$image.lease.Replace($image.bytes, $image.nextHash)',"if (`$image.name -like '*Availability.exe') { throw 'injected second-image failure' }; `$image.lease.Replace(`$image.bytes, `$image.nextHash)") }
  $copy=Join-Path $root 'repair-test-copy.ps1'
  [IO.File]::WriteAllText($copy,$source)
  $output=Join-Path $root 'worker-evidence\broker-inspection-test'
  $command=@('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',$copy,'-PackageRoot',$package,'-ManifestSha256',$hash,'-OutputRoot',$output)
  if ($Case -ne 'preflight') { $command+='-Apply' }
  $engine=(Get-Process -Id $PID).Path
  $text=& $engine @command 2>&1
  $code=$LASTEXITCODE
  $report=Get-Content -Raw -LiteralPath (Join-Path $output 'broker-inspection-update-evidence.json') | ConvertFrom-Json
  $success=$Case -in @('preflight','apply')
  if (($success -and $code -ne 0) -or (-not $success -and $code -eq 0)) { throw ($text|Out-String) }
  if (@($report.rollbackFailures).Count -ne 0) { throw 'Rollback failed.' }
  foreach ($name in $names) {
    $expected=$original[$name]
    if ($Case -eq 'apply' -and $name -notlike '*Client.exe') { $expected=(Get-FileHash -LiteralPath (Join-Path $package ('app\provisioner\'+$name))).Hash }
    if ((Get-FileHash -LiteralPath (Join-Path $bin $name)).Hash -ne $expected) { throw "Incorrect final bytes: $name" }
  }
  if ([IO.File]::ReadAllText($sentinel) -cne 'protected fixture must survive') { throw 'State sentinel changed.' }
  if ($success -and @($report.protectedDirectories).Count -ne 5) { throw 'State handles were not all verified.' }
  if ($Case -eq 'rollback' -and ($report.refusals -join '') -notmatch 'injected second-image failure') { throw ($text|Out-String) }
  if ($Case -eq 'running' -and ($report.refusals -join '') -notmatch 'fixture service is running') { throw ($text|Out-String) }
  $display=$text | Out-String
  $expectedMode=if ($Case -eq 'preflight') { 'preflight' } else { 'apply' }
  $expectedVerdict=if ($success) { 'passed' } else { 'failed' }
  if ($display -notmatch ('"mode"\s*:\s*"'+$expectedMode+'"') -or
      $display -notmatch ('"verdict"\s*:\s*"'+$expectedVerdict+'"')) { throw ('Console summary does not match saved receipt: '+$display) }
  [pscustomobject]@{passed=$true;case=$Case} | ConvertTo-Json -Compress
} finally {
  $resolved=[IO.Path]::GetFullPath($root)
  $temp=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
  if (-not $resolved.StartsWith($temp,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^goat-broker-repair-test-[a-f0-9]{32}$') { throw 'Unsafe test cleanup path.' }
  Remove-Item -LiteralPath $resolved -Recurse -Force
}
