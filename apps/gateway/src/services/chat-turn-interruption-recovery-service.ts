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
import {
  CHAT_TURN_ACTIVE_STATUSES,
  buildToolEffectEvidence,
  isDurableRunTerminal,
  NotFoundError,
  redactStructuredSecrets,
  TOOL_EFFECT_CLASSIFICATION_VERSION,
} from "@goatcitadel/contracts";
import type {
  ChatMessageRecord,
  ChatMode,
  ChatStreamUsageRecord,
  ChatTurnFailureRecord,
  ChatTurnRepairRecord,
  ChatTurnTraceRecord,
  DurableRunRecord,
  RealtimeEvent,
  TranscriptEvent,
} from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import { buildChatTurnRealtimeOptions } from "./chat-turn-realtime.js";

export const INTERRUPTED_BY_RESTART_MESSAGE =
  "The gateway restarted while this turn was in flight, so the turn never finished.";

export interface ChatTurnInterruptionRecoveryDeps {
  storage: Pick<
    Storage,
    | "chatTurnTraces"
    | "chatToolRuns"
    | "chatTurnRecovery"
    | "chatSessionPrefs"
    | "chatSessionBranchState"
    | "chatMessages"
    | "chatStreamEvents"
    | "sessions"
    | "transcriptOutbox"
    | "durableRuns"
    | "runImmediateTransaction"
  >;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): Promise<unknown>;
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
  /** Turns restored from an authoritative retained message_done source. */
  restoredFinalTurnIds: string[];
  /** Turns that retain their completed streamed prefix after interruption. */
  preservedPartialTurnIds: string[];
  /** Newly queued durable transcript entries; duplicate event ids are not counted. */
  transcriptEventsEnqueued: number;
  /** Dangling canonical tool calls settled without replay. */
  reconciledToolRunIds: string[];
  /** Reconciled calls whose external state must be inspected before retry. */
  unknownEffectToolRunIds: string[];
}

const MAX_RECOVERED_ASSISTANT_BYTES = 128 * 1024;
const RECOVERED_CONTENT_TRUNCATION_MARKER = "\n...[recovered prefix truncated]";
const RECOVERY_PAGE_SIZE = 500;
const RECOVERY_DIAGNOSTIC_LIMIT_BYTES = 2 * 1024;
const RECOVERY_DIAGNOSTIC_TRUNCATION_MARKER = "...[truncated]";

export async function reconcileInterruptedChatTurns(
  deps: ChatTurnInterruptionRecoveryDeps,
): Promise<ChatTurnInterruptionRecoveryResult> {
  const now = deps.now ? deps.now() : new Date().toISOString();
  const result = createInterruptionRecoveryResult();

  let activeCursor: { startedAt: string; turnId: string } | undefined;
  while (true) {
    const page = await deps.storage.chatTurnTraces.listActivePage({
      afterStartedAt: activeCursor?.startedAt,
      afterTurnId: activeCursor?.turnId,
      limit: RECOVERY_PAGE_SIZE,
    });
    if (page.length === 0) {
      break;
    }
    for (const trace of page) {
      await reconcileActiveInterruptedTrace(deps, trace, now, result);
    }
    const last = page.at(-1)!;
    activeCursor = { startedAt: last.startedAt, turnId: last.turnId };
    if (page.length < RECOVERY_PAGE_SIZE) {
      break;
    }
  }

  await reconcileOrphanedUserMessages(deps, now, result);

  return result;
}

/**
 * Reconcile one exact durable Chat turn after its lease owner has been fenced
 * and the durable run has reached terminal failure. Keeping this exact avoids a
 * second process-wide scan and prevents a shared host from touching unrelated
 * active turns while still reusing the canonical prefix/transcript repair.
 */
export async function reconcileInterruptedDurableChatTurn(
  deps: ChatTurnInterruptionRecoveryDeps,
  input: { runId: string; turnId: string },
): Promise<ChatTurnInterruptionRecoveryResult> {
  const result = createInterruptionRecoveryResult();
  let trace: ChatTurnTraceRecord;
  try {
    trace = await deps.storage.chatTurnTraces.get(input.turnId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return result;
    }
    throw error;
  }
  if (
    trace.durable?.runId !== input.runId ||
    !CHAT_TURN_ACTIVE_STATUSES.includes(trace.status as (typeof CHAT_TURN_ACTIVE_STATUSES)[number])
  ) {
    return result;
  }
  await reconcileActiveInterruptedTrace(deps, trace, deps.now ? deps.now() : new Date().toISOString(), result, {
    durableTerminalFailure: true,
  });
  return result;
}

