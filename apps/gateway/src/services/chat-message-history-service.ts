import { createHash } from "node:crypto";
import {
  redactStructuredSecrets,
  type ChatCompletionRequest,
  type ChatCompactionAttemptDisposition,
  type ChatCompactionBreakerRecord,
  type ChatCompactionStateRecord,
  type ChatInputPart,
  type ChatMessageRecord,
  type TranscriptEvent,
} from "@goatcitadel/contracts";
import { estimateTokensFromText } from "@goatcitadel/memory-core";
import { buildChatCompactionAttemptId, buildChatCompactionStateKey, type Storage } from "@goatcitadel/storage";
import { buildConversationCompactionSummary } from "./chat-compaction.js";
import type { LlmService } from "./llm-service.js";
import type { ChatTurnSessionState } from "./chat-turn-prep-service.js";

type ChatSystemInstructionContent = ChatCompletionRequest["messages"][number]["content"];

const CHAT_COMPACTION_RECENT_TURN_LIMIT = 6;
const CHAT_COMPACTION_WINDOW_SIZE = 8;
const CHAT_COMPACTION_TRIGGER_TOKENS = 2200;
const CHAT_COMPACTION_REARM_TOKENS = 1600;
const CHAT_COMPACTION_MIN_GROWTH_TOKENS = 600;
// Keep the durable boundary within the storage contract. Once a session grows
// beyond this prefix, the remaining turns stay verbatim instead of risking an
// oversized state write or silently dropping context.
const CHAT_COMPACTION_MAX_BOUNDARY_TURNS = 512;

export interface ChatCompactionDimension {
  dimensionHash: string;
  providerId?: string;
  model?: string;
  profileFingerprint?: string;
  /** False for the preflight-only history build before capability selection is sealed. */
  persistState?: boolean;
  /**
   * One-shot governed force evidence. Only a trusted Gateway action service
   * may construct this after binding the authenticated actor to the action.
   */
  forceAction?: {
    actionId: string;
    actorHash: string;
  };
}

export interface ChatMessageHistoryDependencies {
  readonly storage: Pick<Storage, "chatConversationSummaries">;
  readonly llmService: Pick<LlmService, "getRuntimeConfig">;
  readTranscriptOrEmpty(sessionId: string): Promise<TranscriptEvent[]>;
  loadChatTurnSessionState(sessionId: string): Promise<ChatTurnSessionState>;
  buildUserMessageContent(
    message: ChatMessageRecord,
    supportsVision: boolean,
  ): Promise<string | Array<Record<string, unknown>>>;
  /**
   * Resolves the per-model token-estimate multiplier (from model metadata) used
   * to size prompt-cache compaction. Optional: absent implies 1 (no scaling).
   */
  getModelTokenMultiplier?(providerId: string | undefined, model: string | undefined): number;
}

export async function buildLlmMessagesFromTranscript(
  deps: ChatMessageHistoryDependencies,
  sessionId: string,
  options?: {
    providerId?: string;
    model?: string;
    guidanceSystemInstruction?: ChatSystemInstructionContent;
    compactionDimension?: ChatCompactionDimension;
  },
): Promise<ChatCompletionRequest["messages"]> {
  const runtime = deps.llmService.getRuntimeConfig();
  const providerId = options?.providerId ?? runtime.activeProviderId;
  const providerSummary = runtime.providers.find((item) => item.providerId === providerId);
  const model = options?.model ?? providerSummary?.defaultModel ?? runtime.activeModel;
  const tokenMultiplier = deps.getModelTokenMultiplier?.(providerId, model) ?? 1;
  const supportsVision = Boolean(providerSummary?.capabilities?.vision || inferModelVisionSupport(model));
  const transcript = await deps.readTranscriptOrEmpty(sessionId);
  const mapped = await Promise.all(
    transcript
      .filter((event) => event.type === "message.user" || event.type === "message.assistant")
      .map(async (event) => {
        const payload = event.payload as {
          message?: {
            role?: string;
            content?: unknown;
            parts?: unknown;
            attachments?: unknown;
          };
        };
        const baseContent =
          typeof payload.message?.content === "string" ? payload.message.content : extractMessagePreview(event.payload);
        if (event.type === "message.user") {
          const userMessage: ChatMessageRecord = {
            messageId: event.eventId,
            sessionId,
            role: "user",
            actorType: "user",
            actorId: "operator",
            content: baseContent,
            timestamp: event.timestamp,
            parts: parseMessageParts(payload.message?.parts),
            attachments: parseMessageAttachments(payload.message?.attachments),
          };
          return {
            role: "user" as const,
            content: await deps.buildUserMessageContent(userMessage, supportsVision),
          };
        }
        return {
          role: "assistant" as const,
          content: redactStructuredSecrets(baseContent).value,
        };
      }),
  );
  const messages = await compactTranscriptMessages(deps, sessionId, transcript, mapped, tokenMultiplier);
  const guidanceSystemInstruction = normalizeGuidanceSystemInstruction(options?.guidanceSystemInstruction);
  if (guidanceSystemInstruction) {
    return [
      {
        role: "system",
        content: guidanceSystemInstruction,
      },
      ...messages,
    ];
  }
  return messages;
}

