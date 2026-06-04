import assert from "node:assert/strict";
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

test("macOS Tauri overlay can use a Developer ID identity for notarized CI DMGs", () => {
  const bundleDir = path.join(os.tmpdir(), "GoatCitadel-1.0.0-macos-arm64");
  const config = renderMacTauriConfig({
    bundleDir,
    version: "1.0.0",
    signingIdentity: "Developer ID Application: GoatCitadel Test (TEAMID)",
  });

  assert.equal(config.bundle.macOS.signingIdentity, "Developer ID Application: GoatCitadel Test (TEAMID)");
});

test("root package exposes package:macos without changing Windows scripts", () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(packageJson.scripts["package:macos"], "node scripts/packaging/build-macos-native-installer.mjs");
  assert.equal(packageJson.scripts["package:windows"], "node scripts/packaging/build-windows-native-installer.mjs");
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
