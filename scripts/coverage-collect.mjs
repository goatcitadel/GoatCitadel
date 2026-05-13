import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import crypto from "node:crypto";
import ts from "typescript";

const repoRoot = process.cwd();
const artifactsDir = path.join(repoRoot, "artifacts", "coverage");
const summaryJsonPath = path.join(artifactsDir, "coverage-summary.json");
const summaryMdPath = path.join(artifactsDir, "coverage-summary.md");
const coveragePolicyPath = path.join(repoRoot, "coverage-policy.json");
const DEFAULT_LINE_THRESHOLD = 65;
const DEFAULT_BRANCH_THRESHOLD = 45;
const ALLOWED_EXCLUSION_CATEGORIES = new Set([
  "generated-static-adapter",
  "test-harness-setup",
  "type-only-barrel",
]);
const PRODUCTION_RISK_TIERS = [
  {
    id: "storage-policy-security-critical",
    label: "Storage, Policy, And Security-Critical Paths",
    lineThreshold: 90,
    branchThreshold: 80,
    sourcePrefixes: [
      "packages/storage/src/",
      "packages/policy-engine/src/",
    ],
  },
  {
    id: "gateway-shared-contracts",
    label: "Gateway And Shared Contracts",
    lineThreshold: 72.58,
    branchThreshold: 70,
    ratchet: {
      label: "gateway/shared coverage ratchet",
      baselineLinePercent: 72.22,
      baselineCapturedAt: "2026-05-13",
      currentLinePercent: 72.58,
      enforcedLineThreshold: 72.58,
      nextLineThreshold: 75,
      targetLineThreshold: 80,
      note: "Temporary enforced threshold is pinned to the focused-test ratchet; next ratchet is 75% and the tracked production target remains 80%.",
    },
    sourcePrefixes: [
      "apps/gateway/src/",
      "packages/gateway-core/src/",
      "packages/contracts/src/",
    ],
  },
  {
    id: "mission-control",
    label: "Mission Control UI Surfaces",
    lineThreshold: 75,
    branchThreshold: 60,
    sourcePrefixes: [
      "apps/mission-control/src/",
      "apps/mission-control-next/src/",
      "packages/mission-control-shared/src/",
      "packages/threaded-surface-core/src/",
    ],
  },
];
const sourceRunId = crypto.randomUUID();
const runStartedAt = new Date().toISOString();

const warnings = [];

await removeCoverageDirectories(path.join(repoRoot, "apps"));
await removeCoverageDirectories(path.join(repoRoot, "packages"));
await fs.mkdir(artifactsDir, { recursive: true });
await writeSummary({
  generatedAt: runStartedAt,
  status: "running",
  sourceRunId,
  runStartedAt,
  warnings,
});

try {
  execSync("pnpm --filter @goatcitadel/gateway... --if-present build", {
    cwd: repoRoot,
    stdio: "inherit",
  });
  execSync("pnpm -r --workspace-concurrency=1 --if-present test:coverage", {
    cwd: repoRoot,
    stdio: "inherit",
  });
  execSync("pnpm --filter @goatcitadel/gateway --if-present coverage:smoke", {
    cwd: repoRoot,
    stdio: "inherit",
  });
  execSync("pnpm --filter @goatcitadel/gateway --if-present coverage:exercise", {
    cwd: repoRoot,
    stdio: "inherit",
  });
} catch (error) {
  const failedAt = new Date().toISOString();
  warnings.push("Coverage collection failed before summary generation completed.");
  await writeSummary({
    generatedAt: failedAt,
    status: "failed",
    sourceRunId,
    runStartedAt,
    runFinishedAt: failedAt,
    warnings,
    error: error instanceof Error ? error.message : String(error),
  });
  throw error;
}

const coverageFiles = await findCoverageFinalFiles(repoRoot);
const coverageMap = await loadCoverageMap(coverageFiles, warnings);
const sourceFiles = await collectSourceFiles(repoRoot);
const coveragePolicy = await loadCoveragePolicy(sourceFiles);
const excludedSourceFileSet = new Set(coveragePolicy.excludedFiles.map((item) => item.path));
const includedSourceFiles = sourceFiles.filter((filePath) => {
  const relativePath = path.relative(repoRoot, filePath).replaceAll("\\", "/");
  return !excludedSourceFileSet.has(relativePath);
});
const moduleLoadSmokeTests = await findModuleLoadSmokeTests(repoRoot);

