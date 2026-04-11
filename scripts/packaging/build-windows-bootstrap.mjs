#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

const args = parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.outDir || path.join(repoRoot, "artifacts", "installers", "windows"));
const issPath = path.join(outDir, "GoatCitadel-Bootstrap.iss");
const outputBaseFilename = args.output || "GoatCitadel-Setup-windows-bootstrap";
const repoUrl = args.repoUrl || "https://github.com/goatcitadel/GoatCitadel.git";
const voiceModel = args.voiceModel || "base.en";

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  issPath,
  renderIss({
    appVersion: packageJson.version,
    outputBaseFilename,
    repoRoot,
    repoUrl,
    voiceModel,
  }),
  "utf8",
);

if (args.emitOnly) {
  console.log(`Wrote Inno Setup script: ${issPath}`);
  process.exit(0);
}

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

console.log(`Built Windows installer: ${path.join(outDir, `${outputBaseFilename}.exe`)}`);

function parseArgs(argv) {
  const parsed = { emitOnly: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--out-dir") {
      parsed.outDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--output") {
      parsed.output = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--repo-url") {
      parsed.repoUrl = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--voice-model") {
      parsed.voiceModel = argv[index + 1];
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

function renderIss({ appVersion, outputBaseFilename: setupName, repoRoot: currentRepoRoot, repoUrl: currentRepoUrl, voiceModel: currentVoiceModel }) {
  const installPs1Path = normalizeForInno(path.join(currentRepoRoot, "install.ps1"));
  const escapedRepoUrl = normalizeForInno(currentRepoUrl);
  const escapedVoiceModel = normalizeForInno(currentVoiceModel);
  return `
#define MyAppName "GoatCitadel"
#define MyAppVersion "${appVersion}"
#define MyAppPublisher "GoatCitadel"
#define MyAppURL "https://github.com/goatcitadel/GoatCitadel"
#define MyInstallScript "${installPs1Path}"
#define MyRepoUrl "${escapedRepoUrl}"
#define MyVoiceModel "${escapedVoiceModel}"

[Setup]
AppId=com.goatcitadel.bootstrap.windows
AppName={#MyAppName}
AppVersion={#MyAppVersion}
AppPublisher={#MyAppPublisher}
AppPublisherURL={#MyAppURL}
AppSupportURL={#MyAppURL}
AppUpdatesURL={#MyAppURL}
DefaultDirName={localappdata}\\GoatCitadel
DefaultGroupName=GoatCitadel
OutputDir=${normalizeForInno(outDir)}
OutputBaseFilename=${setupName}
Compression=lzma2
SolidCompression=yes
PrivilegesRequired=lowest
WizardStyle=modern
DisableProgramGroupPage=yes
AllowNoIcons=yes
UninstallDisplayIcon={app}\\bin\\goatcitadel.cmd

[Languages]
Name: "english"; MessagesFile: "compiler:Default.isl"

[Types]
Name: "full"; Description: "Full installation"
Name: "custom"; Description: "Custom installation"; Flags: iscustom

[Components]
Name: "core"; Description: "Core runtime + Chromium"; Types: full custom; Flags: fixed
Name: "voice"; Description: "Voice runtime"; Types: full custom

[Tasks]
Name: "desktopicon"; Description: "{cm:CreateDesktopIcon}"; GroupDescription: "Shortcuts:"; Flags: unchecked

[Files]
Source: "{#MyInstallScript}"; DestDir: "{tmp}"; Flags: deleteafterinstall

[Icons]
Name: "{autoprograms}\\GoatCitadel"; Filename: "{app}\\bin\\goatcitadel.cmd"; Parameters: "up"; WorkingDir: "{app}"
Name: "{autodesktop}\\GoatCitadel"; Filename: "{app}\\bin\\goatcitadel.cmd"; Parameters: "up"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -File ""{tmp}\\install.ps1"" -RepoUrl ""{#MyRepoUrl}"" -InstallDir ""{app}"" -VoiceModel ""{#MyVoiceModel}""{code:GetVoiceArgument}"; StatusMsg: "Installing GoatCitadel..."; Flags: waituntilterminated
Filename: "{app}\\bin\\goatcitadel.cmd"; Parameters: "up"; Description: "Launch GoatCitadel"; Flags: nowait postinstall skipifsilent unchecked

[UninstallRun]
Filename: "{app}\\bin\\goatcitadel.cmd"; Parameters: "uninstall --force"; RunOnceId: "GoatCitadelUninstall"; Flags: runhidden waituntilterminated skipifdoesntexist

[Code]
function GetVoiceArgument(Param: string): string;
begin
  if WizardIsComponentSelected('voice') then
    Result := ''
  else
    Result := ' -SkipVoice';
end;
`.trimStart();
}

function normalizeForInno(value) {
  return value.replaceAll("\\", "\\\\");
}
