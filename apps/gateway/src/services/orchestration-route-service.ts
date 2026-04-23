import type { OrchestrationPlan, OrchestrationRun, MemoryContextPack } from "@goatcitadel/contracts";
import type { OrchestrationCheckpoint } from "@goatcitadel/storage";
import type { GatewayService } from "./gateway-service.js";

type OrchestrationRouteGateway = Pick<
  GatewayService,
  | "approvePhase"
  | "createOrchestrationPlan"
  | "getRun"
  | "listRunCheckpoints"
  | "listRunContexts"
  | "runOrchestrationPlan"
>;

export class OrchestrationRouteService {
  public constructor(private readonly gateway: OrchestrationRouteGateway) {}

  public async createPlan(plan: OrchestrationPlan): Promise<OrchestrationRun> {
    return this.gateway.createOrchestrationPlan(plan);
  }

  public async runPlan(planId: string): Promise<OrchestrationRun> {
    return this.gateway.runOrchestrationPlan(planId);
  }

  public async approvePhase(
    runId: string,
    phaseId: string,
    approvedBy: string,
    costIncrementUsd: number,
  ): Promise<unknown> {
    return this.gateway.approvePhase(runId, phaseId, approvedBy, costIncrementUsd);
  }

  public getRun(runId: string): OrchestrationRun {
    return this.gateway.getRun(runId);
  }

  public listRunCheckpoints(runId: string): OrchestrationCheckpoint[] {
    return this.gateway.listRunCheckpoints(runId);
  }

  public listRunContexts(runId: string): MemoryContextPack[] {
    return this.gateway.listRunContexts(runId);
  }
}
