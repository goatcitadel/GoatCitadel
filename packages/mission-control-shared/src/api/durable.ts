import type {
  ApprovalRequest,
  ChatStreamUsageRecord,
  DurableCheckpointRecord,
  DurableRunCreateRequest,
  DurableRunRecord,
  DurableRunTimelineEvent,
  DurableWakeResult,
  MemoryContextPack,
  RuntimeLifecycleResponse,
  RuntimeLifecycleTurnSummary,
  RuntimeLifecycleToolRunSummary,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export type RunTraceAvailabilityState = "available" | "not_available" | "unknown";

export interface ObserveRunTraceArtifact {
  artifactId: string;
  sessionId: string;
  workspaceId?: string;
  projectId?: string;
  turnId: string;
  title: string;
  kind: string;
  language?: string;
  sourceSurface: string;
  version: number;
  supersedesArtifactId?: string;
  providerId?: string;
  model?: string;
  sourceBlockIndex?: number;
  contentHash?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ObserveRunTraceError {
  source: "durable_run" | "checkpoint" | "timeline" | "turn" | "tool";
  id: string;
  message: string;
  createdAt?: string;
}

export interface ObserveRunTraceProviderUsageItem {
  turnId: string;
  sessionId: string;
  providerId?: string;
  model?: string;
  usage?: ChatStreamUsageRecord;
  latencyMs?: number;
  providerCallCount?: number;
  costUsd?: number;
  costSource?: string;
}

export interface ObserveRunTraceResponse {
  version: "observe.run_trace.v1";
  generatedAt: string;
  runId: string;
  run: DurableRunRecord;
  durable: {
    checkpoints: {
      state: RunTraceAvailabilityState;
      items: DurableCheckpointRecord[];
    };
    timeline: {
      state: RunTraceAvailabilityState;
      items: DurableRunTimelineEvent[];
    };
  };
  lifecycle: {
    state: RunTraceAvailabilityState;
    response?: RuntimeLifecycleResponse;
    error?: string;
  };
  session: {
    state: RunTraceAvailabilityState;
    item?: RuntimeLifecycleResponse["session"];
    summary?: RuntimeLifecycleResponse["sessionSummary"];
  };
  thread: {
    state: RunTraceAvailabilityState;
    turns: RuntimeLifecycleTurnSummary[];
  };
  approvals: {
    state: RunTraceAvailabilityState;
    items: ApprovalRequest[];
    missingIds: string[];
  };
  toolCalls: {
    state: RunTraceAvailabilityState;
    items: RuntimeLifecycleToolRunSummary[];
  };
  memoryContext: {
    state: RunTraceAvailabilityState;
    items: MemoryContextPack[];
    error?: string;
  };
  providerUsage: {
    state: RunTraceAvailabilityState;
    items: ObserveRunTraceProviderUsageItem[];
    totals: {
      inputTokens?: number;
      outputTokens?: number;
      cachedInputTokens?: number;
      costUsd?: number;
    };
  };
  artifacts: {
    state: RunTraceAvailabilityState;
    items: ObserveRunTraceArtifact[];
    error?: string;
  };
  errors: {
    state: RunTraceAvailabilityState;
    items: ObserveRunTraceError[];
  };
  posture: {
    readOnly: true;
    sideEffectPosture: "audit_only";
    audit: {
      state: "available";
      note: string;
    };
    replay: {
      state: RunTraceAvailabilityState;
      checkpointIds: string[];
      note: string;
    };
    resume: {
      state: RunTraceAvailabilityState;
      eligible: boolean;
      endpoint?: string;
      note: string;
    };
  };
}

export interface ObserveRunTraceExportResponse {
  version: "observe.run_trace_export.v1";
  generatedAt: string;
  runId: string;
  format: "json";
  contentType: "application/json";
  filename: string;
  sourceEndpoint: string;
  posture: {
    readOnly: true;
    sideEffectPosture: "audit_only";
    note: string;
  };
  trace: ObserveRunTraceResponse;
  content: string;
}

export async function createDurableRun(input: DurableRunCreateRequest): Promise<DurableRunRecord> {
  return request<DurableRunRecord>("/api/v1/durable/runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchDurableRun(runId: string): Promise<DurableRunRecord> {
  return request<DurableRunRecord>(`/api/v1/durable/runs/${encodeURIComponent(runId)}`);
}

export async function fetchObserveRunTrace(runId: string): Promise<ObserveRunTraceResponse> {
  return request<ObserveRunTraceResponse>(`/api/v1/observe/runs/${encodeURIComponent(runId)}/trace`);
}

export async function exportObserveRunTrace(runId: string): Promise<ObserveRunTraceExportResponse> {
  return request<ObserveRunTraceExportResponse>(`/api/v1/observe/runs/${encodeURIComponent(runId)}/trace/export`);
}

export async function fetchDurableRunTimeline(
  runId: string,
  limit = 300,
): Promise<{ items: DurableRunTimelineEvent[] }> {
  return request<{ items: DurableRunTimelineEvent[] }>(
    `/api/v1/durable/runs/${encodeURIComponent(runId)}/timeline?limit=${Math.max(1, Math.min(limit, 2000))}`,
  );
}

export async function pauseDurableRun(runId: string, actorId?: string): Promise<DurableRunRecord> {
  return request<DurableRunRecord>(`/api/v1/durable/runs/${encodeURIComponent(runId)}/pause`, {
    method: "POST",
    body: JSON.stringify({ actorId }),
  });
}

export async function resumeDurableRun(runId: string, actorId?: string): Promise<DurableRunRecord> {
  return request<DurableRunRecord>(`/api/v1/durable/runs/${encodeURIComponent(runId)}/resume`, {
    method: "POST",
    body: JSON.stringify({ actorId }),
  });
}

export async function cancelDurableRun(runId: string, actorId?: string): Promise<DurableRunRecord> {
  return request<DurableRunRecord>(`/api/v1/durable/runs/${encodeURIComponent(runId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ actorId }),
  });
}

export async function retryDurableRun(
  runId: string,
  input?: { reason?: string; actorId?: string },
): Promise<DurableRunRecord> {
  return request<DurableRunRecord>(`/api/v1/durable/runs/${encodeURIComponent(runId)}/retry`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}

export async function wakeDurableRun(
  runId: string,
  input: { eventKey: string; payload?: Record<string, unknown>; correlationId?: string },
): Promise<DurableWakeResult> {
  return request<DurableWakeResult>(`/api/v1/durable/runs/${encodeURIComponent(runId)}/events/wake`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function recoverDurableDeadLetter(entryId: string, actorId?: string): Promise<DurableRunRecord> {
  return request<DurableRunRecord>(`/api/v1/durable/dead-letters/${encodeURIComponent(entryId)}/recover`, {
    method: "POST",
    body: JSON.stringify({ actorId }),
  });
}
