import type {
  ReviewFindingImportResult,
  ReviewFindingInput,
  ReviewFindingRecord,
  ReviewReadinessSummary,
  ReviewRunRecord,
  RuntimeBuildIdentity,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function fetchReviewReadiness(): Promise<ReviewReadinessSummary> {
  return request<ReviewReadinessSummary>("/api/v1/review/readiness");
}

export async function refreshRuntimeReleaseTrust(): Promise<ReviewReadinessSummary> {
  return request<ReviewReadinessSummary>("/api/v1/review/readiness/runtime-release/refresh", {
    method: "POST",
  });
}

export async function fetchRuntimeBuildIdentity(): Promise<RuntimeBuildIdentity> {
  return request<RuntimeBuildIdentity>("/api/v1/review/identity");
}

export async function importReviewFindings(findings: ReviewFindingInput[]): Promise<ReviewFindingImportResult> {
  return request<ReviewFindingImportResult>("/api/v1/review/findings/import", {
    method: "POST",
    body: JSON.stringify({ findings }),
  });
}

export async function startStructuredReview(input: {
  participants: Array<{ participantId: string; providerId: string; model: string; label?: string }>;
  workspaceId?: string;
  sourceSessionId?: string;
  sourceTaskId?: string;
  costBudgetUsd?: number;
  tokenBudget?: number;
}): Promise<ReviewRunRecord> {
  return request<ReviewRunRecord>("/api/v1/review/runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchStructuredReviewRuns(limit = 50): Promise<{ items: ReviewRunRecord[] }> {
  return request<{ items: ReviewRunRecord[] }>(`/api/v1/review/runs?limit=${Math.max(1, Math.min(200, limit))}`);
}

export async function fetchStructuredReviewRun(reviewRunId: string): Promise<ReviewRunRecord> {
  return request<ReviewRunRecord>(`/api/v1/review/runs/${encodeURIComponent(reviewRunId)}`);
}

export async function acceptStructuredReviewFinding(
  findingId: string,
  mirrorToTask = true,
): Promise<ReviewFindingRecord> {
  return request<ReviewFindingRecord>(`/api/v1/review/findings/${encodeURIComponent(findingId)}/accept`, {
    method: "POST",
    body: JSON.stringify({ mirrorToTask }),
  });
}

export async function dismissStructuredReviewFinding(findingId: string): Promise<ReviewFindingRecord> {
  return request<ReviewFindingRecord>(`/api/v1/review/findings/${encodeURIComponent(findingId)}/dismiss`, {
    method: "POST",
  });
}

export async function requestStructuredReviewFix(findingId: string): Promise<ReviewFindingRecord> {
  return request<ReviewFindingRecord>(`/api/v1/review/findings/${encodeURIComponent(findingId)}/request-fix`, {
    method: "POST",
  });
}

export async function closeStructuredReviewFinding(
  findingId: string,
  input: { verificationEvidence: string[]; followUpReviewRunId: string },
): Promise<ReviewFindingRecord> {
  return request<ReviewFindingRecord>(`/api/v1/review/findings/${encodeURIComponent(findingId)}/close`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
