import type { DurableRunRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { recordRemoteWorkerChatApprovalWake } from "./remote-worker-chat-approval-resume.js";

interface DurableWakeTransitionPort {
  prepareMetadata(current: DurableRunRecord): Promise<Record<string, unknown>>;
  recordTimeline(runId: string, payload: Record<string, unknown>): Promise<unknown>;
}

/** Approval wake evidence, optimistic run update and timeline commit atomically. */
export async function commitDurableWakeTransition(
  storage: AsyncStorage,
  port: DurableWakeTransitionPort,
  current: DurableRunRecord,
  runId: string,
  event: { eventKey: string; correlationId?: string; payload?: Record<string, unknown> },
  now: string,
): Promise<DurableRunRecord> {
  let next!: DurableRunRecord;
  await storage.runImmediateTransaction(async () => {
    await recordRemoteWorkerChatApprovalWake(storage, current, event);
    const metadata = await port.prepareMetadata(current);
    next = await storage.durableRuns.updateRun({
      runId,
      status: "queued",
      updatedAt: now,
      startedAt: current.startedAt ?? now,
      clearFinishedAt: true,
      clearLease: true,
      clearLastError: true,
      metadata,
      expectedVersion: current.version,
    });
    await port.recordTimeline(runId, {
      eventKey: event.eventKey,
      correlationId: event.correlationId,
      payload: event.payload ?? {},
    });
  });
  return next;
}