function createInterruptionRecoveryResult(): ChatTurnInterruptionRecoveryResult {
  return {
    interruptedTurnIds: [],
    synthesizedTurnIds: [],
    skippedDurableOwnedTurnIds: [],
    restoredFinalTurnIds: [],
    preservedPartialTurnIds: [],
    transcriptEventsEnqueued: 0,
    reconciledToolRunIds: [],
    unknownEffectToolRunIds: [],
  };
}

async function reconcileActiveInterruptedTrace(
  deps: ChatTurnInterruptionRecoveryDeps,
  trace: ChatTurnTraceRecord,
  now: string,
  result: ChatTurnInterruptionRecoveryResult,
  options: { durableTerminalFailure?: boolean } = {},
): Promise<void> {
  try {
    if (await isOwnedByLiveDurableRun(deps, trace)) {
      result.skippedDurableOwnedTurnIds.push(trace.turnId);
      return;
    }
    await reconcileDanglingToolRuns(deps, trace, now, result);
    const recoveredSource = await resolveRecoveredAssistantSource(deps.storage, trace);
    if (recoveredSource) {
      const enqueued = await persistRecoveredAssistantSource(
        deps,
        trace,
        recoveredSource,
        now,
        options.durableTerminalFailure ? "failed" : "partial",
      );
      result.transcriptEventsEnqueued += enqueued ? 1 : 0;
      if (recoveredSource.final) {
        result.restoredFinalTurnIds.push(trace.turnId);
      } else {
        result.preservedPartialTurnIds.push(trace.turnId);
      }
      await announceInterruptedTurn(
        deps,
        trace.sessionId,
        trace.turnId,
        recoveredSource.final
          ? "chat.turn.final_source_restored_after_restart"
          : "chat.turn.partial_prefix_preserved_after_restart",
        {
          previousStatus: trace.status,
          assistantMessageId: recoveredSource.messageId,
          recoveredBytes: Buffer.byteLength(recoveredSource.content, "utf8"),
          finalSource: recoveredSource.final,
          sourceIncomplete: Boolean(recoveredSource.sourceIncomplete),
        },
      );
      return;
    }
  } catch (error) {
    recordInterruptionRecoveryFailure(deps, trace, error, "recovered assistant output");
  }
  try {
    await deps.storage.chatTurnTraces.patch(trace.turnId, {
      status: "failed",
      failure: buildInterruptedByRestartFailure(),
      completion: {
        finishReason: trace.completion?.finishReason,
        status: "interrupted",
        repaired: Boolean(trace.completion?.repaired),
      },
      // A waiting_for_user_input turn can never collect its answer after the
      // process died; clear the prompt so it doesn't sit on a terminal row.
      pendingUserInput: null,
      finishedAt: now,
    });
    result.interruptedTurnIds.push(trace.turnId);
    await announceInterruptedTurn(deps, trace.sessionId, trace.turnId, "chat.turn.interrupted_by_restart", {
      previousStatus: trace.status,
    });
  } catch (error) {
    recordInterruptionRecoveryFailure(deps, trace, error, "interrupted trace fallback");
  }
}

function recordInterruptionRecoveryFailure(
  deps: ChatTurnInterruptionRecoveryDeps,
  trace: ChatTurnTraceRecord,
  error: unknown,
  phase: string,
): void {
  recordDevDiagnosticSafely(deps, {
    level: "warn",
    category: "chat",
    event: "chat.turn.interruption_recovery_persistence_failed",
    message: buildBoundedRecoveryDiagnostic(`Failed to persist ${phase}; recovery continued with the next turn`, error),
    sessionId: trace.sessionId,
    turnId: trace.turnId,
  });
}

