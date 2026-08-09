#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveUiTarget } from "../lib/ui-target.mjs";
import {
  nodeArchiveName,
  nodeArchiveRoot,
  PACKAGING_TARGETS,
  requirePackagingTarget,
} from "./lib/packaging-targets.mjs";
import {
  buildReleaseManifest,
  isDetachedReleaseMetadataPath,
  RELEASE_PAYLOAD_LIMITS,
  renderPosixLauncher,
  renderWindowsLaunchers,
} from "./lib/package-renderers.mjs";
import { assertDesktopArtifactProvenance } from "./lib/desktop-artifact-provenance.mjs";
import { materializeHardLinkedFiles, removeEmptyDirectories } from "./lib/release-payload-ownership.mjs";
import { removeDirectorySafely } from "./safe-cleanup.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

const args = parseArgs(process.argv.slice(2));
const target = args.target;
if (!target || !PACKAGING_TARGETS[target]) {
  printUsage();
  process.exit(1);
}
const targetInfo = requirePackagingTarget(target);

const outDir = path.resolve(args.outDir || path.join(repoRoot, "artifacts", "installers", "bundles"));
const version = args.version || packageJson.version;
const bundleName = `GoatCitadel-${version}-${target}`;
const bundleRoot = path.join(outDir, bundleName);
const appRoot = path.join(bundleRoot, "app");
const gatewayDeployDir = path.join(appRoot, "gateway");
const missionControlDistDir = path.join(appRoot, "mission-control", "dist");
const desktopRuntimeDir = path.join(appRoot, "desktop");
const identityRuntimeDir = path.join(appRoot, "identity");
const desktopExecutableName = targetInfo.desktopArtifactName;
const desktopArtifactPath = path.join(repoRoot, "artifacts", "installers", "desktop", target, desktopExecutableName);
const runtimeNodeDir = path.join(appRoot, "runtime", "node");
const templatesRoot = path.join(appRoot, "templates");
const nodeVersion = args.nodeVersion || process.version;
const uiTarget = resolveUiTarget(repoRoot, process.env);
const WINDOWS_CMD_PATH = "C:\\Windows\\System32\\cmd.exe";
const WINDOWS_TAR_PATH = "C:\\Windows\\System32\\tar.exe";
const includeDesktopHost = targetInfo.bundleDesktopHost && !args.skipDesktop;
const sourceCommit = resolveSourceCommit();
const sourceModified = resolveSourceModified();

await main();
process.exit(0);

