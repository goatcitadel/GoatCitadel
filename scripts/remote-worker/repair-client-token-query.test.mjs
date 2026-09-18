import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const directory = path.dirname(fileURLToPath(import.meta.url));
const repair = path.join(directory, 'repair-client-token-query.ps1');
const source = fs.readFileSync(repair, 'utf8');
const native = fs.readFileSync(path.join(directory, 'broker-image-maintenance.cs'), 'utf8');
test('maintenance is limited to pinned existing images and preserves custody and SCM registrations', () => {
  assert.doesNotMatch(source + native, /\b(?:SetKernelObjectSecurity|SetSecurityInfo|SetServiceObjectSecurity|SetTokenInformation|CreateServiceW|DeleteService|ChangeServiceConfigW|ControlService|StartServiceW|Format-Volume|Clear-Disk|Initialize-Disk|Remove-Item|ReadEntries|CreateChild|RemoveCreatedEmpty)\b/u);
  assert.match(native, /IntPtr.Zero, 3U, 0x02200000U/u);
  assert.match(native, /write \? 0U : 1U/u);
  assert.match(source, /\$inventory\[\$source\]\.ToLowerInvariant\(\)/u);
  assert.match(source, /\$bytesHash -cne \$nextHash/u);
  assert.ok(source.indexOf("Save-Receipt 'prepared-update-evidence.json'") < source.indexOf('$image.lease.Replace('));
  assert.match(source, /\$written\[\$i\]\.lease\.RestoreOriginal\(\)/u);
});
for (const engine of ['powershell.exe', 'pwsh.exe']) {
  const env = { ...process.env };
  // Windows PowerShell must discover its own compatible system modules;
  // inheriting a PowerShell 7 parent's PSModulePath hides Get-Acl/Get-FileHash.
  for (const key of Object.keys(env)) if (key.toLowerCase() === 'psmodulepath') delete env[key];
  const run = (...args) => spawnSync(engine, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', ...args], {
    encoding: 'utf8', timeout: 45000, windowsHide: true, env,
  });
  test(`${engine}: existing-file exclusion, backup, readback, security and rollback`, { skip: process.platform !== 'win32' }, () => {
    const result = run('-File', path.join(directory, 'broker-image-maintenance.behavior.test.ps1'));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(JSON.parse(result.stdout).passed, true);
  });
  for (const scenario of ['preflight', 'apply', 'rollback', 'running']) {
    test(`${engine}: orchestration ${scenario}, real temporary files and mocked SCM`, { skip: process.platform !== 'win32' }, () => {
      const result = run('-File', path.join(directory, 'repair-client-token-query.behavior.test.ps1'), '-Case', scenario);
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), { passed: true, case: scenario });
    });
  }
  test(`${engine}: wrong host refused before helper loading or filesystem writes`, {
    skip: process.platform !== 'win32' || process.env.COMPUTERNAME === 'GOATBOX',
  }, () => {
    const result = run('-File', repair, '-PackageRoot', 'Z:\\absent', '-ManifestSha256', '0'.repeat(64), '-OutputRoot', 'Z:\\absent');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr + result.stdout, /Run this repair on GOATBOX only/u);
  });
}
