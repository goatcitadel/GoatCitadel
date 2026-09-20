import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
const file=path.resolve(import.meta.dirname,'resume-goatbox-worker-install.ps1');
const source=fs.readFileSync(file,'utf8');
const evidence=source.slice(source.indexOf('  $failed=ConvertFrom-WorkerJson'),source.indexOf('  # Validate the partial v2 recovery'));
for(const engine of ['powershell.exe','pwsh.exe']) {
  test(`${engine}: recovery evidence accepts exact incident and refuses substitutions`,()=>{
    const code=String.raw`$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest;
$failedFixture=[pscustomobject]@{verdict='failed';preflight=$false;installationId='81877965c3b140539617e7699cd4e3e8';
manifestSha256='d80b8d70375b40962947689e2cfc4787ae28aa9dc64a8ebc9e0fed3c5559256b';
settingsSha256='333f16a1bf8c6263da29af38ebee4711b5917cfece64a609d201ee40d85a3427';
controllerCustodySha256='fcd2150487ec87d98b60df32491a215ae693167003744b072ea338173d45a786';
createdService=$false;createdController=$false;createdCells=$true}
$reviewFixture=[pscustomobject]@{schemaVersion='goatcitadel.controller-key-system-review.v1';verdict='passed';computerName='GOATBOX';
publicPointHex='0473401e4f060e970cbc5814df8428c6b34dc557ad2127d33b8b155f9c9a57ce96b925db1947adf2ae3c2c19e6678d1f4016c33364a88483537a661d2de71ca0ca';
keySha256='173b2848bc3fd5b2f0f41e983a46c8883fe1f1919369826e96704cb091edf362';keyCreated=$false;keyPermissionsChanged=$false;privateKeyExported=$false}
function Read-WorkerBytes([string]$Path) { return $Path }
function ConvertFrom-WorkerJson([string]$Path) { if ($Path.EndsWith('worker-install-evidence.json')) { return $failedFixture }; return $reviewFixture }
$check=[scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(evidence).toString('base64')}')))
& $check
$count=0
foreach ($field in @('installationId','manifestSha256','settingsSha256','controllerCustodySha256')) {
 $old=$failedFixture.$field; $failedFixture.$field='different'; try { & $check } catch { $count++ }; $failedFixture.$field=$old
}
foreach ($field in @('createdService','createdController')) {
 $failedFixture.$field=$true; try { & $check } catch { $count++ }; $failedFixture.$field=$false
}
foreach ($field in @('verdict','publicPointHex','keySha256','computerName')) {
 $old=$reviewFixture.$field; $reviewFixture.$field='different'; try { & $check } catch { $count++ }; $reviewFixture.$field=$old
}
if ($count -ne 10) { throw 'Recovery accepted changed evidence.' }
$tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseFile('${file.replaceAll("'","''")}',[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }; 'PASS: exact incident accepted; ten substitutions refused'
`;
    const result=spawnSync(engine,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:20000});
    assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS/);
  });
  test(`${engine}: wrong-host apply refuses before mutations`,()=>{
    assert.notEqual(process.env.COMPUTERNAME,'GOATBOX');
    const result=spawnSync(engine,['-NoProfile','-NonInteractive','-File',file,'-Apply'],{encoding:'utf8',windowsHide:true,timeout:10000});
    assert.notEqual(result.status,0);assert.match(result.stderr,/GOATBOX only/);
  });
}
test('recovery has no key recreation, service start, payload copy or cleanup deletion',()=>{
  assert.doesNotMatch(source,/::CreateMachineKey|Start-Service|Remove-Item|DeleteFile|RemoveService|Format-Volume|Copy-WorkerPinnedFile/);
  assert.match(source,/AcquireInstalledStateWriterGate/);
});

for (const engine of ['powershell.exe','pwsh.exe']) {
 test(engine+': partial recovery rejects changed state',()=>{
  const block=source.slice(source.indexOf('  $partial=ConvertFrom-WorkerJson'),source.indexOf('  # Service state is checked again'));
  const code=String.raw`$ErrorActionPreference='Stop'; Set-StrictMode -Version Latest;
$f=[pscustomobject]@{schemaVersion='goatcitadel.goatbox-worker-recovery.v1';verdict='failed';stage='create stopped worker service';apply=$true;createdWorker=$false;createdController=$true;servicesStarted=$false;keyChanged=$false;payloadReplaced=$false;newConfigurationFiles=@('C:\ProgramData\GoatCitadel\RemoteWorker\configuration\controller-signing-enrollment.json','C:\ProgramData\GoatCitadel\RemoteWorker\configuration\install-receipt.json')};
function Read-WorkerBytes { return '' }; function ConvertFrom-WorkerJson { return $f };
$check=[scriptblock]::Create([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(block).toString('base64')}')));
& $check; $n=0;
foreach ($field in @('apply','createdWorker','createdController','servicesStarted','keyChanged','payloadReplaced')) { $old=$f.$field; $f.$field=-not $old; try { & $check } catch { $n++ }; $f.$field=$old };
foreach ($field in @('schemaVersion','verdict','stage','newConfigurationFiles')) { $old=$f.$field; $f.$field='wrong'; try { & $check } catch { $n++ }; $f.$field=$old };
if ($n -ne 10) { throw 'Changed partial state accepted' }; 'PASS'
`;
  const result=spawnSync(engine,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:20000});
  assert.equal(result.status,0,result.stdout+result.stderr);
 });
}
test('virtual account uses null password; resume preserves completed controller and records',()=>{
 const native=fs.readFileSync(path.join(import.meta.dirname,'worker-install-native.cs'),'utf8');
 assert.ok(native.includes('@"NT SERVICE\\GoatCitadelRemoteWorker", null)'));
 assert.doesNotMatch(source,/::CreateStoppedCellControllerService|Write-WorkerProtectedBytes|::SetFileSddl/);
 assert.match(source,/Retained recovery record differs/);
});
