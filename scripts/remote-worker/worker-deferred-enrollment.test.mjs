import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

for (const engine of ['powershell.exe', 'pwsh.exe']) {
  test(`${engine}: explicit deferred enrollment and ticket choice fail closed`,{ skip: process.platform !== "win32" }, () => {
    const common=path.resolve('scripts/remote-worker/worker-install-common.ps1').replaceAll("'","''");
    const code=`$ErrorActionPreference='Stop'; . '${common}';
Assert-WorkerEnrollmentInputChoice -DeferEnrollment;
Assert-WorkerEnrollmentInputChoice -TicketFile 'C:\\ticket.json';
$count=0;
try { Assert-WorkerEnrollmentInputChoice } catch { $count++ };
try { Assert-WorkerEnrollmentInputChoice -TicketFile 'C:\\ticket.json' -DeferEnrollment } catch { $count++ };
if ($count -ne 2) { throw 'Ambiguous enrollment inputs accepted.' };
'PASS';`;
    const result=spawnSync(engine,['-NoProfile','-NonInteractive','-Command',code],{encoding:'utf8',windowsHide:true,timeout:20000});
    assert.equal(result.status,0,result.stdout+result.stderr);
    assert.match(result.stdout,/PASS/);
  });
  test(`${engine}: GOATBOX launcher refuses a different machine before any file or service work`,{ skip: process.platform !== "win32" }, () => {
    assert.notEqual(process.env.COMPUTERNAME,'GOATBOX');
    const result=spawnSync(engine,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',
      path.resolve('scripts/remote-worker/install-goatbox-worker.ps1'),'-HandoffManifestSha256','0'.repeat(64),'-Apply'],
      {encoding:'utf8',windowsHide:true,timeout:20000});
    assert.notEqual(result.status,0);
    assert.match(result.stderr,/GOATBOX only/);
  });
}
