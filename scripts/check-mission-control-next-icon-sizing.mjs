#!/usr/bin/env node
/*
 * The classic shell does not compile Tailwind utility classes. Numeric
 * `h-*` / `w-*` tokens there leave icons at the default size. The cockpit
 * compiles Tailwind separately and is exempt from this classic-only check.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(repoRoot, "apps", "mission-control-next", "src");
// Match standalone `h-<n>` / `w-<n>` sizing utilities only. The leading
// `(?<![\w-])` guard skips compound utilities such as `min-h-0` or `max-w-64`,
// which are container-layout classes rather than icon sizing and would
// otherwise be flagged with misleading "use a Lucide size prop" guidance.
const NUMERIC_UTILITY_RE = /(?<![\w-])(?:h|w)-\d+(?:\.\d+)?\b/g;

export function findIconSizingViolations(filePath, contents) {
  const violations = [];
  contents.split(/\r?\n/u).forEach((line, index) => {
    const tokens = [...line.matchAll(NUMERIC_UTILITY_RE)].map((match) => match[0]);
    if (tokens.length === 0 || !line.includes("className")) {
      return;
    }
    violations.push({
      file: filePath,
      line: index + 1,
      tokens,
      snippet: line.trim(),
    });
  });
  return violations;
}

async function walk(directory, files) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "dist-node") {
        continue;
      }
      await walk(fullPath, files);
    } else if (entry.isFile() && entry.name.endsWith(".tsx")) {
      files.push(fullPath);
    }
  }
}

export async function collectIconSizingViolations({ scanRoot = SCAN_ROOT } = {}) {
  const files = [];
  await walk(scanRoot, files);
  const violations = [];
  const classicFiles = files.filter((filePath) => !path.relative(scanRoot, filePath).split(path.sep).includes("cockpit"));
  for (const filePath of classicFiles) {
    const contents = await fs.readFile(filePath, "utf8");
    violations.push(...findIconSizingViolations(filePath, contents));
  }
  return { files: classicFiles, violations };
}

async function main() {
  const { files, violations } = await collectIconSizingViolations();
  if (violations.length === 0) {
    console.log(`icon sizing: ok (${files.length} TSX files scanned, 0 ineffective numeric utility classes)`);
    return;
  }

  console.error(`icon sizing: ${violations.length} ineffective numeric utility class usage(s) found.`);
  console.error("The classic shell does not compile Tailwind sizing utilities; use an explicit Lucide size prop.");
  for (const violation of violations) {
    const relativePath = path.relative(repoRoot, violation.file).split(path.sep).join("/");
    console.error(`  ${relativePath}:${violation.line} (${violation.tokens.join(", ")})`);
    console.error(`    ${violation.snippet}`);
  }
  process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("icon sizing: script error", error);
    process.exitCode = 2;
  });
}
