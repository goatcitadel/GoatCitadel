import type {
  DurableCheckpointRecord,
  DurableDeadLetterRecord,
  DurableDiagnosticsResponse,
  DurableRunCreateRequest,
  DurableRunRecord,
  DurableRunTimelineEvent,
  DurableWakeResult,
} from "@goatcitadel/contracts";
import type { DurableRunService } from "./durable-run-service.js";
import type { HooksService } from "./hooks-service.js";
import type { MemoryLifecycleService } from "./memory-lifecycle-service.js";

export interface DurableOperatorServiceDeps {
  readonly durableRunService: Pick<
    DurableRunService,
    | "getDurableDiagnostics"
    | "listDurableRuns"
    | "listDurableDeadLetters"
    | "listDurableRunCheckpoints"
    | "createDurableRun"
    | "getDurableRun"
    | "listDurableRunTimeline"
    | "pauseDurableRun"
    | "resumeDurableRun"
    | "cancelDurableRun"
    | "retryDurableRun"
    | "wakeDurableRun"
    | "recoverDurableDeadLetter"
    | "requestRunProcessing"
  >;
  readonly memoryLifecycleService: Pick<MemoryLifecycleService, "syncMaintenanceFromDurableRun">;
  readonly hooksService: Pick<HooksService, "enqueueAfterHooks">;
  resolveDurableRunHookWorkspaceId(run: DurableRunRecord): string;
}

export class DurableOperatorService {
  public constructor(private readonly deps: DurableOperatorServiceDeps) {}

  public getDiagnostics(): DurableDiagnosticsResponse {
    return this.deps.durableRunService.getDurableDiagnostics();
  }

  public listRuns(limit = 50): DurableRunRecord[] {
    return this.deps.durableRunService.listDurableRuns(limit);
  }

  public listDeadLetters(limit = 50): DurableDeadLetterRecord[] {
    return this.deps.durableRunService.listDurableDeadLetters(limit);
  }

  public listRunCheckpoints(runId: string, limit = 200): DurableCheckpointRecord[] {
    return this.deps.durableRunService.listDurableRunCheckpoints(runId, limit);
  }

  public createRun(input: DurableRunCreateRequest): DurableRunRecord {
    const run = this.deps.durableRunService.createDurableRun(input);
    if (run.status === "queued") {
      this.deps.durableRunService.requestRunProcessing(run.runId);
    }
    return run;
  }

  public getRun(runId: string): DurableRunRecord {
    return this.deps.durableRunService.getDurableRun(runId);
  }

  public listRunTimeline(runId: string, limit = 300): DurableRunTimelineEvent[] {
    return this.deps.durableRunService.listDurableRunTimeline(runId, limit);
  }

  public pauseRun(runId: string, actorId = "operator"): DurableRunRecord {
    return this.deps.durableRunService.pauseDurableRun(runId, actorId);
  }

  public resumeRun(runId: string, actorId = "operator"): DurableRunRecord {
    const run = this.deps.durableRunService.resumeDurableRun(runId, actorId);
    this.deps.memoryLifecycleService.syncMaintenanceFromDurableRun(run);
    this.deps.durableRunService.requestRunProcessing(runId);
    return run;
  }

  public cancelRun(runId: string, actorId = "operator"): DurableRunRecord {
    const run = this.deps.durableRunService.cancelDurableRun(runId, actorId);
    this.deps.memoryLifecycleService.syncMaintenanceFromDurableRun(run);
    return run;
  }

  public retryRun(runId: string, reason = "manual_retry", actorId = "operator"): DurableRunRecord {
    const run = this.deps.durableRunService.retryDurableRun(runId, reason, actorId);
    this.deps.memoryLifecycleService.syncMaintenanceFromDurableRun(run);
    if (run.status === "queued") {
      this.deps.durableRunService.requestRunProcessing(runId);
    }
    this.deps.hooksService.enqueueAfterHooks({
      workspaceId: this.deps.resolveDurableRunHookWorkspaceId(run),
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

  public wakeRun(
    runId: string,
    event: {
      eventKey: string;
      payload?: Record<string, unknown>;
      correlationId?: string;
    },
  ): DurableWakeResult {
    const result = this.deps.durableRunService.wakeDurableRun(runId, event);
    if (result.outcome === "woke" && result.run) {
      this.deps.durableRunService.requestRunProcessing(runId);
      this.deps.hooksService.enqueueAfterHooks({
        workspaceId: this.deps.resolveDurableRunHookWorkspaceId(result.run),
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
    }
    return result;
  }

  public recoverDeadLetter(
    entryId: string,
    actorId = "operator",
    options?: { maxAttempts?: number },
  ): DurableRunRecord {
    return this.deps.durableRunService.recoverDurableDeadLetter(entryId, actorId, options);
  }
}
