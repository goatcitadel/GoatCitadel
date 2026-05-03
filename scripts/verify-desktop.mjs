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

console.log("Desktop verification passed.");

function fail(message) {
  console.error(`Desktop verification failed: ${message}`);
  process.exit(1);
}
