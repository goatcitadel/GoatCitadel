export const PACKAGING_TARGETS = Object.freeze({
  "windows-x64": Object.freeze({
    target: "windows-x64",
    platform: "windows",
    arch: "x64",
    nodePlatform: "win",
    nodeArch: "x64",
    nodeArchiveType: "zip",
    nodeExecutableName: "node.exe",
    tauriTriple: "x86_64-pc-windows-msvc",
    tauriDesktopArtifactName: "GoatCitadel-Mission-Control-Desktop.exe",
    windowsRid: "win-x64",
    windowsHostKind: "winui3-windows-app-sdk",
    desktopArtifactName: "GoatCitadel-Mission-Control-Windows.exe",
    bundleDesktopHost: true,
  }),
  "windows-arm64": Object.freeze({
    target: "windows-arm64",
    platform: "windows",
    arch: "arm64",
    nodePlatform: "win",
    nodeArch: "arm64",
    nodeArchiveType: "zip",
    nodeExecutableName: "node.exe",
    tauriTriple: "aarch64-pc-windows-msvc",
    tauriDesktopArtifactName: "GoatCitadel-Mission-Control-Desktop.exe",
    windowsRid: "win-arm64",
    windowsHostKind: "winui3-windows-app-sdk",
    desktopArtifactName: "GoatCitadel-Mission-Control-Windows.exe",
    bundleDesktopHost: true,
  }),
  "macos-arm64": Object.freeze({
    target: "macos-arm64",
    platform: "darwin",
    arch: "arm64",
    nodePlatform: "darwin",
    nodeArch: "arm64",
    nodeArchiveType: "tar.gz",
    nodeExecutableName: "node",
    tauriTriple: "aarch64-apple-darwin",
    desktopArtifactName: "GoatCitadel Mission Control.app",
    bundleDesktopHost: false,
  }),
  "linux-x64": Object.freeze({
    target: "linux-x64",
    platform: "linux",
    arch: "x64",
    nodePlatform: "linux",
    nodeArch: "x64",
    nodeArchiveType: "tar.gz",
    nodeExecutableName: "node",
    desktopArtifactName: "goatcitadel",
    bundleDesktopHost: false,
  }),
});

export function requirePackagingTarget(target, options = {}) {
  const allowedTargets = options.allowedTargets ?? Object.keys(PACKAGING_TARGETS);
  if (!target || !allowedTargets.includes(target) || !PACKAGING_TARGETS[target]) {
    throw new Error(`Unsupported target: ${target ?? "(missing)"}. Supported targets: ${allowedTargets.join(", ")}`);
  }
  return PACKAGING_TARGETS[target];
}

export function nodeArchiveName(nodeVersion, targetInfo) {
  const normalizedVersion = nodeVersion.startsWith("v") ? nodeVersion : `v${nodeVersion}`;
  const baseName = `node-${normalizedVersion}-${targetInfo.nodePlatform}-${targetInfo.nodeArch}`;
  return targetInfo.nodeArchiveType === "zip" ? `${baseName}.zip` : `${baseName}.tar.gz`;
}

export function nodeArchiveRoot(nodeVersion, targetInfo) {
  const normalizedVersion = nodeVersion.startsWith("v") ? nodeVersion : `v${nodeVersion}`;
  return `node-${normalizedVersion}-${targetInfo.nodePlatform}-${targetInfo.nodeArch}`;
}
