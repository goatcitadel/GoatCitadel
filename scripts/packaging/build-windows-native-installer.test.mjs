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
