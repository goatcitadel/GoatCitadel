import { runAssistantParitySuite } from "./lib/assistant-parity/runner.mjs";
import fs from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2).filter((value) => value !== "--");
let mode = "fixture",
  split = "development",
  maxCostUsd,
  providerConfigFile,
  products,
  caseIds,
  outputRoot;
for (let index = 0; index < args.length; index += 2) {
  const value = args[index + 1];
  if (args[index] === "--mode") mode = value;
  else if (args[index] === "--split") split = value;
  else if (args[index] === "--max-cost-usd") maxCostUsd = Number(value);
  else if (args[index] === "--provider-config") providerConfigFile = value;
  else if (args[index] === "--products") products = value?.split(",");
  else if (args[index] === "--case-ids") caseIds = value?.split(",");
  else if (args[index] === "--output-root") outputRoot = value;
  else
    throw new Error(
      "Use --mode fixture|live --split development|held_out|adversarial --products IDS --case-ids IDS --provider-config FILE --max-cost-usd N --output-root DIR.",
    );
}
let providerConfig = {},
  providerConfigBaseDir;
if (providerConfigFile) {
  const filename = path.resolve(providerConfigFile),
    info = await fs.stat(filename);
  if (!info.isFile() || info.size > 1024 * 1024) throw new Error("Use a bounded provider configuration file.");
  providerConfig = JSON.parse(await fs.readFile(filename, "utf8"));
  providerConfigBaseDir = path.dirname(filename);
}
const report = await runAssistantParitySuite({
  mode,
  split,
  maxCostUsd,
  providerConfig,
  providerConfigBaseDir,
  products,
  caseIds,
  outputRoot,
});
process.stdout.write(
  JSON.stringify({ counts: report.counts, comparativeStatus: report.comparison.status, evidence: report.outputRoot }) +
    "\n",
);
if (Object.values(report.counts).some((count) => count.failed > 0)) process.exitCode = 1;
