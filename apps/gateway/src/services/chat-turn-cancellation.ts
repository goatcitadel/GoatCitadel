/**
 * Chat-turn cancellation semantics, extracted from GatewayService (B3b).
 *
 * Cancellation must succeed even when the turn's trace row was never created
 * (a durable stream cancelled before its initial trace persisted): the
 * recovery path reconstructs a "running" trace from the active stream's
 * durable payload so the cancel patch has a row to land on.
 */

import { isChatTurnTerminalStatus, NotFoundError } from "@goatcitadel/contracts";
import type { ChatMode, ChatTurnTraceRecord, DurableRunRecord, RealtimeEvent } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { ActiveChatTurnStreamExecution } from "./chat-turn-execution-registry.js";
import type { DurableChatTurnExecutionPayload } from "./chat-turn-types.js";

export interface ChatTurnCancellationDeps {
  storage: Pick<Storage, "chatTurnTraces" | "durableRuns" | "chatSessionPrefs">;
  getActiveChatTurnStream(turnId: string): ActiveChatTurnStreamExecution | undefined;
  parseDurableChatTurnPayload(run: DurableRunRecord): DurableChatTurnExecutionPayload | undefined;
  createHydratedChatTurnTrace(turnId: string, trace: ChatTurnTraceRecord): ChatTurnTraceRecord;
  recordDevDiagnostic(input: {
    level: "info";
    category: "chat";
    event: string;
    message: string;
    sessionId?: string;
    turnId?: string;
    context?: Record<string, unknown>;
  }): void;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): RealtimeEvent;
}

export function markChatTurnCancelled(
  deps: ChatTurnCancellationDeps,
  sessionId: string,
  turnId: string,
  cancelledBy?: string,
): ChatTurnTraceRecord {
  let current: ChatTurnTraceRecord;
  try {
    current = deps.storage.chatTurnTraces.get(turnId);
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
    const recovered = createRunningTraceForActiveStreamCancellation(deps, sessionId, turnId);
    if (!recovered) {
      throw error;
    }
    current = recovered;
  }
  if (current.sessionId !== sessionId) {
    throw new Error(`Chat turn ${turnId} does not belong to session ${sessionId}`);
  }
  if (current.status === "cancelled") {
    return deps.createHydratedChatTurnTrace(turnId, current);
  }
  if (isChatTurnTerminalStatus(current.status)) {
    return deps.createHydratedChatTurnTrace(turnId, current);
  }
  const trace = deps.storage.chatTurnTraces.patch(turnId, {
    status: "cancelled",
    failure: undefined,
    completion: {
      finishReason: current.completion?.finishReason,
      status: "interrupted",
      repaired: Boolean(current.completion?.repaired),
    },
    finishedAt: new Date().toISOString(),
  });
  deps.recordDevDiagnostic({
    level: "info",
    category: "chat",
    event: "chat.turn.cancelled",
    message: "Cancelled active chat turn",
    sessionId,
    turnId,
    context: {
      cancelledBy,
    },
  });
  deps.publishRealtime(
    "chat_thread_updated",
    "chat",
    {
      type: "chat_thread_turn_cancelled",
      sessionId,
      turnId,
    },
    {
      eventClass: "operational_signal",
      eventAuthority: "retained_stream",
      links: {
        sessionId,
        turnId,
      },
    },
  );
  return deps.createHydratedChatTurnTrace(turnId, trace);
}

function createRunningTraceForActiveStreamCancellation(
  deps: ChatTurnCancellationDeps,
  sessionId: string,
  turnId: string,
): ChatTurnTraceRecord | undefined {
  const activeStream = deps.getActiveChatTurnStream(turnId);
  if (!activeStream || activeStream.sessionId !== sessionId || !activeStream.runId) {
    return undefined;
  }
  let run: DurableRunRecord;
  try {
    run = deps.storage.durableRuns.getRun(activeStream.runId);
  } catch {
    return undefined;
  }
  const payload = deps.parseDurableChatTurnPayload(run);
  if (!payload || payload.sessionId !== sessionId || payload.turnId !== turnId) {
    return undefined;
  }
  const prefs = deps.storage.chatSessionPrefs.get(sessionId);
  const request = payload.request;
  const mode: ChatMode = request.mode ?? request.prefsOverride?.mode ?? prefs?.mode ?? "chat";
  return deps.storage.chatTurnTraces.create({
    turnId,
    sessionId,
    userMessageId: payload.userMessageId,
    parentTurnId: payload.parentTurnId,
    branchKind: payload.branchKind,
    sourceTurnId: payload.sourceTurnId,
    status: "running",
    mode,
    model: request.model ?? prefs?.model,
    webMode: request.webMode ?? request.prefsOverride?.webMode ?? prefs?.webMode ?? "auto",
    memoryMode: request.memoryMode ?? request.prefsOverride?.memoryMode ?? prefs?.memoryMode ?? "auto",
    thinkingLevel: request.thinkingLevel ?? request.prefsOverride?.thinkingLevel ?? prefs?.thinkingLevel ?? "standard",
    speedMode: request.speedMode ?? request.prefsOverride?.speedMode ?? prefs?.speedMode,
    subagentPolicy: request.subagentPolicy ?? request.prefsOverride?.subagentPolicy ?? prefs?.subagentPolicy,
    effectiveToolAutonomy: request.prefsOverride?.toolAutonomy ?? prefs?.toolAutonomy,
    startedAt: activeStream.startedAt,
    routing: {
      primaryProviderId: request.providerId ?? prefs?.providerId,
      primaryModel: request.model ?? prefs?.model,
      effectiveProviderId: request.providerId ?? prefs?.providerId,
      effectiveModel: request.model ?? prefs?.model,
    },
    durable: {
      runId: activeStream.runId,
      status: run.status,
    },
  });
}
