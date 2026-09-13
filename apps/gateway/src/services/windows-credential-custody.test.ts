import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { expect, it } from "vitest";
import { WINDOWS_CREDENTIAL_CUSTODY_FUNCTIONS, WINDOWS_CREDENTIAL_CUSTODY_WRITE_FUNCTION,
  WINDOWS_CREDENTIAL_CUSTODY_WRITE_SCRIPT, WINDOWS_CREDENTIAL_CUSTODY_DELETE_SCRIPT } from "./windows-credential-custody.js";

const win = it.skipIf(process.platform !== "win32");
const machine = "11111111-2222-4333-8444-555555555555";
const sid = "S-1-5-21-100-200-300-1001";
const binding = (machineId = machine, userSid = sid) => createHash("sha256")
  .update(["goatcitadel.windows-credential-custody.v1", machineId.toLowerCase(), userSid, "goatcitadel"].join("\0")).digest("hex");

win.each([
  { machineId: machine, userSid: sid },
  { machineId: "AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE", userSid: sid },
  { machineId: machine, userSid: "S-1-5-18" },
])("derives the exact opaque host/principal digest in PowerShell: $machineId / $userSid", ({ machineId, userSid }) => {
  const result = run(`${WINDOWS_CREDENTIAL_CUSTODY_FUNCTIONS}\nGet-GoatCredentialCustodyDigest $env:FIXTURE_MACHINE $env:FIXTURE_SID 'goatcitadel'`,
    { FIXTURE_MACHINE: machineId, FIXTURE_SID: userSid });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout.trim()).toBe(binding(machineId, userSid));
  expect(result.stdout).not.toContain(userSid);
});

win.each([
  { current: binding(), expected: binding(), boundary: true, status: 1 },
  { current: binding(), expected: binding(machine, "S-1-5-18"), boundary: false, status: 4 },
  { current: binding(), expected: binding("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee"), boundary: false, status: 4 },
  { current: "private-error", expected: binding(), boundary: false, status: 1 },
  { current: binding(), expected: "invalid", boundary: false, status: 1 },
])("guards both mutation scripts before vault access: $status / $boundary", ({ current, expected, boundary, status }) => {
  for (const script of [WINDOWS_CREDENTIAL_CUSTODY_WRITE_SCRIPT, WINDOWS_CREDENTIAL_CUSTODY_DELETE_SCRIPT]) {
    // Override only identity discovery and the vault boundary. The exact
    // production guard runs, without reading registry identity or any OS vault.
    const fixture = script.replace("try {\n  if (-not (Test-GoatCredentialCustody",
      "function Get-GoatCurrentCredentialCustody { if ($env:FIXTURE_CURRENT -eq 'private-error') { throw 'private-identity-error' }; return $env:FIXTURE_CURRENT }\ntry {\n  if (-not (Test-GoatCredentialCustody")
      .replace("[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null",
        "[Console]::Out.WriteLine('vault_boundary'); throw 'private-vault-error'");
    expect(fixture).not.toBe(script);
    expect(fixture).toContain("function Get-GoatCurrentCredentialCustody { if");
    expect(fixture).not.toContain("[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null");
    const result = run(fixture, { FIXTURE_CURRENT: current, GOATCITADEL_SECRET_CUSTODY: expected });
    expect(result.status, result.stderr).toBe(status);
    expect(result.stdout.includes("vault_boundary")).toBe(boundary);
    expect(result.stdout + result.stderr).not.toMatch(/private-(identity|vault)-error/u);
    if (status === 4) expect(result.stdout.trim()).toBe("custody_mismatch");
  }
});

win.each([
  { mode: "success", outcome: "ok", reads: 2, adds: 1 },
  { mode: "occupied", outcome: "failed", reads: 1, adds: 0 },
  { mode: "read-denied", outcome: "failed", reads: 1, adds: 0 },
  { mode: "add-denied", outcome: "failed", reads: 1, adds: 1 },
  { mode: "changed", outcome: "failed", reads: 2, adds: 1 },
  { mode: "missing-after-add", outcome: "failed", reads: 2, adds: 1 },
  { mode: "verify-denied", outcome: "failed", reads: 2, adds: 1 },
])("verifies immutable writes through real PowerShell control flow: $mode", ({ mode, outcome, reads, adds }) => {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
${WINDOWS_CREDENTIAL_CUSTODY_WRITE_FUNCTION}
$credential = [pscustomobject]@{ Resource='goatcitadel'; UserName='fixture-account'; Password='private-test-value' }
$credential | Add-Member -MemberType ScriptMethod -Name RetrievePassword -Value { }
$vault = [pscustomobject]@{ Mode=$env:FIXTURE_MODE; Present=($env:FIXTURE_MODE -eq 'occupied'); Reads=0; Adds=0; Saved=$credential }
$vault | Add-Member -MemberType ScriptMethod -Name Retrieve -Value {
  param($resource, $account)
  $this.Reads += 1
  if ($resource -ne 'goatcitadel' -or $account -ne 'fixture-account') { throw 'Wrong owner.' }
  if ($this.Mode -eq 'read-denied' -or ($this.Reads -gt 1 -and $this.Mode -eq 'verify-denied')) {
    throw [System.Runtime.InteropServices.COMException]::new('private-diagnostic', -2147024891)
  }
  if (-not $this.Present -or $this.Mode -eq 'missing-after-add') {
    throw [System.Runtime.InteropServices.COMException]::new('private-diagnostic', -2147023728)
  }
  return $this.Saved
}
$vault | Add-Member -MemberType ScriptMethod -Name Add -Value {
  param($value)
  $this.Adds += 1
  if ($this.Mode -eq 'add-denied') { throw 'private-add-error' }
  $this.Present = $true
  if ($this.Mode -eq 'changed') { $this.Saved.Password = 'private-other-value' }
}
try { $outcome = Add-GoatOwnedCredential $vault $credential 'private-test-value' }
catch { $outcome = 'failed' }
@{ outcome=$outcome; reads=$vault.Reads; adds=$vault.Adds } | ConvertTo-Json -Compress
`;
  const result = run(script, { FIXTURE_MODE: mode });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout + result.stderr).not.toContain("private-");
  expect(JSON.parse(result.stdout)).toEqual({ outcome, reads, adds });
});

function run(script: string, env: Record<string, string>) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("Windows PowerShell fixture requires SystemRoot.");
  const result = spawnSync(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024,
      encoding: "utf8", env: { SystemRoot: systemRoot, ...env } });
  expect(result.error).toBeUndefined();
  return result;
}
