import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nextSrcRoot = path.join(repoRoot, "apps", "mission-control-next", "src");
const threadedSurfaceRoot = path.join(nextSrcRoot, "features", "threaded-surface");
const nextConfigFiles = [
  path.join(repoRoot, "apps", "mission-control-next", "vite.config.ts"),
  path.join(repoRoot, "apps", "mission-control-next", "tsconfig.json"),
];

const forbiddenImportChecks = [
  { pattern: /from\s+["']@\/pages\/ChatPage["']/g, label: "direct ChatPage import" },
  { pattern: /from\s+["']@\/pages\/chat\//g, label: "legacy pages/chat import" },
  { pattern: /from\s+["']@\/components\/CoworkCanvasPanel["']/g, label: "legacy CoworkCanvasPanel import" },
  { pattern: /from\s+["']@\/components\/CodeWorkbenchPanel["']/g, label: "legacy CodeWorkbenchPanel import" },
  { pattern: /from\s+["']@\//g, label: "legacy @/ import alias" },
  { pattern: /from\s+["'][^"']*apps\/mission-control\//g, label: "direct apps/mission-control import" },
];

const forbiddenSelectorChecks = [
  { pattern: /chat-v11/g, label: "legacy chat-v11 selector/class" },
  { pattern: /mission-context-dock/g, label: "legacy mission-context-dock selector/class" },
  { pattern: /mission-surface-header/g, label: "legacy mission-surface-header selector/class" },
];

const forbiddenConfigChecks = [
  { pattern: /legacySourceFallbackPlugin/g, label: "legacy Vite source fallback plugin" },
  { pattern: /mission-control\/public/g, label: "legacy mission-control publicDir" },
  { pattern: /mission-control\/src/g, label: "legacy mission-control source alias" },
  { pattern: /packages\/contracts\/src/g, label: "source-exported contracts alias" },
  { pattern: /packages\/threaded-surface-core\/src/g, label: "source-exported threaded-surface-core alias" },
  { pattern: /packages\/mission-control-shared\/src/g, label: "source-exported mission-control-shared alias" },
];

function walkFiles(root, matcher, results = []) {
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const resolved = path.join(root, entry.name);
    if (entry.isDirectory()) {
      walkFiles(resolved, matcher, results);
      continue;
    }
    if (matcher.test(entry.name)) {
      results.push(resolved);
    }
  }
  return results;
}

function collectFailures(files, checks) {
  const failures = [];
  for (const filePath of files) {
    const source = fs.readFileSync(filePath, "utf8");
    for (const check of checks) {
      const match = source.match(check.pattern);
      if (!match) {
        continue;
      }
      failures.push({
        filePath,
        label: check.label,
        count: match.length,
      });
    }
  }
  return failures;
}

const sourceFiles = walkFiles(nextSrcRoot, /\.(ts|tsx|css)$/);
const threadedFiles = walkFiles(threadedSurfaceRoot, /\.(ts|tsx|css)$/);
const failures = [
  ...collectFailures(threadedFiles, forbiddenImportChecks),
  ...collectFailures(sourceFiles, forbiddenSelectorChecks),
  ...collectFailures(nextConfigFiles, forbiddenConfigChecks),
];

if (failures.length > 0) {
  console.error("[legacy-check:next] Mission Control Next still references forbidden threaded legacy imports/selectors.");
  for (const failure of failures) {
    console.error(`- ${path.relative(repoRoot, failure.filePath)}: ${failure.label} (${failure.count})`);
  }
  process.exit(1);
}

console.log("[legacy-check:next] No forbidden threaded legacy imports or selectors found in mission-control-next/src.");
