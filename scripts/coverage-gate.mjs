import fs from "node:fs/promises";
import path from "node:path";

const repoRoot = process.cwd();
const summaryPath = path.join(repoRoot, "artifacts", "coverage", "coverage-summary.json");
const DEFAULT_LINE_THRESHOLD = 65;
const DEFAULT_BRANCH_THRESHOLD = 45;
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

if (failed) {
  process.exit(1);
}

console.log(
  `[coverage:gate] passed: line ${linePercent}% (>= ${resolved.line.value}%), `
  + `branch ${branchPercent}% (>= ${resolved.branch.value}%), profile ${profile}.`,
);

function resolveGateProfile() {
  const arg = process.argv.find((item) => item.startsWith("--profile="));
  const raw = arg?.slice("--profile=".length) || process.env.GOATCITADEL_COVERAGE_GATE_PROFILE || "default";
  if (raw === "default" || raw === "production") {
    return raw;
  }
  console.warn(`[coverage:gate] warning: unknown profile ${JSON.stringify(raw)}. Using default.`);
  return "default";
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