if (moduleLoadSmokeTests.length > 0) {
  warnings.push(
    `Coverage includes ${moduleLoadSmokeTests.length} module-load smoke test(s). `
    + "Treat package import coverage as packaging confidence, not behavioral coverage.",
  );
}

let coveredFiles = 0;
let uncoveredFiles = 0;
let lineTotal = 0;
let lineCovered = 0;
let branchTotal = 0;
let branchCovered = 0;
const uncoveredSample = [];
const topUncoveredFiles = [];
const packageBuckets = new Map();
const riskTierBuckets = new Map(PRODUCTION_RISK_TIERS.map((tier) => [tier.id, createCoverageBucket()]));

for (const filePath of includedSourceFiles) {
  const relativePath = path.relative(repoRoot, filePath).replaceAll("\\", "/");
  const normalized = normalizePathForLookup(filePath);
  const entry = coverageMap.get(normalized);
  const metrics = entry
    ? computeCoverageMetrics(entry)
    : {
      lineTotal: await countRelevantLines(filePath),
      lineCovered: 0,
    branchTotal: 0,
      branchCovered: 0,
  };
  const fileCovered = metrics.lineCovered > 0 || metrics.branchCovered > 0;
  const uncoveredLines = Math.max(0, metrics.lineTotal - metrics.lineCovered);

  lineTotal += metrics.lineTotal;
  lineCovered += metrics.lineCovered;
  branchTotal += metrics.branchTotal;
  branchCovered += metrics.branchCovered;

  if (fileCovered) {
    coveredFiles += 1;
  } else {
    uncoveredFiles += 1;
    if (uncoveredSample.length < 200) {
      uncoveredSample.push(relativePath);
    }
  }

  if (uncoveredLines > 0) {
    topUncoveredFiles.push({
      path: relativePath,
      uncoveredLines,
      coveredLines: metrics.lineCovered,
      totalLines: metrics.lineTotal,
      linePercent: percent(metrics.lineCovered, metrics.lineTotal, 0),
    });
  }

  const packageKey = getPackageKey(relativePath);
  if (packageKey) {
    const packageBucket = ensureBucket(packageBuckets, packageKey);
    addFileMetrics(packageBucket, metrics, fileCovered, relativePath);
  }

  for (const tier of PRODUCTION_RISK_TIERS) {
    if (!tier.sourcePrefixes.some((prefix) => relativePath.startsWith(prefix))) {
      continue;
    }
    addFileMetrics(riskTierBuckets.get(tier.id), metrics, fileCovered, relativePath);
  }
}

topUncoveredFiles.sort((left, right) => {
  if (right.uncoveredLines !== left.uncoveredLines) {
    return right.uncoveredLines - left.uncoveredLines;
  }
  return left.path.localeCompare(right.path);
});

const excludedSourceFiles = await buildExcludedSourceFileSummary(coveragePolicy.excludedFiles, coverageMap);

const fileCoveragePercent = includedSourceFiles.length === 0
  ? 0
  : Number(((coveredFiles / includedSourceFiles.length) * 100).toFixed(2));
const linePercent = lineTotal === 0
  ? 0
  : Number(((lineCovered / lineTotal) * 100).toFixed(2));
const branchPercent = branchTotal === 0
  ? 100
  : Number(((branchCovered / branchTotal) * 100).toFixed(2));

const resolvedThresholds = resolveThresholds(warnings);
const packageCoverage = [...packageBuckets.entries()]
  .map(([id, bucket]) => formatCoverageBucket(id, id, bucket))
  .sort((left, right) => left.id.localeCompare(right.id));
const riskTierCoverage = PRODUCTION_RISK_TIERS.map((tier) => {
  const bucket = riskTierBuckets.get(tier.id) ?? createCoverageBucket();
  const formatted = formatCoverageBucket(tier.id, tier.label, bucket);
  const passesLine = formatted.linePercent >= tier.lineThreshold;
  const passesBranch = formatted.branchPercent >= tier.branchThreshold;
  return {
    ...formatted,
    lineThreshold: tier.lineThreshold,
    branchThreshold: tier.branchThreshold,
    ratchet: tier.ratchet,
    passesLine,
    passesBranch,
    passes: passesLine && passesBranch,
    sourcePrefixes: tier.sourcePrefixes,
  };
});