async function main() {
  if (!args.skipBuild) {
    runPnpm(["--dir", repoRoot, "build"]);
  }

  removeDirectory(bundleRoot);
  fs.mkdirSync(appRoot, { recursive: true });

  // node-linker=hoisted produces a flat, symlink-free node_modules. The default (isolated)
  // layout relies on symlinks into .pnpm, which do NOT survive the bundle's tar archive +
  // lowest-privilege `tar -x` install on Windows (a non-elevated user cannot create symlinks,
  // and tar dereferences the junctions into real dir copies). Dereferenced @goatcitadel/*
  // workspace packages then cannot reach their third-party deps (docx, mammoth, pptxgenjs,
  // sharp, unpdf, @e965/xlsx, playwright) that lived as sibling symlinks in .pnpm, so the
  // gateway crashes at startup with ERR_MODULE_NOT_FOUND and the installer's Chromium step
  // (node node_modules/playwright/cli.js) fails. Hoisting puts every dependency at the
  // top level as a real directory, which the tar round-trip preserves losslessly.
  // Release payload files must be independently owned. pnpm's default store import
  // strategy may hard-link packages when the store shares a volume with the bundle.
  runPnpm(
    [
      "--dir",
      repoRoot,
      "--filter",
      "@goatcitadel/gateway",
      "deploy",
      "--prod",
      "--legacy",
      "--config.node-linker=hoisted",
      "--config.package-import-method=copy",
      gatewayDeployDir,
    ],
    {
      attempts: 3,
      beforeRetry: () => removeDirectory(gatewayDeployDir),
      retryDelayMs: 2500,
    },
  );
  pruneGatewayDeploy(gatewayDeployDir);
  const materializedGatewayFiles = materializeHardLinkedFiles(gatewayDeployDir);
  if (materializedGatewayFiles > 0) {
    console.log(`Materialized ${materializedGatewayFiles} hard-linked gateway deployment files.`);
  }

  copyFile(path.join(repoRoot, "bin", "goatcitadel.mjs"), path.join(appRoot, "bin", "goatcitadel.mjs"));
  copyFile(path.join(repoRoot, "package.json"), path.join(appRoot, "package.json"));
  copyFile(
    path.join(repoRoot, "scripts", "lib", "ui-target.mjs"),
    path.join(appRoot, "scripts", "lib", "ui-target.mjs"),
  );
  copyFile(
    path.join(repoRoot, "scripts", "lib", "managed-runtime-ownership.mjs"),
    path.join(appRoot, "scripts", "lib", "managed-runtime-ownership.mjs"),
  );
  copyFile(
    path.join(repoRoot, "scripts", "lib", "managed-runtime-lifecycle.mjs"),
    path.join(appRoot, "scripts", "lib", "managed-runtime-lifecycle.mjs"),
  );
  copyIfExists(path.join(repoRoot, "pnpm-lock.yaml"), path.join(appRoot, "pnpm-lock.yaml"));
  copyDirectory(uiTarget.distDir, missionControlDistDir);
  writeUiTargetManifest(appRoot);
  if (includeDesktopHost) {
    copyDesktopExecutable();
  }
  const windowsIdentityPackage = copyWindowsIdentityPackage();
  copyDirectory(path.join(repoRoot, "config"), path.join(templatesRoot, "config"));
  copyIfExists(path.join(repoRoot, ".env.example"), path.join(templatesRoot, ".env.example"));
  copyIfExists(path.join(repoRoot, "skills"), path.join(templatesRoot, "skills"));
  copyIfExists(path.join(repoRoot, "workspaces"), path.join(templatesRoot, "workspaces"));
  copyFile(
    path.join(scriptDir, "runtime", "ui-static-server.mjs"),
    path.join(appRoot, "runtime", "ui-static-server.mjs"),
  );
  await installEmbeddedNodeRuntime({
    target,
    nodeVersion,
    destinationDir: runtimeNodeDir,
  });
  writeLaunchers(bundleRoot);
  const removedEmptyDirectories = removeEmptyDirectories(bundleRoot);
  if (removedEmptyDirectories > 0) {
    console.log(`Removed ${removedEmptyDirectories} empty release payload directories.`);
  }
  await writeReleaseManifest({
    bundleRoot,
    appRoot,
    version,
    nodeVersion,
    windowsIdentityPackage,
  });

  console.log(`Created GoatCitadel bundle: ${bundleRoot}`);
}

