import type {
  CandidateLifecycleActionResult,
  CandidateSkillDetailRecord,
  CapabilityCatalogEntry,
  CapabilityCatalogScope,
  CapabilityCatalogSnapshotRecord,
  CapabilityProposalDetailRecord,
  CapabilityProposalRecord,
  CodeModeRunArtifactKind,
  CodeModeRunArtifactPreview,
  CodeModeRunComparisonRecord,
  CodeModeExecutionBackendsResponse,
  CodeModeRunListOptions,
  CodeModeRunRecord,
  CodeModeRunRequest,
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

export async function fetchCapabilityProposal(proposalId: string): Promise<CapabilityProposalDetailRecord> {
  return request(`/api/v1/capabilities/proposals/${encodeURIComponent(proposalId)}`);
}

export async function fetchCapabilityCandidate(candidateId: string): Promise<CandidateSkillDetailRecord> {
  return request(`/api/v1/capabilities/candidates/${encodeURIComponent(candidateId)}`);
}

export async function promoteCapabilityCandidate(
  candidateId: string,
  versionId?: string,
): Promise<CandidateLifecycleActionResult> {
  return request(`/api/v1/capabilities/candidates/${encodeURIComponent(candidateId)}/promote`, {
    method: "POST",
    body: JSON.stringify(versionId ? { versionId } : {}),
  });
}

export async function revokeCapabilityCandidate(
  candidateId: string,
  versionId?: string,
): Promise<CandidateLifecycleActionResult> {
  return request(`/api/v1/capabilities/candidates/${encodeURIComponent(candidateId)}/revoke`, {
    method: "POST",
    body: JSON.stringify(versionId ? { versionId } : {}),
  });
}

export async function rollbackCapabilityCandidate(
  candidateId: string,
  targetVersionId: string,
): Promise<CandidateLifecycleActionResult> {
  return request(`/api/v1/capabilities/candidates/${encodeURIComponent(candidateId)}/rollback`, {
    method: "POST",
    body: JSON.stringify({ targetVersionId }),
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
  return request("/api/v1/code-mode/runs", {
    method: "POST",
    headers: input.originSurface ? { "x-goatcitadel-origin-surface": input.originSurface } : undefined,
    body: JSON.stringify(input),
  });
}