const summary = {
  generatedAt: new Date().toISOString(),
  status: "success",
  sourceRunId,
  runStartedAt,
  runFinishedAt: new Date().toISOString(),
  sourceFiles: includedSourceFiles.length,
  totalSourceFiles: sourceFiles.length,
  excludedSourceFiles,
  coveredFiles,
  uncoveredFiles,
  fileCoveragePercent,
  linePercent,
  branchPercent,
  lineTotals: {
    covered: lineCovered,
    total: lineTotal,
  },
  branchTotals: {
    covered: branchCovered,
    total: branchTotal,
  },
  effectiveThresholds: {
    line: resolvedThresholds.line.value,
    branch: resolvedThresholds.branch.value,
  },
  thresholdSource: {
    line: resolvedThresholds.line.source,
    branch: resolvedThresholds.branch.source,
  },
  packageCoverage,
  riskTierCoverage,
  productionTargets: {
    profile: "production",
    allRiskTiersPass: riskTierCoverage.every((tier) => tier.passes),
  },
  warnings,
  coverageFinalFiles: coverageFiles.map((filePath) => path.relative(repoRoot, filePath).replaceAll("\\", "/")),
  uncoveredSample,
  topUncoveredFiles: topUncoveredFiles.slice(0, 100),
  coveragePolicy: {
    path: path.relative(repoRoot, coveragePolicyPath).replaceAll("\\", "/"),
    allowedReasonCategories: [...ALLOWED_EXCLUSION_CATEGORIES].sort(),
    exclusionCount: coveragePolicy.exclusions.length,
    excludedSourceFileCount: excludedSourceFiles.length,
  },
  syntheticCoverageNotes: {
    moduleLoadSmokeTests,
  },
};

await writeSummary(summary);

console.log(`[coverage] summary written to ${path.relative(repoRoot, summaryJsonPath)}`);
console.log(`[coverage] line coverage: ${summary.linePercent}% (${summary.lineTotals.covered}/${summary.lineTotals.total})`);
console.log(`[coverage] branch coverage: ${summary.branchPercent}% (${summary.branchTotals.covered}/${summary.branchTotals.total})`);

async function removeCoverageDirectories(root) {
  const entries = await safeReadDir(root);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const packageDir = path.join(root, entry.name);
    const packageEntries = await safeReadDir(packageDir);
    for (const packageEntry of packageEntries) {
      if (!packageEntry.isDirectory()) {
        continue;
      }
      if (!packageEntry.name.startsWith("coverage")) {
        continue;
      }
      await fs.rm(path.join(packageDir, packageEntry.name), { recursive: true, force: true });
    }
  }
}

async function findCoverageFinalFiles(root) {
  const candidates = [];
  for (const base of ["apps", "packages"]) {
    const dir = path.join(root, base);
    const entries = await safeReadDir(dir);
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }
      const packageDir = path.join(dir, entry.name);
      const packageEntries = await safeReadDir(packageDir);
      for (const packageEntry of packageEntries) {
        if (!packageEntry.isDirectory()) {
          continue;
        }
        if (!packageEntry.name.startsWith("coverage")) {
          continue;
        }
        const coverageFile = path.join(packageDir, packageEntry.name, "coverage-final.json");
        try {
          await fs.access(coverageFile);
          candidates.push(coverageFile);
        } catch {
          // report folder may not contain coverage-final
        }
      }
    }
  }
  return candidates;
}

async function loadCoverageMap(files, warningsList) {
  const map = new Map();
  for (const filePath of files) {
    let raw = "";
    try {
      raw = await fs.readFile(filePath, "utf8");
    } catch {
      warningsList.push(`Unable to read coverage report: ${path.relative(repoRoot, filePath)}`);
      continue;
    }

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      warningsList.push(`Invalid JSON in coverage report: ${path.relative(repoRoot, filePath)}`);
      continue;
    }

    for (const [coveredPath, data] of Object.entries(parsed)) {
      const normalized = normalizePathForLookup(String(coveredPath));
      const existing = map.get(normalized);
      map.set(normalized, existing ? mergeCoverageEntries(existing, data) : data);
    }
  }
  return map;
}

