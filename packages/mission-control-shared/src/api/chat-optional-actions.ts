import type {
  ChatDelegateRequest, ChatDelegateResponse, ChatDelegateSuggestRequest, ChatDelegateSuggestResponse,
  ChatMode, ChatGeneratedArtifactSourceSurface, ProactiveRunRecord, ResearchSummaryRecord,
  DelegatedFilesystemScopePublicProjection,
} from "@goatcitadel/contracts";
import { createCorrelationId } from "../state/dev-diagnostics-store";
import { request, buildGatewayUrl, buildGatewayHeaders, handleGatewayAuthRejectionResponse } from "./client-core.js";
import { iterateSsePayloads, parseSseJson } from "./streaming.js";

// Same pure surface normalization as mandatory Chat; transport remains client-core/streaming-owned.
interface ChatRequestSurfaceOptions {
  originSurface?: ChatMode;
}

function originSurfaceHeader(options?: ChatRequestSurfaceOptions): HeadersInit | undefined {
  return options?.originSurface
    ? { "x-goatcitadel-origin-surface": normalizeChatSurface(options.originSurface) }
    : undefined;
}

function originSurfaceInit(options?: ChatRequestSurfaceOptions): Pick<RequestInit, "headers"> {
  const headers = originSurfaceHeader(options);
  return headers ? { headers } : {};
}

function normalizeChatSurface(_surface?: ChatMode | ChatGeneratedArtifactSourceSurface | null): "chat" {
  return "chat";
}

export type ChatDelegationStreamScopeControl = DelegatedFilesystemScopePublicProjection;

export interface ChatDelegationStreamChunk {
  type: "status" | "step" | "done" | "error";
  runId?: string;
  taskId?: string;
  message?: string;
  step?: {
    stepId: string;
    runId: string;
    role: string;
    label?: string;
    status: string;
    index: number;
    startedAt: string;
    finishedAt?: string;
    durationMs?: number;
    summary?: string;
    output?: string;
    error?: string;
    failureGuidance?: string;
    /** Public delegated-scope projection; canonical host paths stay Gateway-owned. */
    scopeControl?: ChatDelegationStreamScopeControl;
  };
  result?: ChatDelegateResponse;
  error?: string;
}

export async function runChatDelegation(sessionId: string, input: ChatDelegateRequest): Promise<ChatDelegateResponse> {
  return request<ChatDelegateResponse>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/delegate`, {
    method: "POST",
    ...originSurfaceInit({ originSurface: input.surfaceMode }),
    body: JSON.stringify(input),
  });
}

export async function runChatResearch(
  sessionId: string,
  input: {
    query: string;
    mode?: "quick" | "deep";
    providerId?: string;
    model?: string;
    policyRunId?: string;
    policyTaskId?: string;
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
    surface?: ChatMode;
  },
): Promise<ResearchSummaryRecord> {
  return request<ResearchSummaryRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/research/run`, {
    method: "POST",
    body: JSON.stringify(input),
  });
}

export async function streamChatDelegation(
  sessionId: string,
  input: ChatDelegateRequest,
  onChunk: (chunk: ChatDelegationStreamChunk) => void,
  options: { signal?: AbortSignal } = {},
): Promise<void> {
  const path = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/delegate/stream`;
  const correlationId = createCorrelationId();
  const response = await fetch(buildGatewayUrl(path), {
    method: "POST",
    headers: buildGatewayHeaders(path, "POST", correlationId, {
      "x-goatcitadel-session-id": sessionId,
      ...originSurfaceHeader({ originSurface: input.surfaceMode }),
    }),
    body: JSON.stringify(input),
    signal: options.signal,
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    handleGatewayAuthRejectionResponse(response.status, text, path);
    throw new Error(`API error ${response.status}: ${text}`);
  }
  let streamError: string | null = null;
  for await (const dataText of iterateSsePayloads(response.body)) {
    const chunk = parseSseJson<ChatDelegationStreamChunk>(dataText);
    onChunk(chunk);
    if (chunk.type === "error") {
      streamError = chunk.error || "Streaming request failed.";
    }
  }
  if (streamError) {
    throw new Error(streamError);
  }
}

export async function suggestChatDelegation(
  sessionId: string,
  input: ChatDelegateSuggestRequest = {},
): Promise<ChatDelegateSuggestResponse> {
  return request<ChatDelegateSuggestResponse>(
    `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/delegate/suggest`,
    {
      method: "POST",
      body: JSON.stringify(input),
    },
  );
}

export async function triggerChatProactive(
  sessionId: string,
  input?: {
    source?: "scheduler" | "manual" | "chat";
    reason?: string;
    surface?: ChatMode;
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
  },
): Promise<ProactiveRunRecord> {
  return request<ProactiveRunRecord>(`/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/proactive/trigger`, {
    method: "POST",
    body: JSON.stringify(input ?? {}),
  });
}
