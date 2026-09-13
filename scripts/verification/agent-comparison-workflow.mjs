import path from "node:path";
import { readComparisonJson } from "./lib/agent-comparison-session.mjs";
import { advanceComparisonWorkflow, readComparisonWorkflowInstructions } from "./lib/agent-comparison-workflow.mjs";

const [cellDirectory, action, receiptFile, skillFile, ...extra] = process.argv.slice(2);
if (!cellDirectory || !action || !receiptFile || extra.length || (action === "review") !== Boolean(skillFile))
  throw new Error(
    "Usage: node scripts/verification/agent-comparison-workflow.mjs CELL source|review|reuse|schedule|reconnect RECEIPT [REVIEWED_SKILL]",
  );
let instructions;
if (skillFile) {
  instructions = await readComparisonWorkflowInstructions(path.resolve(skillFile));
}
const result = await advanceComparisonWorkflow({
  cellDirectory: path.resolve(cellDirectory),
  action,
  receipt: await readComparisonJson(path.resolve(receiptFile)),
  instructions,
});
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
