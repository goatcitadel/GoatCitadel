import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./read-broker-startup-owner.ps1", import.meta.url));
const source = fs.readFileSync(script, "utf8");

test("diagnostic has one broker start and no security, installation, process-control or disk mutations", () => {
  assert.doesNotMatch(source, /\b(?:SetKernelObjectSecurity|SetSecurityInfo|SetServiceObjectSecurity|SetTokenInformation|AdjustTokenPrivileges|WriteProcessMemory|ReadProcessMemory|CreateRemoteThread|TerminateProcess|CreateServiceW|DeleteService|ChangeServiceConfigW|ControlService|Format-Volume|Clear-Disk|Initialize-Disk|Remove-Item)\b/u);
  assert.equal(source.match(/result\.startReturnedSuccess = StartServiceW\(services\[1\], 0, IntPtr\.Zero\)/gu)?.length, 1);
  assert.ok(source.indexOf("if (!startOnce) return result;") < source.indexOf("result.startReturnedSuccess = StartServiceW"));
  assert.match(source, /AssertStoppedConfig\(services\[i\], Names\[i\]\)/u);
  assert.match(source, /FileAccess\.Read, FileShare\.Read/u);
});

for (const engine of ["powershell.exe", "pwsh.exe"]) {
  test(`${engine}: reads actual caller owners and process metadata without starting a service`, { skip: process.platform !== "win32" }, () => {
    const result = spawnSync(engine, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-SelfTest"], {
      encoding: "utf8", timeout: 30000,
    });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout.replace(/^\uFEFF/u, ""));
    assert.equal(report.serviceName, "self-test only");
    assert.ok(report.processId > 0);
    assert.equal(path.basename(report.imagePath).toLowerCase(), engine);
    assert.ok(Date.parse(report.createdUtc) > 0);
    for (const field of ["processOwnerSid", "tokenUserSid", "tokenDefaultOwnerSid", "tokenObjectOwnerSid"]) {
      assert.match(report[field], /^S-1-\d+-\d+/u, field);
    }
    assert.deepEqual(report.errors, []);
    assert.ok(Array.isArray(report.tokenLogonGroups));
    for (const group of report.tokenLogonGroups) {
      assert.match(group.sid, /^S-1-5-5-\d+-\d+$/u);
      assert.equal((group.attributes & 0xc0000000) >>> 0, 0xc0000000);
    }
    // WindowsIdentity.Groups deliberately excludes logon SIDs. Compare the
    // native observation with Windows' dedicated logon-ID command instead.
    const logon = spawnSync(path.join(process.env.SystemRoot, "System32", "whoami.exe"), ["/logonid"], {
      encoding: "utf8", timeout: 10000,
    });
    assert.equal(logon.status, 0, logon.stderr);
    const expectedLogon = logon.stdout.match(/S-1-5-5-\d+-\d+/u)?.[0];
    assert.ok(expectedLogon, "whoami returned the inherited logon SID");
    assert.deepEqual(report.tokenLogonGroups.map((group) => group.sid), [expectedLogon]);
  });

  test(`${engine}: -StartOnce refuses a different host before any start`, {
    skip: process.platform !== "win32" || process.env.COMPUTERNAME === "GOATBOX",
  }, () => {
    const result = spawnSync(engine, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", script, "-StartOnce"], {
      encoding: "utf8", timeout: 15000,
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Run this diagnostic on GOATBOX only/u);
    assert.doesNotMatch(result.stdout, /Starting the verified broker/u);
  });
}
