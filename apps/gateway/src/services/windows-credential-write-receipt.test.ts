import { spawnSync } from "node:child_process";
import path from "node:path";
import { expect, it } from "vitest";
import { WINDOWS_CREDENTIAL_RECEIPT_FUNCTION, WINDOWS_CREDENTIAL_RECEIPT_SCRIPT } from "./windows-credential-write-receipt.js";
import { encodeMcpCredentialReceipt } from "./mcp-credential-receipt.js";

const win = it.skipIf(process.platform !== "win32");
const id = "11111111-2222-4333-8444-555555555555";

win.each([
  { mode: "match", remove: false, outcome: "written", removals: 0 },
  { mode: "match", remove: true, outcome: "ok", removals: 1 },
  { mode: "absent", remove: false, outcome: "absent", removals: 0 },
  { mode: "absent", remove: true, outcome: "absent", removals: 0 },
  { mode: "wrong-write", remove: false, outcome: "mismatch", removals: 0 },
  { mode: "wrong-write", remove: true, outcome: "mismatch", removals: 0 },
  { mode: "malformed", remove: true, outcome: "mismatch", removals: 0 },
  { mode: "extra-field", remove: true, outcome: "mismatch", removals: 0 },
  { mode: "oversized", remove: false, outcome: "mismatch", removals: 0 },
  { mode: "read-denied", remove: true, outcome: "unavailable", removals: 0 },
  { mode: "password-denied", remove: true, outcome: "unavailable", removals: 0 },
  { mode: "delete-denied", remove: true, outcome: "unavailable", removals: 1 },
  { mode: "still-present", remove: true, outcome: "unavailable", removals: 1 },
])("checks captured write ownership in real PowerShell without opening a keychain: $mode / $remove", ({ mode, remove, outcome, removals }) => {
  const script = String.raw`
$ErrorActionPreference = 'Stop'
${WINDOWS_CREDENTIAL_RECEIPT_FUNCTION}
$encoded = '{"version":1,"writeId":"${id}","secret":"private-fixture-value"}'
if ($env:FIXTURE_MODE -eq 'wrong-write') { $encoded = $encoded.Replace('${id}', 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee') }
if ($env:FIXTURE_MODE -eq 'malformed') { $encoded = 'private-invalid-json' }
if ($env:FIXTURE_MODE -eq 'extra-field') { $encoded = $encoded.Replace('"version":1', '"extra":true,"version":1') }
if ($env:FIXTURE_MODE -eq 'oversized') { $encoded = 'x' * 49153 }
$credential = [pscustomobject]@{ Password=$encoded; Mode=$env:FIXTURE_MODE }
$credential | Add-Member -MemberType ScriptMethod -Name RetrievePassword -Value { if ($this.Mode -eq 'password-denied') { throw 'private-read-error' } }
$vault = [pscustomobject]@{ Present=($env:FIXTURE_MODE -ne 'absent'); Mode=$env:FIXTURE_MODE; Saved=$credential; Removals=0 }
$vault | Add-Member -MemberType ScriptMethod -Name Retrieve -Value {
  param($resource, $account)
  if ($this.Mode -eq 'read-denied') { throw [System.Runtime.InteropServices.COMException]::new('private-read-error', -2147024891) }
  if (-not $this.Present) { throw [System.Runtime.InteropServices.COMException]::new('private-missing', -2147023728) }
  return $this.Saved
}
$vault | Add-Member -MemberType ScriptMethod -Name Remove -Value {
  param($credential)
  if (-not [Object]::ReferenceEquals($credential, $this.Saved)) { throw 'Wrong credential object.' }
  $this.Removals += 1
  if ($this.Mode -eq 'delete-denied') { throw 'private-delete-error' }
  if ($this.Mode -ne 'still-present') { $this.Present = $false }
}
try { $outcome = Invoke-GoatCredentialWriteReceipt $vault 'goatcitadel' 'mcp:fixture:environment:receipt-v1:${id}' '${id}' ($env:FIXTURE_REMOVE -eq 'yes') }
catch { $outcome = 'unavailable' }
@{ outcome=$outcome; removals=$vault.Removals } | ConvertTo-Json -Compress
`;
  const result = run(script, { FIXTURE_MODE: mode, FIXTURE_REMOVE: remove ? "yes" : "no" });
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout + result.stderr).not.toContain("private-");
  expect(JSON.parse(result.stdout)).toEqual({ outcome, removals });
});

win("rejects changed custody before accessing the receipt vault", () => {
  const fixture = WINDOWS_CREDENTIAL_RECEIPT_SCRIPT.replace("try {\n  if (-not (Test-GoatCredentialCustody",
    "function Get-GoatCurrentCredentialCustody { return ('b' * 64) }\ntry {\n  if (-not (Test-GoatCredentialCustody")
    .replace("[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime] | Out-Null",
      "throw 'Unexpected vault access.'");
  expect(fixture).not.toContain("| Out-Null");
  const result = run(fixture, { GOATCITADEL_SECRET_CUSTODY: "a".repeat(64), GOATCITADEL_SECRET_RECEIPT_ACTION: "remove" });
  expect(result.status, result.stderr).toBe(4);
  expect(result.stdout.trim()).toBe("custody_mismatch");
});

win("preserves Unicode and whitespace through real Windows PowerShell console pipes", () => {
  const secret = '  \uFEFFprivate-value\n"🦙é" ';
  const encoded = encodeMcpCredentialReceipt(secret, id);
  const expected = Buffer.from(secret, "utf8").toString("base64");
  const script = String.raw`
$ErrorActionPreference = 'Stop'
${WINDOWS_CREDENTIAL_RECEIPT_FUNCTION}
$credential = [pscustomobject]@{ Password=[Console]::In.ReadToEnd() }
$credential | Add-Member -MemberType ScriptMethod -Name RetrievePassword -Value { }
$valid = Test-GoatCredentialWriteReceipt $credential '${id}'
$decoded = ConvertFrom-Json -InputObject $credential.Password
$exact = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($decoded.secret)) -ceq '${expected}'
@{ valid=$valid; exact=$exact } | ConvertTo-Json -Compress
`;
  const result = run(script, {}, encoded);
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual({ valid: true, exact: true });
});

function run(script: string, env: Record<string, string>, input?: string) {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error("Windows PowerShell fixture requires SystemRoot.");
  const result = spawnSync(path.join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-Command", script], { windowsHide: true, timeout: 10000, maxBuffer: 16 * 1024,
      encoding: "utf8", env: { SystemRoot: systemRoot, ...env }, input });
  expect(result.error).toBeUndefined();
  return result;
}
