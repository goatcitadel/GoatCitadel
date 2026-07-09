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
import { fileURLToPath, pathToFileURL } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const SCAN_ROOT = path.join(repoRoot, "apps", "mission-control-next", "src");

// Files where existing deprecated declarations are GRANDFATHERED.
// Phase A: prevent NEW drift. Phase B will migrate these files in sequence and
// shrink this list to {mission-control-next.css} (the intentional alias file).
// When this list reaches zero entries other than the alias file, deprecated
// token namespaces should be deleted entirely.
const GRANDFATHERED_DECLARATIONS = buildGrandfatheredDeclarationMap(repoRoot);

function buildGrandfatheredDeclarationMap(root) {
  return new Map(
    [
      [
        "apps/mission-control-next/src/styles/mission-control-next.css",
        [
          "--gc-area-chat",
          "--gc-area-code",
          "--gc-area-cowork",
          "--gc-area-library",
          "--gc-area-ops",
          "--gc-area-projects",
          "--gc-area-settings",
          "--gc-risk-caution",
          "--gc-risk-danger",
          "--gc-risk-nuclear",
          "--gc-risk-safe",
          "--mc-area-color",
          "--mc-border-strong",
          "--mc-border-subtle",
          "--mc-loader-gap",
          "--mc-loader-shift",
          "--mc-loader-size",
          "--mc-scrollbar-safe-gutter",
          "--mc-scrollbar-thumb",
          "--mc-scrollbar-thumb-hover",
          "--mc-scrollbar-track",
          "--mc-shadow-soft",
          "--mc-shadow-strong",
          "--mc-shell-bg",
          "--mc-surface-1",
          "--mc-surface-2",
          "--mc-surface-3",
        ],
      ],
      [
        "apps/mission-control-next/src/styles/mission-control-next-foundation.css",
        [
          "--mc-font-mono",
          "--mc-font-sans",
          "--mc-radius-lg",
          "--mc-radius-md",
          "--mc-radius-pill",
          "--mc-radius-sm",
          "--mc-radius-xl",
          "--mc-shadow-soft",
          "--mc-shadow-strong",
        ],
      ],
      // The area-accent local property. Decomposition of native-routes.css moved
      // these per-[data-area] declarations into the split stylesheet below; the
      // grandfather entry follows them. Phase B retires --mc-area-color everywhere.
      ["apps/mission-control-next/src/features/native-routes/styles/01-shared-primitives.css", ["--mc-area-color"]],
      // The theme bridge re-declares --mc-area-color on the bare .theme-* class
      // so body-portaled content (e.g. the composer "+" popover) keeps its area
      // accent; every other bridge token is sourced canonically. Phase B retires
      // --mc-area-color across all sites together.
      ["apps/mission-control-next/src/styles/mission-control-next-theme-bridge.css", ["--mc-area-color"]],
      [
        "apps/mission-control-next/src/features/threaded-surface/styles/rail.css",
        [
          "--mc-area-color",
          "--mc-mode-chat",
          "--mc-mode-code",
          "--mc-mode-cowork",
          "--mc-scrollbar-safe-gutter",
          "--mc-session-mode-color",
        ],
      ],
      ["apps/mission-control-next/src/features/threaded-surface/styles/side-panels.css", ["--mc-area-color"]],
    ].map(([file, tokens]) => [
      path.resolve(root, file.split("/").join(path.sep)),
      new Set(tokens),
    ]),
  );
}

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

export function findViolations(filePath, contents) {
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

export async function collectTokenDriftViolations({
  scanRoot = SCAN_ROOT,
  grandfatheredDeclarations = GRANDFATHERED_DECLARATIONS,
} = {}) {
  const files = [];
  await walk(scanRoot, files);

  const allViolations = [];
  let grandfatheredFileCount = 0;
  for (const file of files) {
    const allowedTokens = grandfatheredDeclarations.get(path.resolve(file));
    if (allowedTokens) {
      grandfatheredFileCount += 1;
    }
    const contents = await fs.readFile(file, "utf8");
    const violations = findViolations(file, contents).filter((violation) => !allowedTokens?.has(violation.token));
    allViolations.push(...violations);
  }
  return { files, grandfatheredFileCount, violations: allViolations };
}

async function main() {
  const { files, grandfatheredFileCount, violations: allViolations } = await collectTokenDriftViolations();

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
  console.error("  status colors → --success / --warning / --danger");
  console.error("  muted tertiary text → --text-tertiary");
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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("token-drift: script error", err);
    process.exit(2);
  });
}
