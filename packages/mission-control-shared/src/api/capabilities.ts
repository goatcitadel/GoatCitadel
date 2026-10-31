import type {
  CandidateSkillDetailRecord,
  CapabilityProposalRecord,
  AutonomousActivationGrantRecord,
  CodeModeRunRecord,
  CodeModeRunRequest,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function createCapabilityProposal(input: {
  proposalKind: "skill" | "tool";
  title: string;
  summary: string;
  payload: Record<string, unknown>;
  candidateId?: string;
  activationTargetId?: string;
}): Promise<CapabilityProposalRecord> {
  return request("/api/v1/capabilities/proposals", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchAutonomousActivationGrants(
  includeExpired = false,
  signal?: AbortSignal,
): Promise<{ items: AutonomousActivationGrantRecord[] }> {
  return request(`/api/v1/capabilities/autonomy-grants?includeExpired=${includeExpired ? "true" : "false"}`, {
    cache: "no-store",
    ...(signal ? { signal } : {}),
  });
}

/**
 * HX-402 P2: direct candidate lifecycle verbs are approval-first. The gateway
 * answers 202 with one canonical pending `capability.lifecycle` approval (the
 * recovered approval effect is the only executor) or 200 with a no-op
 * envelope when the reviewed state already matches.
 */
export interface CapabilityLifecyclePendingApproval {
  approvalId: string;
  status: string;
  kind: "capability.lifecycle";
  action: "candidate_promoted" | "candidate_revoked" | "candidate_rolled_back";
  candidateId: string;
  requestSha256: string;
  expectedStateSha256: string;
  expiresAt?: string;
  createdAt: string;
  replayed: boolean;
}

export type CapabilityCandidateMutationOutcome =
  | { pendingApproval: CapabilityLifecyclePendingApproval }
  | { pendingApproval: null; noMutationRequired: true; detail: CandidateSkillDetailRecord }
  | {
      pendingApproval: null;
      noMutationRequired: false;
      detail: CandidateSkillDetailRecord;
      changePlan: import("@goatcitadel/contracts").ChangePlanRecord;
    };

export async function createCodeModeRun(input: CodeModeRunRequest): Promise<CodeModeRunRecord> {
  const requestBody = input.originSurface ? { ...input, originSurface: "chat" as const } : input;
  return request("/api/v1/code-mode/runs", {
    method: "POST",
    headers: input.originSurface ? { "x-goatcitadel-origin-surface": "chat" } : undefined,
    body: JSON.stringify(requestBody),
  });
}

// Optional destination operations retain their public bindings and shared request owner.
export {
  fetchCapabilityCatalog,
  fetchCapabilityCatalogSnapshot,
  fetchCapabilityCatalogDriftMetrics,
  fetchCapabilityAuditExport,
  fetchCapabilityProposals,
  createAutonomousActivationGrant,
  revokeAutonomousActivationGrant,
  evaluateAutonomousActivationGrant,
  fetchCapabilityProposal,
  fetchCapabilityCandidate,
  fetchCandidateSkillArtifactReview,
  promoteCapabilityCandidate,
  revokeCapabilityCandidate,
  rollbackCapabilityCandidate,
  fetchCodeModeRuns,
  fetchCodeModeExecutionBackends,
  fetchCodeModeReadiness,
  fetchCodeModeRun,
  keepCodeModeRun,
  fetchCodeModeRunVerificationEvidence,
  verifyCodeModeRun,
  fetchCodeModeRunArtifact,
  compareCodeModeRuns,
} from "./capabilities-operations.js";
