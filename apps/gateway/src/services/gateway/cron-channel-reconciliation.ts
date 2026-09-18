import { isCronRunTerminalStatus, type CronRunRecord, type CronRunExecutionToken, type CronRunTerminalStatus, type DurableRunRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { CronRunResult } from "./cron-automation-service.js";

interface CronChannelReadDependencies {
  storage: Pick<AsyncStorage, "durableRuns" | "commsDeliveries" | "cronRuns">;
}

interface CronChannelReconciliationPort {
  settle(current: CronRunRecord, status: CronRunTerminalStatus, details: {
    outcome?: Record<string, unknown>; failureMessage?: string; reconciliationReason?: string;
  }): Promise<CronRunResult>;
  project(current: CronRunRecord): Promise<CronRunResult>;
  childOutcome(): Record<string, unknown>;
}

export async function reconcileCompletedCronChannelDelivery(
  deps: CronChannelReadDependencies, port: CronChannelReconciliationPort, current: CronRunRecord, child: DurableRunRecord,
  deliveryRun: DurableRunRecord, token: CronRunExecutionToken,
): Promise<CronRunResult> {
  // Connector completion acknowledges queue admission. The channel repository
  // owns the eventual provider outcome, which may arrive after that checkpoint.
  const checkpoints = await deps.storage.durableRuns.listCheckpoints(deliveryRun.runId);
  const completions = checkpoints.filter((checkpoint) => checkpoint.checkpointKind === "run_completed");
  const completion = completions.length === 1 ? completions[0]?.state : undefined;
  const result = readRecord(completion?.result);
  const deliveryId = readString(result?.deliveryId);
  const record = deliveryId ? await deps.storage.commsDeliveries.getById(deliveryId) : undefined;
  if (
    checkpoints.length >= 200 ||
    !record ||
    completion?.dispatchKind !== "integration_channel_send" ||
    completion.connectorType !== "integration_connection" ||
    completion.action !== "channel.send" ||
    deliveryRun.payload.action !== completion.action ||
    completion.connectorId !== `integration:${record.connectionId}` ||
    completion.connectorId !== deliveryRun.payload.connectorId ||
    result?.channelKey !== record.channelKey ||
    result.target !== record.target ||
    record.payload?.runId !== child.runId ||
    record.payload.sessionId !== current.childSessionId
  ) {
    return await port.settle(current, "manual_reconciliation_required", {
      failureMessage: "The completed delivery child has no matching canonical channel receipt.",
      reconciliationReason: "Channel delivery identity, parent or destination evidence is missing or inconsistent.",
    });
  }
  if (record.status === "queued") {
    const advanced = await deps.storage.cronRuns.advancePhase(token, {
      status: "waiting",
      phase: "delivery",
    });
    return await port.project(advanced ?? current);
  }
  const outcome = {
    ...port.childOutcome(),
    deliveryRunId: deliveryRun.runId,
    deliveryId: record.deliveryId,
    ...(record.deliveryStatus ? { deliveryStatus: record.deliveryStatus } : {}),
    ...(record.providerMessageId ? { providerMessageId: record.providerMessageId } : {}),
  };
  if (record.status === "sent" && record.deliveryStatus === "sent") {
    return await port.settle(current, "completed", { outcome });
  }
  const ambiguous = record.deliveryStatus === "manual_reconciliation_required" || Boolean(record.providerMessageId);
  return await port.settle(
    current,
    ambiguous || record.status !== "failed" ? "manual_reconciliation_required" : "failed",
    {
      outcome,
      failureMessage: record.error ?? "The channel delivery has no acknowledged successful outcome.",
      ...(ambiguous || record.status !== "failed"
        ? {
            reconciliationReason:
              "Channel delivery has an unknown external outcome and must not be retried automatically.",
          }
        : {}),
    },
  );
}

/** Observe attached work only; never admit or replay an occurrence here. */
export async function observeActiveCronAgentRun(
  deps: { storage: Pick<AsyncStorage, "cronRuns"> }, activeRunId: string,
  process: (run: CronRunRecord) => Promise<unknown>,
): Promise<CronRunRecord | undefined> {
  const active = await deps.storage.cronRuns.get(activeRunId);
  if (active?.action !== "agent_turn" || active.status === "admitting" || isCronRunTerminalStatus(active.status)) {
    return undefined;
  }
  await process(active);
  return deps.storage.cronRuns.get(active.runId);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
