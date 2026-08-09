import type {
  CandidateSkillDetailRecord,
  CapabilityAuditExportRecord,
  CapabilityCatalogEntry,
  CapabilityCatalogDriftMetricsRecord,
  CapabilityCatalogScope,
  CapabilityCatalogSnapshotRecord,
  CapabilityProposalDetailRecord,
  CapabilityProposalRecord,
  AutonomousActivationGrantCreateInput,
  AutonomousActivationGrantEvaluationInput,
  AutonomousActivationGrantEvaluationResult,
  AutonomousActivationGrantRecord,
  AutonomousActivationGrantRevokeInput,
  CodeModeRunArtifactKind,
  CodeModeRunArtifactPreview,
  CodeModeRunComparisonRecord,
  CodeModeExecutionBackendsResponse,
  CodeModeRunListOptions,
  CodeModeRunRecord,
  CodeModeRunRequest,
  CodeModeRunVerificationRequest,
  CodeModeRunVerificationResponse,
  CodeModeVerificationEvidenceRecord,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchCapabilityCatalog(
  scope: CapabilityCatalogScope = "inspectable",
): Promise<{ scope: CapabilityCatalogScope; items: CapabilityCatalogEntry[] }> {
  return request(`/api/v1/capabilities/catalog?scope=${encodeURIComponent(scope)}`);
}

export async function fetchCapabilityCatalogSnapshot(snapshotId: string): Promise<CapabilityCatalogSnapshotRecord> {
  return request(`/api/v1/capabilities/snapshots/${encodeURIComponent(snapshotId)}`);
}

export async function fetchCapabilityCatalogDriftMetrics(
  workspaceId?: string,
): Promise<CapabilityCatalogDriftMetricsRecord> {
  const suffix = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return request(`/api/v1/capabilities/catalog-metrics${suffix}`);
}

export async function fetchCapabilityAuditExport(
  snapshotId: string,
  input: { workspaceId?: string; runIds?: string[] } = {},
): Promise<CapabilityAuditExportRecord> {
  const params = new URLSearchParams();
  if (input.workspaceId) {
    params.set("workspaceId", input.workspaceId);
  }
  if (input.runIds?.length) {
    params.set("runIds", [...new Set(input.runIds)].sort().join(","));
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request(`/api/v1/capabilities/snapshots/${encodeURIComponent(snapshotId)}/audit-export${suffix}`);
}

export async function fetchCapabilityProposals(limit = 100): Promise<{ items: CapabilityProposalRecord[] }> {
  return request(`/api/v1/capabilities/proposals?limit=${Math.max(1, Math.min(limit, 500))}`);
}

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
): Promise<{ items: AutonomousActivationGrantRecord[] }> {
  return request(`/api/v1/capabilities/autonomy-grants?includeExpired=${includeExpired ? "true" : "false"}`);
}

export async function createAutonomousActivationGrant(
  input: AutonomousActivationGrantCreateInput,
): Promise<AutonomousActivationGrantRecord> {
  return request("/api/v1/capabilities/autonomy-grants", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function revokeAutonomousActivationGrant(
  grantId: string,
  input: AutonomousActivationGrantRevokeInput,
): Promise<AutonomousActivationGrantRecord> {
  return request(`/api/v1/capabilities/autonomy-grants/${encodeURIComponent(grantId)}/revoke`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function evaluateAutonomousActivationGrant(
  input: AutonomousActivationGrantEvaluationInput,
): Promise<AutonomousActivationGrantEvaluationResult> {
  return request("/api/v1/capabilities/autonomy-grants/evaluate", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchCapabilityProposal(proposalId: string): Promise<CapabilityProposalDetailRecord> {
  return request(`/api/v1/capabilities/proposals/${encodeURIComponent(proposalId)}`);
}

export async function fetchCapabilityCandidate(candidateId: string): Promise<CandidateSkillDetailRecord> {
  return request(`/api/v1/capabilities/candidates/${encodeURIComponent(candidateId)}`);
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
  | { pendingApproval: null; noMutationRequired: true; detail: CandidateSkillDetailRecord };

export async function promoteCapabilityCandidate(
  candidateId: string,
  expectedRevision: number,
  versionId?: string,
): Promise<CapabilityCandidateMutationOutcome> {
  return request(`/api/v1/capabilities/candidates/${encodeURIComponent(candidateId)}/promote`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision, ...(versionId ? { versionId } : {}) }),
  });
}

export async function revokeCapabilityCandidate(
  candidateId: string,
  expectedRevision: number,
  versionId?: string,
): Promise<CapabilityCandidateMutationOutcome> {
  return request(`/api/v1/capabilities/candidates/${encodeURIComponent(candidateId)}/revoke`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision, ...(versionId ? { versionId } : {}) }),
  });
}

export async function rollbackCapabilityCandidate(
  candidateId: string,
  targetVersionId: string,
  expectedRevision: number,
): Promise<CapabilityCandidateMutationOutcome> {
  return request(`/api/v1/capabilities/candidates/${encodeURIComponent(candidateId)}/rollback`, {
    method: "POST",
    body: JSON.stringify({ expectedRevision, targetVersionId }),
  });
}

export async function fetchCodeModeRuns(
  input: number | CodeModeRunListOptions = 100,
): Promise<{ items: CodeModeRunRecord[] }> {
  const options = typeof input === "number" ? { limit: input } : input;
  const params = new URLSearchParams();
  params.set("limit", String(Math.max(1, Math.min(options.limit ?? 100, 500))));
  if (options.workspaceId) {
    params.set("workspaceId", options.workspaceId);
  }
  if (options.sessionId) {
    params.set("sessionId", options.sessionId);
  }
  if (options.turnId) {
    params.set("turnId", options.turnId);
  }
  if (options.status) {
    params.set("status", options.status);
  }
  return request(`/api/v1/code-mode/runs?${params.toString()}`);
}

export async function fetchCodeModeExecutionBackends(): Promise<CodeModeExecutionBackendsResponse> {
  return request("/api/v1/code-mode/execution-backends");
}

export async function fetchCodeModeRun(
  runId: string,
  input?: {
    sessionId?: string;
    turnId?: string;
    workspaceId?: string;
  },
): Promise<CodeModeRunRecord> {
  const params = new URLSearchParams();
  if (input?.sessionId) {
    params.set("sessionId", input.sessionId);
  }
  if (input?.turnId) {
    params.set("turnId", input.turnId);
  }
  if (input?.workspaceId) {
    params.set("workspaceId", input.workspaceId);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request(`/api/v1/code-mode/runs/${encodeURIComponent(runId)}${suffix}`);
}

export async function fetchCodeModeRunVerificationEvidence(
  runId: string,
  input?: {
    sessionId?: string;
    turnId?: string;
    workspaceId?: string;
    limit?: number;
  },
): Promise<{ items: CodeModeVerificationEvidenceRecord[] }> {
  const params = codeModeRunScopeParams(input);
  params.set("limit", String(Math.max(1, Math.min(input?.limit ?? 50, 200))));
  return request(`/api/v1/code-mode/runs/${encodeURIComponent(runId)}/verification/evidence?${params.toString()}`);
}

export async function verifyCodeModeRun(
  runId: string,
  input: CodeModeRunVerificationRequest,
  scope?: {
    sessionId?: string;
    turnId?: string;
    workspaceId?: string;
  },
): Promise<CodeModeRunVerificationResponse> {
  const params = codeModeRunScopeParams(scope);
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request(`/api/v1/code-mode/runs/${encodeURIComponent(runId)}/verification${suffix}`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchCodeModeRunArtifact(
  runId: string,
  artifactKind: CodeModeRunArtifactKind,
  input?: {
    sessionId?: string;
    turnId?: string;
    workspaceId?: string;
  },
): Promise<CodeModeRunArtifactPreview> {
  const params = new URLSearchParams();
  if (input?.sessionId) {
    params.set("sessionId", input.sessionId);
  }
  if (input?.turnId) {
    params.set("turnId", input.turnId);
  }
  if (input?.workspaceId) {
    params.set("workspaceId", input.workspaceId);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request(
    `/api/v1/code-mode/runs/${encodeURIComponent(runId)}/artifacts/${encodeURIComponent(artifactKind)}${suffix}`,
  );
}

export async function compareCodeModeRuns(
  runId: string,
  baselineRunId: string,
  input?: {
    sessionId?: string;
    turnId?: string;
    workspaceId?: string;
  },
): Promise<CodeModeRunComparisonRecord> {
  const params = new URLSearchParams();
  if (input?.sessionId) {
    params.set("sessionId", input.sessionId);
  }
  if (input?.turnId) {
    params.set("turnId", input.turnId);
  }
  if (input?.workspaceId) {
    params.set("workspaceId", input.workspaceId);
  }
  const suffix = params.size > 0 ? `?${params.toString()}` : "";
  return request(
    `/api/v1/code-mode/runs/${encodeURIComponent(runId)}/compare/${encodeURIComponent(baselineRunId)}${suffix}`,
  );
}

export async function createCodeModeRun(input: CodeModeRunRequest): Promise<CodeModeRunRecord> {
  const requestBody = input.originSurface ? { ...input, originSurface: "chat" as const } : input;
  return request("/api/v1/code-mode/runs", {
    method: "POST",
    headers: input.originSurface ? { "x-goatcitadel-origin-surface": "chat" } : undefined,
    body: JSON.stringify(requestBody),
  });
}

function codeModeRunScopeParams(input?: {
  sessionId?: string;
  turnId?: string;
  workspaceId?: string;
}): URLSearchParams {
  const params = new URLSearchParams();
  if (input?.sessionId) {
    params.set("sessionId", input.sessionId);
  }
  if (input?.turnId) {
    params.set("turnId", input.turnId);
  }
  if (input?.workspaceId) {
    params.set("workspaceId", input.workspaceId);
  }
  return params;
}
