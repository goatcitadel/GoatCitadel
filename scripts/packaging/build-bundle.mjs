#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveUiTarget } from "../lib/ui-target.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

const supportedTargets = {
  "windows-x64": { platform: "windows", arch: "x64" },
  "windows-arm64": { platform: "windows", arch: "arm64" },
};

const args = parseArgs(process.argv.slice(2));
const target = args.target;
if (!target || !supportedTargets[target]) {
  printUsage();
  process.exit(1);
}

const outDir = path.resolve(args.outDir || path.join(repoRoot, "artifacts", "installers", "bundles"));
const version = args.version || packageJson.version;
const bundleName = `GoatCitadel-${version}-${target}`;
const bundleRoot = path.join(outDir, bundleName);
const appRoot = path.join(bundleRoot, "app");
const gatewayDeployDir = path.join(appRoot, "gateway");
const missionControlDistDir = path.join(appRoot, "mission-control", "dist");
const desktopRuntimeDir = path.join(appRoot, "desktop");
const desktopExecutableName = "GoatCitadel-Mission-Control-Desktop.exe";
const desktopArtifactPath = path.join(
  repoRoot,
  "artifacts",
  "installers",
  "desktop",
  target,
  desktopExecutableName,
);
const runtimeNodeDir = path.join(appRoot, "runtime", "node");
const templatesRoot = path.join(appRoot, "templates");
const nodeVersion = args.nodeVersion || process.version;
const uiTarget = resolveUiTarget(repoRoot, process.env);
const WINDOWS_CMD_PATH = "C:\\Windows\\System32\\cmd.exe";

await main();

async function main() {
  if (!args.skipBuild) {
    runPnpm(["--dir", repoRoot, "build"]);
  }

  removeDirectory(bundleRoot);
  fs.mkdirSync(appRoot, { recursive: true });

  runPnpm(["--dir", repoRoot, "--filter", "@goatcitadel/gateway", "deploy", "--legacy", "--prod", gatewayDeployDir]);
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
  if (!args.skipDesktop) {
    copyDesktopExecutable();
  }
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
    target,
    version,
    nodeVersion,
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
    "Usage: node scripts/packaging/build-bundle.mjs --target <windows-x64|windows-arm64> [--out-dir <dir>] [--version <semver>] [--node-version <vX.Y.Z>] [--node-sha256 <hex>] [--skip-build] [--skip-desktop]",
  );
}

function runPnpm(pnpmArgs) {
  const result = spawnSync(WINDOWS_CMD_PATH, ["/d", "/s", "/c", "pnpm", ...pnpmArgs], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`pnpm ${pnpmArgs.join(" ")} exited with code ${result.status}`);
  }
}

async function installEmbeddedNodeRuntime({ target: bundleTarget, nodeVersion: requestedNodeVersion, destinationDir }) {
  fs.mkdirSync(destinationDir, { recursive: true });
  const normalizedVersion = requestedNodeVersion.startsWith("v") ? requestedNodeVersion : `v${requestedNodeVersion}`;
  const targetInfo = supportedTargets[bundleTarget];
  const runtimeFilename = targetInfo.platform === "windows" ? "node.exe" : "node";
  const destinationPath = path.join(destinationDir, runtimeFilename);

  if (process.platform === "win32" && process.arch === targetInfo.arch && process.version === normalizedVersion) {
    fs.copyFileSync(process.execPath, destinationPath);
    return;
  }

  const archiveName = `node-${normalizedVersion}-win-${targetInfo.arch}.zip`;
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

  const extractedNodePath = path.join(expandedRoot, `node-${normalizedVersion}-win-${targetInfo.arch}`, "node.exe");
  if (!fs.existsSync(extractedNodePath)) {
    throw new Error(`Embedded Node runtime was extracted without node.exe: ${extractedNodePath}`);
  }
  fs.copyFileSync(extractedNodePath, destinationPath);
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
      .find((candidate) => candidate.trim().endsWith(` ${archiveName}`) || candidate.trim().endsWith(` *${archiveName}`));
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

  const launcherCmd = [
    "@echo off",
    "setlocal",
    'set "SCRIPT_DIR=%~dp0"',
    'for %%I in ("%SCRIPT_DIR%..") do set "GOATCITADEL_HOME=%%~fI"',
    '"%GOATCITADEL_HOME%\\app\\runtime\\node\\node.exe" "%GOATCITADEL_HOME%\\app\\bin\\goatcitadel.mjs" %*',
    "exit /b %ERRORLEVEL%",
    "",
  ].join("\r\n");

  const launcherPs1 = [
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

  for (const name of ["goatcitadel", "goat"]) {
    fs.writeFileSync(path.join(launcherDir, `${name}.cmd`), launcherCmd, "ascii");
    fs.writeFileSync(path.join(launcherDir, `${name}.ps1`), launcherPs1, "ascii");
  }
}

function writeReleaseManifest({
  bundleRoot: bundleRootPath,
  appRoot: packagedAppRoot,
  target: bundleTarget,
  version: bundleVersion,
  nodeVersion: bundledNodeVersion,
}) {
  const targetInfo = supportedTargets[bundleTarget];
  const checksums = {};
  for (const filePath of listFiles(bundleRootPath)) {
    const relativePath = path.relative(bundleRootPath, filePath).replaceAll("\\", "/");
    checksums[relativePath] = sha256(filePath);
  }
  const manifest = {
    version: bundleVersion,
    platform: targetInfo.platform,
    arch: targetInfo.arch,
    target: bundleTarget,
    components: [
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
        version: bundledNodeVersion,
        path: "app/runtime/node/node.exe",
        description: "Embedded Node runtime used by the packaged launcher.",
      },
      {
        id: "mission-control-desktop",
        required: !args.skipDesktop,
        path: `app/desktop/${desktopExecutableName}`,
        description: "Native desktop host for Mission Control, tray controls, runtime recovery, and local notifications.",
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
    ],
    checksums,
    launcher: {
      command: "goatcitadel launch",
      windows: "bin/goatcitadel.cmd",
      desktop: `app/desktop/${desktopExecutableName}`,
    },
  };
  fs.writeFileSync(path.join(packagedAppRoot, "release-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

function copyDesktopExecutable() {
  if (!fs.existsSync(desktopArtifactPath)) {
    throw new Error(
      `Desktop executable is missing: ${desktopArtifactPath}. Run pnpm package:desktop --target ${target} before package:bundle, or pass --skip-desktop for a browser-only bundle.`,
    );
  }
  copyFile(desktopArtifactPath, path.join(desktopRuntimeDir, desktopExecutableName));
  copyIfExists(
    path.join(path.dirname(desktopArtifactPath), "desktop-manifest.json"),
    path.join(desktopRuntimeDir, "desktop-manifest.json"),
  );
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
}

function removeDirectory(targetPath) {
  if (!fs.existsSync(targetPath)) {
    return;
  }
  try {
    fs.rmSync(targetPath, { recursive: true, force: true });
    return;
  } catch {
    const result = spawnSync(WINDOWS_CMD_PATH, ["/d", "/s", "/c", "rmdir", "/s", "/q", targetPath], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    if (result.error || result.status !== 0) {
      throw new Error(`Unable to remove existing directory: ${targetPath}`);
    }
  }
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
