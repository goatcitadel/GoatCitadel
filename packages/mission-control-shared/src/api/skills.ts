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
  SkillStateRecord,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchSkills(): Promise<{ items: SkillListItem[] }> {
  return request("/api/v1/skills");
}

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

/**
 * HX-402 P2: the legacy executable install is retired. The gateway validates
 * (advisory) and answers with a structured redirect into the governed Skill
 * Hub review surface — no bytes are published and no skill becomes callable
 * from this endpoint.
 */
export interface SkillImportRedirectResult {
  disposition: "redirected_to_skill_hub";
  validation: SkillImportValidationResult;
  redirect: {
    owner: "skill_hub";
    reviewRoute: string;
    sourceRef: string;
    sourceType?: "git_url" | "remote_bundle";
    eligible: boolean;
    ineligibleReason?: string;
  };
}

export async function installSkillImport(input: {
  sourceRef: string;
  sourceType?: SkillImportSourceType;
  sourceProvider?: SkillSourceProvider;
  force?: boolean;
  confirmHighRisk?: boolean;
}): Promise<SkillImportRedirectResult> {
  return request<SkillImportRedirectResult>("/api/v1/skills/import/install", {
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

/**
 * HX-402 P2: operator skill-state mutations are approval-first. The gateway
 * answers 202 with one canonical pending `skill.lifecycle` approval (the
 * recovered approval effect is the only executor) or 200 with a no-op
 * envelope when the reviewed state already matches.
 */
export interface SkillLifecyclePendingApproval {
  approvalId: string;
  status: string;
  kind: "skill.lifecycle";
  action: "skill_state_set" | "skill_state_bulk_set" | "activation_policy_updated";
  subjectKind: "skill" | "skill_batch" | "skill_activation_policy";
  subjectId?: string;
  requestSha256: string;
  expectedStateSha256: string;
  expiresAt?: string;
  createdAt: string;
  replayed: boolean;
  skillIds: string[];
}

export type SkillStateMutationOutcome =
  | { pendingApproval: SkillLifecyclePendingApproval }
  | { pendingApproval: null; noMutationRequired: true; skillState: SkillStateRecord };

export type SkillStateBulkMutationOutcome =
  | { pendingApproval: SkillLifecyclePendingApproval }
  | { pendingApproval: null; noMutationRequired: true; skillStates: SkillStateRecord[] };

export type SkillActivationPolicyMutationOutcome =
  | { pendingApproval: SkillLifecyclePendingApproval }
  | { pendingApproval: null; noMutationRequired: true; policy: SkillActivationPolicy };

export async function updateSkillState(
  skillId: string,
  input: { expectedRevision: number; state: SkillRuntimeState; note?: string },
): Promise<SkillStateMutationOutcome> {
  return request<SkillStateMutationOutcome>("/api/v1/skills/by-id/state", {
    method: "PATCH",
    body: JSON.stringify({ ...input, skillId }),
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
