export const RELEASE_MANIFEST_SCHEMA_VERSION = 2;
export const RELEASE_MANIFEST_PRODUCT = "GoatCitadel";
export const RELEASE_PAYLOAD_ROOTS = Object.freeze(["app", "bin"]);
export const RELEASE_DETACHED_METADATA_FILES = Object.freeze(["app/release-manifest.json"]);
export const RELEASE_DETACHED_METADATA_TREES = Object.freeze(["app/release-evidence"]);
export const RELEASE_PAYLOAD_LIMITS = Object.freeze({
  maxManifestBytes: 16 * 1024 * 1024,
  maxFiles: 100_000,
  maxTotalBytes: 8 * 1024 * 1024 * 1024,
  maxFileBytes: 2 * 1024 * 1024 * 1024,
  maxPathLength: 1_024,
});

const FULL_GIT_SHA = /^[a-f0-9]{40}$/u;
const SHA256 = /^[a-f0-9]{64}$/u;

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
  payloadFiles,
  uiTarget,
  includeDesktopHost,
  desktopArtifactName,
  windowsIdentityPackage = null,
  sourceCommit = null,
  sourceModified = null,
}) {
  const normalizedPayloadFiles = normalizeReleasePayloadFiles(payloadFiles, {
    platform: targetInfo.platform,
  });
  const payloadTotalBytes = normalizedPayloadFiles.reduce((total, file) => total + file.sizeBytes, 0);
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
      targetInfo.windowsHostKind === "winui3-windows-app-sdk"
        ? "mission-control-windows-host"
        : "mission-control-desktop";
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

  if (windowsIdentityPackage) {
    components.splice(4, 0, {
      id: "mission-control-windows-identity-package",
      kind: "msix-external-location-identity",
      required: true,
      path: windowsIdentityPackage.path,
      packageName: windowsIdentityPackage.packageName,
      applicationId: windowsIdentityPackage.applicationId,
      protocol: windowsIdentityPackage.protocol,
      signed: windowsIdentityPackage.signed,
      description:
        "Signed sparse MSIX identity package for Windows App SDK notifications, protocol activation, and package identity with external runtime files.",
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
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
    product: RELEASE_MANIFEST_PRODUCT,
    version,
    sourceCommit,
    sourceModified,
    platform: targetInfo.platform,
    arch: targetInfo.arch,
    target: targetInfo.target,
    components,
    payload: {
      algorithm: "sha256",
      roots: [...RELEASE_PAYLOAD_ROOTS],
      detachedMetadataFiles: [...RELEASE_DETACHED_METADATA_FILES],
      detachedMetadataTrees: [...RELEASE_DETACHED_METADATA_TREES],
      fileCount: normalizedPayloadFiles.length,
      totalBytes: payloadTotalBytes,
      files: normalizedPayloadFiles,
    },
    launcher,
  };
  if (targetInfo.platform === "darwin" || targetInfo.platform === "linux") {
    manifest.experimental = true;
  }
  validateReleaseManifest(manifest, { targetInfo });
  return manifest;
}

export function validateReleaseManifest(
  manifest,
  { targetInfo, expectedVersion, expectedCommit, requireCleanSource = false } = {},
) {
  if (!isRecord(manifest)) {
    throw new Error("Release manifest must be a JSON object.");
  }
  if (manifest.schemaVersion !== RELEASE_MANIFEST_SCHEMA_VERSION || manifest.product !== RELEASE_MANIFEST_PRODUCT) {
    throw new Error(`Release manifest must use ${RELEASE_MANIFEST_PRODUCT} schema ${RELEASE_MANIFEST_SCHEMA_VERSION}.`);
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0 || manifest.version.length > 80) {
    throw new Error("Release manifest version is invalid.");
  }
  if (expectedVersion !== undefined && manifest.version !== expectedVersion) {
    throw new Error(`Release manifest version ${manifest.version} does not match ${expectedVersion}.`);
  }
  if (typeof manifest.sourceCommit !== "string" || !FULL_GIT_SHA.test(manifest.sourceCommit)) {
    throw new Error("Release manifest sourceCommit must be a lowercase full Git SHA.");
  }
  if (expectedCommit !== undefined && manifest.sourceCommit !== String(expectedCommit).toLowerCase()) {
    throw new Error(`Release manifest sourceCommit ${manifest.sourceCommit} does not match ${expectedCommit}.`);
  }
  if (typeof manifest.sourceModified !== "boolean") {
    throw new Error("Release manifest sourceModified must be a boolean.");
  }
  if (requireCleanSource && manifest.sourceModified) {
    throw new Error("Release manifest was produced from modified source.");
  }
  if (!targetInfo || manifest.target !== targetInfo.target) {
    throw new Error(`Release manifest target ${String(manifest.target)} does not match the requested target.`);
  }
  if (manifest.platform !== targetInfo.platform || manifest.arch !== targetInfo.arch) {
    throw new Error(
      `Release manifest platform/arch ${String(manifest.platform)}/${String(manifest.arch)} does not match ` +
        `${targetInfo.platform}/${targetInfo.arch}.`,
    );
  }
  if (
    !Array.isArray(manifest.components) ||
    manifest.components.length > 128 ||
    manifest.components.some((component) => !isRecord(component))
  ) {
    throw new Error("Release manifest components must be a bounded object array.");
  }
  if (!isRecord(manifest.launcher)) {
    throw new Error("Release manifest launcher must be an object.");
  }

  const payload = manifest.payload;
  if (!isRecord(payload) || payload.algorithm !== "sha256") {
    throw new Error("Release manifest payload must use SHA-256.");
  }
  requireExactStringArray(payload.roots, RELEASE_PAYLOAD_ROOTS, "payload roots");
  requireExactStringArray(payload.detachedMetadataFiles, RELEASE_DETACHED_METADATA_FILES, "detached metadata files");
  requireExactStringArray(payload.detachedMetadataTrees, RELEASE_DETACHED_METADATA_TREES, "detached metadata trees");
  const files = validateReleasePayloadFiles(payload.files, {
    platform: targetInfo.platform,
    requireSorted: true,
  });
  const totalBytes = files.reduce((total, file) => total + file.sizeBytes, 0);
  if (payload.fileCount !== files.length || payload.totalBytes !== totalBytes) {
    throw new Error("Release manifest payload count/byte summaries do not match its file records.");
  }
  return { files, fileCount: files.length, totalBytes };
}

export function normalizeReleasePayloadFiles(files, { platform } = {}) {
  return validateReleasePayloadFiles(files, { platform, requireSorted: false }).sort((left, right) =>
    compareStrings(left.path, right.path),
  );
}

export function isDetachedReleaseMetadataPath(relativePath) {
  if (RELEASE_DETACHED_METADATA_FILES.includes(relativePath)) {
    return true;
  }
  return RELEASE_DETACHED_METADATA_TREES.some((tree) => relativePath === tree || relativePath.startsWith(`${tree}/`));
}

function validateReleasePayloadFiles(files, { platform, requireSorted }) {
  if (!Array.isArray(files) || files.length === 0 || files.length > RELEASE_PAYLOAD_LIMITS.maxFiles) {
    throw new Error(`Release manifest payload must contain 1-${RELEASE_PAYLOAD_LIMITS.maxFiles} file records.`);
  }
  const seen = new Set();
  const seenCaseFolded = new Set();
  let previousPath = null;
  let totalBytes = 0;
  const normalized = files.map((file) => {
    if (!isRecord(file)) {
      throw new Error("Release manifest payload contains a non-object file record.");
    }
    const payloadPath = validatePayloadPath(file.path);
    if (
      isDetachedReleaseMetadataPath(payloadPath) ||
      (platform === "windows" && isDetachedReleaseMetadataPath(payloadPath.toLowerCase()))
    ) {
      throw new Error(`Release manifest payload cannot include detached metadata: ${payloadPath}`);
    }
    if (seen.has(payloadPath)) {
      throw new Error(`Release manifest payload contains a duplicate path: ${payloadPath}`);
    }
    seen.add(payloadPath);
    if (platform === "windows") {
      const caseFolded = payloadPath.toLowerCase();
      if (seenCaseFolded.has(caseFolded)) {
        throw new Error(`Release manifest payload contains a Windows case-fold collision: ${payloadPath}`);
      }
      seenCaseFolded.add(caseFolded);
    }
    if (requireSorted && previousPath !== null && compareStrings(previousPath, payloadPath) >= 0) {
      throw new Error("Release manifest payload file records must be strictly path-sorted.");
    }
    previousPath = payloadPath;
    if (typeof file.sha256 !== "string" || !SHA256.test(file.sha256)) {
      throw new Error(`Release manifest payload hash is invalid for ${payloadPath}.`);
    }
    if (
      !Number.isSafeInteger(file.sizeBytes) ||
      file.sizeBytes < 0 ||
      file.sizeBytes > RELEASE_PAYLOAD_LIMITS.maxFileBytes
    ) {
      throw new Error(`Release manifest payload size is invalid for ${payloadPath}.`);
    }
    totalBytes += file.sizeBytes;
    if (!Number.isSafeInteger(totalBytes) || totalBytes > RELEASE_PAYLOAD_LIMITS.maxTotalBytes) {
      throw new Error(`Release manifest payload exceeds ${RELEASE_PAYLOAD_LIMITS.maxTotalBytes} bytes.`);
    }
    return {
      path: payloadPath,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
    };
  });
  return normalized;
}

function validatePayloadPath(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value, "utf8") > RELEASE_PAYLOAD_LIMITS.maxPathLength ||
    value.includes("\0") ||
    value.includes("\\") ||
    Buffer.from(value, "utf8").toString("utf8") !== value ||
    value.startsWith("/") ||
    value.startsWith("//") ||
    /^[a-z]:/iu.test(value)
  ) {
    throw new Error(`Release manifest payload path is unsafe: ${String(value)}`);
  }
  const segments = value.split("/");
  if (
    !RELEASE_PAYLOAD_ROOTS.includes(segments[0]) ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
  ) {
    throw new Error(`Release manifest payload path is unsafe: ${value}`);
  }
  return segments.join("/");
}

function requireExactStringArray(actual, expected, label) {
  if (
    !Array.isArray(actual) ||
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    throw new Error(`Release manifest ${label} do not match the fixed verifier policy.`);
  }
}

function compareStrings(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function isRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
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
