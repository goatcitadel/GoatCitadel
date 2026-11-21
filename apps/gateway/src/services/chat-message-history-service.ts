import { resolveExactFirstProviderUsage, buildLegacyCompactionDimension } from "./chat-compaction-provider-evidence.js";
import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  redactStructuredSecrets,
  type ChatContinuityLedgerV1,
  type ChatContinuityCanonicalLink,
  type ChatCompletionRequest,
  type ChatCompactionAttemptDisposition,
  type ChatCompactionBreakerRecord,
  type ChatCompactionStateRecord,
  type ChatInputPart,
  type ChatMessageRecord,
  type TranscriptEvent,
} from "@goatcitadel/contracts";
import { estimateTokensFromText } from "@goatcitadel/memory-core";
import {
  buildChatCompactionAttemptId,
  buildChatCompactionStateKey,
  type AsyncStorage as Storage,
} from "@goatcitadel/storage";
import { renderConversationSummaryForModel } from "./chat-compaction.js";
import { buildChatContinuityLedger, renderChatContinuityLedger } from "./chat-continuity-ledger.js";
import { estimateFirstProviderRequestInputTokens } from "./chat-agent-prompt-budget-receipt.js";
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
  readonly llmService: Pick<LlmService, "getRuntimeConfig"> &
    Partial<Pick<LlmService, "getModelContextWindow" | "getModelOutputTokenLimit">>;
  resolveContinuityLinks?(
    sessionId: string,
    turnIds: string[],
  ): Promise<{ links: ChatContinuityCanonicalLink[]; complete: boolean }>;
  readTranscriptOrEmpty(sessionId: string): Promise<TranscriptEvent[]>;
  loadChatTurnSessionState(sessionId: string): Promise<ChatTurnSessionState>;
  /** `codeModeRequestEligible`: whether this turn is offered `code_mode.request` (attachment hints name its tools). */
  buildUserMessageContent(
    message: ChatMessageRecord,
    supportsVision: boolean,
    codeModeRequestEligible: boolean,
  ): Promise<string | Array<Record<string, unknown>>>;
  /**
   * Resolves the per-model token-estimate multiplier (from model metadata) used
   * to size prompt-cache compaction. Optional: absent implies 1 (no scaling).
   */
  getModelTokenMultiplier?(providerId: string | undefined, model: string | undefined): number;
  /** Gateway-owned lifecycle evidence; no source or summary text crosses this boundary. */
  onCompaction?(input: {
    phase: "before" | "after";
    sessionId: string;
    branchHeadTurnId: string;
    startTurnId: string;
    endTurnId: string;
    turnCount: number;
    sourceHash: string;
    summaryHash?: string;
  }): Promise<void>;
}

function resolveHistoryModel(deps: ChatMessageHistoryDependencies, options?: { providerId?: string; model?: string }) {
  const runtime = deps.llmService.getRuntimeConfig();
  const providerId = options?.providerId ?? runtime.activeProviderId;
  const provider = runtime.providers.find((item) => item.providerId === providerId);
  const model = options?.model ?? provider?.defaultModel ?? runtime.activeModel;
  const tokenMultiplier = deps.getModelTokenMultiplier?.(providerId, model) ?? 1;
  const supportsVision = Boolean(provider?.capabilities?.vision || inferModelVisionSupport(model));
  return { providerId, model, tokenMultiplier, supportsVision };
}

