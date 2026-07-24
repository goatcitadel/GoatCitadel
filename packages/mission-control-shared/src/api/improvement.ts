import type {
  CapabilityGapEventRecord,
  CuratorReviewItem,
  CuratorReviewResponse,
  DecisionAutoTuneRecord,
  DecisionReplayFindingRecord,
  DecisionReplayItemRecord,
  DecisionReplayRunRecord,
  HarnessAuditReportRecord,
  ImprovementActivationRecord,
  ImprovementCandidateDetailResponse,
  ImprovementCandidateLifecycleAction,
  ImprovementCandidateLifecycleInput,
  ImprovementCandidateLifecycleResult,
  ImprovementCandidateRecord,
  ImprovementLifecycleOperationKind,
  ImprovementLifecycleTargetKind,
  ImprovementSignalRecord,
  RepairCandidateRecord,
  ReplayDiffSummary,
  ReplayOverrideDraft,
  WeeklyImprovementReportRecord,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export type {
  CuratorReviewItem,
  CuratorReviewResponse,
  ImprovementCandidateLifecycleAction,
  ImprovementCandidateLifecycleInput,
  ImprovementCandidateLifecycleResult,
};

/**
 * HX-402 P3: the pending `improvement.lifecycle` approval envelope returned by
 * the approval-first activation/pause/rollback request routes. The request
 * never mutates — the recovered approval effect applies the operation later
 * through the durable intent/claim/inspection/settlement state machine.
 */
export interface ImprovementLifecyclePendingApproval {
  approvalId: string;
  status: "pending" | "approved" | "rejected" | "expired" | "edited";
  kind: "improvement.lifecycle";
  operationKind: ImprovementLifecycleOperationKind;
  targetKind: ImprovementLifecycleTargetKind;
  targetId: string;
  workspaceId: string;
  requestSha256: string;
  expectedStateSha256: string;
  expiresAt?: string;
  createdAt: string;
  replayed: boolean;
}

export type ImprovementLifecycleRequestOutcome =
  | { pendingApproval: ImprovementLifecyclePendingApproval }
  | { pendingApproval: null; noMutationRequired: true; activation: ImprovementActivationRecord };

export async function fetchImprovementReports(limit = 24): Promise<{ items: WeeklyImprovementReportRecord[] }> {
  return request<{ items: WeeklyImprovementReportRecord[] }>(
    `/api/v1/improvement/reports?limit=${Math.max(1, Math.min(limit, 260))}`,
  );
}

export async function fetchImprovementReport(reportId: string): Promise<WeeklyImprovementReportRecord> {
  return request<WeeklyImprovementReportRecord>(`/api/v1/improvement/reports/${encodeURIComponent(reportId)}`);
}

export async function fetchHarnessAuditReport(): Promise<HarnessAuditReportRecord> {
  return request<HarnessAuditReportRecord>("/api/v1/improvement/harness-audit");
}

export async function runImprovementReplay(input?: { sampleSize?: number }): Promise<{
  run: DecisionReplayRunRecord;
  report?: WeeklyImprovementReportRecord;
}> {
  return request<{
    run: DecisionReplayRunRecord;
    report?: WeeklyImprovementReportRecord;
  }>("/api/v1/improvement/replay/run", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function fetchImprovementReplayRuns(limit = 40): Promise<{ items: DecisionReplayRunRecord[] }> {
  return request<{ items: DecisionReplayRunRecord[] }>(
    `/api/v1/improvement/replay/runs?limit=${Math.max(1, Math.min(limit, 300))}`,
  );
}

export async function fetchImprovementSignals(
  limit = 100,
  workspaceId?: string,
): Promise<{ items: ImprovementSignalRecord[] }> {
  const query = new URLSearchParams({
    limit: String(Math.max(1, Math.min(limit, 500))),
  });
  if (workspaceId) {
    query.set("workspaceId", workspaceId);
  }
  return request<{ items: ImprovementSignalRecord[] }>(`/api/v1/improvement/signals?${query.toString()}`);
}

export async function fetchImprovementSignal(signalId: string): Promise<ImprovementSignalRecord> {
  return request<ImprovementSignalRecord>(`/api/v1/improvement/signals/${encodeURIComponent(signalId)}`);
}

export async function fetchImprovementCandidates(
  limit = 100,
  workspaceId?: string,
): Promise<{ items: ImprovementCandidateRecord[] }> {
  const query = new URLSearchParams({
    limit: String(Math.max(1, Math.min(limit, 300))),
  });
  if (workspaceId) {
    query.set("workspaceId", workspaceId);
  }
  return request<{ items: ImprovementCandidateRecord[] }>(`/api/v1/improvement/candidates?${query.toString()}`);
}

export async function fetchImprovementCandidate(candidateId: string): Promise<ImprovementCandidateDetailResponse> {
  return request<ImprovementCandidateDetailResponse>(
    `/api/v1/improvement/candidates/${encodeURIComponent(candidateId)}`,
  );
}

export async function fetchCuratorReviewItems(input?: {
  limit?: number;
  workspaceId?: string;
}): Promise<CuratorReviewResponse> {
  const query = new URLSearchParams({
    limit: String(Math.max(1, Math.min(input?.limit ?? 100, 300))),
  });
  if (input?.workspaceId) {
    query.set("workspaceId", input.workspaceId);
  }
  return request<CuratorReviewResponse>(`/api/v1/improvement/curator-review?${query.toString()}`);
}

export async function fetchCuratorReviewItem(candidateId: string): Promise<CuratorReviewItem> {
  return request<CuratorReviewItem>(`/api/v1/improvement/candidates/${encodeURIComponent(candidateId)}/curator-review`);
}

async function runImprovementCandidateLifecycleAction(
  candidateId: string,
  action: ImprovementCandidateLifecycleAction,
  input?: ImprovementCandidateLifecycleInput,
): Promise<ImprovementCandidateLifecycleResult> {
  return request<ImprovementCandidateLifecycleResult>(
    `/api/v1/improvement/candidates/${encodeURIComponent(candidateId)}/${action}`,
    {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    },
  );
}

export async function validateImprovementCandidate(
  candidateId: string,
  input?: ImprovementCandidateLifecycleInput,
): Promise<ImprovementCandidateLifecycleResult> {
  return runImprovementCandidateLifecycleAction(candidateId, "validate", input);
}

export async function approveImprovementCandidate(
  candidateId: string,
  input?: ImprovementCandidateLifecycleInput,
): Promise<ImprovementCandidateLifecycleResult> {
  return runImprovementCandidateLifecycleAction(candidateId, "approve", input);
}

export async function rejectImprovementCandidate(
  candidateId: string,
  input?: ImprovementCandidateLifecycleInput,
): Promise<ImprovementCandidateLifecycleResult> {
  return runImprovementCandidateLifecycleAction(candidateId, "reject", input);
}

export async function snoozeImprovementCandidate(
  candidateId: string,
  input?: ImprovementCandidateLifecycleInput,
): Promise<ImprovementCandidateLifecycleResult> {
  return runImprovementCandidateLifecycleAction(candidateId, "snooze", input);
}

export async function activateImprovementCandidate(
  candidateId: string,
  input?: ImprovementCandidateLifecycleInput,
): Promise<ImprovementCandidateLifecycleResult> {
  return runImprovementCandidateLifecycleAction(candidateId, "activate", input);
}

export async function promoteImprovementCandidate(
  candidateId: string,
  input?: ImprovementCandidateLifecycleInput,
): Promise<ImprovementCandidateLifecycleResult> {
  return runImprovementCandidateLifecycleAction(candidateId, "promote", input);
}

export async function requestImprovementActivation(
  candidateId: string,
  input?: { actorId?: string },
): Promise<{ pendingApproval: ImprovementLifecyclePendingApproval }> {
  return request<{ pendingApproval: ImprovementLifecyclePendingApproval }>(
    `/api/v1/improvement/candidates/${encodeURIComponent(candidateId)}/activation-request`,
    {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    },
  );
}

export async function fetchImprovementActivation(activationId: string): Promise<ImprovementActivationRecord> {
  return request<ImprovementActivationRecord>(`/api/v1/improvement/activations/${encodeURIComponent(activationId)}`);
}

export async function pauseImprovementActivation(
  activationId: string,
  input?: { actorId?: string },
): Promise<ImprovementLifecycleRequestOutcome> {
  return request<ImprovementLifecycleRequestOutcome>(
    `/api/v1/improvement/activations/${encodeURIComponent(activationId)}/pause`,
    {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    },
  );
}

export async function rollbackImprovementActivation(
  activationId: string,
  input?: { actorId?: string },
): Promise<ImprovementLifecycleRequestOutcome> {
  return request<ImprovementLifecycleRequestOutcome>(
    `/api/v1/improvement/activations/${encodeURIComponent(activationId)}/rollback`,
    {
      method: "POST",
      body: JSON.stringify(input ?? {}),
    },
  );
}

export async function fetchCapabilityGapEvents(limit = 100): Promise<{ items: CapabilityGapEventRecord[] }> {
  return request<{ items: CapabilityGapEventRecord[] }>(
    `/api/v1/improvement/capability-gaps?limit=${Math.max(1, Math.min(limit, 500))}`,
  );
}

export async function fetchRepairCandidates(limit = 60): Promise<{ items: RepairCandidateRecord[] }> {
  return request<{ items: RepairCandidateRecord[] }>(
    `/api/v1/improvement/repair-candidates?limit=${Math.max(1, Math.min(limit, 300))}`,
  );
}

export async function updateRepairCandidateValidation(
  candidateId: string,
  input: {
    status: RepairCandidateRecord["validationStatus"];
    summary?: string;
  },
): Promise<RepairCandidateRecord> {
  return request<RepairCandidateRecord>(
    `/api/v1/improvement/repair-candidates/${encodeURIComponent(candidateId)}/validation`,
    {
      method: "PATCH",
      body: JSON.stringify(input),
    },
  );
}

export async function fetchImprovementReplayRun(runId: string): Promise<{
  run: DecisionReplayRunRecord;
  items: DecisionReplayItemRecord[];
  findings: DecisionReplayFindingRecord[];
  autoTunes: DecisionAutoTuneRecord[];
  report?: WeeklyImprovementReportRecord;
}> {
  return request<{
    run: DecisionReplayRunRecord;
    items: DecisionReplayItemRecord[];
    findings: DecisionReplayFindingRecord[];
    autoTunes: DecisionAutoTuneRecord[];
    report?: WeeklyImprovementReportRecord;
  }>(`/api/v1/improvement/replay/runs/${encodeURIComponent(runId)}`);
}

export async function draftReplayOverride(
  runId: string,
  input: {
    overrides: ReplayOverrideDraft["overrides"];
    capabilityGapEventId?: string;
    repairCandidateId?: string;
  },
): Promise<ReplayOverrideDraft> {
  return request<ReplayOverrideDraft>(`/api/v1/replay/runs/${encodeURIComponent(runId)}/draft`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function executeReplayOverride(
  runId: string,
  input: {
    overrides: ReplayOverrideDraft["overrides"];
    capabilityGapEventId?: string;
    repairCandidateId?: string;
  },
): Promise<ReplayOverrideDraft> {
  return request<ReplayOverrideDraft>(`/api/v1/replay/runs/${encodeURIComponent(runId)}/execute`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchReplayDiff(replayRunId: string): Promise<ReplayDiffSummary> {
  return request<ReplayDiffSummary>(`/api/v1/replay/${encodeURIComponent(replayRunId)}/diff`);
}

export async function approveImprovementAutoTune(tuneId: string): Promise<DecisionAutoTuneRecord> {
  return request<DecisionAutoTuneRecord>(`/api/v1/improvement/autotune/${encodeURIComponent(tuneId)}/approve`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function revertImprovementAutoTune(tuneId: string): Promise<DecisionAutoTuneRecord> {
  return request<DecisionAutoTuneRecord>(`/api/v1/improvement/autotune/${encodeURIComponent(tuneId)}/revert`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}
