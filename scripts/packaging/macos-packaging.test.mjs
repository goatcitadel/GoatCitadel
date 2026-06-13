import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  nodeArchiveName,
  PACKAGING_TARGETS,
  requirePackagingTarget,
} from "./lib/packaging-targets.mjs";
import {
  buildReleaseManifest,
  renderMacTauriConfig,
  renderPosixLauncher,
  renderWindowsLaunchers,
} from "./lib/package-renderers.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");

test("macos-arm64 target maps to Apple Silicon, Darwin, and the macOS Tauri triple", () => {
  const target = requirePackagingTarget("macos-arm64");
  assert.equal(target.tauriTriple, "aarch64-apple-darwin");
  assert.equal(target.platform, "darwin");
  assert.equal(target.arch, "arm64");
  assert.equal(target.nodePlatform, "darwin");
  assert.equal(target.nodeArch, "arm64");
  assert.equal(target.nodeExecutableName, "node");
  assert.equal(target.bundleDesktopHost, false);
  assert.equal(nodeArchiveName("v22.1.0", target), "node-v22.1.0-darwin-arm64.tar.gz");
});

test("Windows target metadata remains signed-installer compatible", () => {
  const target = requirePackagingTarget("windows-x64");
  assert.equal(target.tauriTriple, "x86_64-pc-windows-msvc");
  assert.equal(target.tauriDesktopArtifactName, "GoatCitadel-Mission-Control-Desktop.exe");
  assert.equal(target.windowsRid, "win-x64");
  assert.equal(target.windowsHostKind, "winui3-windows-app-sdk");
  assert.equal(target.desktopArtifactName, "GoatCitadel-Mission-Control-Windows.exe");
  assert.equal(target.platform, "windows");
  assert.equal(target.nodeExecutableName, "node.exe");
  assert.equal(target.bundleDesktopHost, true);
  assert.equal(nodeArchiveName("v22.1.0", target), "node-v22.1.0-win-x64.zip");

  const launchers = renderWindowsLaunchers();
  assert.match(launchers.cmd, /node\.exe/);
  assert.match(launchers.ps1, /GOATCITADEL_HOME/);

  const manifest = buildReleaseManifest({
    targetInfo: target,
    version: "1.0.0",
    nodeVersion: "v22.1.0",
    checksums: { "bin/goatcitadel.cmd": "abc123" },
    uiTarget: {
      packageName: "@goatcitadel/mission-control-next",
      packageDirName: "mission-control-next",
      displayName: "Mission Control Next",
    },
    includeDesktopHost: true,
    desktopArtifactName: target.desktopArtifactName,
  });
  assert.equal(Object.hasOwn(manifest, "experimental"), false);
  assert.equal(manifest.launcher.windows, "bin/goatcitadel.cmd");
  assert.equal(manifest.launcher.desktop, "app/desktop/GoatCitadel-Mission-Control-Windows.exe");
  const desktopHost = manifest.components.find((item) => item.id === "mission-control-windows-host");
  assert.equal(desktopHost?.kind, "winui3-windows-app-sdk");
  assert.equal(desktopHost?.path, "app/desktop/GoatCitadel-Mission-Control-Windows.exe");
});