export async function buildLlmMessagesFromTranscript(
  deps: ChatMessageHistoryDependencies,
  sessionId: string,
  options?: {
    providerId?: string;
    model?: string;
    guidanceSystemInstruction?: ChatSystemInstructionContent;
    compactionDimension?: ChatCompactionDimension;
    /** Bounded, canonical durable-state context retained outside transcript summaries. */
    agenticStateCapsule?: string;
    /** Turn ids that must remain verbatim while their durable aggregate is active. */
    protectedTurnIds?: readonly string[];
  },
): Promise<ChatCompletionRequest["messages"]> {
  const { tokenMultiplier, supportsVision } = resolveHistoryModel(deps, options);
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
            sourceAuthority: event.sourceAuthority ?? "unknown",
            content: baseContent,
            timestamp: event.timestamp,
            parts: parseMessageParts(payload.message?.parts),
            attachments: parseMessageAttachments(payload.message?.attachments),
          };
          return {
            role: "user" as const,
            content: await deps.buildUserMessageContent(userMessage, supportsVision, false),
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
    /** Bounded, canonical durable-state context retained outside transcript summaries. */
    agenticStateCapsule?: string;
    /** Turn ids that must remain verbatim while their durable aggregate is active. */
    protectedTurnIds?: readonly string[];
    /** Whether this turn is offered `code_mode.request`; absent means not offered. */
    codeModeRequestEligible?: boolean;
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
  return await buildLlmMessagesFromRecords(deps, orderedMessages, {
    ...options,
    sessionId,
    branchHeadTurnId: pathTurnIds.at(-1),
    branchTurnIds: pathTurnIds,
    turnRecordsById,
    sessionState,
    agenticStateCapsule: options?.agenticStateCapsule,
    protectedTurnIds: options?.protectedTurnIds,
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
    agenticStateCapsule?: string;
    protectedTurnIds?: readonly string[];
    codeModeRequestEligible?: boolean;
  },
): Promise<ChatCompletionRequest["messages"]> {
  const { providerId, model, tokenMultiplier, supportsVision } = resolveHistoryModel(deps, options);
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
        content: await deps.buildUserMessageContent(message, supportsVision, options?.codeModeRequestEligible === true),
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
          systemContextText: [
            typeof options.guidanceSystemInstruction === "string" ? options.guidanceSystemInstruction : "",
            options.agenticStateCapsule ?? "",
          ]
            .filter(Boolean)
            .join("\n"),
          protectedTurnIds: options.protectedTurnIds,
        })
      : mapped;
  const guidanceSystemInstruction = normalizeGuidanceSystemInstruction(options?.guidanceSystemInstruction);
  const agenticStateCapsule = normalizeAgenticStateCapsule(options?.agenticStateCapsule);
  if (!guidanceSystemInstruction && !agenticStateCapsule) {
    return messages;
  }
  return [
    ...(guidanceSystemInstruction ? [{ role: "system" as const, content: guidanceSystemInstruction }] : []),
    ...(agenticStateCapsule ? [{ role: "system" as const, content: agenticStateCapsule }] : []),
    ...messages,
  ];
}

