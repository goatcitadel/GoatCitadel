/**
 * Chat turn preparation pipeline.
 *
 * Owns chat turn preparation and orchestration-planning helpers behind a
 * narrow host contract. GatewayService remains the composition root, but this
 * module no longer needs to type itself as the gateway monolith.
 */

import { randomUUID } from "node:crypto";
import {
  applyChatModePresetToPatch,
  chatModeAllowsDynamicTeamGrowth,
  chatModeRequiresProjectBinding,
  DEFAULT_CITADEL_ID,
} from "@goatcitadel/contracts";
import type {
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCitationRecord,
  ChatDelegationRunRecord,
  GatewayEventInput,
  ChatMessageRecord,
  ChatMode,
  ChatSendMessageRequest,
  ChatSessionPrefsRecord,
  ChatTurnBranchKind,
  ChatTurnTraceRecord,
  RuntimeDecisionTraceAppendInput,
  SessionMeta,
} from "@goatcitadel/contracts";
import type { SessionAutonomyPrefsRecord, Storage } from "@goatcitadel/storage";
import { normalizeAgentInputFromSend, type NormalizedAgentInputFromSend } from "./chat-agent-input-normalization.js";
import { executionProfileFromNormalizationProfile } from "./chat-turn-execution-profile.js";
import { extractPrimaryUserTaskContent } from "./chat-agent-prompt-lab-contract.js";
import { assertChatSessionActive, splitChatPrefsPatch } from "./chat-session-utils.js";
import { buildSelectedPathTurnIds } from "./chat-thread-utils.js";
import {
  buildBaseAgentSystemPrompt,
  renderBaseAgentSystemPromptBlocks,
  type BaseAgentPromptToolset,
} from "./base-agent-system-prompt.js";
import { buildProviderCapabilityRegistry } from "../orchestration/providers/capability-registry.js";
import { buildOrchestrationPlan, resolveModePolicy, shouldUseModeOrchestration } from "../orchestration/router.js";
import type {
  OrchestrationPlan as ModeOrchestrationPlan,
  OrchestrationRouterInput,
  OrchestrationStepExecutionResult,
} from "../orchestration/types.js";
import {
  applyExecutionPlanDraftToOrchestrationPlan,
  buildExecutionPlanDraftFromOrchestrationPlan,
  buildPlanningModeSystemInstruction,
  buildRetrievalTrace,
  buildSpecialistMatchReason,
  CHAT_PLANNER_MAX_STEPS,
  CHAT_PLANNER_MIN_STEPS,
  MAX_PLANNER_PRODUCTION_STEPS,
  coercePlannerExecutionPlanDraft,
  extractCompletionText,
  extractSpecialistObjectiveKeywords,
  inferSpecialistBaseRole,
  normalizeChatInputParts,
  parseLooseJsonRecord,
  type ResolvedRuntimeGuidance,
  scoreSpecialistCandidateMatch,
} from "./chat-turn-planning-helpers.js";
import { selectPlannerDraftModel, shouldSkipPlannerDraft } from "./chat-planner-fast-path.js";
import { readLiveIntentThreshold } from "./improvement-tune-reads.js";
import { appendMobileContextParts, recordMobileContextTurnProvenance } from "./chat-turn-mobile-context.js";
import { recordPreparedTurnDecisions } from "./chat-turn-runtime-decisions.js";
import { buildSideChatSystemInstruction } from "./chat-turn-side-chat.js";
import {
  routeWithModelRouter,
  shouldBypassOrchestrationWithModelRouter,
  withModelRouterOrchestrationDecision,
} from "./model-router-decision-service.js";
import type { PreparedChatExecutionPlanResolution } from "./chat-turn-types.js";
import type { LlmService } from "./llm-service.js";
import type { ResolvedThreadKnowledgeContext } from "./chat-thread-knowledge-service.js";

// `appendMobileContextParts` now lives in chat-turn-mobile-context.ts; re-export it
// here so this module's public surface stays stable for namespace importers.
export { appendMobileContextParts };

// Bound for the planner LLM call — the only blocking completion on the
// non-fast turn-prep critical path. Lowered from 2500ms: on timeout we fall
// back to the deterministic template draft (see generatePreparedExecutionPlanDraft),
// so a tighter bound trims worst-case latency without changing behavior.
const CHAT_PLANNER_COMPLETION_TIMEOUT_MS = 1500;

export interface ChatTurnRoute {
  channel: string;
  account: string;
  peer?: string;
  room?: string;
  threadId?: string;
}

export interface ChatTurnSessionState {
  traces: ChatTurnTraceRecord[];
  tracesById: Map<string, ChatTurnTraceRecord>;
  turnLineageById: Map<string, { turnId: string; parentTurnId?: string }>;
  messages: ChatMessageRecord[];
  messagesById: Map<string, ChatMessageRecord>;
  childrenByTurnId: Map<string, string[]>;
  activeLeafTurnId?: string;
}

type ChatTurnPrepStorage = Pick<
  Storage,
  | "chatAttachments"
  | "chatSessionMeta"
  | "chatSessionPrefs"
  | "chatSessionProjects"
  | "chatSideChats"
  | "chatSpecialistCandidates"
  | "systemSettings"
  | "workspaces"