function mergeCoverageEntries(left, right) {
  const merged = {
    ...left,
    ...right,
    s: mergeHitMap(left.s, right.s),
    l: mergeHitMap(left.l, right.l),
    b: mergeBranchMap(left.b, right.b),
    statementMap: {
      ...(left.statementMap ?? {}),
      ...(right.statementMap ?? {}),
    },
    fnMap: {
      ...(left.fnMap ?? {}),
      ...(right.fnMap ?? {}),
    },
    branchMap: {
      ...(left.branchMap ?? {}),
      ...(right.branchMap ?? {}),
    },
  };
  return merged;
}

function mergeHitMap(left = {}, right = {}) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const previous = Number(merged[key] ?? 0);
    const next = Number(value ?? 0);
    merged[key] = Number.isFinite(previous) && Number.isFinite(next)
      ? Math.max(previous, next)
      : next;
  }
  return merged;
}

function mergeBranchMap(left = {}, right = {}) {
  const merged = { ...left };
  for (const [key, value] of Object.entries(right)) {
    const existing = Array.isArray(merged[key]) ? merged[key] : [];
    const incoming = Array.isArray(value) ? value : [];
    const length = Math.max(existing.length, incoming.length);
    const next = [];
    for (let index = 0; index < length; index += 1) {
      const previous = Number(existing[index] ?? 0);
      const current = Number(incoming[index] ?? 0);
      next.push(Number.isFinite(previous) && Number.isFinite(current) ? Math.max(previous, current) : current);
    }
    merged[key] = next;
  }
  return merged;
}

async function collectSourceFiles(root) {
  const out = [];
  for (const base of ["apps", "packages"]) {
    const baseDir = path.join(root, base);
    await walk(baseDir, out);
  }
  return out;
}

async function findModuleLoadSmokeTests(root) {
  const out = [];
  for (const base of ["apps", "packages"]) {
    const baseDir = path.join(root, base);
    await walkModuleLoadSmokeTests(baseDir, out);
  }
  return out;
}

async function walkModuleLoadSmokeTests(current, out) {
  const entries = await safeReadDir(current);
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules" || entry.name.startsWith("coverage")) {
        continue;
      }
      await walkModuleLoadSmokeTests(fullPath, out);
      continue;
    }
    if (!entry.name.match(/module-load-smoke\.test\.tsx?$/)) {
      continue;
    }
    out.push(path.relative(repoRoot, fullPath).replaceAll("\\", "/"));
  }
}

async function walk(current, out) {
  const entries = await safeReadDir(current);
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "dist" || entry.name === "node_modules" || entry.name === "coverage") {
        continue;
      }
      await walk(fullPath, out);
      continue;
    }
    if (!fullPath.includes(`${path.sep}src${path.sep}`)) {
      continue;
    }
    if (!/\.(ts|tsx)$/.test(entry.name)) {
      continue;
    }
    if (
      entry.name.endsWith(".d.ts")
      || entry.name.endsWith(".test.ts")
      || entry.name.endsWith(".test.tsx")
      || entry.name.endsWith(".spec.ts")
      || entry.name.endsWith(".spec.tsx")
    ) {
      continue;
    }
    out.push(path.resolve(fullPath));
  }
}

function computeCoverageMetrics(entry) {
  const statements = entry && typeof entry === "object" && "s" in entry
    ? Object.entries(entry.s ?? {})
    : [];

  const statementMap = entry && typeof entry === "object" && "statementMap" in entry
    ? entry.statementMap ?? {}
    : {};

  const lineCoverage = entry && typeof entry === "object" && "l" in entry
    ? entry.l ?? {}
    : {};

  const lineHits = new Map();
  if (lineCoverage && typeof lineCoverage === "object") {
    for (const [lineNumber, count] of Object.entries(lineCoverage)) {
      const line = Number(lineNumber);
      if (!Number.isFinite(line) || line <= 0) {
        continue;
      }
      const current = lineHits.get(line) ?? false;
      lineHits.set(line, current || Number(count) > 0);
    }
  }

  for (const [statementId, count] of statements) {
    const location = statementMap[statementId];
    const line = Number(location?.start?.line);
    if (!Number.isFinite(line) || line <= 0) {
      continue;
    }
    const current = lineHits.get(line) ?? false;
    lineHits.set(line, current || Number(count) > 0);
  }

  const lineTotal = lineHits.size;
  const lineCovered = [...lineHits.values()].filter(Boolean).length;

  const branchMap = entry && typeof entry === "object" && "b" in entry
    ? entry.b ?? {}
    : {};
  let branchTotal = 0;
  let branchCovered = 0;
  for (const counts of Object.values(branchMap)) {
    if (!Array.isArray(counts)) {
      continue;
    }
    branchTotal += counts.length;
    branchCovered += counts.filter((count) => Number(count) > 0).length;
  }

  return {
    lineTotal,
    lineCovered,
    branchTotal,
    branchCovered,
  };
}

