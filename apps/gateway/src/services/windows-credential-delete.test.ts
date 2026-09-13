import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import { WINDOWS_CREDENTIAL_DELETE_FUNCTION } from "./windows-credential-delete.js";

it.skipIf(process.platform !== "win32").each([
  { mode: "absent", outcome: "absent", reads: 1, removes: 0 },
  { mode: "present", outcome: "ok", reads: 2, removes: 1 },
  { mode: "read-denied", outcome: "failed", reads: 1, removes: 0 },
  { mode: "remove-denied", outcome: "failed", reads: 1, removes: 1 },
  { mode: "retained", outcome: "failed", reads: 2, removes: 1 },
  { mode: "verify-denied", outcome: "failed", reads: 2, removes: 1 },
])("classifies actual PowerShell vault exception/control flow: $mode", ({ mode, outcome, reads, removes }) => {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("Windows fixture requires SystemRoot.");
  // This script never constructs PasswordVault or reads/writes an OS credential.
  // ScriptMethod gives the helper real PowerShell invocation-exception wrapping.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
${WINDOWS_CREDENTIAL_DELETE_FUNCTION}
$vault = [pscustomobject]@{ Mode=$env:GOAT_DELETE_FIXTURE; Present=($env:GOAT_DELETE_FIXTURE -ne 'absent'); Reads=0; Removes=0 }
$vault | Add-Member -MemberType ScriptMethod -Name Retrieve -Value {
  param($resource, $account)
  $this.Reads += 1
  if ($resource -ne 'fixture-resource' -or $account -ne 'fixture-account') { throw 'Wrong fixture owner.' }
  if ($this.Mode -eq 'read-denied' -or ($this.Mode -eq 'verify-denied' -and $this.Reads -gt 1)) {
    throw [System.Runtime.InteropServices.COMException]::new('private-fixture-diagnostic', -2147024891)
  }
  if (-not $this.Present) { throw [System.Runtime.InteropServices.COMException]::new('private-fixture-diagnostic', -2147023728) }
  return [pscustomobject]@{ Account='fixture-account' }
}
$vault | Add-Member -MemberType ScriptMethod -Name Remove -Value {
  param($credential)
  $this.Removes += 1
  if ($credential.Account -ne 'fixture-account') { throw 'Wrong fixture removal.' }
  if ($this.Mode -eq 'remove-denied') { throw [System.Runtime.InteropServices.COMException]::new('private-fixture-diagnostic', -2147024891) }
  if ($this.Mode -ne 'retained') { $this.Present = $false }
}
try { $outcome = Remove-GoatCredential $vault 'fixture-resource' 'fixture-account' }
catch { $outcome = 'failed' }
@{ outcome=$outcome; reads=$vault.Reads; removes=$vault.Removes } | ConvertTo-Json -Compress
`;
  const result = spawnSync(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script], {
      windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024, encoding: "utf8",
      env: { SystemRoot: systemRoot, GOAT_DELETE_FIXTURE: mode },
    });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).not.toContain("private-fixture-diagnostic");
  expect(JSON.parse(result.stdout)).toEqual({ outcome, reads, removes });
});
