import type {
  OrchestrationPlan,
  OrchestrationRun,
  OrchestrationRunPolicyContext,
  MemoryContextPack,
  AutomationRecipeDraftRequest,
  AutomationRecipeDraftResponse,
  WorkflowRecipeActivepiecesTemplateExportRequest,
  WorkflowRecipeActivepiecesTemplateExportResponse,
  WorkflowRecipePlanCreateRequest,
  WorkflowRecipePlanCreateResponse,
  WorkflowRecipePreviewRequest,
  WorkflowRecipePreviewResponse,
  WorkflowRecipeTemplatesResponse,
} from "@goatcitadel/contracts";
import type { OrchestrationCheckpoint } from "@goatcitadel/storage";

export interface OrchestrationRoutePort {
  createOrchestrationPlan(
    plan: OrchestrationPlan,
    policyContext?: OrchestrationRunPolicyContext,
  ): Promise<OrchestrationRun>;
  createPlanFromRecipe(
    input: WorkflowRecipePlanCreateRequest,
    policyContext?: OrchestrationRunPolicyContext,
  ): Promise<WorkflowRecipePlanCreateResponse>;
  draftAutomationRecipe(input: AutomationRecipeDraftRequest): AutomationRecipeDraftResponse;
  exportActivepiecesTemplate(
    input: WorkflowRecipeActivepiecesTemplateExportRequest,
  ): WorkflowRecipeActivepiecesTemplateExportResponse;
  listRecipeTemplates(): WorkflowRecipeTemplatesResponse;
  previewRecipe(input: WorkflowRecipePreviewRequest): WorkflowRecipePreviewResponse;
  runOrchestrationPlan(planId: string, policyContext?: OrchestrationRunPolicyContext): Promise<OrchestrationRun>;
  cancelOrchestrationRun(
    runId: string,
    actorId?: string,
    workspaceId?: string,
  ): Promise<{ run: OrchestrationRun; checkpoints: OrchestrationCheckpoint[] }>;
  approvePhase(
    runId: string,
    phaseId: string,
    approvedBy: string,
    costIncrementUsd: number,
    workspaceId?: string,
  ): Promise<unknown>;
  getRun(runId: string, workspaceId?: string): OrchestrationRun;
  listRunCheckpoints(runId: string, workspaceId?: string): OrchestrationCheckpoint[];
  listRunContexts(runId: string): MemoryContextPack[];
}

export class OrchestrationRouteService {
  public constructor(private readonly orchestration: OrchestrationRoutePort) {}

  public async createPlan(
    plan: OrchestrationPlan,
    policyContext?: OrchestrationRunPolicyContext,
  ): Promise<OrchestrationRun> {
    return policyContext
      ? this.orchestration.createOrchestrationPlan(plan, policyContext)
      : this.orchestration.createOrchestrationPlan(plan);
  }

  public previewRecipe(input: WorkflowRecipePreviewRequest): WorkflowRecipePreviewResponse {
    return this.orchestration.previewRecipe(input);
  }

  public async createPlanFromRecipe(
    input: WorkflowRecipePlanCreateRequest,
    policyContext?: OrchestrationRunPolicyContext,
  ): Promise<WorkflowRecipePlanCreateResponse> {
    return policyContext
      ? this.orchestration.createPlanFromRecipe(input, policyContext)
      : this.orchestration.createPlanFromRecipe(input);
  }

  public listRecipeTemplates(): WorkflowRecipeTemplatesResponse {
    return this.orchestration.listRecipeTemplates();
  }

  public draftAutomationRecipe(input: AutomationRecipeDraftRequest): AutomationRecipeDraftResponse {
    return this.orchestration.draftAutomationRecipe(input);
  }

  public exportActivepiecesTemplate(
    input: WorkflowRecipeActivepiecesTemplateExportRequest,
  ): WorkflowRecipeActivepiecesTemplateExportResponse {
    return this.orchestration.exportActivepiecesTemplate(input);
  }

  public async runPlan(planId: string, policyContext?: OrchestrationRunPolicyContext): Promise<OrchestrationRun> {
    return policyContext
      ? this.orchestration.runOrchestrationPlan(planId, policyContext)
      : this.orchestration.runOrchestrationPlan(planId);
  }

  public async cancelRun(
    runId: string,
    actorId?: string,
    workspaceId?: string,
  ): Promise<{ run: OrchestrationRun; checkpoints: OrchestrationCheckpoint[] }> {
    return this.orchestration.cancelOrchestrationRun(runId, actorId, workspaceId);
  }

  public async approvePhase(
    runId: string,
    phaseId: string,
    approvedBy: string,
    costIncrementUsd: number,
    workspaceId?: string,
  ): Promise<unknown> {
    return this.orchestration.approvePhase(runId, phaseId, approvedBy, costIncrementUsd, workspaceId);
  }

  public getRun(runId: string, workspaceId?: string): OrchestrationRun {
    return this.orchestration.getRun(runId, workspaceId);
  }

  public listRunCheckpoints(runId: string, workspaceId?: string): OrchestrationCheckpoint[] {
    return this.orchestration.listRunCheckpoints(runId, workspaceId);
  }

  public listRunContexts(runId: string): MemoryContextPack[] {
    return this.orchestration.listRunContexts(runId);
  }
}