export async function buildLlmMessagesFromBranchPath(
  deps: ChatMessageHistoryDependencies,
  sessionId: string,
  pathTurnIds: string[],
  currentUserMessage: ChatMessageRecord | undefined,
  options?: {
    providerId?: string;
    model?: string;
    guidanceSystemInstruction?: ChatSystemInstructionContent;
    compactionDimension?: ChatCompactionDimension;
  },
  state?: ChatTurnSessionState,
): Promise<ChatCompletionRequest["messages"]> {
  const sessionState = state ?? (await deps.loadChatTurnSessionState(sessionId));
  const orderedMessages: ChatMessageRecord[] = [];
  const turnRecordsById = new Map<string, ChatMessageRecord[]>();
  for (const turnId of pathTurnIds) {
    const trace = sessionState.tracesById.get(turnId);
    if (!trace) {
      continue;
    }
    const userMessage = sessionState.messagesById.get(trace.userMessageId);
    const turnRecords: ChatMessageRecord[] = [];
    if (userMessage) {
      orderedMessages.push(userMessage);
      turnRecords.push(userMessage);
    }
    if (trace.assistantMessageId) {
      const assistantMessage = sessionState.messagesById.get(trace.assistantMessageId);
      if (assistantMessage) {
        orderedMessages.push(assistantMessage);
        turnRecords.push(assistantMessage);
      }
    }
    turnRecordsById.set(turnId, turnRecords);
  }
  if (currentUserMessage) {
    orderedMessages.push(currentUserMessage);
  }
  return buildLlmMessagesFromRecords(deps, orderedMessages, {
    ...options,
    sessionId,
    branchHeadTurnId: pathTurnIds.at(-1),
    branchTurnIds: pathTurnIds,
    turnRecordsById,
    sessionState,
  });
}

export function extractMessagePreview(payload: Record<string, unknown>): string {
  const content = payload.content;
  if (typeof content === "string") {
    return content.slice(0, 240);
  }
  if (Array.isArray(content)) {
    return JSON.stringify(content).slice(0, 240);
  }
  const message = payload.message;
  if (typeof message === "string") {
    return message.slice(0, 240);
  }
  return JSON.stringify(payload).slice(0, 240);
}

export function parseMessageParts(input: unknown): ChatMessageRecord["parts"] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const parts = input.map((item) => normalizeMessagePart(item)).filter((item): item is ChatInputPart => Boolean(item));
  return parts.length > 0 ? parts : undefined;
}

export function parseMessageAttachments(input: unknown): ChatMessageRecord["attachments"] | undefined {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const attachments = input
    .map((item) => {
      const value = item as Record<string, unknown>;
      const attachmentId = typeof value.attachmentId === "string" ? value.attachmentId : undefined;
      const fileName = typeof value.fileName === "string" ? value.fileName : undefined;
      const mimeType = typeof value.mimeType === "string" ? value.mimeType : undefined;
      const sizeBytes = typeof value.sizeBytes === "number" ? value.sizeBytes : undefined;
      if (!attachmentId || !fileName || !mimeType || sizeBytes === undefined) {
        return undefined;
      }
      return {
        attachmentId,
        fileName,
        mimeType,
        sizeBytes,
      };
    })
    .filter((item): item is NonNullable<ChatMessageRecord["attachments"]>[number] => Boolean(item));
  return attachments.length > 0 ? attachments : undefined;
}

