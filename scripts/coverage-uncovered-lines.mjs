import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const coveragePolicyPath = path.join(repoRoot, "coverage-policy.json");
const sourceRoots = ["apps", "packages"];
const MIN_EXCLUSION_REASON_LENGTH = 20;
const allowedExclusionCategories = new Set([
  "generated-static-adapter",
  "test-harness-setup",
  "type-only-barrel",
]);
const ignoredDirs = new Set([
  ".git",
  ".turbo",
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

  rows.sort((left, right) => right.totalMisses - left.totalMisses || left.path.localeCompare(right.path));
  const selectedRows = rows.slice(0, limit);

  if (json) {
    console.log(JSON.stringify(selectedRows, null, 2));
  } else {
    const totalUncovered = rows.reduce((sum, row) => sum + row.uncoveredLines, 0);
    const totalBranches = rows.reduce((sum, row) => sum + row.uncoveredBranches, 0);
    const totalFunctions = rows.reduce((sum, row) => sum + row.uncoveredFunctions, 0);
    console.log(
      `[coverage:uncovered] ${rows.length} files with ${totalUncovered} uncovered lines, `
      + `${totalBranches} uncovered branches, ${totalFunctions} uncovered functions`
      + (Number.isFinite(limit) ? ` (showing ${selectedRows.length})` : ""),
    );
    for (const row of selectedRows) {
      console.log(
        `\n${row.path}: ${row.uncoveredLines} uncovered lines, `
        + `${row.uncoveredBranches} uncovered branches, `
        + `${row.uncoveredFunctions} uncovered functions`,
      );
      console.log(`  lines: ${row.linePercent}% covered`);
      for (const line of wrapRanges(row.uncoveredRanges)) {
        console.log(`    ${line}`);
      }
      if (row.branchMisses.length > 0) {
        console.log("  branches:");
        for (const miss of row.branchMisses) {
          console.log(`    ${miss.location} ${miss.type} path ${miss.branchIndex + 1}/${miss.branchCount}`);
        }
      }
      if (row.functionMisses.length > 0) {
        console.log("  functions:");
        for (const miss of row.functionMisses) {
          console.log(`    ${miss.location} ${miss.name}`);
        }
      }
    }
  }
}

async function readCoveragePolicy() {
  let raw = "";
  try {
    raw = await fs.readFile(coveragePolicyPath, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path.relative(repoRoot, coveragePolicyPath)}.`, { cause: error });
  }

  if (!parsed || typeof parsed !== "object" || parsed.version !== 1) {
    throw new Error("coverage-policy.json must be an object with version 1.");
  }
  if (!Array.isArray(parsed.exclusions)) {
    throw new Error("coverage-policy.json must define an exclusions array.");
  }
  const declaredCategories = Array.isArray(parsed.allowedReasonCategories) ? parsed.allowedReasonCategories : [];
  for (const category of declaredCategories) {
    if (!allowedExclusionCategories.has(category)) {
      throw new Error(`coverage-policy.json declares unsupported exclusion category ${JSON.stringify(category)}.`);
    }
  }

  return parsed.exclusions.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`coverage-policy.json exclusions[${index}] must be an object.`);
    }
    const pattern = typeof entry.pattern === "string" ? entry.pattern.trim() : "";
    if (!pattern) {
      throw new Error(`coverage-policy.json exclusions[${index}] must define pattern.`);
    }
    if (!allowedExclusionCategories.has(entry.reasonCategory)) {
      throw new Error(
        `coverage-policy.json exclusions[${index}] has unsupported reasonCategory ${JSON.stringify(entry.reasonCategory)}.`,
      );
    }
    if (typeof entry.reason !== "string" || entry.reason.trim().length < MIN_EXCLUSION_REASON_LENGTH) {
      throw new Error(`coverage-policy.json exclusions[${index}] must include a specific reason.`);
    }
    return globToRegExp(normalizePath(pattern));
  });
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
    const branchMisses = collectBranchMisses(entry);
    const functionMisses = collectFunctionMisses(entry);
    if (uncovered.length === 0 && branchMisses.length === 0 && functionMisses.length === 0) {
      continue;
    }

    const coveredLines = [...lines.values()].filter(Boolean).length;
    const totalLines = lines.size;
    rows.push({
      coverageFile: normalizePath(path.relative(repoRoot, coverageFile)),
      path: relativePath,
      uncoveredLines: uncovered.length,
      uncoveredBranches: branchMisses.length,
      uncoveredFunctions: functionMisses.length,
      totalMisses: uncovered.length + branchMisses.length + functionMisses.length,
      coveredLines,
      totalLines,
      linePercent: totalLines > 0 ? roundPercent(coveredLines, totalLines) : 100,
      uncoveredRanges: compressRanges(uncovered),
      branchMisses,
      functionMisses,
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

function collectBranchMisses(entry) {
  const misses = [];
  for (const [branchId, rawCounts] of Object.entries(entry.b ?? {})) {
    const counts = Array.isArray(rawCounts) ? rawCounts : [];
    const branch = entry.branchMap?.[branchId] ?? {};
    const locations = Array.isArray(branch.locations) ? branch.locations : [];
    for (let index = 0; index < counts.length; index += 1) {
      if (Number(counts[index] ?? 0) > 0) {
        continue;
      }
      const loc = locations[index] ?? branch.loc ?? {};
      misses.push({
        id: branchId,
        type: String(branch.type ?? "unknown"),
        branchIndex: index,
        branchCount: counts.length,
        location: formatLocation(loc),
      });
    }
  }
  return misses.sort((left, right) => compareLocations(left.location, right.location));
}

function collectFunctionMisses(entry) {
  const misses = [];
  const functionMap = entry.fnMap ?? {};
  const functionIds = new Set([
    ...Object.keys(functionMap),
    ...Object.keys(entry.f ?? {}),
  ]);
  for (const functionId of functionIds) {
    if (Number(entry.f?.[functionId] ?? 0) > 0) {
      continue;
    }
    const fn = functionMap[functionId] ?? {};
    misses.push({
      id: functionId,
      name: String(fn.name || "(anonymous)"),
      location: formatLocation(fn.loc ?? fn.decl ?? { start: { line: fn.line, column: 0 } }),
    });
  }
  return misses.sort((left, right) => compareLocations(left.location, right.location));
}

function formatLocation(loc) {
  const startLine = Number(loc?.start?.line);
  const startColumn = Number(loc?.start?.column);
  const endLine = Number(loc?.end?.line);
  const endColumn = Number(loc?.end?.column);
  if (!Number.isFinite(startLine) || startLine <= 0) {
    return "unknown";
  }
  const start = Number.isFinite(startColumn) ? `${startLine}:${startColumn + 1}` : String(startLine);
  if (!Number.isFinite(endLine) || endLine <= 0) {
    return start;
  }
  const end = Number.isFinite(endColumn) ? `${endLine}:${endColumn + 1}` : String(endLine);
  return `${start}-${end}`;
}

function compareLocations(left, right) {
  return locationSortKey(left) - locationSortKey(right) || left.localeCompare(right);
}

function locationSortKey(value) {
  const match = /^(\d+)(?::(\d+))?/.exec(value);
  if (!match) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Number(match[1]) * 100000 + Number(match[2] ?? 0);
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
