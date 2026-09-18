import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = fs.readFileSync(new URL("./recover-orphaned-broker-services.ps1", import.meta.url), "utf8");
const native = source.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/u)?.[1];
assert.ok(native);
for (const engine of ["powershell.exe", "pwsh.exe"]) {
  test(`${engine}: recovery compiles and refuses changed service identity without service mutations`, () => {
    const script = `$source = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(source).toString("base64")}'))
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
if($errors.Count) { throw 'Recovery script parse failed' }
Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(native).toString("base64")}')))
$definition=$ast.Find({param($n) $n -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Assert-Orphan'},$false)
. ([scriptblock]::Create($definition.Extent.Text))
Add-Type @'
public static class RecoveryFixture {
 public static string Config, Status, Sddl;
 public static string GetServiceConfigLine(string name) { return Config; }
 public static string GetServiceStatusLine(string name) { return Status; }
 public static string GetServiceSddl(string name) { return Sddl; }
}
'@
$native=[RecoveryFixture]
function ConvertTo-CanonicalSddl([string]$Sddl) { ([Security.AccessControl.RawSecurityDescriptor]::new($Sddl)).GetSddlForm([Security.AccessControl.AccessControlSections]::All) }
$root=Join-Path ([IO.Path]::GetTempPath()) ('absent-recovery-'+[guid]::NewGuid().ToString('N'))
$names=@('GoatCitadelRemoteWorkerProvisioner')
$name=$names[0]; $expected='O:SYD:P(A;;0xf01ff;;;SY)(A;;0x20035;;;BA)'
$good='16|3|1|"'+$root+'\\bin\\'+$name+'.exe"|LocalSystem||1'
$native::Config=$good; $native::Status='1|0|0|16|0|0|0|0'; $native::Sddl=$expected
Assert-Orphan $name $expected
foreach($kind in @('path','start','state','pid','acl','unknown')) {
 $native::Config=$good; $native::Status='1|0|0|16|0|0|0|0'; $native::Sddl=$expected; $probe=$name
 switch($kind) {
 'path' {$native::Config=$good.Replace('.exe','.other')}
 'start' {$native::Config=$good.Replace('16|3|','16|2|')}
 'state' {$native::Status='4|0|0|16|0|0|0|0'}
 'pid' {$native::Status='1|123|0|16|0|0|0|0'}
 'acl' {$native::Sddl=$expected.Replace('0x20035','0x120035')}
 'unknown' {$probe='UnrelatedService'}
 }
 $refused=$false; try { Assert-Orphan $probe $expected } catch { $refused=$true }
 if(-not $refused) { throw ('Recovery accepted '+$kind) }
}
'PASS: compile, exact stopped identity, six refusals; no service mutations'
`;
    const scriptPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "broker-recovery-test-")), "fixture.ps1");
    fs.writeFileSync(scriptPath, "$ErrorActionPreference='Stop'\n" + script);
    const result = spawnSync(engine, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", scriptPath], { encoding: "utf8", timeout: 30000 });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.match(result.stdout, /PASS: compile/u);
  });
}
