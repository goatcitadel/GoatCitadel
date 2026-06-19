import { ConflictError, isChatTurnActiveStatus } from "@goatcitadel/contracts";
import type {
  ChatTurnTraceRecord,
  DevDiagnosticsCategory,
  DevDiagnosticsLevel,
  RealtimeEvent,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { buildSelectedPathTurnIds } from "./chat-thread-utils.js";
import { assertChatSessionActive } from "./chat-session-utils.js";
import type { ChatTurnSessionState } from "./chat-turn-prep-service.js";

export interface ChatTurnUndoResult {
  undoneCount: number;
  requestedCount: number;
  removedTurnIds: string[];
  removedMessageCount: number;
  activeLeafTurnId?: string;
}

export interface ChatTurnUndoDependencies {
  readonly storage: Pick<
    Storage,
    "chatMessages" | "chatSessionBranchState" | "chatSessionMeta" | "chatTurnTraces" | "runImmediateTransaction"
  >;
  getSession(sessionId: string): unknown;
  loadChatTurnSessionState(sessionId: string): Promise<ChatTurnSessionState>;
  publishRealtime(
    channel: string,
    topic: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): void;
  recordDevDiagnostic(input: {
    level: DevDiagnosticsLevel;
    category: DevDiagnosticsCategory | string;
    event: string;
    message: string;
    sessionId?: string;
    turnId?: string;
    context?: Record<string, unknown>;
  }): void;
  withChatTurnWriteLease<T>(sessionId: string, operation: string, work: () => Promise<T>): Promise<T>;
}

export async function undoChatTurns(
  deps: ChatTurnUndoDependencies,
  sessionId: string,
  count = 1,
  options: { operatorId?: string } = {},
): Promise<ChatTurnUndoResult> {
  // Validate that the session exists before taking the write lease.
  deps.getSession(sessionId);
  const safeCount = Math.max(1, Math.min(20, Math.floor(count)));
  return deps.withChatTurnWriteLease(sessionId, "chat.undo", async () => {
    // Re-validate the session lifecycle INSIDE the lease. The pre-lease
    // `getSession(sessionId)` check above only proves the session still exists, not that
    // it is still active: `archiveChatSession` leaves the session retrievable and merely
    // patches `lifecycleStatus: "archived"`. Without this re-check, an undo that wins the
    // write-lease race against a concurrent archive would still mutate the archived
    // session's turns. Mirror the send/prep path, which asserts the session is active via
    // `assertChatSessionActive(...)` (see chat-turn-prep-service.ts) before any write.
    const sessionMeta = deps.storage.chatSessionMeta.get(sessionId);
    if (sessionMeta) {
      assertChatSessionActive(sessionId, sessionMeta.lifecycleStatus);
    }

    const state = await deps.loadChatTurnSessionState(sessionId);
    if (!state.activeLeafTurnId) {
      return emptyUndoResult(safeCount);
    }

    const selectedPathTurnIds = buildSelectedPathTurnIds(state.turnLineageById, state.activeLeafTurnId);
    const removedTurnIds = selectedPathTurnIds.slice(-safeCount);
    const removedTraces = removedTurnIds
      .map((turnId) => state.tracesById.get(turnId))
      .filter((trace): trace is ChatTurnTraceRecord => Boolean(trace));
    if (removedTraces.length === 0) {
      // Lineage named turn ids but no trace records survived; treat the drift
      // as "undo nothing" while preserving the active leaf for diagnostics.
      return {
        ...emptyUndoResult(safeCount),
        activeLeafTurnId: state.activeLeafTurnId,
      };
    }

    const activeTrace = removedTraces.find((trace) => isChatTurnActiveStatus(trace.status));
    if (activeTrace) {
      throw new ConflictError({
        message: `Chat turn ${activeTrace.turnId} is ${activeTrace.status}; cancel or finish it before undoing.`,
      });
    }

    const remainingPathTurnIds = selectedPathTurnIds.slice(
      0,
      Math.max(0, selectedPathTurnIds.length - removedTurnIds.length),
    );
    const nextActiveLeafTurnId = remainingPathTurnIds.at(-1);
    const removedMessageIds = removedTraces.flatMap((trace) => [
      trace.userMessageId,
      ...(trace.assistantMessageId ? [trace.assistantMessageId] : []),
    ]);
    const now = new Date().toISOString();
    const mutation = deps.storage.runImmediateTransaction(() => {
      const removedMessageCount = deps.storage.chatMessages.deleteByMessageIds(sessionId, removedMessageIds);
      const removedTraceCount = deps.storage.chatTurnTraces.deleteByTurnIds(sessionId, removedTurnIds);
      if (nextActiveLeafTurnId) {
        deps.storage.chatSessionBranchState.setActiveLeaf(sessionId, nextActiveLeafTurnId, now);
      } else {
        deps.storage.chatSessionBranchState.clear(sessionId);
      }
      return { removedMessageCount, removedTraceCount };
    });

    deps.recordDevDiagnostic({
      level: "info",
      category: "chat",
      event: "chat.turns_undone",
      message: "Undid completed chat turns from the active session branch.",
      sessionId,
      turnId: nextActiveLeafTurnId,
      context: {
        requestedCount: safeCount,
        undoneCount: removedTraces.length,
        removedTurnIds,
        removedMessageCount: mutation.removedMessageCount,
        removedTraceCount: mutation.removedTraceCount,
        activeLeafTurnId: nextActiveLeafTurnId,
        operatorId: options.operatorId,
      },
    });
    deps.publishRealtime(
      "chat_thread_updated",
      "chat",
      {
        type: "chat_thread_undone",
        sessionId,
        requestedCount: safeCount,
        undoneCount: removedTraces.length,
        removedTurnIds,
        activeLeafTurnId: nextActiveLeafTurnId,
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          sessionId,
          ...(nextActiveLeafTurnId ? { turnId: nextActiveLeafTurnId } : {}),
        },
      },
    );

    return {
      undoneCount: removedTraces.length,
      requestedCount: safeCount,
      removedTurnIds,
      removedMessageCount: mutation.removedMessageCount,
      activeLeafTurnId: nextActiveLeafTurnId,
    };
  });
}

function emptyUndoResult(requestedCount: number): ChatTurnUndoResult {
  return {
    undoneCount: 0,
    requestedCount,
    removedTurnIds: [],
    removedMessageCount: 0,
  };
}
