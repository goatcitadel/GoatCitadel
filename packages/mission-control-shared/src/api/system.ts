import type { HealthSummaryResponse } from "./types.js";
import { request } from "./client-core.js";

export async function fetchHealthSummary(): Promise<HealthSummaryResponse> {
  return request<HealthSummaryResponse>("/api/v1/observe/health");
}

// Optional destination operations retain their public bindings and shared request owner.
export {
  createMediaJob,
  fetchMediaJob,
  fetchMediaJobs,
  fetchRetentionPolicy,
  updateRetentionPolicy,
  pruneRetention,
  listBackups,
  createBackup,
  verifyBackup,
  fetchCostSummary,
  fetchModelUsageEvents,
  runCheaper,
  fetchRealtimeEvents,
  fetchDashboardState,
  fetchSystemVitals,
  fetchTimelineSummary,
} from "./system-operations.js";