async function reconcileDanglingToolRuns(
  deps: ChatTurnInterruptionRecoveryDeps,
  trace: ChatTurnTraceRecord,
  now: string,
  result: ChatTurnInterruptionRecoveryResult,
): Promise<void> {
  const dangling = (await deps.storage.chatToolRuns.listByTurn(trace.turnId)).filter(
    (toolRun) => toolRun.status === "started" && !toolRun.finishedAt,
  );
  for (const toolRun of dangling) {
    try {
      if (toolRun.effectOutcomeKind === "concrete" && toolRun.effectEvidence?.refs.length) {
        await deps.storage.chatToolRuns.patch(toolRun.toolRunId, {
          status: "failed",
          error: INTERRUPTED_BY_RESTART_MESSAGE,
          failureGuidance:
            "A canonical effect receipt exists, but the Chat call did not settle. Inspect the linked owner receipt before any retry; automatic replay was suppressed.",
          finishedAt: now,
        });
      } else {
        const phase =
          toolRun.effectEvidence?.reason === "planned_before_dispatch"
            ? ("skipped" as const)
            : ("interrupted" as const);
        const settlement = buildToolEffectEvidence({
          potential: toolRun.effectPotential ?? "unknown",
          phase,
        });
        await deps.storage.chatToolRuns.patch(toolRun.toolRunId, {
          status: "failed",
          effectPotential: toolRun.effectPotential ?? "unknown",
          effectDisposition: settlement.disposition ?? null,
          effectOutcomeKind: settlement.outcomeKind,
          effectEvidence: settlement.evidence,
          error: INTERRUPTED_BY_RESTART_MESSAGE,
          failureGuidance:
            settlement.disposition === "unknown"
              ? "The tool may have changed external or runtime state. Inspect state before retry; automatic replay was suppressed."
              : "No tool effect could have occurred. Retry is safe after reviewing the interrupted turn.",
          finishedAt: now,
        });
        if (settlement.disposition === "unknown") {
          result.unknownEffectToolRunIds.push(toolRun.toolRunId);
        }
      }
      result.reconciledToolRunIds.push(toolRun.toolRunId);
    } catch (error) {
      recordDevDiagnosticSafely(deps, {
        level: "warn",
        category: "chat",
        event: "chat.turn.tool_effect_reconciliation_failed",
        message: buildBoundedRecoveryDiagnostic("Failed to reconcile interrupted tool effect truth", error),
        sessionId: trace.sessionId,
        turnId: trace.turnId,
        context: { toolRunId: toolRun.toolRunId, classificationVersion: TOOL_EFFECT_CLASSIFICATION_VERSION },
      });
    }
  }
}

async function reconcileOrphanedUserMessages(
  deps: ChatTurnInterruptionRecoveryDeps,
  now: string,
  result: ChatTurnInterruptionRecoveryResult,
): Promise<void> {
  let cursor: { timestamp: string; messageId: string } | undefined;
  while (true) {
    const page = await deps.storage.chatTurnRecovery.listOrphanedLatestUserMessagesPage({
      afterTimestamp: cursor?.timestamp,
      afterMessageId: cursor?.messageId,
      limit: RECOVERY_PAGE_SIZE,
    });
    if (page.length === 0) {
      break;
    }
    for (const orphan of page) {
      try {
        const turnId = await synthesizeInterruptedTrace(deps, orphan, now);
        result.synthesizedTurnIds.push(turnId);
        await announceInterruptedTurn(deps, orphan.sessionId, turnId, "chat.turn.interrupted_by_restart_synthesized", {
          userMessageId: orphan.messageId,
        });
      } catch (error) {
        recordDevDiagnosticSafely(deps, {
          level: "warn",
          category: "chat",
          event: "chat.turn.orphan_interruption_recovery_failed",
          message: buildBoundedRecoveryDiagnostic(
            "Failed to synthesize interrupted orphan; recovery continued with the next message",
            error,
          ),
          sessionId: orphan.sessionId,
          context: { userMessageId: orphan.messageId },
        });
      }
    }
    const last = page.at(-1)!;
    cursor = { timestamp: last.timestamp, messageId: last.messageId };
    if (page.length < RECOVERY_PAGE_SIZE) {
      break;
    }
  }
}

interface RecoveredAssistantSource {
  messageId: string;
  content: string;
  timestamp: string;
  final: boolean;
  repaired?: boolean;
  repair?: ChatTurnRepairRecord;
  usage?: ChatStreamUsageRecord;
  sourceIncomplete?: boolean;
}

