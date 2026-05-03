#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

const supportedTargets = {
  "windows-x64": "x64compatible",
  "windows-arm64": "arm64",
};

const args = parseArgs(process.argv.slice(2));
const target = args.target;
if (!target || !supportedTargets[target]) {
  printUsage();
  process.exit(1);
}

const version = args.version || packageJson.version;
const outDir = path.resolve(args.outDir || path.join(repoRoot, "artifacts", "installers", "windows"));
const bundleDir = path.resolve(
  args.bundleDir ||
  path.join(repoRoot, "artifacts", "installers", "bundles", `GoatCitadel-${version}-${target}`),
);
const issPath = path.join(outDir, `GoatCitadel-${target}.iss`);
const bundleZipPath = path.join(outDir, `GoatCitadel-${target}.zip`);

if (!fs.existsSync(bundleDir)) {
  throw new Error(`Bundle directory does not exist: ${bundleDir}`);
}

fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(issPath, renderIss({
  target,
  architecture: supportedTargets[target],
  version,
  bundleZipPath,
  outDir,
}), "utf8");

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
  console.log("Usage: node scripts/packaging/build-windows-native-installer.mjs --target <windows-x64|windows-arm64> [--version <semver>] [--bundle-dir <dir>] [--out-dir <dir>] [--emit-only]");
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

function renderIss({ target: bundleTarget, architecture, version: bundleVersion, bundleZipPath: currentBundleZipPath, outDir: currentOutDir }) {
  return `
#define MyAppName "GoatCitadel"
#define MyAppVersion "${bundleVersion}"
#define MyAppPublisher "GoatCitadel"
#define MyAppURL "https://github.com/goatcitadel/GoatCitadel"
#define MyBundleZip "${normalizeForInno(currentBundleZipPath)}"
#define MyOutputDir "${normalizeForInno(currentOutDir)}"
#define MyDesktopExe "app\\desktop\\GoatCitadel-Mission-Control-Desktop.exe"

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
Source: "{#MyBundleZip}"; DestDir: "{tmp}"; DestName: "bundle.zip"; Flags: deleteafterinstall

[Icons]
Name: "{autoprograms}\\GoatCitadel"; Filename: "{app}\\{#MyDesktopExe}"; WorkingDir: "{app}"
Name: "{autodesktop}\\GoatCitadel"; Filename: "{app}\\{#MyDesktopExe}"; WorkingDir: "{app}"; Tasks: desktopicon

[Run]
Filename: "powershell.exe"; Parameters: "-NoProfile -ExecutionPolicy Bypass -Command ""Expand-Archive -LiteralPath '{tmp}\\bundle.zip' -DestinationPath '{app}' -Force"""; StatusMsg: "Expanding GoatCitadel bundle..."; Flags: waituntilterminated runhidden
Filename: "{app}\\app\\runtime\\node\\node.exe"; Parameters: """{app}\\app\\gateway\\node_modules\\playwright\\cli.js"" install chromium"; WorkingDir: "{app}\\app\\gateway"; StatusMsg: "Installing Chromium runtime..."; Flags: waituntilterminated runhidden skipifsilent; Components: chromium
Filename: "{app}\\app\\runtime\\node\\node.exe"; Parameters: """{app}\\app\\gateway\\dist\\voice-runtime-cli.js"" install --model base.en"; WorkingDir: "{app}\\app\\gateway"; StatusMsg: "Installing local voice runtime..."; Flags: waituntilterminated runhidden skipifsilent; Components: voice
Filename: "{app}\\{#MyDesktopExe}"; Description: "Launch GoatCitadel"; Flags: nowait postinstall skipifsilent
`.trimStart();
}

function normalizeForInno(value) {
  return value.replaceAll("\\", "\\\\");
}

function toPowershellSingleQuoted(value) {
  return `'${value.replaceAll("'", "''")}'`;
}