async function buildLlmMessagesFromRecords(
  deps: ChatMessageHistoryDependencies,
  records: ChatMessageRecord[],
  options?: {
    providerId?: string;
    model?: string;
    guidanceSystemInstruction?: ChatSystemInstructionContent;
    sessionId?: string;
    branchHeadTurnId?: string;
    branchTurnIds?: string[];
    turnRecordsById?: Map<string, ChatMessageRecord[]>;
    sessionState?: ChatTurnSessionState;
    compactionDimension?: ChatCompactionDimension;
  },
): Promise<ChatCompletionRequest["messages"]> {
  const runtime = deps.llmService.getRuntimeConfig();
  const providerId = options?.providerId ?? runtime.activeProviderId;
  const providerSummary = runtime.providers.find((item) => item.providerId === providerId);
  const model = options?.model ?? providerSummary?.defaultModel ?? runtime.activeModel;
  const tokenMultiplier = deps.getModelTokenMultiplier?.(providerId, model) ?? 1;
  const supportsVision = Boolean(providerSummary?.capabilities?.vision || inferModelVisionSupport(model));
  const mapped = await Promise.all(
    records.map(async (message) => {
      if (message.role === "assistant") {
        return {
          role: "assistant" as const,
          content: redactStructuredSecrets(message.content).value,
        };
      }
      if (message.role === "system") {
        return {
          role: "system" as const,
          content: redactStructuredSecrets(message.content).value,
        };
      }
      return {
        role: "user" as const,
        content: await deps.buildUserMessageContent(message, supportsVision),
      };
    }),
  );
  const messages =
    options?.sessionId && options.branchTurnIds && options.branchTurnIds.length > 0
      ? await compactBranchMappedMessages(deps, {
          sessionId: options.sessionId,
          branchHeadTurnId: options.branchHeadTurnId ?? options.branchTurnIds.at(-1) ?? options.sessionId,
          branchTurnIds: options.branchTurnIds,
          turnRecordsById: options.turnRecordsById,
          sessionState: options.sessionState,
          records,
          mapped,
          tokenMultiplier,
          providerId,
          model,
          compactionDimension: options.compactionDimension,
        })
      : mapped;
  const guidanceSystemInstruction = normalizeGuidanceSystemInstruction(options?.guidanceSystemInstruction);
  if (!guidanceSystemInstruction) {
    return messages;
  }
  return [
    {
      role: "system",
      content: guidanceSystemInstruction,
    },
    ...messages,
  ];
}

