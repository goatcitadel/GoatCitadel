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
import { buildReleaseManifest, renderPosixLauncher, renderWindowsLaunchers } from "./lib/package-renderers.mjs";
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
      gatewayDeployDir,
    ],
    {
      attempts: 3,
      beforeRetry: () => removeDirectory(gatewayDeployDir),
      retryDelayMs: 2500,
    },
  );
  pruneGatewayDeploy(gatewayDeployDir);

  copyFile(path.join(repoRoot, "bin", "goatcitadel.mjs"), path.join(appRoot, "bin", "goatcitadel.mjs"));
  copyFile(path.join(repoRoot, "package.json"), path.join(appRoot, "package.json"));
  copyFile(
    path.join(repoRoot, "scripts", "lib", "ui-target.mjs"),
    path.join(appRoot, "scripts", "lib", "ui-target.mjs"),
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
  writeReleaseManifest({
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

function writeReleaseManifest({
  bundleRoot: bundleRootPath,
  appRoot: packagedAppRoot,
  version: bundleVersion,
  nodeVersion: bundledNodeVersion,
  windowsIdentityPackage,
}) {
  const checksums = {};
  for (const filePath of listFiles(bundleRootPath)) {
    const relativePath = path.relative(bundleRootPath, filePath).replaceAll("\\", "/");
    checksums[relativePath] = sha256(filePath);
  }
  const manifest = buildReleaseManifest({
    targetInfo,
    version: bundleVersion,
    nodeVersion: bundledNodeVersion,
    checksums,
    uiTarget,
    includeDesktopHost,
    desktopArtifactName: desktopExecutableName,
    windowsIdentityPackage,
  });
  fs.writeFileSync(path.join(packagedAppRoot, "release-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
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

function listFiles(rootDir) {
  const results = [];
  const queue = [rootDir];
  // Track resolved real paths so a circular symlink (a → b → a) cannot trap
  // the traversal in an infinite loop.
  const visitedDirectories = new Set();
  visitedDirectories.add(fs.realpathSync(rootDir));
  // Iterate via an index pointer rather than `queue.pop()` so the order in
  // which we descend is stable (FIFO) and so the array doesn't get resized
  // on every step.
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    for (const entryName of fs.readdirSync(current)) {
      const absolutePath = path.join(current, entryName);
      const stats = fs.lstatSync(absolutePath);
      if (stats.isDirectory()) {
        const directoryRealPath = fs.realpathSync(absolutePath);
        if (!visitedDirectories.has(directoryRealPath)) {
          visitedDirectories.add(directoryRealPath);
          queue.push(absolutePath);
        }
        continue;
      }
      if (stats.isSymbolicLink()) {
        const targetStats = fs.statSync(absolutePath);
        if (targetStats.isDirectory()) {
          const directoryRealPath = fs.realpathSync(absolutePath);
          if (!visitedDirectories.has(directoryRealPath)) {
            visitedDirectories.add(directoryRealPath);
            queue.push(absolutePath);
          }
          continue;
        }
      }
      if (stats.isFile() || stats.isSymbolicLink()) {
        results.push(absolutePath);
      }
    }
  }
  return results.sort((left, right) => left.localeCompare(right));
}

function sha256(filePath) {
  return createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
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
