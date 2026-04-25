import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..");
const launcherPath = path.join(repoRoot, "bin", "goatcitadel.mjs");
const source = fs.readFileSync(launcherPath, "utf8").replaceAll("\r\n", "\n");
const bundlePath = path.join(repoRoot, "scripts", "packaging", "build-bundle.mjs");
const bundleSource = fs.readFileSync(bundlePath, "utf8").replaceAll("\r\n", "\n");

const startSourceUiSource = extractFunctionSource(source, "startSourceUi");
const requiredSnippets = ["resolveUiTarget(appDir, runtimeProcessEnv)", "uiTarget.packageName", '"--filter"'];

for (const snippet of requiredSnippets) {
  if (!startSourceUiSource.includes(snippet)) {
    fail(`startSourceUi() is missing ${snippet}.`);
  }
}

if (startSourceUiSource.includes('"@goatcitadel/mission-control"')) {
  fail("startSourceUi() hardcodes the legacy Mission Control package.");
}

if (!source.includes('const packagedUiDistDir = path.join(appDir, "mission-control", "dist")')) {
  fail("packaged UI dist path changed without updating the compatibility manifest guard.");
}

const startPackagedUiSource = extractFunctionSource(source, "startPackagedUi");
if (!startPackagedUiSource.includes("GOATCITADEL_UI_DIST_DIR: packagedUiDistDir")) {
  fail("startPackagedUi() is not wired to the packaged UI dist path.");
}

if (!bundleSource.includes("const uiTarget = resolveUiTarget(repoRoot, process.env)")) {
  fail("build-bundle.mjs does not resolve the active UI target.");
}
if (!bundleSource.includes("copyDirectory(uiTarget.distDir, missionControlDistDir)")) {
  fail("build-bundle.mjs does not copy the selected UI target dist into the packaged bundle.");
}
if (!bundleSource.includes("writeUiTargetManifest")) {
  fail("build-bundle.mjs does not write the packaged UI target manifest.");
}

console.log("Launcher UI target check passed.");

function fail(message) {
  console.error(`Launcher UI target check failed: ${message}`);
  process.exit(1);
}

function extractFunctionSource(fileSource, functionName) {
  const marker = `function ${functionName}`;
  const start = fileSource.indexOf(marker);
  if (start < 0) {
    fail(`Unable to locate ${functionName}() in bin/goatcitadel.mjs.`);
  }
  const openBrace = fileSource.indexOf("{", start);
  if (openBrace < 0) {
    fail(`Unable to locate ${functionName}() body in bin/goatcitadel.mjs.`);
  }
  let depth = 0;
  for (let index = openBrace; index < fileSource.length; index += 1) {
    const char = fileSource[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return fileSource.slice(start, index + 1);
      }
    }
  }
  fail(`Unable to parse ${functionName}() body in bin/goatcitadel.mjs.`);
}
