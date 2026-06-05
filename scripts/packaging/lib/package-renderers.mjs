export function renderWindowsLaunchers() {
  const cmd = [
    "@echo off",
    "setlocal",
    'set "SCRIPT_DIR=%~dp0"',
    'for %%I in ("%SCRIPT_DIR%..") do set "GOATCITADEL_HOME=%%~fI"',
    '"%GOATCITADEL_HOME%\\app\\runtime\\node\\node.exe" "%GOATCITADEL_HOME%\\app\\bin\\goatcitadel.mjs" %*',
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");

  const ps1 = [
    "param(",
    "  [Parameter(ValueFromRemainingArguments = $true)]",
    "  [string[]]$Args",
    ")",
    "$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path",
    "$goatHome = Resolve-Path (Join-Path $scriptDir '..')",
    "$env:GOATCITADEL_HOME = $goatHome",
    "& (Join-Path $goatHome 'app\\runtime\\node\\node.exe') (Join-Path $goatHome 'app\\bin\\goatcitadel.mjs') @Args",
    "",
  ].join("\r\n");

  return { cmd, ps1 };
}

export function renderPosixLauncher() {
  return [
    "#!/usr/bin/env sh",
    "set -eu",
    'SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)',
    'BUNDLE_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)',
    'if [ "$(uname -s)" = "Darwin" ] && [ -z "${GOATCITADEL_HOME:-}" ]; then',
    '  GOATCITADEL_HOME="${HOME}/Library/Application Support/GoatCitadel"',
    '  export GOATCITADEL_APP_DIR="${BUNDLE_ROOT}/app"',
    "else",
    '  GOATCITADEL_HOME="${GOATCITADEL_HOME:-${BUNDLE_ROOT}}"',
    "fi",
    "export GOATCITADEL_HOME",
    'exec "${BUNDLE_ROOT}/app/runtime/node/node" "${BUNDLE_ROOT}/app/bin/goatcitadel.mjs" "$@"',
    "",
  ].join("\n");
}

export function buildReleaseManifest({
  targetInfo,
  version,
  nodeVersion,
  checksums,
  uiTarget,
  includeDesktopHost,
  desktopArtifactName,
}) {
  const embeddedNodePath = `app/runtime/node/${targetInfo.nodeExecutableName}`;
  const components = [
    {
      id: "core-runtime",
      required: true,
      path: "app/gateway",
      description: "Compiled GoatCitadel gateway runtime with production dependencies.",
    },
    {
      id: "mission-control",
      required: true,
      path: "app/mission-control/dist",
      uiTarget: {
        packageName: uiTarget.packageName,
        packageDirName: uiTarget.packageDirName,
        displayName: uiTarget.displayName,
        compatibilityPath: true,
      },
      description: `Built ${uiTarget.displayName} operator surface.`,
    },
    {
      id: "embedded-node",
      required: true,
      version: nodeVersion,
      path: embeddedNodePath,
      description: "Embedded Node runtime used by the packaged launcher.",
    },
    {
      id: "chromium-runtime",
      required: false,
      description: "Installer-managed Playwright Chromium runtime.",
    },
    {
      id: "voice-runtime",
      required: false,
      description: "Installer-managed local voice runtime.",
    },
  ];

  if (includeDesktopHost) {
    const desktopHostKind = targetInfo.windowsHostKind ?? "native-desktop-host";
    const desktopHostId =
      targetInfo.windowsHostKind === "winui3-windows-app-sdk" ? "mission-control-windows-host" : "mission-control-desktop";
    const desktopDescription =
      targetInfo.windowsHostKind === "winui3-windows-app-sdk"
        ? "Windows App SDK / WinUI 3 desktop host for Mission Control, tray controls, runtime recovery, local notifications, and protocol activation."
        : "Native desktop host for Mission Control, tray controls, runtime recovery, and local notifications.";
    components.splice(3, 0, {
      id: desktopHostId,
      kind: desktopHostKind,
      required: true,
      path: `app/desktop/${desktopArtifactName}`,
      description: desktopDescription,
    });
  }

  const launcher = {
    command: "goatcitadel launch",
    desktop: includeDesktopHost
      ? `app/desktop/${desktopArtifactName}`
      : targetInfo.platform === "darwin"
        ? "macos-app-bundle"
        : "browser-launcher",
  };
  if (targetInfo.platform === "windows") {
    launcher.windows = "bin/goatcitadel.cmd";
  } else {
    launcher.posix = "bin/goatcitadel";
  }

  const manifest = {
    version,
    platform: targetInfo.platform,
    arch: targetInfo.arch,
    target: targetInfo.target,
    components,
    checksums,
    launcher,
  };
  if (targetInfo.platform === "darwin" || targetInfo.platform === "linux") {
    manifest.experimental = true;
  }
  return manifest;
}

export function renderMacTauriConfig({ bundleDir, version, signingIdentity = "-" }) {
  return {
    version,
    bundle: {
      active: true,
      targets: ["dmg"],
      macOS: {
        files: {
          "Resources/goatcitadel": bundleDir,
        },
        minimumSystemVersion: "13.0",
        signingIdentity,
        dmg: {
          appPosition: { x: 180, y: 220 },
          applicationFolderPosition: { x: 480, y: 220 },
          windowSize: { width: 660, height: 400 },
        },
      },
    },
  };
}
