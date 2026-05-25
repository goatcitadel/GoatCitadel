#!/usr/bin/env node
/*
 * W1.1 token-drift guard for apps/mission-control-next.
 *
 * Enforces the canonical token system declared in
 *   apps/mission-control-next/src/styles/mission-control-next-tokens.css
 * Rejects NEW declarations of deprecated --mc-* / --gc-* / --mc-radius-* tokens
 * anywhere except the single grandfathered alias file
 *   apps/mission-control-next/src/styles/mission-control-next.css
 * which holds the deprecation aliases (Phase A) until the mechanical sweep in
 * Phase B retires them.
 *
 * Run via:
 *   node scripts/check-mission-control-next-token-drift.mjs
 *
 * Exits 1 on violation with file:line evidence.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const SCAN_ROOT = path.join(repoRoot, "apps", "mission-control-next", "src");

// Files where existing deprecated declarations are GRANDFATHERED.
// Phase A: prevent NEW drift. Phase B will migrate these files in sequence and
// shrink this list to {mission-control-next.css} (the intentional alias file).
// When this list reaches zero entries other than the alias file, deprecated
// token namespaces should be deleted entirely.
const GRANDFATHERED_FILES = new Set(
  [
    // The intentional Phase A alias file. Stays permanently until aliases are deleted.
    "apps/mission-control-next/src/styles/mission-control-next.css",
    // Legacy declarations widely consumed downstream — Phase B target.
    "apps/mission-control-next/src/styles/mission-control-next-foundation.css",
    // Per-area --mc-area-color setters. Phase B target: migrate to data-area + tokens.
    "apps/mission-control-next/src/features/native-routes/native-routes.css",
    // Feature-level mode/session-color drift. Phase B target.
    "apps/mission-control-next/src/features/threaded-surface/styles/rail.css",
    "apps/mission-control-next/src/features/threaded-surface/styles/side-panels.css",
  ].map((p) => path.resolve(repoRoot, p.split("/").join(path.sep))),
);

// Patterns we reject as DECLARATIONS (left-hand side of a CSS custom property).
// Note: we look for the property syntax `--foo:` to avoid catching `var(--foo)` references.
const DEPRECATED_PREFIXES = [
  /^--mc-radius-/,
  /^--mc-shadow-/,
  /^--mc-scrollbar-/,
  /^--mc-shell-/,
  /^--mc-surface-/,
  /^--mc-border-/,
  /^--mc-area-/,
  /^--mc-font-/,
  /^--mc-/,
  /^--gc-area-/,
  /^--gc-risk-/,
  /^--gc-/,
];

const DECL_REGEX = /(--[a-zA-Z0-9_-]+)\s*:/g;

async function walk(dir, accumulator) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "dist-node") continue;
      await walk(full, accumulator);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".css")) {
      accumulator.push(full);
    }
  }
}

function findViolations(filePath, contents) {
  const violations = [];
  const lines = contents.split(/\r?\n/);
  lines.forEach((line, index) => {
    // Skip pure usages (var(--mc-foo)) — only flag declarations on the LHS.
    // A declaration looks like `  --foo: value;` — the property name appears
    // before a colon at the start of a CSS property.
    let match;
    DECL_REGEX.lastIndex = 0;
    while ((match = DECL_REGEX.exec(line)) !== null) {
      const propName = match[1];
      // Verify this is the LHS of a declaration, not the property name argument
      // to var() — var() requires --foo INSIDE the parens, never followed by `:`.
      const isDeclaration = DEPRECATED_PREFIXES.some((re) => re.test(propName));
      if (!isDeclaration) continue;
      // Match should be at LHS — i.e., the character before `--` is whitespace,
      // `{`, `;`, start-of-line, or end of a previous declaration. Reject if
      // immediately preceded by `(` (that would be inside var()).
      const before = line.slice(0, match.index);
      if (/\(\s*$/.test(before)) continue;
      violations.push({
        file: filePath,
        line: index + 1,
        token: propName,
        snippet: line.trim(),
      });
    }
  });
  return violations;
}

async function main() {
  const files = [];
  await walk(SCAN_ROOT, files);

  const allViolations = [];
  let grandfatheredFileCount = 0;
  for (const file of files) {
    if (GRANDFATHERED_FILES.has(path.resolve(file))) {
      grandfatheredFileCount += 1;
      continue;
    }
    const contents = await fs.readFile(file, "utf8");
    const violations = findViolations(file, contents);
    allViolations.push(...violations);
  }

  if (allViolations.length === 0) {
    console.log(
      `token-drift: ok (${files.length} CSS files scanned, ${grandfatheredFileCount} grandfathered)`,
    );
    process.exit(0);
  }

  console.error(`token-drift: ${allViolations.length} violation(s) found.`);
  console.error("");
  console.error("New declarations of deprecated --mc-* / --gc-* tokens are not allowed.");
  console.error("Use canonical tokens from mission-control-next-tokens.css instead:");
  console.error("  --gc-area-*  →  --area-*");
  console.error("  --gc-risk-*  →  --risk-*");
  console.error("  --mc-radius-*  →  --r-*");
  console.error("  --mc-font-*  →  --font-*");
  console.error("");
  console.error("Existing aliases live in mission-control-next.css (grandfathered).");
  console.error("");
  for (const v of allViolations) {
    const relFile = path.relative(repoRoot, v.file).split(path.sep).join("/");
    console.error(`  ${relFile}:${v.line}  ${v.token}`);
    console.error(`    ${v.snippet}`);
  }
  process.exit(1);
}

main().catch((err) => {
  console.error("token-drift: script error", err);
  process.exit(2);
});
