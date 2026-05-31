import type { OrchestrationPlan, OrchestrationRun } from "./orchestration.js";

export type WorkflowRecipeProcess = "sequential" | "parallel" | "hierarchical";

export interface WorkflowRecipeAgent {
  id: string;
  role: string;
  goal?: string;
  skills?: string[];
  tools?: string[];
}

export interface WorkflowRecipeStep {
  id: string;
  title: string;
  agent: string;
  prompt: string;
  dependsOn?: string[];
  requiresApproval?: boolean;
  tools?: string[];
  skills?: string[];
}

export interface WorkflowRecipeApproval {
  mode?: "none" | "before_run" | "before_each_step" | "on_sensitive_steps";
  requiredBeforeRun?: boolean;
  requiredBeforeSteps?: string[];
}

export interface WorkflowRecipeLimits {
  maxIterations?: number;
  maxRuntimeMinutes?: number;
  maxCostUsd?: number;
}

export interface WorkflowRecipeRecord {
  name: string;
  goal: string;
  process: WorkflowRecipeProcess;
  agents: WorkflowRecipeAgent[];
  steps: WorkflowRecipeStep[];
  approval?: WorkflowRecipeApproval;
  limits?: WorkflowRecipeLimits;
  tools?: string[];
  skills?: string[];
  memory?: string[];
  knowledge?: string[];
  scheduleIntent?: string;
  channelIntent?: string;
}

export interface WorkflowRecipePreviewRequest {
  source?: string;
  recipe?: unknown;
}

export interface WorkflowRecipePreviewResponse {
  recipe: WorkflowRecipeRecord;
  plan: OrchestrationPlan;
  warnings: string[];
  requiredApprovals: string[];
  missingTools: string[];
  missingSkills: string[];
  estimatedLimits: Required<WorkflowRecipeLimits>;
}

export interface WorkflowRecipePlanCreateRequest extends WorkflowRecipePreviewRequest {
  workspaceId?: string;
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
}

export interface WorkflowRecipePlanCreateResponse extends WorkflowRecipePreviewResponse {
  run: OrchestrationRun;
}

export interface WorkflowRecipeTemplateRecord {
  templateId: string;
  name: string;
  description: string;
  recipe: WorkflowRecipeRecord;
}

export interface WorkflowRecipeTemplatesResponse {
  items: WorkflowRecipeTemplateRecord[];
}

export interface AutomationRecipeDraftRequest {
  taskDescription: string;
  trigger?: string;
  frequency?: string;
  successCriteria?: string[];
  constraints?: string[];
  workspaceId?: string;
}

export interface AutomationRecipeDraftResponse extends WorkflowRecipePreviewResponse {
  roiEstimate: {
    timeSavedMinutesPerRun?: number;
    confidence: number;
    notes: string[];
  };
  proofChecklist: string[];
  missingCapabilities: string[];
}

export interface WorkflowRecipeActivepiecesTemplateExportRequest extends WorkflowRecipePreviewRequest {
  flowName?: string;
  webhookPath?: string;
}

export interface WorkflowRecipeActivepiecesTemplateStep {
  id: string;
  displayName: string;
  agent: string;
  prompt: string;
  requiresApproval: boolean;
  dependsOn: string[];
}

export interface WorkflowRecipeActivepiecesTemplate {
  name: string;
  description: string;
  trigger: {
    type: "webhook";
    path: string;
    method: "POST";
  };
  steps: WorkflowRecipeActivepiecesTemplateStep[];
  metadata: {
    source: "goatcitadel.workflow_recipe";
    planId: string;
    approvalMode: "none" | "human_in_the_loop";
    scheduleIntent?: string;
    channelIntent?: string;
  };
}

export type WorkflowRecipeActivepiecesTemplateValidationStatus = "passed" | "warning" | "blocked";

export interface WorkflowRecipeActivepiecesTemplateValidationCheck {
  id: string;
  label: string;
  status: WorkflowRecipeActivepiecesTemplateValidationStatus;
  detail: string;
}

export interface WorkflowRecipeActivepiecesTemplateValidation {
  status: "ready_for_operator_import_review" | "blocked";
  nativeImportCompatibility: "not_verified";
  checks: WorkflowRecipeActivepiecesTemplateValidationCheck[];
  notes: string[];
}

export interface WorkflowRecipeActivepiecesTemplateExportResponse extends WorkflowRecipePreviewResponse {
  version: "workflow_recipe.activepieces_template_export.v1";
  generatedAt: string;
  filename: string;
  contentType: "application/json";
  activepiecesTemplate: WorkflowRecipeActivepiecesTemplate;
  validation: WorkflowRecipeActivepiecesTemplateValidation;
  posture: {
    readOnly: true;
    sideEffectPosture: "not_executed";
    importRequired: true;
    execution: "operator_import_required";
  };
  content: string;
}
