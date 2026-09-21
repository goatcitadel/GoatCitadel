import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
for(const engine of ['powershell.exe','pwsh.exe']) {
  test(`${engine}: cell parent permits SACL AI metadata only`,{ skip: process.platform !== "win32" },()=>{
    const common=path.resolve(import.meta.dirname,'worker-install-common.ps1').replaceAll("'","''");
    const code=`$ErrorActionPreference='Stop'; . '${common}';
$exact=$script:CellControllerParentSddl;
$observed=$exact.Replace('S:(', 'S:AI(');
Assert-WorkerCellParentSecurity $exact;
Assert-WorkerCellParentSecurity $observed;
$bad=@(
 $observed.Replace('O:SY','O:BA'),
 $observed.Replace('G:SY','G:BA'),
 $observed.Replace('D:P','D:PAI'),
 $observed.Replace('D:P','D:'),
 $observed.Replace('S:AI','S:ARAI'),
 $observed.Replace('S:AI','S:PAI'),
 $observed.Replace('NW;;;ME','NW;;;LW'),
 $observed.Replace('NW;;;ME','NRNW;;;ME'),
 $observed.Replace('(ML;OICI;','(ML;OICIID;'),
 $observed.Replace('(ML;OICI;','(ML;;'),
 $observed.Replace(';;;OW)',';;;BA)'),
 $observed.Replace('S:AI','(A;;FA;;;BA)S:AI'),
 $observed.Substring(0,$observed.IndexOf('S:AI'))
);
$count=0; foreach($sddl in $bad) { try { Assert-WorkerCellParentSecurity $sddl } catch { $count++ } };
if ($count -ne $bad.Count) { throw 'A security-changing descriptor was accepted.' };
'PASS: exact and AI-only forms accepted; thirteen security changes refused';`;
    const result=spawnSync(engine,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:20000});
    assert.equal(result.status,0,result.stdout+result.stderr);assert.match(result.stdout,/PASS:/);
  });
}
