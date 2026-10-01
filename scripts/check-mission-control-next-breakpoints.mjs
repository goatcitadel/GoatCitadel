#!/usr/bin/env node
/* Enforce four viewport width breakpoints in Mission Control and shared UI. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCAN_ROOTS = [
  path.join(repoRoot, "apps", "mission-control-next", "src"),
  path.join(repoRoot, "packages", "mission-control-shared", "src"),
];
const MIN_ALLOWED = new Set([640, 1024, 1280, 1600]);
const MAX_ALLOWED = new Set([639, 1023, 1279, 1599]);
const FEATURE_RE = /\((max-width|min-width):\s*(\d+)px\)|\(width\s*(<|>=)\s*(\d+)px\)/g;

export function findBreakpointViolations(filePath, contents) {
  const violations = [];
  const candidates = [];
  if (filePath.endsWith(".css")) {
    for (const match of contents.matchAll(/@media([^{}]*)\{/g)) {
      candidates.push({ text: match[1], offset: match.index });
    }
  } else if (/\.tsx?$/.test(filePath)) {
    for (const match of contents.matchAll(/\b(?:useMediaQuery|matchMedia)\(\s*([`"'])([\s\S]*?)\1/g)) {
      candidates.push({ text: match[2], offset: match.index });
    }
  }
  for (const candidate of candidates) {
    for (const match of candidate.text.matchAll(FEATURE_RE)) {
      const [, feature, featurePx, operator, operatorPx] = match;
      const px = Number(featurePx ?? operatorPx);
      const allowed = feature === "max-width" ? MAX_ALLOWED : MIN_ALLOWED;
      if (allowed.has(px)) continue;
      const line = contents.slice(0, candidate.offset + match.index).split(/\r?\n/).length;
      violations.push({
        file: filePath,
        line,
        value: feature ? `${feature}: ${px}px` : `width ${operator} ${px}px`,
      });
    }
  }
  return violations;
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const groups = await Promise.all(entries.map((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return entry.name === "node_modules" || entry.name === "dist" ? [] : walk(full);
    return entry.isFile() && /\.(css|ts|tsx)$/.test(entry.name) && !/\.test\./.test(entry.name) ? [full] : [];
  }));
  return groups.flat();
}

async function main() {
  const files = (await Promise.all(SCAN_ROOTS.map(walk))).flat();
  const violations = [];
  for (const file of files) {
    violations.push(...findBreakpointViolations(file, await fs.readFile(file, "utf8")));
  }
  if (violations.length) {
    console.error("[breakpoints] non-canonical width breakpoints:");
    for (const item of violations) {
      console.error(`- ${path.relative(repoRoot, item.file)}:${item.line} -> ${item.value}`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`[breakpoints] ${files.length} files use only canonical breakpoints`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
