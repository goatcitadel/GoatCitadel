import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { runConnectedWorker } from "./connected-worker-runtime.js";
import { parseConnectedWorkerConfig } from "./worker-runtime-config.js";

/**
 * Connected-worker process entrypoint.
 *
 * This is the real second process the connected-worker end-to-end proof spawns:
 * it admits itself over native mTLS, polls and claims a dispatched offer, reads
 * its workload, exchanges inference through the Gateway, ships ordered
 * transcript events, renews its lease, settles artifacts and effects, and
 * settles the assignment — carrying nothing across a restart except its own
 * durable state.
 *
 * It writes a single JSON report so the harness observes the run's outcome
 * without parsing logs, and it never prints secrets.
 */
async function main(): Promise<void> {
  const config = parseConnectedWorkerConfig();
  let report: Readonly<Record<string, unknown>>;
  let exitCode = 0;
  try {
    report = await runConnectedWorker(config);
  } catch (error) {
    exitCode = 1;
    report = Object.freeze({
      runId: config.runId,
      outcome: "failed",
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    });
  }
  await mkdir(dirname(config.reportFile), { recursive: true });
  await writeFile(config.reportFile, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  process.exitCode = exitCode;
}

await main();