> & {
  audit?: Pick<Storage["audit"], "append">;
};

export interface ChatTurnPrepHost {
  readonly storage: ChatTurnPrepStorage;
  readonly llmService: Pick<LlmService, "getRuntimeConfig">;
  getSession(sessionId: string): SessionMeta;
  ensureChatSessionRuntimeGrants(sessionId: string): void;
  maybeAutoTitleChatSession(sessionId: string, content: string): void;
  normalizeWorkspaceId(workspaceId?: string): string;
  routeFromSession(session: SessionMeta): ChatTurnRoute;
  ingestEvent(idempotencyKey: string, payload: GatewayEventInput): Promise<unknown>;
  patchSessionAutonomyPrefs(
    sessionId: string,
    input: Partial<
      Pick<
        SessionAutonomyPrefsRecord,
        | "proactiveMode"
        | "maxActionsPerHour"
        | "maxActionsPerTurn"
        | "cooldownSeconds"
        | "retrievalMode"
        | "reflectionMode"
      >
    >,
  ): SessionAutonomyPrefsRecord;
  ensureChatSessionModelDefaults(sessionId: string, prefs: ChatSessionPrefsRecord): ChatSessionPrefsRecord;
  getSessionAutonomyPrefs(sessionId: string): SessionAutonomyPrefsRecord;
  buildDefaultChatPersonalityOverlay(): string | undefined;
  resolveRuntimeGuidance(workspaceId: string): Promise<ResolvedRuntimeGuidance>;
  resolveThreadKnowledgeContext(sessionId: string, query: string): Promise<ResolvedThreadKnowledgeContext>;
  loadChatTurnSessionState(sessionId: string): Promise<ChatTurnSessionState>;
  buildLlmMessagesFromBranchPath(
    sessionId: string,
    pathTurnIds: string[],
    currentUserMessage: ChatMessageRecord | undefined,
    options?: {
      providerId?: string;
      model?: string;
      guidanceSystemInstruction?: ChatCompletionRequest["messages"][number]["content"];
    },
    state?: ChatTurnSessionState,
  ): Promise<ChatCompletionRequest["messages"]>;
  createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  recordRuntimeDecision?(input: RuntimeDecisionTraceAppendInput): void;
  isFeatureEnabled(flag: string): boolean;
  /**
   * Frozen cross-session operator-profile digest (P2-S4b), composed once per
   * session and byte-stable per workspace+revision (cached). Fed to the base
   * prompt as `memoryDigest`. Optional + best-effort: returns `undefined` when
   * there is nothing to inject, and is only consulted when the base prompt is on.
   */
  composeFrozenOperatorProfileDigest?(workspaceId: string): string | undefined;
  /**
   * Callable tool/skill catalog for the base prompt's "what you can do" index
   * (P0-#2). Previously the base prompt was built with an empty toolset, so the
   * model was never told which tools or skills it had — a major cause of thin,
   * generic responses. Optional + best-effort: the prompt is advisory grounding,
   * so this lists the callable catalog cheaply (in-memory) and does NOT run
   * per-tool policy evaluation — real deny-wins enforcement stays inline at call
   * time. Returns empty names when unavailable; never throws on the prep path.
   */
  resolveBasePromptCapabilityCatalog?(): BaseAgentPromptToolset;
}

export interface PreparedAgentChatTurn {
  session: SessionMeta;
  route: ChatTurnRoute;
  citadelId: string;
  workspaceId: string;
  content: string;
  userEventId: string;
  userMessage: ChatMessageRecord;
  prefs: ChatSessionPrefsRecord;
  autonomy: SessionAutonomyPrefsRecord;
  normalized: NormalizedAgentInputFromSend;
  effectiveMode: ChatSessionPrefsRecord["mode"];
  modelRouterDecision: NonNullable<ChatTurnTraceRecord["routing"]["modelRouter"]>;
  retrievalTrace: NonNullable<ChatTurnTraceRecord["retrieval"]>;
  threadKnowledgeCitations: ChatCitationRecord[];
  resolvedGuidance: ResolvedRuntimeGuidance;
  conversationMessages: ChatMessageRecord[];
  history: ChatCompletionRequest["messages"];
  turnId: string;
  assistantMessageId: string;
  parentTurnId?: string;
  branchKind: ChatTurnBranchKind;
  sourceTurnId?: string;
  effectiveToolAutonomy: ChatSessionPrefsRecord["toolAutonomy"];
}

export function resolvePreparedTurnMode(
  prepared: Pick<PreparedAgentChatTurn, "effectiveMode" | "prefs" | "normalized">,
): ChatSessionPrefsRecord["mode"] {
  return prepared.effectiveMode ?? prepared.prefs.mode ?? prepared.normalized.mode ?? "chat";
}

export const DEFAULT_GOAL_TURN_BUDGET = 20;

