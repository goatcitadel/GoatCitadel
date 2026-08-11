import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const wrapper = fs.readFileSync(path.join(repoRoot, "scripts", "install-smoke", "run-clean-host-smoke.ps1"), "utf8");
const runbook = fs.readFileSync(path.join(repoRoot, "scripts", "install-smoke", "README.md"), "utf8");

test("preflight is read-only, covers every identity signal, and refuses before any lifecycle work", () => {
  assert.match(wrapper, /HKEY_CURRENT_USER\\Software\\Classes\\goatcitadel/);
  assert.match(wrapper, /HKEY_LOCAL_MACHINE\\Software\\Classes\\goatcitadel/);
  assert.match(wrapper, /HKEY_CLASSES_ROOT\\goatcitadel/);
  assert.match(wrapper, /GoatCitadel\.MissionControl\.Windows/);
  assert.match(wrapper, /com\.goatcitadel\.installer\./);
  assert.match(wrapper, /Join-Path \$env:LOCALAPPDATA "GoatCitadel"/);
  assert.match(wrapper, /Join-Path \$env:USERPROFILE "\.GoatCitadel"/);
  assert.match(wrapper, /\.goatcitadel-install/);
  assert.match(wrapper, /GetEnvironmentVariable\("GOATCITADEL_HOME", \$scope\)/);
  assert.match(wrapper, /@\("Process", "User", "Machine"\)/);
  assert.match(wrapper, /Get-CimInstance Win32_Process/);
  assert.match(wrapper, /WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall/);

  const preflight = wrapper.indexOf("Get-GoatCitadelIdentityFindings");
  const refusal = wrapper.indexOf('Write-SmokeVerdict -Verdict "refused"');
  const sharedSmoke = wrapper.indexOf("Invoke-SharedLifecyclePass -PassName");
  const extendedInstall = wrapper.indexOf('"extended-install"');
  assert.ok(preflight >= 0 && refusal >= 0 && sharedSmoke >= 0 && extendedInstall >= 0);
  assert.ok(refusal < sharedSmoke, "preflight refusal must be decided before any shared lifecycle pass");
  assert.ok(sharedSmoke < extendedInstall, "shared lifecycle passes must run before the wrapper-owned install");
  assert.match(wrapper, /Nothing was modified/);
  assert.match(wrapper, /\n\s*exit 2\r?\n/);
  assert.match(wrapper, /READ-ONLY: every check below only queries registry, filesystem, package, and/);
  assert.match(wrapper, /\$PreflightOnly/);
});

test("both lifecycle passes delegate to the shared installer smoke instead of duplicating it", () => {
  assert.match(wrapper, /smoke-windows-installer\.ps1/);
  assert.match(wrapper, /validate-windows-bundle\.ps1/);
  assert.match(wrapper, /Invoke-SharedLifecyclePass -PassName "pass1"/);
  assert.match(wrapper, /Invoke-SharedLifecyclePass -PassName "pass2"/);
  assert.match(wrapper, /"lifecycle-pass-2-reinstall"/);
  assert.match(
    wrapper,
    /-InstallerPath "\{1\}" -ExpectedReleaseManifestPath "\{2\}" -Target \{3\} -TrustMode \{4\} -ScratchRoot "\{5\}"/,
  );
  assert.doesNotMatch(
    wrapper.slice(0, wrapper.indexOf('"extended-install"')),
    /Start-Process -FilePath \$script:ResolvedInstallerPath/,
    "the wrapper must not run the installer itself before the shared passes",
  );
});

