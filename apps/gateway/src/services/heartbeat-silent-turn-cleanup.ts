import { NotFoundError, type RealtimeEvent } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { GatewayDevDiagnosticsService } from "../dev-diagnostics/service.js";
import type { SilentHeartbeatCleanupRequest, SilentHeartbeatCleanupResult } from "./durable-execution-service.js";

interface SilentHeartbeatCleanupDeps {
  storage: Pick<AsyncStorage, "runImmediateTransaction" | "chatMessages" | "chatTurnTraces" | "chatSessionBranchState">;
  recordDevDiagnostic(input: Parameters<GatewayDevDiagnosticsService["record"]>[0]): void;
  publishRealtime(
    event: "chat_thread_updated",
    source: "chat",
    payload: Record<string, unknown>,
    options: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links">,
  ): Promise<unknown>;
}

/**
 * Prune a silent heartbeat turn from a human transcript (P1-F4 invisibility).
 * Removes the seed user message + `{notify:false}` assistant message and the
 * turn trace, reverting the active branch leaf to the pre-heartbeat leaf, in a
 * single transaction (mirroring the undo path). Returns explicit recovery
 * truth so retryable storage failures remain pending while an advanced branch
 * becomes operator-visible manual reconciliation instead of being rewound.
 */
export async function cleanupSilentHeartbeatTurn(
  deps: SilentHeartbeatCleanupDeps,
  input: SilentHeartbeatCleanupRequest,
): Promise<SilentHeartbeatCleanupResult> {
  let removed = false;
  let resolution: SilentHeartbeatCleanupResult = { status: "already_completed" };
  try {
    const messageIds = [input.userMessageId, input.assistantMessageId].filter(
      (id): id is string => typeof id === "string" && id.trim().length > 0,
    );
    await deps.storage.runImmediateTransaction(async () => {
      const activeLeafTurnId = (await deps.storage.chatSessionBranchState.get(input.sessionId))?.activeLeafTurnId;
      let hasMessages = false;
      for (const messageId of messageIds) {
        try {
          await deps.storage.chatMessages.get(messageId);
          hasMessages = true;
          break;
        } catch (error) {
          if (!(error instanceof NotFoundError)) {
            throw error;
          }
        }
      }
      let hasTrace = true;
      try {
        await deps.storage.chatTurnTraces.get(input.turnId);
      } catch (error) {
        if (error instanceof NotFoundError) {
          hasTrace = false;
        } else {
          throw error;
        }
      }
      if (!hasMessages && !hasTrace) {
        return;
      }
      if (activeLeafTurnId !== input.turnId) {
        resolution = {
          status: "manual_reconciliation",
          reason:
            `Silent heartbeat ${input.turnId} was retained because the active leaf advanced to ` +
            `${activeLeafTurnId ?? "none"}; automatic cleanup would corrupt newer branch truth.`,
        };
        return;
      }
      await deps.storage.chatMessages.deleteByMessageIds(input.sessionId, messageIds);
      await deps.storage.chatTurnTraces.deleteByTurnIds(input.sessionId, [input.turnId]);
      if (input.parentTurnId) {
        const reverted = await deps.storage.chatSessionBranchState.setActiveLeafIfCurrent(
          input.sessionId,
          input.turnId,
          input.parentTurnId,
          new Date().toISOString(),
        );
        if (!reverted) {
          throw new Error(`Silent heartbeat ${input.turnId} lost active-leaf ownership during cleanup.`);
        }
      } else {
        await deps.storage.chatSessionBranchState.clear(input.sessionId);
      }
      removed = true;
      resolution = { status: "completed" };
    });
  } catch (error) {
    deps.recordDevDiagnostic({
      level: "warn",
      category: "chat",
      event: "chat.heartbeat.cleanup_failed",
      message: "Failed to prune a silent heartbeat turn from the transcript.",
      sessionId: input.sessionId,
      turnId: input.turnId,
      context: { error: error instanceof Error ? error.message : String(error) },
    });
    return {
      status: "retryable_failure",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  if (!removed) {
    return resolution;
  }
  try {
    await deps.publishRealtime(
      "chat_thread_updated",
      "chat",
      {
        type: "chat_thread_undone",
        sessionId: input.sessionId,
        removedTurnIds: [input.turnId],
        ...(input.parentTurnId ? { activeLeafTurnId: input.parentTurnId } : {}),
        reason: "silent_heartbeat",
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          sessionId: input.sessionId,
          ...(input.parentTurnId ? { turnId: input.parentTurnId } : {}),
        },
      },
    );
  } catch (error) {
    deps.recordDevDiagnostic({
      level: "warn",
      category: "chat",
      event: "chat.heartbeat.cleanup_projection_failed",
      message: "Silent heartbeat cleanup committed, but its realtime projection failed.",
      sessionId: input.sessionId,
      turnId: input.turnId,
      context: { error: error instanceof Error ? error.message : String(error) },
    });
  }
  return { status: "completed" };
}