export function applyGoalToGuidanceSystemInstruction(input: { baseInstruction?: string; goal: string | null }): string {
  if (!input.goal) {
    return input.baseInstruction ?? "";
  }
  const goalSection = `Pinned goal: ${input.goal}\nKeep every turn focused on this goal until the operator clears it.`;
  if (!input.baseInstruction) {
    return goalSection;
  }
  return `${goalSection}\n\n${input.baseInstruction}`;
}

/**
 * Counts an attempted turn against the goal budget.
 * Note: increment happens at prep time, BEFORE dispatch. Transient dispatch
 * failures still count toward the budget. This is intentional — a misconfigured
 * goal that triggers repeated failures should still time out via the budget.
 */
export function advanceGoalForTurn(input: { turnsUsed: number; turnBudget: number | null }): { cleared: boolean } {
  const budget = input.turnBudget ?? DEFAULT_GOAL_TURN_BUDGET;
  return { cleared: input.turnsUsed >= budget };
}

export async function prepareAgentChatTurn(
  host: ChatTurnPrepHost,
  sessionId: string,
  input: ChatSendMessageRequest,
  options?: {
    branchKind?: ChatTurnBranchKind;
    sourceTurnId?: string;
    parentTurnId?: string;
    existingUserMessage?: ChatMessageRecord;
    ingestUserMessage?: boolean;
    extraSystemInstruction?: string;
    turnId?: string;
    assistantMessageId?: string;
  },
): Promise<PreparedAgentChatTurn> {
  const session = host.getSession(sessionId);
  host.ensureChatSessionRuntimeGrants(sessionId);
  const sessionMeta = host.storage.chatSessionMeta.ensure(sessionId);
  assertChatSessionActive(sessionId, sessionMeta.lifecycleStatus);
  const workspaceId = host.normalizeWorkspaceId(sessionMeta.workspaceId);
  const citadelId = host.storage.workspaces?.find(workspaceId)?.citadelId ?? DEFAULT_CITADEL_ID;
  const branchKind = options?.branchKind ?? "append";
  const content = (options?.existingUserMessage?.content ?? input.content).trim();
  if (!content) {
    throw new Error("content is required");
  }
  const normalized = normalizeAgentInputFromSend({ ...input, content });
  const executionProfile = executionProfileFromNormalizationProfile(normalized.normalizationProfile);
  const quickWebTurn = executionProfile === "quick_web";
  if (branchKind !== "retry") {
    host.maybeAutoTitleChatSession(sessionId, content);
  }

  const route = host.routeFromSession(session);
  const ingestUserMessage = options?.ingestUserMessage ?? !options?.existingUserMessage;
  let userEventId = options?.existingUserMessage?.messageId ?? "";
  let userMessage: ChatMessageRecord;
  if (ingestUserMessage || !options?.existingUserMessage) {
    const uploadAttachments = host.storage.chatAttachments.listByIds(input.attachments ?? [], workspaceId);
    const inputParts = appendMobileContextParts(
      normalizeChatInputParts(content, input.parts, uploadAttachments),
      input.mobileContext,
    );
    userEventId = randomUUID();
    await recordMobileContextTurnProvenance(host, sessionId, userEventId, input.mobileContext);
    await host.ingestEvent(randomUUID(), {
      eventId: userEventId,
      route,
      actor: {
        type: "user",
        id: "operator",
      },
      message: {
        role: "user",
        content,
        parts: inputParts,
        attachments: uploadAttachments.map((item) => ({
          attachmentId: item.attachmentId,
          fileName: item.fileName,
          mimeType: item.mimeType,
          sizeBytes: item.sizeBytes,
        })),
        parentDelegationStepId: input.parentDelegationStepId,
      },
    });
    const attachments = uploadAttachments.map((item) => ({
      attachmentId: item.attachmentId,
      fileName: item.fileName,
      mimeType: item.mimeType,
      sizeBytes: item.sizeBytes,
    }));
    userMessage = {
      messageId: userEventId,
      sessionId,
      role: "user",
      actorType: "user",
      actorId: "operator",
      content,
      parts: inputParts.length > 0 ? inputParts : undefined,
      timestamp: new Date().toISOString(),
      attachments: attachments.length > 0 ? attachments : undefined,
      parentDelegationStepId: input.parentDelegationStepId,
    };
  } else {
    userMessage = options.existingUserMessage;
  }

  const resolvedGuidancePromise = quickWebTurn
    ? Promise.resolve({
        workspaceId,
        globalFilesUsed: [],
        workspaceFilesUsed: [],
        truncated: false,
      } satisfies Partial<ResolvedRuntimeGuidance>)
    : host.resolveRuntimeGuidance(workspaceId);
  const threadKnowledgeContextPromise: Promise<ResolvedThreadKnowledgeContext> = quickWebTurn
    ? Promise.resolve({ systemInstruction: undefined, citations: [], attachments: [] })
    : host.resolveThreadKnowledgeContext(sessionId, content);
  const sideChatSystemInstructionPromise = input.sideChatContext
    ? buildSideChatSystemInstruction(host, sessionId, input.sideChatContext)
    : Promise.resolve(undefined);
  const sessionStatePromise = host.loadChatTurnSessionState(sessionId);

  const prefsOverride = applyChatModePresetToPatch({
    ...(input.prefsOverride ?? {}),
    mode: input.mode ?? input.prefsOverride?.mode,
    providerId: input.providerId ?? input.prefsOverride?.providerId,
    model: input.model ?? input.prefsOverride?.model,
    webMode: input.webMode ?? input.prefsOverride?.webMode,
    memoryMode: input.memoryMode ?? input.prefsOverride?.memoryMode,
    thinkingLevel: input.thinkingLevel ?? input.prefsOverride?.thinkingLevel,
    speedMode: input.speedMode ?? input.prefsOverride?.speedMode,
    subagentPolicy: input.subagentPolicy ?? input.prefsOverride?.subagentPolicy,
  });
  const splitPrefs = splitChatPrefsPatch(prefsOverride);
  if (Object.keys(splitPrefs.autonomyPatch).length > 0) {
    host.patchSessionAutonomyPrefs(sessionId, splitPrefs.autonomyPatch);
  }
  const prefsPatched = host.storage.chatSessionPrefs.patch(sessionId, splitPrefs.basePatch);
  const prefs = host.ensureChatSessionModelDefaults(sessionId, prefsPatched);
  const autonomy = host.getSessionAutonomyPrefs(sessionId);
  const modelRouterDecision = routeWithModelRouter({
    prompt: content,
    hasAttachments: Boolean(input.attachments?.length || input.parts?.some((part) => part.type !== "text")),
  });
  const projectId = host.storage.chatSessionProjects.get(sessionId)?.projectId;
  const effectiveMode = quickWebTurn ? normalized.mode : prefs.mode;
  const requiresProjectBinding = chatModeRequiresProjectBinding(effectiveMode);
  const missingRequiredProjectBinding = requiresProjectBinding && !projectId;
  const effectiveToolAutonomy =
    prefs.planningMode === "advisory" || missingRequiredProjectBinding ? "manual" : prefs.toolAutonomy;
  const retrievalTrace = buildRetrievalTrace({
    content,
    retrievalMode: autonomy.retrievalMode,
    webMode: normalized.webMode ?? prefs.webMode,
    memoryMode: normalized.memoryMode ?? prefs.memoryMode,
    // P2-W3: close the self-improvement loop — read the live-data intent
    // sensitivity the weekly tuner writes so a raised threshold actually
    // escalates web retrieval. Safe default (0.6) keeps current behaviour.
    liveIntentThreshold: readLiveIntentThreshold(host.storage.systemSettings),
  });
  // Previously the personality overlay (and any base instruction) was applied
  // only in chat mode, so cowork/code turns reached the model with no agent
  // identity, tool doctrine, output bar, or runtime grounding (not even the
  // date) — the single biggest cause of thin cowork responses. With the base
  // system prompt enabled (default on; kill switch coworkRuntimeQualityV1Disabled)
  // we apply a real layered prompt, and the personality overlay, to every mode.
  const baseSystemPromptEnabled = !host.isFeatureEnabled("coworkRuntimeQualityV1Disabled");
  const personalityOverlay = quickWebTurn
    ? undefined
    : baseSystemPromptEnabled || effectiveMode === "chat"
      ? host.buildDefaultChatPersonalityOverlay()
      : undefined;
  let baseAgentInstruction: ChatCompletionRequest["messages"][number]["content"] | undefined;
  if (baseSystemPromptEnabled) {
    const now = new Date();
    const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    // Frozen cross-session operator profile (P2-S4b). Cheap + cached
    // (workspace+revision), so it stays byte-stable within a session and lands in
    // the base prompt's volatile tail without busting the P0-A cache prefix.
    // Best-effort: never let a profile read break turn preparation.
    let memoryDigest: string | undefined;
    if (!quickWebTurn) {
      try {
        memoryDigest = host.composeFrozenOperatorProfileDigest?.(workspaceId);
      } catch {
        memoryDigest = undefined;
      }
    }
    // Tell the model what it can actually do (P0-#2). Best-effort + cheap
    // (in-memory callable catalog, no per-tool policy eval). Quick-web turns use
    // a stub prefix that ignores the toolset, so skip the lookup for them.
    let promptCapabilityCatalog: BaseAgentPromptToolset = { toolNames: [] };
    if (!quickWebTurn && host.resolveBasePromptCapabilityCatalog) {
      try {
        promptCapabilityCatalog = host.resolveBasePromptCapabilityCatalog();
      } catch {
        promptCapabilityCatalog = { toolNames: [] };
      }
    }
    baseAgentInstruction = renderBaseAgentSystemPromptBlocks(
      buildBaseAgentSystemPrompt({
        mode: effectiveMode,
        normalizationProfile: normalized.normalizationProfile,
        runtimeInfo: {
          date: now.toLocaleDateString("en-US", {
            weekday: "long",
            year: "numeric",
            month: "long",
            day: "numeric",
            timeZone: timezone,
          }),
          timezone,
          model: input.model ?? prefs.model ?? "unknown",
          providerId: input.providerId ?? prefs.providerId ?? "unknown",
          channel: route.channel,
          mode: effectiveMode,
        },
        toolset: promptCapabilityCatalog,
        ...(memoryDigest ? { memoryDigest } : {}),
      }),
    );
  }
  const [rawResolvedGuidance, threadKnowledgeContext, sideChatSystemInstruction, sessionState] = await Promise.all([
    resolvedGuidancePromise,
    threadKnowledgeContextPromise,
    sideChatSystemInstructionPromise,
    sessionStatePromise,
  ]);
  const resolvedGuidance = normalizeResolvedRuntimeGuidance(rawResolvedGuidance, workspaceId);
  const guidanceSystemInstruction = mergeChatSystemInstructionContent(
    baseAgentInstruction,
    buildPinnedGoalSystemInstruction(sessionMeta.pinnedGoal ?? null),
    resolvedGuidance.systemInstruction,
    threadKnowledgeContext.systemInstruction,
    personalityOverlay,
    sideChatSystemInstruction,
    buildPlanningModeSystemInstruction(prefs.planningMode),
    missingRequiredProjectBinding
      ? "Code mode requires a bound project before execution-heavy work. Until a project is attached, stay in planning and review posture, and do not imply that repository-bound edits or filesystem inspection were executed."
      : undefined,
    options?.extraSystemInstruction,
  );

  const hasExplicitParentTurnId = Object.prototype.hasOwnProperty.call(options ?? {}, "parentTurnId");
  const parentTurnId = hasExplicitParentTurnId ? options?.parentTurnId : sessionState.activeLeafTurnId;
  const pathTurnIds = parentTurnId ? buildSelectedPathTurnIds(sessionState.turnLineageById, parentTurnId) : [];
  const contextPathTurnIds = quickWebTurn ? [] : pathTurnIds;
  const conversationMessages = contextPathTurnIds.flatMap((turnId) => {
    const trace = sessionState.tracesById.get(turnId);
    if (!trace) {
      return [];
    }
    const items: ChatMessageRecord[] = [];
    const userMessageFromState = sessionState.messagesById.get(trace.userMessageId);
    if (userMessageFromState) {
      items.push(userMessageFromState);
    }
    if (trace.assistantMessageId) {
      const assistantMessage = sessionState.messagesById.get(trace.assistantMessageId);
      if (assistantMessage) {
        items.push(assistantMessage);
      }
    }
    return items;
  });
  conversationMessages.push(userMessage);
  const history = await host.buildLlmMessagesFromBranchPath(
    sessionId,
    contextPathTurnIds,
    userMessage,
    {
      providerId: input.providerId ?? prefs.providerId,
      model: input.model ?? prefs.model,
      guidanceSystemInstruction,
    },
    sessionState,
  );

  if (sessionMeta.pinnedGoal) {
    const turnsUsed = host.storage.chatSessionMeta.incrementGoalTurnsUsed(sessionId);
    const { cleared } = advanceGoalForTurn({
      turnsUsed,
      turnBudget: sessionMeta.goalTurnBudget ?? null,
    });
    if (cleared) {
      host.storage.chatSessionMeta.patch(sessionId, {
        pinnedGoal: null,
        goalTurnBudget: null,
        goalSetAt: null,
      });
    }
  }

  const prepared: PreparedAgentChatTurn = {
    session,
    route,
    citadelId,
    workspaceId,
    content,
    userEventId,
    userMessage,
    prefs,
    autonomy,
    normalized,
    effectiveMode,
    modelRouterDecision,
    retrievalTrace,
    threadKnowledgeCitations: threadKnowledgeContext.citations,
    resolvedGuidance,
    conversationMessages,
    history,
    turnId: options?.turnId ?? randomUUID(),
    assistantMessageId: options?.assistantMessageId ?? `assistant-${randomUUID()}`,
    parentTurnId,
    branchKind,
    sourceTurnId: options?.sourceTurnId,
    effectiveToolAutonomy,
  };
  recordPreparedTurnDecisions(host, prepared, {
    projectId,
    missingRequiredProjectBinding,
    guidanceFileCount: resolvedGuidance.globalFilesUsed.length + resolvedGuidance.workspaceFilesUsed.length,
    threadKnowledgeCitationCount: threadKnowledgeContext.citations.length,
  });
  return prepared;
}

