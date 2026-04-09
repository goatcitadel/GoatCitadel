import type {
  A2UIProofLaneDraft,
  BackupCreateResponse,
  BackupManifestRecord,
  BrowserProofLaneDraft,
  ExtensionSdkBriefDraft,
  ExtensionStarterPackArtifactRecord,
  ExtensionStarterPackDraft,
  FollowOnParityReport,
  FollowOnProofLaneArtifactRecord,
  MediaCreateJobRequest,
  MediaJobRecord,
  OpenclawParityProgramReport,
  PackagingProofLaneDraft,
  RetentionPolicy,
  RetentionPruneResult,
  VoiceProofLaneDraft,
} from "@goatcitadel/contracts";
import type { CostSummaryResponse, DashboardStateResponse, RealtimeEvent, SystemVitalsResponse } from "./types.js";
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

export async function restoreBackup(
  filePath: string,
  confirm = false,
): Promise<{ restored: boolean; backupId?: string; filesRestored: number }> {
  return request<{ restored: boolean; backupId?: string; filesRestored: number }>("/api/v1/admin/backups/restore", {
    method: "POST",
    body: JSON.stringify({ filePath, confirm }),
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

export async function fetchFollowOnParityReport(): Promise<FollowOnParityReport> {
  return request<FollowOnParityReport>("/api/v1/system/follow-on-parity");
}

export async function fetchOpenclawParityReport(): Promise<OpenclawParityProgramReport> {
  return request<OpenclawParityProgramReport>("/api/v1/system/openclaw-parity");
}

export async function fetchBrowserProofLaneDraft(): Promise<BrowserProofLaneDraft> {
  return request<BrowserProofLaneDraft>("/api/v1/system/follow-on-parity/browser-proof-lane");
}

export async function exportBrowserProofLaneDraft(): Promise<FollowOnProofLaneArtifactRecord> {
  return request<FollowOnProofLaneArtifactRecord>("/api/v1/system/follow-on-parity/browser-proof-lane/export", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchPackagingProofLaneDraft(): Promise<PackagingProofLaneDraft> {
  return request<PackagingProofLaneDraft>("/api/v1/system/follow-on-parity/packaging-proof-lane");
}

export async function exportPackagingProofLaneDraft(): Promise<FollowOnProofLaneArtifactRecord> {
  return request<FollowOnProofLaneArtifactRecord>("/api/v1/system/follow-on-parity/packaging-proof-lane/export", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchA2UIProofLaneDraft(): Promise<A2UIProofLaneDraft> {
  return request<A2UIProofLaneDraft>("/api/v1/system/follow-on-parity/a2ui-proof-lane");
}

export async function fetchVoiceProofLaneDraft(): Promise<VoiceProofLaneDraft> {
  return request<VoiceProofLaneDraft>("/api/v1/system/follow-on-parity/voice-proof-lane");
}

export async function exportVoiceProofLaneDraft(): Promise<FollowOnProofLaneArtifactRecord> {
  return request<FollowOnProofLaneArtifactRecord>("/api/v1/system/follow-on-parity/voice-proof-lane/export", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function exportA2UIProofLaneDraft(): Promise<FollowOnProofLaneArtifactRecord> {
  return request<FollowOnProofLaneArtifactRecord>("/api/v1/system/follow-on-parity/a2ui-proof-lane/export", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function exportCompanionBootstrapBrief(): Promise<FollowOnProofLaneArtifactRecord> {
  return request<FollowOnProofLaneArtifactRecord>("/api/v1/system/follow-on-parity/companion-bootstrap-brief/export", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchExtensionSdkBrief(): Promise<ExtensionSdkBriefDraft> {
  return request<ExtensionSdkBriefDraft>("/api/v1/system/follow-on-parity/extension-sdk-brief");
}

export async function exportExtensionSdkBrief(): Promise<FollowOnProofLaneArtifactRecord> {
  return request<FollowOnProofLaneArtifactRecord>("/api/v1/system/follow-on-parity/extension-sdk-brief/export", {
    method: "POST",
    body: JSON.stringify({}),
  });
}

export async function fetchExtensionStarterPack(): Promise<ExtensionStarterPackDraft> {
  return request<ExtensionStarterPackDraft>("/api/v1/system/follow-on-parity/extension-starter-pack");
}

export async function exportExtensionStarterPack(): Promise<ExtensionStarterPackArtifactRecord> {
  return request<ExtensionStarterPackArtifactRecord>("/api/v1/system/follow-on-parity/extension-starter-pack/export", {
    method: "POST",
    body: JSON.stringify({}),
  });
}
