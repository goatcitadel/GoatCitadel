import type { DurableOperatorService } from "./durable-operator-service.js";

type DurableRoutePort = Pick<
  DurableOperatorService,
  | "cancelRun"
  | "createRun"
  | "getDiagnostics"
  | "getRun"
  | "listDeadLetters"
  | "listRunCheckpoints"
  | "listRunTimeline"
  | "watchChildRun"
  | "listChildWatchers"
  | "detachChildWatcher"
  | "reattachChildWatcher"
  | "closeChildWatcher"
  | "getBackgroundTaskRail"
  | "controlBackgroundTask"
  | "listRuns"
  | "pauseRun"
  | "recoverDeadLetter"
  | "resumeRun"
  | "retryRun"
  | "wakeRun"
>;

export class DurableRouteService {
  public constructor(private readonly durable: DurableRoutePort) {}

  public getDiagnostics() {
    return this.durable.getDiagnostics();
  }

  public listRuns(limit: number) {
    return this.durable.listRuns(limit);
  }

  public listDeadLetters(limit: number) {
    return this.durable.listDeadLetters(limit);
  }

  public listRunCheckpoints(runId: string, limit: number) {
    return this.durable.listRunCheckpoints(runId, limit);
  }

  public createRun(input: Parameters<DurableRoutePort["createRun"]>[0]) {
    return this.durable.createRun(input);
  }

  public getRun(runId: string) {
    return this.durable.getRun(runId);
  }

  public listRunTimeline(runId: string, limit: number) {
    return this.durable.listRunTimeline(runId, limit);
  }

  public watchChildRun(input: Parameters<DurableRoutePort["watchChildRun"]>[0]) {
    return this.durable.watchChildRun(input);
  }

  public listChildWatchers(parentRunId: string, limit: number) {
    return this.durable.listChildWatchers(parentRunId, limit);
  }

  public detachChildWatcher(watcherId: string) {
    return this.durable.detachChildWatcher(watcherId);
  }

  public reattachChildWatcher(watcherId: string) {
    return this.durable.reattachChildWatcher(watcherId);
  }

  public closeChildWatcher(watcherId: string) {
    return this.durable.closeChildWatcher(watcherId);
  }

  public getBackgroundTaskRail(parentRunId: string, input: Parameters<DurableRoutePort["getBackgroundTaskRail"]>[1]) {
    return this.durable.getBackgroundTaskRail(parentRunId, input);
  }

  public controlBackgroundTask(
    parentRunId: string,
    watcherId: string,
    input: Parameters<DurableRoutePort["controlBackgroundTask"]>[2],
    actorId: string,
  ) {
    return this.durable.controlBackgroundTask(parentRunId, watcherId, input, actorId);
  }

  public pauseRun(runId: string, actorId: string) {
    return this.durable.pauseRun(runId, actorId);
  }

  public resumeRun(runId: string, actorId: string) {
    return this.durable.resumeRun(runId, actorId);
  }

  public cancelRun(runId: string, actorId: string) {
    return this.durable.cancelRun(runId, actorId);
  }

  public retryRun(runId: string, reason: string | undefined, actorId: string) {
    return this.durable.retryRun(runId, reason, actorId);
  }

  public wakeRun(runId: string, input: Parameters<DurableRoutePort["wakeRun"]>[1]) {
    return this.durable.wakeRun(runId, input);
  }

  public recoverDeadLetter(
    entryId: string,
    actorId: string,
    options?: Parameters<DurableRoutePort["recoverDeadLetter"]>[2],
  ) {
    return this.durable.recoverDeadLetter(entryId, actorId, options);
  }
}
