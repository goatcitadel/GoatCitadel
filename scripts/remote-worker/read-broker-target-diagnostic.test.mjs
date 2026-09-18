import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("./read-broker-target-diagnostic.ps1", import.meta.url));
const source = fs.readFileSync(script, "utf8");

test("target observation holds exact images and has one fixed broker start without installation or custody authority", () => {
  assert.doesNotMatch(source, /\b(?:SetKernelObjectSecurity|SetSecurityInfo|SetServiceObjectSecurity|SetTokenInformation|AdjustTokenPrivileges|WriteProcessMemory|ReadProcessMemory|CreateRemoteThread|TerminateProcess|CreateServiceW|DeleteService|ChangeServiceConfigW|ControlService|Format-Volume|Clear-Disk|Initialize-Disk|Remove-Item)\b/u);
  assert.equal(source.match(/result\.startReturnedSuccess = StartServiceW\(services\[1\], 0, IntPtr\.Zero\)/gu)?.length, 1);
  assert.ok(source.indexOf("if (!startOnce) return result;") < source.indexOf("result.startReturnedSuccess = StartServiceW"));
  assert.match(source, /AssertInitialConfig\(services\[i\], Names\[i\]\)/u);
  assert.match(source, /FileAccess\.Read, FileShare\.Read/u);
  assert.match(source, /GetFinalPathNameByHandleW\(file\.SafeFileHandle/u);
  assert.match(source, /index == 1 \|\| status.state == 4/u);
  assert.match(source, /history.Count < 64/u);
  assert.match(source, /pollCounts\[index\] >= 5000/u);
  assert.match(source, /timer.ElapsedMilliseconds < 12000/u);
  assert.match(source, /query results do not prove access from the broker token/u);
  assert.doesNotMatch(source, /state-v1|keysets|journal|quarantine/u);
});

for (const engine of ["powershell.exe", "pwsh.exe"]) {
  const run = (...args) => spawnSync(engine, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", ...args], {
    encoding: "utf8", timeout: 30000, windowsHide: true,
  });
  test(`${engine}: actual process and token queries work without starting a service`, { skip: process.platform !== "win32" }, () => {
    const result = run("-File", script, "-SelfTest");
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const report = JSON.parse(result.stdout.replace(/^\uFEFF/u, ""));
    assert.equal(report.serviceName, "self-test only");
    assert.equal(path.basename(report.imagePath).toLowerCase(), engine);
    assert.ok(report.processId > 0 && Date.parse(report.createdUtc) > 0);
    assert.equal(report.processQueryAndSynchronize, true);
    assert.equal(report.aliveBefore, true);
    assert.equal(report.aliveAfter, true);
    assert.equal(report.tokenQuery, true);
    assert.equal(report.tokenType, 1);
    assert.equal(report.tokenSession, report.sessionId);
    assert.equal(report.tokenAppContainer, 0);
    assert.equal(typeof report.tokenRestricted, "boolean");
    assert.equal(typeof report.tokenMatchesSignerContract, "boolean");
    assert.match(report.processSddl, /^O:S-[\s\S]+D:/u);
    assert.match(report.tokenSddl, /^O:[\s\S]+D:/u);
    assert.ok(report.tokenPrivileges.some((privilege) => privilege.isChangeNotify));
    assert.deepEqual(report.errors, []);
  });
  test(`${engine}: status and token diagnostics distinguish refusals and missing evidence`, { skip: process.platform !== "win32" }, () => {
    const result = run("-File", path.join(path.dirname(script), "read-broker-target-diagnostic.behavior.test.ps1"));
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout.replace(/^\uFEFF/u, "")), { passed: true, checks: 28 });
  });
  test(`${engine}: a different host is refused before any service access`, {
    skip: process.platform !== "win32" || process.env.COMPUTERNAME === "GOATBOX",
  }, () => {
    const result = run("-File", script, "-StartOnce");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Run this diagnostic on GOATBOX only/u);
    assert.doesNotMatch(result.stdout, /Starting the verified broker/u);
  });
}
