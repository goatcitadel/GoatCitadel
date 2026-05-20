import type {
  ChatSendMessageRequest,
  ChatMessageRecord,
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
  getRun?(runId: string): DurableRunRecord;
  updateRun(input: {
    runId: string;
    status?: DurableRunStatus;
    updatedAt?: string;
    finishedAt?: string;
    clearFinishedAt?: boolean;
    lastError?: string;
    clearLastError?: boolean;
    clearLease?: boolean;
    metadata?: Record<string, unknown>;
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
  persistInitialTrace?(prepared: PreparedAgentChatTurn, input: ChatSendMessageRequest, run: DurableRunRecord): void;
  requestDurableRunProcessing(runId: string): void;
}

export interface ChatDurableRunFinalizeDeps {
  durableRuns: DurableRunStore;
  chatToolRuns: ChatToolRunSummaryStore;
  chatToolArtifacts: ChatToolArtifactSummaryStore;
  chatMessages?: Pick<{ get(messageId: string): ChatMessageRecord | undefined }, "get">;
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
  deps.persistInitialTrace?.(prepared, input, run);
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
  const currentRun = deps.durableRuns.getRun?.(runId);
  if (currentRun && isTerminalDurableChatRunStatus(currentRun.status)) {
    deps.patchDurableTraceIfPresent(prepared.turnId, {
      durable: {
        runId,
        status: currentRun.status,
        checkpointKind: checkpointKindForTerminalDurableChatRunStatus(currentRun.status),
      },
    });
    return;
  }
  const checkpointState = buildDurableCheckpointState(deps, prepared, trace);
  if (
    trace.status === "waiting_for_approval" ||
    trace.status === "waiting_for_user_input" ||
    trace.status === "waiting_for_tool"
  ) {
    deps.durableRuns.updateRun({
      runId,
      status: "waiting",
      updatedAt: now,
      clearFinishedAt: true,
      clearLastError: true,
      clearLease: true,
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
    const checkpointKind: DurableCheckpointRecord["checkpointKind"] = "run_cancelled";
    deps.durableRuns.updateRun({
      runId,
      status: "cancelled",
      updatedAt: now,
      finishedAt: now,
      clearLease: true,
      lastError: "cancelled",
    });
    deps.durableRuns.createCheckpoint({
      runId,
      checkpointKind,
      state: checkpointState,
    });
    deps.recordDurableTimelineEvent(runId, "run_cancelled", checkpointState);
    deps.patchDurableTraceIfPresent(prepared.turnId, {
      durable: {
        runId,
        status: "cancelled",
        checkpointKind,
      },
    });
    return;
  }
  const completionFailed = trace.completion ? trace.completion.status !== "complete" : false;
  const failed = trace.status === "failed" || completionFailed;
  const nextStatus: DurableRunStatus = failed ? "failed" : "completed";
  const checkpointKind: DurableCheckpointRecord["checkpointKind"] = failed ? "run_failed" : "run_completed";
  const terminalOutput = getTerminalAssistantOutput(deps, prepared, trace);
  deps.durableRuns.updateRun({
    runId,
    status: nextStatus,
    updatedAt: now,
    finishedAt: now,
    clearLease: true,
    metadata: mergeTerminalOutputMetadata(currentRun?.metadata, terminalOutput),
    ...(failed ? { lastError: trace.failure?.message ?? "Durable chat run failed." } : { clearLastError: true }),
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

function isTerminalDurableChatRunStatus(status: DurableRunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "dead_lettered";
}

function checkpointKindForTerminalDurableChatRunStatus(
  status: DurableRunStatus,
): DurableCheckpointRecord["checkpointKind"] {
  if (status === "completed") {
    return "run_completed";
  }
  if (status === "cancelled") {
    return "run_cancelled";
  }
  return "run_failed";
}

function buildDurableCheckpointState(
  deps: Pick<ChatDurableRunFinalizeDeps, "chatToolRuns" | "chatToolArtifacts" | "chatMessages">,
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
  const terminalOutput = getTerminalAssistantOutput(deps, prepared, trace);
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
    ...(terminalOutput
      ? {
          assistantMessageId: trace.assistantMessageId ?? prepared.assistantMessageId,
          outputText: terminalOutput.outputText,
          outputSummary: terminalOutput.outputSummary,
        }
      : {}),
  };
}

function getTerminalAssistantOutput(
  deps: Pick<ChatDurableRunFinalizeDeps, "chatMessages">,
  prepared: PreparedAgentChatTurn,
  trace: ChatTurnTraceRecord,
): { outputText: string; outputSummary: string } | undefined {
  if (trace.status !== "completed" && trace.status !== "failed") {
    return undefined;
  }
  const messageId = trace.assistantMessageId ?? prepared.assistantMessageId;
  if (!messageId) {
    return undefined;
  }
  const content = deps.chatMessages?.get(messageId)?.content.trim();
  if (!content) {
    return undefined;
  }
  return {
    outputText: content,
    outputSummary: summarizeAssistantOutput(content),
  };
}

function summarizeAssistantOutput(content: string): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  return normalized.length > 280 ? `${normalized.slice(0, 277)}...` : normalized;
}

function mergeTerminalOutputMetadata(
  metadata: Record<string, unknown> | undefined,
  output: { outputText: string; outputSummary: string } | undefined,
): Record<string, unknown> | undefined {
  if (!output) {
    return metadata;
  }
  return {
    ...(metadata ?? {}),
    outputText: output.outputText,
    finalOutput: output.outputText,
    outputSummary: output.outputSummary,
    finalSummary: output.outputSummary,
  };
}