function createCoverageBucket() {
  return {
    sourceFiles: 0,
    coveredFiles: 0,
    uncoveredFiles: 0,
    lineTotal: 0,
    lineCovered: 0,
    branchTotal: 0,
    branchCovered: 0,
    uncoveredSample: [],
  };
}

function ensureBucket(map, id) {
  const existing = map.get(id);
  if (existing) {
    return existing;
  }
  const next = createCoverageBucket();
  map.set(id, next);
  return next;
}

function addFileMetrics(bucket, metrics, fileCovered, relativePath) {
  if (!bucket) {
    return;
  }
  bucket.sourceFiles += 1;
  bucket.lineTotal += metrics.lineTotal;
  bucket.lineCovered += metrics.lineCovered;
  bucket.branchTotal += metrics.branchTotal;
  bucket.branchCovered += metrics.branchCovered;
  if (fileCovered) {
    bucket.coveredFiles += 1;
  } else {
    bucket.uncoveredFiles += 1;
    if (bucket.uncoveredSample.length < 50) {
      bucket.uncoveredSample.push(relativePath);
    }
  }
}

function formatCoverageBucket(id, label, bucket) {
  const lineUncovered = Math.max(0, bucket.lineTotal - bucket.lineCovered);
  const branchUncovered = Math.max(0, bucket.branchTotal - bucket.branchCovered);
  return {
    id,
    label,
    sourceFiles: bucket.sourceFiles,
    coveredFiles: bucket.coveredFiles,
    uncoveredFiles: bucket.uncoveredFiles,
    fileCoveragePercent: percent(bucket.coveredFiles, bucket.sourceFiles, 0),
    linePercent: percent(bucket.lineCovered, bucket.lineTotal, 0),
    branchPercent: percent(bucket.branchCovered, bucket.branchTotal, 100),
    lineTotals: {
      covered: bucket.lineCovered,
      uncovered: lineUncovered,
      total: bucket.lineTotal,
    },
    branchTotals: {
      covered: bucket.branchCovered,
      uncovered: branchUncovered,
      total: bucket.branchTotal,
    },
    uncoveredSample: bucket.uncoveredSample,
  };
}

async function loadCoveragePolicy(sourceFilePaths) {
  let raw = "";
  try {
    raw = await fs.readFile(coveragePolicyPath, "utf8");
  } catch (error) {
    if ((error instanceof Error && "code" in error && error.code === "ENOENT")) {
      return {
        exclusions: [],
        excludedFiles: [],
      };
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
    if (!ALLOWED_EXCLUSION_CATEGORIES.has(category)) {
      throw new Error(`coverage-policy.json declares unsupported exclusion category ${JSON.stringify(category)}.`);
    }
  }

  const sourceRelativePaths = sourceFilePaths.map((filePath) => path.relative(repoRoot, filePath).replaceAll("\\", "/"));
  const excludedFileMap = new Map();
  const exclusions = parsed.exclusions.map((entry, index) => validateCoveragePolicyEntry(entry, index));
  for (const exclusion of exclusions) {
    const matcher = globToRegExp(exclusion.pattern);
    const matches = sourceRelativePaths.filter((relativePath) => matcher.test(relativePath));
    if (matches.length === 0) {
      throw new Error(`coverage-policy.json exclusion ${JSON.stringify(exclusion.pattern)} does not match any source file.`);
    }
    for (const match of matches) {
      const existing = excludedFileMap.get(match);
      if (existing) {
        throw new Error(
          `coverage-policy.json excludes ${match} more than once `
          + `(${existing.pattern} and ${exclusion.pattern}).`,
        );
      }
      excludedFileMap.set(match, {
        path: match,
        pattern: exclusion.pattern,
        reasonCategory: exclusion.reasonCategory,
        reason: exclusion.reason,
      });
    }
  }

  return {
    exclusions,
    excludedFiles: [...excludedFileMap.values()].sort((left, right) => left.path.localeCompare(right.path)),
  };
}

function validateCoveragePolicyEntry(entry, index) {
  if (!entry || typeof entry !== "object") {
    throw new Error(`coverage-policy.json exclusions[${index}] must be an object.`);
  }
  const pattern = typeof entry.pattern === "string" ? entry.pattern.trim() : "";
  const reasonCategory = typeof entry.reasonCategory === "string" ? entry.reasonCategory.trim() : "";
  const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
  if (!pattern) {
    throw new Error(`coverage-policy.json exclusions[${index}] must define pattern.`);
  }
  if (!ALLOWED_EXCLUSION_CATEGORIES.has(reasonCategory)) {
    throw new Error(
      `coverage-policy.json exclusions[${index}] has unsupported reasonCategory ${JSON.stringify(reasonCategory)}.`,
    );
  }
  if (reason.length < 20) {
    throw new Error(`coverage-policy.json exclusions[${index}] must include a specific reason.`);
  }
  return { pattern, reasonCategory, reason };
}

function globToRegExp(pattern) {
  const normalized = pattern.replaceAll("\\", "/");
  let source = "^";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    const next = normalized[index + 1];
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    source += escapeRegExp(char);
  }
  source += "$";
  return new RegExp(source);
}

