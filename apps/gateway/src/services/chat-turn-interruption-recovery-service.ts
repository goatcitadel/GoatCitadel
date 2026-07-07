/**
 * Boot-time reconciliation for chat turns interrupted by a gateway death.
 *
 * When the gateway process dies mid-turn (dev-supervisor restart, crash, kill),
 * the in-flight turn leaves one of two runtime-truth gaps behind:
 *
 *   1. a chat_turn_traces row stuck in a non-terminal status that nothing will
 *      ever finalize (the executing background task died with the process), or
 *   2. no trace row at all — the user message persisted but the process died
 *      before the turn trace was created, so the turn is invisible to the
 *      thread (buildChatThreadResponse only renders turns that have a trace).
 *
 * On boot this reconciler converts both gaps into an honest, retryable
 * `interrupted_by_restart` failure trace so Mission Control can render
 * "interrupted — retry?" instead of a raw stream/network error. Turns owned by
 * a still-live durable run are skipped: durable boot recovery resumes or fails
 * those itself (see durable-run-service performBootRecovery).
 */

import { randomUUID } from "node:crypto";
import { isDurableRunTerminal, NotFoundError } from "@goatcitadel/contracts";
import type {
  ChatMode,
  ChatTurnFailureRecord,
  ChatTurnTraceRecord,
  DurableRunRecord,
  RealtimeEvent,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { buildChatTurnRealtimeOptions } from "./chat-turn-realtime.js";

export const INTERRUPTED_BY_RESTART_MESSAGE =
  "The gateway restarted while this turn was in flight, so the turn never finished.";

export interface ChatTurnInterruptionRecoveryDeps {
  storage: Pick<
    Storage,
    "chatTurnTraces" | "chatTurnRecovery" | "chatSessionPrefs" | "chatSessionBranchState" | "durableRuns"
  >;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): unknown;
  recordDevDiagnostic(input: {
    level: "info" | "warn";
    category: "chat";
    event: string;
    message: string;
    sessionId?: string;
    turnId?: string;
    context?: Record<string, unknown>;
  }): void;
  now?: () => string;
}

export interface ChatTurnInterruptionRecoveryResult {
  /** Existing non-terminal traces patched to a failed interrupted_by_restart state. */
  interruptedTurnIds: string[];
  /** Traces synthesized for orphaned user messages that had no trace at all. */
  synthesizedTurnIds: string[];
  /** Active traces left untouched because a live durable run still owns them. */
  skippedDurableOwnedTurnIds: string[];
}

export function reconcileInterruptedChatTurns(
  deps: ChatTurnInterruptionRecoveryDeps,
): ChatTurnInterruptionRecoveryResult {
  const now = deps.now ? deps.now() : new Date().toISOString();
  const result: ChatTurnInterruptionRecoveryResult = {
    interruptedTurnIds: [],
    synthesizedTurnIds: [],
    skippedDurableOwnedTurnIds: [],
  };

  for (const trace of deps.storage.chatTurnTraces.listActive()) {
    if (isOwnedByLiveDurableRun(deps, trace)) {
      result.skippedDurableOwnedTurnIds.push(trace.turnId);
      continue;
    }
    deps.storage.chatTurnTraces.patch(trace.turnId, {
      status: "failed",
      failure: buildInterruptedByRestartFailure(),
      completion: {
        finishReason: trace.completion?.finishReason,
        status: "interrupted",
        repaired: Boolean(trace.completion?.repaired),
      },
      finishedAt: now,
    });
    result.interruptedTurnIds.push(trace.turnId);
    announceInterruptedTurn(deps, trace.sessionId, trace.turnId, "chat.turn.interrupted_by_restart", {
      previousStatus: trace.status,
    });
  }

  for (const orphan of deps.storage.chatTurnRecovery.listOrphanedLatestUserMessages()) {
    const turnId = synthesizeInterruptedTrace(deps, orphan, now);
    result.synthesizedTurnIds.push(turnId);
    announceInterruptedTurn(deps, orphan.sessionId, turnId, "chat.turn.interrupted_by_restart_synthesized", {
      userMessageId: orphan.messageId,
    });
  }

  return result;
}

function isOwnedByLiveDurableRun(deps: ChatTurnInterruptionRecoveryDeps, trace: ChatTurnTraceRecord): boolean {
  const runId = trace.durable?.runId;
  if (!runId) {
    return false;
  }
  let run: DurableRunRecord;
  try {
    run = deps.storage.durableRuns.getRun(runId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return false;
    }
    throw error;
  }
  return !isDurableRunTerminal(run.status);
}

function buildInterruptedByRestartFailure(): ChatTurnFailureRecord {
  return {
    failureClass: "interrupted_by_restart",
    message: INTERRUPTED_BY_RESTART_MESSAGE,
    retryable: true,
    recommendedAction: "retry",
  };
}

/**
 * Create a failed trace for a user message whose turn died before any trace
 * was written. Mirrors the trace reconstruction in chat-turn-cancellation.ts:
 * modes come from session prefs with the same defaults, and the turn is
 * appended under the session's current active leaf so the thread renders it
 * where the vanished turn would have appeared.
 */
function synthesizeInterruptedTrace(
  deps: ChatTurnInterruptionRecoveryDeps,
  orphan: { sessionId: string; messageId: string; timestamp: string },
  now: string,
): string {
  const prefs = deps.storage.chatSessionPrefs.get(orphan.sessionId);
  const parentTurnId = deps.storage.chatSessionBranchState.get(orphan.sessionId)?.activeLeafTurnId;
  const mode: ChatMode = prefs?.mode ?? "chat";
  const turnId = randomUUID();
  deps.storage.chatTurnTraces.create({
    turnId,
    sessionId: orphan.sessionId,
    userMessageId: orphan.messageId,
    parentTurnId,
    status: "failed",
    mode,
    model: prefs?.model,
    webMode: prefs?.webMode ?? "auto",
    memoryMode: prefs?.memoryMode ?? "auto",
    thinkingLevel: prefs?.thinkingLevel ?? "standard",
    speedMode: prefs?.speedMode,
    subagentPolicy: prefs?.subagentPolicy,
    effectiveToolAutonomy: prefs?.toolAutonomy,
    routing: {},
    failure: buildInterruptedByRestartFailure(),
    completion: {
      status: "interrupted",
      repaired: false,
    },
    startedAt: orphan.timestamp,
    finishedAt: now,
  });
  // Best-effort leaf advance so the interrupted turn sits on the selected
  // path. The compare-and-set only wins when the leaf still points at the
  // parent we appended under; on conflict the trace still exists as a branch.
  deps.storage.chatSessionBranchState.setActiveLeafIfCurrent(orphan.sessionId, parentTurnId, turnId, now);
  return turnId;
}

function announceInterruptedTurn(
  deps: ChatTurnInterruptionRecoveryDeps,
  sessionId: string,
  turnId: string,
  event: string,
  context: Record<string, unknown>,
): void {
  deps.recordDevDiagnostic({
    level: "warn",
    category: "chat",
    event,
    message: INTERRUPTED_BY_RESTART_MESSAGE,
    sessionId,
    turnId,
    context,
  });
  deps.publishRealtime(
    "chat_thread_updated",
    "chat",
    {
      type: "chat_thread_turn_interrupted",
      sessionId,
      turnId,
    },
    buildChatTurnRealtimeOptions({ sessionId, turnId }),
  );
}
