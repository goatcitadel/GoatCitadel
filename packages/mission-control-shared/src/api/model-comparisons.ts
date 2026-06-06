import type {
  ModelComparisonCreateRequest,
  ModelComparisonJudgeRequest,
  ModelComparisonJudgment,
  ModelComparisonRun,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function createModelComparison(input: ModelComparisonCreateRequest): Promise<ModelComparisonRun> {
  return request<ModelComparisonRun>("/api/v1/model-comparisons", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchModelComparison(comparisonId: string): Promise<ModelComparisonRun> {
  return request<ModelComparisonRun>(`/api/v1/model-comparisons/${encodeURIComponent(comparisonId)}`);
}

export async function listModelComparisons(limit = 50): Promise<{ items: ModelComparisonRun[] }> {
  return request<{ items: ModelComparisonRun[] }>(
    `/api/v1/model-comparisons?limit=${Math.max(1, Math.min(limit, 200))}`,
  );
}

export async function judgeModelComparison(
  comparisonId: string,
  input: ModelComparisonJudgeRequest,
): Promise<ModelComparisonJudgment> {
  return request<ModelComparisonJudgment>(`/api/v1/model-comparisons/${encodeURIComponent(comparisonId)}/judgments`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
