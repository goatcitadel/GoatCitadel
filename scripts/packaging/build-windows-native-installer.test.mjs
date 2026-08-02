import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { renderIss } from "./build-windows-native-installer.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

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
  assert.match(iss, /Remove-Item -LiteralPath '\\\\\?\\\{app\}\\app'[\s\S]*?Check: GoatCitadelInstallMarkerExists/);

  // The marker-guard helpers and code-driven payload removal must be present.
  assert.match(iss, /function GoatCitadelInstallMarkerExists\(\): Boolean;/);
  assert.match(iss, /procedure RemoveGoatCitadelPayload\(\);/);
  assert.match(iss, /if not GoatCitadelInstallMarkerExists\(\) then/);
  assert.match(iss, /WriteGoatCitadelInstallMarker\(\);/);

  const uninstallRun = iss.match(/\[UninstallRun\][\s\S]*?\[UninstallDelete\]/)?.[0] ?? "";
  assert.match(uninstallRun, /RunOnceId: "goatcitadel-remove-identity"/);
  assert.match(uninstallRun, /RunOnceId: "goatcitadel-remove-payload"/);
  assert.match(uninstallRun, /catch \{\{\}; try \{\{[\s\S]*?catch \{\{\};[\s\S]*?exit 0/);
  assert.doesNotMatch(uninstallRun, /catch \{\{\}\}/);
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

test("installer promotes during ssInstall before Inno managed state can commit", () => {
  const iss = renderSample();

  assert.match(iss, /procedure StopExistingGoatCitadelRuntime\(DuringUninstall: Boolean\);/);
  assert.match(iss, /goatcitadel\.cmd'' stop --json/);
  const curSteps = iss.match(/procedure CurStepChanged\(CurStep: TSetupStep\);[\s\S]*?procedure CurUninstallStepChanged/)?.[0] ?? "";
  const postInstallIndex = curSteps.indexOf("if CurStep = ssPostInstall then");
  assert.ok(postInstallIndex > 0);
  const installStep = curSteps.slice(0, postInstallIndex);
  const postInstallStep = curSteps.slice(postInstallIndex);
  const stopRuntimeIndex = installStep.indexOf("StopExistingGoatCitadelRuntime(False);");
  const stopPayloadIndex = installStep.indexOf("StopExistingGoatCitadelPayloadProcesses(False);");
  const promoteIndex = installStep.indexOf("PromoteStagedGoatCitadelPayload();");
  const chromiumIndex = installStep.indexOf("InstallChromiumRuntime();");
  const voiceIndex = installStep.indexOf("InstallVoiceRuntime();");
  assert.ok(stopRuntimeIndex >= 0 && stopRuntimeIndex < stopPayloadIndex);
  assert.ok(stopPayloadIndex < promoteIndex);
  assert.ok(promoteIndex < chromiumIndex);
  assert.ok(promoteIndex < voiceIndex);
  assert.doesNotMatch(installStep, /RemoveGoatCitadelPayload\(\)/);
  assert.doesNotMatch(postInstallStep, /PromoteStagedGoatCitadelPayload\(\)/);
  assert.doesNotMatch(postInstallStep, /InstallChromiumRuntime\(\)|InstallVoiceRuntime\(\)/);
  assert.match(installStep, /before Inno begins its managed install transaction/);
  assert.match(installStep, /Selected runtime components are part of install truth/);
  assert.match(iss, /procedure InstallChromiumRuntime\(\);[\s\S]*?RunOrFail\(/);
  assert.match(iss, /procedure InstallVoiceRuntime\(\);[\s\S]*?RunOrFail\(/);
});

test("installer updates close the running desktop host without double-restarting it", () => {
  const iss = renderSample();

  assert.match(iss, /CloseApplications=force/);
  assert.match(iss, /RestartApplications=no/);
  assert.match(iss, /procedure RegisterExtraCloseApplicationsResources;/);
  assert.ok(iss.includes("RegisterExtraCloseApplicationsResource(False, ExpandConstant('{app}\\{#MyDesktopExe}'));"));
  assert.match(iss, /Flags: nowait postinstall skipifsilent/);
  assert.match(iss, /procedure StopExistingGoatCitadelPayloadProcesses\(DuringUninstall: Boolean\);/);
  assert.match(iss, /param\(\$payloadRoot\)/);
  assert.match(iss, /ExecutablePath\.StartsWith\(\$payloadRoot, \[System\.StringComparison\]::OrdinalIgnoreCase\)/);
  assert.match(iss, /Stop-Process -Id \$_\.ProcessId -Force/);
  assert.match(iss, /Sleep\(1500\);/);
});

test("installer stages and validates the complete bundle before stopping the working install", () => {
  const iss = renderSample();

  assert.match(iss, /Source: "\{#MyBundleZip\}";[\s\S]*?Flags: dontcopy/);
  assert.match(iss, /Source: "\{#MyPayloadValidator\}";[\s\S]*?Flags: dontcopy/);
  assert.match(
    iss,
    /function PrepareToInstall[\s\S]*?PrepareStagedGoatCitadelPayload\(\);[\s\S]*?could not prepare a validated payload/,
  );
  assert.match(
    iss,
    /procedure PrepareStagedGoatCitadelPayload[\s\S]*?ExtractTemporaryFile\('bundle\.zip'\);[\s\S]*?tar\.exe[\s\S]*?StageAdjacentReleaseEvidence\(StageRoot\);[\s\S]*?ValidateGoatCitadelPayload\(StageRoot, False\);/,
  );
  assert.match(
    iss,
    /procedure PrepareStagedGoatCitadelPayload[\s\S]*?StageCreatedByCurrentSetup := False;[\s\S]*?AssertInstallDestinationSafe\(\);[\s\S]*?WriteTransactionMarker\(StageRoot\);[\s\S]*?StageCreatedByCurrentSetup := True;/,
  );
  assert.match(iss, /Validating the GoatCitadel payload manifest and hashes/);
  assert.match(
    iss,
    /function PrepareToInstall[\s\S]*?if StageCreatedByCurrentSetup then[\s\S]*?RemoveOwnedTransactionDirectory\([\s\S]*?Cleaning failed GoatCitadel installer staging/,
  );
  const prepareToInstall = iss.match(/function PrepareToInstall[\s\S]*?procedure RegisterGoatCitadelIdentity/)?.[0] ?? "";
  const failureIndex = prepareToInstall.indexOf("FailureMessage := GetExceptionMessage();");
  const ownershipGuardIndex = prepareToInstall.indexOf("if StageCreatedByCurrentSetup then");
  const cleanupIndex = prepareToInstall.indexOf("RemoveOwnedTransactionDirectory(");
  assert.ok(failureIndex >= 0 && failureIndex < ownershipGuardIndex);
  assert.ok(ownershipGuardIndex < cleanupIndex);
});

test("installer promotion keeps a same-volume backup until final validation and rolls back failures", () => {
  const iss = renderSample();

  assert.match(iss, /#define MyInstallStageDir "\.goatcitadel-install-stage"/);
  assert.match(iss, /#define MyInstallBackupDir "\.goatcitadel-install-backup"/);
  assert.match(
    iss,
    /procedure PromoteStagedGoatCitadelPayload[\s\S]*?BackupExistingGoatCitadelPayload\(\);[\s\S]*?RenameFile\(AddBackslash\(StageRoot\) \+ 'app', AppPayloadPath\)[\s\S]*?RenameFile\(AddBackslash\(StageRoot\) \+ 'bin', BinPayloadPath\)[\s\S]*?ValidateGoatCitadelPayload\(ExpandConstant\('\{app\}'\), True\)/,
  );
  assert.match(
    iss,
    /ValidateGoatCitadelPayload\(ExpandConstant\('\{app\}'\), True\)[\s\S]*?WriteGoatCitadelInstallMarker\(\);[\s\S]*?except[\s\S]*?RollBackGoatCitadelPayload\(\)/,
  );
  const promotion = iss.match(
    /procedure PromoteStagedGoatCitadelPayload\(\);[\s\S]*?procedure DeinitializeSetup\(\);/,
  )?.[0] ?? "";
  const capturedMarkerIndex = promotion.indexOf("InstallHadMarker := GoatCitadelInstallMarkerExists();");
  const capturedBinPathIndex = promotion.indexOf("BinPayloadPath := ExpandConstant('{app}\\bin');");
  const promotionStartedIndex = promotion.indexOf("InstallPromotionStarted := True;");
  const mutationTryIndex = promotion.indexOf("try", promotionStartedIndex);
  assert.ok(capturedMarkerIndex >= 0 && capturedMarkerIndex < promotionStartedIndex);
  assert.ok(capturedBinPathIndex >= 0 && capturedBinPathIndex < promotionStartedIndex);
  assert.ok(promotionStartedIndex < mutationTryIndex);
  assert.doesNotMatch(
    promotion,
    /InstallCommitted := True|CleanupCommittedInstallTransaction\(\)|InstallChromiumRuntime\(\)|InstallVoiceRuntime\(\)|RegisterGoatCitadelIdentity\(\)/,
  );
  assert.match(iss, /function RollBackGoatCitadelPayload\(\): Boolean;/);
  assert.match(iss, /RemoveDirectoryTree\(AppPayloadPath[\s\S]*?RenameFile\(AddBackslash\(BackupRoot\) \+ 'app', AppPayloadPath\)/);
  assert.match(iss, /The previous GoatCitadel payload was restored\./);
  assert.match(iss, /previous payload remains preserved at[\s\S]*?Do not delete that directory/);
});

test("ssPostInstall commits before best-effort cleanup and identity work", () => {
  const iss = renderSample();
  const curSteps = iss.match(/procedure CurStepChanged\(CurStep: TSetupStep\);[\s\S]*?procedure CurUninstallStepChanged/)?.[0] ?? "";
  const postInstall = curSteps.slice(curSteps.indexOf("if CurStep = ssPostInstall then"));
  const identityIndex = postInstall.indexOf("RegisterGoatCitadelIdentity();");
  const commitIndex = postInstall.indexOf("InstallCommitted := True;");
  const cleanupIndex = postInstall.indexOf("CleanupCommittedInstallTransaction();");
  assert.ok(commitIndex >= 0 && commitIndex < cleanupIndex);
  assert.ok(cleanupIndex < identityIndex);
  assert.doesNotMatch(postInstall, /RunOrFail\(|RaiseException\(|RollBackGoatCitadelPayload\(\)/);
  assert.doesNotMatch(postInstall, /InstallChromiumRuntime\(\)|InstallVoiceRuntime\(\)/);
  assert.match(postInstall, /Inno has committed its managed files, shortcuts, registry, and uninstaller/);
  assert.match(postInstall, /try[\s\S]*?RegisterGoatCitadelIdentity\(\);[\s\S]*?except[\s\S]*?continuing/);

  assert.match(
    iss,
    /procedure CleanupCommittedInstallTransaction\(\);[\s\S]*?try[\s\S]*?GoatCitadelInstallStageRoot\(\)[\s\S]*?except[\s\S]*?marked staging directory[\s\S]*?try[\s\S]*?GoatCitadelInstallBackupRoot\(\)[\s\S]*?except[\s\S]*?marked backup directory/,
  );
});

test("setup exit rolls back promoted payload until ssPostInstall commits", () => {
  const iss = renderSample();

  assert.match(
    iss,
    /procedure DeinitializeSetup\(\);[\s\S]*?InstallPromotionStarted and \(not InstallCommitted\)[\s\S]*?RollBackGoatCitadelPayload\(\)[\s\S]*?Exit;[\s\S]*?StageCreatedByCurrentSetup and \(not InstallPromotionStarted\) and \(not InstallCommitted\)[\s\S]*?GoatCitadelInstallStageRoot\(\)/,
  );
  assert.match(iss, /Inno rolls back its own state[\s\S]*?killed setup process cannot run this hook[\s\S]*?next installer run fails closed/);
  const deinitialize = iss.match(/procedure DeinitializeSetup\(\);[\s\S]*?procedure CurStepChanged/)?.[0] ?? "";
  assert.match(deinitialize, /previous payload[\s\S]*?GoatCitadelInstallBackupRoot\(\)[\s\S]*?must not be deleted/);
});

test("installer updates fail closed when the previous payload cannot be moved into backup", () => {
  const iss = renderSample();

  assert.match(iss, /procedure BackupExistingGoatCitadelPayload\(\);/);
  assert.match(iss, /RenameFile\(AppPayloadPath, AddBackslash\(BackupRoot\) \+ 'app'\)/);
  assert.match(iss, /previous GoatCitadel app payload is still in use\. Close GoatCitadel and retry the update\./);
  assert.match(iss, /if RollBackGoatCitadelPayload\(\) then/);
});

test("uninstall stops the packaged runtime before removing its payload", () => {
  const iss = renderSample();

  assert.match(
    iss,
    /if CurUninstallStep = usUninstall then[\s\S]*?StopExistingGoatCitadelRuntime\(True\);[\s\S]*?StopExistingGoatCitadelPayloadProcesses\(True\);[\s\S]*?RemoveGoatCitadelPayload\(\);/,
  );

  const uninstallHelpers = iss.match(
    /procedure RunUninstallOrFail[\s\S]*?procedure RunUninstallBestEffort[\s\S]*?function GoatCitadelInstallMarkerPath/,
  )?.[0] ?? "";
  assert.match(uninstallHelpers, /UninstallProgressForm\.StatusLabel\.Caption := StatusText/);
  assert.doesNotMatch(uninstallHelpers, /WizardForm/);
  const removePayload = iss.match(/procedure RemoveGoatCitadelPayload\(\);[\s\S]*?procedure WriteTransactionMarker/)?.[0] ?? "";
  assert.match(removePayload, /RunUninstallOrFail\(/);
  assert.doesNotMatch(removePayload, /RunOrFail\(/);
});

test("installer consumes only the exact adjacent release-evidence files", () => {
  const iss = renderSample();

  assert.doesNotMatch(iss, /Source: "\{src\}\\release-evidence/);
  assert.match(iss, /procedure CopyAdjacentReleaseEvidenceIfPresent\(StageRoot: String; FileName: String\);/);
  assert.ok(iss.includes("CopyAdjacentReleaseEvidenceIfPresent(StageRoot, 'release-certificate.json');"));
  assert.ok(iss.includes("CopyAdjacentReleaseEvidenceIfPresent(StageRoot, 'release-certificate.sigstore.json');"));
  assert.match(
    iss,
    /procedure StageAdjacentReleaseEvidence[\s\S]*?FileExists\(TransactionMarkerPath\(StageRoot\)\)[\s\S]*?RemoveDirectoryTree\([\s\S]*?embedded release evidence[\s\S]*?CopyAdjacentReleaseEvidenceIfPresent\(StageRoot, 'release-certificate\.json'\)[\s\S]*?CopyAdjacentReleaseEvidenceIfPresent\(StageRoot, 'release-certificate\.sigstore\.json'\)/,
  );
  assert.match(
    iss,
    /procedure PrepareStagedGoatCitadelPayload[\s\S]*?tar\.exe[\s\S]*?StageAdjacentReleaseEvidence\(StageRoot\);[\s\S]*?ValidateGoatCitadelPayload/,
  );
  assert.doesNotMatch(iss, /release-evidence\\\*/);
  assert.doesNotMatch(iss, /release-evidence\\(?:release-assets|proof-bundle)/);
  assert.doesNotMatch(iss, /recursesubdirs/);
  assert.match(iss, /standalone[\s\S]*installer remains usable but truthfully reports proof unverified/);
});

test(
  "generated transactional installer script passes syntax-only Inno Setup compilation when available",
  { skip: process.platform === "win32" ? false : "Inno Setup compilation requires Windows." },
  (t) => {
    const iscc = resolveIsccForTest();
    if (!iscc) {
      t.skip("Inno Setup compiler is not installed on this Windows host.");
      return;
    }
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-inno-compile-"));
    try {
      const bundlePath = path.join(tempRoot, "bundle.zip");
      const issPath = path.join(tempRoot, "installer.iss");
      fs.writeFileSync(bundlePath, "compile-only bundle fixture\n", "utf8");
      fs.writeFileSync(
        issPath,
        renderIss({
          target: "windows-x64",
          architecture: "x64compatible",
          version: "1.0.0",
          bundleZipPath: bundlePath,
          outDir: tempRoot,
          payloadValidatorPath: path.join(scriptDir, "validate-windows-bundle.ps1"),
        }),
        "utf8",
      );

      const compiled = spawnSync(iscc, [issPath], { cwd: tempRoot, encoding: "utf8", windowsHide: true });
      assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`);
      assert.ok(fs.existsSync(path.join(tempRoot, "GoatCitadel-Setup-windows-x64.exe")));
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  },
);

function resolveIsccForTest() {
  const candidates = [
    "ISCC.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Inno Setup 6", "ISCC.exe"),
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  ];
  return candidates.find((candidate) => {
    const result = spawnSync(candidate, ["/?"], { stdio: "ignore", windowsHide: true });
    return !result.error;
  });
}