function escapeRegExp(value) {
  return value.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&");
}

async function buildExcludedSourceFileSummary(excludedFiles, coverageMap) {
  const out = [];
  for (const item of excludedFiles) {
    const fullPath = path.join(repoRoot, item.path);
    const entry = coverageMap.get(normalizePathForLookup(fullPath));
    const metrics = entry
      ? computeCoverageMetrics(entry)
      : {
        lineTotal: await countRelevantLines(fullPath),
        lineCovered: 0,
        branchTotal: 0,
        branchCovered: 0,
      };
    out.push({
      ...item,
      lineTotals: {
        covered: metrics.lineCovered,
        uncovered: Math.max(0, metrics.lineTotal - metrics.lineCovered),
        total: metrics.lineTotal,
      },
      branchTotals: {
        covered: metrics.branchCovered,
        uncovered: Math.max(0, metrics.branchTotal - metrics.branchCovered),
        total: metrics.branchTotal,
      },
    });
  }
  return out;
}

function getPackageKey(relativePath) {
  const segments = relativePath.split("/");
  if (segments.length < 3) {
    return undefined;
  }
  if (segments[0] !== "apps" && segments[0] !== "packages") {
    return undefined;
  }
  return `${segments[0]}/${segments[1]}`;
}

function percent(covered, total, emptyValue) {
  if (total === 0) {
    return emptyValue;
  }
  return Number(((covered / total) * 100).toFixed(2));
}

async function countRelevantLines(filePath) {
  let raw = "";
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch {
    return 0;
  }

  const candidates = collectCandidateLines(raw);
  if (candidates.size === 0) {
    return 0;
  }

  const scriptKind = filePath.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const source = ts.createSourceFile(filePath, raw, ts.ScriptTarget.Latest, true, scriptKind);
  const typeOnlyRanges = [];
  collectTypeOnlyRanges(source, typeOnlyRanges);
  for (const range of typeOnlyRanges) {
    for (let line = range.start; line <= range.end; line += 1) {
      candidates.delete(line);
    }
  }

  return candidates.size;
}

function collectCandidateLines(raw) {
  const candidates = new Set();
  const lines = raw.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const trimmed = (lines[index] ?? "").trim();
    if (!trimmed || trimmed.startsWith("//")) {
      continue;
    }
    candidates.add(index + 1);
  }
  return candidates;
}

function collectTypeOnlyRanges(node, out) {
  if (isTypeOnlyNode(node)) {
    out.push(getNodeLineRange(node));
    return;
  }
  ts.forEachChild(node, (child) => collectTypeOnlyRanges(child, out));
}

function isTypeOnlyNode(node) {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    return true;
  }
  if (ts.isImportDeclaration(node)) {
    return Boolean(node.importClause?.isTypeOnly);
  }
  if (ts.isExportDeclaration(node)) {
    return Boolean(node.isTypeOnly);
  }
  if (ts.isImportEqualsDeclaration(node)) {
    return Boolean(node.isTypeOnly);
  }
  if (hasDeclareModifier(node)) {
    return true;
  }
  return false;
}

