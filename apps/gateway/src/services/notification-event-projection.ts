import type { RealtimeEvent, NotifyRequest, ChatTurnTraceRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
const DEFAULT_WORKSPACE_ID = "default";
export interface NotificationEventProjectionHost {
  storage: Pick<AsyncStorage, "chatTurnTraces" | "chatSessionMeta" | "cronJobs">;
}
/** Notifications project canonical state; delivery never advances execution. */
export async function projectCanonicalNotificationEvent(
  host: NotificationEventProjectionHost,
  event: RealtimeEvent,
): Promise<
  | {
      workspaceId: string;
      input: Omit<NotifyRequest, "targetIds"> & { source: string; eventId: string };
    }
  | undefined
> {
  const type = typeof event.payload.type === "string" ? event.payload.type : "";
  if (event.eventType === "chat_thread_updated" && type === "chat_thread_turn_appended") {
    const sessionId = typeof event.payload.sessionId === "string" ? event.payload.sessionId : undefined;
    const turnId = typeof event.payload.turnId === "string" ? event.payload.turnId : undefined;
    if (!sessionId || !turnId) return undefined;
    let trace: ChatTurnTraceRecord;
    try {
      trace = await host.storage.chatTurnTraces.get(turnId);
    } catch {
      return undefined;
    }
    const eventType =
      trace.status === "waiting_for_approval"
        ? "approval.requested"
        : trace.status === "waiting_for_user_input"
          ? "user_input.requested"
          : trace.status === "failed" && trace.failure?.failureClass === "tool_blocked"
            ? "turn.blocked"
            : trace.status === "failed"
              ? "turn.failed"
              : trace.status === "completed" || trace.status === "partial"
                ? "turn.completed"
                : undefined;
    if (!eventType) return undefined;
    const titleByType = {
      "approval.requested": "Approval requested",
      "user_input.requested": "Input requested",
      "turn.blocked": "Chat turn blocked",
      "turn.failed": "Chat turn failed",
      "turn.completed": "Chat turn completed",
    } as const;
    return {
      workspaceId: (await host.storage.chatSessionMeta.get(sessionId))?.workspaceId ?? DEFAULT_WORKSPACE_ID,
      input: {
        eventId: `notification:${event.eventId}`,
        eventType,
        sessionId,
        turnId,
        title: titleByType[eventType],
        message:
          trace.failure?.message ??
          (await host.storage.chatSessionMeta.get(sessionId))?.title ??
          "A GoatCitadel Chat turn changed state.",
        source: "chat.turn",
      },
    };
  }
  if (
    event.eventType === "cron_job_run" &&
    (type === "cron_agent_turn_completed" || type === "cron_agent_turn_terminal")
  ) {
    const status = typeof event.payload.status === "string" ? event.payload.status : "failed";
    const eventType = status === "completed" ? "scheduled_turn.completed" : "scheduled_turn.failed";
    const jobId = typeof event.payload.jobId === "string" ? event.payload.jobId : undefined;
    const sessionId = jobId ? (await host.storage.cronJobs.get(jobId))?.actionConfig?.agentTurn?.sessionId : undefined;
    return {
      workspaceId: sessionId
        ? ((await host.storage.chatSessionMeta.get(sessionId))?.workspaceId ?? DEFAULT_WORKSPACE_ID)
        : DEFAULT_WORKSPACE_ID,
      input: {
        eventId: `notification:${event.eventId}`,
        eventType,
        ...(sessionId ? { sessionId } : {}),
        title: status === "completed" ? "Scheduled agent turn completed" : "Scheduled agent turn failed",
        message: `Scheduled run ${String(event.payload.runId ?? "unknown")} settled as ${status}.`,
        source: "scheduled.agent_turn",
      },
    };
  }
  return undefined;
}