async function resolveRecoveredAssistantSource(
  storage: ChatTurnInterruptionRecoveryDeps["storage"],
  trace: ChatTurnTraceRecord,
): Promise<RecoveredAssistantSource | undefined> {
  const existingMessage = trace.assistantMessageId
    ? await storage.chatMessages.get(trace.assistantMessageId)
    : undefined;
  if (existingMessage?.role === "assistant" && existingMessage.content.trim()) {
    const wasRecoveredPartial =
      trace.status === "partial" &&
      trace.completion?.status === "interrupted" &&
      trace.failure?.failureClass === "interrupted_by_restart";
    return {
      messageId: existingMessage.messageId,
      content: boundRecoveredContent(existingMessage.content),
      timestamp: existingMessage.timestamp,
      final: !wasRecoveredPartial,
    };
  }

  let messageId = trace.assistantMessageId;
  let finalContent: string | undefined;
  let finalTimestamp: string | undefined;
  let repaired = false;
  let repair: RecoveredAssistantSource["repair"];
  let usage: RecoveredAssistantSource["usage"];
  let completedPrefix = "";
  let prefixTruncated = false;
  let sourceIncomplete = false;
  let latestDeltaTimestamp: string | undefined;
  let afterSequence = 0;
  let expectedSequence: number | undefined;
  while (true) {
    const page = await storage.chatStreamEvents.listByTurn(trace.turnId, afterSequence, 5_000);
    if (page.length === 0) {
      break;
    }
    for (const event of page) {
      if (expectedSequence === undefined) {
        sourceIncomplete = event.sequence > 1;
      } else if (event.sequence !== expectedSequence) {
        sourceIncomplete = true;
      }
      expectedSequence = event.sequence + 1;
      const payload = event.payload;
      const type = typeof payload.type === "string" ? payload.type : event.chunkType;
      if (type === "message_start" && typeof payload.messageId === "string") {
        messageId = payload.messageId;
        continue;
      }
      if (type === "delta" && typeof payload.delta === "string" && payload.delta.length > 0) {
        if (!prefixTruncated) {
          const appended = appendRecoveredPrefix(completedPrefix, payload.delta);
          completedPrefix = appended.content;
          prefixTruncated = appended.truncated;
        }
        latestDeltaTimestamp = event.createdAt;
        if (!messageId && typeof payload.messageId === "string") {
          messageId = payload.messageId;
        }
        continue;
      }
      if (type === "usage" && isRecord(payload.usage)) {
        usage = payload.usage as unknown as ChatStreamUsageRecord;
        continue;
      }
      if (type === "message_done" && typeof payload.content === "string" && payload.content.trim()) {
        finalContent = payload.content;
        finalTimestamp = event.createdAt;
        messageId = typeof payload.messageId === "string" ? payload.messageId : messageId;
        repaired = payload.repaired === true;
        repair = isRecord(payload.repair) ? (payload.repair as unknown as ChatTurnRepairRecord) : undefined;
      }
    }
    const nextSequence = page.at(-1)?.sequence ?? afterSequence;
    if (nextSequence <= afterSequence) {
      sourceIncomplete = true;
      break;
    }
    afterSequence = nextSequence;
    if (page.length < 5_000) {
      break;
    }
  }

  if (messageId && finalContent?.trim()) {
    const durableFinalSource = await hasAuthoritativeDurableFinalOutput(storage, trace, finalContent);
    return {
      messageId,
      content: boundRecoveredContent(finalContent),
      timestamp: finalTimestamp ?? new Date().toISOString(),
      final: durableFinalSource,
      repaired: durableFinalSource ? repaired : false,
      repair: durableFinalSource ? repair : undefined,
      usage,
      sourceIncomplete: sourceIncomplete || Buffer.byteLength(finalContent, "utf8") > MAX_RECOVERED_ASSISTANT_BYTES,
    };
  }
  if (!messageId || !completedPrefix.trim()) {
    return undefined;
  }
  const incompletePrefix = prefixTruncated || sourceIncomplete;
  return {
    messageId,
    content: incompletePrefix
      ? appendRecoveryPostureMarker(
          completedPrefix,
          prefixTruncated ? RECOVERED_CONTENT_TRUNCATION_MARKER : "\n...[retained stream history incomplete]",
        )
      : completedPrefix,
    timestamp: latestDeltaTimestamp ?? new Date().toISOString(),
    final: false,
    usage,
    sourceIncomplete: incompletePrefix,
  };
}

/**
 * Retained stream chunks are replay projections, not canonical completion
 * records. A message_done chunk may restore a completed turn only when the
 * durable owner independently committed the same terminal output. Otherwise
 * the content is retained as an explicitly interrupted prefix.
 */
async function hasAuthoritativeDurableFinalOutput(
  storage: ChatTurnInterruptionRecoveryDeps["storage"],
  trace: ChatTurnTraceRecord,
  content: string,
): Promise<boolean> {
  const runId = trace.durable?.runId;
  if (!runId) {
    return false;
  }
  let run: DurableRunRecord;
  try {
    run = await storage.durableRuns.getRun(runId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return false;
    }
    throw error;
  }
  if (run.status !== "completed") {
    return false;
  }
  const finalOutput = run.metadata?.finalOutput;
  return typeof finalOutput === "string" && finalOutput === content;
}

