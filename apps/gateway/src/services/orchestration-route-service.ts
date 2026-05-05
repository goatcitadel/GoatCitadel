import type {
  OrchestrationPlan,
  OrchestrationRun,
  MemoryContextPack,
  WorkflowRecipePlanCreateRequest,
  WorkflowRecipePlanCreateResponse,
  WorkflowRecipePreviewRequest,
  WorkflowRecipePreviewResponse,
  WorkflowRecipeTemplatesResponse,
} from "@goatcitadel/contracts";
import type { OrchestrationCheckpoint } from "@goatcitadel/storage";

export interface OrchestrationRoutePort {
  createOrchestrationPlan(plan: OrchestrationPlan): Promise<OrchestrationRun>;
  createPlanFromRecipe(input: WorkflowRecipePlanCreateRequest): Promise<WorkflowRecipePlanCreateResponse>;
  listRecipeTemplates(): WorkflowRecipeTemplatesResponse;
  previewRecipe(input: WorkflowRecipePreviewRequest): WorkflowRecipePreviewResponse;
  runOrchestrationPlan(planId: string): Promise<OrchestrationRun>;
  approvePhase(runId: string, phaseId: string, approvedBy: string, costIncrementUsd: number): Promise<unknown>;
  getRun(runId: string): OrchestrationRun;
  listRunCheckpoints(runId: string): OrchestrationCheckpoint[];
  listRunContexts(runId: string): MemoryContextPack[];
}

export class OrchestrationRouteService {
  public constructor(private readonly orchestration: OrchestrationRoutePort) {}

  public async createPlan(plan: OrchestrationPlan): Promise<OrchestrationRun> {
    return this.orchestration.createOrchestrationPlan(plan);
  }

  public previewRecipe(input: WorkflowRecipePreviewRequest): WorkflowRecipePreviewResponse {
    return this.orchestration.previewRecipe(input);
  }

  public async createPlanFromRecipe(input: WorkflowRecipePlanCreateRequest): Promise<WorkflowRecipePlanCreateResponse> {
    return this.orchestration.createPlanFromRecipe(input);
  }

  public listRecipeTemplates(): WorkflowRecipeTemplatesResponse {
    return this.orchestration.listRecipeTemplates();
  }

  public async runPlan(planId: string): Promise<OrchestrationRun> {
    return this.orchestration.runOrchestrationPlan(planId);
  }

  public async approvePhase(
    runId: string,
    phaseId: string,
    approvedBy: string,
    costIncrementUsd: number,
  ): Promise<unknown> {
    return this.orchestration.approvePhase(runId, phaseId, approvedBy, costIncrementUsd);
  }

  public getRun(runId: string): OrchestrationRun {
    return this.orchestration.getRun(runId);
  }

  public listRunCheckpoints(runId: string): OrchestrationCheckpoint[] {
    return this.orchestration.listRunCheckpoints(runId);
  }

  public listRunContexts(runId: string): MemoryContextPack[] {
    return this.orchestration.listRunContexts(runId);
  }
}