function buildPinnedGoalSystemInstruction(goal: string | null): string | undefined {
  if (!goal) {
    return undefined;
  }
  return `Pinned goal: ${goal}\nKeep every turn focused on this goal until the operator clears it.`;
}

function mergeChatSystemInstructionContent(
  ...parts: Array<ChatCompletionRequest["messages"][number]["content"] | undefined>
): ChatCompletionRequest["messages"][number]["content"] | undefined {
  const blocks: Record<string, unknown>[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      const trimmed = part.trim();
      if (trimmed) {
        blocks.push({ type: "text", text: trimmed });
      }
      continue;
    }
    if (Array.isArray(part)) {
      for (const block of part) {
        if (!isRecord(block)) {
          continue;
        }
        const text = typeof block.text === "string" ? block.text.trim() : "";
        if (text) {
          blocks.push({ ...block, text });
        }
      }
    }
  }
  return blocks.length > 0 ? blocks : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function normalizeResolvedRuntimeGuidance(
  guidance: Partial<ResolvedRuntimeGuidance>,
  workspaceId: string,
): ResolvedRuntimeGuidance {
  return {
    workspaceId:
      typeof guidance.workspaceId === "string" && guidance.workspaceId.trim() ? guidance.workspaceId : workspaceId,
    systemInstruction: guidance.systemInstruction,
    globalFilesUsed: Array.isArray(guidance.globalFilesUsed) ? guidance.globalFilesUsed : [],
    workspaceFilesUsed: Array.isArray(guidance.workspaceFilesUsed) ? guidance.workspaceFilesUsed : [],
    truncated: guidance.truncated === true,
  };
}

