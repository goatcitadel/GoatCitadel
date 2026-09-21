import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const file=path.resolve(import.meta.dirname,'verify-goatbox-controller-key-system.ps1');
const source=fs.readFileSync(file,'utf8');
const worker=source.match(/\$worker=@'\r?\n([\s\S]*?)\r?\n'@/)[1];
for (const engine of ['powershell.exe','pwsh.exe']) {
  test(`${engine}: SYSTEM review enforces exact permissions and public blob shape`,{ skip: process.platform !== "win32" },()=>{
    const commands=worker.split('# Execute only')[0]+`
$sid='S-1-5-80-1810587747-2867442932-4204439414-1143594691-3479143721'
function Descriptor([string]$sddl) {
  $sd=[Security.AccessControl.RawSecurityDescriptor]::new($sddl)
  $bytes=[byte[]]::new($sd.BinaryLength); $sd.GetBinaryForm($bytes,0); return ,$bytes
}
Assert-ControllerReviewSecurity (Descriptor "O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;$sid)")
Assert-ControllerReviewSecurity (Descriptor "O:SYD:P(A;;0xd01f01ff;;;SY)(A;;0xd01f01ff;;;$sid)") -ProviderDescriptor
$providerRejected=0
try { Assert-ControllerReviewSecurity (Descriptor "O:SYD:P(A;;0xd01f01ff;;;SY)(A;;0xd01f01ff;;;$sid)") } catch { $providerRejected++ }
foreach ($sddl in @("O:SYD:P(A;;0xd11f01ff;;;SY)(A;;0xd01f01ff;;;$sid)",
  "O:SYD:P(A;;0xd01f01fe;;;SY)(A;;0xd01f01ff;;;$sid)",
  "O:SYD:P(A;;0xd01f01ff;;;SY)(A;;0xd01f01ff;;;BA)",
  "O:SYD:P(A;;0xd01f01ff;;;SY)(A;;0xd01f01ff;;;$sid)(A;;FA;;;BA)")) {
  try { Assert-ControllerReviewSecurity (Descriptor $sddl) -ProviderDescriptor } catch { $providerRejected++ }
}
if ($providerRejected -ne 5) { throw 'Provider-specific permission boundary weakened.' }
$details=Get-ControllerReviewSecurityReport (Descriptor "O:SYG:SYD:P(A;;0x1f0003;;;SY)(A;;FA;;;$sid)")
if ($details.aces.Count -ne 2 -or $details.aces[0].mask -cne '0x001F0003' -or
    $details.aces[0].sid -cne 'S-1-5-18' -or $details.aces[1].mask -cne '0x001F01FF') {
  throw 'Diagnostic dropped exact permission details.'
}
$rejected=0
foreach ($sddl in @("O:BAG:SYD:P(A;;FA;;;SY)(A;;FA;;;$sid)","O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;BA)",
  "O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;$sid)(A;;FA;;;BA)","O:SYG:SYD:(A;;FA;;;SY)(A;;FA;;;$sid)")) {
  try { Assert-ControllerReviewSecurity (Descriptor $sddl) } catch { $rejected++ }
}
if ($rejected -ne 4) { throw 'Bad key permissions accepted.' }
$blob=[byte[]]::new(72); [BitConverter]::GetBytes([uint32]0x31534345).CopyTo($blob,0); $blob[4]=32
$point=ConvertTo-ControllerPublicPoint $blob
if ($point.Length -ne 65 -or $point[0] -ne 4) { throw 'Public point framing differs.' }
$rejected=0
try { $null=ConvertTo-ControllerPublicPoint ([byte[]]::new(71)) } catch { $rejected++ }
$blob[0]=0
try { $null=ConvertTo-ControllerPublicPoint $blob } catch { $rejected++ }
if ($rejected -ne 2) { throw 'Malformed public blob accepted.' }
$tokens=$null; $errors=$null
$null=[Management.Automation.Language.Parser]::ParseInput([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(worker).toString('base64')}')),[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
'PASS'
`;
    const result=spawnSync(engine,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(commands,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:20000});
    assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS/);
  });
  test(`${engine}: wrong-host launch refuses before directory or task creation`,{ skip: process.platform !== "win32" },()=>{
    assert.notEqual(process.env.COMPUTERNAME,'GOATBOX');
    const result=spawnSync(engine,['-NoProfile','-NonInteractive','-File',file],{encoding:'utf8',windowsHide:true,timeout:10000});
    assert.notEqual(result.status,0);assert.match(result.stderr,/GOATBOX only/);
  });
}
test('review opens the existing exact key and exports only public material',()=>{
  assert.match(worker,/CngKey\]::Open/);
  assert.match(worker,/EccPublicBlob/);
  assert.doesNotMatch(worker,/CngKey\]::Create|\.SetProperty\(|\.Delete\(|PrivateBlob|Pkcs8|SignHash|Set-Acl/);
  assert.match(worker,/5e73bfd4cd51dfdc788ed3095838b24d_b73bf112-8305-4217-a84f-f751c7d78199/);
});