function normalizeAgenticStateCapsule(input: string | undefined): string | undefined {
  const trimmed = input?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 6_000 ? trimmed.slice(0, 6_000) : trimmed;
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
    /** System context counts toward prompt pressure without being summarized as transcript content. */
    systemContextText?: string;
    /** Active durable aggregate parents stay outside a compaction boundary. */
    protectedTurnIds?: readonly string[];
  },
): Promise<ChatCompletionRequest["messages"]> {
  if (input.compactionDimension?.persistState === false) {
    return input.mapped;
  }
  const totalTokens = Math.ceil(
    estimateTokensFromText(`${input.systemContextText ?? ""}\n${stringifyMessagesForTokenEstimate(input.mapped)}`) *
      (input.tokenMultiplier ?? 1),
  );
  if (input.branchTurnIds.length <= CHAT_COMPACTION_RECENT_TURN_LIMIT) {
    return input.mapped;
  }

  const recentTurnIds = input.branchTurnIds.slice(-CHAT_COMPACTION_RECENT_TURN_LIMIT);
  const olderTurnIds = input.branchTurnIds.slice(0, Math.max(0, input.branchTurnIds.length - recentTurnIds.length));
  const grouped = input.turnRecordsById ?? buildBranchRecordGroups(input.branchTurnIds, input.records).turnMessagesById;
  const protectedTurnIds = new Set(input.protectedTurnIds ?? []);
  const safePrefixTurnIds = collectSafeCompleteSummaryTurnIds(olderTurnIds, grouped);
  // A summary boundary is always an exact *contiguous prefix* of the branch.
  // Filtering an active parent out of a later window would make the resulting
  // list non-contiguous, then the render path could hide that protected turn
  // while calculating a count-based prefix. Stop before it instead.
  const firstProtectedIndex = safePrefixTurnIds.findIndex((turnId) => protectedTurnIds.has(turnId));
  const compactablePrefixTurnIds =
    firstProtectedIndex >= 0 ? safePrefixTurnIds.slice(0, firstProtectedIndex) : safePrefixTurnIds;
  const compactableBoundaryLength =
    Math.floor(
      Math.min(compactablePrefixTurnIds.length, CHAT_COMPACTION_MAX_BOUNDARY_TURNS) / CHAT_COMPACTION_WINDOW_SIZE,
    ) * CHAT_COMPACTION_WINDOW_SIZE;
  const safeCompleteOlderTurnIds = compactablePrefixTurnIds.slice(0, compactableBoundaryLength);
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
  const selectedCompatibleState = supportsState
    ? selectCompatibleCompactionState(
        await summaryRepo.listCompactionStates(input.sessionId, dimension.dimensionHash),
        input.branchTurnIds,
        grouped,
      )
    : undefined;
  // A previously valid boundary can become unsafe once a durable aggregate is
  // admitted for one of its parent turns. Keep that parent tail verbatim until
  // the aggregate reaches a terminal state; never let an old summary hide it.
  const compatibleState = selectedCompatibleState?.boundaryTurnIds.some((turnId) => protectedTurnIds.has(turnId))
    ? undefined
    : selectedCompatibleState;
  let breaker: ChatCompactionBreakerRecord | undefined;
  try {
    breaker = supportsBreaker
      ? await summaryRepo.getCompactionBreaker(input.sessionId, dimension.dimensionHash)
      : undefined;
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
      breaker = await summaryRepo.observeCompactionEvidence({
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
      const validation = await summaryRepo.validatePendingCompactionBreakerForceAction({
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
    activeState = await summaryRepo.upsertCompactionState({
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

  const continuityWindows: ChatContinuityLedgerV1[] = [];
  const summaryDispositions: Array<Exclude<ChatCompactionAttemptDisposition, "no_progress">> = [];
  let completedBoundaryCount = 0;
  for (let index = 0; index < targetBoundaryTurnIds.length; index += CHAT_COMPACTION_WINDOW_SIZE) {
    const windowTurnIds = targetBoundaryTurnIds.slice(index, index + CHAT_COMPACTION_WINDOW_SIZE);
    if (windowTurnIds.length !== CHAT_COMPACTION_WINDOW_SIZE) {
      break;
    }
    const windowMessages = windowTurnIds.flatMap((turnId) => grouped.get(turnId) ?? []);
    const summaryResult = await getOrCreateConversationSummary(deps, {
      sessionId: input.sessionId,
      branchHeadTurnId: input.branchHeadTurnId,
      turnIds: windowTurnIds,
      messages: windowMessages,
    });
    if (!summaryResult) {
      break;
    }
    continuityWindows.push(summaryResult.ledger);
    summaryDispositions.push(summaryResult.disposition);
    completedBoundaryCount += windowTurnIds.length;
  }

  if (completedBoundaryCount < existingBoundaryCount) {
    // A corrupt/missing persisted window must fail closed. Returning the full
    // prompt is safer than silently rolling a durable boundary backward.
    return input.mapped;
  }
  const completedBoundaryTurnIds = targetBoundaryTurnIds.slice(0, completedBoundaryCount);
  // Validate the *combined* continuity context before committing a durable
  // boundary. A per-window budget would grow without bound over long chats.
  if (completedBoundaryCount > 0 && !renderBoundaryContinuity(completedBoundaryCount)) return input.mapped;
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
      breaker = await summaryRepo.recordCompactionNoProgress({
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
        const committed = await summaryRepo.commitCompactionBoundary({
          state: nextState,
          attemptId,
          branchHeadTurnId: input.branchHeadTurnId,
          disposition,
          expectedBreakerRevision: breaker?.revision,
          ...(validatedForceAction ? { forceAction: validatedForceAction } : {}),
        });
        activeState = committed.state;
      } else {
        activeState = await summaryRepo.upsertCompactionState(nextState);
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
        const refreshedBreaker = await summaryRepo.getCompactionBreaker(input.sessionId, dimension.dimensionHash);
        if (refreshedBreaker?.pendingAttemptId === attemptId || refreshedBreaker?.lastAttemptId === attemptId) {
          const durableState = (await summaryRepo.listCompactionStates(input.sessionId, dimension.dimensionHash)).find(
            (state) => state.stateKey === nextState.stateKey,
          );
          if (!durableState) {
            return input.mapped;
          }
          activeState = durableState;
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
          // The returned record is intentionally discarded: this path always
          // returns the unmapped prompt, so no later read observes `breaker`.
          await summaryRepo.recordCompactionNoProgress({
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
  return renderBoundaryContinuity(renderedBoundaryCount) ?? input.mapped;

  function renderBoundaryContinuity(count: number): ChatCompletionRequest["messages"] | undefined {
    if (count === 0) return input.mapped;
    const windows = continuityWindows.slice(0, count / CHAT_COMPACTION_WINDOW_SIZE);
    if (windows.length * CHAT_COMPACTION_WINDOW_SIZE !== count) return undefined;
    const summarizedMessageIds = new Set(
      input.branchTurnIds
        .slice(0, count)
        .flatMap((turnId) => grouped.get(turnId) ?? [])
        .map((message) => message.messageId),
    );
    const tail = input.records.flatMap((message, index) =>
      summarizedMessageIds.has(message.messageId) ? [] : [input.mapped[index]!],
    );
    const contextWindow =
      input.providerId && input.model
        ? deps.llmService.getModelContextWindow?.(input.providerId, input.model)
        : undefined;
    const outputCeiling =
      input.providerId && input.model
        ? deps.llmService.getModelOutputTokenLimit?.(input.providerId, input.model)
        : undefined;
    const multiplier = Math.max(1, input.tokenMultiplier ?? 1);
    // Reserve the route's entire known output ceiling, schema budget and
    // framing. Final routed-context admission still owns the full request.
    const baseEstimate = estimateFirstProviderRequestInputTokens({
      messages: [{ role: "system", content: input.systemContextText ?? "" }, ...tail],
    });
    const remaining =
      contextWindow === undefined
        ? 2000
        : Math.floor((contextWindow - (outputCeiling ?? 4096) - 2200) / multiplier) - baseEstimate - 160;
    const ledger: ChatContinuityLedgerV1 = {
      version: 1,
      sourceHash: createHash("sha256")
        .update(windows.map((window) => window.sourceHash).join(":"))
        .digest("hex"),
      turnIds: windows.flatMap((window) => window.turnIds),
      entries: windows.flatMap((window) => window.entries),
      omittedSourceRefs: windows.flatMap((window) => window.omittedSourceRefs),
      originalAsk: windows[0]?.originalAsk,
      latestAsk: windows.at(-1)?.latestAsk,
    };
    const rendered = renderChatContinuityLedger(ledger, { maxTokens: Math.min(2000, remaining) });
    if (rendered.requiresSourceExpansion || !rendered.text) return undefined;
    return [
      {
        role: "system",
        content: renderConversationSummaryForModel(`Compacted conversation context.\n${rendered.text}`),
      },
      ...tail,
    ];
  }
}

interface ConversationCompactionSummaryResult {
  summary: string;
  ledger: ChatContinuityLedgerV1;
  disposition: Exclude<ChatCompactionAttemptDisposition, "no_progress">;
}

async function getOrCreateConversationSummary(
  deps: ChatMessageHistoryDependencies,
  input: {
    sessionId: string;
    branchHeadTurnId: string;
    turnIds: string[];
    messages: ChatMessageRecord[];
  },
): Promise<ConversationCompactionSummaryResult | undefined> {
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
  const summaryRepo = deps.storage.chatConversationSummaries;
  try {
    const resolveContinuityLinks = deps.resolveContinuityLinks;
    const canonical = resolveContinuityLinks
      ? await resolveContinuityLinks.call(deps, input.sessionId, input.turnIds)
      : { links: [], complete: true };
    if (!canonical.complete) return undefined;
    const ledger = buildChatContinuityLedger({
      messages: input.messages,
      turnIds: input.turnIds,
      canonicalLinks: canonical.links,
    });
    const sourceHash = ledger.sourceHash;
    const existing =
      typeof summaryRepo.findReusableWindow === "function"
        ? await summaryRepo.findReusableWindow({ sessionId: input.sessionId, turnIds: input.turnIds, sourceHash })
        : (
            await (typeof summaryRepo.listBySession === "function"
              ? summaryRepo.listBySession(input.sessionId, 128)
              : summaryRepo.listByBranch(input.sessionId, input.branchHeadTurnId))
          ).find((summary) => summary.sourceHash === sourceHash && arraysEqual(summary.turnIds, input.turnIds));
    if (existing) {
      if (!existing.continuityLedger || canonicalJsonString(existing.continuityLedger) !== canonicalJsonString(ledger))
        return undefined;
      return {
        summary: existing.summary,
        ledger: existing.continuityLedger,
        disposition: isStructuredConversationSummary(existing.summary) ? "structured" : "fallback",
      };
    }
    const rendered = renderChatContinuityLedger(ledger, { maxTokens: 2000 });
    const summary = `Compacted conversation context.\n${rendered.text}`;
    if (!rendered.text || rendered.requiresSourceExpansion || ledger.entries.length === 0) {
      return undefined;
    }
    await deps.onCompaction?.({
      phase: "before",
      sessionId: input.sessionId,
      branchHeadTurnId: input.branchHeadTurnId,
      startTurnId: input.turnIds[0]!,
      endTurnId: input.turnIds.at(-1)!,
      turnCount: input.turnIds.length,
      sourceHash,
    });
    const persisted = await summaryRepo.upsert({
      sessionId: input.sessionId,
      branchHeadTurnId: input.branchHeadTurnId,
      startTurnId: input.turnIds[0]!,
      endTurnId: input.turnIds.at(-1)!,
      turnIds: input.turnIds,
      sourceHash,
      tokenEstimate: estimateTokensFromText(source),
      summary,
      continuityLedger: ledger,
    });
    await deps.onCompaction?.({
      phase: "after",
      sessionId: input.sessionId,
      branchHeadTurnId: input.branchHeadTurnId,
      startTurnId: input.turnIds[0]!,
      endTurnId: input.turnIds.at(-1)!,
      turnCount: input.turnIds.length,
      sourceHash,
      summaryHash: createHash("sha256").update(persisted.summary).digest("hex"),
    });
    return {
      summary: persisted.summary,
      ledger: persisted.continuityLedger ?? ledger,
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

function hashBranchTurnSource(turnIds: string[], grouped: Map<string, ChatMessageRecord[]>): string {
  const records = turnIds.flatMap((turnId) => grouped.get(turnId) ?? []);
  return createHash("sha256").update(serializeSummarySource(turnIds, records)).digest("hex");
}

function serializeSummarySource(turnIds: string[], messages: ChatMessageRecord[]): string {
  return JSON.stringify({
    version: 2,
    turnIds,
    messages: messages.map((message) => ({
      messageId: message.messageId,
      role: message.role,
      actorType: message.actorType,
      sourceAuthority: message.sourceAuthority ?? "unknown",
      parentDelegationStepId: message.parentDelegationStepId ?? null,
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
