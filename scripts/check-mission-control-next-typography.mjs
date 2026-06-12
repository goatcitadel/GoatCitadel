#!/usr/bin/env node
/*
 * Typography-scale guard for apps/mission-control-next.
 *
 * Enforces the two-tier text scale declared in
 * apps/mission-control-next/src/styles/mission-control-next-tokens.css.
 * Every operator-facing font size must resolve through a --text-* token so it
 * tracks the density multiplier and user font-size preferences. Hardcoded rem,
 * px, em, and pt font sizes are rejected. `font-size: 0` and clamp() remain
 * allowed for icon hides and bounded large headings.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(repoRoot, "apps", "mission-control-next", "src");

const LENGTH_RE = /\d*\.?\d+(?:rem|px|em|pt)\b/;

function stripVars(value) {
  let previous;
  let output = value;
  do {
    previous = output;
    output = output.replace(/var\([^()]*\)/g, " ");
  } while (output !== previous);
  return output;
}

function valueIsHardcoded(rawValue) {
  const value = rawValue.trim().replace(/!important\s*$/i, "").trim();
  if (value === "0" || value === "inherit" || value === "initial" || value === "unset") {
    return false;
  }
  if (/var\(--text-/.test(value)) {
    return false;
  }
  if (/\bclamp\(/.test(value)) {
    return false;
  }
  return LENGTH_RE.test(stripVars(value));
}

export function findTypographyViolations(filePath, contents) {
  const violations = [];
  contents.split(/\r?\n/).forEach((line, index) => {
    const fontSize = line.match(/(?:^|[;{]|\*\/)\s*font-size\s*:\s*([^;{}]+)/i);
    const shorthand = line.match(/(?:^|[;{]|\*\/)\s*font\s*:\s*([^;{}]+)/i);
    const valueMatch = fontSize ?? shorthand;
    if (!valueMatch) {
      return;
    }
    if (valueIsHardcoded(valueMatch[1])) {
      violations.push({
        file: filePath,
        line: index + 1,
        property: fontSize ? "font-size" : "font",
        snippet: line.trim(),
      });
    }
  });
  return violations;
}

async function walk(dir, acc) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "dist-node") {
        continue;
      }
      await walk(full, acc);
    } else if (entry.isFile() && entry.name.endsWith(".css")) {
      acc.push(full);
    }
  }
}

export async function collectTypographyViolations({ scanRoot = SCAN_ROOT } = {}) {
  const files = [];
  await walk(scanRoot, files);
  const violations = [];
  for (const file of files) {
    const contents = await fs.readFile(file, "utf8");
    violations.push(...findTypographyViolations(file, contents));
  }
  return { files, violations };
}

async function main() {
  const { files, violations } = await collectTypographyViolations();
  if (violations.length === 0) {
    console.log(`typography: ok (${files.length} CSS files scanned, 0 hardcoded font sizes)`);
    process.exit(0);
  }
  console.error(`typography: ${violations.length} hardcoded font size(s) found.`);
  console.error("");
  console.error("Operator-facing text must use the --text-* scale.");
  console.error("Use --text-2xs only for dense mono chrome and --text-xs or larger for content.");
  console.error("");
  for (const violation of violations) {
    const relFile = path.relative(repoRoot, violation.file).split(path.sep).join("/");
    console.error(`  ${relFile}:${violation.line} (${violation.property})`);
    console.error(`    ${violation.snippet}`);
  }
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("typography: script error", error);
    process.exit(2);
  });
}
