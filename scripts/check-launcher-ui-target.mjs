import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const launcherPath = path.join(repoRoot, "bin", "goatcitadel.mjs");
const source = fs.readFileSync(launcherPath, "utf8");

const startSourceUiMatch = /function startSourceUi[\s\S]*?\n}\n/.exec(source);
if (!startSourceUiMatch) {
  fail("Unable to locate startSourceUi() in bin/goatcitadel.mjs.");
}

const startSourceUiSource = startSourceUiMatch[0];
const requiredSnippets = ["resolveUiTarget(appDir, runtimeProcessEnv)", "uiTarget.packageName", '"--filter"'];

for (const snippet of requiredSnippets) {
  if (!startSourceUiSource.includes(snippet)) {
    fail(`startSourceUi() is missing ${snippet}.`);
  }
}

if (startSourceUiSource.includes('"@goatcitadel/mission-control"')) {
  fail("startSourceUi() hardcodes the legacy Mission Control package.");
}

console.log("Launcher UI target check passed.");

function fail(message) {
  console.error(`Launcher UI target check failed: ${message}`);
  process.exit(1);
}
