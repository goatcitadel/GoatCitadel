import fs from 'node:fs';
import path from 'node:path';
import { createHash, X509Certificate } from 'node:crypto';
import { decodeWindowsTlsKeyIdentifier } from '../../apps/remote-worker-provisioner/dist/windows-tls-key-identifier.js';

const root=path.resolve(import.meta.dirname,'../..');
const output=path.join(root,'.tmp/goatbox-worker-install-v1');
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const controller=path.join(root,'runtime/remote-worker-goatbox');
const certBytes=fs.readFileSync(path.join(controller,'client-cert.pem'));
const caBytes=fs.readFileSync(path.join(controller,'ca.pem'));
const referenceBytes=fs.readFileSync(path.join(root,'.tmp/goatbox-generation-1-public-inputs/protected-key.json'));
const cert=new X509Certificate(certBytes), ca=new X509Certificate(caBytes);
const reference=decodeWindowsTlsKeyIdentifier(referenceBytes.toString('utf8'));
if (!cert.verify(ca.publicKey) || Date.parse(cert.validTo)<=Date.now() ||
    cert.publicKey.export({format:'der',type:'spki'}).toString('base64url')!==reference.workerPublicKeySpkiBase64Url ||
    reference.keysetGeneration!==1 || reference.stateSha256!=='ec89cf132f099e4ea95136e73d10fc54761403d16a8f0c65c5dee19cb80d5cde') {
  throw Error('Certificate or protected-key reference does not match the live GOATBOX keyset.');
}
fs.mkdirSync(output); // Exclusive: never overwrite an earlier handoff.
const files=[];
const write=(name,bytes)=>{
  if (/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(bytes.toString('utf8'))) throw Error('Private key in public handoff.');
  fs.writeFileSync(path.join(output,name),bytes,{flag:'wx'});
  files.push({path:name,sha256:sha(bytes),sizeBytes:bytes.length});
};
for (const name of ['install-goatbox-worker.ps1','install-worker-service.ps1','worker-install-common.ps1',
  'worker-install-native.cs','worker-controller-key.cs','broker-coordinator-common.ps1']) {
  write(name,fs.readFileSync(path.join(import.meta.dirname,name)));
}
write('client-cert.pem',certBytes);write('ca.pem',caBytes);write('protected-key.json',referenceBytes);
const manifestBytes=Buffer.from(JSON.stringify({schemaVersion:'goatcitadel.goatbox-install-handoff.v1',files},null,2)+'\n');
fs.writeFileSync(path.join(output,'handoff-files.json'),manifestBytes,{flag:'wx'});
const helperHash=files.find(file=>file.path==='install-goatbox-worker.ps1').sha256;
const launcher=Buffer.from(`[CmdletBinding()]\nparam([switch]$Apply)\n$ErrorActionPreference='Stop'\nif ([Environment]::MachineName -cne 'GOATBOX') { throw 'GOATBOX only.' }\n$helper=Join-Path $PSScriptRoot 'install-goatbox-worker.ps1'\n$lease=[IO.File]::Open($helper,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)\ntry {\n  $sha=[Security.Cryptography.SHA256]::Create()\n  try { $actual=[BitConverter]::ToString($sha.ComputeHash($lease)).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }\n  if ($actual -cne '${helperHash}') { throw 'Launcher helper hash mismatch.' }\n  & $helper -HandoffManifestSha256 '${sha(manifestBytes)}' -Apply:$Apply\n} finally { $lease.Dispose() }\n`.replaceAll('\n','\r\n'));
fs.writeFileSync(path.join(output,'Run-GOATBOX-Worker-Install.ps1'),launcher,{flag:'wx'});
console.log(JSON.stringify({output,launcherSha256:sha(launcher),manifestSha256:sha(manifestBytes),files:files.length,privateKeyIncluded:false},null,2));
