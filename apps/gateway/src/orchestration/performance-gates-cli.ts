import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parsePerformanceBenchmarkCliArgs, runOrchestrationPerformanceBenchmark } from "./performance-benchmark.js";

const args = parsePerformanceBenchmarkCliArgs(process.argv.slice(2));
const report = await runOrchestrationPerformanceBenchmark();
const serializedReport = `${JSON.stringify(report, null, 2)}\n`;

if (args.outputPath) {
  const outputPath = path.resolve(process.cwd(), args.outputPath);
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, serializedReport, "utf8");
}

process.stdout.write(serializedReport);

if (!report.passed) {
  process.exitCode = 1;
}
