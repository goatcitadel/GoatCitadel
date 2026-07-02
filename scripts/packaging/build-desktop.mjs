#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PACKAGING_TARGETS, requirePackagingTarget } from "./lib/packaging-targets.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const desktopDir = path.join(repoRoot, "apps", "mission-control-desktop");
const desktopTauriDir = path.join(desktopDir, "src-tauri");
const WINDOWS_CMD_PATH = "C:\\Windows\\System32\\cmd.exe";

const args = parseArgs(process.argv.slice(2));
const target = args.target;
if (!target || !PACKAGING_TARGETS[target]) {
  printUsage();
  process.exit(1);
}

const targetInfo = requirePackagingTarget(target);
const defaultOutRoot =
  targetInfo.platform === "windows" ? path.join(repoRoot, "artifacts", "installers", "desktop-tauri") : path.join(repoRoot, "artifacts", "installers", "desktop");
const outDir = path.resolve(args.outDir || path.join(defaultOutRoot, target));
const outArtifactName = targetInfo.tauriDesktopArtifactName ?? targetInfo.desktopArtifactName;
const outArtifactPath = path.join(outDir, outArtifactName);

await main();

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  if (!args.skipBuild) {
    ensureRustTarget(targetInfo.tauriTriple);
    runPnpm(["--dir", desktopDir, "build"]);
    runPnpm(["--dir", desktopDir, "exec", "tauri", "build", "--target", targetInfo.tauriTriple]);
  }

  const builtArtifact = findBuiltDesktopArtifact(targetInfo);
  fs.copyFileSync(builtArtifact, outArtifactPath);
  fs.writeFileSync(
    path.join(outDir, "desktop-manifest.json"),
    JSON.stringify(
      {
        target,
        triple: targetInfo.tauriTriple,
        hostKind: "tauri-rollback",
        executable: path.relative(outDir, outArtifactPath).replaceAll("\\", "/"),
        sourceExecutable: path.relative(repoRoot, builtArtifact).replaceAll("\\", "/"),
        createdAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );
  console.log(`Built GoatCitadel desktop executable: ${outArtifactPath}`);
}

function parseArgs(argv) {
  const parsed = { skipBuild: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--target") {
      parsed.target = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--out-dir") {
      parsed.outDir = argv[index + 1];
      index += 1;
      continue;
    }
    if (value === "--skip-build") {
      parsed.skipBuild = true;
      continue;
    }
    throw new Error(`Unknown argument: ${value}`);
  }
  return parsed;
}

function printUsage() {
  console.log(
    "Usage: node scripts/packaging/build-desktop.mjs --target <windows-x64|windows-arm64|macos-arm64> [--out-dir <dir>] [--skip-build]",
  );
}

function ensureRustTarget(triple) {
  const result = spawnSync("rustup", ["target", "add", triple], {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error && result.error.code === "ENOENT") {
    return;
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`rustup target add ${triple} exited with code ${result.status}`);
  }
}

function runPnpm(pnpmArgs) {
  const cmd = process.platform === "win32" ? WINDOWS_CMD_PATH : "pnpm";
  const args = process.platform === "win32" ? ["/d", "/s", "/c", buildWindowsCommand(["pnpm", ...pnpmArgs])] : pnpmArgs;
  const result = spawnSync(cmd, args, {
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

function findBuiltDesktopArtifact(currentTargetInfo) {
  const releaseRoots = [
    path.join(desktopTauriDir, "target", currentTargetInfo.tauriTriple, "release"),
    path.join(desktopTauriDir, "target", "release"),
  ];
  const matches = [];
  for (const root of releaseRoots) {
    if (!fs.existsSync(root)) {
      continue;
    }
    for (const filePath of listFiles(root)) {
      const fileName = path.basename(filePath).toLowerCase();
      const matchesWindowsArtifact =
        currentTargetInfo.platform === "windows" && fileName.endsWith(".exe") && fileName.includes("goatcitadel");
      const matchesMacArtifact =
        currentTargetInfo.platform === "darwin" &&
        !fileName.includes(".") &&
        fileName.includes("goatcitadel") &&
        fs.statSync(filePath).isFile();
      if (matchesWindowsArtifact || matchesMacArtifact) {
        matches.push(filePath);
      }
    }
  }
  matches.sort((left, right) => fs.statSync(right).mtimeMs - fs.statSync(left).mtimeMs);
  const match = matches[0];
  if (!match) {
    throw new Error(`Unable to locate built desktop executable under ${releaseRoots.join(", ")}`);
  }
  return match;
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

function listFiles(root) {
  const files = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}
