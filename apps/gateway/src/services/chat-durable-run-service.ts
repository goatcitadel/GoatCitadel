import type {
  ChatSendMessageRequest,
  ChatTurnTraceRecord,
  ChatTurnBranchKind,
  DurableCheckpointRecord,
  DurableRunCreateRequest,
  DurableRunRecord,
  DurableRunStatus,
  DurableRunTimelineEvent,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";

export type ChatDurableThreadEventType =
  | "chat_thread_turn_appended"
  | "chat_thread_turn_retried"
  | "chat_thread_turn_edited";

interface DurableRunStore {
  updateRun(input: {
    runId: string;
    status?: DurableRunStatus;
    updatedAt?: string;
    finishedAt?: string;
    lastError?: string;
  }): DurableRunRecord;
  createCheckpoint(input: {
    runId: string;
    checkpointKind: DurableCheckpointRecord["checkpointKind"];
    state: Record<string, unknown>;
    createdAt?: string;
  }): DurableCheckpointRecord;
}

interface ChatToolRunSummaryStore {
  listByTurn(turnId: string): Array<{
    toolRunId: string;
    toolName: string;
    status: string;
    startedAt?: string;
    finishedAt?: string;
  }>;
}

interface ChatToolArtifactSummaryStore {
  listByTurn(turnId: string): Array<{
    artifactId: string;
    toolRunId?: string;
    toolName?: string;
    contentType?: string;
    byteLength?: number;
    storageRelPath?: string;
    snippet?: string;
  }>;
}

export interface ChatDurableRunBeginDeps {
  shouldUseDurableExecution: boolean;
  createDurableRun(input: DurableRunCreateRequest): DurableRunRecord;
  buildDurablePayloadRecord(
    prepared: PreparedAgentChatTurn,
    input: ChatSendMessageRequest,
    threadEventType: ChatDurableThreadEventType,
  ): Record<string, unknown>;
  persistChatStreamChunk(
    chunk: {
      type: "message_start";
      sessionId: string;
      turnId: string;
      messageId: string;
      parentTurnId?: string;
      branchKind: ChatTurnBranchKind;
      sourceTurnId?: string;
    },
    durableRunId?: string,
  ): void;
  requestDurableRunProcessing(runId: string): void;
}

export interface ChatDurableRunFinalizeDeps {
  durableRuns: DurableRunStore;
  chatToolRuns: ChatToolRunSummaryStore;
  chatToolArtifacts: ChatToolArtifactSummaryStore;
  recordDurableTimelineEvent(
    durableRunId: string,
    eventType: DurableRunTimelineEvent["eventType"],
    payload?: Record<string, unknown>,
  ): void;
  patchDurableTraceIfPresent(turnId: string, input: Parameters<Storage["chatTurnTraces"]["patch"]>[1]): void;
}

export function beginDurableChatRun(
  deps: ChatDurableRunBeginDeps,
  prepared: PreparedAgentChatTurn,
  input: ChatSendMessageRequest,
  threadEventType: ChatDurableThreadEventType,
): DurableRunRecord | undefined {
  if (!deps.shouldUseDurableExecution) {
    return undefined;
  }
  const mode = prepared.normalized.mode ?? prepared.prefs.mode;
  const run = deps.createDurableRun({
    workflowKey: "chat.turn.execute",
    payload: deps.buildDurablePayloadRecord(prepared, input, threadEventType),
    metadata: {
      surface: mode,
      autoPromoted: mode === "chat",
      objective: prepared.content,
    },
  });
  deps.persistChatStreamChunk(
    {
      type: "message_start",
      sessionId: prepared.session.sessionId,
      turnId: prepared.turnId,
      messageId: prepared.assistantMessageId,
      parentTurnId: prepared.parentTurnId,
      branchKind: prepared.branchKind,
      sourceTurnId: prepared.sourceTurnId,
    },
    run.runId,
  );
  deps.requestDurableRunProcessing(run.runId);
  return run;
}

export function finalizeDurableChatRun(
  deps: ChatDurableRunFinalizeDeps,
  runId: string,
  prepared: PreparedAgentChatTurn,
  trace: ChatTurnTraceRecord,
): void {
  const now = new Date().toISOString();
  const checkpointState = buildDurableCheckpointState(deps, prepared, trace);
  if (trace.status === "waiting_for_approval") {
    deps.durableRuns.updateRun({
      runId,
      status: "waiting",
      updatedAt: now,
      finishedAt: undefined,
    });
    deps.durableRuns.createCheckpoint({
      runId,
      checkpointKind: "run_waiting",
      state: checkpointState,
    });
    deps.recordDurableTimelineEvent(runId, "run_waiting", checkpointState);
    deps.patchDurableTraceIfPresent(prepared.turnId, {
      durable: {
        runId,
        status: "waiting",
        checkpointKind: "run_waiting",
      },
    });
    return;
  }
  if (trace.status === "cancelled") {
    deps.durableRuns.updateRun({
      runId,
      status: "cancelled",
      updatedAt: now,
      finishedAt: now,
    });
    deps.recordDurableTimelineEvent(runId, "run_cancelled", checkpointState);
    deps.patchDurableTraceIfPresent(prepared.turnId, {
      durable: {
        runId,
        status: "cancelled",
        checkpointKind: "run_failed",
      },
    });
    return;
  }
  const failed = trace.status === "failed" || trace.completion?.status !== "complete";
  const nextStatus: DurableRunStatus = failed ? "failed" : "completed";
  const checkpointKind: DurableCheckpointRecord["checkpointKind"] = failed ? "run_failed" : "run_completed";
  deps.durableRuns.updateRun({
    runId,
    status: nextStatus,
    updatedAt: now,
    finishedAt: now,
    lastError: failed ? trace.failure?.message : undefined,
  });
  deps.durableRuns.createCheckpoint({
    runId,
    checkpointKind,
    state: checkpointState,
  });
  deps.recordDurableTimelineEvent(runId, failed ? "run_failed" : "run_completed", checkpointState);
  deps.patchDurableTraceIfPresent(prepared.turnId, {
    durable: {
      runId,
      status: nextStatus,
      checkpointKind,
    },
  });
}

function buildDurableCheckpointState(
  deps: Pick<ChatDurableRunFinalizeDeps, "chatToolRuns" | "chatToolArtifacts">,
  prepared: PreparedAgentChatTurn,
  trace: ChatTurnTraceRecord,
): Record<string, unknown> {
  const toolRuns = deps.chatToolRuns.listByTurn(prepared.turnId);
  const artifacts = deps.chatToolArtifacts.listByTurn(prepared.turnId).map((artifact) => ({
    artifactId: artifact.artifactId,
    toolRunId: artifact.toolRunId,
    toolName: artifact.toolName,
    contentType: artifact.contentType,
    byteLength: artifact.byteLength,
    storageRelPath: artifact.storageRelPath,
    snippet: artifact.snippet,
  }));
  return {
    objective: prepared.content,
    currentStep: trace.status,
    attemptedTools: toolRuns.map((run) => ({
      toolRunId: run.toolRunId,
      toolName: run.toolName,
      status: run.status,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    })),
    artifactPointers: artifacts,
    blocker: trace.failure?.message,
    nextAction: trace.failure?.recommendedAction,
  };
}
