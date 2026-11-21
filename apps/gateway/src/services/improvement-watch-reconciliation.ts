import type { ImprovementActivationRecord, ImprovementSignalRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";

interface ImprovementWatchReconciliationDeps {
  storage: Pick<AsyncStorage, "runImmediateTransaction" | "improvementWatchEvidence">;
  readActivation(activationId: string): Promise<ImprovementActivationRecord>;
  pauseActivation(activation: ImprovementActivationRecord): Promise<ImprovementActivationRecord>;
  publish(
    eventType: "improvement_activation_pause_failed" | "improvement_activation_watch_updated",
    evidence: Record<string, unknown>,
  ): Promise<unknown>;
}

export class ImprovementWatchReconciliation {
  constructor(private readonly deps: ImprovementWatchReconciliationDeps) {}

  async applySignal(signal: Pick<ImprovementSignalRecord, "origin" | "signalId">): Promise<void> {
    if (signal.origin !== "runtime" && signal.origin !== "evaluation") return;
    for (const activationId of await this.deps.storage.improvementWatchEvidence.listForSignal(signal.signalId)) {
      await this.reconcile(activationId);
    }
  }

  async reconcile(activationId: string): Promise<ImprovementActivationRecord> {
    return await reconcileImprovementWatch(this.deps, activationId);
  }
}

async function reconcileImprovementWatch(
  deps: ImprovementWatchReconciliationDeps,
  activationId: string,
): Promise<ImprovementActivationRecord> {
  const evidence = deps.storage.improvementWatchEvidence;
  const outcome = await deps.storage.runImmediateTransaction(async () => {
    const observed = await evidence.reconcile(activationId);
    let pauseFailed = false;
    if (observed.shouldRestore) {
      // The evidence owner holds the row through snapshot recovery. Competing
      // deliveries see the settled activation once this transaction commits.
      const activation = await deps.readActivation(activationId);
      if (activation.status === "active") {
        pauseFailed = (await deps.pauseActivation(activation)).status !== "paused";
      }
    }
    return { changed: observed.changed, pauseFailed };
  });
  const current = await deps.readActivation(activationId);
  if (outcome.pauseFailed) {
    await deps.publish("improvement_activation_pause_failed", { activationId, candidateId: current.candidateId });
  }
  if (outcome.changed) {
    await deps.publish("improvement_activation_watch_updated", {
      activationId,
      candidateId: current.candidateId,
      revisionId: current.revisionId,
      status: current.status,
      watchStatus: current.watchStatus,
      positiveSignalCount: current.positiveSignalCount ?? 0,
      regressionCount: current.regressionCount,
    });
  }
  return current;
}
