import type {
  RuntimeLifecycleExportBundle,
  RuntimeLifecycleResponse,
  SessionSummary,
  SessionTimelineItem,
} from "@goatcitadel/contracts";

import type { SessionsResponse } from "./types.js";

import { request } from "./client-core.js";

export type { RuntimeLifecycleExportBundle, RuntimeLifecycleResponse, SessionSummary, SessionTimelineItem };

export async function fetchSessions(): Promise<SessionsResponse> {
  return request<SessionsResponse>("/api/v1/sessions?limit=50");
}

export async function fetchSessionSummary(sessionId: string): Promise<SessionSummary> {
  return request<SessionSummary>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/summary`);
}

export async function fetchSessionTimeline(sessionId: string, limit = 200): Promise<{ items: SessionTimelineItem[] }> {
  return request<{ items: SessionTimelineItem[] }>(
    `/api/v1/sessions/${encodeURIComponent(sessionId)}/timeline?limit=${Math.max(1, Math.min(limit, 1000))}`,
  );
}

export async function fetchRuntimeLifecycle(input: {
  sessionId?: string;
  turnId?: string;
  runId?: string;
  approvalId?: string;
  taskId?: string;
}): Promise<RuntimeLifecycleResponse> {
  const query = new URLSearchParams();
  if (input.sessionId) query.set("sessionId", input.sessionId);
  if (input.turnId) query.set("turnId", input.turnId);
  if (input.runId) query.set("runId", input.runId);
  if (input.approvalId) query.set("approvalId", input.approvalId);
  if (input.taskId) query.set("taskId", input.taskId);
  return request<RuntimeLifecycleResponse>(`/api/v1/runtime/lifecycle?${query.toString()}`);
}

export async function fetchRuntimeLifecycleExport(input: {
  sessionId?: string;
  turnId?: string;
  runId?: string;
  approvalId?: string;
  taskId?: string;
  includeTranscript?: boolean;
  includeTimeline?: boolean;
  timelineLimit?: number;
  format?: "bundle" | "trust_report";
}): Promise<RuntimeLifecycleExportBundle> {
  const query = new URLSearchParams();
  if (input.sessionId) query.set("sessionId", input.sessionId);
  if (input.turnId) query.set("turnId", input.turnId);
  if (input.runId) query.set("runId", input.runId);
  if (input.approvalId) query.set("approvalId", input.approvalId);
  if (input.taskId) query.set("taskId", input.taskId);
  if (input.includeTranscript !== undefined) query.set("includeTranscript", String(input.includeTranscript));
  if (input.includeTimeline !== undefined) query.set("includeTimeline", String(input.includeTimeline));
  if (input.timelineLimit !== undefined) {
    query.set("timelineLimit", String(Math.max(1, Math.min(input.timelineLimit, 1000))));
  }
  if (input.format) query.set("format", input.format);
  return request<RuntimeLifecycleExportBundle>(`/api/v1/runtime/lifecycle/export?${query.toString()}`);
}
