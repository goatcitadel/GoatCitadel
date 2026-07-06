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
import { isDurableRunTerminal } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { resolvePreparedTurnMode, type PreparedAgentChatTurn } from "./chat-turn-prep-service.js";

export type ChatDurableThreadEventType =
  | "chat_thread_turn_appended"
  | "chat_thread_turn_retried"
  | "chat_thread_turn_edited";

// Wake-event keys that the durable chat-turn parks register on `metadata.waitForEvent`.
// Each MUST exactly match the eventKey its real waker emits, or the parked run either
// resumes prematurely (loose key) or never resumes (wrong key):
//   - approval.resolved       — emitted by ApprovalEffectsService.wakeDurableRun
//                               (approval-resolution-effects-service.ts), correlationId = approvalId.
//   - chat.user_input.resolved — emitted by the user-input respond runtime
//                               (chat-message-route-runtime.ts), correlationId = promptId.
//   - chat.tool_wait.resolved  — SENTINEL. `waiting_for_tool` is a transient in-flight
//                               marker (see chat-turn-stream-service.ts); NO production
//                               path emits a keyed wake for it. Kept eventKey-only so an
//                               operator can still force-resume via the durable wake route,
//                               while blocking stray cross-type wakes.
const CHAT_APPROVAL_RESOLVED_WAKE_EVENT = "approval.resolved";
const CHAT_USER_INPUT_RESOLVED_WAKE_EVENT = "chat.user_input.resolved";
const CHAT_TOOL_WAIT_RESOLVED_WAKE_EVENT = "chat.tool_wait.resolved";

interface ChatDurableWaitForEvent {
  eventKey: string;
  correlationId?: string;
}

/**
 * Resolve the wake contract for a chat turn that parked in a waiting state.
 *
 * The correlationId MUST match what the real waker supplies, and we NEVER guess
 * one: a wrong correlationId rejects a legitimate resume (worse than the loose
 * wake it replaces). When the identifier cannot be resolved from the trace we
 * fall back to eventKey-only so the run is still wakeable by its real waker.
 */
function resolveChatDurableWaitForEvent(trace: ChatTurnTraceRecord): ChatDurableWaitForEvent {
  if (trace.status === "waiting_for_approval") {
    // Mirror orchestration-phase-execution-service.ts: prefer the (hydration-only)
    // pendingApprovalSummary, then the persisted approval_required tool run.
    const approvalId =
      trace.pendingApprovalSummary?.approvalId ??
      trace.toolRuns.find((toolRun) => toolRun.status === "approval_required" && toolRun.approvalId)?.approvalId;
    return approvalId
      ? { eventKey: CHAT_APPROVAL_RESOLVED_WAKE_EVENT, correlationId: approvalId }
      : { eventKey: CHAT_APPROVAL_RESOLVED_WAKE_EVENT };
  }
  if (trace.status === "waiting_for_user_input") {
    const promptId = trace.pendingUserInput?.promptId;
    return promptId
      ? { eventKey: CHAT_USER_INPUT_RESOLVED_WAKE_EVENT, correlationId: promptId }
      : { eventKey: CHAT_USER_INPUT_RESOLVED_WAKE_EVENT };
  }
  // waiting_for_tool — eventKey-only sentinel (no real keyed waker exists).
  return { eventKey: CHAT_TOOL_WAIT_RESOLVED_WAKE_EVENT };
}

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
  const mode = resolvePreparedTurnMode(prepared);
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
  if (currentRun && isDurableRunTerminal(currentRun.status)) {
    deps.patchDurableTraceIfPresent(prepared.turnId, {
      durable: {
        runId,
        status: currentRun.status,
        checkpointKind: checkpointKindForTerminalDurableChatRunStatus(currentRun.status),
      },
    });
    return;
  }
  if (currentRun && currentRun.status !== "running") {
    deps.patchDurableTraceIfPresent(prepared.turnId, {
      durable: {
        runId,
        status: currentRun.status,
        ...(currentRun.status === "waiting" ? { checkpointKind: "run_waiting" } : {}),
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
    const waitForEvent = resolveChatDurableWaitForEvent(trace);
    deps.durableRuns.updateRun({
      runId,
      status: "waiting",
      updatedAt: now,
      clearFinishedAt: true,
      clearLastError: true,
      clearLease: true,
      // The durable-run repo REPLACES metadata on update, so spread the existing
      // metadata (surface, objective, retryPolicy, …) to avoid clobbering it while
      // registering the wake contract. Without waitForEvent, wakeDurableRun would
      // accept ANY wake and prematurely resume a still-waiting turn (Finding 3).
      metadata: {
        ...(currentRun?.metadata ?? {}),
        waitForEvent,
      },
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
