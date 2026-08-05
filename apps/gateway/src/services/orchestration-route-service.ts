import type {
  OrchestrationPlan,
  OrchestrationDecisionTrace,
  OrchestrationRun,
  OrchestrationRunPolicyContext,
  MemoryContextPack,
  AutomationRecipeDraftRequest,
  AutomationRecipeDraftResponse,
  WorkflowRecipeActivepiecesTemplateExportRequest,
  WorkflowRecipeActivepiecesTemplateExportResponse,
  WorkflowRecipeN8nTemplateExportRequest,
  WorkflowRecipeN8nTemplateExportResponse,
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
  draftAutomationRecipe(input: AutomationRecipeDraftRequest): Promise<AutomationRecipeDraftResponse>;
  exportActivepiecesTemplate(
    input: WorkflowRecipeActivepiecesTemplateExportRequest,
  ): Promise<WorkflowRecipeActivepiecesTemplateExportResponse>;
  exportN8nTemplate(input: WorkflowRecipeN8nTemplateExportRequest): Promise<WorkflowRecipeN8nTemplateExportResponse>;
  listRecipeTemplates(): WorkflowRecipeTemplatesResponse;
  previewRecipe(input: WorkflowRecipePreviewRequest): Promise<WorkflowRecipePreviewResponse>;
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
  getRun(runId: string, workspaceId?: string): Promise<OrchestrationRun>;
  listRunCheckpoints(runId: string, workspaceId?: string): Promise<OrchestrationCheckpoint[]>;
  getRunTrace(runId: string, workspaceId?: string): Promise<OrchestrationDecisionTrace>;
  listRunContexts(runId: string): Promise<MemoryContextPack[]>;
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

  public async previewRecipe(input: WorkflowRecipePreviewRequest): Promise<WorkflowRecipePreviewResponse> {
    return await this.orchestration.previewRecipe(input);
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

  public async draftAutomationRecipe(input: AutomationRecipeDraftRequest): Promise<AutomationRecipeDraftResponse> {
    return await this.orchestration.draftAutomationRecipe(input);
  }

  public async exportActivepiecesTemplate(
    input: WorkflowRecipeActivepiecesTemplateExportRequest,
  ): Promise<WorkflowRecipeActivepiecesTemplateExportResponse> {
    return await this.orchestration.exportActivepiecesTemplate(input);
  }

  public async exportN8nTemplate(
    input: WorkflowRecipeN8nTemplateExportRequest,
  ): Promise<WorkflowRecipeN8nTemplateExportResponse> {
    return await this.orchestration.exportN8nTemplate(input);
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

  public async getRun(runId: string, workspaceId?: string): Promise<OrchestrationRun> {
    return await this.orchestration.getRun(runId, workspaceId);
  }

  public async listRunCheckpoints(runId: string, workspaceId?: string): Promise<OrchestrationCheckpoint[]> {
    return await this.orchestration.listRunCheckpoints(runId, workspaceId);
  }

  public async getRunTrace(runId: string, workspaceId?: string): Promise<OrchestrationDecisionTrace> {
    return await this.orchestration.getRunTrace(runId, workspaceId);
  }

  public async listRunContexts(runId: string): Promise<MemoryContextPack[]> {
    return await this.orchestration.listRunContexts(runId);
  }
}
