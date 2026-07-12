import { randomUUID } from "node:crypto";
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
import { isDurableRunTerminal, NotFoundError } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { resolvePreparedTurnMode, type PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import type { ChatStreamMutationLifecycle } from "./chat-turn-types.js";

export const AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY = "autonomousChatPostCommitPending";
export const GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY = "generalChatPostCommitPending";
export const GENERAL_CHAT_POST_COMMIT_EFFECTS = [
  "capability_gap",
  "learned_memory_user",
  "learned_memory_assistant",
  "commitments",
  "background_review",
  "memory_maintenance",
  "memory_prewarm",
  "realtime",
  "agent_end",
] as const;
export const GENERAL_CHAT_POST_COMMIT_DURABLE_EFFECTS = [
  "commitments",
  "background_review",
  "memory_maintenance",
] as const;
const GENERAL_CHAT_POST_COMMIT_TRACE_STATUSES = [
  "waiting_for_tool",
  "waiting_for_approval",
  "waiting_for_user_input",
  "completed",
  "partial",
  "failed",
  "cancelled",
] as const satisfies readonly ChatTurnTraceRecord["status"][];
export type GeneralChatPostCommitEffect = (typeof GENERAL_CHAT_POST_COMMIT_EFFECTS)[number];
export type GeneralChatPostCommitDurableEffect = (typeof GENERAL_CHAT_POST_COMMIT_DURABLE_EFFECTS)[number];
export type GeneralChatPostCommitDurableEffectInput =
  | {
      effect: "commitments";
      sessionId: string;
      workspaceId: string;
      turnId: string;
      autonomous: boolean;
    }
  | {
      effect: "background_review";
      sessionId: string;
      workspaceId: string;
      turnId: string;
      delegatedChild: boolean;
      autonomous: boolean;
    }
  | {
      effect: "memory_maintenance";
      sessionId: string;
      workspaceId: string;
      turnId: string;
      delegatedChild: boolean;
    };
export type GeneralChatPostCommitDurableEffectExecutionInput =
  | (Extract<GeneralChatPostCommitDurableEffectInput, { effect: "commitments" }> & {
      userText: string;
      assistantText: string;
    })
  | (Extract<GeneralChatPostCommitDurableEffectInput, { effect: "background_review" }> & {
      userText: string;
      assistantText: string;
    })
  | Extract<GeneralChatPostCommitDurableEffectInput, { effect: "memory_maintenance" }>;
export interface GeneralChatPostCommitEffectWorkflowPayload {
  version: "chat.post_commit.effect.v1";
  parentRunId: string;
  generationId: string;
  traceStatus: ChatTurnTraceRecord["status"];
  input: GeneralChatPostCommitDurableEffectInput;
}
export interface AutonomousChatPostCommitPendingMarker {
  version: 1;
  requestedAt: string;
  claimId?: string;
  claimExpiresAt?: string;
}
export interface GeneralChatPostCommitPendingMarker {
  version: 1;
  generationId: string;
  traceStatus: ChatTurnTraceRecord["status"];
  requestedAt: string;
  completedEffects: GeneralChatPostCommitEffect[];
  durableEffectRunIds: Partial<Record<GeneralChatPostCommitDurableEffect, string>>;
}
export interface GeneralChatPostCommitProgress {
  generationId: string;
  requestedAt: string;
  targetTraceStatus: ChatTurnTraceRecord["status"];
  completedEffects: readonly GeneralChatPostCommitEffect[];
  /**
   * Runs one synchronous, same-database consumer under the parent row lock and
   * records its durable completion receipt in that transaction. This closes
   * the local commit gap for learned memory, capability facts, retained
   * realtime, and the existing idempotent hook enqueue.
   *
   * A callback that only starts process-local async work is not durable. The
   * memory prewarm remains explicitly best-effort cache warming; meaningful
   * async effects must use `enqueueDurableEffect` below.
   */
  runEffect(effect: GeneralChatPostCommitEffect, callback: () => void): boolean;
  /**
   * Commits the parent receipt first, then invokes an idempotent notification
   * publisher outside the transaction. Reconciliation republishes an existing
   * receipt so a crash between receipt commit and delivery cannot lose it.
   */
  publishEffect(effect: GeneralChatPostCommitEffect, callback: () => void): boolean;
  /**
   * Atomically creates a deterministic durable child run and records the
   * parent's enqueue receipt. Child execution is lease-governed and may be
   * retried after a crash, so provider-backed work is at-least-once rather
   * than exactly-once.
   */
  enqueueDurableEffect(input: GeneralChatPostCommitDurableEffectInput): string | undefined;
}

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
  lockFreshActiveLeaseForUpdate?(runId: string, expectedLeaseOwnerId: string): DurableRunRecord | undefined;
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
    expectedVersion?: number;
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
  /** When present, the initial durable chat-turn trace is persisted through this store. */
  chatTurnTraces?: Pick<Storage["chatTurnTraces"], "get" | "create">;
  requestDurableRunProcessing(runId: string): void;
}