export async function resolvePreparedTurnOrchestration(
  host: ChatTurnPrepHost,
  prepared: PreparedAgentChatTurn,
): Promise<PreparedChatExecutionPlanResolution | undefined> {
  const mode = prepared.effectiveMode;
  const runtime = host.llmService.getRuntimeConfig({
    useCache: true,
  });
  const capabilities = buildProviderCapabilityRegistry(runtime);
  const policy = resolveModePolicy(mode);
  const routerInput: OrchestrationRouterInput = {
    task: {
      sessionId: prepared.session.sessionId,
      workspaceId: prepared.workspaceId,
      mode,
      // The objective is operator-facing and is echoed into delegated step
      // prompts and synthesis fallbacks. On prompt-pack runs, keep it to the
      // user's task: the Prompt Lab run contract must not leak into it. Live
      // turns keep their content verbatim even when it happens to contain a
      // "## User Task" heading.
      objective:
        prepared.normalized.normalizationProfile === "prompt_pack_harness"
          ? extractPrimaryUserTaskContent(prepared.content) || prepared.content
          : prepared.content,
      prefs: prepared.prefs,
      conversation: prepared.conversationMessages,
      historyMessages: prepared.history,
    },
    runtime,
    capabilities,
    policy,
  };
  const advisoryOnly = prepared.prefs.planningMode === "advisory";
  const modelRouterBypass = shouldBypassOrchestrationWithModelRouter({
    routerInput,
    decision: prepared.modelRouterDecision,
    advisoryOnly,
  });
  if (modelRouterBypass.bypass) {
    prepared.modelRouterDecision = withModelRouterOrchestrationDecision(prepared.modelRouterDecision, {
      decision: "bypassed",
      reason: modelRouterBypass.reason,
    });
    return undefined;
  }
  if (!advisoryOnly && !shouldUseModeOrchestration(routerInput)) {
    prepared.modelRouterDecision = withModelRouterOrchestrationDecision(prepared.modelRouterDecision, {
      decision: "bypassed",
      reason:
        "orchestration router suppressed a separate plan because the chat path is tool-backed or live-data handled directly",
    });
    return undefined;
  }
  prepared.modelRouterDecision = withModelRouterOrchestrationDecision(prepared.modelRouterDecision, {
    decision: "allowed",
    reason: modelRouterBypass.reason,
  });
  const templatePlan = applyApprovedSpecialistsToPlan(host, prepared, buildOrchestrationPlan(routerInput));
  const executionPlanDraft = await generatePreparedExecutionPlanDraft(
    host,
    prepared,
    routerInput,
    templatePlan,
    advisoryOnly,
  );
  const plan = applyExecutionPlanDraftToOrchestrationPlan(templatePlan, executionPlanDraft);
  return {
    routerInput,
    orchestrationPlan: plan,
    executionPlanDraft,
  };
}

