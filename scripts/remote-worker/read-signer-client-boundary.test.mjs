import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
const script=fileURLToPath(new URL('./read-signer-client-boundary.ps1',import.meta.url));
const source=fs.readFileSync(script,'utf8');
test('one fixed signer start requires observed failures and no protocol or custody writes',()=>{
  assert.equal(source.match(/StartServiceW\(services\[0\], 0, IntPtr.Zero\)/gu)?.length,1);
  assert.doesNotMatch(source,/StartServiceW\(services\[1\]/u);
  assert.match(source,/startOnce && i == 0 \? 16 : 0/u);
  assert.match(source,/status\.win32Exit != 1066 \|\| status\.serviceExit != 6/u);
  assert.match(source,/status\.win32Exit != 1066 \|\| status\.serviceExit != 3/u);
  assert.match(source,/initial\.configurationBytesNeeded = needed/u);
  assert.ok(source.indexOf('if (!startOnce) return result;') < source.indexOf('result.startReturnedSuccess = StartServiceW'));
  assert.doesNotMatch(source,/\b(?:CreateFileW|CreateNamedPipeW|ConnectNamedPipe|WriteFile|ReadProcessMemory|WriteProcessMemory|AdjustTokenPrivileges|CreateServiceW|DeleteService|ChangeServiceConfigW|ControlService|SetKernelObjectSecurity|Remove-Item|Format-Volume|Clear-Disk)\b/u);
});
for(const engine of ['powershell.exe','pwsh.exe']) {
  test(`${engine}: observer process/token queries work`,{skip:process.platform!=='win32'},()=>{
    const result=spawnSync(engine,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-SelfTest'],{encoding:'utf8',timeout:30000,windowsHide:true});
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(result.stdout.replace(/^\uFEFF/u,''));
    assert.equal(report.serviceName,'self-test only');
    assert.equal(report.tokenQuery,true);
    assert.equal(report.processQueryAndSynchronize,true);
    assert.deepEqual(report.errors,[]);
  });
  test(`${engine}: wrong host refused before service access`,{skip:process.platform!=='win32'||process.env.COMPUTERNAME==='GOATBOX'},()=>{
    const result=spawnSync(engine,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script,'-StartOnce'],{encoding:'utf8',timeout:10000,windowsHide:true});
    assert.notEqual(result.status,0);
    assert.match(result.stderr+result.stdout,/GOATBOX only/u);
  });
}
