import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  assertArchitectureMetricsCaptureClean,
  collectArchitectureMetrics,
  createArchitectureMetricsBaseline,
} from "./verification/lib/architecture-metrics.mjs";

const execFile = promisify(execFileCallback);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const baselinePath = path.join(repoRoot, "scripts", "verification", "baselines", "architecture-metrics.json");
const measuredSourcePaths = [
  "apps/gateway/src",
  "package.json",
  "scripts/update-architecture-metrics-baseline.mjs",
  "scripts/verification/lib/architecture-metrics.mjs",
  "scripts/verification/lib/architecture-metrics.test.mjs",
  "scripts/verification/lib/scenarios/architecture-metrics-lane.mjs",
];
const allowedArguments = new Set(["--allow-dirty-review-candidate"]);
const unknownArguments = process.argv.slice(2).filter((argument) => !allowedArguments.has(argument));
if (unknownArguments.length > 0) {
  throw new Error(`Unknown architecture baseline update argument(s): ${unknownArguments.join(", ")}`);
}
const allowDirtyReviewCandidate = process.argv.includes("--allow-dirty-review-candidate");

const status = await execFile(
  "git",
  ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...measuredSourcePaths],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
);
const sourceTreeState = status.stdout.length === 0 ? "clean" : "dirty";
if (sourceTreeState === "dirty" && !allowDirtyReviewCandidate) {
  assertArchitectureMetricsCaptureClean(status.stdout);
}

const revisionResult = await execFile("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
});
const sourceRevision = revisionResult.stdout.trim();
const metrics = await collectArchitectureMetrics(repoRoot);
const baseline = createArchitectureMetricsBaseline(metrics, sourceRevision, { sourceTreeState });

await fs.writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
process.stdout.write(
  `Updated ${path.relative(repoRoot, baselinePath).replaceAll("\\", "/")} from ${sourceTreeState} source ` +
    `${sourceRevision} (${metrics.measuredSourceSha256}).\n`,
);
