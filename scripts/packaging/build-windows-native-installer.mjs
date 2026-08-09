#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const payloadValidatorPath = path.join(scriptDir, "validate-windows-bundle.ps1");

const supportedTargets = {
  "windows-x64": "x64compatible",
  "windows-arm64": "arm64",
};

function main() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  const args = parseArgs(process.argv.slice(2));
  const target = args.target;
  if (!target || !supportedTargets[target]) {
    printUsage();
    process.exit(1);
  }

  const version = args.version || packageJson.version;
  const outDir = path.resolve(args.outDir || path.join(repoRoot, "artifacts", "installers", "windows"));
  const bundleDir = path.resolve(
    args.bundleDir || path.join(repoRoot, "artifacts", "installers", "bundles", `GoatCitadel-${version}-${target}`),
  );
  const issPath = path.join(outDir, `GoatCitadel-${target}.iss`);
  const bundleZipPath = path.join(outDir, `GoatCitadel-${target}.zip`);

  if (!fs.existsSync(bundleDir)) {
    throw new Error(`Bundle directory does not exist: ${bundleDir}`);
  }
  if (!fs.existsSync(payloadValidatorPath)) {
    throw new Error(`Windows bundle validator does not exist: ${payloadValidatorPath}`);
  }

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    issPath,
    renderIss({
      target,
      architecture: supportedTargets[target],
      version,
      bundleZipPath,
      outDir,
      payloadValidatorPath,
    }),
    "utf8",
  );

  if (args.emitOnly) {
    console.log(`Wrote Inno Setup script: ${issPath}`);
    process.exit(0);
  }

  createBundleArchive(bundleDir, bundleZipPath);

  const iscc = resolveIscc();
  if (!iscc) {
    throw new Error("Inno Setup compiler (ISCC.exe) was not found.");
  }

  const result = spawnSync(iscc, [issPath], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`ISCC.exe exited with code ${result.status}`);
  }

  console.log(`Built Windows installer: ${path.join(outDir, `GoatCitadel-Setup-${target}.exe`)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}

function parseArgs(argv) {
  const parsed = { emitOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--target") {
      parsed.target = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--version") {
      parsed.version = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--bundle-dir") {
      parsed.bundleDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--out-dir") {
      parsed.outDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--emit-only") {
      parsed.emitOnly = true;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}

function printUsage() {
  console.log(
    "Usage: node scripts/packaging/build-windows-native-installer.mjs --target <windows-x64|windows-arm64> [--version <semver>] [--bundle-dir <dir>] [--out-dir <dir>] [--emit-only]",
  );
}

function resolveIscc() {
  const candidates = [
    "ISCC.exe",
    path.join(process.env.LOCALAPPDATA || "", "Programs", "Inno Setup 6", "ISCC.exe"),
    "C:\\Program Files (x86)\\Inno Setup 6\\ISCC.exe",
    "C:\\Program Files\\Inno Setup 6\\ISCC.exe",
  ];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["/?"], { stdio: "ignore" });
    if (!result.error) {
      return candidate;
    }
  }
  return null;
}

function createBundleArchive(sourceDir, destinationZip) {
  fs.rmSync(destinationZip, { force: true });

  const tarResult = spawnSync("tar.exe", ["-a", "-cf", destinationZip, "-C", sourceDir, "."], {
    cwd: repoRoot,
    stdio: "inherit",
  });

  if (!tarResult.error && tarResult.status === 0) {
    return;
  }

  const command = [
    "$ErrorActionPreference = 'Stop'",
    `Compress-Archive -Path (Join-Path ${toPowershellSingleQuoted(sourceDir)} '*') -DestinationPath ${toPowershellSingleQuoted(destinationZip)} -Force`,
  ].join("; ");
  const zipResult = spawnSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (zipResult.error) {
    throw zipResult.error;
  }
  if (zipResult.status !== 0) {
    throw new Error(`Failed to create bundle archive at ${destinationZip}`);
  }
}

export function renderIss({
  target: bundleTarget,
  architecture,
  version: bundleVersion,
  bundleZipPath: currentBundleZipPath,
  outDir: currentOutDir,
  payloadValidatorPath: currentPayloadValidatorPath = payloadValidatorPath,
}) {
  return `
#define MyAppName "GoatCitadel"
#define MyAppVersion "${bundleVersion}"
#define MyAppPublisher "GoatCitadel"
#define MyAppURL "https://github.com/goatcitadel/GoatCitadel"
#define MyBundleZip "${normalizeForInno(currentBundleZipPath)}"
#define MyPayloadValidator "${normalizeForInno(currentPayloadValidatorPath)}"
#define MyOutputDir "${normalizeForInno(currentOutDir)}"
#define MyBundleTarget "${bundleTarget}"
#define MyDesktopExe "app\\desktop\\GoatCitadel-Mission-Control-Windows.exe"
#define MyIdentityPackage "app\\identity\\GoatCitadel-Mission-Control-Windows-Identity.msix"
#define MyIdentityPackageName "GoatCitadel.MissionControl.Windows"
#define MyInstallMarker ".goatcitadel-install"
#define MyInstallStageDir ".goatcitadel-install-stage"
#define MyInstallBackupDir ".goatcitadel-install-backup"
#define MyTransactionMarker ".goatcitadel-transaction"

[Setup]
AppId=com.goatcitadel.installer.${bundleTarget}
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
ArchitecturesAllowed=${architecture}
ArchitecturesInstallIn64BitMode=${architecture}
DefaultDirName={localappdata}\\GoatCitadel
DefaultGroupName=GoatCitadel
DisableProgramGroupPage=yes
AllowNoIcons=yes
OutputDir={#MyOutputDir}
OutputBaseFilename=GoatCitadel-Setup-${bundleTarget}
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
WizardStyle=modern
CloseApplications=force
RestartApplications=no
UninstallDisplayIcon={app}\\{#MyDesktopExe}

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Types]
Name: "full"; Description: "Full installation"
Name: "custom"; Description: "Custom installation"; Flags: iscustom

[Components]
Name: "core"; Description: "Core runtime"; Types: full custom; Flags: fixed
Name: "chromium"; Description: "Chromium runtime"; Types: full custom
Name: "voice"; Description: "Voice runtime"; Types: full custom

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#MyBundleZip}"; DestDir: "{tmp}"; DestName: "bundle.zip"; Flags: dontcopy
Source: "{#MyPayloadValidator}"; DestDir: "{tmp}"; DestName: "validate-windows-bundle.ps1"; Flags: dontcopy
; Final release identity cannot be embedded in the signed installer without a
; digest cycle. Verified distribution ZIPs place this fixed, data-only
; pair beside the installer. PrepareToInstall copies only those exact files
; into the transaction stage before validation and promotion. A standalone
; installer remains usable but truthfully reports proof unverified.

[Icons]
Name: "{autoprograms}\\GoatCitadel"; Filename: "{app}\\{#MyDesktopExe}"; WorkingDir: "{app}"
Name: "{autodesktop}\\GoatCitadel"; Filename: "{app}\\{#MyDesktopExe}"; WorkingDir: "{app}"; Tasks: desktopicon

[Registry]
Root: HKCU; Subkey: "Software\\Classes\\goatcitadel"; ValueType: string; ValueName: ""; ValueData: "URL:GoatCitadel Protocol"; Flags: uninsdeletekey
Root: HKCU; Subkey: "Software\\Classes\\goatcitadel"; ValueType: string; ValueName: "URL Protocol"; ValueData: ""
Root: HKCU; Subkey: "Software\\Classes\\goatcitadel\\DefaultIcon"; ValueType: string; ValueName: ""; ValueData: "{app}\\{#MyDesktopExe},0"
Root: HKCU; Subkey: "Software\\Classes\\goatcitadel\\shell\\open\\command"; ValueType: string; ValueName: ""; ValueData: """{app}\\{#MyDesktopExe}"" ""%1"""

[Run]
Filename: "{app}\\{#MyDesktopExe}"; Description: "Launch GoatCitadel"; Flags: nowait postinstall skipifsilent

[Code]
var
  InstallHadMarker: Boolean;
  BackedUpAppPayload: Boolean;
  BackedUpBinPayload: Boolean;
  PromotedAppPayload: Boolean;
  PromotedBinPayload: Boolean;
  StageCreatedByCurrentSetup: Boolean;
  StagedPayloadPrepared: Boolean;
  InstallPromotionStarted: Boolean;
  InstallCommitted: Boolean;

procedure RegisterExtraCloseApplicationsResources;
begin
  // The desktop host closes to the tray, so explicitly register its installed executable with
  // Restart Manager before replacing app\\. The normal post-install action owns relaunch.
  RegisterExtraCloseApplicationsResource(False, ExpandConstant('{app}\\{#MyDesktopExe}'));
end;

procedure RunOrFail(FileName: String; Parameters: String; WorkingDir: String; StatusText: String);
var
  ResultCode: Integer;
begin
  WizardForm.StatusLabel.Caption := StatusText;
  if not Exec(FileName, Parameters, WorkingDir, SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    RaiseException('Failed to start ' + FileName + ' while ' + StatusText);
  end;
  if ResultCode <> 0 then
  begin
    RaiseException(FileName + ' exited with code ' + IntToStr(ResultCode) + ' while ' + StatusText);
  end;
end;

// Like RunOrFail, but best-effort: a launch failure or non-zero exit is written to the install
// log and tolerated instead of aborting the install. Use only for optional post-install steps.
procedure RunBestEffort(FileName: String; Parameters: String; WorkingDir: String; StatusText: String);
var
  ResultCode: Integer;
begin
  WizardForm.StatusLabel.Caption := StatusText;
  if not Exec(FileName, Parameters, WorkingDir, SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    Log('GoatCitadel: failed to start ' + FileName + ' while ' + StatusText + ' (optional step, continuing)');
    Exit;
  end;
  if ResultCode <> 0 then
  begin
    Log('GoatCitadel: ' + FileName + ' exited with code ' + IntToStr(ResultCode) + ' while ' + StatusText + ' (optional step, continuing)');
  end;
end;

// Setup and uninstall expose different progress-form globals. Calling a helper that touches
// WizardForm from the generated uninstaller raises "Could not call proc" before Exec runs, so
// keep the uninstall variants separate and reachable only from uninstall-owned procedures.
procedure RunUninstallOrFail(FileName: String; Parameters: String; WorkingDir: String; StatusText: String);
var
  ResultCode: Integer;
begin
  UninstallProgressForm.StatusLabel.Caption := StatusText;
  if not Exec(FileName, Parameters, WorkingDir, SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    RaiseException('Failed to start ' + FileName + ' while ' + StatusText);
  end;
  if ResultCode <> 0 then
  begin
    RaiseException(FileName + ' exited with code ' + IntToStr(ResultCode) + ' while ' + StatusText);
  end;
end;

procedure RunUninstallBestEffort(FileName: String; Parameters: String; WorkingDir: String; StatusText: String);
var
  ResultCode: Integer;
begin
  UninstallProgressForm.StatusLabel.Caption := StatusText;
  if not Exec(FileName, Parameters, WorkingDir, SW_HIDE, ewWaitUntilTerminated, ResultCode) then
  begin
    Log('GoatCitadel: failed to start ' + FileName + ' while ' + StatusText + ' (optional step, continuing)');
    Exit;
  end;
  if ResultCode <> 0 then
  begin
    Log('GoatCitadel: ' + FileName + ' exited with code ' + IntToStr(ResultCode) + ' while ' + StatusText + ' (optional step, continuing)');
  end;
end;

function GoatCitadelInstallMarkerPath(): String;
begin
  Result := ExpandConstant('{app}\\{#MyInstallMarker}');
end;

function GoatCitadelInstallStageRoot(): String;
begin
  Result := ExpandConstant('{app}\\{#MyInstallStageDir}');
end;

function GoatCitadelInstallBackupRoot(): String;
begin
  Result := ExpandConstant('{app}\\{#MyInstallBackupDir}');
end;

function TransactionMarkerPath(RootPath: String): String;
begin
  Result := AddBackslash(RootPath) + '{#MyTransactionMarker}';
end;

// True only when this directory was provisioned by a prior GoatCitadel install. Guards the
// app\\ and bin\\ deletes so a custom {app} (e.g. a shared folder reused via /DIR) that happens
// to contain unrelated app\\ or bin\\ trees is never wiped by install/uninstall cleanup.
function GoatCitadelInstallMarkerExists(): Boolean;
begin
  Result := FileExists(GoatCitadelInstallMarkerPath());
end;

procedure WriteGoatCitadelInstallMarker();
begin
  if not SaveStringToFile(
      GoatCitadelInstallMarkerPath(),
      'GoatCitadel install marker. Created by the installer; do not remove.' + #13#10,
      False) then
  begin
    RaiseException('Failed to write the GoatCitadel install marker.');
  end;
end;

procedure StopExistingGoatCitadelRuntime(DuringUninstall: Boolean);
var
  LauncherPath: String;
begin
  if not GoatCitadelInstallMarkerExists() then
  begin
    Exit;
  end;
  LauncherPath := ExpandConstant('{app}\\bin\\goatcitadel.cmd');
  if not FileExists(LauncherPath) then
  begin
    Exit;
  end;
  if DuringUninstall then
  begin
    RunUninstallBestEffort(
      'powershell.exe',
      ExpandConstant('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "& ''{app}\\bin\\goatcitadel.cmd'' stop --json"'),
      ExpandConstant('{app}'),
      'Stopping the existing GoatCitadel runtime...'
    );
  end
  else
  begin
    RunBestEffort(
      'powershell.exe',
      ExpandConstant('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "& ''{app}\\bin\\goatcitadel.cmd'' stop --json"'),
      ExpandConstant('{app}'),
      'Stopping the existing GoatCitadel runtime...'
    );
  end;
end;

procedure StopExistingGoatCitadelPayloadProcesses(DuringUninstall: Boolean);
var
  PayloadRoot: String;
  Parameters: String;
begin
  if not GoatCitadelInstallMarkerExists() then
  begin
    Exit;
  end;
  PayloadRoot := AddBackslash(ExpandConstant('{app}\\app'));
  if not DirExists(PayloadRoot) then
  begin
    Exit;
  end;
  // Restart Manager gets the first chance to close the host. Then stop only processes whose
  // executable lives in this marker-owned app\\ payload, including an orphaned launch --wait
  // supervisor that would otherwise keep the bundled node.exe locked.
  Parameters := '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "& { param($payloadRoot) $processes = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith($payloadRoot, [System.StringComparison]::OrdinalIgnoreCase) }); if ($processes.Count -gt 0) { $processes | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }; $processes | ForEach-Object { Wait-Process -Id $_.ProcessId -Timeout 10 -ErrorAction SilentlyContinue } } }" ' + AddQuotes(PayloadRoot);
  if DuringUninstall then
  begin
    RunUninstallBestEffort(
      'powershell.exe',
      Parameters,
      ExpandConstant('{app}'),
      'Closing existing GoatCitadel payload processes...'
    );
  end
  else
  begin
    RunBestEffort(
      'powershell.exe',
      Parameters,
      ExpandConstant('{app}'),
      'Closing existing GoatCitadel payload processes...'
    );
  end;
  // Self-contained .NET/WinUI DLL handles can outlive process enumeration very briefly.
  Sleep(1500);
end;

procedure RemoveGoatCitadelPayload();
var
  AppPayloadPath: String;
  BinPayloadPath: String;
begin
  if not GoatCitadelInstallMarkerExists() then
  begin
    Exit;
  end;
  AppPayloadPath := ExpandConstant('{app}\\app');
  BinPayloadPath := ExpandConstant('{app}\\bin');
  DelTree(AppPayloadPath, True, True, True);
  DelTree(BinPayloadPath, True, True, True);
  if DirExists(AppPayloadPath) or DirExists(BinPayloadPath) then
  begin
    RunUninstallOrFail(
      'powershell.exe',
      ExpandConstant('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "try {{ [System.IO.Directory]::Delete(''\\\\?\\{app}\\app'', $true) } catch {{}; try {{ [System.IO.Directory]::Delete(''\\\\?\\{app}\\bin'', $true) } catch {{}; Remove-Item -LiteralPath ''\\\\?\\{app}\\app'' -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath ''\\\\?\\{app}\\bin'' -Recurse -Force -ErrorAction SilentlyContinue; exit 0"'),
      '',
      'Removing the previous GoatCitadel payload...'
    );
  end;
  if DirExists(AppPayloadPath) or DirExists(BinPayloadPath) then
  begin
    RaiseException('The previous GoatCitadel payload is still in use. Close GoatCitadel and retry the update.');
  end;
end;

procedure WriteTransactionMarker(RootPath: String);
begin
  if not SaveStringToFile(
      TransactionMarkerPath(RootPath),
      'GoatCitadel installer transaction directory.' + #13#10,
      False) then
  begin
    RaiseException('Failed to mark the GoatCitadel installer transaction directory.');
  end;
end;

procedure RemoveDirectoryTree(DirectoryPath: String; StatusText: String);
var
  Parameters: String;
begin
  if not DirExists(DirectoryPath) then
  begin
    Exit;
  end;
  DelTree(DirectoryPath, True, True, True);
  if DirExists(DirectoryPath) then
  begin
    Parameters := '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "& { param($path) Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction SilentlyContinue; exit 0 }" ' + AddQuotes(DirectoryPath);
    RunOrFail('powershell.exe', Parameters, '', StatusText);
  end;
  if DirExists(DirectoryPath) then
  begin
    RaiseException('A GoatCitadel installer transaction directory remains locked: ' + DirectoryPath);
  end;
end;

procedure RemoveOwnedTransactionDirectory(RootPath: String; StatusText: String);
begin
  if not DirExists(RootPath) then
  begin
    Exit;
  end;
  if not FileExists(TransactionMarkerPath(RootPath)) then
  begin
    RaiseException('Refusing to remove an unmarked installer transaction directory: ' + RootPath);
  end;
  RemoveDirectoryTree(RootPath, StatusText);
end;

procedure AssertInstallDestinationSafe();
begin
  if DirExists(GoatCitadelInstallStageRoot()) or DirExists(GoatCitadelInstallBackupRoot()) then
  begin
    RaiseException(
      'A previous GoatCitadel installer transaction directory still exists. ' +
      'The installer will not guess whether it contains the only recoverable payload.');
  end;
  if (not GoatCitadelInstallMarkerExists()) and
     (DirExists(ExpandConstant('{app}\\app')) or DirExists(ExpandConstant('{app}\\bin'))) then
  begin
    RaiseException(
      'The selected directory contains app or bin without a GoatCitadel install marker. ' +
      'Choose an empty directory or the existing marker-owned installation.');
  end;
end;

procedure ValidateGoatCitadelPayload(PayloadRoot: String; InstalledRoot: Boolean);
var
  Parameters: String;
begin
  Parameters := '-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File ' +
    AddQuotes(ExpandConstant('{tmp}\\validate-windows-bundle.ps1')) +
    ' -StageRoot ' + AddQuotes(PayloadRoot) +
    ' -Target ' + AddQuotes('{#MyBundleTarget}') +
    ' -Version ' + AddQuotes('{#MyAppVersion}');
  if InstalledRoot then
  begin
    Parameters := Parameters + ' -InstalledRoot';
  end;
  RunOrFail(
    'powershell.exe',
    Parameters,
    PayloadRoot,
    'Validating the GoatCitadel payload manifest and hashes...'
  );
end;

procedure CopyAdjacentReleaseEvidenceIfPresent(StageRoot: String; FileName: String);
var
  SourcePath: String;
  DestinationDirectory: String;
  DestinationPath: String;
begin
  SourcePath := AddBackslash(ExpandConstant('{src}\\release-evidence')) + FileName;
  if not FileExists(SourcePath) then
  begin
    Exit;
  end;

  DestinationDirectory := AddBackslash(StageRoot) + 'app\\release-evidence';
  if not ForceDirectories(DestinationDirectory) then
  begin
    RaiseException('Failed to create the staged GoatCitadel release-evidence directory.');
  end;
  DestinationPath := AddBackslash(DestinationDirectory) + FileName;
  if not FileCopy(SourcePath, DestinationPath, False) then
  begin
    RaiseException('Failed to copy adjacent GoatCitadel release evidence ' + FileName + ' into staging.');
  end;
end;

procedure StageAdjacentReleaseEvidence(StageRoot: String);
var
  DestinationDirectory: String;
begin
  // These are the only detached files accepted beside the installer. Keep the
  // list explicit so release-assets or proof bundles are never copied recursively.
  // The manifest validator intentionally excludes detached evidence, so first
  // clear any copy embedded in the archive from this marker-owned stage.
  if not FileExists(TransactionMarkerPath(StageRoot)) then
  begin
    RaiseException('Refusing to replace release evidence in an unmarked installer stage.');
  end;
  DestinationDirectory := AddBackslash(StageRoot) + 'app\\release-evidence';
  RemoveDirectoryTree(
    DestinationDirectory,
    'Removing embedded release evidence from GoatCitadel installer staging...'
  );
  CopyAdjacentReleaseEvidenceIfPresent(StageRoot, 'release-certificate.json');
  CopyAdjacentReleaseEvidenceIfPresent(StageRoot, 'release-certificate.sigstore.json');
end;

procedure PrepareStagedGoatCitadelPayload();
var
  StageRoot: String;
  Parameters: String;
begin
  StageCreatedByCurrentSetup := False;
  AssertInstallDestinationSafe();
  StageRoot := GoatCitadelInstallStageRoot();
  if not ForceDirectories(StageRoot) then
  begin
    RaiseException('Failed to create the GoatCitadel installer staging directory.');
  end;
  WriteTransactionMarker(StageRoot);
  StageCreatedByCurrentSetup := True;
  ExtractTemporaryFile('bundle.zip');
  ExtractTemporaryFile('validate-windows-bundle.ps1');
  Parameters := '-xf ' + AddQuotes(ExpandConstant('{tmp}\\bundle.zip')) + ' -C ' + AddQuotes(StageRoot);
  RunOrFail(
    ExpandConstant('{sys}\\tar.exe'),
    Parameters,
    '',
    'Expanding the GoatCitadel bundle into transaction staging...'
  );
  StageAdjacentReleaseEvidence(StageRoot);
  ValidateGoatCitadelPayload(StageRoot, False);
  StagedPayloadPrepared := True;
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
var
  FailureMessage: String;
begin
  Result := '';
  try
    PrepareStagedGoatCitadelPayload();
  except
    FailureMessage := GetExceptionMessage();
    // AssertInstallDestinationSafe can fail because a prior killed setup left a
    // recoverable transaction directory. Never delete that prior directory here.
    if StageCreatedByCurrentSetup then
    begin
      try
        RemoveOwnedTransactionDirectory(
          GoatCitadelInstallStageRoot(),
          'Cleaning failed GoatCitadel installer staging...'
        );
        StageCreatedByCurrentSetup := False;
      except
        Log('GoatCitadel: failed to clean installer staging after validation failure: ' + GetExceptionMessage());
      end;
    end;
    StagedPayloadPrepared := False;
    Result := 'GoatCitadel could not prepare a validated payload. ' + FailureMessage;
  end;
end;

procedure RegisterGoatCitadelIdentity();
begin
  // Best-effort: an unsigned/untrusted identity package, a sideloading policy, or a publisher
  // mismatch must not abort an otherwise-good install. The app runs without package identity
  // (the shortcut launches the executable directly), so a failure here is logged and ignored.
  RunBestEffort(
    'powershell.exe',
    ExpandConstant('-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command "Get-AppxPackage {#MyIdentityPackageName} | Remove-AppxPackage -ErrorAction SilentlyContinue; $package = Join-Path ''{app}'' ''{#MyIdentityPackage}''; if (Test-Path -LiteralPath $package) {{ Add-AppxPackage -Path $package -ExternalLocation ''{app}'' }}"'),
    '',
    'Registering GoatCitadel package identity...'
  );
end;

procedure InstallChromiumRuntime();
begin
  RunOrFail(
    ExpandConstant('{app}\\app\\runtime\\node\\node.exe'),
    ExpandConstant('"{app}\\app\\gateway\\node_modules\\playwright\\cli.js" install chromium'),
    ExpandConstant('{app}\\app\\gateway'),
    'Installing Chromium runtime...'
  );
end;

procedure InstallVoiceRuntime();
begin
  RunOrFail(
    ExpandConstant('{app}\\app\\runtime\\node\\node.exe'),
    ExpandConstant('"{app}\\app\\gateway\\dist\\voice-runtime-cli.js" install --model base.en'),
    ExpandConstant('{app}\\app\\gateway'),
    'Installing local voice runtime...'
  );
end;

procedure BackupExistingGoatCitadelPayload();
var
  BackupRoot: String;
  AppPayloadPath: String;
  BinPayloadPath: String;
begin
  BackupRoot := GoatCitadelInstallBackupRoot();
  AppPayloadPath := ExpandConstant('{app}\\app');
  BinPayloadPath := ExpandConstant('{app}\\bin');
  if not ForceDirectories(BackupRoot) then
  begin
    RaiseException('Failed to create the GoatCitadel installer backup directory.');
  end;
  WriteTransactionMarker(BackupRoot);
  if DirExists(AppPayloadPath) then
  begin
    if not RenameFile(AppPayloadPath, AddBackslash(BackupRoot) + 'app') then
    begin
      RaiseException('The previous GoatCitadel app payload is still in use. Close GoatCitadel and retry the update.');
    end;
    BackedUpAppPayload := True;
  end;
  if DirExists(BinPayloadPath) then
  begin
    if not RenameFile(BinPayloadPath, AddBackslash(BackupRoot) + 'bin') then
    begin
      RaiseException('The previous GoatCitadel bin payload is still in use. Close GoatCitadel and retry the update.');
    end;
    BackedUpBinPayload := True;
  end;
end;

function RollBackGoatCitadelPayload(): Boolean;
var
  BackupRoot: String;
  AppPayloadPath: String;
  BinPayloadPath: String;
begin
  Result := True;
  BackupRoot := GoatCitadelInstallBackupRoot();
  AppPayloadPath := ExpandConstant('{app}\\app');
  BinPayloadPath := ExpandConstant('{app}\\bin');

  if PromotedBinPayload then
  begin
    try
      RemoveDirectoryTree(BinPayloadPath, 'Removing the failed GoatCitadel bin payload...');
      PromotedBinPayload := False;
    except
      Log('GoatCitadel: failed to remove the promoted bin payload during rollback: ' + GetExceptionMessage());
      Result := False;
    end;
  end;
  if PromotedAppPayload then
  begin
    try
      RemoveDirectoryTree(AppPayloadPath, 'Removing the failed GoatCitadel app payload...');
      PromotedAppPayload := False;
    except
      Log('GoatCitadel: failed to remove the promoted app payload during rollback: ' + GetExceptionMessage());
      Result := False;
    end;
  end;

  if BackedUpAppPayload then
  begin
    if (not DirExists(AppPayloadPath)) and RenameFile(AddBackslash(BackupRoot) + 'app', AppPayloadPath) then
    begin
      BackedUpAppPayload := False;
    end
    else
    begin
      Log('GoatCitadel: failed to restore the previous app payload from transaction backup.');
      Result := False;
    end;
  end;
  if BackedUpBinPayload then
  begin
    if (not DirExists(BinPayloadPath)) and RenameFile(AddBackslash(BackupRoot) + 'bin', BinPayloadPath) then
    begin
      BackedUpBinPayload := False;
    end
    else
    begin
      Log('GoatCitadel: failed to restore the previous bin payload from transaction backup.');
      Result := False;
    end;
  end;

  if Result then
  begin
    if not InstallHadMarker then
    begin
      DeleteFile(GoatCitadelInstallMarkerPath());
    end;
    try
      RemoveOwnedTransactionDirectory(
        GoatCitadelInstallStageRoot(),
        'Cleaning GoatCitadel installer staging after rollback...'
      );
      RemoveOwnedTransactionDirectory(
        BackupRoot,
        'Cleaning GoatCitadel installer backup after rollback...'
      );
    except
      Log('GoatCitadel: failed to clean transaction directories after restoring the payload: ' + GetExceptionMessage());
      Result := False;
    end;
  end;
  if Result then
  begin
    StageCreatedByCurrentSetup := False;
    StagedPayloadPrepared := False;
    InstallPromotionStarted := False;
  end;
end;

procedure CleanupCommittedInstallTransaction();
begin
  // A valid promoted install is the commit point. Cleanup after that point is deliberately
  // best-effort: AV or a transient lock must never cause a partially deleted old backup to be
  // restored over the already-validated new payload.
  try
    RemoveOwnedTransactionDirectory(
      GoatCitadelInstallStageRoot(),
      'Cleaning committed GoatCitadel installer staging...'
    );
    StageCreatedByCurrentSetup := False;
  except
    Log('GoatCitadel: committed install left its marked staging directory for manual cleanup: ' + GetExceptionMessage());
  end;
  try
    RemoveOwnedTransactionDirectory(
      GoatCitadelInstallBackupRoot(),
      'Cleaning committed GoatCitadel installer backup...'
    );
  except
    Log('GoatCitadel: committed install left its marked backup directory for manual cleanup: ' + GetExceptionMessage());
  end;
end;

procedure PromoteStagedGoatCitadelPayload();
var
  FailureMessage: String;
  StageRoot: String;
  BackupRoot: String;
  AppPayloadPath: String;
  BinPayloadPath: String;
begin
  InstallHadMarker := GoatCitadelInstallMarkerExists();
  BackedUpAppPayload := False;
  BackedUpBinPayload := False;
  PromotedAppPayload := False;
  PromotedBinPayload := False;
  StageRoot := GoatCitadelInstallStageRoot();
  BackupRoot := GoatCitadelInstallBackupRoot();
  AppPayloadPath := ExpandConstant('{app}\\app');
  BinPayloadPath := ExpandConstant('{app}\\bin');
  // Initialization above has not mutated the live payload. Enter rollback-owned state only
  // after the previous marker state and every path needed by rollback are captured safely.
  InstallPromotionStarted := True;

  try
    if (not InstallHadMarker) and (DirExists(AppPayloadPath) or DirExists(BinPayloadPath)) then
    begin
      RaiseException(
        'The selected directory gained an unmarked app or bin payload after staging. ' +
        'The installer will not overwrite it.');
    end;
    if DirExists(BackupRoot) then
    begin
      RaiseException('The GoatCitadel installer backup directory unexpectedly already exists.');
    end;
    BackupExistingGoatCitadelPayload();
    if not RenameFile(AddBackslash(StageRoot) + 'app', AppPayloadPath) then
    begin
      RaiseException('Failed to promote the validated GoatCitadel app payload.');
    end;
    PromotedAppPayload := True;
    if not RenameFile(AddBackslash(StageRoot) + 'bin', BinPayloadPath) then
    begin
      RaiseException('Failed to promote the validated GoatCitadel bin payload.');
    end;
    PromotedBinPayload := True;

    ValidateGoatCitadelPayload(ExpandConstant('{app}'), True);
    WriteGoatCitadelInstallMarker();
  except
    FailureMessage := GetExceptionMessage();
    if RollBackGoatCitadelPayload() then
    begin
      RaiseException(FailureMessage + ' The previous GoatCitadel payload was restored.');
    end
    else
    begin
      RaiseException(
        FailureMessage + ' Automatic rollback was incomplete. The previous payload remains preserved at ' +
        BackupRoot + '. Do not delete that directory.');
    end;
  end;

end;

procedure DeinitializeSetup();
begin
  // ssInstall promotes before Inno begins its managed file/registry/uninstaller transaction.
  // If that later transaction fails or is cancelled, restore the previous payload here while
  // Inno rolls back its own state. A killed setup process cannot run this hook; its marked
  // transaction directories remain and the next installer run fails closed for recovery.
  if InstallPromotionStarted and (not InstallCommitted) then
  begin
    if not RollBackGoatCitadelPayload() then
    begin
      Log(
        'GoatCitadel: setup exit could not fully restore the previous payload. The marked backup remains at ' +
        GoatCitadelInstallBackupRoot() + ' and must not be deleted.'
      );
    end;
    Exit;
  end;

  // Setup may fail or be cancelled after PrepareToInstall staged a valid bundle but before
  // ssInstall starts promotion. The live payload is untouched, so remove only the stage.
  if StageCreatedByCurrentSetup and (not InstallPromotionStarted) and (not InstallCommitted) then
  begin
    try
      RemoveOwnedTransactionDirectory(
        GoatCitadelInstallStageRoot(),
        'Cleaning uncommitted GoatCitadel installer staging...'
      );
      StageCreatedByCurrentSetup := False;
      StagedPayloadPrepared := False;
    except
      Log('GoatCitadel: setup exit left its marked staging directory for manual cleanup: ' + GetExceptionMessage());
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
begin
  if CurStep = ssInstall then
  begin
    // The bundle was already extracted and hash-validated under the same-volume transaction
    // stage. Promote before Inno begins its managed install transaction so any later Inno
    // failure reaches DeinitializeSetup with the old payload backup still available.
    StopExistingGoatCitadelRuntime(False);
    StopExistingGoatCitadelPayloadProcesses(False);
    PromoteStagedGoatCitadelPayload();
    // Selected runtime components are part of install truth, not advisory extras. Install them
    // fail-hard while the old payload backup is retained; DeinitializeSetup restores on error.
    if (not WizardSilent()) and IsComponentSelected('chromium') then
    begin
      InstallChromiumRuntime();
    end;
    if (not WizardSilent()) and IsComponentSelected('voice') then
    begin
      InstallVoiceRuntime();
    end;
  end;
  if CurStep = ssPostInstall then
  begin
    // Inno has committed its managed files, shortcuts, registry, and uninstaller by this event.
    // Mark the custom payload committed before evaluating any optional helper or argument;
    // DeinitializeSetup must never restore the previous payload after Inno has committed.
    InstallCommitted := True;
    StagedPayloadPrepared := False;
    CleanupCommittedInstallTransaction();
    try
      RegisterGoatCitadelIdentity();
    except
      Log('GoatCitadel: identity post-install step raised unexpectedly; continuing: ' + GetExceptionMessage());
    end;
  end;
end;

procedure CurUninstallStepChanged(CurUninstallStep: TUninstallStep);
begin
  if CurUninstallStep = usUninstall then
  begin
    // Stop the packaged runtime before removing its payload. Only delete the payload trees if
    // this directory carries our install marker.
    StopExistingGoatCitadelRuntime(True);
    StopExistingGoatCitadelPayloadProcesses(True);
    RemoveGoatCitadelPayload();
  end;
  if CurUninstallStep = usPostUninstall then
  begin
    // Remove the marker last, after the [UninstallRun] long-path safety net has run.
    DeleteFile(GoatCitadelInstallMarkerPath());
  end;
end;

[UninstallRun]
Filename: "powershell.exe"; Parameters: "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -Command ""Get-AppxPackage {#MyIdentityPackageName} | Remove-AppxPackage -ErrorAction SilentlyContinue"""; Flags: waituntilterminated runhidden; RunOnceId: "goatcitadel-remove-identity"
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""try {{ [System.IO.Directory]::Delete('\\\\?\\{app}\\app', $true) } catch {{}; try {{ [System.IO.Directory]::Delete('\\\\?\\{app}\\bin', $true) } catch {{}; Remove-Item -LiteralPath '\\\\?\\{app}\\app' -Recurse -Force -ErrorAction SilentlyContinue; Remove-Item -LiteralPath '\\\\?\\{app}\\bin' -Recurse -Force -ErrorAction SilentlyContinue; exit 0"""; Flags: waituntilterminated runhidden; Check: GoatCitadelInstallMarkerExists; RunOnceId: "goatcitadel-remove-payload"

[UninstallDelete]
Type: dirifempty; Name: "{app}\\app"
Type: dirifempty; Name: "{app}\\bin"
Type: dirifempty; Name: "{app}"
`.trimStart();
}

function normalizeForInno(value) {
  return value.replaceAll("\\", "\\\\");
}

function toPowershellSingleQuoted(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
