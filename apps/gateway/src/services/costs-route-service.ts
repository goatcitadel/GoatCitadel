import {
  ConflictError,
  NotFoundError,
  ValidationError,
  redactSecretText,
  type ModelUsageDispatchReconciliation,
  type ModelUsageEventListQuery,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { createRouteService, type RoutePort, type RouteService } from "./route-service-factory.js";

export const costsRouteMethods = [
  "costSummary",
  "costDailySeries",
  "costUsageAvailability",
  "runCheaper",
  "listModelUsageEvents",
  "getModelUsageEvent",
  "reconcileModelUsageDispatch",
] as const;

export type CostsRouteMethod = (typeof costsRouteMethods)[number];
export type CostsRoutePort = RoutePort<CostsRouteMethod>;
export type CostsRouteService = RouteService<CostsRouteMethod>;

export interface CostsRoutePortDependencies {
  storage: Storage;
}

export function createCostsRoutePort(deps: CostsRoutePortDependencies): CostsRoutePort {
  return {
    costSummary: (scope, from, to) => deps.storage.costLedger.summary(scope, from, to),
    costDailySeries: (from, to) => deps.storage.costLedger.dailySeries(from, to),
    costUsageAvailability: (from, to) => deps.storage.costLedger.usageAvailability(from, to),
    runCheaper: () => ({
      mode: "saver",
      actions: [
        "Switch long-running research to gpt-5-mini unless escalation is required.",
        "Batch background memory compaction outside active sessions.",
        "Prefer cached connector diagnostics for dashboard refreshes under 60 seconds.",
      ],
    }),
    listModelUsageEvents: (workspaceId: string, query: Omit<ModelUsageEventListQuery, "workspaceId">) => {
      try {
        return deps.storage.modelUsageEvents.list({
          ...query,
          workspaceId: requireRouteText(workspaceId, "workspaceId"),
        });
      } catch (error) {
        throw translateModelUsageRepositoryError(error);
      }
    },
    getModelUsageEvent: (workspaceId: string, eventId: string) =>
      requireWorkspaceModelUsageEvent(deps.storage, workspaceId, eventId),
    reconcileModelUsageDispatch: async (input: {
      workspaceId: string;
      eventId: string;
      reconciliation: ModelUsageDispatchReconciliation;
      evidence: string;
      actorId: string;
    }) => {
      const existing = requireWorkspaceModelUsageEvent(deps.storage, input.workspaceId, input.eventId);
      if (existing.transportStatus !== "dispatch_unknown") {
        throw new ConflictError({
          message: "Only dispatch-unknown model usage attempts can be reconciled.",
          details: { eventId: existing.eventId, transportStatus: existing.transportStatus },
        });
      }
      const actorId = requireRouteText(input.actorId, "actorId");
      const evidence = requireRouteText(input.evidence, "evidence", 2_048);
      if (redactSecretText(evidence).redactionCount > 0) {
        throw new ValidationError({
          field: "evidence",
          message: "Reconciliation evidence must not contain secrets or credentials.",
        });
      }
      let record;
      try {
        record = deps.storage.modelUsageEvents.reconcileDispatchUnknown(existing.eventId, {
          reconciliation: input.reconciliation,
          evidence,
          reconciledBy: actorId,
          reconciledAt: new Date().toISOString(),
        });
      } catch (error) {
        throw translateModelUsageRepositoryError(error);
      }
      await deps.storage.audit.append(
        "approvals",
        {
          event: "model_usage.dispatch_unknown.reconciled",
          workspaceId: record.workspaceId,
          eventId: record.eventId,
          reconciliation: record.dispatchReconciliation,
          evidence: record.dispatchReconciliationEvidence,
          reconciledBy: record.dispatchReconciledBy,
          reconciledAt: record.dispatchReconciledAt,
        },
        { deliveryId: `model-usage-reconciliation:${record.eventId}` },
      );
      return record;
    },
  };
}

export function createCostsRouteService(port: CostsRoutePort): CostsRouteService {
  return createRouteService(port, costsRouteMethods);
}

function requireWorkspaceModelUsageEvent(storage: Storage, workspaceId: string, eventId: string) {
  const normalizedWorkspaceId = requireRouteText(workspaceId, "workspaceId");
  const normalizedEventId = requireRouteText(eventId, "eventId");
  const record = storage.modelUsageEvents.findByEventId(normalizedEventId);
  if (!record || record.workspaceId !== normalizedWorkspaceId) {
    // Deliberately do not reveal whether the event exists in another workspace.
    throw new NotFoundError({ entity: "Model usage event", id: normalizedEventId });
  }
  return record;
}

function requireRouteText(value: string, field: string, maxLength = 256): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ValidationError({ code: "FIELD_REQUIRED", field });
  }
  if (normalized.length > maxLength) {
    throw new ValidationError({ field, message: `${field} must be at most ${maxLength} characters.` });
  }
  return normalized;
}

function translateModelUsageRepositoryError(error: unknown): Error {
  if (error instanceof TypeError) {
    return new ValidationError({ message: error.message });
  }
  if (error instanceof Error && error.message.includes("conflicting reconciliation evidence")) {
    return new ConflictError({ message: error.message });
  }
  return error instanceof Error ? error : new Error("Model usage repository operation failed.");
}
