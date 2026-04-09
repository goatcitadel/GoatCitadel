import type {
  CapabilityGapEventRecord,
  DecisionAutoTuneRecord,
  DecisionReplayFindingRecord,
  DecisionReplayItemRecord,
  DecisionReplayRunRecord,
  RepairCandidateRecord,
  ReplayDiffSummary,
  ReplayOverrideDraft,
  WeeklyImprovementReportRecord,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchImprovementReports(limit = 24): Promise<{ items: WeeklyImprovementReportRecord[] }> {
  return request<{ items: WeeklyImprovementReportRecord[] }>(
    `/api/v1/improvement/reports?limit=${Math.max(1, Math.min(limit, 260))}`,
  );
}

export async function fetchImprovementReport(reportId: string): Promise<WeeklyImprovementReportRecord> {
  return request<WeeklyImprovementReportRecord>(`/api/v1/improvement/reports/${encodeURIComponent(reportId)}`);
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