export function applyApprovedSpecialistsToPlan(
  host: ChatTurnPrepHost,
  prepared: PreparedAgentChatTurn,
  plan: ReturnType<typeof buildOrchestrationPlan>,
): ReturnType<typeof buildOrchestrationPlan> {
  const mode = prepared.effectiveMode;
  if (!chatModeAllowsDynamicTeamGrowth(mode)) {
    return plan;
  }
  const sessionWorkspaceId = host.normalizeWorkspaceId(prepared.workspaceId);
  const candidates = host.storage.chatSpecialistCandidates
    .listAutoRoutable(
      prepared.session.sessionId,
      mode,
      Boolean(host.storage.chatSessionProjects.get(prepared.session.sessionId)?.projectId),
    )
    .filter((candidate) => host.normalizeWorkspaceId(candidate.workspaceId) === sessionWorkspaceId)
    .filter((candidate) => isSpecialistCandidateAutoRouteFresh(candidate.updatedAt));
  if (candidates.length === 0) {
    return plan;
  }
  const objectiveKeywords = extractSpecialistObjectiveKeywords(prepared.content);
  const nextSteps = plan.steps.map((step) => ({ ...step }));
  const matchedSelections: NonNullable<typeof plan.routeDecision.specialistCandidates> = [];
  const usedCandidateIds = new Set<string>();
  for (const step of nextSteps) {
    const bestMatch = candidates
      .filter((candidate) => !usedCandidateIds.has(candidate.candidateId))
      .map((candidate) => {
        const baseRole = inferSpecialistBaseRole(candidate.role);
        const score = scoreSpecialistCandidateMatch(candidate, objectiveKeywords, step.role);
        return { candidate, baseRole, score };
      })
      .filter((item) => item.baseRole === step.role && item.score >= 0.58)
      .sort((left, right) => right.score - left.score)
      .at(0);
    if (!bestMatch) {
      continue;
    }
    const selection = {
      candidateId: bestMatch.candidate.candidateId,
      title: bestMatch.candidate.title,
      role: bestMatch.candidate.role,
      baseRole: bestMatch.baseRole,
      summary: bestMatch.candidate.summary,
      matchReason: buildSpecialistMatchReason(bestMatch.candidate, objectiveKeywords),
      routingMode: bestMatch.candidate.routingMode,
    } satisfies NonNullable<typeof plan.routeDecision.specialistCandidates>[number];
    step.specialistCandidate = selection;
    matchedSelections.push(selection);
    usedCandidateIds.add(bestMatch.candidate.candidateId);
    if (matchedSelections.length >= 2) {
      break;
    }
  }
  if (matchedSelections.length === 0) {
    return plan;
  }
  return {
    ...plan,
    routeDecision: {
      ...plan.routeDecision,
      specialistCandidates: matchedSelections,
    },
    steps: nextSteps,
  };
}

