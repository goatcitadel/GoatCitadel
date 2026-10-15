import type { SkillStateBulkMutationOutcome, SkillActivationPolicyMutationOutcome } from "./skills.js";
import type {
  SkillActivationPolicy,
  SkillEvaluationListResponse,
  SkillEvaluationPreviewRequest,
  SkillEvaluationPreviewResponse,
  SkillEvaluationProposalResponse,
  SkillEvaluationRunRequest,
  SkillEvaluationRunResponse,
  SkillImportHistoryRecord,
  SkillImportSourceType,
  SkillImportValidationResult,
  SkillListItem,
  SkillRuntimeState,
  SkillSourceListResponse,
  SkillSourceLookupResponse,
  SkillSourceProvider,
} from "@goatcitadel/contracts";

import { request } from "./client-core.js";

export async function reloadSkills(): Promise<{ items: SkillListItem[] }> {
  return request("/api/v1/skills/reload", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchSkillSources(query?: { q?: string; limit?: number }): Promise<SkillSourceListResponse> {
  const params = new URLSearchParams();
  if (query?.q?.trim()) {
    params.set("q", query.q.trim());
  }
  if (query?.limit) {
    params.set("limit", String(Math.max(1, Math.min(query.limit, 100))));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request<SkillSourceListResponse>(`/api/v1/skills/sources${suffix}`);
}

export async function fetchSkillLookup(query: { q: string; limit?: number }): Promise<SkillSourceLookupResponse> {
  const params = new URLSearchParams();
  params.set("q", query.q.trim());
  if (query.limit) {
    params.set("limit", String(Math.max(1, Math.min(query.limit, 100))));
  }
  return request<SkillSourceLookupResponse>(`/api/v1/skills/lookup?${params.toString()}`);
}

export async function validateSkillImport(input: {
  sourceRef: string;
  sourceType?: SkillImportSourceType;
  sourceProvider?: SkillSourceProvider;
}): Promise<SkillImportValidationResult> {
  return request<SkillImportValidationResult>("/api/v1/skills/import/validate", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchSkillImportHistory(limit = 100): Promise<{ items: SkillImportHistoryRecord[] }> {
  const boundedLimit = Math.max(1, Math.min(limit, 300));
  return request<{ items: SkillImportHistoryRecord[] }>(`/api/v1/skills/import/history?limit=${boundedLimit}`);
}

export async function previewSkillEvaluation(
  skillId: string,
  input: SkillEvaluationPreviewRequest = {},
): Promise<SkillEvaluationPreviewResponse> {
  return request<SkillEvaluationPreviewResponse>("/api/v1/skills/by-id/evaluations/preview", {
    method: "POST",
    body: JSON.stringify({ ...input, skillId }),
  });
}

export async function runSkillEvaluation(
  skillId: string,
  input: SkillEvaluationRunRequest = {},
): Promise<SkillEvaluationRunResponse> {
  return request<SkillEvaluationRunResponse>("/api/v1/skills/by-id/evaluations/run", {
    method: "POST",
    body: JSON.stringify({ ...input, skillId }),
  });
}

export async function fetchSkillEvaluations(skillId: string): Promise<SkillEvaluationListResponse> {
  return request<SkillEvaluationListResponse>(
    `/api/v1/skills/by-id/evaluations?${new URLSearchParams({ skillId }).toString()}`,
  );
}

export async function fetchSkillEvaluationRun(runId: string): Promise<SkillEvaluationPreviewResponse["run"]> {
  return request<SkillEvaluationPreviewResponse["run"]>(`/api/v1/skills/evaluations/${encodeURIComponent(runId)}`);
}

export async function createSkillEvaluationProposal(runId: string): Promise<SkillEvaluationProposalResponse> {
  return request<SkillEvaluationProposalResponse>(`/api/v1/skills/evaluations/${encodeURIComponent(runId)}/proposal`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function bulkUpdateSkillState(input: {
  skillIds: string[];
  expectedRevisionsBySkillId: Record<string, number>;
  state: SkillRuntimeState;
  note?: string;
}): Promise<SkillStateBulkMutationOutcome> {
  return request<SkillStateBulkMutationOutcome>("/api/v1/skills/bulk-state", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchSkillActivationPolicies(): Promise<SkillActivationPolicy> {
  return request<SkillActivationPolicy>("/api/v1/skills/activation-policies");
}

export async function patchSkillActivationPolicies(
  input: Partial<Omit<SkillActivationPolicy, "revision">> & { expectedRevision: number },
): Promise<SkillActivationPolicyMutationOutcome> {
  return request<SkillActivationPolicyMutationOutcome>("/api/v1/skills/activation-policies", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}
