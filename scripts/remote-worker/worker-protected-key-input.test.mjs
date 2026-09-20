import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodeWindowsTlsKeyIdentifier } from '../../apps/remote-worker-provisioner/dist/windows-tls-key-identifier.js';

for (const engine of ['powershell.exe', 'pwsh.exe']) test(`${engine}: installer accepts runtime identifier and refuses JSON and corrupt references`, t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'goat-key-input-'));
  t.after(()=>{
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir())+path.sep+'goat-key-input-'));
    fs.rmSync(root,{recursive:true,force:true});
  });
  const runtime=path.join(root,'app/runtime');
  const decoder=path.join(root,'app/worker/node_modules/@goatcitadel/remote-worker-provisioner/dist');
  fs.mkdirSync(runtime,{recursive:true});fs.mkdirSync(decoder,{recursive:true});
  fs.copyFileSync(process.execPath,path.join(runtime,'node.exe'));
  fs.copyFileSync('apps/remote-worker-provisioner/dist/windows-tls-key-identifier.js',path.join(decoder,'windows-tls-key-identifier.js'));
  fs.writeFileSync(path.join(decoder,'package.json'),'{"type":"module"}');
  const identifier=encodeWindowsTlsKeyIdentifier({keysetGeneration:1,stateSha256:'1'.repeat(64),
    keysetReceiptSha256:'2'.repeat(64),helperExecutableSha256:'3'.repeat(64),
    helperExecutablePath:'C:\\fixture\\client.exe',
    workerPublicKeySpkiBase64Url:Buffer.from('302a300506032b6570032100'+'44'.repeat(32),'hex').toString('base64url')});
  fs.writeFileSync(path.join(root,'reference.txt'),identifier);
  const harness=path.join(root,'check.ps1');
  fs.writeFileSync(harness,`param([string]$Common,[string]$Root)
$ErrorActionPreference='Stop'
. $Common
$good=[IO.File]::ReadAllBytes((Join-Path $Root 'reference.txt'))
Assert-WorkerProtectedKeyInput -Bytes $good -PackageRoot $Root
$badInputs=@('{}',([Text.Encoding]::UTF8.GetString($good)+[char]10),('goatcitadel-tls-v1:00'))
foreach ($bad in $badInputs) {
  $refused=$false
  try { Assert-WorkerProtectedKeyInput -Bytes ([Text.Encoding]::UTF8.GetBytes($bad)) -PackageRoot $Root } catch { $refused=$true }
  if (-not $refused) { throw 'Malformed reference accepted.' }
}
'PASS: valid reference accepted; JSON, newline and corrupt identifier refused.'
exit 0
`.replace(/\n/g,'\r\n'));
  const r=spawnSync(engine,['-NoProfile','-ExecutionPolicy','Bypass','-File',harness,
    '-Common',path.resolve('scripts/remote-worker/worker-install-common.ps1'),'-Root',root],
    {encoding:'utf8',windowsHide:true,timeout:30000});
  assert.equal(r.status,0,r.stderr+r.stdout);assert.match(r.stdout,/PASS:/);
});
