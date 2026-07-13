import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const distRoot = path.join(repoRoot, "apps", "mission-control-next", "dist");
const assetsRoot = path.join(distRoot, "assets");
const monacoRoot = path.join(distRoot, "vendor", "monaco", "vs");

const budgets = {
  initialCssBytes: 100 * 1024,
  initialJsBytes: 450 * 1024,
  lazyJsBytes: 900 * 1024,
};

function fail(message) {
  console.error(`[perf-check:next] ${message}`);
  process.exit(1);
}

function readIndexHtml() {
  const indexHtmlPath = path.join(distRoot, "index.html");
  if (!fs.existsSync(indexHtmlPath)) {
    fail("Mission Control Next dist output is missing index.html. Run the build first.");
  }
  return fs.readFileSync(indexHtmlPath, "utf8");
}

function listAssetFiles() {
  if (!fs.existsSync(assetsRoot)) {
    fail("Mission Control Next dist assets are missing. Run the build first.");
  }
  return fs.readdirSync(assetsRoot);
}

function extractAssetPaths(indexHtml, pattern) {
  return [...indexHtml.matchAll(pattern)].map((match) => match[1]);
}

function normalizeAssetName(assetPath) {
  return assetPath.replace(/^\/+/, "").replace(/^assets\//, "");
}

function requireMatchingAsset(assetFiles, label, matcher) {
  const match = assetFiles.find((name) => matcher.test(name));
  if (!match) {
    fail(`Expected ${label} asset was not produced.`);
  }
  return match;
}

const indexHtml = readIndexHtml();
const assetFiles = listAssetFiles();

const scriptAssets = extractAssetPaths(indexHtml, /<script[^>]+src="([^"]+)"/g).map(normalizeAssetName);
const modulePreloads = extractAssetPaths(indexHtml, /<link rel="modulepreload"[^>]+href="([^"]+)"/g).map(normalizeAssetName);
const stylesheetAssets = extractAssetPaths(indexHtml, /<link rel="stylesheet"[^>]+href="([^"]+)"/g).map(normalizeAssetName);
const eagerAssets = new Set([...scriptAssets, ...modulePreloads, ...stylesheetAssets]);

if (scriptAssets.length !== 1) {
  fail(`Expected exactly one entry script in index.html, found ${scriptAssets.length}.`);
}

const entryScript = scriptAssets[0];
const entryScriptPath = path.join(assetsRoot, entryScript);
if (!fs.existsSync(entryScriptPath)) {
  fail(`Entry script ${entryScript} referenced by index.html was not found.`);
}

const entryScriptSize = fs.statSync(entryScriptPath).size;
if (entryScriptSize > budgets.initialJsBytes) {
  fail(`Initial shell JS is ${entryScriptSize} bytes; budget is ${budgets.initialJsBytes} bytes.`);
}

const initialCssSize = stylesheetAssets.reduce((sum, assetName) => {
  const assetPath = path.join(assetsRoot, assetName);
  if (!fs.existsSync(assetPath)) {
    fail(`Stylesheet ${assetName} referenced by index.html was not found.`);
  }
  return sum + fs.statSync(assetPath).size;
}, 0);
if (stylesheetAssets.some((assetName) => assetName.includes("webawesome"))) {
  fail("Mission Control Next must not eagerly load the unused WebAwesome stylesheet.");
}
if (initialCssSize > budgets.initialCssBytes) {
  fail(`Initial shell CSS is ${initialCssSize} bytes; budget is ${budgets.initialCssBytes} bytes.`);
}

requireMatchingAsset(assetFiles, "threaded surface route chunk", /^ThreadedSurface.*\.js$/);
requireMatchingAsset(assetFiles, "native route chunk", /^NativeRoutePages-.*\.js$/);
requireMatchingAsset(assetFiles, "native route stylesheet", /^NativeRoutePages-.*\.css$/);
requireMatchingAsset(assetFiles, "threaded surface stylesheet", /^ThreadedSurfaceRoute-.*\.css$/);
requireMatchingAsset(assetFiles, "prompt packs chunk", /^PromptPacksWorkbenchPage-.*\.js$/);

if (assetFiles.some((name) => /^styles-.*\.css$/.test(name))) {
  fail("Mission Control Next is still emitting the legacy aggregate stylesheet chunk.");
}

if (!fs.existsSync(path.join(monacoRoot, "editor", "editor.main.js"))) {
  fail("Expected Monaco AMD editor assets were not copied into dist/vendor/monaco/vs.");
}

if (indexHtml.includes("ThreadedSurface") || indexHtml.includes("NativeRoutePages-")) {
  fail("index.html eagerly references lazy route chunks.");
}
if (indexHtml.includes("PromptPacksWorkbenchPage-")) {
  fail("index.html eagerly references the prompt packs chunk.");
}
if (indexHtml.includes("/vendor/monaco/vs/")) {
  fail("index.html eagerly references Monaco AMD assets.");
}
if (assetFiles.some((name) => name.startsWith("vendor-monaco-"))) {
  fail("Bundled Monaco vendor chunks are still present in dist/assets.");
}

const jsAssets = assetFiles.filter((name) => name.endsWith(".js"));
const lazyJsAssets = jsAssets.filter((name) => !eagerAssets.has(name));
const oversizedLazyAsset = lazyJsAssets.find((name) => fs.statSync(path.join(assetsRoot, name)).size > budgets.lazyJsBytes);
if (oversizedLazyAsset) {
  const size = fs.statSync(path.join(assetsRoot, oversizedLazyAsset)).size;
  fail(`Lazy chunk ${oversizedLazyAsset} is ${size} bytes; budget is ${budgets.lazyJsBytes} bytes.`);
}

console.log("[perf-check:next] Mission Control Next budgets passed.");
console.log(`[perf-check:next] entry JS: ${entryScriptSize} bytes (${entryScript})`);
console.log(`[perf-check:next] initial CSS: ${initialCssSize} bytes (${stylesheetAssets.join(", ")})`);
console.log(`[perf-check:next] lazy JS chunks checked: ${lazyJsAssets.length}`);
