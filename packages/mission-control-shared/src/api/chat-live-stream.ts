import type { ChatMode, ChatSendMessageRequest, ChatStreamChunk } from "@goatcitadel/contracts";
import { createCorrelationId, recordClientDiagnostic } from "../state/dev-diagnostics-store";
import { buildGatewayHeaders, buildGatewayUrl, handleGatewayAuthRejectionResponse } from "./client-core.js";
import { originSurfaceHeader } from "./chat-request-surface.js";
import { consumeSseResponse } from "./streaming.js";

export async function streamAgentChatMessage(
  sessionId: string,
  input: ChatSendMessageRequest,
  onChunk: (chunk: ChatStreamChunk) => void,
  options: { signal?: AbortSignal; originSurface?: ChatMode } = {},
): Promise<void> {
  const path = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/agent-send/stream`;
  const correlationId = createCorrelationId();
  recordClientDiagnostic({
    level: "info",
    category: "chat",
    event: "stream.start",
    message: "Agent chat stream started",
    correlationId,
    sessionId,
    route: path,
  });
  // Every `stream.start` must have a matching terminal event so the diagnostics
  // timeline never shows an orphaned start. A user cancel / transport drop throws
  // an AbortError, and a non-ok response throws after emitting its own
  // `stream.error`; the try/catch below records the terminal event for the paths
  // that would otherwise escape (consume-time abort, transport failure) without
  // double-recording the non-ok case.
  let terminalRecorded = false;
  try {
    const response = await fetch(buildGatewayUrl(path), {
      method: "POST",
      signal: options.signal,
      headers: buildGatewayHeaders(path, "POST", correlationId, {
        "x-goatcitadel-session-id": sessionId,
        ...originSurfaceHeader(options),
      }),
      body: JSON.stringify(input),
    });
    if (!response.ok || !response.body) {
      const text = await response.text();
      handleGatewayAuthRejectionResponse(response.status, text, path);
      recordClientDiagnostic({
        level: "error",
        category: "chat",
        event: "stream.error",
        message: `Agent chat stream failed (${response.status})`,
        correlationId,
        sessionId,
        route: path,
        context: { status: response.status, body: text.slice(0, 600) },
      });
      terminalRecorded = true;
      throw new Error(`API error ${response.status}: ${text}`);
    }
    await consumeSseResponse(
      response.body,
      (chunk) => {
        if (chunk.type === "error") {
          recordClientDiagnostic({
            level: "error",
            category: "chat",
            event: "stream.chunk_error",
            message: "Agent chat stream emitted an error chunk",
            correlationId,
            sessionId,
            route: path,
            turnId: chunk.turnId,
          });
        }
        onChunk(chunk);
      },
      options.signal,
    );
    recordClientDiagnostic({
      level: "info",
      category: "chat",
      event: "stream.complete",
      message: "Agent chat stream completed",
      correlationId,
      sessionId,
      route: path,
    });
  } catch (error) {
    if (!terminalRecorded) {
      recordStreamTerminalFailure({ error, correlationId, sessionId, route: path });
    }
    throw error;
  }
}

/**
 * Records the terminal diagnostic for a chat stream that ended without a
 * `stream.complete` — `stream.aborted` for a user cancel / transport drop
 * (AbortError) and `stream.error` for any other failure. Pairs every
 * `stream.start` with a terminal event in the diagnostics timeline.
 */
function recordStreamTerminalFailure(input: {
  error: unknown;
  correlationId: string;
  sessionId: string;
  route: string;
}): void {
  const { error, correlationId, sessionId, route } = input;
  if (isStreamAbortError(error)) {
    recordClientDiagnostic({
      level: "info",
      category: "chat",
      event: "stream.aborted",
      message: "Agent chat stream aborted before completion",
      correlationId,
      sessionId,
      route,
    });
    return;
  }
  recordClientDiagnostic({
    level: "error",
    category: "chat",
    event: "stream.error",
    message: error instanceof Error ? `Agent chat stream errored: ${error.message}` : "Agent chat stream errored",
    correlationId,
    sessionId,
    route,
  });
}

function isStreamAbortError(error: unknown): boolean {
  if (typeof DOMException === "function" && error instanceof DOMException) {
    return error.name === "AbortError";
  }
  return (
    typeof error === "object" && error !== null && "name" in error && (error as { name?: string }).name === "AbortError"
  );
}

export async function streamRetryChatTurn(
  sessionId: string,
  turnId: string,
  input: Partial<ChatSendMessageRequest>,
  onChunk: (chunk: ChatStreamChunk) => void,
  options: { signal?: AbortSignal; originSurface?: ChatMode } = {},
): Promise<void> {
  const path = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/retry/stream`;
  const correlationId = createCorrelationId();
  const response = await fetch(buildGatewayUrl(path), {
    method: "POST",
    signal: options.signal,
    headers: buildGatewayHeaders(path, "POST", correlationId, {
      "x-goatcitadel-session-id": sessionId,
      ...originSurfaceHeader(options),
    }),
    body: JSON.stringify(input),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    handleGatewayAuthRejectionResponse(response.status, text, path);
    throw new Error(`API error ${response.status}: ${text}`);
  }
  await consumeSseResponse(response.body, onChunk, options.signal);
}

export async function streamEditChatTurn(
  sessionId: string,
  turnId: string,
  input: ChatSendMessageRequest,
  onChunk: (chunk: ChatStreamChunk) => void,
  options: { signal?: AbortSignal; originSurface?: ChatMode } = {},
): Promise<void> {
  const path = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/edit/stream`;
  const correlationId = createCorrelationId();
  const response = await fetch(buildGatewayUrl(path), {
    method: "POST",
    signal: options.signal,
    headers: buildGatewayHeaders(path, "POST", correlationId, {
      "x-goatcitadel-session-id": sessionId,
      ...originSurfaceHeader(options),
    }),
    body: JSON.stringify(input),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    handleGatewayAuthRejectionResponse(response.status, text, path);
    throw new Error(`API error ${response.status}: ${text}`);
  }
  await consumeSseResponse(response.body, onChunk, options.signal);
}

export async function resumeChatTurnStream(
  sessionId: string,
  turnId: string,
  onChunk: (chunk: ChatStreamChunk) => void,
  options: { signal?: AbortSignal; sinceEventId?: string; originSurface?: ChatMode } = {},
): Promise<void> {
  const query = new URLSearchParams();
  if (options.sinceEventId) {
    query.set("sinceEventId", options.sinceEventId);
  }
  const path = `/api/v1/chat/sessions/${encodeURIComponent(sessionId)}/turns/${encodeURIComponent(turnId)}/stream${query.size > 0 ? `?${query.toString()}` : ""}`;
  const correlationId = createCorrelationId();
  const response = await fetch(buildGatewayUrl(path), {
    method: "GET",
    signal: options.signal,
    headers: buildGatewayHeaders(path, "GET", correlationId, {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      "x-goatcitadel-session-id": sessionId,
      ...(options.sinceEventId ? { "Last-Event-ID": options.sinceEventId } : {}),
      ...originSurfaceHeader(options),
    }),
  });
  if (!response.ok || !response.body) {
    const text = await response.text();
    handleGatewayAuthRejectionResponse(response.status, text, path);
    throw new Error(`API error ${response.status}: ${text}`);
  }
  await consumeSseResponse(response.body, onChunk, options.signal);
}
