import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Pure descriptor validation: never invoke CreateMachineKey, service control,
// elevation, or disk operations. Exercise both installed PowerShell versions.
for (const shell of ["powershell.exe", "pwsh.exe"]) test(`controller key descriptor refuses extra authority (${shell})`,
  { skip: process.platform !== "win32" }, () => {
    const source = path.resolve(import.meta.dirname, "worker-controller-key.cs").replaceAll("'", "''");
    const script = `
$ErrorActionPreference = 'Stop'
Add-Type -Path '${source}'
$sid = 'S-1-5-80-1810587747-2867442932-4204439414-1143594691-3479143721'
function Check-Descriptor([string]$sddl, [bool]$expected) {
  $sd = [Security.AccessControl.RawSecurityDescriptor]::new($sddl)
  $bytes = [byte[]]::new($sd.BinaryLength)
  $sd.GetBinaryForm($bytes, 0)
  $accepted = $true
  try { [GoatCitadel.RemoteWorker.Install.ControllerKey]::ValidateSecurity($bytes) }
  catch { $accepted = $false }
  if ($accepted -ne $expected) { throw 'Descriptor admission differs.' }
}
Check-Descriptor "O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;$sid)" $true
Check-Descriptor "O:SYG:SYD:P(A;;FA;;;SY)(A;;FA;;;$sid)" $true
Check-Descriptor "O:BAG:SYD:P(A;;GA;;;SY)(A;;GA;;;$sid)" $false
Check-Descriptor "O:SYG:SYD:(A;;GA;;;SY)(A;;GA;;;$sid)" $false
Check-Descriptor "O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;BA)" $false
Check-Descriptor "O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;$sid)(A;;GA;;;BA)" $false
Check-Descriptor "O:SYG:SYD:P(A;;GA;;;SY)(A;;GA;;;SY)" $false
Check-Descriptor "O:SYG:SYD:P(A;OI;GA;;;SY)(A;;GA;;;$sid)" $false
Check-Descriptor "O:SYG:SYD:P(A;;GA;;;SY)(D;;GA;;;$sid)" $false
Check-Descriptor "O:SYG:SYD:P(A;;GA;;;SY)(A;;GR;;;$sid)" $false
Write-Output 'descriptor-only checks passed'
`;
    const result = spawnSync(shell, ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(script, "utf16le").toString("base64")],
      { encoding: "utf8", timeout: 30000, windowsHide: true });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /descriptor-only checks passed/u);
  });