function hasDeclareModifier(node) {
  const modifiers = node.modifiers ?? [];
  return modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword);
}

function getNodeLineRange(node) {
  const source = node.getSourceFile();
  const start = source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const end = source.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return { start, end };
}

function normalizePathForLookup(inputPath) {
  const withoutFileScheme = inputPath.replace(/^file:\/\//i, "");
  return path.resolve(withoutFileScheme).replaceAll("\\", "/").toLowerCase();
}

function resolveThresholds(warningsList) {
  const allowLower = process.env.GOATCITADEL_ALLOW_LOWER_COVERAGE_GATE === "1";
  return {
    line: resolveThreshold(
      process.env.GOATCITADEL_COVERAGE_LINE_THRESHOLD,
      DEFAULT_LINE_THRESHOLD,
      "GOATCITADEL_COVERAGE_LINE_THRESHOLD",
      allowLower,
      warningsList,
    ),
    branch: resolveThreshold(
      process.env.GOATCITADEL_COVERAGE_BRANCH_THRESHOLD,
      DEFAULT_BRANCH_THRESHOLD,
      "GOATCITADEL_COVERAGE_BRANCH_THRESHOLD",
      allowLower,
      warningsList,
    ),
  };
}

function resolveThreshold(raw, fallback, envName, allowLower, warningsList) {
  if (!raw) {
    return { value: fallback, source: "default" };
  }

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 100) {
    warningsList.push(`${envName}="${raw}" is invalid. Using default ${fallback}.`);
    return { value: fallback, source: "default_invalid_override" };
  }

  if (parsed < fallback && !allowLower) {
    warningsList.push(`${envName}=${parsed} is below default ${fallback}. Set GOATCITADEL_ALLOW_LOWER_COVERAGE_GATE=1 to allow lower gates.`);
    return { value: fallback, source: "default_clamped" };
  }

  if (parsed < fallback && allowLower) {
    warningsList.push(`${envName}=${parsed} is below default ${fallback} (allowed by GOATCITADEL_ALLOW_LOWER_COVERAGE_GATE=1).`);
  }

  return { value: parsed, source: "env" };
}

