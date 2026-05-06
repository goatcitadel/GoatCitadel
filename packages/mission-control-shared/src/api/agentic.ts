import type {
  AgenticControlRequest,
  AgenticControlResponse,
  AgenticRunListItem,
  AgenticRuntimeAvailabilityResponse,
  AgenticRunStatus,
  AgenticRunTreeResponse,
  AgenticSurface,
} from "@goatcitadel/contracts";

import { request } from "./client-core.js";

export type {
  AgenticControlAction,
  AgenticControlDescriptor,
  AgenticControlRequest,
  AgenticControlResponse,
  AgenticDiagnosticSignal,
  AgenticRunListItem,
  AgenticRunStatus,
  AgenticRunTreeEdge,
  AgenticRunTreeNode,
  AgenticRunTreeResponse,
  AgenticRuntimeAvailabilityResponse,
  AgenticSurface,
  AgenticTaskContext,
} from "@goatcitadel/contracts";

export interface FetchAgenticRunsInput {
  surface?: AgenticSurface;
  sessionId?: string;
  boardId?: string;
  parentRunId?: string;
  status?: AgenticRunStatus;
  limit?: number;
  cursor?: string;
}

export interface AgenticRunsResponse {
  items: AgenticRunListItem[];
  nextCursor?: string;
}

export type AgenticChannelDeliveryRuntimeStatus = "queued" | "running" | "retrying" | "sent" | "failed" | "stale";

export interface AgenticChannelDeliveryRuntimeRecord {
  deliveryId: string;
  connectionId?: string;
  channelKey: string;
  target: string;
  status: AgenticChannelDeliveryRuntimeStatus;
  deliveryStatus?: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt?: string;
  staleReason?: string;
  providerMessageId?: string;
  error?: string;
  fallbackReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgenticChannelDeliveriesResponse {
  deliveries: AgenticChannelDeliveryRuntimeRecord[];
  count: number;
}

export interface FetchAgenticChannelDeliveriesInput {
  connectionId?: string;
  limit?: number;
}

export async function fetchAgenticRuntimeAvailability(): Promise<AgenticRuntimeAvailabilityResponse> {
  return request<AgenticRuntimeAvailabilityResponse>("/api/v1/agentic/availability");
}

export async function fetchAgenticChannelDeliveries(
  input: FetchAgenticChannelDeliveriesInput = {},
): Promise<AgenticChannelDeliveriesResponse> {
  const query = new URLSearchParams();
  if (input.connectionId) query.set("connectionId", input.connectionId);
  query.set("limit", String(input.limit ?? 50));
  return request<AgenticChannelDeliveriesResponse>(`/api/v1/comms/deliveries?${query.toString()}`);
}

export async function fetchAgenticRuns(input: FetchAgenticRunsInput = {}): Promise<AgenticRunsResponse> {
  const query = new URLSearchParams();
  if (input.surface) query.set("surface", input.surface);
  if (input.sessionId) query.set("sessionId", input.sessionId);
  if (input.boardId) query.set("boardId", input.boardId);
  if (input.parentRunId) query.set("parentRunId", input.parentRunId);
  if (input.status) query.set("status", input.status);
  if (input.cursor) query.set("cursor", input.cursor);
  query.set("limit", String(input.limit ?? 100));
  return request<AgenticRunsResponse>(`/api/v1/agentic/runs?${query.toString()}`);
}

export async function fetchAgenticRunTree(runId: string): Promise<AgenticRunTreeResponse> {
  return request<AgenticRunTreeResponse>(`/api/v1/agentic/runs/${encodeURIComponent(runId)}/tree`);
}

export async function controlAgenticRun(runId: string, input: AgenticControlRequest): Promise<AgenticControlResponse> {
  return request<AgenticControlResponse>(`/api/v1/agentic/runs/${encodeURIComponent(runId)}/control`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}