export interface ChatDurableRunFinalizeDeps {
  runImmediateTransaction<T>(callback: () => T): T;
  durableRuns: DurableRunStore;
  chatToolRuns: ChatToolRunSummaryStore;
  chatToolArtifacts: ChatToolArtifactSummaryStore;
  chatMessages?: Pick<{ get(messageId: string): ChatMessageRecord | undefined }, "get">;
  recordDurableTimelineEvent(
    durableRunId: string,
    eventType: DurableRunTimelineEvent["eventType"],
    payload?: Record<string, unknown>,
  ): void;
  chatTurnTraces: Pick<Storage["chatTurnTraces"], "patch">;
}

export function beginDurableChatRun(
  deps: ChatDurableRunBeginDeps,
  prepared: PreparedAgentChatTurn,
  input: ChatSendMessageRequest,
  threadEventType: ChatDurableThreadEventType,
  options?: { mutationLifecycle?: ChatStreamMutationLifecycle; runId?: string },
): DurableRunRecord | undefined {
  if (!deps.shouldUseDurableExecution) {
    return undefined;
  }
  const mode = resolvePreparedTurnMode(prepared);
  const run = deps.createDurableRun({
    runId: options?.runId,
    workflowKey: "chat.turn.execute",
    payload: deps.buildDurablePayloadRecord(prepared, input, threadEventType),
    metadata: {
      surface: mode,
      autoPromoted: mode === "chat",
      objective: prepared.content,
    },
  });
  options?.mutationLifecycle?.markCommitted();
  if (deps.chatTurnTraces) {
    persistInitialDurableChatTurnTrace({ chatTurnTraces: deps.chatTurnTraces }, prepared, input, run);
  }
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

/**
 * Persist the initial "running" chat-turn trace for a freshly-begun durable run.
 * Idempotent: if a trace already exists for the turn (e.g. a retry re-entered the
 * durable path) it is left untouched.
 */
export function persistInitialDurableChatTurnTrace(
  deps: { chatTurnTraces: Pick<Storage["chatTurnTraces"], "get" | "create"> },
  prepared: PreparedAgentChatTurn,
  input: ChatSendMessageRequest,
  run: DurableRunRecord,
): void {
  persistInitialChatTurnTrace(deps, prepared, input, run);
}

/**
 * Persist the initial running trace that makes a streamed turn durable enough
 * for cancellation/idempotency ownership before its first SSE payload.
 */
export function persistInitialChatTurnTrace(
  deps: { chatTurnTraces: Pick<Storage["chatTurnTraces"], "get" | "create"> },
  prepared: PreparedAgentChatTurn,
  input: ChatSendMessageRequest,
  run?: DurableRunRecord,
): void {
  try {
    deps.chatTurnTraces.get(prepared.turnId);
    return;
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
  }
  deps.chatTurnTraces.create({
    turnId: prepared.turnId,
    sessionId: prepared.session.sessionId,
    userMessageId: prepared.userEventId,
    parentTurnId: prepared.parentTurnId,
    branchKind: prepared.branchKind,
    sourceTurnId: prepared.sourceTurnId,
    status: "running",
    mode: resolvePreparedTurnMode(prepared),
    model: input.model ?? prepared.prefs.model,
    webMode: prepared.normalized.webMode ?? prepared.prefs.webMode,
    memoryMode: prepared.normalized.memoryMode ?? prepared.prefs.memoryMode,
    thinkingLevel: prepared.normalized.thinkingLevel ?? prepared.prefs.thinkingLevel,
    speedMode: prepared.normalized.speedMode ?? prepared.prefs.speedMode,
    subagentPolicy: prepared.normalized.subagentPolicy ?? prepared.prefs.subagentPolicy,
    effectiveToolAutonomy: prepared.effectiveToolAutonomy,
    routing: {
      primaryProviderId: input.providerId ?? prepared.prefs.providerId,
      primaryModel: input.model ?? prepared.prefs.model,
      effectiveProviderId: input.providerId ?? prepared.prefs.providerId,
      effectiveModel: input.model ?? prepared.prefs.model,
      modelRouter: prepared.modelRouterDecision,
    },
    ...(run
      ? {
          durable: {
            runId: run.runId,
            status: run.status,
          },
        }
      : {}),
  });
}

/** Patch a chat-turn trace, tolerating a trace that was never created for the turn. */
function patchDurableTraceIfPresent(
  chatTurnTraces: Pick<Storage["chatTurnTraces"], "patch">,
  turnId: string,
  input: Parameters<Storage["chatTurnTraces"]["patch"]>[1],
): void {
  try {
    chatTurnTraces.patch(turnId, input);
  } catch (error) {
    if (!(error instanceof NotFoundError)) {
      throw error;
    }
  }
}

export function finalizeDurableChatRun(
  deps: ChatDurableRunFinalizeDeps,
  runId: string,
  prepared: PreparedAgentChatTurn,
  trace: ChatTurnTraceRecord,
  expectedLeaseOwnerId?: string,
): void {
  const now = new Date().toISOString();
  const currentRun = deps.durableRuns.getRun?.(runId);
  if (currentRun && isDurableRunTerminal(currentRun.status)) {
    patchDurableTraceIfPresent(deps.chatTurnTraces, prepared.turnId, {
      durable: {
        runId,
        status: currentRun.status,
        checkpointKind: checkpointKindForTerminalDurableChatRunStatus(currentRun.status),
      },
    });
    return;
  }
  if (currentRun && currentRun.status !== "running") {
    patchDurableTraceIfPresent(deps.chatTurnTraces, prepared.turnId, {
      durable: {
        runId,
        status: currentRun.status,
        ...(currentRun.status === "waiting" ? { checkpointKind: "run_waiting" } : {}),
      },
    });
    return;
  }
  const lockCommittableRun = (): DurableRunRecord | undefined => {
    if (expectedLeaseOwnerId) {
      return deps.durableRuns.lockFreshActiveLeaseForUpdate?.(runId, expectedLeaseOwnerId);
    }
    const latest = deps.durableRuns.getRun?.(runId) ?? currentRun;
    return latest?.status === "running" ? latest : undefined;
  };
  const checkpointState = buildDurableCheckpointState(deps, prepared, trace);
  if (
    trace.status === "waiting_for_approval" ||
    trace.status === "waiting_for_user_input" ||
    trace.status === "waiting_for_tool"
  ) {
    const waitForEvent = resolveChatDurableWaitForEvent(trace);
    runChatFinalizeTransaction(deps, () => {
      const latest = lockCommittableRun();
      if (!latest) return;
      deps.durableRuns.updateRun({
        runId,
        status: "waiting",
        updatedAt: now,
        clearFinishedAt: true,
        clearLastError: true,
        clearLease: true,
        metadata: markGeneralChatPostCommitPending(
          {
            ...(latest.metadata ?? {}),
            waitForEvent,
          },
          now,
          trace.status,
        ),
        expectedVersion: latest.version,
      });
      deps.durableRuns.createCheckpoint({
        runId,
        checkpointKind: "run_waiting",
        state: checkpointState,
      });
      deps.recordDurableTimelineEvent(runId, "run_waiting", checkpointState);
      patchDurableTraceIfPresent(deps.chatTurnTraces, prepared.turnId, {
        durable: {
          runId,
          status: "waiting",
          checkpointKind: "run_waiting",
        },
      });
    });
    return;
  }
  if (trace.status === "cancelled") {
    const checkpointKind: DurableCheckpointRecord["checkpointKind"] = "run_cancelled";
    runChatFinalizeTransaction(deps, () => {
      const latest = lockCommittableRun();
      if (!latest) return;
      deps.durableRuns.updateRun({
        runId,
        status: "cancelled",
        updatedAt: now,
        finishedAt: now,
        clearLease: true,
        lastError: "cancelled",
        metadata: markGeneralChatPostCommitPending(latest.metadata, now, trace.status),
        expectedVersion: latest.version,
      });
      deps.durableRuns.createCheckpoint({
        runId,
        checkpointKind,
        state: checkpointState,
      });
      deps.recordDurableTimelineEvent(runId, "run_cancelled", checkpointState);
      patchDurableTraceIfPresent(deps.chatTurnTraces, prepared.turnId, {
        durable: {
          runId,
          status: "cancelled",
          checkpointKind,
        },
      });
    });
    return;
  }
  const completionFailed = trace.completion ? trace.completion.status !== "complete" : false;
  const failed = trace.status === "failed" || completionFailed;
  const nextStatus: DurableRunStatus = failed ? "failed" : "completed";
  const checkpointKind: DurableCheckpointRecord["checkpointKind"] = failed ? "run_failed" : "run_completed";
  const terminalOutput = getTerminalAssistantOutput(deps, prepared, trace);
  runChatFinalizeTransaction(deps, () => {
    const latest = lockCommittableRun();
    if (!latest) return;
    const terminalMetadata = markGeneralChatPostCommitPending(
      mergeTerminalOutputMetadata(latest.metadata, terminalOutput),
      now,
      trace.status,
    );
    deps.durableRuns.updateRun({
      runId,
      status: nextStatus,
      updatedAt: now,
      finishedAt: now,
      clearLease: true,
      metadata:
        nextStatus === "completed" ? markAutonomousChatPostCommitPending(terminalMetadata, now) : terminalMetadata,
      ...(failed ? { lastError: trace.failure?.message ?? "Durable chat run failed." } : { clearLastError: true }),
      expectedVersion: latest.version,
    });
    deps.durableRuns.createCheckpoint({
      runId,
      checkpointKind,
      state: checkpointState,
    });
    deps.recordDurableTimelineEvent(runId, failed ? "run_failed" : "run_completed", checkpointState);
    patchDurableTraceIfPresent(deps.chatTurnTraces, prepared.turnId, {
      durable: {
        runId,
        status: nextStatus,
        checkpointKind,
      },
    });
  });
}

function runChatFinalizeTransaction<T>(deps: ChatDurableRunFinalizeDeps, callback: () => T): T {
  return deps.runImmediateTransaction(callback);
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

function markAutonomousChatPostCommitPending(
  metadata: Record<string, unknown> | undefined,
  requestedAt: string,
): Record<string, unknown> | undefined {
  const autonomous = metadata?.autonomous;
  if (!autonomous || typeof autonomous !== "object" || Array.isArray(autonomous)) {
    return metadata;
  }
  return {
    ...(metadata ?? {}),
    [AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY]: {
      version: 1,
      requestedAt,
    },
  };
}

export function markGeneralChatPostCommitPending(
  metadata: Record<string, unknown> | undefined,
  requestedAt: string,
  traceStatus: ChatTurnTraceRecord["status"],
  generationId = randomUUID(),
): Record<string, unknown> {
  return {
    ...(metadata ?? {}),
    [GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY]: {
      version: 1,
      generationId,
      traceStatus,
      requestedAt,
      completedEffects: [],
      durableEffectRunIds: {},
    },
  };
}

export function markTerminalChatPostCommitPending(
  metadata: Record<string, unknown> | undefined,
  requestedAt: string,
  traceStatus: ChatTurnTraceRecord["status"],
  generationId = randomUUID(),
): Record<string, unknown> {
  const generalPending = markGeneralChatPostCommitPending(metadata, requestedAt, traceStatus, generationId);
  if (traceStatus !== "completed") {
    return generalPending;
  }
  return markAutonomousChatPostCommitPending(generalPending, requestedAt) ?? generalPending;
}

export function hasAutonomousChatPostCommitPending(run: DurableRunRecord): boolean {
  return readAutonomousChatPostCommitPendingMarker(run) !== undefined;
}

export function readAutonomousChatPostCommitPendingMarker(
  run: DurableRunRecord,
): AutonomousChatPostCommitPendingMarker | undefined {
  const pending = run.metadata?.[AUTONOMOUS_CHAT_POST_COMMIT_PENDING_METADATA_KEY];
  if (!pending || typeof pending !== "object" || Array.isArray(pending)) {
    return undefined;
  }
  const value = pending as Partial<AutonomousChatPostCommitPendingMarker>;
  if (value.version !== 1 || typeof value.requestedAt !== "string" || !value.requestedAt) {
    return undefined;
  }
  return {
    version: 1,
    requestedAt: value.requestedAt,
    ...(typeof value.claimId === "string" && value.claimId ? { claimId: value.claimId } : {}),
    ...(typeof value.claimExpiresAt === "string" && value.claimExpiresAt
      ? { claimExpiresAt: value.claimExpiresAt }
      : {}),
  };
}

export function hasGeneralChatPostCommitPending(run: DurableRunRecord): boolean {
  return readGeneralChatPostCommitPendingMarker(run) !== undefined;
}

export function readGeneralChatPostCommitPendingMarker(
  run: DurableRunRecord,
): GeneralChatPostCommitPendingMarker | undefined {
  const pending = run.metadata?.[GENERAL_CHAT_POST_COMMIT_PENDING_METADATA_KEY];
  if (!pending || typeof pending !== "object" || Array.isArray(pending)) {
    return undefined;
  }
  const value = pending as Partial<GeneralChatPostCommitPendingMarker>;
  if (
    value.version !== 1 ||
    typeof value.generationId !== "string" ||
    !value.generationId.trim() ||
    typeof value.traceStatus !== "string" ||
    !(GENERAL_CHAT_POST_COMMIT_TRACE_STATUSES as readonly string[]).includes(value.traceStatus) ||
    typeof value.requestedAt !== "string" ||
    !value.requestedAt.trim()
  ) {
    return undefined;
  }
  const completedEffects = Array.isArray(value.completedEffects)
    ? value.completedEffects.filter(isGeneralChatPostCommitEffect)
    : [];
  const durableEffectRunIds = readGeneralChatPostCommitDurableEffectRunIds(
    (value as { durableEffectRunIds?: unknown }).durableEffectRunIds,
  );
  return {
    version: 1,
    generationId: value.generationId,
    traceStatus: value.traceStatus,
    requestedAt: value.requestedAt,
    completedEffects: [...new Set(completedEffects)],
    durableEffectRunIds,
  };
}

export function readGeneralChatPostCommitCompletedEffects(run: DurableRunRecord): GeneralChatPostCommitEffect[] {
  return readGeneralChatPostCommitPendingMarker(run)?.completedEffects ?? [];
}

function isGeneralChatPostCommitEffect(value: unknown): value is GeneralChatPostCommitEffect {
  return typeof value === "string" && (GENERAL_CHAT_POST_COMMIT_EFFECTS as readonly string[]).includes(value);
}

function readGeneralChatPostCommitDurableEffectRunIds(
  value: unknown,
): Partial<Record<GeneralChatPostCommitDurableEffect, string>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  const record = value as Record<string, unknown>;
  const result: Partial<Record<GeneralChatPostCommitDurableEffect, string>> = {};
  for (const effect of GENERAL_CHAT_POST_COMMIT_DURABLE_EFFECTS) {
    const runId = record[effect];
    if (typeof runId === "string" && runId.trim()) {
      result[effect] = runId;
    }
  }
  return result;
}
