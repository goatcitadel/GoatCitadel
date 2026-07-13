import assert from "node:assert/strict";
import test from "node:test";
import { renderIss } from "./build-windows-native-installer.mjs";

function renderSample() {
  return renderIss({
    target: "windows-x64",
    architecture: "x64compatible",
    version: "1.0.0",
    bundleZipPath: "C:\\out\\GoatCitadel-windows-x64.zip",
    outDir: "C:\\out",
  });
}

test("uninstaller payload deletes are guarded by the install marker", () => {
  const iss = renderSample();

  // The destructive long-path PowerShell delete must only run when our marker is present.
  // (Rendered ISS uses single backslashes: \\?\{app}\app .)
  assert.match(
    iss,
    /Remove-Item -LiteralPath '\\\\\?\\\{app\}\\app'[\s\S]*?Check: GoatCitadelInstallMarkerExists/,
  );

  // The marker-guard helpers and code-driven payload removal must be present.
  assert.match(iss, /function GoatCitadelInstallMarkerExists\(\): Boolean;/);
  assert.match(iss, /procedure RemoveGoatCitadelPayload\(\);/);
  assert.match(iss, /if not GoatCitadelInstallMarkerExists\(\) then/);
  assert.match(iss, /WriteGoatCitadelInstallMarker\(\);/);
});

test("unconditional app/bin filesandordirs deletes are removed", () => {
  const iss = renderSample();

  // No [InstallDelete] section should force-clear {app}\app or {app}\bin unconditionally.
  assert.doesNotMatch(iss, /\[InstallDelete\]/);

  // [UninstallDelete] must not contain unconditional filesandordirs removal of the payload trees;
  // only the safe dirifempty cleanups remain.
  assert.doesNotMatch(iss, /Type: filesandordirs; Name: "\{app\}\\app"/);
  assert.doesNotMatch(iss, /Type: filesandordirs; Name: "\{app\}\\bin"/);
  assert.match(iss, /Type: dirifempty; Name: "\{app\}\\app"/);
  assert.match(iss, /Type: dirifempty; Name: "\{app\}"/);
});

test("installer updates stop the packaged runtime before replacing the payload", () => {
  const iss = renderSample();

  assert.match(iss, /procedure StopExistingGoatCitadelRuntime\(\);/);
  assert.match(iss, /goatcitadel\.cmd'' stop --json/);
  assert.match(
    iss,
    /if CurStep = ssInstall then[\s\S]*?StopExistingGoatCitadelRuntime\(\);[\s\S]*?StopExistingGoatCitadelPayloadProcesses\(\);[\s\S]*?RemoveGoatCitadelPayload\(\);/,
  );
});

test("installer updates close the running desktop host without double-restarting it", () => {
  const iss = renderSample();

  assert.match(iss, /CloseApplications=force/);
  assert.match(iss, /RestartApplications=no/);
  assert.match(iss, /procedure RegisterExtraCloseApplicationsResources;/);
  assert.ok(
    iss.includes("RegisterExtraCloseApplicationsResource(False, ExpandConstant('{app}\\{#MyDesktopExe}'));"),
  );
  assert.match(iss, /Flags: nowait postinstall skipifsilent/);
  assert.match(iss, /procedure StopExistingGoatCitadelPayloadProcesses\(\);/);
  assert.match(iss, /param\(\$payloadRoot\)/);
  assert.match(iss, /ExecutablePath\.StartsWith\(\$payloadRoot, \[System\.StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(iss, /Stop-Process -Id \$_\.ProcessId -Force/);
  assert.match(iss, /Sleep\(1500\);/);
});

test("installer updates fail closed when the previous payload remains locked", () => {
  const iss = renderSample();

  assert.match(iss, /if DirExists\(AppPayloadPath\) or DirExists\(BinPayloadPath\) then/);
  assert.match(iss, /Removing the previous GoatCitadel payload/);
  assert.match(iss, /Remove-Item[\s\S]*?exit 0/);
  assert.match(iss, /The previous GoatCitadel payload is still in use\. Close GoatCitadel and retry the update\./);
});

test("uninstall stops the packaged runtime before removing its payload", () => {
  const iss = renderSample();

  assert.match(
    iss,
    /if CurUninstallStep = usUninstall then[\s\S]*?StopExistingGoatCitadelRuntime\(\);[\s\S]*?StopExistingGoatCitadelPayloadProcesses\(\);[\s\S]*?RemoveGoatCitadelPayload\(\);/,
  );
});
