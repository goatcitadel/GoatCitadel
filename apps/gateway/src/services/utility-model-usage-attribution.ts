import type { ModelUsageAttributionContext } from "@goatcitadel/contracts";

export type TrustedUtilityModelUsageLineage = Pick<
  ModelUsageAttributionContext,
  | "workspaceId"
  | "sessionId"
  | "turnId"
  | "durableRunId"
  | "taskId"
  | "agentId"
  | "parentOperationId"
  | "routeDecisionId"
  | "contextSnapshotId"
  | "contextIntentHash"
  | "contextEntryRefId"
>;

/**
 * Builds attribution only from server-owned identifiers supplied by the runtime
 * service that owns the logical utility call. Request metadata is deliberately
 * not accepted here, so HTTP clients cannot self-attribute cost or lineage.
 */
export function createUtilityModelUsageAttribution(input: {
  operationId: string;
  utilityKind: string;
  requestedProviderId?: string;
  requestedModelId?: string;
  lineage?: TrustedUtilityModelUsageLineage;
}): ModelUsageAttributionContext {
  return {
    operationId: input.operationId,
    callKind: "utility",
    utilityKind: input.utilityKind,
    ...(input.requestedProviderId ? { requestedProviderId: input.requestedProviderId } : {}),
    ...(input.requestedModelId ? { requestedModelId: input.requestedModelId } : {}),
    ...(input.lineage ?? {}),
  };
}