function parseArgs(argv) {
  const parsed = {
    skipBuild: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--target") {
      parsed.target = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--out-dir") {
      parsed.outDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--version") {
      parsed.version = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--node-version") {
      parsed.nodeVersion = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--node-sha256") {
      parsed.nodeSha256 = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--skip-build") {
      parsed.skipBuild = true;
      continue;
    }
    if (arg === "--skip-desktop") {
      parsed.skipDesktop = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  return parsed;
}

function printUsage() {
  console.log(
    "Usage: node scripts/packaging/build-bundle.mjs --target <windows-x64|windows-arm64|macos-arm64|linux-x64> [--out-dir <dir>] [--version <semver>] [--node-version <vX.Y.Z>] [--node-sha256 <hex>] [--skip-build] [--skip-desktop]",
  );
}

function runPnpm(pnpmArgs, options = {}) {
  const attempts = options.attempts ?? 1;
  const cmd = process.platform === "win32" ? WINDOWS_CMD_PATH : "pnpm";
  const cmdArgs =
    process.platform === "win32" ? ["/d", "/s", "/c", buildWindowsCommand(["pnpm", ...pnpmArgs])] : pnpmArgs;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const result = spawnSync(cmd, cmdArgs, {
      cwd: repoRoot,
      stdio: "inherit",
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status === 0) {
      return;
    }
    if (attempt < attempts) {
      console.warn(
        `pnpm ${pnpmArgs.join(" ")} exited with code ${result.status}; retrying ${attempt + 1}/${attempts}.`,
      );
      sleepSync(options.retryDelayMs ?? 1000);
      options.beforeRetry?.();
      continue;
    }

    throw new Error(`pnpm ${pnpmArgs.join(" ")} exited with code ${result.status}`);
  }
}

function sleepSync(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

async function installEmbeddedNodeRuntime({ target: bundleTarget, nodeVersion: requestedNodeVersion, destinationDir }) {
  fs.mkdirSync(destinationDir, { recursive: true });
  const normalizedVersion = requestedNodeVersion.startsWith("v") ? requestedNodeVersion : `v${requestedNodeVersion}`;
  const targetInfo = requirePackagingTarget(bundleTarget);
  const runtimeFilename = targetInfo.nodeExecutableName;
  const destinationPath = path.join(destinationDir, runtimeFilename);

  if (
    process.platform === targetInfo.platform &&
    process.arch === targetInfo.arch &&
    process.version === normalizedVersion
  ) {
    fs.copyFileSync(process.execPath, destinationPath);
    if (targetInfo.platform !== "windows") {
      fs.chmodSync(destinationPath, 0o755);
    }
    return;
  }

  const archiveName = nodeArchiveName(normalizedVersion, targetInfo);
  const archiveUrl = `https://nodejs.org/dist/${normalizedVersion}/${archiveName}`;
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-node-runtime-"));
  const archivePath = path.join(tempRoot, archiveName);
  const expandedRoot = path.join(tempRoot, "expanded");

  const response = await fetch(archiveUrl);
  if (!response.ok) {
    throw new Error(`Failed to download embedded Node runtime from ${archiveUrl} (${response.status})`);
  }
  const archiveBuffer = Buffer.from(await response.arrayBuffer());
  await verifyNodeArchiveChecksum({
    archiveName,
    archiveUrl,
    archiveBuffer,
    expectedSha256: args.nodeSha256,
  });
  fs.writeFileSync(archivePath, archiveBuffer);
  fs.mkdirSync(expandedRoot, { recursive: true });

  expandNodeRuntimeArchive({ archivePath, expandedRoot, targetInfo });

  const extractedNodePath =
    targetInfo.nodeArchiveType === "zip"
      ? path.join(expandedRoot, nodeArchiveRoot(normalizedVersion, targetInfo), "node.exe")
      : path.join(expandedRoot, nodeArchiveRoot(normalizedVersion, targetInfo), "bin", "node");
  if (!fs.existsSync(extractedNodePath)) {
    throw new Error(`Embedded Node runtime was extracted without ${runtimeFilename}: ${extractedNodePath}`);
  }
  fs.copyFileSync(extractedNodePath, destinationPath);
  if (targetInfo.platform !== "windows") {
    fs.chmodSync(destinationPath, 0o755);
  }
}

async function verifyNodeArchiveChecksum({ archiveName, archiveUrl, archiveBuffer, expectedSha256 }) {
  const actual = createHash("sha256").update(archiveBuffer).digest("hex").toLowerCase();
  let expected = expectedSha256?.trim().toLowerCase();
  if (!expected) {
    const checksumsUrl = archiveUrl.replace(/\/[^/]+$/, "/SHASUMS256.txt");
    const response = await fetch(checksumsUrl);
    if (!response.ok) {
      throw new Error(`Failed to download Node runtime checksums from ${checksumsUrl} (${response.status})`);
    }
    const checksums = await response.text();
    const line = checksums
      .split(/\r?\n/)
      .find(
        (candidate) => candidate.trim().endsWith(` ${archiveName}`) || candidate.trim().endsWith(` *${archiveName}`),
      );
    expected = line?.trim().split(/\s+/)[0]?.toLowerCase();
    if (!expected) {
      throw new Error(`Node runtime checksum for ${archiveName} was not found in ${checksumsUrl}`);
    }
  }
  if (actual !== expected) {
    throw new Error(`Node runtime checksum mismatch for ${archiveName}: expected ${expected}, got ${actual}`);
  }
}

function writeLaunchers(bundleRootPath) {
  const launcherDir = path.join(bundleRootPath, "bin");
  fs.mkdirSync(launcherDir, { recursive: true });

  if (targetInfo.platform === "windows") {
    const { cmd, ps1 } = renderWindowsLaunchers();
    for (const name of ["goatcitadel", "goat"]) {
      fs.writeFileSync(path.join(launcherDir, `${name}.cmd`), cmd, "ascii");
      fs.writeFileSync(path.join(launcherDir, `${name}.ps1`), ps1, "ascii");
    }
    return;
  }

  const launcher = renderPosixLauncher();
  for (const name of ["goatcitadel", "goat"]) {
    const launcherPath = path.join(launcherDir, name);
    fs.writeFileSync(launcherPath, launcher, "ascii");
    fs.chmodSync(launcherPath, 0o755);
  }
}

async function writeReleaseManifest({
  bundleRoot: bundleRootPath,
  appRoot: packagedAppRoot,
  version: bundleVersion,
  nodeVersion: bundledNodeVersion,
  windowsIdentityPackage,
}) {
  const initialPayloadSnapshot = snapshotReleasePayloadTree(bundleRootPath);
  const payloadFiles = [];
  for (const filePath of initialPayloadSnapshot.filePaths) {
    const relativePath = path.relative(bundleRootPath, filePath).replaceAll("\\", "/");
    payloadFiles.push(await buildPayloadFileRecord(bundleRootPath, filePath, relativePath));
  }
  const finalPayloadSnapshot = snapshotReleasePayloadTree(bundleRootPath);
  assertSamePayloadSnapshot(initialPayloadSnapshot, finalPayloadSnapshot);
  const manifest = buildReleaseManifest({
    targetInfo,
    version: bundleVersion,
    nodeVersion: bundledNodeVersion,
    payloadFiles,
    uiTarget,
    includeDesktopHost,
    desktopArtifactName: desktopExecutableName,
    windowsIdentityPackage,
    sourceCommit,
    sourceModified,
  });
  const manifestBytes = `${JSON.stringify(manifest, null, 2)}\n`;
  if (Buffer.byteLength(manifestBytes) > RELEASE_PAYLOAD_LIMITS.maxManifestBytes) {
    throw new Error(`Release manifest exceeds ${RELEASE_PAYLOAD_LIMITS.maxManifestBytes} bytes.`);
  }
  fs.writeFileSync(path.join(packagedAppRoot, "release-manifest.json"), manifestBytes, "utf8");
}

function copyDesktopExecutable() {
  if (!fs.existsSync(desktopArtifactPath)) {
    const buildCommand =
      targetInfo.platform === "windows"
        ? `pnpm package:windows-host --target ${target}`
        : `pnpm package:desktop --target ${target}`;
    throw new Error(
      `Desktop executable is missing: ${desktopArtifactPath}. Run ${buildCommand} before package:bundle, or pass --skip-desktop for a browser-only bundle.`,
    );
  }
  assertDesktopArtifactProvenance(path.join(path.dirname(desktopArtifactPath), "desktop-manifest.json"), {
    target,
    sourceCommit,
    sourceModified,
  });
  removeDirectory(desktopRuntimeDir);
  copyDirectory(path.dirname(desktopArtifactPath), desktopRuntimeDir);
  copyIfExists(
    path.join(path.dirname(desktopArtifactPath), "desktop-manifest.json"),
    path.join(desktopRuntimeDir, "desktop-manifest.json"),
  );
}

function copyWindowsIdentityPackage() {
  if (targetInfo.platform !== "windows") {
    return null;
  }

  const identityOutDir = path.join(repoRoot, "artifacts", "installers", "windows-msix");
  const identityManifestPath = path.join(identityOutDir, "identity-manifest.json");
  if (!fs.existsSync(identityManifestPath)) {
    return null;
  }

  const identityManifest = JSON.parse(fs.readFileSync(identityManifestPath, "utf8"));
  if (!identityManifest.signed) {
    console.warn(
      "Skipping unsigned Windows identity package in bundle. Build package:windows-msix with a signing certificate for Stage B installer identity.",
    );
    return null;
  }

  const sourcePackage = path.join(identityOutDir, identityManifest.fileName);
  if (!fs.existsSync(sourcePackage)) {
    throw new Error(`Windows identity package manifest exists, but package is missing: ${sourcePackage}`);
  }

  removeDirectory(identityRuntimeDir);
  fs.mkdirSync(identityRuntimeDir, { recursive: true });
  const packageName = "GoatCitadel-Mission-Control-Windows-Identity.msix";
  copyFile(sourcePackage, path.join(identityRuntimeDir, packageName));
  copyFile(identityManifestPath, path.join(identityRuntimeDir, "identity-manifest.json"));
  return {
    ...identityManifest,
    fileName: packageName,
    path: `app/identity/${packageName}`,
    manifestPath: "app/identity/identity-manifest.json",
  };
}

function writeUiTargetManifest(packagedAppRoot) {
  const manifest = {
    packageName: uiTarget.packageName,
    packageDirName: uiTarget.packageDirName,
    displayName: uiTarget.displayName,
    sourceDistDir: path.relative(repoRoot, uiTarget.distDir).replaceAll("\\", "/"),
    packagedDistDir: "mission-control/dist",
    compatibilityPath: true,
  };
  fs.writeFileSync(
    path.join(packagedAppRoot, "mission-control", "ui-target-manifest.json"),
    JSON.stringify(manifest, null, 2),
    "utf8",
  );
}

function snapshotReleasePayloadTree(rootDir) {
  const resolvedRoot = path.resolve(rootDir);
  const rootStats = fs.lstatSync(rootDir);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Release payload root must be a regular non-link directory: ${rootDir}`);
  }
  const canonicalRoot = fs.realpathSync.native(resolvedRoot);
  const filePaths = [];
  const identities = [];
  let totalBytes = 0;
  const queue = [resolvedRoot];
  // Iterate via an index pointer rather than `queue.pop()` so the order in
  // which we descend is stable (FIFO) and so the array doesn't get resized
  // on every step.
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    const beforeDirectoryStats = fs.lstatSync(current);
    if (!beforeDirectoryStats.isDirectory() || beforeDirectoryStats.isSymbolicLink()) {
      throw new Error(`Release payload directory changed into a link or non-directory: ${current}`);
    }
    const canonicalDirectory = fs.realpathSync.native(current);
    assertCanonicalPayloadContainment(canonicalRoot, canonicalDirectory, current === resolvedRoot);
    const entryNames = fs.readdirSync(current).sort(compareStrings);
    const afterReadDirectoryStats = fs.lstatSync(current);
    if (!sameFileIdentity(beforeDirectoryStats, afterReadDirectoryStats)) {
      throw new Error(`Release payload directory changed while it was enumerated: ${current}`);
    }
    identities.push(
      payloadIdentityRecord({
        rootDir: resolvedRoot,
        canonicalRoot,
        absolutePath: current,
        canonicalPath: canonicalDirectory,
        kind: "directory",
        stats: afterReadDirectoryStats,
      }),
    );
    for (const entryName of entryNames) {
      const absolutePath = path.join(current, entryName);
      const stats = fs.lstatSync(absolutePath);
      const relativePath = path.relative(rootDir, absolutePath).replaceAll("\\", "/");
      if (stats.isSymbolicLink()) {
        throw new Error(`Release payload cannot contain a symlink or junction: ${relativePath}`);
      }
      if (isDetachedReleaseMetadataPath(relativePath)) {
        continue;
      }
      const canonicalPath = fs.realpathSync.native(absolutePath);
      assertCanonicalPayloadContainment(canonicalRoot, canonicalPath, false);
      if (stats.isDirectory()) {
        identities.push(
          payloadIdentityRecord({
            rootDir: resolvedRoot,
            canonicalRoot,
            absolutePath,
            canonicalPath,
            kind: "directory-entry",
            stats,
          }),
        );
        queue.push(absolutePath);
        continue;
      }
      if (stats.isFile()) {
        if (stats.nlink !== 1) {
          throw new Error(`Release payload cannot contain a hard-linked file: ${relativePath}`);
        }
        if (stats.size > RELEASE_PAYLOAD_LIMITS.maxFileBytes) {
          throw new Error(`Release payload file is oversized: ${relativePath}`);
        }
        if (filePaths.length >= RELEASE_PAYLOAD_LIMITS.maxFiles) {
          throw new Error(`Release payload exceeds ${RELEASE_PAYLOAD_LIMITS.maxFiles} files.`);
        }
        totalBytes += stats.size;
        if (!Number.isSafeInteger(totalBytes) || totalBytes > RELEASE_PAYLOAD_LIMITS.maxTotalBytes) {
          throw new Error(`Release payload exceeds ${RELEASE_PAYLOAD_LIMITS.maxTotalBytes} bytes.`);
        }
        identities.push(
          payloadIdentityRecord({
            rootDir: resolvedRoot,
            canonicalRoot,
            absolutePath,
            canonicalPath,
            kind: "file",
            stats,
          }),
        );
        filePaths.push(absolutePath);
        continue;
      }
      throw new Error(`Release payload cannot contain a special filesystem entry: ${relativePath}`);
    }
  }
  filePaths.sort((left, right) =>
    compareStrings(
      path.relative(resolvedRoot, left).replaceAll("\\", "/"),
      path.relative(resolvedRoot, right).replaceAll("\\", "/"),
    ),
  );
  identities.sort((left, right) => compareStrings(`${left.path}:${left.kind}`, `${right.path}:${right.kind}`));
  return { filePaths, identities, totalBytes };
}

function payloadIdentityRecord({ rootDir, canonicalRoot, absolutePath, canonicalPath, kind, stats }) {
  return {
    path: path.relative(rootDir, absolutePath).replaceAll("\\", "/") || ".",
    canonicalPath: path.relative(canonicalRoot, canonicalPath).replaceAll("\\", "/") || ".",
    kind,
    dev: stats.dev,
    ino: stats.ino,
    nlink: stats.nlink,
    size: stats.size,
    mtimeMs: stats.mtimeMs,
    ctimeMs: stats.ctimeMs,
  };
}

function assertCanonicalPayloadContainment(canonicalRoot, canonicalPath, allowSame) {
  const relative = path.relative(canonicalRoot, canonicalPath);
  if (allowSame && relative === "") return;
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Release payload path escapes the canonical bundle root: ${canonicalPath}`);
  }
}

