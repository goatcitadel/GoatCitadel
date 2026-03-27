import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(repoRoot, "apps", "mission-control", "dist");
const assetsRoot = path.join(distRoot, "assets");

function fail(message) {
  console.error(`[perf-check] ${message}`);
  process.exit(1);
}

if (!fs.existsSync(distRoot) || !fs.existsSync(assetsRoot)) {
  fail("Mission Control dist output is missing. Run the build first.");
}

const assetFiles = fs.readdirSync(assetsRoot);
const indexCss = assetFiles.find((name) => /^index-.*\.css$/.test(name));
const indexJs = assetFiles.find((name) => /^index-.*\.js$/.test(name));
const chatCss = assetFiles.find((name) => /^ChatPage-.*\.css$/.test(name));
const agentsCss = assetFiles.find((name) => /^AgentsHubPage-.*\.css$/.test(name));
const officeChunk = assetFiles.find((name) => /^vendor-three-build-.*\.js$/.test(name));

if (!indexCss || !indexJs) {
  fail("Initial Mission Control shell assets were not found.");
}
if (!chatCss || !agentsCss) {
  fail("Expected route-specific ChatPage and AgentsHubPage CSS chunks were not produced.");
}
if (!officeChunk) {
  fail("Expected lazy Office three.js chunk was not produced.");
}

const budgets = {
  initialCssBytes: 160 * 1024,
  initialJsBytes: 192 * 1024,
};

const indexCssSize = fs.statSync(path.join(assetsRoot, indexCss)).size;
const indexJsSize = fs.statSync(path.join(assetsRoot, indexJs)).size;

if (indexCssSize > budgets.initialCssBytes) {
  fail(`Initial shell CSS is ${indexCssSize} bytes; budget is ${budgets.initialCssBytes} bytes.`);
}
if (indexJsSize > budgets.initialJsBytes) {
  fail(`Initial shell JS is ${indexJsSize} bytes; budget is ${budgets.initialJsBytes} bytes.`);
}

const indexHtml = fs.readFileSync(path.join(distRoot, "index.html"), "utf8");
if (indexHtml.includes("ChatPage-") || indexHtml.includes("AgentsHubPage-")) {
  fail("index.html eagerly references lazy route CSS chunks.");
}

console.log("[perf-check] Mission Control budgets passed.");
console.log(`[perf-check] index CSS: ${indexCssSize} bytes`);
console.log(`[perf-check] index JS: ${indexJsSize} bytes`);
