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

const status = await execFile(
  "git",
  ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...measuredSourcePaths],
  { cwd: repoRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
);
assertArchitectureMetricsCaptureClean(status.stdout);

const revisionResult = await execFile("git", ["rev-parse", "HEAD"], {
  cwd: repoRoot,
  encoding: "utf8",
});
const sourceRevision = revisionResult.stdout.trim();
const metrics = await collectArchitectureMetrics(repoRoot);
const baseline = createArchitectureMetricsBaseline(metrics, sourceRevision);

await fs.writeFile(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, "utf8");
process.stdout.write(
  `Updated ${path.relative(repoRoot, baselinePath).replaceAll("\\", "/")} from clean source ${sourceRevision}.\n`,
);
