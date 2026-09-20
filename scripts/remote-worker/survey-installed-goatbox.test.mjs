import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import test from 'node:test';
const source=fs.readFileSync(path.join(import.meta.dirname,'survey-installed-goatbox.ps1'),'utf8');
const helper=source.slice(source.indexOf('function Invoke-SurveyProcess'),source.indexOf('function Hold-SurveyFile'));
for(const engine of ['powershell.exe','pwsh.exe']){
 test(engine+': survey preserves child stdout, stderr and exact exit code',()=>{
  const code=`$ErrorActionPreference='Stop'; ${helper}
foreach($exit in @(0,7)) {
 $start=[Diagnostics.ProcessStartInfo]::new(); $start.FileName=(Get-Process -Id $PID).Path;
 $childCode='[Console]::Out.WriteLine("survey-output"); [Console]::Error.WriteLine("specific-survey-failure"); exit '+$exit;
 $start.Arguments='-NoProfile -NonInteractive -EncodedCommand '+[Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($childCode));
 $start.UseShellExecute=$false; $start.CreateNoWindow=$true;
 $result=Invoke-SurveyProcess $start;
 if($result.exitCode -ne $exit -or $result.stdout.Trim() -cne 'survey-output' -or $result.stderr.Trim() -cne 'specific-survey-failure' -or $result.outputTruncated) { throw 'Child diagnostic was lost.' }
}; 'PASS'
`;
  const r=spawnSync(engine,['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(code,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:20000});
  assert.equal(r.status,0,r.stdout+r.stderr);assert.match(r.stdout,/PASS/);
 });
}
