import fs from "node:fs/promises";
import path from "node:path";
import { recordComparisonCell } from "./lib/agent-comparison-record.mjs";

const [manifestFile, taskId, trialText, workspace, evidence, journalFile, measurementsFile, output, ...extra] =
  process.argv.slice(2);
if (!output || extra.length || !/^[1-9][0-9]*$/u.test(trialText ?? ""))
  throw new Error(
    "Usage: node scripts/verification/agent-comparison-record.mjs MANIFEST TASK TRIAL WORKSPACE EVIDENCE JOURNAL MEASUREMENTS NEW_RESULT_FILE",
  );
async function json(filename) {
  const handle = await fs.open(path.resolve(filename), "r");
  try {
    const size = (await handle.stat()).size;
    if (size > 8 * 1024 * 1024) throw new Error("Comparison input exceeds 8 MiB.");
    const bytes = Buffer.alloc(size + 1);
    let length = 0;
    while (length < bytes.length) {
      const part = await handle.read(bytes, length, bytes.length - length, length);
      if (!part.bytesRead) break;
      length += part.bytesRead;
    }
    if (length !== size) throw new Error("Comparison input changed during read.");
    return JSON.parse(bytes.subarray(0, size).toString("utf8"));
  } finally {
    await handle.close();
  }
}
const result = await recordComparisonCell({
  manifest: await json(manifestFile),
  taskId,
  trial: Number(trialText),
  workspaceRoot: path.resolve(workspace),
  evidenceRoot: path.resolve(evidence),
  journal: await json(journalFile),
  measurements: await json(measurementsFile),
});
await fs.writeFile(path.resolve(output), JSON.stringify(result, null, 2) + "\n", { flag: "wx" });
process.stdout.write(`${result.receipt.outcome}\n`);
process.exitCode = result.receipt.outcome === "passed" ? 0 : 1;
