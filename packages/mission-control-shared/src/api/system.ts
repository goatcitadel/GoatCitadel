import type {
  BackupCreateResponse,
  BackupManifestRecord,
  BackupVerifyResponse,
  MediaCreateJobRequest,
  MediaJobRecord,
  RetentionPolicy,
  RetentionPruneResult,
} from "@goatcitadel/contracts";
import type {
  CostSummaryResponse,
  DashboardStateResponse,
  HealthSummaryResponse,
  RealtimeEvent,
  SystemVitalsResponse,
  TimelineSummaryResponse,
} from "./types.js";
import { request } from "./client-core.js";

export async function createMediaJob(input: MediaCreateJobRequest): Promise<MediaJobRecord> {
  return request<MediaJobRecord>("/api/v1/media/jobs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchMediaJob(jobId: string): Promise<MediaJobRecord> {
  return request<MediaJobRecord>(`/api/v1/media/jobs/${encodeURIComponent(jobId)}`);
}

export async function fetchMediaJobs(sessionId?: string): Promise<{ items: MediaJobRecord[] }> {
  const query = sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : "";
  return request<{ items: MediaJobRecord[] }>(`/api/v1/media/jobs${query}`);
}

export async function fetchRetentionPolicy(): Promise<RetentionPolicy> {
  return request<RetentionPolicy>("/api/v1/admin/retention");
}

export async function updateRetentionPolicy(input: Partial<RetentionPolicy>): Promise<RetentionPolicy> {
  return request<RetentionPolicy>("/api/v1/admin/retention", {
    method: "PATCH",
    body: JSON.stringify(input),
  });
}

export async function pruneRetention(dryRun = true): Promise<RetentionPruneResult> {
  return request<RetentionPruneResult>("/api/v1/admin/retention/prune", {
    method: "POST",
    body: JSON.stringify({ dryRun }),
  });
}

export async function listBackups(limit = 50): Promise<{ items: BackupManifestRecord[] }> {
  return request<{ items: BackupManifestRecord[] }>(`/api/v1/admin/backups?limit=${limit}`);
}

export async function createBackup(input?: { name?: string; outputPath?: string }): Promise<BackupCreateResponse> {
  return request<BackupCreateResponse>("/api/v1/admin/backups/create", {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function verifyBackup(filePath: string): Promise<BackupVerifyResponse> {
  return request<BackupVerifyResponse>("/api/v1/admin/backups/verify", {
    method: "POST",
    body: JSON.stringify({ filePath }),
  });
}

export async function fetchCostSummary(
  scope: "day" | "session" | "agent" | "task" = "day",
): Promise<CostSummaryResponse> {
  return request<CostSummaryResponse>(`/api/v1/costs/summary?scope=${scope}`);
}

export async function runCheaper(): Promise<{ mode: string; actions: string[] }> {
  return request<{ mode: string; actions: string[] }>("/api/v1/costs/run-cheaper", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchRealtimeEvents(
  limit = 100,
  cursor?: string,
): Promise<{ items: RealtimeEvent[]; nextCursor?: string }> {
  const query = new URLSearchParams({
    limit: String(limit),
  });
  if (cursor?.trim()) {
    query.set("cursor", cursor.trim());
  }
  return request<{ items: RealtimeEvent[]; nextCursor?: string }>(`/api/v1/events?${query.toString()}`);
}

export async function fetchDashboardState(): Promise<DashboardStateResponse> {
  return request<DashboardStateResponse>("/api/v1/dashboard/state");
}

export async function fetchSystemVitals(): Promise<SystemVitalsResponse> {
  return request<SystemVitalsResponse>("/api/v1/system/vitals");
}

export async function fetchTimelineSummary(): Promise<TimelineSummaryResponse> {
  return request<TimelineSummaryResponse>("/api/v1/observe/timeline");
}

export async function fetchHealthSummary(): Promise<HealthSummaryResponse> {
  return request<HealthSummaryResponse>("/api/v1/observe/health");
}
