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

export type WorkflowRecipePlanCreateRequest = WorkflowRecipePreviewRequest;

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
