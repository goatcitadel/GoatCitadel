import fs from "node:fs/promises";
import path from "node:path";
import {
  COMPARISON_TASKS,
  prepareComparison,
  summarizeComparison,
  comparisonMarkdown,
} from "./lib/agent-comparison.mjs";

const [operation, inputFile, outputDir, receiptFile, ...extra] = process.argv.slice(2);
if (
  !["prepare", "report"].includes(operation) ||
  !inputFile ||
  !outputDir ||
  extra.length ||
  (operation === "report" && !receiptFile) ||
  (operation === "prepare" && receiptFile)
) {
  throw new Error(
    "Usage: node scripts/verification/agent-comparison.mjs prepare config.json output-dir | report manifest.json output-dir receipts.json",
  );
}
async function readJson(file) {
  const handle = await fs.open(path.resolve(file), "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024)
      throw new Error("Comparison input exceeds 8 MiB or is not a file.");
    const buffer = Buffer.alloc(8 * 1024 * 1024 + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, null);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    if (length > 8 * 1024 * 1024) throw new Error("Comparison input grew beyond its bound.");
    return JSON.parse(buffer.subarray(0, length).toString("utf8"));
  } finally {
    await handle.close();
  }
}
const input = await readJson(inputFile);
const output = path.resolve(outputDir);
// New directory only: never replace an earlier run, fixtures, or user work.
await fs.mkdir(output, { recursive: false });
if (operation === "prepare") {
  const manifest = prepareComparison(input);
  await fs.writeFile(path.join(output, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  await fs.writeFile(path.join(output, "fixtures.json"), JSON.stringify(COMPARISON_TASKS, null, 2) + "\n", {
    flag: "wx",
  });
  await fs.writeFile(path.join(output, "receipts.json"), "[]\n", { flag: "wx" });
  process.stdout.write(`Prepared ${manifest.cells.length} unrun cells. No provider was contacted.\n`);
} else {
  const report = summarizeComparison(input, await readJson(receiptFile));
  await fs.writeFile(path.join(output, "report.json"), JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
  await fs.writeFile(path.join(output, "report.md"), comparisonMarkdown(report), { flag: "wx" });
  process.stdout.write(`${report.status}\n`);
}
