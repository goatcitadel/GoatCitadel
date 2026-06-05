#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { PACKAGING_TARGETS, requirePackagingTarget } from "./lib/packaging-targets.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const windowsProject = path.join(
  repoRoot,
  "apps",
  "mission-control-windows",
  "GoatCitadel.MissionControl.Windows.csproj",
);
const WINDOWS_CMD_PATH = "C:\\Windows\\System32\\cmd.exe";

const args = parseArgs(process.argv.slice(2));
const target = args.target;
if (!target || !PACKAGING_TARGETS[target]) {
  printUsage();
  process.exit(1);
}

const targetInfo = requirePackagingTarget(target, { allowedTargets: ["windows-x64", "windows-arm64"] });
const outDir = path.resolve(args.outDir || path.join(repoRoot, "artifacts", "installers", "desktop", target));
const outArtifactPath = path.join(outDir, targetInfo.desktopArtifactName);
const configuration = args.configuration || "Release";
const msbuildPlatform = targetInfo.arch === "arm64" ? "ARM64" : "x64";

await main();

async function main() {
  if (!targetInfo.windowsRid) {
    throw new Error(`Packaging target ${target} does not define a Windows runtime identifier.`);
  }
  if (!fs.existsSync(windowsProject)) {
    throw new Error(`Windows host project is missing: ${windowsProject}`);
  }
  if (!args.skipBuild) {
    if (process.platform !== "win32") {
      throw new Error("The WinUI 3 Windows host publish must run on Windows.");
    }
    assertDotnet10Sdk();
    removeDirectory(outDir);
    fs.mkdirSync(outDir, { recursive: true });
    runDotnet([
      "publish",
      windowsProject,
      "--configuration",
      configuration,
      "--runtime",
      targetInfo.windowsRid,
      "--self-contained",
      "true",
      "-p:WindowsAppSDKSelfContained=true",
      "-p:WindowsPackageType=None",
      "-p:PublishSingleFile=false",
      "-p:EnableWindowsTargeting=true",
      `-p:Platform=${msbuildPlatform}`,
      "-p:RestoreSources=https://api.nuget.org/v3/index.json",
      "--output",
      outDir,
    ]);
  }

  if (!fs.existsSync(outArtifactPath)) {
    throw new Error(`WinUI host executable was not produced: ${outArtifactPath}`);
  }
  writeDesktopManifest();
  console.log(`Built GoatCitadel Windows host: ${outArtifactPath}`);
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
    if (value === "--configuration") {
      parsed.configuration = argv[index + 1];
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
    "Usage: node scripts/packaging/build-windows-host.mjs --target <windows-x64|windows-arm64> [--out-dir <dir>] [--configuration <Debug|Release>] [--skip-build]",
  );
}

function assertDotnet10Sdk() {
  const result = spawnSync("dotnet", ["--list-sdks"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error && result.error.code === "ENOENT") {
    throw new Error("No .NET SDK was found. Install the .NET 10 SDK before building the WinUI Windows host.");
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`dotnet --list-sdks exited with code ${result.status}: ${result.stderr || result.stdout}`);
  }
  const hasDotnet10 = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line.startsWith("10."));
  if (!hasDotnet10) {
    throw new Error(`The WinUI Windows host targets .NET 10 LTS, but dotnet --list-sdks did not report a 10.x SDK:\n${result.stdout}`);
  }
}

function runDotnet(dotnetArgs) {
  const result = spawnSync("dotnet", dotnetArgs, {
    cwd: repoRoot,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`dotnet ${dotnetArgs.join(" ")} exited with code ${result.status}`);
  }
}

function writeDesktopManifest() {
  const files = listFiles(outDir).map((filePath) => path.relative(outDir, filePath).replaceAll("\\", "/"));
  const manifest = {
    target,
    rid: targetInfo.windowsRid,
    platform: msbuildPlatform,
    hostKind: targetInfo.windowsHostKind,
    executable: path.relative(outDir, outArtifactPath).replaceAll("\\", "/"),
    project: path.relative(repoRoot, windowsProject).replaceAll("\\", "/"),
    createdAt: new Date().toISOString(),
    files,
  };
  fs.writeFileSync(path.join(outDir, "desktop-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

function listFiles(rootDir) {
  const results = [];
  const queue = [rootDir];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const current = queue[cursor];
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const entryPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        queue.push(entryPath);
      } else if (entry.isFile()) {
        results.push(entryPath);
      }
    }
  }
  return results.sort((left, right) => left.localeCompare(right));
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
