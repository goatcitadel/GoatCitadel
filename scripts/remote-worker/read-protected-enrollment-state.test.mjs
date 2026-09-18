import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const script=fileURLToPath(new URL('./read-protected-enrollment-state.ps1',import.meta.url));
const source=fs.readFileSync(script,'utf8');
test('public inspection has no key creation, service control or filesystem writes',()=>{
  assert.doesNotMatch(source,/\b(?:createWindowsProtectedKeyset|revokeWindowsProtectedKeyset|Start-Service|Stop-Service|Set-Content|WriteAllText|WriteAllBytes|Remove-Item|Format-Volume|Clear-Disk)\b/u);
  assert.match(source,/FileMode\]::Open/u);
  assert.match(source,/FileShare\]::Read/u);
  assert.match(source,/inspectWindowsProtectedService/u);
});
test('public projection retains exact path, bigint generations and public key bytes only',()=>{
  const code=source.match(/\$code=@'\r?\n([\s\S]*?)\r?\n'@/u)[1];
  const replacement=`const inspectWindowsProtectedService=async (path)=>{
    if (path !== ${JSON.stringify('C:\\ProgramData\\GoatCitadel\\RemoteWorkerProvisioner\\bin\\GoatCitadelRemoteWorkerProvisionerClient.exe')}) throw Error('wrong client path');
    return {custodyPosture:'empty',activeGeneration:0n,highestBurnedGeneration:0n,runtimeManifestSpki:new Uint8Array([1,2,3]),secret:'must not print'};
  };`;
  const result=spawnSync(process.execPath,['--input-type=module','-e',code.replace(/^import[^\n]+\n/u,replacement+'\n')],{encoding:'utf8',timeout:5000,windowsHide:true});
  assert.equal(result.status,0,result.stderr);
  const report=JSON.parse(result.stdout);
  assert.equal(report.custodyPosture,'empty');
  assert.equal(report.activeGeneration,'0');
  assert.equal(report.runtimeManifestSpki,'010203');
  assert.equal('secret' in report,false);
});
for(const engine of ['powershell.exe','pwsh.exe']) test(`${engine}: refuses another host before loading package or helper`,{skip:process.platform!=='win32'||process.env.COMPUTERNAME==='GOATBOX'},()=>{
  const result=spawnSync(engine,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],{encoding:'utf8',timeout:10000,windowsHide:true});
  assert.notEqual(result.status,0);
  assert.match(result.stderr+result.stdout,/GOATBOX only/u);
});
