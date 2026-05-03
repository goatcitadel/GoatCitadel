#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");

const requiredFiles = [
  "apps/mission-control-desktop/package.json",
  "apps/mission-control-desktop/src/main.ts",
  "apps/mission-control-desktop/src-tauri/tauri.conf.json",
  "apps/mission-control-desktop/src-tauri/src/main.rs",
  "scripts/packaging/build-desktop.mjs",
];

for (const relativePath of requiredFiles) {
  const fullPath = path.join(repoRoot, relativePath);
  if (!fs.existsSync(fullPath)) {
    fail(`Missing desktop file: ${relativePath}`);
  }
}

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
