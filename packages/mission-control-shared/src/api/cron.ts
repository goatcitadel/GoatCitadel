import type { CronReviewItem, CronRunDiff } from "@goatcitadel/contracts";
import type { CronJobRecordResponse, CronJobsResponse } from "./types.js";
import { request } from "./client-core.js";

export async function fetchCronJobs(): Promise<CronJobsResponse> {
  return request<CronJobsResponse>("/api/v1/cron/jobs");
}

export async function fetchCronJob(jobId: string): Promise<CronJobRecordResponse> {
  return request<CronJobRecordResponse>(`/api/v1/cron/jobs/${encodeURIComponent(jobId)}`);
}

export async function createCronJob(input: {
  jobId: string;
  name: string;
  action?: "task" | "improvement" | "backup" | "memory_flush" | "cost_report" | "update_review" | "watchdog";
  actionConfig?: Record<string, unknown>;
  description?: string;
  schedule: string;
  enabled?: boolean;
  endAt?: string;
}): Promise<CronJobRecordResponse> {
  return request<CronJobRecordResponse>("/api/v1/cron/jobs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function updateCronJob(
  jobId: string,
  input: {
    name?: string;
    action?: "task" | "improvement" | "backup" | "memory_flush" | "cost_report" | "update_review" | "watchdog";
    actionConfig?: Record<string, unknown> | null;
    description?: string;
    schedule?: string;
    enabled?: boolean;
    endAt?: string | null;
  },
): Promise<CronJobRecordResponse> {
  return request<CronJobRecordResponse>(`/api/v1/cron/jobs/${encodeURIComponent(jobId)}`, {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function startCronJob(jobId: string): Promise<CronJobRecordResponse> {
  return request<CronJobRecordResponse>(`/api/v1/cron/jobs/${encodeURIComponent(jobId)}/start`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function pauseCronJob(jobId: string): Promise<CronJobRecordResponse> {
  return request<CronJobRecordResponse>(`/api/v1/cron/jobs/${encodeURIComponent(jobId)}/pause`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function runCronJobNow(jobId: string): Promise<{ jobId: string; status: "ok" }> {
  return request<{ jobId: string; status: "ok" }>(`/api/v1/cron/jobs/${encodeURIComponent(jobId)}/run`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchCronReviewQueue(limit = 200): Promise<{ items: CronReviewItem[] }> {
  return request<{ items: CronReviewItem[] }>(`/api/v1/cron/review-queue?limit=${Math.max(1, Math.min(limit, 1000))}`);
}

export async function retryCronReviewQueueItem(itemId: string): Promise<CronReviewItem> {
  return request<CronReviewItem>(`/api/v1/cron/review-queue/${encodeURIComponent(itemId)}/retry`, {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchCronRunDiff(runId: string): Promise<CronRunDiff> {
  return request<CronRunDiff>(`/api/v1/cron/runs/${encodeURIComponent(runId)}/diff`);
}

export async function deleteCronJob(jobId: string): Promise<{ deleted: boolean; jobId: string }> {
  return request<{ deleted: boolean; jobId: string }>(`/api/v1/cron/jobs/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });
}