function normalizeGuidanceSystemInstruction(
  input: ChatSystemInstructionContent | undefined,
): ChatSystemInstructionContent | undefined {
  if (typeof input === "string") {
    const trimmed = input.trim();
    return trimmed ? trimmed : undefined;
  }
  if (!Array.isArray(input)) {
    return undefined;
  }
  const blocks: Record<string, unknown>[] = [];
  for (const block of input) {
    if (!isRecord(block)) {
      continue;
    }
    const text = typeof block.text === "string" ? block.text.trim() : "";
    if (text) {
      blocks.push({ ...block, text });
    }
  }
  return blocks.length > 0 ? blocks : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

async function compactTranscriptMessages(
  _deps: ChatMessageHistoryDependencies,
  _sessionId: string,
  _transcript: TranscriptEvent[],
  mapped: ChatCompletionRequest["messages"],
  _tokenMultiplier = 1,
): Promise<ChatCompletionRequest["messages"]> {
  // Transcript-only callers do not supply sealed branch lineage, an exact
  // provider/model/profile dimension, or fresh provider usage. Running the
  // old stateless compactor here would bypass the persistent breaker and make
  // restart/fork behavior unverifiable, so compatibility history stays
  // verbatim. Canonical Chat routes through compactBranchMappedMessages.
  return mapped;
}

async function compactBranchMappedMessages(
  deps: ChatMessageHistoryDependencies,
  input: {
    sessionId: string;
    branchHeadTurnId: string;
    branchTurnIds: string[];
    turnRecordsById?: Map<string, ChatMessageRecord[]>;
    sessionState?: ChatTurnSessionState;
    records: ChatMessageRecord[];
    mapped: ChatCompletionRequest["messages"];
    tokenMultiplier?: number;
    providerId?: string;
    model?: string;
    compactionDimension?: ChatCompactionDimension;
  },
): Promise<ChatCompletionRequest["messages"]> {
  if (input.compactionDimension?.persistState === false) {
    return input.mapped;
  }
  const totalTokens = Math.ceil(
    estimateTokensFromText(stringifyMessagesForTokenEstimate(input.mapped)) * (input.tokenMultiplier ?? 1),
  );
  if (input.branchTurnIds.length <= CHAT_COMPACTION_RECENT_TURN_LIMIT) {
    return input.mapped;
  }

  const recentTurnIds = input.branchTurnIds.slice(-CHAT_COMPACTION_RECENT_TURN_LIMIT);
  const olderTurnIds = input.branchTurnIds.slice(0, Math.max(0, input.branchTurnIds.length - recentTurnIds.length));
  const grouped = input.turnRecordsById ?? buildBranchRecordGroups(input.branchTurnIds, input.records).turnMessagesById;
  const safeCompleteOlderTurnIds = collectSafeCompleteSummaryTurnIds(olderTurnIds, grouped).slice(
    0,
    CHAT_COMPACTION_MAX_BOUNDARY_TURNS,
  );
  if (safeCompleteOlderTurnIds.length === 0) {
    return input.mapped;
  }

  const dimension = input.compactionDimension ?? buildLegacyCompactionDimension(input.providerId, input.model);
  const summaryRepo = deps.storage.chatConversationSummaries;
  const breakerIdentity = {
    sessionId: input.sessionId,
    dimensionHash: dimension.dimensionHash,
    ...((dimension.providerId ?? input.providerId) ? { providerId: dimension.providerId ?? input.providerId } : {}),
    ...((dimension.model ?? input.model) ? { model: dimension.model ?? input.model } : {}),
    ...(dimension.profileFingerprint ? { profileFingerprint: dimension.profileFingerprint } : {}),
  };
  const supportsState =
    typeof summaryRepo.listCompactionStates === "function" && typeof summaryRepo.upsertCompactionState === "function";
  const supportsBreaker =
    typeof summaryRepo.getCompactionBreaker === "function" &&
    typeof summaryRepo.commitCompactionBoundary === "function" &&
    typeof summaryRepo.recordCompactionNoProgress === "function" &&
    typeof summaryRepo.observeCompactionEvidence === "function";
  const compatibleState = supportsState
    ? selectCompatibleCompactionState(
        summaryRepo.listCompactionStates(input.sessionId, dimension.dimensionHash),
        input.branchTurnIds,
        grouped,
      )
    : undefined;
  let breaker: ChatCompactionBreakerRecord | undefined;
  try {
    breaker = supportsBreaker ? summaryRepo.getCompactionBreaker(input.sessionId, dimension.dimensionHash) : undefined;
  } catch {
    // Durable anti-thrashing truth is safety state. If it cannot be read, do
    // not silently compact with a process-local approximation.
    return input.mapped;
  }
  if (breaker?.status === "blocked_corrupt") {
    return input.mapped;
  }

  const pendingEvidence = breaker?.pendingBranchHeadTurnId
    ? resolveExactFirstProviderUsage(
        input.sessionState,
        input.branchTurnIds,
        dimension,
        breaker.pendingBranchHeadTurnId,
      )
    : undefined;
  if (supportsBreaker && breaker?.pendingAttemptId && pendingEvidence) {
    try {
      breaker = summaryRepo.observeCompactionEvidence({
        ...breakerIdentity,
        evidenceTurnId: pendingEvidence.turnId,
        evidenceObservedTurnCount: pendingEvidence.observedTurnCount,
        reportedInputTokens: pendingEvidence.inputTokens,
        rearmTokens: CHAT_COMPACTION_REARM_TOKENS,
        triggerTokens: CHAT_COMPACTION_TRIGGER_TOKENS,
      });
    } catch {
      return input.mapped;
    }
  }
  if (breaker?.status === "blocked_corrupt") {
    return input.mapped;
  }

  let validatedForceAction: ChatCompactionDimension["forceAction"];
  if (dimension.forceAction) {
    if (!supportsBreaker || typeof summaryRepo.validatePendingCompactionBreakerForceAction !== "function") {
      return input.mapped;
    }
    try {
      const validation = summaryRepo.validatePendingCompactionBreakerForceAction({
        sessionId: input.sessionId,
        dimensionHash: dimension.dimensionHash,
        actionId: dimension.forceAction.actionId,
        actorHash: dimension.forceAction.actorHash,
      });
      breaker = validation.breaker;
      validatedForceAction = dimension.forceAction;
    } catch {
      return input.mapped;
    }
  }
  const latestExactUsage = resolveExactFirstProviderUsage(input.sessionState, input.branchTurnIds, dimension);
  const observedInputTokens = latestExactUsage?.inputTokens;

  let activeState = compatibleState;
  if (
    activeState &&
    !activeState.armed &&
    input.branchTurnIds.length > activeState.observedTurnCount &&
    observedInputTokens !== undefined &&
    observedInputTokens <= CHAT_COMPACTION_REARM_TOKENS
  ) {
    activeState = summaryRepo.upsertCompactionState({
      ...activeState,
      baselineInputTokens: observedInputTokens,
      lastObservedInputTokens: observedInputTokens,
      observedTurnCount: input.branchTurnIds.length,
      armed: true,
    });
  }

  const existingBoundaryCount = activeState?.boundaryTurnIds.length ?? 0;
  const hasCompleteNewWindow = safeCompleteOlderTurnIds.length >= existingBoundaryCount + CHAT_COMPACTION_WINDOW_SIZE;
  // A rough estimate may decide that an initial attempt is eligible. It never
  // judges whether a committed attempt was healthy; only exact provider usage
  // from a newer descendant can mutate breaker streaks.
  const initialTriggerTokens = observedInputTokens ?? totalTokens;
  const breakerAllowsAttempt = validatedForceAction
    ? breaker?.status === "tripped"
    : !breaker || breaker.status === "closed";
  const canCreateInitialBoundary =
    breakerAllowsAttempt &&
    !activeState &&
    (validatedForceAction
      ? safeCompleteOlderTurnIds.length >= CHAT_COMPACTION_WINDOW_SIZE
      : initialTriggerTokens >= CHAT_COMPACTION_TRIGGER_TOKENS);
  const canExtendBoundary = Boolean(
    breakerAllowsAttempt &&
    activeState &&
    hasCompleteNewWindow &&
    (validatedForceAction ||
      (activeState?.armed &&
        observedInputTokens !== undefined &&
        observedInputTokens >= CHAT_COMPACTION_TRIGGER_TOKENS &&
        observedInputTokens - activeState.baselineInputTokens >= CHAT_COMPACTION_MIN_GROWTH_TOKENS)),
  );
  const targetBoundaryTurnIds =
    canCreateInitialBoundary || canExtendBoundary ? safeCompleteOlderTurnIds : (activeState?.boundaryTurnIds ?? []);
  if (targetBoundaryTurnIds.length === 0) {
    return input.mapped;
  }

  const summaryMessages: ChatCompletionRequest["messages"] = [];
  const summaryDispositions: Array<Exclude<ChatCompactionAttemptDisposition, "no_progress">> = [];
  let completedBoundaryCount = 0;
  for (let index = 0; index < targetBoundaryTurnIds.length; index += CHAT_COMPACTION_WINDOW_SIZE) {
    const windowTurnIds = targetBoundaryTurnIds.slice(index, index + CHAT_COMPACTION_WINDOW_SIZE);
    if (windowTurnIds.length !== CHAT_COMPACTION_WINDOW_SIZE) {
      break;
    }
    const windowMessages = windowTurnIds.flatMap((turnId) => grouped.get(turnId) ?? []);
    const summaryResult = getOrCreateConversationSummary(deps, {
      sessionId: input.sessionId,
      branchHeadTurnId: input.branchHeadTurnId,
      turnIds: windowTurnIds,
      messages: windowMessages,
    });
    if (!summaryResult) {
      break;
    }
    summaryMessages.push({
      role: "system",
      content: summaryResult.summary,
    });
    summaryDispositions.push(summaryResult.disposition);
    completedBoundaryCount += windowTurnIds.length;
  }

  if (completedBoundaryCount < existingBoundaryCount) {
    // A corrupt/missing persisted window must fail closed. Returning the full
    // prompt is safer than silently rolling a durable boundary backward.
    return input.mapped;
  }
  const completedBoundaryTurnIds = targetBoundaryTurnIds.slice(0, completedBoundaryCount);
  const attemptedNewBoundary = canCreateInitialBoundary || canExtendBoundary;
  if (supportsBreaker && attemptedNewBoundary && completedBoundaryCount === existingBoundaryCount) {
    const attemptedSourceHash = hashBranchTurnSource(targetBoundaryTurnIds, grouped);
    const attemptId = buildChatCompactionAttemptId({
      ...breakerIdentity,
      branchHeadTurnId: input.branchHeadTurnId,
      observedTurnCount: input.branchTurnIds.length,
      boundarySourceHash: attemptedSourceHash,
      disposition: "no_progress",
    });
    try {
      breaker = summaryRepo.recordCompactionNoProgress({
        ...breakerIdentity,
        attemptId,
        branchHeadTurnId: input.branchHeadTurnId,
        observedTurnCount: input.branchTurnIds.length,
        attemptedBoundarySourceHash: attemptedSourceHash,
        expectedBreakerRevision: breaker?.revision,
        ...(validatedForceAction ? { forceAction: validatedForceAction } : {}),
      });
    } catch {
      return input.mapped;
    }
  }
  if (supportsState && completedBoundaryTurnIds.length > existingBoundaryCount && attemptedNewBoundary) {
    const boundarySourceHash = hashBranchTurnSource(completedBoundaryTurnIds, grouped);
    const nextState = {
      stateKey: buildChatCompactionStateKey(
        input.sessionId,
        dimension.dimensionHash,
        completedBoundaryTurnIds,
        boundarySourceHash,
      ),
      ...breakerIdentity,
      boundaryTurnIds: completedBoundaryTurnIds,
      boundarySourceHash,
      baselineInputTokens: observedInputTokens ?? totalTokens,
      lastObservedInputTokens: observedInputTokens ?? totalTokens,
      observedTurnCount: input.branchTurnIds.length,
      armed: false,
    };
    const existingWindowCount = existingBoundaryCount / CHAT_COMPACTION_WINDOW_SIZE;
    const disposition = summaryDispositions.slice(existingWindowCount).includes("fallback") ? "fallback" : "structured";
    const attemptId = buildChatCompactionAttemptId({
      ...breakerIdentity,
      branchHeadTurnId: input.branchHeadTurnId,
      observedTurnCount: input.branchTurnIds.length,
      boundarySourceHash,
      disposition,
    });
    try {
      if (supportsBreaker) {
        const committed = summaryRepo.commitCompactionBoundary({
          state: nextState,
          attemptId,
          branchHeadTurnId: input.branchHeadTurnId,
          disposition,
          expectedBreakerRevision: breaker?.revision,
          ...(validatedForceAction ? { forceAction: validatedForceAction } : {}),
        });
        activeState = committed.state;
        breaker = committed.breaker;
      } else {
        activeState = summaryRepo.upsertCompactionState(nextState);
      }
    } catch {
      // A lost response after a successful concurrent commit is safe to
      // recover only when the exact attempt and exact boundary are durable.
      // If the same breaker revision is still current, the eligible attempt
      // genuinely failed to commit and receives one idempotent no-progress
      // strike. Revision drift belongs to another writer and is not charged.
      if (!supportsBreaker) {
        return input.mapped;
      }
      try {
        const refreshedBreaker = summaryRepo.getCompactionBreaker(input.sessionId, dimension.dimensionHash);
        if (refreshedBreaker?.pendingAttemptId === attemptId || refreshedBreaker?.lastAttemptId === attemptId) {
          const durableState = summaryRepo
            .listCompactionStates(input.sessionId, dimension.dimensionHash)
            .find((state) => state.stateKey === nextState.stateKey);
          if (!durableState) {
            return input.mapped;
          }
          activeState = durableState;
          breaker = refreshedBreaker;
        } else {
          const breakerRevisionUnchanged = breaker
            ? refreshedBreaker?.revision === breaker.revision
            : refreshedBreaker === undefined;
          if (!breakerRevisionUnchanged) {
            return input.mapped;
          }
          const noProgressAttemptId = buildChatCompactionAttemptId({
            ...breakerIdentity,
            branchHeadTurnId: input.branchHeadTurnId,
            observedTurnCount: input.branchTurnIds.length,
            boundarySourceHash,
            disposition: "no_progress",
          });
          breaker = summaryRepo.recordCompactionNoProgress({
            ...breakerIdentity,
            attemptId: noProgressAttemptId,
            branchHeadTurnId: input.branchHeadTurnId,
            observedTurnCount: input.branchTurnIds.length,
            attemptedBoundarySourceHash: boundarySourceHash,
            expectedBreakerRevision: refreshedBreaker?.revision,
            ...(validatedForceAction ? { forceAction: validatedForceAction } : {}),
          });
          return input.mapped;
        }
      } catch {
        return input.mapped;
      }
    }
  }

  const renderedBoundaryCount = activeState?.boundaryTurnIds.length ?? completedBoundaryCount;
  const summarizedMessageIds = new Set(
    input.branchTurnIds
      .slice(0, renderedBoundaryCount)
      .flatMap((turnId) => grouped.get(turnId) ?? [])
      .map((message) => message.messageId),
  );
  const mappedVerbatim = input.records.flatMap((message, index) =>
    summarizedMessageIds.has(message.messageId) ? [] : [input.mapped[index]!],
  );
  return [...summaryMessages.slice(0, renderedBoundaryCount / CHAT_COMPACTION_WINDOW_SIZE), ...mappedVerbatim];
}

interface ConversationCompactionSummaryResult {
  summary: string;
  disposition: Exclude<ChatCompactionAttemptDisposition, "no_progress">;
}

function getOrCreateConversationSummary(
  deps: ChatMessageHistoryDependencies,
  input: {
    sessionId: string;
    branchHeadTurnId: string;
    turnIds: string[];
    messages: ChatMessageRecord[];
  },
): ConversationCompactionSummaryResult | undefined {
  if (input.turnIds.length === 0 || input.messages.length === 0) {
    return undefined;
  }
  if (input.turnIds.length !== CHAT_COMPACTION_WINDOW_SIZE || input.messages.some(hasRichMessageContent)) {
    return undefined;
  }
  const source = serializeSummarySource(input.turnIds, input.messages);
  if (!source) {
    return undefined;
  }
  const sourceHash = createHash("sha256").update(source).digest("hex");
  const summaryRepo = deps.storage.chatConversationSummaries;
  try {
    const existing =
      typeof summaryRepo.findReusableWindow === "function"
        ? summaryRepo.findReusableWindow({ sessionId: input.sessionId, turnIds: input.turnIds, sourceHash })
        : (typeof summaryRepo.listBySession === "function"
            ? summaryRepo.listBySession(input.sessionId, 128)
            : summaryRepo.listByBranch(input.sessionId, input.branchHeadTurnId)
          ).find((summary) => summary.sourceHash === sourceHash && arraysEqual(summary.turnIds, input.turnIds));
    if (existing) {
      return {
        summary: existing.summary,
        disposition: isStructuredConversationSummary(existing.summary) ? "structured" : "fallback",
      };
    }
    const summary = buildConversationCompactionSummary(input.messages);
    if (!summary) {
      return undefined;
    }
    const persisted = deps.storage.chatConversationSummaries.upsert({
      sessionId: input.sessionId,
      branchHeadTurnId: input.branchHeadTurnId,
      startTurnId: input.turnIds[0]!,
      endTurnId: input.turnIds.at(-1)!,
      turnIds: input.turnIds,
      sourceHash,
      tokenEstimate: estimateTokensFromText(source),
      summary,
    });
    return {
      summary: persisted.summary,
      disposition:
        persisted.summary === summary || isStructuredConversationSummary(persisted.summary) ? "structured" : "fallback",
    };
  } catch (storageError) {
    // Corrupt/oversized legacy rows can collide with the exact-window key. A
    // full verbatim prompt is the safe fallback; never omit the window.
    void storageError;
    return undefined;
  }
}

function isStructuredConversationSummary(summary: string): boolean {
  return summary.trimStart().startsWith("Compacted conversation context.");
}

function collectSafeCompleteSummaryTurnIds(
  olderTurnIds: string[],
  grouped: Map<string, ChatMessageRecord[]>,
): string[] {
  const safeTurnIds: string[] = [];
  const completeTurnCount = Math.floor(olderTurnIds.length / CHAT_COMPACTION_WINDOW_SIZE) * CHAT_COMPACTION_WINDOW_SIZE;
  for (let index = 0; index < completeTurnCount; index += CHAT_COMPACTION_WINDOW_SIZE) {
    const windowTurnIds = olderTurnIds.slice(index, index + CHAT_COMPACTION_WINDOW_SIZE);
    const windowRecords = windowTurnIds.flatMap((turnId) => grouped.get(turnId) ?? []);
    const hasCompleteTurns = windowTurnIds.every((turnId) => {
      const records = grouped.get(turnId) ?? [];
      return records.some((record) => record.role === "user") && records.some((record) => record.role === "assistant");
    });
    if (!hasCompleteTurns || windowRecords.length === 0 || windowRecords.some(hasRichMessageContent)) {
      break;
    }
    safeTurnIds.push(...windowTurnIds);
  }
  return safeTurnIds;
}

function selectCompatibleCompactionState(
  states: ChatCompactionStateRecord[],
  branchTurnIds: string[],
  grouped: Map<string, ChatMessageRecord[]>,
): ChatCompactionStateRecord | undefined {
  return states
    .filter((state) => isExactPrefix(state.boundaryTurnIds, branchTurnIds))
    .filter((state) => state.boundarySourceHash === hashBranchTurnSource(state.boundaryTurnIds, grouped))
    .sort((left, right) => right.boundaryTurnIds.length - left.boundaryTurnIds.length)[0];
}

interface ExactFirstProviderUsage {
  turnId: string;
  inputTokens: number;
  observedTurnCount: number;
}

function resolveExactFirstProviderUsage(
  state: ChatTurnSessionState | undefined,
  branchTurnIds: string[],
  dimension: ChatCompactionDimension,
  afterTurnId?: string,
): ExactFirstProviderUsage | undefined {
  if (!state || !dimension.providerId || !dimension.model) {
    return undefined;
  }
  const evidenceIndex = branchTurnIds.length - 1;
  const afterIndex = afterTurnId === undefined ? -1 : branchTurnIds.lastIndexOf(afterTurnId);
  if (evidenceIndex < 0 || (afterTurnId !== undefined && (afterIndex < 0 || evidenceIndex <= afterIndex))) {
    return undefined;
  }
  const turnId = branchTurnIds[evidenceIndex]!;
  const trace = state.tracesById.get(turnId);
  if (trace?.status !== "completed") {
    return undefined;
  }
  const usage = trace.completion?.firstProviderRequestUsage;
  if (
    usage?.source !== "provider_reported" ||
    usage.availability !== "reported" ||
    usage.compactionDimensionHash !== dimension.dimensionHash ||
    usage.providerId !== dimension.providerId ||
    usage.model !== dimension.model ||
    !Number.isSafeInteger(usage.reportedInputTokens) ||
    usage.reportedInputTokens! < 0 ||
    usage.effectiveInputTokens !== usage.reportedInputTokens
  ) {
    // The dimension hash seals the provider/model/profile fingerprint. A
    // deterministic estimate, mismatched route, failed turn, or malformed
    // provider receipt is never allowed to judge breaker effectiveness.
    return undefined;
  }
  return {
    turnId,
    inputTokens: usage.reportedInputTokens,
    observedTurnCount: branchTurnIds.length,
  };
}

function buildLegacyCompactionDimension(
  providerId: string | undefined,
  model: string | undefined,
): ChatCompactionDimension {
  const dimensionSource = JSON.stringify({
    version: 1,
    providerId: providerId ?? null,
    model: model ?? null,
    profile: null,
  });
  return {
    dimensionHash: createHash("sha256").update(dimensionSource).digest("hex"),
    providerId,
    model,
  };
}

function hashBranchTurnSource(turnIds: string[], grouped: Map<string, ChatMessageRecord[]>): string {
  const records = turnIds.flatMap((turnId) => grouped.get(turnId) ?? []);
  return createHash("sha256").update(serializeSummarySource(turnIds, records)).digest("hex");
}

function serializeSummarySource(turnIds: string[], messages: ChatMessageRecord[]): string {
  return JSON.stringify({
    version: 1,
    turnIds,
    messages: messages.map((message) => ({
      messageId: message.messageId,
      role: message.role,
      content: message.content,
      parts: message.parts ?? null,
      attachments: message.attachments ?? null,
    })),
  });
}

function hasRichMessageContent(message: ChatMessageRecord): boolean {
  return Boolean(message.attachments?.length || message.parts?.length);
}

function isExactPrefix(prefix: string[], path: string[]): boolean {
  return prefix.length <= path.length && prefix.every((turnId, index) => turnId === path[index]);
}

function arraysEqual(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeMessagePart(input: unknown): ChatInputPart | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const value = input as Record<string, unknown>;
  const type = typeof value.type === "string" ? value.type : undefined;
  if (!type) {
    return undefined;
  }
  if (type === "text") {
    const text = typeof value.text === "string" ? value.text : undefined;
    return text !== undefined ? { type: "text", text } : undefined;
  }
  if (type === "image_ref") {
    const attachmentId = typeof value.attachmentId === "string" ? value.attachmentId : undefined;
    if (!attachmentId) {
      return undefined;
    }
    return {
      type,
      attachmentId,
      mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
      detail: value.detail === "low" || value.detail === "high" || value.detail === "auto" ? value.detail : undefined,
    };
  }
  if (type === "audio_ref" || type === "video_ref" || type === "file_ref") {
    const attachmentId = typeof value.attachmentId === "string" ? value.attachmentId : undefined;
    if (!attachmentId) {
      return undefined;
    }
    return {
      type,
      attachmentId,
      mimeType: typeof value.mimeType === "string" ? value.mimeType : undefined,
    };
  }
  return undefined;
}

function inferModelVisionSupport(model: string): boolean {
  const normalized = model.toLowerCase();
  return (
    normalized.includes("vision") ||
    normalized.includes("gpt-4o") ||
    normalized.includes("gpt-4.1") ||
    normalized.includes("gemini") ||
    normalized.includes("claude-3") ||
    normalized.includes("kimi") ||
    normalized.includes("glm")
  );
}

function stringifyMessagesForTokenEstimate(messages: ChatCompletionRequest["messages"]): string {
  return messages
    .map((message) => {
      const content = typeof message.content === "string" ? message.content : extractStringFromUnknown(message.content);
      return `${message.role.toUpperCase()}: ${content}`;
    })
    .join("\n\n");
}

function extractStringFromUnknown(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => extractStringFromUnknown(item)).join("\n");
  }
  if (value && typeof value === "object") {
    return Object.values(value as Record<string, unknown>)
      .map((item) => extractStringFromUnknown(item))
      .join("\n");
  }
  return "";
}

function buildBranchRecordGroups(
  branchTurnIds: string[],
  records: ChatMessageRecord[],
): {
  turnMessagesById: Map<string, ChatMessageRecord[]>;
  trailingMessages: ChatMessageRecord[];
} {
  const turnMessagesById = new Map<string, ChatMessageRecord[]>();
  let cursor = 0;
  for (const turnId of branchTurnIds) {
    const turnMessages: ChatMessageRecord[] = [];
    if (cursor < records.length) {
      turnMessages.push(records[cursor]!);
      cursor += 1;
    }
    if (cursor < records.length && records[cursor]?.role === "assistant") {
      turnMessages.push(records[cursor]!);
      cursor += 1;
    }
    turnMessagesById.set(turnId, turnMessages);
  }
  return {
    turnMessagesById,
    trailingMessages: records.slice(cursor),
  };
}
