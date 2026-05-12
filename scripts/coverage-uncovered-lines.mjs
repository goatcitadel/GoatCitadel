import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const coveragePolicyPath = path.join(repoRoot, "coverage-policy.json");
const sourceRoots = ["apps", "packages"];
const ignoredDirs = new Set([
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
]);

const args = process.argv.slice(2);
let target = "";
let limit = Number.POSITIVE_INFINITY;
let json = false;

for (const arg of args) {
  if (arg === "--json") {
    json = true;
    continue;
  }
  if (arg.startsWith("--limit=")) {
    const parsed = Number.parseInt(arg.slice("--limit=".length), 10);
    if (Number.isFinite(parsed) && parsed >= 0) {
      limit = parsed;
    }
    continue;
  }
  if (!target) {
    target = arg;
  }
}

const policy = await readCoveragePolicy();
const coverageFiles = await resolveCoverageFiles(target);
if (coverageFiles.length === 0) {
  console.error(
    `[coverage:uncovered] no coverage-final.json files found for ${target || "workspace"}. Run pnpm coverage:collect or package test:coverage first.`,
  );
  process.exitCode = 1;
} else {
  const rows = [];
  for (const coverageFile of coverageFiles) {
    rows.push(...await collectUncoveredRows(coverageFile, policy));
  }

  rows.sort((left, right) => right.uncoveredLines - left.uncoveredLines || left.path.localeCompare(right.path));
  const selectedRows = rows.slice(0, limit);

  if (json) {
    console.log(JSON.stringify(selectedRows, null, 2));
  } else {
    const totalUncovered = rows.reduce((sum, row) => sum + row.uncoveredLines, 0);
    console.log(
      `[coverage:uncovered] ${rows.length} files with ${totalUncovered} uncovered lines`
      + (Number.isFinite(limit) ? ` (showing ${selectedRows.length})` : ""),
    );
    for (const row of selectedRows) {
      console.log(`\n${row.path}: ${row.uncoveredLines} uncovered lines (${row.linePercent}% lines covered)`);
      for (const line of wrapRanges(row.uncoveredRanges)) {
        console.log(`  ${line}`);
      }
    }
  }
}

async function readCoveragePolicy() {
  try {
    const parsed = JSON.parse(await fs.readFile(coveragePolicyPath, "utf8"));
    const exclusions = Array.isArray(parsed.exclusions) ? parsed.exclusions : [];
    return exclusions.map((entry) => globToRegExp(normalizePath(String(entry.pattern ?? ""))));
  } catch {
    return [];
  }
}

async function resolveCoverageFiles(rawTarget) {
  const coverageFiles = await findCoverageFinalFiles();
  if (!rawTarget) {
    return coverageFiles;
  }

  const normalizedTarget = normalizePath(rawTarget);
  const absoluteTarget = path.resolve(repoRoot, rawTarget);
  const stat = await safeStat(absoluteTarget);
  if (stat?.isFile() && path.basename(absoluteTarget) === "coverage-final.json") {
    return [absoluteTarget];
  }
  if (stat?.isDirectory()) {
    const candidate = path.join(absoluteTarget, "coverage", "coverage-final.json");
    if (await exists(candidate)) {
      return [candidate];
    }
  }

  const packagePath = await resolveWorkspacePackagePath(rawTarget);
  if (packagePath) {
    const candidate = path.join(packagePath, "coverage", "coverage-final.json");
    if (await exists(candidate)) {
      return [candidate];
    }
  }

  return coverageFiles.filter((coverageFile) => normalizePath(path.relative(repoRoot, coverageFile)).includes(normalizedTarget));
}

async function findCoverageFinalFiles() {
  const out = [];
  for (const sourceRoot of sourceRoots) {
    await walk(path.join(repoRoot, sourceRoot), async (entryPath, entry) => {
      if (entry.isFile() && entry.name === "coverage-final.json") {
        out.push(entryPath);
      }
    });
  }
  return out.sort((left, right) => left.localeCompare(right));
}

