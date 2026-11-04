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

function uninstallRunSection(iss) {
  const section = iss.match(/^\[UninstallRun\]\r?\n([\s\S]*?)^\[UninstallDelete\]/mu)?.[1];
  assert.ok(section, "Expected the generated uninstall run section");
  return section;
}

test("uninstaller payload deletes are guarded by the install marker at uninstall time", () => {
  const iss = renderSample();
  assert.match(iss, /function GoatCitadelInstallMarkerExists\(\): Boolean;/);
  assert.match(iss, /WriteGoatCitadelInstallMarker\(\);/);

  const removePayload = iss.match(/procedure RemoveGoatCitadelPayload\(\);[\s\S]*?\nend;/)?.[0] ?? "";
  assert.match(removePayload, /^procedure RemoveGoatCitadelPayload\(\);\nvar\n[\s\S]*?\nbegin\n  if not GoatCitadelInstallMarkerExists\(\) then\n  begin\n    Exit;\n  end;\n  AppPayloadPath :=/u);
  assert.match(removePayload, /DelTree\(AppPayloadPath, True, True, True\);\n  DelTree\(BinPayloadPath, True, True, True\);/u);
  assert.match(removePayload, /RunUninstallOrFail\([\s\S]*?PowerShellLiteral\('\\\\\?\\' \+ AppPayloadPath\)[\s\S]*?PowerShellLiteral\('\\\\\?\\' \+ BinPayloadPath\)/u);
  assert.match(removePayload, /if DirExists\(AppPayloadPath\) or DirExists\(BinPayloadPath\) then\n  begin\n    RaiseException\('The previous GoatCitadel payload is still in use/u);

  const uninstallRun = uninstallRunSection(iss);
  assert.match(uninstallRun, /Get-AppxPackage \{#MyIdentityPackageName\} \| Remove-AppxPackage[\s\S]*?RunOnceId: "goatcitadel-remove-identity"/u);
  assert.match(iss, /\[UninstallDelete\]\nType: dirifempty; Name: "\{app\}\\app"\nType: dirifempty; Name: "\{app\}\\bin"\nType: dirifempty; Name: "\{app\}"/u);
  assert.doesNotMatch(uninstallRun, /Remove-Item|\[System\.IO\.Directory\]::Delete|\{app\}/u);
});

test("latest uninstall record supersedes legacy payload removal even without an install marker", () => {
  const id = "goatcitadel-remove-payload";
  const entries = uninstallRunSection(renderSample()).split(/\r?\n/u);
  const generated = entries.filter((line) => line.endsWith('RunOnceId: "' + id + '"'));
  assert.equal(generated.length, 1, "Removing the entry alone leaves the old uninstall log record");

  // Inno records eligible entries at setup and uses the latest same-ID record on uninstall.
  // The retained record below is a label only. No uninstall command is evaluated.
  const legacy = { id, action: "legacy recursive payload removal" };
  const current = generated
    .filter((line) => !/;\s*(?:Check|Components|Tasks|Languages|MinVersion|OnlyBelowVersion)\s*:/iu.test(line))
    .map((action) => ({ id, action }));
  const effective = [legacy, ...current].findLast((entry) => entry.id === id);
  assert.equal(
    effective?.action,
    'Filename: "{cmd}"; Parameters: "/d /c exit /b 0"; Flags: waituntilterminated runhidden; RunOnceId: "' + id + '"',
  );
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
  assert.match(iss, /PowerShellLiteral\(LauncherPath\) \+ ' stop --json"/);
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
  assert.match(removePayload, /try \{ \[System\.IO\.Directory\]::Delete\(\$a, \$true\) \} catch \{\}; try \{ \[System\.IO\.Directory\]::Delete\(\$b, \$true\) \} catch \{\};/);
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

test("installer never passes paths to PowerShell as trailing -Command arguments", () => {
  const iss = renderSample();

  // powershell.exe -Command re-joins trailing arguments with spaces, so a path such as
  // C:\Users\John Smith\AppData\Local\GoatCitadel was truncated at the first space and an
  // AddBackslash'd path ending in \ turned the closing quote into an escaped quote.
  assert.doesNotMatch(iss, /param\(\$payloadRoot\)/);
  assert.doesNotMatch(iss, /param\(\$path\)/);
  assert.doesNotMatch(iss, /-Command[^\n]*"\s*'\s*\+\s*AddQuotes\(/);

  // Paths reach PowerShell as single-quoted literals produced by one shared helper.
  const helper = iss.match(/function PowerShellLiteral\(Value: String\): String;[\s\S]*?\nend;/)?.[0] ?? "";
  assert.ok(helper.length > 0, "PowerShellLiteral helper must exist");
  assert.match(helper, /StringChangeEx\(Escaped, '''', '''''', True\)/);

  assert.match(iss, /\$payloadRoot = ' \+ PowerShellLiteral\(PayloadRoot\)/);
  assert.match(iss, /Remove-Item -LiteralPath ' \+ PowerShellLiteral\(DirectoryPath\)/);
  assert.match(iss, /-Command "& ' \+ PowerShellLiteral\(LauncherPath\)/);
  assert.match(iss, /PowerShellLiteral\('\\\\\?\\' \+ AppPayloadPath\)/);

  // {app} must never be spliced into a single-quoted PowerShell string by ExpandConstant
  // (an apostrophe in the profile name, e.g. O'Brien, would break out of the literal).
  assert.doesNotMatch(iss, /''\{app\}/);
  assert.doesNotMatch(iss, /''\\\?\\{app\}/);
});


function renderedPowerShellLiteral(value) {
  const helper = renderSample().match(/function PowerShellLiteral\(Value: String\): String;[\s\S]*?\nend;/)?.[0];
  assert.ok(helper?.includes("Escaped := Value;"));
  assert.ok(helper?.includes("Result := '''' + Escaped + '''';"));
  const decodePascalLiteral = (literal) => {
    if (literal.startsWith("'")) return literal.slice(1, -1).replaceAll("''", "'");
    assert.match(literal, /^(?:#\d+)+$/u);
    return String.fromCharCode(...Array.from(literal.matchAll(/#(\d+)/gu), (match) => Number(match[1])));
  };
  const replacements = helper.match(/^\s*StringChangeEx\(Escaped, .+\);$/gmu) ?? [];
  assert.ok(replacements.length > 0);
  for (const line of replacements) {
    const change = /StringChangeEx\(Escaped, ([^,]+), ([^,]+), True\);$/u.exec(line);
    assert.ok(change, "Expected a literal-to-literal Pascal replacement");
    value = value.replaceAll(decodePascalLiteral(change[1]), () => decodePascalLiteral(change[2]));
  }
  return "'" + value + "'";
}

function quotePathFixtures() {
  return [
    { label: "spaces and trailing separator", quote: "" },
    { label: "ASCII apostrophe", quote: "'" },
    { label: "U+2018", quote: "\u2018" },
    { label: "U+2019", quote: "\u2019" },
    { label: "U+201A", quote: "\u201a" },
    { label: "U+201B", quote: "\u201b" },
    { label: "mixed adjacent quotes", quote: "'\u2019" },
  ].map(({ label, quote }) => ({ label, value: "C:\\Review Folder\\O" + quote + "Brien\\GoatCitadel\\" }));
}

test("installer doubles PowerShell single-quote delimiters in rendered path literals", () => {
  const cases = quotePathFixtures();
  assert.deepEqual(
    cases.map(({ label, value }) => [label, renderedPowerShellLiteral(value)]),
    cases.map(({ label, value }) => [label, "'" + value.replace(/['\u2018-\u201b]/gu, "$&$&") + "'"]),
  );
});

test("Windows PowerShell parser preserves paths escaped by the rendered helper", {
  skip: process.platform !== "win32" && "Windows PowerShell 5.1 required",
}, () => {
  const cases = quotePathFixtures().map(({ label, value }) => ({
    label, value, input: "$fixturePath = " + renderedPowerShellLiteral(value),
  }));
  // The child evaluates only this fixed parser harness. Generated assignments stay inert.
  const parser = String.raw`
$ErrorActionPreference = 'Stop'
if ($PSVersionTable.PSEdition -ne 'Desktop' -or $PSVersionTable.PSVersion.Major -ne 5 -or $PSVersionTable.PSVersion.Minor -ne 1) {
  throw 'Windows PowerShell 5.1 required.'
}
$fixtureBytes = [Convert]::FromBase64String([Console]::In.ReadToEnd())
$fixtures = ConvertFrom-Json -InputObject ([Text.Encoding]::UTF8.GetString($fixtureBytes))
$results = foreach ($fixture in $fixtures) {
  $tokens = $null
  $errors = $null
  $tree = [System.Management.Automation.Language.Parser]::ParseInput($fixture.input, [ref]$tokens, [ref]$errors)
  $strings = @($tree.FindAll({
    param($node)
    $node -is [System.Management.Automation.Language.StringConstantExpressionAst]
  }, $true))
  [pscustomobject]@{
    label = $fixture.label
    exact = ($errors.Count -eq 0 -and $tree.EndBlock.Statements.Count -eq 1 -and
      $tree.EndBlock.Statements[0] -is [System.Management.Automation.Language.AssignmentStatementAst] -and
      $strings.Count -eq 1 -and [string]::Equals($strings[0].Value, $fixture.value, [StringComparison]::Ordinal))
  }
}
ConvertTo-Json -InputObject @($results) -Compress
`;
  const powershell = path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(powershell, [
    "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(parser, "utf16le").toString("base64"),
  ], {
    input: Buffer.from(JSON.stringify(cases), "utf8").toString("base64"),
    encoding: "utf8", timeout: 10_000, windowsHide: true,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), cases.map(({ label }) => ({ label, exact: true })));
});