function isSpecialistCandidateAutoRouteFresh(updatedAt: string): boolean {
  const updatedAtMs = Date.parse(updatedAt);
  if (!Number.isFinite(updatedAtMs)) {
    return false;
  }
  return Date.now() - updatedAtMs <= 30 * 24 * 60 * 60 * 1000;
}

export async function generatePreparedExecutionPlanDraft(
  host: ChatTurnPrepHost,
  prepared: PreparedAgentChatTurn,
  routerInput: OrchestrationRouterInput,
  templatePlan: ModeOrchestrationPlan,
  advisoryOnly: boolean,
): Promise<PreparedChatExecutionPlanResolution["executionPlanDraft"]> {
  const fallbackDraft = buildExecutionPlanDraftFromOrchestrationPlan(templatePlan, {
    objective: prepared.content,
    advisoryOnly,
  });
  if ((prepared.normalized?.speedMode ?? prepared.prefs.speedMode) === "fast") {
    return fallbackDraft;
  }
  const plannerFastPathDisabled = host.isFeatureEnabled("plannerFastPathV1Disabled");
  if (!plannerFastPathDisabled && shouldSkipPlannerDraft(prepared.content)) {
    // Trivial single-clause ask: the deterministic template draft is the same
    // floor speedMode:"fast" ships, so skip the planner LLM round-trip.
    return fallbackDraft;
  }
  const plannerDraftModel = plannerFastPathDisabled
    ? undefined
    : selectPlannerDraftModel({ capabilities: routerInput.capabilities, prefs: prepared.prefs });
  const allowProductionExpansion =
    routerInput.task.mode === "cowork" && !advisoryOnly && !host.isFeatureEnabled("plannerFanoutV1Disabled");
  const maxExtraWorkerSteps = Math.max(
    0,
    MAX_PLANNER_PRODUCTION_STEPS -
      templatePlan.steps.filter(
        (step) => step.role === "planner" || step.role === "worker" || step.role === "researcher",
      ).length,
  );
  // Bound the planner with our OWN timer (not just the provider's timeoutMs) so
  // a provider that ignores its deadline cannot pin the hot turn-prep path. On
  // timeout we abort the in-flight call (no leaked request) and fall back to the
  // deterministic template draft. Invariants: createChatCompletion runs exactly
  // once; the planner promise gets a rejection handler up-front so a late
  // rejection (e.g. from the abort, after the fallback returned) is captured and
  // never surfaces as an unhandledRejection; when the completion wins the race
  // the payload is parsed/coerced exactly as before, so output is byte-identical.
  const abortController = new AbortController();
  const plannerCompletion = Promise.resolve().then(() =>
    host.createChatCompletion({
      providerId: plannerDraftModel?.providerId ?? prepared.prefs.providerId,
      model: plannerDraftModel?.model ?? prepared.prefs.model,
      stream: false,
      timeoutMs: CHAT_PLANNER_COMPLETION_TIMEOUT_MS,
      signal: abortController.signal,
      memory: { enabled: false, mode: "off" },
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: [
            "You are GoatCitadel's execution planner.",
            "Return strict JSON with keys: summary, steps.",
            `Return between ${CHAT_PLANNER_MIN_STEPS} and ${CHAT_PLANNER_MAX_STEPS} steps.`,
            "Each step must include: objective, successCriteria, suggestedTools, expectedOutput, parallelizable, dependsOnStepIds, delegatedRole.",
            "Use the template delegatedRole as-is. Do not repurpose synthesis, review, critic, or QA steps into worker steps.",
            "If the mode is chat, delegatedRole must be null for all steps.",
            "Keep step objectives specific, practical, and directly tied to the user request.",
            "You may refine production/planning step wording, but terminal control steps must preserve the template role, objective, dependencies, and expected output.",
            ...(allowProductionExpansion && maxExtraWorkerSteps > 0
              ? [
                  `When the request contains genuinely independent subtasks, you may append up to ${maxExtraWorkerSteps} EXTRA worker steps after the template steps: mark each parallelizable:true, give each a precise objective, and set dependsOnStepIds to the template steps it truly needs (usually just the planning step).`,
                ]
              : []),
          ].join("\n"),
        },
        {
          role: "user",
          content: JSON.stringify({
            mode: routerInput.task.mode,
            planningMode: prepared.prefs.planningMode,
            objective: prepared.content,
            workflowTemplate: templatePlan.workflowTemplate,
            routeDecision: templatePlan.routeDecision,
            allowedRoles: [...new Set(templatePlan.steps.map((step) => step.role))],
            templateSteps: templatePlan.steps.map((step) => ({
              stepId: step.stepId,
              role: step.role,
              label: step.label,
              objective: step.objective,
              successCriteria: step.successCriteria,
              suggestedTools: step.suggestedTools,
              expectedOutput: step.expectedOutput,
              parallelizable: step.parallelizable,
              dependsOnStepIds: step.dependsOnStepIds,
              delegatedRole: step.delegatedRole ?? null,
            })),
          }),
        },
      ],
    }),
  );
  // Neutralize unhandled rejections up-front: if the timer wins the race and we
  // return the fallback, the in-flight planner promise may still reject later
  // (e.g. from the abort). This detached handler captures that, the race below
  // re-reads the same promise for the in-time path.
  plannerCompletion.catch(() => undefined);

  const timeoutSentinel = Symbol("chat-planner-timeout");
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const timeoutGuard = new Promise<typeof timeoutSentinel>((resolve) => {
    timeoutHandle = setTimeout(() => resolve(timeoutSentinel), CHAT_PLANNER_COMPLETION_TIMEOUT_MS);
  });

  try {
    const outcome = await Promise.race([plannerCompletion, timeoutGuard]);
    if (outcome === timeoutSentinel) {
      abortController.abort(); // bound elapsed: cancel the in-flight call, fall back
      return fallbackDraft;
    }
    const payload = parseLooseJsonRecord(extractCompletionText(outcome));
    const planned = payload
      ? coercePlannerExecutionPlanDraft(payload, templatePlan, {
          advisoryOnly,
          mode: routerInput.task.mode,
          objective: prepared.content,
          allowProductionExpansion,
        })
      : undefined;
    return planned ?? fallbackDraft;
  } catch {
    // Planner rejected before the timeout (the race surfaced its rejection).
    return fallbackDraft;
  } finally {
    clearTimeout(timeoutHandle);
  }
}

