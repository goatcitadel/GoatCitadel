import type { GatewayService } from "./gateway-service.js";

type DurableRouteGateway = Pick<
  GatewayService,
  | "cancelDurableRun"
  | "createDurableRun"
  | "getDurableDiagnostics"
  | "getDurableRun"
  | "listDurableDeadLetters"
  | "listDurableRunCheckpoints"
  | "listDurableRunTimeline"
  | "listDurableRuns"
  | "pauseDurableRun"
  | "recoverDurableDeadLetter"
  | "resumeDurableRun"
  | "retryDurableRun"
  | "wakeDurableRun"
>;

export class DurableRouteService {
  public constructor(private readonly gateway: DurableRouteGateway) {}

  public getDiagnostics() {
    return this.gateway.getDurableDiagnostics();
  }

  public listRuns(limit: number) {
    return this.gateway.listDurableRuns(limit);
  }

  public listDeadLetters(limit: number) {
    return this.gateway.listDurableDeadLetters(limit);
  }

  public listRunCheckpoints(runId: string, limit: number) {
    return this.gateway.listDurableRunCheckpoints(runId, limit);
  }

  public createRun(input: Parameters<DurableRouteGateway["createDurableRun"]>[0]) {
    return this.gateway.createDurableRun(input);
  }

  public getRun(runId: string) {
    return this.gateway.getDurableRun(runId);
  }

  public listRunTimeline(runId: string, limit: number) {
    return this.gateway.listDurableRunTimeline(runId, limit);
  }

  public pauseRun(runId: string, actorId: string) {
    return this.gateway.pauseDurableRun(runId, actorId);
  }

  public resumeRun(runId: string, actorId: string) {
    return this.gateway.resumeDurableRun(runId, actorId);
  }

  public cancelRun(runId: string, actorId: string) {
    return this.gateway.cancelDurableRun(runId, actorId);
  }

  public retryRun(runId: string, reason: string | undefined, actorId: string) {
    return this.gateway.retryDurableRun(runId, reason, actorId);
  }

  public wakeRun(runId: string, input: Parameters<DurableRouteGateway["wakeDurableRun"]>[1]) {
    return this.gateway.wakeDurableRun(runId, input);
  }

  public recoverDeadLetter(
    entryId: string,
    actorId: string,
    options?: Parameters<DurableRouteGateway["recoverDurableDeadLetter"]>[2],
  ) {
    return this.gateway.recoverDurableDeadLetter(entryId, actorId, options);
  }
}