async function resolveWorkspacePackagePath(rawTarget) {
  const out = [];
  for (const sourceRoot of sourceRoots) {
    await walk(path.join(repoRoot, sourceRoot), async (entryPath, entry) => {
      if (!entry.isFile() || entry.name !== "package.json") {
        return;
      }
      try {
        const parsed = JSON.parse(await fs.readFile(entryPath, "utf8"));
        const packageName = String(parsed.name ?? "");
        const packageDir = path.dirname(entryPath);
        const relativePackageDir = normalizePath(path.relative(repoRoot, packageDir));
        if (packageName === rawTarget || relativePackageDir === normalizePath(rawTarget)) {
          out.push(packageDir);
        }
      } catch {
        // Ignore invalid package manifests; this helper should not block coverage investigation.
      }
    });
  }
  return out[0];
}

async function collectUncoveredRows(coverageFile, policy) {
  const parsed = JSON.parse(await fs.readFile(coverageFile, "utf8"));
  const rows = [];
  for (const [filePath, entry] of Object.entries(parsed)) {
    const relativePath = normalizePath(path.relative(repoRoot, filePath));
    if (!isRuntimeSourcePath(relativePath) || policy.some((rule) => rule.test(relativePath))) {
      continue;
    }

    const lines = collectLineCoverage(entry);
    const uncovered = [...lines.entries()]
      .filter(([, covered]) => !covered)
      .map(([line]) => line)
      .sort((left, right) => left - right);
    if (uncovered.length === 0) {
      continue;
    }

    const coveredLines = [...lines.values()].filter(Boolean).length;
    const totalLines = lines.size;
    rows.push({
      coverageFile: normalizePath(path.relative(repoRoot, coverageFile)),
      path: relativePath,
      uncoveredLines: uncovered.length,
      coveredLines,
      totalLines,
      linePercent: totalLines > 0 ? roundPercent(coveredLines, totalLines) : 100,
      uncoveredRanges: compressRanges(uncovered),
    });
  }
  return rows;
}

function collectLineCoverage(entry) {
  const lines = new Map();

  for (const [rawLine, count] of Object.entries(entry.l ?? {})) {
    lines.set(Number(rawLine), Number(count) > 0);
  }

  for (const [statementId, count] of Object.entries(entry.s ?? {})) {
    const statement = entry.statementMap?.[statementId];
    const startLine = Number(statement?.start?.line);
    const endLine = Number(statement?.end?.line ?? startLine);
    if (!Number.isFinite(startLine) || startLine <= 0) {
      continue;
    }
    const covered = Number(count) > 0;
    for (let line = startLine; line <= Math.max(startLine, endLine); line += 1) {
      lines.set(line, (lines.get(line) ?? false) || covered);
    }
  }

  return lines;
}

function isRuntimeSourcePath(relativePath) {
  return (
    /\/src\/.+\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(relativePath)
    && !/(?:^|\/)(?:test|tests|__tests__)\/.+/.test(relativePath)
    && !/\.(?:test|spec)\.(?:cjs|cts|js|jsx|mjs|mts|ts|tsx)$/.test(relativePath)
  );
}

function compressRanges(lines) {
  const ranges = [];
  let start = lines[0];
  let previous = lines[0];
  for (let index = 1; index < lines.length; index += 1) {
    const current = lines[index];
    if (current === previous + 1) {
      previous = current;
      continue;
    }
    ranges.push(formatRange(start, previous));
    start = current;
    previous = current;
  }
  if (start !== undefined && previous !== undefined) {
    ranges.push(formatRange(start, previous));
  }
  return ranges;
}

function formatRange(start, end) {
  return start === end ? String(start) : `${start}-${end}`;
}

function wrapRanges(ranges) {
  const out = [];
  let current = "";
  for (const range of ranges) {
    const next = current ? `${current}, ${range}` : range;
    if (next.length > 120) {
      out.push(current);
      current = range;
    } else {
      current = next;
    }
  }
  if (current) {
    out.push(current);
  }
  return out;
}

function roundPercent(covered, total) {
  return Math.round((covered / total) * 10000) / 100;
}

function globToRegExp(pattern) {
  const escaped = pattern
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replaceAll("**", "\0")
    .replaceAll("*", "[^/]*")
    .replaceAll("\0", ".*");
  return new RegExp(`^${escaped}$`);
}

function normalizePath(value) {
  return value.replaceAll("\\", "/");
}

async function walk(dir, visitor) {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (ignoredDirs.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    await visitor(entryPath, entry);
    if (entry.isDirectory()) {
      await walk(entryPath, visitor);
    }
  }
}

async function exists(filePath) {
  return Boolean(await safeStat(filePath));
}

async function safeStat(filePath) {
  try {
    return await fs.stat(filePath);
  } catch {
    return undefined;
  }
}
