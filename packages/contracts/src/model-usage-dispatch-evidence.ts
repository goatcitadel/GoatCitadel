import type { ModelUsageEventRecord } from "./model-usage.js";

export const MODEL_USAGE_NO_DISPATCH_REASON = "guarded_dispatch_not_started";

type DispatchIdentity = Pick<
  ModelUsageEventRecord,
  "eventId" | "dispatchOwnerId" | "operationId" | "dispatchGeneration"
>;

/** Exact owner-authored evidence; error text or missing usage is never proof. */
export function modelUsageNoDispatchEvidence(identity: DispatchIdentity): string {
  return JSON.stringify({
    schemaVersion: "goatcitadel.model-usage.no-dispatch.v1",
    eventId: identity.eventId,
    dispatchOwnerId: identity.dispatchOwnerId,
    operationId: identity.operationId ?? null,
    dispatchGeneration: identity.dispatchGeneration ?? null,
  });
}

export function isModelUsageProvenNotDispatched(record: ModelUsageEventRecord): boolean {
  return (
    (record.source === "llm_service" || record.source === "embedding_runtime") &&
    record.transportStatus === "dispatch_unknown" &&
    record.dispatchUncertaintyReason === MODEL_USAGE_NO_DISPATCH_REASON &&
    record.dispatchReconciliation === "confirmed_not_dispatched" &&
    record.dispatchReconciledBy === record.dispatchOwnerId &&
    record.dispatchReconciliationEvidence === modelUsageNoDispatchEvidence(record) &&
    record.terminalOutcome === "failed_before_usage" &&
    !!record.finishedAt &&
    record.finishedAt === record.dispatchReconciledAt
  );
}
