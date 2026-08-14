#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { assertDesktopArtifactProvenance } from "./lib/desktop-artifact-provenance.mjs";
import { PACKAGING_TARGETS, requirePackagingTarget } from "./lib/packaging-targets.mjs";
import { removeDirectorySafely } from "./safe-cleanup.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "../..");
const windowsProject = path.join(
  repoRoot,
  "apps",
  "mission-control-windows",
  "GoatCitadel.MissionControl.Windows.csproj",
);
const sourceUpdateHelperProject = path.join(
  repoRoot,
  "apps",
  "product-source-update-helper",
  "GoatCitadel.ProductSourceUpdateHelper.csproj",
);
const PACKAGE_NAME = "GoatCitadel.MissionControl.Windows";
const APPLICATION_ID = "App";
const DEFAULT_MSIX_PUBLISHER = "CN=GoatCitadel";
const RETIRED_WINDOWS_AI_PAYLOAD_FILES = ["Microsoft.ML.OnnxRuntime.dll", "onnxruntime.dll", "DirectML.dll"];

const args = parseArgs(process.argv.slice(2));
const target = args.target;
if (!target || !PACKAGING_TARGETS[target]) {
  printUsage();
  process.exit(1);
}

const targetInfo = requirePackagingTarget(target, { allowedTargets: ["windows-x64", "windows-arm64"] });
const outDir = path.resolve(args.outDir || path.join(repoRoot, "artifacts", "installers", "desktop", target));
const outArtifactPath = path.join(outDir, targetInfo.desktopArtifactName);
const sourceUpdateHelperDir = path.join(outDir, "runtime", "evolution");
const sourceUpdateHelperPath = path.join(sourceUpdateHelperDir, "GoatCitadel-Product-Source-Update-Helper.exe");
const configuration = args.configuration || "Release";
const msbuildPlatform = targetInfo.arch === "arm64" ? "ARM64" : "x64";
const msixPublisher = args.msixPublisher ?? process.env.GOATCITADEL_WINDOWS_MSIX_PUBLISHER ?? DEFAULT_MSIX_PUBLISHER;
const sourceCommit = resolveSourceCommit();
const sourceModified = resolveSourceModified();

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
    if (!fs.existsSync(sourceUpdateHelperProject)) {
      throw new Error(`Product source update helper project is missing: ${sourceUpdateHelperProject}`);
    }
    removeDirectory(outDir);
    fs.mkdirSync(outDir, { recursive: true });
    const generatedManifestRoot = fs.mkdtempSync(path.join(os.tmpdir(), "goatcitadel-winui-manifest-"));
    const generatedManifestPath = path.join(generatedManifestRoot, "app.manifest");
    try {
      fs.writeFileSync(generatedManifestPath, renderAppManifest({ publisher: msixPublisher }), "utf8");
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
        `-p:ApplicationManifest=${generatedManifestPath}`,
        `-p:Platform=${msbuildPlatform}`,
        "-p:RestoreSources=https://api.nuget.org/v3/index.json",
        "--output",
        outDir,
      ]);
      fs.mkdirSync(sourceUpdateHelperDir, { recursive: true });
      runDotnet([
        "publish",
        sourceUpdateHelperProject,
        "--configuration",
        configuration,
        "--runtime",
        targetInfo.windowsRid,
        "--self-contained",
        "true",
        "-p:PublishSingleFile=true",
        "-p:IncludeNativeLibrariesForSelfExtract=true",
        "-p:EnableWindowsTargeting=true",
        `-p:Platform=${msbuildPlatform}`,
        "-p:RestoreSources=https://api.nuget.org/v3/index.json",
        "--output",
        sourceUpdateHelperDir,
      ]);
    } finally {
      fs.rmSync(generatedManifestRoot, { recursive: true, force: true });
    }
  }

  if (!fs.existsSync(outArtifactPath)) {
    throw new Error(`WinUI host executable was not produced: ${outArtifactPath}`);
  }
  if (!fs.existsSync(sourceUpdateHelperPath)) {
    throw new Error(`Product source update helper was not produced: ${sourceUpdateHelperPath}`);
  }
  if (args.skipBuild) {
    assertDesktopArtifactProvenance(path.join(outDir, "desktop-manifest.json"), {
      target,
      sourceCommit,
      sourceModified,
    });
    console.log(`Reused verified GoatCitadel Windows host: ${outArtifactPath}`);
    return;
  }

  pruneRetiredWindowsAiPayload();
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
    if (value === "--msix-publisher") {
      parsed.msixPublisher = argv[index + 1];
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
    "Usage: node scripts/packaging/build-windows-host.mjs --target <windows-x64|windows-arm64> [--out-dir <dir>] [--configuration <Debug|Release>] [--msix-publisher <subject>] [--skip-build]",
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
    throw new Error(
      `The WinUI Windows host targets .NET 10 LTS, but dotnet --list-sdks did not report a 10.x SDK:\n${result.stdout}`,
    );
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
    sourceCommit,
    sourceModified,
    rid: targetInfo.windowsRid,
    platform: msbuildPlatform,
    hostKind: targetInfo.windowsHostKind,
    packageIdentity: {
      packageName: PACKAGE_NAME,
      applicationId: APPLICATION_ID,
      publisher: msixPublisher,
    },
    executable: path.relative(outDir, outArtifactPath).replaceAll("\\", "/"),
    evolutionHelper: {
      executable: path.relative(outDir, sourceUpdateHelperPath).replaceAll("\\", "/"),
      sha256: createHash("sha256").update(fs.readFileSync(sourceUpdateHelperPath)).digest("hex"),
    },
    project: path.relative(repoRoot, windowsProject).replaceAll("\\", "/"),
    createdAt: new Date().toISOString(),
    files,
  };
  fs.writeFileSync(path.join(outDir, "desktop-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
}

function resolveSourceCommit() {
  const fromCi = process.env.GITHUB_SHA?.trim();
  const result = spawnSync("git", ["-C", repoRoot, "rev-parse", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const candidate = String(result.stdout ?? "").trim();
  if (result.status !== 0 || !/^[a-f0-9]{40}$/iu.test(candidate)) {
    throw new Error("Windows host source commit could not be resolved to a full Git SHA.");
  }
  const normalizedHead = candidate.toLowerCase();
  if (fromCi !== undefined && (!/^[a-f0-9]{40}$/iu.test(fromCi) || fromCi.toLowerCase() !== normalizedHead)) {
    throw new Error("Windows host checkout HEAD does not match GITHUB_SHA.");
  }
  return normalizedHead;
}

function resolveSourceModified() {
  const result = spawnSync("git", ["-C", repoRoot, "status", "--porcelain"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    throw new Error("Windows host source modification state could not be resolved.");
  }
  return String(result.stdout ?? "").trim().length > 0;
}

function pruneRetiredWindowsAiPayload() {
  for (const fileName of RETIRED_WINDOWS_AI_PAYLOAD_FILES) {
    const filePath = path.join(outDir, fileName);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true });
    }
  }
}

function renderAppManifest({ publisher }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<assembly manifestVersion="1.0" xmlns="urn:schemas-microsoft-com:asm.v1">
  <assemblyIdentity version="1.0.0.0" name="GoatCitadel.MissionControl.Windows.app" />
  <msix xmlns="urn:schemas-microsoft-com:msix.v1"
        publisher="${escapeXml(publisher)}"
        packageName="${PACKAGE_NAME}"
        applicationId="${APPLICATION_ID}" />
  <application xmlns="urn:schemas-microsoft-com:asm.v3">
    <windowsSettings>
      <dpiAwareness xmlns="http://schemas.microsoft.com/SMI/2016/WindowsSettings">PerMonitorV2</dpiAwareness>
    </windowsSettings>
  </application>
  <compatibility xmlns="urn:schemas-microsoft-com:compatibility.v1">
    <application>
      <supportedOS Id="{8e0f7a12-bfb3-4fe8-b9a5-48fd50a15a9a}" />
    </application>
  </compatibility>
</assembly>
`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
  removeDirectorySafely(targetPath, {
    repoRoot,
    allowedRoot: path.join(repoRoot, "artifacts", "installers", "desktop"),
    cwd: process.cwd(),
  });
}
