#!/usr/bin/env node
/* Normalize viewport width queries in the classic Mission Control CSS. */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const CANONICAL_MIN_WIDTHS = Object.freeze([640, 1024, 1280, 1600]);
export const CANONICAL_MAX_WIDTHS = Object.freeze([639, 1023, 1279, 1599]);

function nearest(values, px) {
  return values.reduce((best, value) =>
    Math.abs(value - px) < Math.abs(best - px) ? value : best,
  );
}

export function mapMaxWidth(px) {
  return nearest(CANONICAL_MAX_WIDTHS, px);
}

export function mapMinWidth(px) {
  return nearest(CANONICAL_MIN_WIDTHS, px);
}

export function normalizeMediaPrelude(prelude) {
  let normalized = prelude
    .replace(/\(max-width:\s*(\d+)px\)/g, (_match, px) => `(max-width: ${mapMaxWidth(Number(px))}px)`)
    .replace(/\(min-width:\s*(\d+)px\)/g, (_match, px) => `(min-width: ${mapMinWidth(Number(px))}px)`)
    .replace(/\(width\s*<\s*(\d+)px\)/g, (_match, px) => `(width < ${mapMinWidth(Number(px))}px)`)
    .replace(/\(width\s*>=\s*(\d+)px\)/g, (_match, px) => `(width >= ${mapMinWidth(Number(px))}px)`);

  // Preserve an occupied band when rounding its two endpoints would invert it.
  normalized = normalized.replace(
    /\(min-width: (\d+)px\)(\s+and\s+)\(max-width: (\d+)px\)/g,
    (match, minRaw, conjunction, maxRaw) => {
      const min = Number(minRaw);
      const max = Number(maxRaw);
      if (min <= max) return match;
      const prior = [...CANONICAL_MIN_WIDTHS].reverse().find((value) => value <= max);
      return prior ? `(min-width: ${prior}px)${conjunction}(max-width: ${max}px)` : match;
    },
  );
  return normalized;
}

export function normalizeCssMediaQueries(source) {
  return source.replace(/@media([^{}]*)\{/g, (match, prelude) =>
    `@media${normalizeMediaPrelude(prelude)}{`,
  );
}

async function listCssFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const groups = await Promise.all(entries.map((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listCssFiles(full);
    return entry.isFile() && entry.name.endsWith(".css") ? [full] : [];
  }));
  return groups.flat();
}

async function main() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const files = await listCssFiles(path.join(repoRoot, "apps", "mission-control-next", "src"));
  let changed = 0;
  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    const next = normalizeCssMediaQueries(source);
    if (next === source) continue;
    await fs.writeFile(file, next);
    changed += 1;
  }
  console.log(`normalized breakpoints in ${changed} file(s)`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
