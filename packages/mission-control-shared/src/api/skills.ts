import type {
  SkillActivationPolicy,
  SkillImportSourceType,
  SkillImportValidationResult,
  SkillListItem,
  SkillRuntimeState,
  SkillSourceProvider,
  SkillStateRecord,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchSkills(): Promise<{ items: SkillListItem[] }> {
  return request("/api/v1/skills");
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

// Optional destination operations retain their public bindings and shared request owner.
export {
  reloadSkills,
  fetchSkillSources,
  fetchSkillLookup,
  validateSkillImport,
  fetchSkillImportHistory,
  previewSkillEvaluation,
  runSkillEvaluation,
  fetchSkillEvaluations,
  fetchSkillEvaluationRun,
  createSkillEvaluationProposal,
  bulkUpdateSkillState,
  fetchSkillActivationPolicies,
  patchSkillActivationPolicies,
} from "./skills-operations.js";