export function buildChatOrchestrationSummary(input: {
  runId: string;
  objective: string;
  modePolicy: ChatMode;
  routeDecision: ReturnType<typeof buildOrchestrationPlan>["routeDecision"];
  stepResults: OrchestrationStepExecutionResult[];
  finalSummary?: string;
  integritySignals?: string[];
  finalized?: boolean;
  advisoryOnly?: boolean;
}): NonNullable<ChatTurnTraceRecord["orchestration"]> {
  const completedCount = input.stepResults.filter((step) => step.status === "completed").length;
  const failedCount = input.stepResults.filter((step) => step.status === "failed").length;
  const partialFailedCount = input.stepResults.filter(
    (step) => step.status === "failed" && Boolean(step.output?.trim()) && step.output?.trim() !== step.error?.trim(),
  ).length;
  const runningCount = input.stepResults.filter((step) => step.status === "running").length;
  const continuationNeeded = (input.integritySignals ?? []).some(
    (signal) =>
      signal === "orchestration_partial_needs_continuation" || signal === "orchestration_final_synthesis_fallback",
  );
  const incompleteFinalSummary = Boolean(input.finalSummary && /\bSynthesis Incomplete\b/i.test(input.finalSummary));
  const status: ChatDelegationRunRecord["status"] = !input.finalized
    ? "running"
    : input.advisoryOnly
      ? "completed"
      : runningCount > 0
        ? "running"
        : completedCount === 0 && partialFailedCount === 0
          ? "failed"
          : failedCount > 0 || continuationNeeded || incompleteFinalSummary
            ? "partial"
            : "completed";
  return {
    runId: input.runId,
    objective: input.objective,
    workflowTemplate: input.routeDecision.workflowTemplate,
    status,
    modePolicy: input.modePolicy,
    visibility: input.routeDecision.visibility,
    finalSummary: input.finalSummary,
    routeDecision: input.routeDecision,
    steps: input.stepResults.map((step) => ({
      stepId: step.stepId,
      role: step.role,
      label: step.label,
      index: step.index,
      status: step.status,
      waitStatus: step.waitStatus,
      specialistCandidateId: step.specialistCandidateId,
      specialistTitle: step.specialistTitle,
      specialistRole: step.specialistRole,
      providerId: step.providerId,
      model: step.model,
      startedAt: step.startedAt,
      finishedAt: step.finishedAt,
      durationMs: step.durationMs,
      summary: step.summary,
      error: step.error,
      degradedHandoffStepIds: step.degradedHandoffStepIds,
      prompt: step.prompt,
    })),
    integritySignals: input.integritySignals,
  };
}