async function persistRecoveredAssistantSource(
  deps: ChatTurnInterruptionRecoveryDeps,
  trace: ChatTurnTraceRecord,
  source: RecoveredAssistantSource,
  now: string,
  interruptedStatus: "partial" | "failed" = "partial",
): Promise<boolean> {
  const session = await deps.storage.sessions.getBySessionId(trace.sessionId);
  const message: ChatMessageRecord = {
    messageId: source.messageId,
    sessionId: trace.sessionId,
    role: "assistant",
    actorType: "agent",
    actorId: "assistant",
    sourceAuthority: "agent_proposed",
    content: source.content,
    timestamp: source.timestamp,
  };
  const transcriptEvent: TranscriptEvent = {
    eventId: source.messageId,
    actionId: `chat-recovery:${trace.turnId}`,
    idempotencyKey: `chat-recovery:${trace.turnId}:${source.messageId}`,
    sessionId: trace.sessionId,
    sessionKey: session.sessionKey,
    timestamp: source.timestamp,
    type: "message.assistant",
    actorType: "agent",
    actorId: "assistant",
    sourceAuthority: "agent_proposed",
    payload: { message },
  };
  const wasAlreadyQueued = Boolean(await deps.storage.transcriptOutbox.get(source.messageId));
  await deps.storage.runImmediateTransaction(async () => {
    await deps.storage.chatMessages.upsert(message, now);
    await deps.storage.transcriptOutbox.enqueue(transcriptEvent, now);
    await deps.storage.chatTurnTraces.patch(trace.turnId, {
      assistantMessageId: source.messageId,
      status: source.final ? "completed" : interruptedStatus,
      failure: source.final ? undefined : buildInterruptedByRestartFailure(true),
      completion: {
        status: source.final ? "complete" : "interrupted",
        repaired: source.final ? Boolean(source.repaired) : false,
        ...(source.final && source.repair ? { repair: source.repair } : {}),
        ...(source.usage ? { usage: source.usage } : {}),
      },
      pendingUserInput: null,
      finishedAt: now,
    });
  });
  return !wasAlreadyQueued;
}

function boundRecoveredContent(value: string): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.byteLength <= MAX_RECOVERED_ASSISTANT_BYTES) {
    return value;
  }
  const marker = Buffer.from(RECOVERED_CONTENT_TRUNCATION_MARKER, "utf8");
  const contentBudget = Math.max(0, MAX_RECOVERED_ASSISTANT_BYTES - marker.byteLength);
  let retainedBytes = 0;
  let retainedCodeUnits = 0;
  for (const character of value) {
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (retainedBytes + characterBytes > contentBudget) {
      break;
    }
    retainedBytes += characterBytes;
    retainedCodeUnits += character.length;
  }
  const bounded = `${value.slice(0, retainedCodeUnits)}${RECOVERED_CONTENT_TRUNCATION_MARKER}`;
  if (Buffer.byteLength(bounded, "utf8") > MAX_RECOVERED_ASSISTANT_BYTES) {
    throw new Error("Recovered assistant prefix exceeded its UTF-8 byte cap.");
  }
  return bounded;
}

function appendRecoveredPrefix(current: string, delta: string): { content: string; truncated: boolean } {
  const markerBytes = Buffer.byteLength(RECOVERED_CONTENT_TRUNCATION_MARKER, "utf8");
  const rawBudget = MAX_RECOVERED_ASSISTANT_BYTES - markerBytes;
  const combined = `${current}${delta}`;
  if (Buffer.byteLength(combined, "utf8") <= rawBudget) {
    return { content: combined, truncated: false };
  }
  return { content: truncateUtf8ToBytes(combined, rawBudget), truncated: true };
}

function appendRecoveryPostureMarker(content: string, marker: string): string {
  const markerBytes = Buffer.byteLength(marker, "utf8");
  return `${truncateUtf8ToBytes(content, Math.max(0, MAX_RECOVERED_ASSISTANT_BYTES - markerBytes))}${marker}`;
}

function truncateUtf8ToBytes(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let retainedBytes = 0;
  let retainedCodeUnits = 0;
  for (const character of value) {
    const bytes = Buffer.byteLength(character, "utf8");
    if (retainedBytes + bytes > maxBytes) {
      break;
    }
    retainedBytes += bytes;
    retainedCodeUnits += character.length;
  }
  return value.slice(0, retainedCodeUnits);
}