function assertSamePayloadSnapshot(initial, final) {
  if (
    initial.identities.length !== final.identities.length ||
    initial.filePaths.length !== final.filePaths.length ||
    initial.totalBytes !== final.totalBytes
  ) {
    throw new Error("Release payload file set changed while its manifest was being created.");
  }
  for (let index = 0; index < initial.identities.length; index += 1) {
    const before = initial.identities[index];
    const after = final.identities[index];
    if (
      before.path !== after.path ||
      before.canonicalPath !== after.canonicalPath ||
      before.kind !== after.kind ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.nlink !== after.nlink ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`Release payload identity changed while its manifest was being created: ${before.path}`);
    }
  }
}

async function buildPayloadFileRecord(bundleRootPath, filePath, relativePath) {
  assertAnchoredPayloadFile(bundleRootPath, filePath, relativePath);
  const beforePathStats = fs.lstatSync(filePath);
  if (
    !beforePathStats.isFile() ||
    beforePathStats.isSymbolicLink() ||
    beforePathStats.nlink !== 1 ||
    beforePathStats.size > RELEASE_PAYLOAD_LIMITS.maxFileBytes
  ) {
    throw new Error(`Release payload file is invalid or oversized: ${relativePath}`);
  }
  const handle = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  try {
    const openedStats = fs.fstatSync(handle);
    const currentPathStats = fs.lstatSync(filePath);
    assertAnchoredPayloadFile(bundleRootPath, filePath, relativePath);
    if (
      openedStats.nlink !== 1 ||
      currentPathStats.nlink !== 1 ||
      !sameFileIdentity(beforePathStats, openedStats) ||
      !sameFileIdentity(openedStats, currentPathStats)
    ) {
      throw new Error(`Release payload file changed while it was opened: ${relativePath}`);
    }
    const hash = createHash("sha256");
    for await (const chunk of fs.createReadStream(filePath, { fd: handle, autoClose: false, start: 0 })) {
      hash.update(chunk);
    }
    const finalOpenedStats = fs.fstatSync(handle);
    const finalPathStats = fs.lstatSync(filePath);
    assertAnchoredPayloadFile(bundleRootPath, filePath, relativePath);
    if (
      finalOpenedStats.nlink !== 1 ||
      finalPathStats.nlink !== 1 ||
      !sameFileIdentity(openedStats, finalOpenedStats) ||
      !sameFileIdentity(finalOpenedStats, finalPathStats)
    ) {
      throw new Error(`Release payload file changed while it was hashed: ${relativePath}`);
    }
    return {
      path: relativePath,
      sha256: hash.digest("hex"),
      sizeBytes: openedStats.size,
    };
  } finally {
    fs.closeSync(handle);
  }
}

