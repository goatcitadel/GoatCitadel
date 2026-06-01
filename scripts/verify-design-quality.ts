import process from "node:process";
import { hasBlockingDesignQualityFindings, readDesignQualityEvidence } from "../packages/skills/src/design-quality.ts";

const snapshot = readDesignQualityEvidence(process.cwd());
const json = process.argv.includes("--json");

if (json) {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(snapshot, null, 2));
} else {
  // eslint-disable-next-line no-console
  console.log(
    `[design-quality] ${snapshot.summary.passingCount}/${snapshot.summary.totalChecks} passing, ` +
      `${snapshot.summary.advisoryCount} advisory, ${snapshot.summary.blockingCount} blocking`,
  );
  for (const check of snapshot.checks) {
    const suffix = check.nextAction ? ` - ${check.nextAction}` : "";
    // eslint-disable-next-line no-console
    console.log(`[${check.severity}] ${check.status} ${check.id}: ${check.label} (${check.evidence})${suffix}`);
  }
}

if (hasBlockingDesignQualityFindings(snapshot)) {
  process.exitCode = 1;
}
