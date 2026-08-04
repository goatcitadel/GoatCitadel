import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "release-installers.yml"), "utf8");
const smokeScript = fs.readFileSync(path.join(repoRoot, "scripts", "packaging", "smoke-windows-installer.ps1"), "utf8");
const nativeMainWindow = fs.readFileSync(
  path.join(repoRoot, "apps", "mission-control-windows", "MainWindow.xaml.cs"),
  "utf8",
);
const launcher = fs.readFileSync(path.join(repoRoot, "bin", "goatcitadel.mjs"), "utf8");

function jobBody(name, nextName) {
  const match = workflow.match(new RegExp(`\\n  ${name}:\\n([\\s\\S]*?)(?=\\n  ${nextName}:\\n)`));
  assert.ok(match, `expected workflow job ${name} before ${nextName}`);
  return match[1];
}

test("manual unsigned and tagged signed Windows jobs call one shared lifecycle smoke", () => {
  const unsignedJob = jobBody("windows-build-inputs", "windows-component-sign");
  const signedJob = jobBody("windows", "linux");

  assert.match(
    unsignedJob,
    /Smoke install unsigned Windows installer[\s\S]*?smoke-windows-installer\.ps1[\s\S]*?-ExpectedReleaseManifestPath "artifacts\/installers\/bundles\/GoatCitadel-\$packageVersion-\$\{\{ matrix\.target \}\}\/app\/release-manifest\.json"[\s\S]*?-TrustMode unsigned/,
  );
  assert.ok(
    unsignedJob.indexOf("-TrustMode unsigned") < unsignedJob.indexOf("Upload unsigned Windows convenience artifact"),
    "unsigned lifecycle smoke must pass before artifact upload",
  );
  assert.match(
    signedJob,
    /Admit exact signed Windows release input[\s\S]*?Smoke install signed Windows installer[\s\S]*?smoke-windows-installer\.ps1[\s\S]*?-ExpectedReleaseManifestPath "artifacts\/installers\/windows\/app\/release-manifest\.json"[\s\S]*?-TrustMode signed/,
  );
  assert.ok(
    signedJob.indexOf("Checkout installer smoke owner") < signedJob.indexOf("Smoke install signed Windows installer"),
    "signed job must check out the shared smoke owner before invoking it",
  );
  assert.ok(
    signedJob.indexOf("-TrustMode signed") < signedJob.indexOf("Write SHA-256 checksum"),
    "signed lifecycle smoke must remain a release-asset gate",
  );
  const unsignedSmokeStep = unsignedJob.match(
    /Smoke install unsigned Windows installer[\s\S]*?(?=\n      - name: Upload unsigned Windows convenience artifact)/,
  )?.[0];
  assert.ok(unsignedSmokeStep, "expected a bounded unsigned installer smoke step");
  assert.doesNotMatch(unsignedSmokeStep, /Start-Process -FilePath \$installer -ArgumentList/);
  assert.doesNotMatch(signedJob, /Start-Process -FilePath \$installer -ArgumentList/);
  assert.equal((workflow.match(/smoke-windows-installer\.ps1/g) ?? []).length, 2);
  assert.match(unsignedJob, /target: windows-x64[\s\S]*?target: windows-arm64/);
  assert.match(signedJob, /target: windows-x64[\s\S]*?target: windows-arm64/);
});