async function safeReadDir(dir) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function writeSummary(summary) {
  await fs.writeFile(summaryJsonPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await fs.writeFile(summaryMdPath, buildMarkdownSummary(summary), "utf8");
}

function buildMarkdownSummary(summary) {
  const coverageFinalFiles = Array.isArray(summary.coverageFinalFiles) ? summary.coverageFinalFiles : [];
  const uncoveredSample = Array.isArray(summary.uncoveredSample) ? summary.uncoveredSample : [];
  const packageCoverage = Array.isArray(summary.packageCoverage) ? summary.packageCoverage : [];
  const riskTierCoverage = Array.isArray(summary.riskTierCoverage) ? summary.riskTierCoverage : [];
  const excludedSourceFiles = Array.isArray(summary.excludedSourceFiles) ? summary.excludedSourceFiles : [];
  const topUncoveredFiles = Array.isArray(summary.topUncoveredFiles) ? summary.topUncoveredFiles : [];
  const lineTotals = summary.lineTotals ?? { covered: 0, total: 0 };
  const branchTotals = summary.branchTotals ?? { covered: 0, total: 0 };
  const effectiveThresholds = summary.effectiveThresholds ?? { line: DEFAULT_LINE_THRESHOLD, branch: DEFAULT_BRANCH_THRESHOLD };
  const thresholdSource = summary.thresholdSource ?? { line: "default", branch: "default" };
  const coverageFiles = coverageFinalFiles.length > 0
    ? coverageFinalFiles.map((item) => `- \`${item}\``).join("\n")
    : "- none";
  const uncovered = uncoveredSample.length > 0
    ? uncoveredSample.map((item) => `- \`${item}\``).join("\n")
    : "- none";
  const warningsSection = summary.warnings.length > 0
    ? summary.warnings.map((item) => `- ${item}`).join("\n")
    : "- none";
  const syntheticCoverageNotes = summary.syntheticCoverageNotes?.moduleLoadSmokeTests ?? [];
  const syntheticSection = syntheticCoverageNotes.length > 0
    ? syntheticCoverageNotes.map((item) => `- \`${item}\``).join("\n")
    : "- none";
  const packageSection = packageCoverage.length > 0
    ? [
      "| Package | Files | Lines | Branches |",
      "| --- | ---: | ---: | ---: |",
      ...packageCoverage.map((item) => {
        const lines = item.lineTotals ?? { covered: 0, total: 0 };
        const branches = item.branchTotals ?? { covered: 0, total: 0 };
        return `| \`${item.id}\` | ${item.coveredFiles ?? 0}/${item.sourceFiles ?? 0} (${item.fileCoveragePercent ?? 0}%) | ${item.linePercent ?? 0}% (${lines.covered}/${lines.total}, ${lines.uncovered ?? 0} uncovered) | ${item.branchPercent ?? 0}% (${branches.covered}/${branches.total}, ${branches.uncovered ?? 0} uncovered) |`;
      }),
    ].join("\n")
    : "- none";
  const riskTierSection = riskTierCoverage.length > 0
    ? [
      "| Risk Tier | Lines | Branches | Target | Status |",
      "| --- | ---: | ---: | --- | --- |",
      ...riskTierCoverage.map((item) => {
        const nextTarget = item.ratchet?.nextLineThreshold
          ? `, next ratchet ${item.ratchet.nextLineThreshold}% lines`
          : "";
        const productionTarget = item.ratchet?.targetLineThreshold
          ? `, production target ${item.ratchet.targetLineThreshold}% lines`
          : "";
        const target = `${item.lineThreshold ?? "n/a"}% lines / ${item.branchThreshold ?? "n/a"}% branches${nextTarget}${productionTarget}`;
        const status = item.passes ? "pass" : "below target";
        return `| \`${item.id}\` | ${item.linePercent ?? 0}% | ${item.branchPercent ?? 0}% | ${target} | ${status} |`;
      }),
    ].join("\n")
    : "- none";
  const excludedSection = excludedSourceFiles.length > 0
    ? [
      "| File | Reason | Lines removed |",
      "| --- | --- | ---: |",
      ...excludedSourceFiles.map((item) => {
        const lines = item.lineTotals ?? { total: 0 };
        return `| \`${item.path}\` | ${item.reasonCategory}: ${item.reason} | ${lines.total ?? 0} |`;
      }),
    ].join("\n")
    : "- none";
  const topUncoveredSection = topUncoveredFiles.length > 0
    ? [
      "| File | Lines | Coverage |",
      "| --- | ---: | ---: |",
      ...topUncoveredFiles.map((item) => (
        `| \`${item.path}\` | ${item.uncoveredLines}/${item.totalLines} uncovered | ${item.linePercent}% |`
      )),
    ].join("\n")
    : "- none";

  return [
    "# Coverage Summary",
    "",
    `- Generated: ${summary.generatedAt}`,
    `- Status: ${summary.status ?? "unknown"}`,
    `- Run ID: ${summary.sourceRunId ?? "unknown"}`,
    `- Run started: ${summary.runStartedAt ?? "unknown"}`,
    `- Run finished: ${summary.runFinishedAt ?? "n/a"}`,
    `- File coverage: ${summary.fileCoveragePercent ?? 0}% (${summary.coveredFiles ?? 0}/${summary.sourceFiles ?? 0} included; ${summary.totalSourceFiles ?? summary.sourceFiles ?? 0} total source files)`,
    `- Line coverage: ${summary.linePercent ?? 0}% (${lineTotals.covered}/${lineTotals.total})`,
    `- Branch coverage: ${summary.branchPercent ?? 0}% (${branchTotals.covered}/${branchTotals.total})`,
    `- Effective thresholds: line ${effectiveThresholds.line}%, branch ${effectiveThresholds.branch}%`,
    `- Threshold source: line=${thresholdSource.line}, branch=${thresholdSource.branch}`,
    "",
    "## Warnings",
    warningsSection,
    "",
    "## Collection Error",
    summary.error ? `- ${summary.error}` : "- none",
    "",
    "## Coverage Reports",
    coverageFiles,
    "",
    "## Package Coverage",
    packageSection,
    "",
    "## Production Risk Tiers",
    riskTierSection,
    "",
    "## Coverage Policy Exclusions",
    excludedSection,
    "",
    "## Top Uncovered Files",
    topUncoveredSection,
    "",
    "## Synthetic Coverage Notes",
    syntheticSection,
    "",
    "## Uncovered Sample (first 200)",
    uncovered,
    "",
  ].join("\n");
}
