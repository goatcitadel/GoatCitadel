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

export class DurableOperatorPostCommitError extends Error {
  public readonly mutationCommitted = true;

  public constructor(
    operation: string,
    public readonly canonicalResult: DurableRunRecord | DurableWakeResult,
    cause: unknown,
  ) {
    super(
      `${operation} committed, but a post-commit consumer failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
      { cause },
    );
    this.name = "DurableOperatorPostCommitError";
  }
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
    return this.afterRunCommit("Durable run creation", run, [
      () => {
        if (run.status === "queued") this.deps.durableRunService.requestRunProcessing(run.runId);
      },
    ]);
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
    return this.afterRunCommit("Durable run resume", run, [
      () => this.deps.memoryLifecycleService.syncMaintenanceFromDurableRun(run),
      () => this.deps.durableRunService.requestRunProcessing(runId),
    ]);
  }

  public cancelRun(runId: string, actorId = "operator"): DurableRunRecord {
    const run = this.deps.durableRunService.cancelDurableRun(runId, actorId);
    return this.afterRunCommit("Durable run cancellation", run, [
      () => this.deps.memoryLifecycleService.syncMaintenanceFromDurableRun(run),
    ]);
  }

  public retryRun(runId: string, reason = "manual_retry", actorId = "operator"): DurableRunRecord {
    const run = this.deps.durableRunService.retryDurableRun(runId, reason, actorId);
    return this.afterRunCommit("Durable run retry", run, [
      () => this.deps.memoryLifecycleService.syncMaintenanceFromDurableRun(run),
      () => {
        if (run.status === "queued") this.deps.durableRunService.requestRunProcessing(runId);
      },
      () =>
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
        }),
    ]);
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
      return this.afterWakeCommit("Durable run wake", result, [
        () => this.deps.durableRunService.requestRunProcessing(runId),
        () =>
          this.deps.hooksService.enqueueAfterHooks({
            workspaceId: this.deps.resolveDurableRunHookWorkspaceId(result.run!),
            trigger: "orchestration.run.woken",
            entityType: "durable_run",
            entityId: runId,
            payload: {
              runId,
              eventKey: event.eventKey,
              correlationId: event.correlationId,
              payload: event.payload ?? {},
            },
          }),
      ]);
    }
    return result;
  }

  private afterRunCommit(
    operation: string,
    run: DurableRunRecord,
    postCommitConsumers: ReadonlyArray<() => void>,
  ): DurableRunRecord {
    try {
      this.runPostCommitConsumers(postCommitConsumers);
      return run;
    } catch (error) {
      throw new DurableOperatorPostCommitError(operation, run, error);
    }
  }

  private afterWakeCommit(
    operation: string,
    result: DurableWakeResult,
    postCommitConsumers: ReadonlyArray<() => void>,
  ): DurableWakeResult {
    try {
      this.runPostCommitConsumers(postCommitConsumers);
      return result;
    } catch (error) {
      throw new DurableOperatorPostCommitError(operation, result, error);
    }
  }

  private runPostCommitConsumers(consumers: ReadonlyArray<() => void>): void {
    const failures: unknown[] = [];
    for (const consume of consumers) {
      try {
        consume();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} durable post-commit consumer(s) failed`);
    }
  }

  public recoverDeadLetter(
    entryId: string,
    actorId = "operator",
    options?: { maxAttempts?: number },
  ): DurableRunRecord {
    return this.deps.durableRunService.recoverDurableDeadLetter(entryId, actorId, options);
  }
}
