#Requires -Version 5.1
# Read public custody metadata through the installed signer's INSPECT operation.
# No key creation, service control, credential export or disk provisioning.
$ErrorActionPreference='Stop'
Set-StrictMode -Version Latest
if ([Environment]::MachineName -cne 'GOATBOX' -or $env:COMPUTERNAME -cne 'GOATBOX') { throw 'GOATBOX only.' }
$package='C:\worker-candidates\broker-inspection-fixed\payload'
$manifestPath=Join-Path $package 'worker-package.json'
if ((Get-FileHash -LiteralPath $manifestPath).Hash -ne 'beafa81d55ade7d82274c86a0ab0c1ce2dc8a88685adb400dd2fdde04018eab2') { throw 'Package manifest mismatch.' }
$manifest=Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
foreach ($file in $manifest.files) {
  $path=[IO.Path]::GetFullPath((Join-Path $package $file.path))
  if (-not $path.StartsWith($package+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Invalid inventory path.' }
  if ((Get-FileHash -LiteralPath $path).Hash -ne $file.sha256) { throw ('Package file mismatch: '+$file.path) }
}
$client='C:\ProgramData\GoatCitadel\RemoteWorkerProvisioner\bin\GoatCitadelRemoteWorkerProvisionerClient.exe'
$lease=[IO.File]::Open($client,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
  $sha=[Security.Cryptography.SHA256]::Create()
  try { $hash=([BitConverter]::ToString($sha.ComputeHash($lease))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
  if ($hash -cne '6f7309533bf1034c537e9e4c50a19c31d07354490092e8b97d9a29ba3af05948') { throw 'Installed client hash mismatch.' }
  $code=@'
import { inspectWindowsProtectedService } from 'file:///C:/worker-candidates/broker-inspection-fixed/payload/app/worker/node_modules/@goatcitadel/remote-worker-provisioner/dist/windows-service-client.js';
const state = await inspectWindowsProtectedService('C:\\ProgramData\\GoatCitadel\\RemoteWorkerProvisioner\\bin\\GoatCitadelRemoteWorkerProvisionerClient.exe');
const names = ['custodyPosture', 'activeGeneration', 'highestBurnedGeneration', 'committedGenerationCount', 'burnedGenerationCount', 'remainingOperationCapacity', 'remainingGenerationCapacity', 'stateSha256', 'activeKeysetReceiptSha256', 'runtimeManifestSpkiSha256', 'admissionEvidenceSpkiSha256', 'runtimeManifestSpki', 'admissionEvidenceSpki'];
const report = { schema: 'goatcitadel.goatbox.public-enrollment-inspection/1' };
for (const name of names) {
  const value = state[name];
  report[name] = value instanceof Uint8Array ? Buffer.from(value).toString('hex') : typeof value === 'bigint' ? value.toString() : value;
}
console.log(JSON.stringify(report, null, 2));
'@
  & (Join-Path $package 'app\runtime\node.exe') --input-type=module -e $code
  if ($LASTEXITCODE -ne 0) { throw 'Public inspection failed. Preserve the output; do not restart or reinstall.' }
} finally { $lease.Dispose() }
