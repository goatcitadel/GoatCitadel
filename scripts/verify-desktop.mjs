#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const requiredFiles = [
  "apps/mission-control-windows/GoatCitadel.MissionControl.Windows.csproj",
  "apps/mission-control-windows/GoatCitadel.MissionControl.Windows.sln",
  "apps/mission-control-windows/Program.cs",
  "apps/mission-control-windows/App.xaml",
  "apps/mission-control-windows/MainWindow.xaml",
  "apps/mission-control-windows/Services/LauncherService.cs",
  "apps/mission-control-windows/Services/EventStreamService.cs",
  "apps/mission-control-windows/Tests/GoatCitadel.MissionControl.Windows.Tests.csproj",
  "apps/mission-control-desktop/package.json",
  "apps/mission-control-desktop/src/main.ts",
  "apps/mission-control-desktop/src-tauri/tauri.conf.json",
  "apps/mission-control-desktop/src-tauri/src/main.rs",
  "scripts/packaging/build-desktop.mjs",
  "scripts/packaging/build-windows-host.mjs",
];

for (const relativePath of requiredFiles) {
  const fullPath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    fail(`Missing desktop file: ${relativePath}`);
  }
}

if (process.platform !== "win32") {
  fail("WinUI desktop proof must run on Windows.");
}

assertDotnet10Sdk();

const secretStoreRegression = spawnSync(
  process.env.ComSpec || "cmd.exe",
  [
    "/d",
    "/s",
    "/c",
    "pnpm.cmd",
    "--filter",
    "@goatcitadel/gateway",
    "exec",
    "vitest",
    "run",
    "src/services/secret-store-service.test.ts",
  ],
  {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  },
);
assertSuccessfulSpawn(secretStoreRegression, "Packaged secret-store helper regression test");

const dotnetTest = spawnSync(
  "dotnet",
  [
    "test",
    path.join(repoRoot, "apps", "mission-control-windows", "Tests", "GoatCitadel.MissionControl.Windows.Tests.csproj"),
    "--configuration",
    "Release",
    "-p:RestoreSources=https://api.nuget.org/v3/index.json",
  ],
  {
    cwd: repoRoot,
    encoding: "utf8",
  },
);
assertSuccessfulSpawn(dotnetTest, "Windows App SDK host dotnet test");

const cargoCheck = spawnSync("cargo", ["check"], {
  cwd: path.join(repoRoot, "apps", "mission-control-desktop", "src-tauri"),
  encoding: "utf8",
});
assertSuccessfulSpawn(cargoCheck, "Desktop cargo check");

const cargoTest = spawnSync("cargo", ["test"], {
  cwd: path.join(repoRoot, "apps", "mission-control-desktop", "src-tauri"),
  encoding: "utf8",
});
assertSuccessfulSpawn(cargoTest, "Desktop cargo test");

const launcherStatus = spawnSync(process.execPath, [path.join(repoRoot, "bin", "goatcitadel.mjs"), "status", "--json"], {
  cwd: repoRoot,
  env: {
    ...process.env,
    GOATCITADEL_HOME: repoRoot,
  },
  encoding: "utf8",
});

if (launcherStatus.error) {
  throw launcherStatus.error;
}
if (launcherStatus.status !== 0) {
  fail(`Launcher status contract failed: ${launcherStatus.stderr || launcherStatus.stdout}`);
}

let parsed;
try {
  parsed = JSON.parse(launcherStatus.stdout);
} catch (error) {
  fail(`Launcher status did not return JSON: ${error.message}`);
}

for (const key of ["status", "gatewayUrl", "uiUrl", "targetUrl", "runtimeRoot", "pidFiles", "logFiles"]) {
  if (!(key in parsed)) {
    fail(`Launcher status JSON is missing ${key}`);
  }
}
if (parsed.status === "ready" && parsed.desktopEventStream && parsed.desktopEventStream.error) {
  fail(`Desktop SSE credential status returned an error: ${parsed.desktopEventStream.error}`);
}

console.log("Desktop verification passed.");

function assertDotnet10Sdk() {
  const result = spawnSync("dotnet", ["--list-sdks"], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (result.error && result.error.code === "ENOENT") {
    fail("No .NET SDK was found. Install the .NET 10 SDK before running desktop verification.");
  }
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    fail(`dotnet --list-sdks failed:\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
  const hasDotnet10 = result.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .some((line) => line.startsWith("10."));
  if (!hasDotnet10) {
    fail(`Desktop verification requires the .NET 10 SDK. dotnet --list-sdks returned:\n${result.stdout}`);
  }
}

function assertSuccessfulSpawn(result, label) {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    fail(`${label} failed:\n${result.stdout || ""}\n${result.stderr || ""}`);
  }
}

function fail(message) {
  console.error(`Desktop verification failed: ${message}`);
  process.exit(1);
}
