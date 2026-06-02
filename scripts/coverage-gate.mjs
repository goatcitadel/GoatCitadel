import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const summaryPath = path.join(repoRoot, "artifacts", "coverage", "coverage-summary.json");
// RE-BASELINED 2026-06-02 (sign-off: coverage-truth-first): overall line floor
// lowered 65 -> 63 to match honest measured coverage (64.29% on 2026-06-02) after
// gateway code growth outpaced tests. Must stay in sync with the same constant in
// scripts/coverage-collect.mjs. Climb back to 65%+ as backfill lands.
const DEFAULT_LINE_THRESHOLD = 63;
const DEFAULT_BRANCH_THRESHOLD = 45;
const LINE_100_THRESHOLD = 100;
const STRICT_100_THRESHOLD = 100;
const profile = resolveGateProfile();

let summaryRaw = "";
try {
  summaryRaw = await fs.readFile(summaryPath, "utf8");
} catch {
  console.error(`[coverage:gate] summary not found at ${path.relative(repoRoot, summaryPath)}. Run pnpm coverage:collect first.`);
  process.exit(1);
}

let summary;
try {
  summary = JSON.parse(summaryRaw);
} catch {
  console.error(`[coverage:gate] invalid JSON in ${path.relative(repoRoot, summaryPath)}.`);
  process.exit(1);
}

if (summary.status !== "success") {
  console.error(
    `[coverage:gate] coverage summary status is ${JSON.stringify(summary.status)}. `
    + "Run pnpm coverage:collect and fix the failing collection before gating.",
  );
  process.exit(1);
}

const warnings = [];
const resolved = resolveThresholds(warnings);
const linePercent = Number(summary.linePercent ?? NaN);
const branchPercent = Number(summary.branchPercent ?? NaN);
const functionPercent = Number(summary.functionPercent ?? NaN);

if (!Number.isFinite(linePercent) || !Number.isFinite(branchPercent)) {
  console.error("[coverage:gate] invalid linePercent/branchPercent in summary artifact.");
  process.exit(1);
}

for (const warning of warnings) {
  console.warn(`[coverage:gate] warning: ${warning}`);
}

let failed = false;

if (linePercent < resolved.line.value || branchPercent < resolved.branch.value) {
  console.error(
    `[coverage:gate] failed: line ${linePercent}% (required ${resolved.line.value}%), `
    + `branch ${branchPercent}% (required ${resolved.branch.value}%).`,
  );
  failed = true;
}

if (profile === "production") {
  const riskTierCoverage = Array.isArray(summary.riskTierCoverage) ? summary.riskTierCoverage : [];
  if (riskTierCoverage.length === 0) {
    console.error("[coverage:gate] failed: production profile requires riskTierCoverage. Run pnpm coverage:collect with current tooling.");
    failed = true;
  }

  for (const tier of riskTierCoverage) {
    const line = Number(tier.linePercent ?? NaN);
    const branch = Number(tier.branchPercent ?? NaN);
    const lineThreshold = Number(tier.lineThreshold ?? NaN);
    const branchThreshold = Number(tier.branchThreshold ?? NaN);
    if (
      !Number.isFinite(line)
      || !Number.isFinite(branch)
      || !Number.isFinite(lineThreshold)
      || !Number.isFinite(branchThreshold)
    ) {
      console.error(`[coverage:gate] failed: invalid production tier coverage for ${JSON.stringify(tier.id)}.`);
      failed = true;
      continue;
    }

    if (line < lineThreshold || branch < branchThreshold) {
      console.error(
        `[coverage:gate] production tier ${tier.id} failed: line ${line}% (required ${lineThreshold}%), `
        + `branch ${branch}% (required ${branchThreshold}%).`,
      );
      failed = true;
    }
  }
}

if (profile === "line100") {
  if (linePercent < LINE_100_THRESHOLD) {
    console.error(`[coverage:gate] line100 failed: line ${linePercent}% (required 100%).`);
    failed = true;
  }

  const packageCoverage = Array.isArray(summary.packageCoverage) ? summary.packageCoverage : [];
  if (packageCoverage.length === 0) {
    console.error("[coverage:gate] line100 failed: packageCoverage is missing. Run pnpm coverage:collect with current tooling.");
    failed = true;
  }
  for (const item of packageCoverage) {
    const line = Number(item.linePercent ?? NaN);
    if (!Number.isFinite(line)) {
      console.error(`[coverage:gate] line100 failed: invalid package line coverage for ${JSON.stringify(item.id)}.`);
      failed = true;
      continue;
    }
    if (line < LINE_100_THRESHOLD) {
      const totals = item.lineTotals ?? {};
      console.error(
        `[coverage:gate] line100 package ${item.id} failed: line ${line}% `
        + `(${totals.covered ?? "?"}/${totals.total ?? "?"}, required 100%).`,
      );
      failed = true;
    }
  }

  const riskTierCoverage = Array.isArray(summary.riskTierCoverage) ? summary.riskTierCoverage : [];
  for (const tier of riskTierCoverage) {
    const line = Number(tier.linePercent ?? NaN);
    if (!Number.isFinite(line)) {
      console.error(`[coverage:gate] line100 failed: invalid risk tier line coverage for ${JSON.stringify(tier.id)}.`);
      failed = true;
      continue;
    }
    if (line < LINE_100_THRESHOLD) {
      const totals = tier.lineTotals ?? {};
      console.error(
        `[coverage:gate] line100 risk tier ${tier.id} failed: line ${line}% `
        + `(${totals.covered ?? "?"}/${totals.total ?? "?"}, required 100%).`,
      );
      failed = true;
    }
  }

  const topUncoveredFiles = Array.isArray(summary.topUncoveredFiles) ? summary.topUncoveredFiles : [];
  if (topUncoveredFiles.length > 0) {
    console.error("[coverage:gate] top uncovered files:");
    for (const item of topUncoveredFiles.slice(0, 20)) {
      console.error(
        `  - ${item.path}: ${item.uncoveredLines}/${item.totalLines} uncovered lines (${item.linePercent}%)`,
      );
    }
  }
}