function assertAnchoredPayloadFile(bundleRootPath, filePath, relativePath) {
  const root = path.resolve(bundleRootPath);
  const candidate = path.resolve(filePath);
  const relative = path.relative(root, candidate);
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Release payload file escapes the bundle root: ${relativePath}`);
  }
  const rootStats = fs.lstatSync(root);
  if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
    throw new Error(`Release payload root changed into a link or non-directory: ${root}`);
  }
  let cursor = root;
  for (const segment of relative.split(path.sep)) {
    cursor = path.join(cursor, segment);
    const stats = fs.lstatSync(cursor);
    if (stats.isSymbolicLink()) {
      throw new Error(`Release payload file traverses a symlink or junction: ${relativePath}`);
    }
    if (cursor !== candidate && !stats.isDirectory()) {
      throw new Error(`Release payload file traverses a non-directory component: ${relativePath}`);
    }
  }
  const candidateStats = fs.lstatSync(candidate);
  if (!candidateStats.isFile() || candidateStats.isSymbolicLink() || candidateStats.nlink !== 1) {
    throw new Error(`Release payload file is not a regular single-link file: ${relativePath}`);
  }
  assertCanonicalPayloadContainment(fs.realpathSync.native(root), fs.realpathSync.native(candidate), false);
}

function sameFileIdentity(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

function compareStrings(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function pruneGatewayDeploy(targetDir) {
  const keep = new Set(["dist", "node_modules", "package.json"]);
  for (const entry of fs.readdirSync(targetDir)) {
    if (!keep.has(entry)) {
      removeDirectory(path.join(targetDir, entry));
    }
  }
  removeDirectory(path.join(targetDir, "node_modules", ".pnpm", "node_modules", "@goatcitadel", "gateway"));
  pruneReleaseResidue(targetDir);
}

function pruneReleaseResidue(targetDir) {
  const prunedDirectories = new Set([
    ".codex-temp",
    ".pytest_cache",
    "artifacts",
    "backups",
    "coverage",
    "coverage-exercise",
    "coverage-smoke",
    "test-results",
  ]);
  const prunedExtensions = new Set([".map", ".tsbuildinfo"]);
  const queue = [targetDir];

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    for (const entry of fs.readdirSync(current)) {
      const absolutePath = path.join(current, entry);
      const stats = fs.lstatSync(absolutePath);
      if (stats.isDirectory() && prunedDirectories.has(entry)) {
        removeDirectory(absolutePath);
        continue;
      }
      if (stats.isSymbolicLink()) {
        continue;
      }
      if (stats.isDirectory()) {
        queue.push(absolutePath);
        continue;
      }
      if (stats.isFile() && prunedExtensions.has(path.extname(entry))) {
        fs.rmSync(absolutePath, { force: true });
      }
    }
  }
}

function removeDirectory(targetPath) {
  removeDirectorySafely(targetPath, {
    repoRoot,
    allowedRoot: outDir,
    cwd: process.cwd(),
  });
}

function copyDirectory(sourceDir, destinationDir) {
  fs.mkdirSync(path.dirname(destinationDir), { recursive: true });
  fs.cpSync(sourceDir, destinationDir, { recursive: true });
}

function resolveSourceCommit() {
  const fromCi = process.env.GITHUB_SHA?.trim();
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const candidate = String(result.stdout ?? "").trim();
  if (result.status !== 0 || !/^[a-f0-9]{40}$/i.test(candidate)) {
    throw new Error("Release bundle source commit could not be resolved to a full Git SHA.");
  }
  const normalizedHead = candidate.toLowerCase();
  if (fromCi !== undefined && (!/^[a-f0-9]{40}$/i.test(fromCi) || fromCi.toLowerCase() !== normalizedHead)) {
    throw new Error("Release bundle checkout HEAD does not match GITHUB_SHA.");
  }
  return normalizedHead;
}

function resolveSourceModified() {
  const result = spawnSync("git", ["-C", repoRoot, "status", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    throw new Error("Release bundle source modification state could not be resolved.");
  }
  return String(result.stdout ?? "").trim().length > 0;
}

function copyFile(sourcePath, destinationPath) {
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  fs.copyFileSync(sourcePath, destinationPath);
}

function copyIfExists(sourcePath, destinationPath) {
  if (!fs.existsSync(sourcePath)) {
    return;
  }
  const stats = fs.statSync(sourcePath);
  if (stats.isDirectory()) {
    copyDirectory(sourcePath, destinationPath);
    return;
  }
  copyFile(sourcePath, destinationPath);
}

function toPowershellSingleQuoted(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function expandNodeRuntimeArchive({ archivePath, expandedRoot, targetInfo: currentTargetInfo }) {
  if (currentTargetInfo.nodeArchiveType === "zip") {
    const expandResult = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        `Expand-Archive -LiteralPath ${toPowershellSingleQuoted(archivePath)} -DestinationPath ${toPowershellSingleQuoted(expandedRoot)} -Force`,
      ],
      {
        stdio: "inherit",
      },
    );
    if (expandResult.error) {
      throw expandResult.error;
    }
    if (expandResult.status !== 0) {
      throw new Error(`Expand-Archive exited with code ${expandResult.status}`);
    }
    return;
  }

  const tarCommand = process.platform === "win32" ? WINDOWS_TAR_PATH : "tar";
  const tarResult = spawnSync(tarCommand, ["-xzf", archivePath, "-C", expandedRoot], {
    stdio: "inherit",
  });
  if (tarResult.error) {
    throw tarResult.error;
  }
  if (tarResult.status !== 0) {
    throw new Error(`${tarCommand} exited with code ${tarResult.status}`);
  }
}

function buildWindowsCommand(parts) {
  return parts.map((value) => quoteWindowsCommandArg(String(value))).join(" ");
}

function quoteWindowsCommandArg(value) {
  assertSafeWindowsCommandArg(value);
  if (value.length === 0) {
    return '""';
  }
  if (!/[\s&()^<>|]/.test(value)) {
    return value;
  }
  return `"${value}"`;
}

function assertSafeWindowsCommandArg(value) {
  if (/["%\r\n\0]/.test(value)) {
    throw new Error(
      "Windows shell command arguments must not contain embedded quotes, percent expansions, or control characters.",
    );
  }
}
