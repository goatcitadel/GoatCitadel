import type {
  WorkflowRecipePlanCreateRequest,
  WorkflowRecipePlanCreateResponse,
  WorkflowRecipePreviewRequest,
  WorkflowRecipePreviewResponse,
  WorkflowRecipeTemplatesResponse,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function previewWorkflowRecipe(
  input: WorkflowRecipePreviewRequest,
): Promise<WorkflowRecipePreviewResponse> {
  return request<WorkflowRecipePreviewResponse>("/api/v1/orchestration/recipes/preview", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function createWorkflowRecipePlan(
  input: WorkflowRecipePlanCreateRequest,
): Promise<WorkflowRecipePlanCreateResponse> {
  return request<WorkflowRecipePlanCreateResponse>("/api/v1/orchestration/recipes/plans", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchWorkflowRecipeTemplates(): Promise<WorkflowRecipeTemplatesResponse> {
  return request<WorkflowRecipeTemplatesResponse>("/api/v1/orchestration/recipes/templates");
}