test("extended journeys cover reinstall registration, restart, and single-instance", () => {
  assert.match(wrapper, /"\/DIR=`"\$\(\$script:ExtendedInstallDir\)`""/);
  assert.match(wrapper, /Extended install did not register the goatcitadel protocol command/);
  assert.match(wrapper, /'"\{0\}" "%1"' -f \$script:ExtendedDesktopExe/);
  assert.match(wrapper, /Extended install did not register an uninstall entry/);

  assert.match(wrapper, /launch --no-open --wait --json/);
  assert.match(wrapper, /status --json/);
  assert.match(wrapper, /stop --json/);
  const firstLaunch = wrapper.indexOf('"extended-launch-1"');
  const stop = wrapper.indexOf('"extended-stop-1"');
  const secondLaunch = wrapper.indexOf('"extended-launch-2"');
  assert.ok(firstLaunch >= 0 && stop > firstLaunch && secondLaunch > stop, "restart journey must be ready -> stopped -> ready");
  assert.match(wrapper, /-ExpectedState "ready"/);
  assert.match(wrapper, /-ExpectedState "stopped"/);
  assert.match(wrapper, /\$StatusResult\.readiness\.gateway -and \$StatusResult\.readiness\.ui/);

  assert.match(wrapper, /Second desktop instance did not exit within 45s; single-instance activation redirect failed/);
  assert.match(wrapper, /expected a clean single-instance redirect exit/);
  assert.match(wrapper, /Primary desktop instance exited during the single-instance redirect/);
  assert.match(wrapper, /Expected exactly one desktop host process after the redirect/);
});

test("teardown, uninstall, and deregistration are bounded and fail closed", () => {
  assert.match(wrapper, /taskkill\.exe \/PID \$ProcessId \/T \/F/);
  assert.match(wrapper, /Extended install process teardown did not complete within 20 seconds/);
  assert.match(wrapper, /\/VERYSILENT/);
  assert.match(wrapper, /goatcitadel protocol registration remained after the extended uninstall/);
  assert.match(wrapper, /package identity remained registered after the extended uninstall/);
  assert.match(wrapper, /uninstall entries remained after the extended uninstall/);
  assert.match(wrapper, /foreach \(\$payloadEntry in @\("app", "bin"\)\)/);
  assert.match(wrapper, /Mutable state preserved by uninstall \(expected\)/);
  assert.match(wrapper, /Refused to remove a goatcitadel protocol registration not bound to the extended smoke install/);
  assert.match(
    wrapper,
    /\[string\]::Equals\(\$boundCommand, \$script:ExtendedProtocolCommand, \[System\.StringComparison\]::OrdinalIgnoreCase\)/,
  );
});

test("evidence bundle is machine-readable, complete, and never deleted", () => {
  assert.match(wrapper, /clean-host-smoke-verdict\.json/);
  assert.match(wrapper, /goatcitadel\.clean-host-installer-smoke\/1/);
  assert.match(wrapper, /ConvertTo-Json -InputObject \$payload -Depth 8/);
  assert.match(wrapper, /Get-FileHash -LiteralPath \$script:ResolvedInstallerPath -Algorithm SHA256/);
  assert.match(wrapper, /Refusing to reuse an existing evidence output root/);
  assert.match(wrapper, /steps = \$script:Steps\.ToArray\(\)/);
  assert.match(wrapper, /cleanupFailures = \$script:CleanupFailures\.ToArray\(\)/);
  assert.doesNotMatch(wrapper, /Remove-Item[^\n]*\$script:ResolvedOutputRoot/);
  assert.doesNotMatch(wrapper, /Remove-Item[^\n]*\$OutputRoot/);
  assert.match(wrapper, /Start-Transcript/);
});

test("wrapper stays Windows PowerShell 5.1 compatible", () => {
  assert.match(wrapper, /^#Requires -Version 5\.1/);
  assert.doesNotMatch(wrapper, /\?\?/, "null-coalescing is PowerShell 7 only");
  assert.doesNotMatch(wrapper, /\$\w+\?\./, "null-conditional member access is PowerShell 7 only");
  assert.doesNotMatch(wrapper, /&&|\|\|/, "pipeline chain operators are PowerShell 7 only");
});

test("runbook documents the one command, the copy set, the verdict, and the clean-host hold", () => {
  assert.match(runbook, /run-clean-host-smoke\.ps1/);
  assert.match(runbook, /-InstallerPath/);
  assert.match(runbook, /-ReleaseManifestPath/);
  assert.match(runbook, /-Target windows-x64/);
  assert.match(runbook, /-PreflightOnly/);
  assert.match(runbook, /scripts\/packaging\/smoke-windows-installer\.ps1/);
  assert.match(runbook, /scripts\/packaging\/validate-windows-bundle\.ps1/);
  assert.match(runbook, /release-manifest\.json/);
  assert.match(runbook, /clean-host-smoke-verdict\.json/);
  assert.match(runbook, /`0` = passed, `1` = failed, `2` = preflight refused/);
  assert.match(runbook, /HOLD: the actual clean-VM execution/);
  assert.match(runbook, /GC-P1-09/);
  assert.match(runbook, /M9/);
});
