import fs from "node:fs/promises";
import path from "node:path";
import { verifyComparisonEvidence } from "./lib/agent-comparison-verifiers.mjs";
const [taskId, workspace, evidence, output, ...extra] = process.argv.slice(2);
if (!taskId || !workspace || !evidence || !output || extra.length) {
  throw new Error(
    "Usage: node scripts/verification/agent-comparison-verify.mjs TASK WORKSPACE EVIDENCE NEW_RESULT_FILE",
  );
}
const result = await verifyComparisonEvidence({
  taskId,
  workspaceRoot: path.resolve(workspace),
  evidenceRoot: path.resolve(evidence),
});
await fs.writeFile(path.resolve(output), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
process.stdout.write(`${result.outcome}\n`);
process.exitCode = result.outcome === "passed" ? 0 : 1;
