#!/usr/bin/env node
/*
 * Raw-button-class guard for apps/mission-control-next.
 *
 * Phase 3 of the front-end design remedy migrates every button onto the shared
 * CVA <Button> component (packages/mission-control-shared/src/components/ui/button.tsx).
 * This guard reports any .tsx still using the raw button CSS classes the
 * component replaces, so the Phase 3b sweep can drive the count to zero.
 *
 * Mirrors check-mission-control-next-typography.mjs. NOT wired into perf:check
 * yet: the raw classes are still in use across the app, so this is expected to
 * report usages and exit non-zero until the Phase 3b migration lands.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const SCAN_ROOT = path.join(repoRoot, "apps", "mission-control-next", "src");

// The canonical NativeButton primitive is the one sanctioned home of the raw
// button classes (it maps the variant API onto them), so it is not a migration
// target — exclude it from the scan.
const CANONICAL_BUTTON_SUFFIX = "features/native-routes/primitives/NativeButton.tsx";

function isCanonicalButtonFile(filePath) {
  return filePath.split(path.sep).join("/").endsWith(CANONICAL_BUTTON_SUFFIX);
}

/*
 * Whole-token match for the three raw button classes the CVA <Button> replaces:
 *   .mc-next-button            -> variant="default"  (filled primary)
 *   .mc-next-button-secondary  -> variant="secondary"/"ghost" (transparent)
 *   .gc-button                 -> variant="outline"  (bordered neutral)
 * The negative look-arounds keep `mc-next-button` from matching the longer
 * `mc-next-button-secondary`/`-ghost`/`-danger` tokens or `mc-next-icon-button`.
 */
const BUTTON_CLASS_RE = /(?<![\w-])(mc-next-button-secondary|mc-next-button|gc-button)(?![\w-])/g;

export function findButtonClassUsages(filePath, contents) {
  const usages = [];
  contents.split(/\r?\n/).forEach((line, index) => {
    BUTTON_CLASS_RE.lastIndex = 0;
    const classes = new Set();
    let match;
    while ((match = BUTTON_CLASS_RE.exec(line)) !== null) {
      classes.add(match[1]);
    }
    if (classes.size > 0) {
      usages.push({
        file: filePath,
        line: index + 1,
        classes: [...classes],
        snippet: line.trim(),
      });
    }
  });
  return usages;
}

async function walk(dir, acc) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "dist-node") {
        continue;
      }
      await walk(full, acc);
    } else if (entry.isFile() && entry.name.endsWith(".tsx") && !isCanonicalButtonFile(full)) {
      acc.push(full);
    }
  }
}

export async function collectButtonClassUsages({ scanRoot = SCAN_ROOT } = {}) {
  const files = [];
  await walk(scanRoot, files);
  const usages = [];
  for (const file of files) {
    const contents = await fs.readFile(file, "utf8");
    usages.push(...findButtonClassUsages(file, contents));
  }
  return { files, usages };
}

function countByClass(usages) {
  const counts = { "mc-next-button": 0, "mc-next-button-secondary": 0, "gc-button": 0 };
  for (const usage of usages) {
    for (const cls of usage.classes) {
      counts[cls] += 1;
    }
  }
  return counts;
}

async function main() {
  const { files, usages } = await collectButtonClassUsages();
  const fileCount = new Set(usages.map((usage) => usage.file)).size;
  const byClass = countByClass(usages);
  if (usages.length === 0) {
    console.log(`buttons: ok (${files.length} .tsx files scanned, 0 raw button-class usages)`);
    process.exit(0);
  }
  console.error(
    `buttons: ${usages.length} raw button-class line(s) across ${fileCount} file(s) ` +
      `(${files.length} .tsx scanned).`,
  );
  console.error(
    `  by class: mc-next-button=${byClass["mc-next-button"]}, ` +
      `mc-next-button-secondary=${byClass["mc-next-button-secondary"]}, ` +
      `gc-button=${byClass["gc-button"]}`,
  );
  console.error("");
  console.error("Migrate these onto the shared CVA <Button> (variant=default/outline/secondary/ghost).");
  console.error("");
  for (const usage of usages) {
    const relFile = path.relative(repoRoot, usage.file).split(path.sep).join("/");
    console.error(`  ${relFile}:${usage.line} (${usage.classes.join(", ")})`);
    console.error(`    ${usage.snippet}`);
  }
  process.exit(1);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error("buttons: script error", error);
    process.exit(2);
  });
}
