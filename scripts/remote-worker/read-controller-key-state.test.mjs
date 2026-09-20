import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const file=path.resolve(import.meta.dirname,'read-controller-key-state.ps1');
const source=fs.readFileSync(file,'utf8');
const code=source.match(/\$source=@'\r?\n([\s\S]*?)\r?\n'@/)[1];
for(const engine of ['powershell.exe','pwsh.exe']) {
  test(`${engine}: read-only controller key probe compiles and returns only bounded metadata`,()=>{
    const command=`$ErrorActionPreference='Stop'; Add-Type -TypeDefinition @'\n${code}\n'@; [GoatCitadel.Diagnostics.ControllerKeyReader]::Read() | ConvertTo-Json`;
    const result=spawnSync(engine,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:30000});
    assert.equal(result.status,0,result.stderr);
    const report=JSON.parse(result.stdout);
    assert.deepEqual(Object.keys(report).sort(),['ProviderStatus','EnumerationStatus','EnumerationComplete','ExactNameObserved','OpenStatus'].sort());
    assert.equal(report.ProviderStatus,'0x00000000');
    assert.match(report.OpenStatus,/^0x[0-9a-f]{8}$/);
  });
  test(`${engine}: wrong-host launch refuses before probing`,()=>{
    assert.notEqual(process.env.COMPUTERNAME,'GOATBOX');
    const result=spawnSync(engine,['-NoProfile','-NonInteractive','-File',file],{encoding:'utf8',windowsHide:true,timeout:10000});
    assert.notEqual(result.status,0);assert.match(result.stderr,/GOATBOX only/);
  });
}
test('native probe has no key mutation, signing, export or private-property imports',()=>{
  assert.deepEqual([...code.matchAll(/extern int (\w+)/g)].map(match=>match[1]),[
    'NCryptOpenStorageProvider','NCryptEnumKeys','NCryptOpenKey','NCryptFreeBuffer','NCryptFreeObject']);
});