test("Windows release manifest can carry the signed sparse identity package", () => {
  const target = requirePackagingTarget("windows-x64");
  const manifest = buildReleaseManifest({
    targetInfo: target,
    version: "1.0.0",
    nodeVersion: "v22.1.0",
    checksums: {
      "app/identity/GoatCitadel-Mission-Control-Windows-Identity.msix": "abc123",
    },
    uiTarget: {
      packageName: "@goatcitadel/mission-control-next",
      packageDirName: "mission-control-next",
      displayName: "Mission Control Next",
    },
    includeDesktopHost: true,
    desktopArtifactName: target.desktopArtifactName,
    windowsIdentityPackage: {
      path: "app/identity/GoatCitadel-Mission-Control-Windows-Identity.msix",
      packageName: "GoatCitadel.MissionControl.Windows",
      applicationId: "App",
      protocol: "goatcitadel",
      signed: true,
    },
  });

  const identityPackage = manifest.components.find((item) => item.id === "mission-control-windows-identity-package");
  assert.equal(identityPackage?.kind, "msix-external-location-identity");
  assert.equal(identityPackage?.path, "app/identity/GoatCitadel-Mission-Control-Windows-Identity.msix");
  assert.equal(identityPackage?.packageName, "GoatCitadel.MissionControl.Windows");
  assert.equal(identityPackage?.applicationId, "App");
  assert.equal(identityPackage?.protocol, "goatcitadel");
  assert.equal(identityPackage?.signed, true);
});

test("Windows host manifests declare matching external-location package identity", () => {
  const appManifest = fs.readFileSync(path.join(repoRoot, "apps", "mission-control-windows", "app.manifest"), "utf8");
  const packageManifest = fs.readFileSync(
    path.join(repoRoot, "apps", "mission-control-windows", "Package.appxmanifest"),
    "utf8",
  );
  const hostBuilder = fs.readFileSync(path.join(repoRoot, "scripts", "packaging", "build-windows-host.mjs"), "utf8");
  const releaseWorkflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "release-installers.yml"), "utf8");

  assert.match(appManifest, /packageName="GoatCitadel\.MissionControl\.Windows"/);
  assert.match(appManifest, /applicationId="App"/);
  assert.match(packageManifest, /ProcessorArchitecture="neutral"/);
  assert.match(packageManifest, /<uap10:AllowExternalContent>true<\/uap10:AllowExternalContent>/);
  assert.match(packageManifest, /Executable="app\\desktop\\GoatCitadel-Mission-Control-Windows\.exe"/);
  assert.match(packageManifest, /<uap:Protocol Name="goatcitadel" \/>/);
  assert.match(hostBuilder, /GOATCITADEL_WINDOWS_MSIX_PUBLISHER/);
  assert.match(hostBuilder, /-p:ApplicationManifest=/);
  assert.match(releaseWorkflow, /GOATCITADEL_WINDOWS_MSIX_PUBLISHER/);
  assert.match(releaseWorkflow, /vars\.WINDOWS_MSIX_PUBLISHER/);
});

