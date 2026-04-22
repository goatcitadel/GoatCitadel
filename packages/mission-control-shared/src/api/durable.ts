import type {
  DurableRunCreateRequest,
  DurableRunRecord,
  DurableRunTimelineEvent,
  DurableWakeResult,
} from "@goatcitadel/contracts";
import { request } from "./client-core.js";

export async function createDurableRun(input: DurableRunCreateRequest): Promise<DurableRunRecord> {
  return request<DurableRunRecord>("/api/v1/durable/runs", {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function fetchDurableRun(runId: string): Promise<DurableRunRecord> {
  return request<DurableRunRecord>(`/api/v1/durable/runs/${encodeURIComponent(runId)}`);
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