function buildBoundedRecoveryDiagnostic(prefix: string, error: unknown): string {
  const rawMessage = `${prefix}: ${error instanceof Error ? error.message : String(error)}`;
  const redacted = redactStructuredSecrets(rawMessage).value;
  const normalized = String(redacted);
  if (Buffer.byteLength(normalized, "utf8") <= RECOVERY_DIAGNOSTIC_LIMIT_BYTES) {
    return normalized;
  }
  const markerBytes = Buffer.byteLength(RECOVERY_DIAGNOSTIC_TRUNCATION_MARKER, "utf8");
  return `${truncateUtf8ToBytes(
    normalized,
    Math.max(0, RECOVERY_DIAGNOSTIC_LIMIT_BYTES - markerBytes),
  )}${RECOVERY_DIAGNOSTIC_TRUNCATION_MARKER}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function isOwnedByLiveDurableRun(
  deps: ChatTurnInterruptionRecoveryDeps,
  trace: ChatTurnTraceRecord,
): Promise<boolean> {
  const runId = trace.durable?.runId;
  if (!runId) {
    return false;
  }
  let run: DurableRunRecord;
  try {
    run = await deps.storage.durableRuns.getRun(runId);
  } catch (error) {
    if (error instanceof NotFoundError) {
      return false;
    }
    throw error;
  }
  return !isDurableRunTerminal(run.status);
}

function buildInterruptedByRestartFailure(hasCompletedPrefix = false): ChatTurnFailureRecord {
  return {
    failureClass: "interrupted_by_restart",
    message: hasCompletedPrefix
      ? `${INTERRUPTED_BY_RESTART_MESSAGE} The completed response prefix was preserved.`
      : INTERRUPTED_BY_RESTART_MESSAGE,
    retryable: true,
    recommendedAction: hasCompletedPrefix ? "continue_from_partial" : "retry",
  };
}

/**
 * Create a failed trace for a user message whose turn died before any trace
 * was written. Mirrors the trace reconstruction in chat-turn-cancellation.ts:
 * modes come from session prefs with the same defaults, and the turn is
 * appended under the session's current active leaf so the thread renders it
 * where the vanished turn would have appeared.
 */
async function synthesizeInterruptedTrace(
  deps: ChatTurnInterruptionRecoveryDeps,
  orphan: { sessionId: string; messageId: string; timestamp: string },
  now: string,
): Promise<string> {
  const prefs = await deps.storage.chatSessionPrefs.get(orphan.sessionId);
  const parentTurnId = (await deps.storage.chatSessionBranchState.get(orphan.sessionId))?.activeLeafTurnId;
  const mode: ChatMode = prefs?.mode ?? "chat";
  const turnId = randomUUID();
  await deps.storage.chatTurnTraces.create({
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
  await deps.storage.chatSessionBranchState.setActiveLeafIfCurrent(orphan.sessionId, parentTurnId, turnId, now);
  return turnId;
}

async function announceInterruptedTurn(
  deps: ChatTurnInterruptionRecoveryDeps,
  sessionId: string,
  turnId: string,
  event: string,
  context: Record<string, unknown>,
): Promise<void> {
  recordDevDiagnosticSafely(deps, {
    level: "warn",
    category: "chat",
    event,
    message: INTERRUPTED_BY_RESTART_MESSAGE,
    sessionId,
    turnId,
    context,
  });
  try {
    await deps.publishRealtime(
      "chat_thread_updated",
      "chat",
      {
        type: "chat_thread_turn_interrupted",
        sessionId,
        turnId,
      },
      buildChatTurnRealtimeOptions({ sessionId, turnId }),
    );
  } catch (error) {
    // The durable recovery write is canonical; an operational notification
    // failure must never roll it back or cause the turn to be reclassified.
    recordDevDiagnosticSafely(deps, {
      level: "warn",
      category: "chat",
      event: "chat.turn.interruption_recovery_notification_failed",
      message: buildBoundedRecoveryDiagnostic(
        "Recovered turn state persisted but its realtime notification failed",
        error,
      ),
      sessionId,
      turnId,
    });
  }
}

function recordDevDiagnosticSafely(
  deps: ChatTurnInterruptionRecoveryDeps,
  input: Parameters<ChatTurnInterruptionRecoveryDeps["recordDevDiagnostic"]>[0],
): void {
  try {
    deps.recordDevDiagnostic(input);
  } catch (diagnosticError) {
    void diagnosticError;
    // Diagnostics are non-canonical. Recovery continues from durable state.
  }
}