test("shared installer smoke keeps signed identity and signature checks fail closed", () => {
  assert.match(smokeScript, /ValidateSet\("signed", "unsigned"\)/);
  assert.match(smokeScript, /Get-AuthenticodeSignature -LiteralPath \$installer/);
  assert.match(
    smokeScript,
    /\$signedMode -and \$installerSignature\.Status -ne "Valid"[\s\S]*?Signed installer smoke requires a valid Authenticode signature/,
  );
  assert.match(smokeScript, /Get-AuthenticodeSignature -LiteralPath \$identityPackage/);
  assert.match(smokeScript, /Get-AuthenticodeSignature -LiteralPath \$desktop/);
  assert.match(
    smokeScript,
    /\$signedMode -and \$identitySignature\.Status -ne "Valid"[\s\S]*?Signed installer smoke requires a valid installed identity signature/,
  );
  assert.match(
    smokeScript,
    /elseif \(\$signedMode\) \{[\s\S]*?Signed installer smoke requires the installed package identity/,
  );
  assert.match(smokeScript, /GoatCitadel package identity was not registered/);
  assert.match(smokeScript, /Registered package identity does not match its installed manifest identity/);
  assert.match(smokeScript, /Registered package identity is not bound to the installed desktop executable path/);
  assert.match(smokeScript, /does not expose the exact goatcitadel protocol through external content/);
  assert.match(smokeScript, /Installed desktop and installer signatures do not have the same signer/);
  assert.match(smokeScript, /Installed identity and installer signatures do not have the same signer/);
  assert.match(smokeScript, /Registered package publisher does not match the installed identity signer subject/);
  assert.match(smokeScript, /Installed release manifest does not match the detached release manifest bytes/);
  assert.match(smokeScript, /release manifest target, architecture, commit, version, or clean-source truth is invalid/);
  assert.match(smokeScript, /& \$payloadValidatorPath[\s\S]*?-StageRoot \$installDir[\s\S]*?-InstalledRoot/);
});

test("unsigned trust mode permits omitted or unsigned identity without weakening lifecycle checks", () => {
  assert.match(smokeScript, /Unsigned installer omitted the optional package identity, as permitted/);
  assert.match(
    smokeScript,
    /Unsigned installer carried an unregistered identity package with Authenticode status[\s\S]*?registration is optional in unsigned smoke mode/,
  );
  assert.match(smokeScript, /Desktop host did not present a top-level window within 40s/);
  assert.match(smokeScript, /expected 'GoatCitadel Mission Control'/);
  assert.match(smokeScript, /embedded Mission Control target remained blank/);
  assert.match(smokeScript, /WebView navigated to/);
  assert.match(smokeScript, /\$expectedWebViewPath = "\/settings\/onboarding"/);
  assert.match(smokeScript, /GoatCitadel Start Here/);
  assert.match(smokeScript, /did not place Gateway and Mission Control logs under the isolated runtime home/);
  assert.match(
    smokeScript,
    /\$nativeRuntimeEvidence = @\([\s\S]*?gateway\.stdout\.log[\s\S]*?mission-control\.stdout\.log[\s\S]*?\| Where-Object[\s\S]*?\)\s*if \(\$nativeRuntimeEvidence\.Count -ne 2\)/,
  );
  assert.match(smokeScript, /wrote mutable runtime logs under the immutable install root/);
  assert.match(smokeScript, /WaitForExit\(600000\)/);
  assert.match(
    smokeScript,
    /\$launchStartInfo = \[System\.Diagnostics\.ProcessStartInfo\]::new\(\)[\s\S]*?RedirectStandardOutput = \$true[\s\S]*?RedirectStandardError = \$true[\s\S]*?\$launch = \[System\.Diagnostics\.Process\]::new\(\)/,
  );
  assert.match(smokeScript, /ReadToEndAsync\(\)[\s\S]*?WaitForExit\(600000\)[\s\S]*?\$launch\.WaitForExit\(\)/);
  assert.match(smokeScript, /WriteAllText\(\$launchStdout, \$launchStdoutTask\.Result/);
  assert.match(smokeScript, /WriteAllText\(\$launchStderr, \$launchStderrTask\.Result/);
  assert.match(smokeScript, /if \(\$launchExitCode -ne 0\)/);
  assert.match(
    smokeScript,
    /\$runtimeStatus\.status -ne "ready"[\s\S]*?\$runtimeStatus\.readiness\.gateway[\s\S]*?\$runtimeStatus\.readiness\.ui/,
  );
  assert.match(smokeScript, /GoatCitadel package identity remained registered after uninstall/);
  assert.match(smokeScript, /foreach \(\$payloadEntry in @\("app", "bin"\)\)/);
});

test("native host navigates the initialized WebView controller and smoke rejects a blank embedded page", () => {
  assert.equal((nativeMainWindow.match(/MissionWebView\.CoreWebView2\.Navigate\(uri\.AbsoluteUri\)/g) ?? []).length, 2);
  assert.doesNotMatch(nativeMainWindow, /MissionWebView\.Source\s*=/);
  assert.match(smokeScript, /WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/);
  assert.match(smokeScript, /json\/list/);
  assert.match(smokeScript, /embedded Mission Control target remained blank/);
  assert.match(
    smokeScript,
    /if \(-not \$hostProc\.HasExited\) \{[\s\S]*?taskkill\.exe \/PID \$hostProc\.Id \/T \/F 2>\$null[\s\S]*?Get-CimInstance Win32_Process/,
  );
});

test("packaged status accepts the Gateway tokenless SSE success contract", () => {
  assert.match(launcher, /response\.ok && payload\?\.authMode === "none"/);
  assert.match(launcher, /scope: payload\.scope \|\| "events:stream",\s*authMode: "none"/);
  assert.match(launcher, /Compatibility with older Gateways/);
});

test("shared installer smoke bounds destructive cleanup to its validated scratch child", () => {
  assert.match(smokeScript, /ValidateSet\("windows-x64", "windows-arm64"\)/);
  assert.match(smokeScript, /Refusing to smoke an installer outside the scratch root/);
  assert.match(smokeScript, /Refusing to overwrite an existing installer smoke directory/);
  assert.match(smokeScript, /try \{[\s\S]*?finally \{/);
  assert.match(smokeScript, /function Stop-InstalledProcesses/);
  assert.match(smokeScript, /Remove-Item -LiteralPath \$smokeRoot -Recurse -Force -ErrorAction Stop/);
  assert.doesNotMatch(smokeScript, /Remove-Item[^\n]*(?:\$env:RUNNER_TEMP|\$ScratchRoot)/);
  assert.match(smokeScript, /\[REDACTED\]/);
  assert.match(smokeScript, /Refusing to overwrite an existing goatcitadel protocol registration/);
  assert.match(smokeScript, /Refusing to replace an existing GoatCitadel package identity/);
  assert.match(smokeScript, /StartsWith\(\$installPrefix/);
  assert.match(smokeScript, /Installed process teardown did not complete within 15 seconds/);
  assert.doesNotMatch(smokeScript, /CommandLine -match "goatcitadel"/);
});

test("desktop launch and cleanup are pinned to an isolated runtime before host startup", () => {
  const homeAssignment = smokeScript.indexOf("$env:GOATCITADEL_HOME = $runtimeBase");
  const appAssignment = smokeScript.indexOf("$env:GOATCITADEL_APP_DIR = $appHome");
  const webViewAssignment = smokeScript.indexOf("$env:WEBVIEW2_USER_DATA_FOLDER = $webViewDataDir");
  const webViewDebugAssignment = smokeScript.indexOf(
    '$env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$webViewDebugPort"',
  );
  const launcherClear = smokeScript.indexOf("Remove-Item Env:GOATCITADEL_DESKTOP_LAUNCHER");
  const gatewayClear = smokeScript.indexOf("Remove-Item Env:GOATCITADEL_GATEWAY_URL");
  const uiClear = smokeScript.indexOf("Remove-Item Env:GOATCITADEL_MISSION_CONTROL_URL");
  const hostLaunch = smokeScript.indexOf("$hostProc = Start-Process -FilePath $desktop");

  assert.ok(homeAssignment >= 0 && homeAssignment < hostLaunch);
  assert.ok(appAssignment >= 0 && appAssignment < hostLaunch);
  assert.ok(webViewAssignment >= 0 && webViewAssignment < hostLaunch);
  assert.ok(webViewDebugAssignment >= 0 && webViewDebugAssignment < hostLaunch);
  assert.ok(launcherClear >= 0 && launcherClear < hostLaunch);
  assert.ok(gatewayClear >= 0 && gatewayClear < hostLaunch);
  assert.ok(uiClear >= 0 && uiClear < hostLaunch);
  assert.match(
    smokeScript,
    /if \(\$runtimeIsolationConfigured -and[\s\S]*?\$bundledNode[\s\S]*?\$launcher[\s\S]*?stop --json/,
  );
  assert.match(smokeScript, /Remove-Item Env:WEBVIEW2_USER_DATA_FOLDER/);
  assert.match(smokeScript, /Remove-Item Env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS/);
  assert.match(smokeScript, /\$env:GOATCITADEL_DESKTOP_LAUNCHER = \$previousDesktopLauncher/);
  assert.match(smokeScript, /\$env:GOATCITADEL_GATEWAY_URL = \$previousGatewayUrl/);
  assert.match(smokeScript, /\$env:GOATCITADEL_MISSION_CONTROL_URL = \$previousMissionControlUrl/);
});

test("installer lifecycle binds and removes the exact protocol handler", () => {
  assert.match(smokeScript, /Software\\Classes\\goatcitadel/);
  assert.match(smokeScript, /GetValueNames\(\) -contains "URL Protocol"/);
  assert.match(smokeScript, /\$expectedProtocolCommand = '\"\{0\}\" \"%1\"' -f \$desktop/);
  assert.match(smokeScript, /protocol command is not bound to the exact installed desktop executable/);
  assert.match(smokeScript, /goatcitadel protocol registration remained after uninstall/);
});

test("installer and bundled launcher preserve scratch paths containing spaces", () => {
  assert.match(smokeScript, /"\/DIR=`\"\$installDir`\""/);
  assert.match(smokeScript, /\$quotedLauncher = '\"' \+ \$launcher \+ '\"'/);
  assert.match(smokeScript, /Arguments = "\$quotedLauncher launch --no-open --wait --json"/);
  assert.match(smokeScript, /ArgumentList @\(\$quotedLauncher, "status"/);
});

test("failure cleanup verifies owned registrations before deleting recovery payload", () => {
  assert.match(
    smokeScript,
    /if \(-not \(Test-Path -LiteralPath \$uninstaller -PathType Leaf\)\) \{[\s\S]*?did not provide an uninstaller[\s\S]*?if \(\$uninstall\.ExitCode -ne 0\)[\s\S]*?\$uninstalled = \$true/,
  );
  assert.match(smokeScript, /Remove-AppxPackage -Package \$candidateIdentity\.PackageFullName -ErrorAction Stop/);
  assert.match(
    smokeScript,
    /\[string\]::Equals\(\$cleanupProtocolCommand, \$expectedProtocolCommand[\s\S]*?Remove-Item -LiteralPath \$protocolRegistryPath/,
  );
  assert.match(
    smokeScript,
    /if \(\$null -eq \$primaryFailure -and[\s\S]*?\$cleanupFailures\.Count -eq 0 -and[\s\S]*?Test-Path -LiteralPath \$smokeRoot[\s\S]*?Remove-Item -LiteralPath \$smokeRoot -Recurse -Force -ErrorAction Stop/,
  );
  assert.match(smokeScript, /Installer smoke scratch root remained after cleanup/);
  assert.match(smokeScript, /Preserving installer smoke recovery payload/);
  assert.match(smokeScript, /Installer smoke cleanup failed:/);
  assert.match(smokeScript, /Installer smoke failed: \$primaryFailure/);
  assert.match(smokeScript, /Cleanup also failed:/);
});
