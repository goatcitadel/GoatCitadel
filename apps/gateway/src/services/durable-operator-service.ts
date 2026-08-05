import type {
  DurableChildWatcherCatchUpResult,
  DurableChildWatcherCreateRequest,
  DurableChildWatcherRecord,
  DurableBackgroundTaskControlRequest,
  DurableBackgroundTaskControlResponse,
  DurableBackgroundTaskRailResponse,
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
    | "watchDurableChildRun"
    | "listDurableChildWatchers"
    | "detachDurableChildWatcher"
    | "reattachDurableChildWatcher"
    | "closeDurableChildWatcher"
    | "getDurableBackgroundTaskRail"
    | "controlDurableBackgroundTask"
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
  resolveDurableRunHookWorkspaceId(run: DurableRunRecord): Promise<string>;
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

  public async getDiagnostics(): Promise<DurableDiagnosticsResponse> {
    return this.deps.durableRunService.getDurableDiagnostics();
  }

  public async listRuns(limit = 50): Promise<DurableRunRecord[]> {
    return this.deps.durableRunService.listDurableRuns(limit);
  }

  public async listDeadLetters(limit = 50): Promise<DurableDeadLetterRecord[]> {
    return this.deps.durableRunService.listDurableDeadLetters(limit);
  }

  public async listRunCheckpoints(runId: string, limit = 200): Promise<DurableCheckpointRecord[]> {
    return this.deps.durableRunService.listDurableRunCheckpoints(runId, limit);
  }

  public async createRun(input: DurableRunCreateRequest): Promise<DurableRunRecord> {
    const run = await this.deps.durableRunService.createDurableRun(input);
    return this.afterRunCommit("Durable run creation", run, [
      async () => {
        if (run.status === "queued") await this.deps.durableRunService.requestRunProcessing(run.runId);
      },
    ]);
  }

  public async getRun(runId: string): Promise<DurableRunRecord> {
    return this.deps.durableRunService.getDurableRun(runId);
  }

  public async listRunTimeline(runId: string, limit = 300): Promise<DurableRunTimelineEvent[]> {
    return this.deps.durableRunService.listDurableRunTimeline(runId, limit);
  }

  public async watchChildRun(input: DurableChildWatcherCreateRequest): Promise<DurableChildWatcherRecord> {
    return this.deps.durableRunService.watchDurableChildRun(input);
  }

  public async listChildWatchers(parentRunId: string, limit = 200): Promise<DurableChildWatcherRecord[]> {
    return this.deps.durableRunService.listDurableChildWatchers(parentRunId, limit);
  }

  public async detachChildWatcher(watcherId: string): Promise<DurableChildWatcherRecord> {
    return this.deps.durableRunService.detachDurableChildWatcher(watcherId);
  }

  public async reattachChildWatcher(watcherId: string): Promise<DurableChildWatcherCatchUpResult> {
    return this.deps.durableRunService.reattachDurableChildWatcher(watcherId);
  }

  public async closeChildWatcher(watcherId: string): Promise<DurableChildWatcherRecord> {
    return this.deps.durableRunService.closeDurableChildWatcher(watcherId);
  }

  public async getBackgroundTaskRail(
    parentRunId: string,
    input: { workspaceId: string; sessionId: string },
  ): Promise<DurableBackgroundTaskRailResponse> {
    return this.deps.durableRunService.getDurableBackgroundTaskRail(parentRunId, input);
  }

  public async controlBackgroundTask(
    parentRunId: string,
    watcherId: string,
    input: DurableBackgroundTaskControlRequest,
    actorId: string,
  ): Promise<DurableBackgroundTaskControlResponse> {
    return this.deps.durableRunService.controlDurableBackgroundTask(parentRunId, watcherId, input, actorId);
  }

  public async pauseRun(runId: string, actorId = "operator"): Promise<DurableRunRecord> {
    return this.deps.durableRunService.pauseDurableRun(runId, actorId);
  }

  public async resumeRun(runId: string, actorId = "operator"): Promise<DurableRunRecord> {
    const run = await this.deps.durableRunService.resumeDurableRun(runId, actorId);
    return this.afterRunCommit("Durable run resume", run, [
      () => this.deps.memoryLifecycleService.syncMaintenanceFromDurableRun(run),
      () => this.deps.durableRunService.requestRunProcessing(runId),
    ]);
  }

  public async cancelRun(runId: string, actorId = "operator"): Promise<DurableRunRecord> {
    const run = await this.deps.durableRunService.cancelDurableRun(runId, actorId);
    return this.afterRunCommit("Durable run cancellation", run, [
      () => this.deps.memoryLifecycleService.syncMaintenanceFromDurableRun(run),
    ]);
  }

  public async retryRun(runId: string, reason = "manual_retry", actorId = "operator"): Promise<DurableRunRecord> {
    const run = await this.deps.durableRunService.retryDurableRun(runId, reason, actorId);
    return this.afterRunCommit("Durable run retry", run, [
      () => this.deps.memoryLifecycleService.syncMaintenanceFromDurableRun(run),
      async () => {
        if (run.status === "queued") await this.deps.durableRunService.requestRunProcessing(runId);
      },
      async () => {
        await this.deps.hooksService.enqueueAfterHooks({
          workspaceId: await this.deps.resolveDurableRunHookWorkspaceId(run),
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
      },
    ]);
  }

  public async wakeRun(
    runId: string,
    event: {
      eventKey: string;
      payload?: Record<string, unknown>;
      correlationId?: string;
    },
    options: { deferProcessing?: boolean } = {},
  ): Promise<DurableWakeResult> {
    const result = await this.deps.durableRunService.wakeDurableRun(runId, event);
    if (result.outcome === "woke" && result.run) {
      return this.afterWakeCommit("Durable run wake", result, [
        ...(options.deferProcessing ? [] : [() => this.deps.durableRunService.requestRunProcessing(runId)]),
        async () =>
          await this.deps.hooksService.enqueueAfterHooks({
            workspaceId: await this.deps.resolveDurableRunHookWorkspaceId(result.run!),
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

  private async afterRunCommit(
    operation: string,
    run: DurableRunRecord,
    postCommitConsumers: ReadonlyArray<() => void | Promise<void>>,
  ): Promise<DurableRunRecord> {
    try {
      await this.runPostCommitConsumers(postCommitConsumers);
      return run;
    } catch (error) {
      throw new DurableOperatorPostCommitError(operation, run, error);
    }
  }

  private async afterWakeCommit(
    operation: string,
    result: DurableWakeResult,
    postCommitConsumers: ReadonlyArray<() => void | Promise<void>>,
  ): Promise<DurableWakeResult> {
    try {
      await this.runPostCommitConsumers(postCommitConsumers);
      return result;
    } catch (error) {
      throw new DurableOperatorPostCommitError(operation, result, error);
    }
  }

  private async runPostCommitConsumers(consumers: ReadonlyArray<() => void | Promise<void>>): Promise<void> {
    const failures: unknown[] = [];
    for (const consume of consumers) {
      try {
        await consume();
      } catch (error) {
        failures.push(error);
      }
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, `${failures.length} durable post-commit consumer(s) failed`);
    }
  }

  public async recoverDeadLetter(
    entryId: string,
    actorId = "operator",
    options?: { maxAttempts?: number },
  ): Promise<DurableRunRecord> {
    return this.deps.durableRunService.recoverDurableDeadLetter(entryId, actorId, options);
  }
}
