/**
 * Durable execution service.
 *
 * Body-move home for the durable-run / dead-letter / checkpoint public
 * surface previously living on GatewayService (Step 7 of the
 * gateway-service decomposition plan).
 *
 * Private workflow executors and payload parsers remain on GatewayService
 * for now; they will be moved in a follow-up sub-step. This step only
 * extracts the 13 public methods.
 */

import type {
  DurableCheckpointRecord,
  DurableDeadLetterRecord,
  DurableDiagnosticsResponse,
  DurableRunCreateRequest,
  DurableRunRecord,
  DurableRunTimelineEvent,
} from "@goatcitadel/contracts";
import type { GatewayService } from "./gateway-service.js";

export type DurableExecutionHost = GatewayService;

export function getDurableDiagnostics(host: DurableExecutionHost): DurableDiagnosticsResponse {
  return host.durableRunService.getDurableDiagnostics();
}

export function listDurableRuns(host: DurableExecutionHost, limit = 50): DurableRunRecord[] {
  return host.durableRunService.listDurableRuns(limit);
}

export function listDurableDeadLetters(host: DurableExecutionHost, limit = 50): DurableDeadLetterRecord[] {
  return host.durableRunService.listDurableDeadLetters(limit);
}

export function listDurableRunCheckpoints(
  host: DurableExecutionHost,
  runId: string,
  limit = 200,
): DurableCheckpointRecord[] {
  return host.durableRunService.listDurableRunCheckpoints(runId, limit);
}

export function createDurableRun(host: DurableExecutionHost, input: DurableRunCreateRequest): DurableRunRecord {
  const run = host.durableRunService.createDurableRun(input);
  if (run.status === "queued") {
    host.durableRunService.requestRunProcessing(run.runId);
  }
  return run;
}

export function getDurableRun(host: DurableExecutionHost, runId: string): DurableRunRecord {
  return host.durableRunService.getDurableRun(runId);
}

export function listDurableRunTimeline(
  host: DurableExecutionHost,
  runId: string,
  limit = 300,
): DurableRunTimelineEvent[] {
  return host.durableRunService.listDurableRunTimeline(runId, limit);
}

export function pauseDurableRun(host: DurableExecutionHost, runId: string, actorId = "operator"): DurableRunRecord {
  return host.durableRunService.pauseDurableRun(runId, actorId);
}

export function resumeDurableRun(host: DurableExecutionHost, runId: string, actorId = "operator"): DurableRunRecord {
  const run = host.durableRunService.resumeDurableRun(runId, actorId);
  host.memoryMaintenanceService.syncFromDurableRun(run);
  host.durableRunService.requestRunProcessing(runId);
  return run;
}

export function cancelDurableRun(host: DurableExecutionHost, runId: string, actorId = "operator"): DurableRunRecord {
  const run = host.durableRunService.cancelDurableRun(runId, actorId);
  host.memoryMaintenanceService.syncFromDurableRun(run);
  return run;
}

export function retryDurableRun(
  host: DurableExecutionHost,
  runId: string,
  reason = "manual_retry",
  actorId = "operator",
): DurableRunRecord {
  const run = host.durableRunService.retryDurableRun(runId, reason, actorId);
  host.memoryMaintenanceService.syncFromDurableRun(run);
  if (run.status === "queued") {
    host.durableRunService.requestRunProcessing(runId);
  }
  host.hooksService.enqueueAfterHooks({
    workspaceId: host.resolveDurableRunHookWorkspaceId(run),
    trigger: "orchestration.retry.scheduled",
    entityType: "durable_run",
    entityId: runId,
    payload: {
      runId,
      reason,
      actorId,
      status: run.status,
      attemptCount: run.attemptCount,
    },
  });
  return run;
}

export function wakeDurableRun(
  host: DurableExecutionHost,
  runId: string,
  event: {
    eventKey: string;
    payload?: Record<string, unknown>;
    correlationId?: string;
  },
): DurableRunRecord {
  const run = host.durableRunService.wakeDurableRun(runId, event);
  host.durableRunService.requestRunProcessing(runId);
  host.hooksService.enqueueAfterHooks({
    workspaceId: host.resolveDurableRunHookWorkspaceId(run),
    trigger: "orchestration.run.woken",
    entityType: "durable_run",
    entityId: runId,
    payload: {
      runId,
      eventKey: event.eventKey,
      correlationId: event.correlationId,
      payload: event.payload ?? {},
    },
  });
  return run;
}

export function recoverDurableDeadLetter(
  host: DurableExecutionHost,
  entryId: string,
  actorId = "operator",
): DurableRunRecord {
  return host.durableRunService.recoverDurableDeadLetter(entryId, actorId);
}