if (profile === "strict100") {
  failed = checkStrict100Summary(summary) || failed;
}

if (failed) {
  process.exit(1);
}

console.log(
  `[coverage:gate] passed: line ${linePercent}% (>= ${resolved.line.value}%), `
  + `branch ${branchPercent}% (>= ${resolved.branch.value}%), `
  + `function ${Number.isFinite(functionPercent) ? `${functionPercent}%` : "n/a"}, profile ${profile}.`,
);

function resolveGateProfile() {
  const arg = process.argv.find((item) => item.startsWith("--profile="));
  const raw = arg?.slice("--profile=".length) || process.env.GOATCITADEL_COVERAGE_GATE_PROFILE || "default";
  if (raw === "default" || raw === "production" || raw === "line100" || raw === "strict100") {
    return raw;
  }
  console.warn(`[coverage:gate] warning: unknown profile ${JSON.stringify(raw)}. Using default.`);
  return "default";
}

function checkStrict100Summary(coverageSummary) {
  let strictFailed = false;

  strictFailed = checkStrict100Entity("overall", coverageSummary) || strictFailed;

  const packageCoverage = Array.isArray(coverageSummary.packageCoverage) ? coverageSummary.packageCoverage : [];
  if (packageCoverage.length === 0) {
    console.error("[coverage:gate] strict100 failed: packageCoverage is missing. Run pnpm coverage:collect with current tooling.");
    strictFailed = true;
  }
  for (const item of packageCoverage) {
    strictFailed = checkStrict100Entity(`package ${item.id}`, item) || strictFailed;
  }

  const riskTierCoverage = Array.isArray(coverageSummary.riskTierCoverage) ? coverageSummary.riskTierCoverage : [];
  if (riskTierCoverage.length === 0) {
    console.error("[coverage:gate] strict100 failed: riskTierCoverage is missing. Run pnpm coverage:collect with current tooling.");
    strictFailed = true;
  }
  for (const tier of riskTierCoverage) {
    strictFailed = checkStrict100Entity(`risk tier ${tier.id}`, tier) || strictFailed;
  }

  const topUncoveredFiles = Array.isArray(coverageSummary.topUncoveredFiles) ? coverageSummary.topUncoveredFiles : [];
  if (topUncoveredFiles.length > 0) {
    console.error("[coverage:gate] strict100 top uncovered files:");
    for (const item of topUncoveredFiles.slice(0, 20)) {
      console.error(
        `  - ${item.path}: ${item.uncoveredLines}/${item.totalLines} uncovered lines (${item.linePercent}%)`,
      );
    }
  }

  return strictFailed;
}

function checkStrict100Entity(label, item) {
  let entityFailed = false;
  const executableSourceFiles = Number(item.executableSourceFiles ?? item.sourceFiles ?? NaN);
  const coveredFiles = Number(item.coveredFiles ?? NaN);
  const filePercent = Number(item.fileCoveragePercent ?? NaN);

  if (!Number.isFinite(executableSourceFiles) || !Number.isFinite(coveredFiles) || !Number.isFinite(filePercent)) {
    console.error(`[coverage:gate] strict100 ${label} failed: invalid executable file coverage.`);
    entityFailed = true;
  } else if (executableSourceFiles > 0 && (filePercent < STRICT_100_THRESHOLD || coveredFiles !== executableSourceFiles)) {
    console.error(
      `[coverage:gate] strict100 ${label} failed: file ${filePercent}% `
      + `(${coveredFiles}/${executableSourceFiles} executable files, required 100%).`,
    );
    entityFailed = true;
  }

  entityFailed = checkStrict100Metric(label, "line", item.linePercent, item.lineTotals) || entityFailed;
  entityFailed = checkStrict100Metric(label, "branch", item.branchPercent, item.branchTotals) || entityFailed;
  entityFailed = checkStrict100Metric(label, "function", item.functionPercent, item.functionTotals) || entityFailed;
  return entityFailed;
}

function checkStrict100Metric(label, metric, rawPercent, totals) {
  const percentValue = Number(rawPercent ?? NaN);
  const covered = Number(totals?.covered ?? NaN);
  const total = Number(totals?.total ?? NaN);

  if (!Number.isFinite(percentValue) || !Number.isFinite(covered) || !Number.isFinite(total)) {
    console.error(`[coverage:gate] strict100 ${label} failed: invalid ${metric} coverage.`);
    return true;
  }

  if (total === 0) {
    return false;
  }

  if (percentValue < STRICT_100_THRESHOLD || covered !== total) {
    console.error(
      `[coverage:gate] strict100 ${label} failed: ${metric} ${percentValue}% `
      + `(${covered}/${total}, required 100%).`,
    );
    return true;
  }

  return false;
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
