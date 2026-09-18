import { parseConnectedWorkerStartup } from "./worker-runtime-config.js";
import { runWorkerProcess, WorkerProcessRecoveryRequiredError } from "./worker-process-runtime.js";
import { acquireWorkerStateOwnership } from "./worker-state-ownership.js";
import { writeWorkerProcessReport } from "./worker-process-report.js";
import { attachWorkerHostControl } from "./worker-host-control.js";
import { loadWorkerMeshToolRegistry } from "./worker-mesh-tool-registry.js";
import { WorkerMeshCapabilityRuntime } from "./worker-mesh-capability-runtime.js";
import { createWindowsInstalledNativeRuntime } from "./worker-windows-installed-runtime.js";
import { startWindowsWorkerStateWriterGate } from "./worker-windows-state-writer-gate.js";
import { CONNECTED_WORKER_ENV, WORKER_HOST_CONTROL_PROTOCOL } from "./worker-environment.js";

/**
 * Connected-worker process entrypoint.
 *
 * This is the real second process the connected-worker end-to-end proof spawns:
 * it admits itself over native mTLS, polls and claims a dispatched offer, reads
 * its workload, exchanges governed inference through the Gateway, and ships
 * verified ordered output. It publishes a verified text artifact and recovers
 * final settlement from retained state. The separate protocol_probe mode exercises
 * transport recovery with controlled text and cannot certify useful work.
 *
 * It writes a single JSON report so the harness observes the run's outcome
 * without parsing logs, and it never prints secrets.
 */
async function main(): Promise<void> {
  const { config, protectedKeys } = parseConnectedWorkerStartup();
  const shutdown = new AbortController();
  const stop = () => shutdown.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const detachHostControl = attachWorkerHostControl(process.env, process.stdin, stop);
  let release: (() => Promise<void>) | undefined;
  let exitCode = 0;
  const publishReport = (report: Readonly<Record<string, unknown>>) =>
    writeWorkerProcessReport(config.reportFile, report);
  try {
    if (process.env[CONNECTED_WORKER_ENV.hostControl] === WORKER_HOST_CONTROL_PROTOCOL) startWindowsWorkerStateWriterGate();
    release = await acquireWorkerStateOwnership(config.stateDir);
    const meshCapabilities = config.meshRegistry ? await loadWorkerMeshToolRegistry(config.meshRegistry, {
      workspaceId: config.ticket.executionWorkspaceId, nodeId: config.ticket.nodeId,
    }, shutdown.signal) : new WorkerMeshCapabilityRuntime([]);
    const nativeRuntime = protectedKeys ? createWindowsInstalledNativeRuntime(protectedKeys) : undefined;
    await runWorkerProcess(config, { signal: shutdown.signal, publishReport, protectedKeys, meshCapabilities, nativeRuntime });
  } catch (error) {
    exitCode = 1;
    process.stderr.write("Connected worker stopped. Inspect its report and retained state ownership.\n");
    // A competing process must not overwrite the current owner's report.
    if (release)
      await publishReport({
        runId: config.runId,
        outcome: "failed",
        error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
        ...(error instanceof WorkerProcessRecoveryRequiredError
          ? { lastReport: error.report, recoveryRequired: true }
          : {}),
      });
  } finally {
    detachHostControl();
    await release?.();
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
  process.exitCode = exitCode;
}

await main();
