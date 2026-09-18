import { setTimeout as delay } from "node:timers/promises";
import { runConnectedWorker, type ConnectedWorkerReport } from "./connected-worker-runtime.js";
import type { WorkerRunConfig } from "./worker-runtime-config.js";
import type { WorkerProtectedKeyOwner } from "./worker-protected-key-owner.js";
import type { WorkerMeshCapabilityRuntime } from "./worker-mesh-capability-runtime.js";
import type { WorkerNativeContinuationOwner } from "./worker-native-continuation.js";

export interface WorkerProcessDependencies {
  readonly signal: AbortSignal;
  readonly protectedKeys?: WorkerProtectedKeyOwner;
  readonly meshCapabilities?: WorkerMeshCapabilityRuntime;
  readonly nativeRuntime?: WorkerNativeContinuationOwner;
  readonly publishReport: (report: Readonly<Record<string, unknown>>) => Promise<void>;
  readonly runOnce?: typeof runConnectedWorker;
  readonly waitForOffer?: (signal: AbortSignal) => Promise<void>;
}

export class WorkerProcessRecoveryRequiredError extends Error {
  constructor(readonly report: ConnectedWorkerReport) {
    super("Worker stopped with unresolved work; operator reconciliation is required.");
    this.name = "WorkerProcessRecoveryRequiredError";
  }
}

/** Sequential foreground host. Native service installation/custody is separate. */
export async function runWorkerProcess(
  config: WorkerRunConfig,
  dependencies: WorkerProcessDependencies,
): Promise<void> {
  const continuous = config.runMode === "continuous";
  if (continuous && (config.stopAfter !== "complete" || config.executionMode === "protocol_probe"))
    throw new Error("Continuous workers require complete governed execution.");
  const { signal, publishReport } = dependencies;
  const runOnce = dependencies.runOnce ?? runConnectedWorker;
  const waitForOffer =
    dependencies.waitForOffer ??
    (async (signal: AbortSignal) => {
      await delay(2_000, undefined, { signal });
    });
  let lastReport: ConnectedWorkerReport | undefined;
  let recoveryRequired = false;
  while (!signal.aborted) {
    try {
      recoveryRequired = true;
      const report = await runOnce(config, {
        signal,
        ...(dependencies.protectedKeys ? { protectedKeys: dependencies.protectedKeys } : {}),
        ...(dependencies.meshCapabilities ? { meshCapabilities: dependencies.meshCapabilities } : {}),
        ...(dependencies.nativeRuntime ? { nativeRuntime: dependencies.nativeRuntime } : {}),
      });
      await publishReport(report);
      lastReport = report;
      recoveryRequired =
        report.outcome !== "completed" &&
        report["awaiting"] !== "assignment_offer" &&
        report["awaiting"] !== "approval_resolution" &&
        report["awaiting"] !== "parent_recovery";
      if (!continuous) return;
      if (recoveryRequired) throw new WorkerProcessRecoveryRequiredError(report);
      // Bound polling after completion, empty offers and canonical recovery/approval waits.
      await waitForOffer(signal);
    } catch (error) {
      if (!signal.aborted) throw error;
      break;
    }
  }
  await publishReport({
    runId: config.runId,
    outcome: "stopped",
    reason: "shutdown_requested",
    lastReport,
    // A stopped connection alone cannot establish the remote outcome.
    recoveryRequired,
  });
}