test("Windows native installer replaces payload without deleting packaged runtime state", () => {
  const installerBuilder = fs.readFileSync(
    path.join(repoRoot, "scripts", "packaging", "build-windows-native-installer.mjs"),
    "utf8",
  );

  assert.match(installerBuilder, /\[InstallDelete\]/);
  assert.match(installerBuilder, /Type: filesandordirs; Name: "\{app\}\\\\app"/);
  assert.match(installerBuilder, /Type: filesandordirs; Name: "\{app\}\\\\bin"/);
  assert.doesNotMatch(installerBuilder, /InstallDelete\][\s\S]*runtime-root/);
  assert.match(installerBuilder, /Get-AppxPackage \{#MyIdentityPackageName\} \| Remove-AppxPackage/);
  assert.match(installerBuilder, /if \(Test-Path -LiteralPath \$package\) \{\{ Add-AppxPackage/);
});

test("POSIX launcher keeps macOS mutable state under Application Support", () => {
  const launcher = renderPosixLauncher();
  assert.match(launcher, /^#!\/usr\/bin\/env sh/);
  assert.match(launcher, /\$\{HOME\}\/Library\/Application Support\/GoatCitadel/);
  assert.match(launcher, /GOATCITADEL_APP_DIR="\$\{BUNDLE_ROOT\}\/app"/);
  assert.match(launcher, /app\/runtime\/node\/node/);
  assert.doesNotMatch(launcher, /node\.exe/);
});

test("macOS release manifest is experimental and does not claim bundled desktop executable proof", () => {
  const manifest = buildReleaseManifest({
    targetInfo: PACKAGING_TARGETS["macos-arm64"],
    version: "1.0.0",
    nodeVersion: "v22.1.0",
    checksums: { "bin/goatcitadel": "abc123" },
    uiTarget: {
      packageName: "@goatcitadel/mission-control-next",
      packageDirName: "mission-control-next",
      displayName: "Mission Control Next",
    },
    includeDesktopHost: false,
    desktopArtifactName: "GoatCitadel Mission Control.app",
  });

  assert.equal(manifest.platform, "darwin");
  assert.equal(manifest.arch, "arm64");
  assert.equal(manifest.experimental, true);
  assert.equal(manifest.launcher.posix, "bin/goatcitadel");
  assert.equal(manifest.launcher.desktop, "macos-app-bundle");
  assert.equal(manifest.components.find((item) => item.id === "embedded-node")?.path, "app/runtime/node/node");
  assert.equal(manifest.components.some((item) => item.id === "mission-control-desktop"), false);
});

test("linux-x64 bundle target emits a POSIX browser launcher without release-proof claims", () => {
  const target = requirePackagingTarget("linux-x64");
  assert.equal(target.platform, "linux");
  assert.equal(target.arch, "x64");
  assert.equal(target.nodePlatform, "linux");
  assert.equal(target.nodeArch, "x64");
  assert.equal(target.nodeExecutableName, "node");
  assert.equal(target.bundleDesktopHost, false);
  assert.equal(nodeArchiveName("v22.1.0", target), "node-v22.1.0-linux-x64.tar.gz");

  const manifest = buildReleaseManifest({
    targetInfo: target,
    version: "1.0.0",
    nodeVersion: "v22.1.0",
    checksums: { "bin/goatcitadel": "abc123" },
    uiTarget: {
      packageName: "@goatcitadel/mission-control-next",
      packageDirName: "mission-control-next",
      displayName: "Mission Control Next",
    },
    includeDesktopHost: false,
    desktopArtifactName: target.desktopArtifactName,
  });

  assert.equal(manifest.platform, "linux");
  assert.equal(manifest.arch, "x64");
  assert.equal(manifest.experimental, true);
  assert.equal(manifest.launcher.posix, "bin/goatcitadel");
  assert.equal(manifest.launcher.desktop, "browser-launcher");
  assert.equal(manifest.components.some((item) => item.id === "mission-control-desktop"), false);
});

test("macOS Tauri overlay embeds the runtime bundle and uses ad-hoc signing", () => {
  const bundleDir = path.join(os.tmpdir(), "GoatCitadel-1.0.0-macos-arm64");
  const config = renderMacTauriConfig({ bundleDir, version: "1.0.0" });
  assert.equal(config.bundle.active, true);
  assert.deepEqual(config.bundle.targets, ["dmg"]);
  assert.equal(config.bundle.macOS.files["Resources/goatcitadel"], bundleDir);
  assert.equal(config.bundle.macOS.minimumSystemVersion, "13.0");
  assert.equal(config.bundle.macOS.signingIdentity, "-");
});

test("macOS Tauri icon asset exists for generate_context", () => {
  const iconPath = path.join(repoRoot, "apps", "mission-control-desktop", "src-tauri", "icons", "icon.png");
  assert.ok(fs.statSync(iconPath).size > 0);
});

test("macOS Tauri overlay can use a Developer ID identity for notarized CI DMGs", () => {
  const bundleDir = path.join(os.tmpdir(), "GoatCitadel-1.0.0-macos-arm64");
  const config = renderMacTauriConfig({
    bundleDir,
    version: "1.0.0",
    signingIdentity: "Developer ID Application: GoatCitadel Test (TEAMID)",
  });

  assert.equal(config.bundle.macOS.signingIdentity, "Developer ID Application: GoatCitadel Test (TEAMID)");
});

test("macOS native installer reports missing rustup and caches DMG stat lookups", () => {
  const source = fs.readFileSync(path.join(repoRoot, "scripts", "packaging", "build-macos-native-installer.mjs"), "utf8");

  assert.match(source, /console\.warn\(`\[packaging\] rustup not found; skipping Rust target installation for \$\{triple\}\.`\)/);
  assert.match(source, /const matchesWithStats = matches\.map/);
  assert.match(source, /matchesWithStats\.sort\(\(left, right\) => right\.mtimeMs - left\.mtimeMs\)/);
  assert.doesNotMatch(source, /matches\.sort\(\(left, right\) => fs\.statSync\(right\)\.mtimeMs/);
});

test("root package exposes native packaging scripts and Windows test hang guard", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["package:macos"], "node scripts/packaging/build-macos-native-installer.mjs");
  assert.equal(packageJson.scripts["package:windows"], "node scripts/packaging/build-windows-native-installer.mjs");
  assert.equal(packageJson.scripts["package:windows-host"], "node scripts/packaging/build-windows-host.mjs");
  assert.equal(packageJson.scripts["package:windows-msix"], "node scripts/packaging/build-windows-msix.mjs");
  assert.match(packageJson.scripts["windows:test"], /--blame-hang-timeout 10m/);
});

test("Windows native installer script escapes PowerShell script blocks for Inno", () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-windows-installer-"));
  const bundleDir = path.join(tempRoot, "bundle");
  const outDir = path.join(tempRoot, "out");
  try {
    fs.mkdirSync(bundleDir, { recursive: true });

    const result = spawnSync(process.execPath, [
      path.join(repoRoot, "scripts", "packaging", "build-windows-native-installer.mjs"),
      "--target",
      "windows-x64",
      "--bundle-dir",
      bundleDir,
      "--out-dir",
      outDir,
      "--emit-only",
    ], {
      cwd: repoRoot,
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
    const iss = fs.readFileSync(path.join(outDir, "GoatCitadel-windows-x64.iss"), "utf8");
    assert.match(iss, /procedure RunOrFail/);
    assert.match(iss, /procedure CurStepChanged/);
    assert.match(iss, /RaiseException\(FileName \+ ' exited with code '/);
    assert.match(iss, /InstallChromiumRuntime/);
    assert.match(iss, /InstallVoiceRuntime/);
    assert.doesNotMatch(iss, /Filename: "\{app\}\\app\\runtime\\node\\node\.exe"; Parameters:/);
    assert.match(iss, /Get-AppxPackage \{#MyIdentityPackageName\} \| Remove-AppxPackage -ErrorAction SilentlyContinue; \$package = Join-Path/);
    assert.match(iss, /if \(Test-Path -LiteralPath \$package\) \{\{ Add-AppxPackage -Path \$package -ExternalLocation ''\{app\}''/);
    assert.match(iss, /Add-AppxPackage -Path \$package -ExternalLocation ''\{app\}'' \}\}"/);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("launcher source documents the macOS Application Support default", () => {
  const source = fs.readFileSync(path.join(repoRoot, "bin", "goatcitadel.mjs"), "utf8");
  assert.match(source, /Library", "Application Support", "GoatCitadel"/);
  assert.match(source, /GOATCITADEL_APP_DIR/);
});

test("release workflow carries experimental macOS and Linux packaging promotion lanes", () => {
  const workflow = fs.readFileSync(path.join(repoRoot, ".github", "workflows", "release-installers.yml"), "utf8");
  assert.match(workflow, /name:\s*Release Installers and Bundles/);
  assert.match(workflow, /pnpm package:macos --target macos-arm64 --notarize/);
  assert.match(workflow, /macos-arm64-experimental-release-assets/);
  assert.match(workflow, /pnpm package:bundle --target linux-x64 --skip-desktop/);
  assert.match(workflow, /linux-x64-experimental-release-assets/);
  assert.match(workflow, /GoatCitadel-\$\{PACKAGE_VERSION\}-linux-x64\.tar\.gz/);
});
