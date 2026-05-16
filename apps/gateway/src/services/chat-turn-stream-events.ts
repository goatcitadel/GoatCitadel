import type { HooksService } from "./hooks-service.js";
import { runtimeLifecycleHookDispatcher } from "./runtime-lifecycle-hook-dispatcher.js";

type ChatTurnStreamEventHost = {
  readonly hooksService: Pick<HooksService, "runInlineHooks" | "enqueueAfterHooks">;
};

export async function observeBeforeAssistantMessageWrite(
  host: ChatTurnStreamEventHost,
  input: {
    workspaceId: string;
    sessionId: string;
    turnId: string;
    messageId: string;
    content: string;
    stream: boolean;
    runId?: string;
    taskId?: string;
    providerId?: string;
    model?: string;
  },
): Promise<void> {
  await runtimeLifecycleHookDispatcher.runObserveHook(host.hooksService, {
    workspaceId: input.workspaceId,
    trigger: "before_message_write",
    entityType: "chat_turn",
    entityId: input.turnId,
    payload: {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      runId: input.runId,
      taskId: input.taskId,
      providerId: input.providerId,
      model: input.model,
      messageId: input.messageId,
      contentLength: input.content.length,
      stream: input.stream,
    },
  });
}

export function enqueueAgentEndHook(
  host: ChatTurnStreamEventHost,
  input: {
    workspaceId: string;
    sessionId: string;
    turnId: string;
    status: string;
    toolRunCount: number;
    stream: boolean;
    repaired: boolean;
    runId?: string;
    taskId?: string;
    providerId?: string;
    model?: string;
    approvalId?: string;
  },
): void {
  runtimeLifecycleHookDispatcher.enqueueObserveHook(host.hooksService, {
    workspaceId: input.workspaceId,
    trigger: "agent_end",
    entityType: "chat_turn",
    entityId: input.turnId,
    payload: {
      workspaceId: input.workspaceId,
      sessionId: input.sessionId,
      turnId: input.turnId,
      runId: input.runId,
      taskId: input.taskId,
      approvalId: input.approvalId,
      providerId: input.providerId,
      model: input.model,
      status: input.status,
      toolRunCount: input.toolRunCount,
      stream: input.stream,
      repaired: input.repaired,
    },
  });
}
