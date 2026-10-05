#!/usr/bin/env node
/*
 * Cockpit refetch guard. A background refetch is not "no data": a panel that hides its record,
 * its actions or its open dialog while TanStack Query re-reads makes the cockpit flicker and
 * drops what the operator was doing. Records render through `recordView` (cockpit/data/record-view.ts),
 * which keeps the last good record and shows "Checking for changes…" instead.
 *
 * The guard is line-based. A line can opt out with a trailing
 * `// refetch-guard: allow <reason>` comment; the reason must be at least 10 characters.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cockpitRoot = path.join(repoRoot, "apps", "mission-control-next", "src", "cockpit");

export const PATTERNS = [
  // isFetching ? undefined : …  /  isFetching ? "Reading…" (does not cross a JSX `}`)
  /\.isFetching\b[^;\n}]*\?\s*(undefined|null|"[^"]*"|'[^']*')/,
  // isFetching || isError ? undefined
  /\.isFetching\s*\|\|[^;\n]*\?\s*(undefined|null)/,
  // !q.isFetching && … ? q.data  /  … && !q.isFetching ? q.data
  /!\s*\w+(\.\w+)*\.isFetching\b[^;\n]*\?\s*\w+(\.\w+)*\.data\b/,
];

const ALLOW = /\/\/\s*refetch-guard:\s*allow\s+(.*)$/;
const MIN_REASON_LENGTH = 10;

function isAllowed(line) {
  const match = ALLOW.exec(line);
  return Boolean(match && match[1].trim().length >= MIN_REASON_LENGTH);
}

function isTestFile(filePath) {
  return /\.test\.[cm]?[jt]sx?$/.test(filePath);
}

export function findRefetchHiddenRecords(filePath, contents) {
  if (isTestFile(filePath)) return [];
  const findings = [];
  contents.split(/\r?\n/).forEach((line, index) => {
    if (isAllowed(line)) return;
    if (PATTERNS.some((pattern) => pattern.test(line))) {
      findings.push({ file: filePath, line: index + 1, text: line.trim() });
    }
  });
  return findings;
}

async function walk(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const groups = await Promise.all(
    entries.map((entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return walk(full);
      return entry.isFile() && /\.tsx?$/.test(entry.name) && !isTestFile(entry.name) ? [full] : [];
    }),
  );
  return groups.flat();
}

async function main() {
  const files = await walk(cockpitRoot);
  const findings = [];
  for (const file of files) findings.push(...findRefetchHiddenRecords(file, await fs.readFile(file, "utf8")));
  if (findings.length) {
    console.error("[cockpit-refetch] keep the last good record during a refetch (use recordView):");
    for (const item of findings) console.error(`${path.relative(repoRoot, item.file)}:${item.line}: ${item.text}`);
    process.exitCode = 1;
    return;
  }
  console.log(`[cockpit-refetch] ${files.length} cockpit files keep their records during refetches`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
