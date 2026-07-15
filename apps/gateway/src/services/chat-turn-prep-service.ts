/* eslint-disable max-lines -- Chat turn admission remains centralized while its frozen preparation contract is being integrated. */
/**
 * Chat turn preparation pipeline.
 *
 * Owns chat turn preparation and orchestration-planning helpers behind a
 * narrow host contract. GatewayService remains the composition root, but this
 * module no longer needs to type itself as the gateway monolith.
 */

import { createHash, randomUUID } from "node:crypto";
import {
  applyChatModePresetToPatch,
  chatModeAllowsDynamicTeamGrowth,
  chatModeRequiresProjectBinding,
  canonicalJsonString,
  DEFAULT_CITADEL_ID,
  ConflictError,
  NotFoundError,
} from "@goatcitadel/contracts";
import type {
  CapabilityCatalogSnapshotRecord,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatCitationRecord,
  ChatDelegationRunRecord,
  GatewayEventInput,
  ChatMessageRecord,
  ChatMode,
  ChatRoutedContextSnapshotRecord,
  ChatSendMessageRequest,
  ChatSessionPrefsRecord,
  ChatTurnBranchKind,
  ChatTurnTraceRecord,
  ChatTurnCapabilityProfileRecord,
  ModelUsageAttributionContext,
  RuntimeDecisionTraceAppendInput,
  SessionMeta,
} from "@goatcitadel/contracts";
import { HEARTBEAT_SYSTEM_ACTOR_ID, type SessionAutonomyPrefsRecord, type Storage } from "@goatcitadel/storage";
import { normalizeAgentInputFromSend, type NormalizedAgentInputFromSend } from "./chat-agent-input-normalization.js";
import { executionProfileFromNormalizationProfile } from "./chat-turn-execution-profile.js";
import { extractPrimaryUserTaskContent } from "./chat-agent-prompt-lab-contract.js";
import { assertChatSessionActive, splitChatPrefsPatch } from "./chat-session-utils.js";
import { buildSelectedPathTurnIds } from "./chat-thread-utils.js";
import type { ResolvedChatRouteDescriptor } from "./chat-route-resolution.js";
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
  countPlannerProductionSteps,
  extractCompletionText,
  extractSpecialistObjectiveKeywords,
  inferSpecialistBaseRole,
  normalizeChatInputParts,
  parseLooseJsonRecord,
  type ResolvedRuntimeGuidance,
  scoreSpecialistCandidateMatch,
} from "./chat-turn-planning-helpers.js";
import { trimExecutionPlanDraftToPlan } from "./chat-planner-fanout.js";
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
import type {
  ActiveTurnAdmission,
  ChatStreamMutationLifecycle,
  PreparedChatExecutionPlanResolution,
} from "./chat-turn-types.js";
import type { LlmService } from "./llm-service.js";
import type { ResolvedThreadKnowledgeContext } from "./chat-thread-knowledge-service.js";
import { createUtilityModelUsageAttribution } from "./utility-model-usage-attribution.js";
import { runBoundedUtilityModelCall } from "./utility-model-call.js";
import { isAuthoritativeModelUsageAccountingError } from "@goatcitadel/gateway-core";
import {
  buildChatTurnCapabilityProfileSourceScope,
  type ChatTurnCapabilityProfileResolution,
} from "./chat-turn-capability-profile-service.js";
import type { ChatCompactionDimension } from "./chat-message-history-service.js";
import {
  buildChatRoutedContextSnapshot,
  type ResolveChatRoutedContextSourcesInput,
  type ResolvedChatRoutedContextSources,
} from "./chat-routed-context-service.js";

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
  | "runImmediateTransaction"
  | "sessionAutonomyPrefs"
  | "systemSettings"
  | "workspaces"
> & {
  audit?: Pick<Storage["audit"], "append">;
};

export interface ChatTurnPrepHost {
  readonly storage: ChatTurnPrepStorage;
  assertTurnAdmissionWrite?(admission: ActiveTurnAdmission): void;
  readonly llmService: Pick<LlmService, "getModelContextWindow" | "getRuntimeConfig">;
  getSession(sessionId: string): SessionMeta;
  ensureChatSessionRuntimeGrants(sessionId: string): void;
  maybeAutoTitleChatSession(sessionId: string, content: string): void;
  normalizeWorkspaceId(workspaceId?: string): string;
  routeFromSession(session: SessionMeta): ChatTurnRoute;
  ingestEvent(
    idempotencyKey: string,
    payload: GatewayEventInput,
    options?: { onCommit?: () => void; afterCommit?: () => void },
  ): Promise<unknown>;
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
      compactionDimension?: ChatCompactionDimension;
    },
    state?: ChatTurnSessionState,
  ): Promise<ChatCompletionRequest["messages"]>;
  /**
   * Resolves a one-shot, approval-bound recovery action after the complete
   * provider/model/capability dimension is sealed. Implementations must derive
   * the actor from authenticated Gateway context and must never accept a
   * client-provided actor hash or force boolean.
   */
  resolvePendingCompactionBreakerForceAction?(input: {
    sessionId: string;
    sealedDimensionHash: string;
    actorId: string;
  }): { actionId: string; actorHash: string } | undefined;
  createChatCompletion(
    request: ChatCompletionRequest,
    attribution?: ModelUsageAttributionContext,
  ): Promise<ChatCompletionResponse>;
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
  resolveChatTurnEffectiveRoute?(sessionId: string, input: ChatSendMessageRequest): ResolvedChatRouteDescriptor;
  resolveChatTurnCapabilityProfile?(input: {
    sessionId: string;
    turnId: string;
    workspaceId: string;
    citadelId: string;
    route: ChatTurnRoute;
    content: string;
    prefs: ChatSessionPrefsRecord;
    autonomy: SessionAutonomyPrefsRecord;
    normalized: NormalizedAgentInputFromSend;
    effectiveMode: ChatMode;
    effectiveToolAutonomy: "safe_auto" | "manual";
    routeResolution: ResolvedChatRouteDescriptor;
    historyMessages: ChatCompletionRequest["messages"];
    request: ChatSendMessageRequest;
  }): Promise<ChatTurnCapabilityProfileResolution>;
  resolveChatRoutedContextSources(
    input: ResolveChatRoutedContextSourcesInput,
  ): Promise<ResolvedChatRoutedContextSources>;
  loadChatTurnCapabilityProfile?(input: {
    profileId: string;
    profileHash: string;
    sessionId: string;
    turnId: string;
  }): ChatTurnCapabilityProfileRecord;
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
  /** Frozen pre-routing mutation authority. Required on every production turn. */
  turnAdmission?: ActiveTurnAdmission;
  /** Validated server-only heartbeat identity; absent on every other turn. */
  serverOnlyPosture?: Readonly<SystemHeartbeatTurnPrepPosture>;
  assistantMessageId: string;
  parentTurnId?: string;
  /** Canonical delegation lineage. Unlike parentTurnId, this is absent on normal branch appends. */
  parentDelegationStepId?: string;
  branchKind: ChatTurnBranchKind;
  sourceTurnId?: string;
  effectiveToolAutonomy: ChatSessionPrefsRecord["toolAutonomy"];
  /** Server-owned immutable capability upper bound. Optional only for legacy/test hosts. */
  capabilityProfile?: ChatTurnCapabilityProfileRecord;
  /** Original admitted content used to validate a durable continuation against its profile. */
  capabilityProfileContent?: string;
  capabilityCatalogSnapshot?: CapabilityCatalogSnapshotRecord;
  /** Exact immutable routed-context bytes admitted for this turn. */
  routedContextSnapshot?: ChatRoutedContextSnapshotRecord;
  /** Stable provider/model/capability-selection dimension used by compaction and first-call usage. */
  compactionDimensionHash: string;
}

/**
 * Server-only preparation posture for a storage-admitted heartbeat occurrence.
 * It is deliberately a typed discriminant rather than an ID-prefix convention:
 * only the exact system-heartbeat admission may use it, and it performs no
 * operator-semantic preparation writes.
 */
export interface SystemHeartbeatTurnPrepPosture {
  kind: "system_heartbeat";
  actorId: typeof HEARTBEAT_SYSTEM_ACTOR_ID;
  operation: "chat_system_heartbeat";
  occurrenceId: string;
  claimSha256: string;
  durableRunId: string;
}

export function resolvePreparedTurnMode(
  prepared: Pick<PreparedAgentChatTurn, "effectiveMode" | "prefs" | "normalized">,
): ChatSessionPrefsRecord["mode"] {
  void prepared;
  return "chat";
}

const ROUTED_CONTEXT_ORCHESTRATION_BYPASS_REASON =
  "Routed context is bound to one frozen provider/model budget and must execute through the direct turn runtime.";

/**
 * Routed context is admitted against one exact capability profile and model
 * context window. Mode orchestration may select other providers/models, so it
 * cannot safely consume or delegate those frozen bytes in v1.
 */
export function enforcePreparedRoutedContextOrchestrationBypass(prepared: PreparedAgentChatTurn): boolean {
  if (!prepared.routedContextSnapshot) {
    return false;
  }
  prepared.modelRouterDecision = withModelRouterOrchestrationDecision(prepared.modelRouterDecision, {
    decision: "bypassed",
    reason: ROUTED_CONTEXT_ORCHESTRATION_BYPASS_REASON,
  });
  return true;
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

/**
 * Builds the compaction route dimension from the sealed capability selection,
 * deliberately excluding per-turn identity/content fields. The admission
 * fingerprint itself includes contentHash, so using it directly would reset
 * hysteresis on every turn even when the available provider/tool profile was
 * unchanged.
 */
export function buildChatCompactionDimension(input: {
  providerId?: string;
  model?: string;
  profile?: ChatTurnCapabilityProfileRecord;
  persistState?: boolean;
}): ChatCompactionDimension {
  const stableProfile = input.profile
    ? {
        schemaVersion: input.profile.schemaVersion,
        catalog: {
          inspectableHash: input.profile.catalog?.inspectableHash ?? "legacy-missing-inspectable-hash",
          callableHash: input.profile.catalog?.callableHash ?? "legacy-missing-callable-hash",
        },
        selection: {
          mode: input.profile.selection.mode,
          webMode: input.profile.selection.webMode,
          memory: {
            mode: input.profile.selection.memory?.mode ?? "auto",
            retrievalMode: input.profile.selection.memory?.retrievalMode ?? "standard",
            workspaceId:
              input.profile.selection.memory?.workspaceId ?? input.profile.identity?.workspaceId ?? "default",
            writeApprovalRequired: input.profile.selection.memory?.writeApprovalRequired ?? true,
          },
          thinkingLevel: input.profile.selection.thinkingLevel,
          speedMode: input.profile.selection.speedMode,
          subagentPolicy: input.profile.selection.subagentPolicy,
          toolAutonomy: input.profile.selection.toolAutonomy,
          allowedFallbacks: input.profile.selection.allowedFallbacks ?? [],
          tools: (input.profile.selection.tools ?? []).map((tool) => ({
            canonicalName: tool.canonicalName,
            modelName: tool.modelName,
            definitionHash: tool.definitionHash,
          })),
          trustedSkills: (input.profile.selection.trustedSkills ?? []).map((skill) => ({
            capabilityId: skill.capabilityId,
            skillId: skill.skillId,
            lifecycleState: skill.lifecycleState,
            treeSha256: skill.treeSha256,
          })),
        },
        governance: {
          permissionProfileHash: input.profile.governance?.permission?.profileHash ?? "legacy-missing-permission-hash",
          approvalMode: input.profile.governance?.permission?.approvalMode ?? "prompt",
          activeGrants: (input.profile.governance?.activeGrants ?? []).map((grant) => ({
            grantId: grant.grantId,
            decision: grant.decision,
            scope: grant.scope,
            scopeRef: grant.scopeRef,
            constraints: grant.constraints,
            expiresAt: grant.expiresAt,
          })),
          policyDecisions: input.profile.governance?.policyDecisions ?? [],
          authReadiness: input.profile.governance?.authReadiness ?? [],
        },
      }
    : { legacySelection: true };
  const profileFingerprint = createHash("sha256").update(canonicalJsonString(stableProfile)).digest("hex");
  const dimensionHash = createHash("sha256")
    .update(
      canonicalJsonString({
        version: 1,
        providerId: input.providerId ?? null,
        model: input.model ?? null,
        profileFingerprint,
      }),
    )
    .digest("hex");
  return {
    dimensionHash,
    providerId: input.providerId,
    model: input.model,
    profileFingerprint,
    persistState: input.persistState ?? true,
  };
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
    userMessageId?: string;
    turnId?: string;
    assistantMessageId?: string;
    mutationLifecycle?: ChatStreamMutationLifecycle;
    /** Explicit authority admitted before any routing or preparation mutation. */
    turnAdmission?: ActiveTurnAdmission;
    capabilityProfileId?: string;
    capabilityProfileHash?: string;
    /** Original admitted user content when this is a durable continuation. */
    capabilityProfileContent?: string;
    /** Exact server-only posture; never accepted from a client request. */
    serverOnlyPosture?: SystemHeartbeatTurnPrepPosture;
  },
): Promise<PreparedAgentChatTurn> {
  const turnId = options?.turnId ?? randomUUID();
  const systemHeartbeatPosture = readSystemHeartbeatTurnPrepPosture(input, options, turnId);
  assertPrepTurnAdmission(host, options?.turnAdmission);
  const session = host.getSession(sessionId);
  if (!systemHeartbeatPosture) {
    prepCanonicalWrite(host, options?.turnAdmission, () => host.ensureChatSessionRuntimeGrants(sessionId));
  }
  const sessionMeta = host.storage.chatSessionMeta.get(sessionId);
  if (!sessionMeta) {
    throw new NotFoundError({ entity: "Chat session", id: sessionId });
  }
  assertChatSessionActive(sessionId, sessionMeta.lifecycleStatus);
  const workspaceId = host.normalizeWorkspaceId(sessionMeta.workspaceId);
  if (options?.turnAdmission?.identity.workspaceId !== undefined) {
    const identity = options.turnAdmission.identity;
    if (identity.workspaceId !== workspaceId || identity.sessionId !== sessionId || identity.turnId !== turnId) {
      throw new ConflictError({
        message: "The Chat turn admission does not match the prepared workspace/session/turn.",
      });
    }
  }
  const citadelId = host.storage.workspaces?.find(workspaceId)?.citadelId ?? DEFAULT_CITADEL_ID;
  const branchKind = options?.branchKind ?? "append";
  const sessionStatePromise = host.loadChatTurnSessionState(sessionId);
  let existingUserMessage = options?.existingUserMessage;
  if (!systemHeartbeatPosture && !existingUserMessage && options?.userMessageId) {
    const candidate = (await sessionStatePromise).messagesById.get(options.userMessageId);
    if (candidate) {
      if (
        candidate.sessionId !== sessionId ||
        candidate.role !== "user" ||
        candidate.content.trim() !== input.content.trim()
      ) {
        throw new Error(`Deterministic user message ${options.userMessageId} conflicts with the requested turn.`);
      }
      existingUserMessage = candidate;
    }
  }
  const content = (existingUserMessage?.content ?? input.content).trim();
  if (!content) {
    throw new Error("content is required");
  }
  if (options?.turnAdmission) {
    const identity = options.turnAdmission.identity;
    if (identity.sessionId !== sessionId || identity.turnId !== turnId) {
      throw new ConflictError({ message: "The Chat turn admission does not match the prepared session and turn." });
    }
  }
  if (Boolean(options?.capabilityProfileId) !== Boolean(options?.capabilityProfileHash)) {
    throw new Error("A durable Chat capability profile id and hash must be supplied together.");
  }
  let boundCapabilityProfile: ChatTurnCapabilityProfileRecord | undefined;
  if (options?.capabilityProfileId && options.capabilityProfileHash) {
    if (!host.loadChatTurnCapabilityProfile) {
      throw new Error("This runtime cannot load the capability profile bound to the durable Chat turn.");
    }
    boundCapabilityProfile = host.loadChatTurnCapabilityProfile({
      profileId: options.capabilityProfileId,
      profileHash: options.capabilityProfileHash,
      sessionId,
      turnId,
    });
  }
  const capabilityProfileContent = boundCapabilityProfile
    ? (options?.capabilityProfileContent ?? content).trim()
    : undefined;
  if (boundCapabilityProfile && !capabilityProfileContent) {
    throw new Error("A durable Chat capability profile must retain its original admitted content.");
  }
  const normalizedCandidate = normalizeAgentInputFromSend({
    ...input,
    content: capabilityProfileContent ?? content,
  });
  const normalized: NormalizedAgentInputFromSend = boundCapabilityProfile
    ? {
        ...normalizedCandidate,
        mode: boundCapabilityProfile.selection.mode,
        webMode: boundCapabilityProfile.selection.webMode,
        memoryMode: boundCapabilityProfile.selection.memory.mode,
        thinkingLevel: boundCapabilityProfile.selection.thinkingLevel,
        speedMode: boundCapabilityProfile.selection.speedMode,
        subagentPolicy: boundCapabilityProfile.selection.subagentPolicy,
      }
    : normalizedCandidate;
  const executionProfile = executionProfileFromNormalizationProfile(normalized.normalizationProfile);
  const quickWebTurn = executionProfile === "quick_web";
  if (!systemHeartbeatPosture && branchKind !== "retry") {
    prepCanonicalWrite(host, options?.turnAdmission, () => host.maybeAutoTitleChatSession(sessionId, content));
  }

  const route = host.routeFromSession(session);
  const ingestUserMessage = options?.ingestUserMessage ?? !existingUserMessage;
  let userEventId = existingUserMessage?.messageId ?? "";
  let userMessage: ChatMessageRecord;
  if (systemHeartbeatPosture) {
    const deterministicMessageId = options?.userMessageId?.trim();
    if (!deterministicMessageId) {
      throw new Error("System heartbeat preparation requires its deterministic internal message identity.");
    }
    const sessionState = await sessionStatePromise;
    if (sessionState.messagesById.has(deterministicMessageId)) {
      throw new ConflictError({
        message: "System heartbeat internal input identity conflicts with a persisted Chat message.",
      });
    }
    userEventId = deterministicMessageId;
    userMessage = {
      messageId: deterministicMessageId,
      sessionId,
      // The current objective must remain a user-role model input, but its
      // provenance is explicitly system-owned and it is never persisted.
      role: "user",
      actorType: "system",
      actorId: HEARTBEAT_SYSTEM_ACTOR_ID,
      content,
      timestamp: new Date().toISOString(),
    };
  } else if (ingestUserMessage || !existingUserMessage) {
    assertPrepTurnAdmission(host, options?.turnAdmission);
    const uploadAttachments = host.storage.chatAttachments.listByIds(input.attachments ?? [], workspaceId);
    const inputParts = appendMobileContextParts(
      normalizeChatInputParts(content, input.parts, uploadAttachments),
      input.mobileContext,
    );
    userEventId = options?.userMessageId ?? randomUUID();
    let userIngestAdmissionChecked = false;
    await host.ingestEvent(
      randomUUID(),
      {
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
      },
      {
        onCommit: () => {
          assertPrepTurnAdmission(host, options?.turnAdmission);
          userIngestAdmissionChecked = true;
          options?.mutationLifecycle?.commitAlongsideCanonicalWrite?.();
        },
        afterCommit: () => options?.mutationLifecycle?.markCommitted(),
      },
    );
    assertPrepTurnAdmission(host, options?.turnAdmission);
    if (options?.turnAdmission && !userIngestAdmissionChecked) {
      throw new ConflictError({ message: "The Chat user-message ingest skipped its mutation-admission fence." });
    }
    // Append-only evidence for a user-message commit that already happened.
    // This does not claim current session authority and is intentionally kept
    // separate from normal turn writes.
    await recordMobileContextTurnProvenance(host, sessionId, userEventId, input.mobileContext);
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
    userMessage = existingUserMessage;
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

  const prefsOverride = applyChatModePresetToPatch({
    ...(input.prefsOverride ?? {}),
    mode: "chat",
    providerId: input.providerId ?? input.prefsOverride?.providerId,
    model: input.model ?? input.prefsOverride?.model,
    webMode: input.webMode ?? input.prefsOverride?.webMode,
    memoryMode: input.memoryMode ?? input.prefsOverride?.memoryMode,
    thinkingLevel: input.thinkingLevel ?? input.prefsOverride?.thinkingLevel,
    speedMode: input.speedMode ?? input.prefsOverride?.speedMode,
    subagentPolicy: input.subagentPolicy ?? input.prefsOverride?.subagentPolicy,
  });
  const splitPrefs = splitChatPrefsPatch(prefsOverride);
  let persistedPrefs: ChatSessionPrefsRecord;
  if (systemHeartbeatPosture) {
    const existingPrefs = host.storage.chatSessionPrefs.get(sessionId);
    if (!existingPrefs) {
      throw new Error(`System heartbeat session ${sessionId} has no persisted Chat preferences.`);
    }
    persistedPrefs = existingPrefs;
  } else if (boundCapabilityProfile) {
    persistedPrefs = prepCanonicalWrite(host, options?.turnAdmission, () =>
      host.storage.chatSessionPrefs.ensure(sessionId),
    );
  } else {
    persistedPrefs = prepCanonicalWrite(host, options?.turnAdmission, () => {
      if (Object.keys(splitPrefs.autonomyPatch).length > 0) {
        host.patchSessionAutonomyPrefs(sessionId, splitPrefs.autonomyPatch);
      }
      return host.ensureChatSessionModelDefaults(
        sessionId,
        host.storage.chatSessionPrefs.patch(sessionId, splitPrefs.basePatch),
      );
    });
  }
  const prefs: ChatSessionPrefsRecord = boundCapabilityProfile
    ? {
        ...persistedPrefs,
        mode: boundCapabilityProfile.selection.mode,
        providerId: boundCapabilityProfile.selection.effectiveProviderId,
        model: boundCapabilityProfile.selection.effectiveModel,
        webMode: boundCapabilityProfile.selection.webMode,
        memoryMode: boundCapabilityProfile.selection.memory.mode,
        thinkingLevel: boundCapabilityProfile.selection.thinkingLevel,
        speedMode: boundCapabilityProfile.selection.speedMode,
        subagentPolicy: boundCapabilityProfile.selection.subagentPolicy,
        toolAutonomy: boundCapabilityProfile.selection.toolAutonomy,
      }
    : persistedPrefs;
  const effectiveProviderRoute = boundCapabilityProfile
    ? undefined
    : host.resolveChatTurnEffectiveRoute?.(sessionId, input);
  const effectiveProviderId =
    boundCapabilityProfile?.selection.effectiveProviderId ??
    effectiveProviderRoute?.effectiveProviderId ??
    input.providerId ??
    prefs.providerId;
  const effectiveModel =
    boundCapabilityProfile?.selection.effectiveModel ??
    effectiveProviderRoute?.effectiveModel ??
    input.model ??
    prefs.model;
  const persistedAutonomy = systemHeartbeatPosture
    ? host.storage.sessionAutonomyPrefs.get(sessionId)
    : host.getSessionAutonomyPrefs(sessionId);
  if (!persistedAutonomy) {
    throw new Error(`System heartbeat session ${sessionId} has no persisted autonomy preferences.`);
  }
  const autonomy: SessionAutonomyPrefsRecord = boundCapabilityProfile
    ? {
        ...persistedAutonomy,
        retrievalMode: boundCapabilityProfile.selection.memory.retrievalMode,
      }
    : persistedAutonomy;
  const modelRouterDecision = routeWithModelRouter({
    prompt: content,
    hasAttachments: Boolean(input.attachments?.length || input.parts?.some((part) => part.type !== "text")),
  });
  const projectId = host.storage.chatSessionProjects.get(sessionId)?.projectId;
  const effectiveMode = "chat";
  const requiresProjectBinding = chatModeRequiresProjectBinding(effectiveMode);
  const missingRequiredProjectBinding = requiresProjectBinding && !projectId;
  const effectiveToolAutonomy = boundCapabilityProfile
    ? boundCapabilityProfile.selection.toolAutonomy
    : prefs.planningMode === "advisory" || missingRequiredProjectBinding
      ? "manual"
      : prefs.toolAutonomy;
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
    if (!quickWebTurn && !host.resolveChatTurnCapabilityProfile && host.resolveBasePromptCapabilityCatalog) {
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
          model: effectiveModel ?? "unknown",
          providerId: effectiveProviderId ?? "unknown",
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
  const hasRoutedContextRefs = input.contextRefs !== undefined;
  if (hasRoutedContextRefs && boundCapabilityProfile) {
    throw new ConflictError({
      message: "Durable routed-context replay requires its persisted snapshot binding.",
    });
  }
  // Routed bytes are data, never capability-selection instructions. Preserve
  // the preflight capability/compaction binding and freeze the complete profile
  // before any routed source is read.
  const preflightCompactionDimensionHash = input.routeDecision?.capabilityCompactionDimensionHash;
  let compactionDimension = boundCapabilityProfile
    ? buildChatCompactionDimension({
        providerId: effectiveProviderId,
        model: effectiveModel,
        profile: boundCapabilityProfile,
      })
    : preflightCompactionDimensionHash
      ? {
          dimensionHash: preflightCompactionDimensionHash,
          providerId: effectiveProviderId,
          model: effectiveModel,
          profileFingerprint: preflightCompactionDimensionHash,
          persistState: true,
        }
      : buildChatCompactionDimension({
          providerId: effectiveProviderId,
          model: effectiveModel,
          // A direct send without capability preflight must use one exact,
          // non-mutating history for both profile selection and execution.
          persistState: false,
        });
  if (systemHeartbeatPosture) {
    compactionDimension = { ...compactionDimension, persistState: false };
  }
  let history = await host.buildLlmMessagesFromBranchPath(
    sessionId,
    contextPathTurnIds,
    userMessage,
    {
      providerId: effectiveProviderId,
      model: effectiveModel,
      guidanceSystemInstruction,
      compactionDimension,
    },
    sessionState,
  );
  if (hasRoutedContextRefs) {
    history = upsertChatRoutedContextSystemInstruction(history, "");
  }

  let capabilityResolution: ChatTurnCapabilityProfileResolution | undefined;
  let capabilityProfile = boundCapabilityProfile;
  let routedContextSnapshot: ChatRoutedContextSnapshotRecord | undefined;
  if (!capabilityProfile && host.resolveChatTurnCapabilityProfile) {
    if (!effectiveProviderRoute) {
      throw new ConflictError({
        message: "The server could not freeze a provider/model route for this capability-bound turn.",
      });
    }
    const resolveCapabilityProfile = (historyMessages: ChatCompletionRequest["messages"]) =>
      host.resolveChatTurnCapabilityProfile!({
        sessionId,
        turnId,
        workspaceId,
        citadelId,
        route,
        content,
        prefs,
        autonomy,
        normalized,
        effectiveMode,
        effectiveToolAutonomy,
        routeResolution: effectiveProviderRoute,
        historyMessages,
        request: input,
      });
    if (!preflightCompactionDimensionHash && contextPathTurnIds.length > 0) {
      const tentativeResolution = await resolveCapabilityProfile(history);
      assertCapabilityProfileMatchesFrozenRoute(tentativeResolution.profile, effectiveProviderRoute);
      compactionDimension = buildChatCompactionDimension({
        providerId: effectiveProviderId,
        model: effectiveModel,
        profile: tentativeResolution.profile,
      });
      if (systemHeartbeatPosture) {
        compactionDimension = { ...compactionDimension, persistState: false };
      }
      history = await host.buildLlmMessagesFromBranchPath(
        sessionId,
        contextPathTurnIds,
        userMessage,
        {
          providerId: effectiveProviderId,
          model: effectiveModel,
          guidanceSystemInstruction,
          compactionDimension,
        },
        sessionState,
      );
      if (hasRoutedContextRefs) {
        history = upsertChatRoutedContextSystemInstruction(history, "");
      }
    }
    capabilityResolution = await resolveCapabilityProfile(history);
    capabilityProfile = capabilityResolution.profile;
    assertCapabilityProfileMatchesFrozenRoute(capabilityProfile, effectiveProviderRoute);
  }
  if (capabilityProfile) {
    assertCapabilityProfileMatchesCurrentScope(capabilityProfile, {
      sessionId,
      turnId,
      workspaceId,
      citadelId,
      route,
    });
  }
  const sealedCompactionDimension = buildChatCompactionDimension({
    providerId: effectiveProviderId,
    model: effectiveModel,
    profile: capabilityProfile,
  });
  if (
    compactionDimension.persistState !== false &&
    sealedCompactionDimension.dimensionHash !== compactionDimension.dimensionHash
  ) {
    throw new ConflictError({
      message: "The capability selection changed after history compaction. Refresh route status and retry.",
    });
  }
  compactionDimension = systemHeartbeatPosture
    ? { ...sealedCompactionDimension, persistState: false }
    : sealedCompactionDimension;
  if (
    input.routeDecision?.capabilityFingerprint &&
    capabilityProfile?.preflightFingerprint !== input.routeDecision.capabilityFingerprint
  ) {
    throw new ConflictError({
      message: "The server-owned capability profile changed after route preflight. Refresh route status and retry.",
    });
  }
  if (hasRoutedContextRefs) {
    if (!capabilityProfile || !effectiveProviderRoute) {
      throw new ConflictError({ message: "Routed context requires server-owned capability resolution." });
    }
    assertRoutedContextRouteDecisionMatchesFrozenRoute(input.routeDecision, effectiveProviderRoute);
    if (capabilityProfile.selection.subagentPolicy !== "off") {
      throw new ConflictError({
        message:
          "Routed context requires subagent policy off because its frozen provider/model budget cannot be delegated. " +
          "Set subagent policy to off and retry.",
      });
    }
  }
  if (capabilityProfile) {
    history = upsertChatCapabilityProfileSystemInstruction(history, capabilityProfile);
  }
  if (hasRoutedContextRefs) {
    if (!capabilityProfile || !effectiveProviderRoute) {
      throw new ConflictError({ message: "Routed context requires server-owned capability resolution." });
    }
    const frozenProfileJson = canonicalJsonString(capabilityProfile);
    const routeContextWindowTokens = requireRoutedContextWindow(
      host,
      effectiveProviderRoute.effectiveProviderId,
      effectiveProviderRoute.effectiveModel,
    );
    const resolvedSources = await host.resolveChatRoutedContextSources({
      refs: input.contextRefs,
      sessionId,
      workspaceId,
      memoryMode: capabilityProfile.selection.memory.mode,
      // Global memory remains denied until a server-owned profile field
      // explicitly admits it. Client refs can never widen this boundary.
      allowGlobalMemory: false,
      ordinaryAttachmentIds: collectOrdinaryAttachmentIds(input),
    });
    routedContextSnapshot = buildChatRoutedContextSnapshot({
      resolved: resolvedSources,
      turnId,
      sessionId,
      workspaceId,
      capabilityProfile,
      routeContextWindowTokens,
      // Includes the exact final capability-profile instruction and excludes
      // any prior routed block, so budget receipts cover real prompt overhead.
      baseHistoryMessages: history,
    });
    if (canonicalJsonString(capabilityProfile) !== frozenProfileJson) {
      throw new ConflictError({ message: "Routed context attempted to mutate the frozen capability profile." });
    }
    history = upsertChatRoutedContextSystemInstruction(history, routedContextSnapshot.contextText);
  }

  if (!systemHeartbeatPosture && sessionMeta.pinnedGoal) {
    prepCanonicalWrite(host, options?.turnAdmission, () => {
      const turnsUsed = host.storage.chatSessionMeta.incrementGoalTurnsUsed(sessionId);
      const { cleared } = advanceGoalForTurn({
        turnsUsed,
        turnBudget: sessionMeta.goalTurnBudget ?? null,
      });
      if (cleared) {
        host.storage.chatSessionMeta.patchWithRevision(
          sessionId,
          {
            pinnedGoal: null,
            goalTurnBudget: null,
            goalSetAt: null,
          },
          sessionMeta.revision,
        );
      }
    });
  }

  const recoveryActorId = resolveCompactionRecoveryActor(input);
  const pendingForceAction =
    !systemHeartbeatPosture && recoveryActorId
      ? host.resolvePendingCompactionBreakerForceAction?.({
          sessionId,
          sealedDimensionHash: sealedCompactionDimension.dimensionHash,
          actorId: recoveryActorId,
        })
      : undefined;
  if (pendingForceAction) {
    compactionDimension = {
      ...sealedCompactionDimension,
      forceAction: pendingForceAction,
    };
    // All capability, routed-context, and goal preflight work has completed.
    // This final canonical build is the only call allowed to atomically settle
    // the one-shot force action. The routed-context budget above used the
    // un-compacted history, so applying the already-attested snapshot to a
    // successful (shorter) compaction remains conservative.
    history = await host.buildLlmMessagesFromBranchPath(
      sessionId,
      contextPathTurnIds,
      userMessage,
      {
        providerId: effectiveProviderId,
        model: effectiveModel,
        guidanceSystemInstruction,
        compactionDimension,
      },
      sessionState,
    );
    if (capabilityProfile) {
      history = upsertChatCapabilityProfileSystemInstruction(history, capabilityProfile);
    }
    if (routedContextSnapshot) {
      history = upsertChatRoutedContextSystemInstruction(history, routedContextSnapshot.contextText);
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
    turnId,
    ...(options?.turnAdmission ? { turnAdmission: options.turnAdmission } : {}),
    ...(systemHeartbeatPosture ? { serverOnlyPosture: Object.freeze({ ...systemHeartbeatPosture }) } : {}),
    assistantMessageId: options?.assistantMessageId ?? `assistant-${randomUUID()}`,
    parentTurnId,
    parentDelegationStepId: userMessage.parentDelegationStepId ?? input.parentDelegationStepId,
    branchKind,
    sourceTurnId: options?.sourceTurnId,
    effectiveToolAutonomy,
    compactionDimensionHash: compactionDimension.dimensionHash,
    ...(capabilityProfile ? { capabilityProfile } : {}),
    ...(capabilityProfileContent ? { capabilityProfileContent } : {}),
    ...(capabilityResolution ? { capabilityCatalogSnapshot: capabilityResolution.catalogSnapshot } : {}),
    ...(routedContextSnapshot ? { routedContextSnapshot } : {}),
  };
  if (!systemHeartbeatPosture) {
    prepCanonicalWrite(host, options?.turnAdmission, () =>
      recordPreparedTurnDecisions(host, prepared, {
        projectId,
        missingRequiredProjectBinding,
        guidanceFileCount: resolvedGuidance.globalFilesUsed.length + resolvedGuidance.workspaceFilesUsed.length,
        threadKnowledgeCitationCount: threadKnowledgeContext.citations.length,
      }),
    );
  }
  return prepared;
}

function readSystemHeartbeatTurnPrepPosture(
  input: ChatSendMessageRequest,
  options: Parameters<typeof prepareAgentChatTurn>[3],
  turnId: string,
): SystemHeartbeatTurnPrepPosture | undefined {
  const posture = options?.serverOnlyPosture;
  if (!posture) return undefined;
  const admission = options?.turnAdmission;
  const occurrence = admission?.systemHeartbeatOccurrence;
  if (
    posture.kind !== "system_heartbeat" ||
    posture.actorId !== HEARTBEAT_SYSTEM_ACTOR_ID ||
    posture.operation !== "chat_system_heartbeat" ||
    !posture.occurrenceId ||
    !posture.claimSha256 ||
    !posture.durableRunId ||
    !admission ||
    !occurrence ||
    occurrence.kind !== "system_heartbeat_occurrence" ||
    occurrence.operation !== posture.operation ||
    occurrence.occurrenceId !== posture.occurrenceId ||
    occurrence.correlationId !== posture.occurrenceId ||
    occurrence.claimSha256 !== posture.claimSha256 ||
    occurrence.durableRunId !== posture.durableRunId ||
    admission.identity.turnId !== turnId ||
    admission.requestActor.actorKind !== "system" ||
    admission.requestActor.actorId !== HEARTBEAT_SYSTEM_ACTOR_ID ||
    input.operatorId !== HEARTBEAT_SYSTEM_ACTOR_ID ||
    input.authActorId !== HEARTBEAT_SYSTEM_ACTOR_ID ||
    input.authActorSource !== "none" ||
    options?.ingestUserMessage !== false ||
    options?.existingUserMessage !== undefined
  ) {
    throw new ConflictError({ message: "System heartbeat preparation lacks its exact server-only admission posture." });
  }
  return posture;
}

function assertPrepTurnAdmission(host: ChatTurnPrepHost, admission: ActiveTurnAdmission | undefined): void {
  if (!admission) return;
  if (!host.assertTurnAdmissionWrite) {
    throw new ConflictError({ message: "The Chat preparation host cannot verify its mutation admission." });
  }
  host.assertTurnAdmissionWrite(admission);
}

function prepCanonicalWrite<T>(host: ChatTurnPrepHost, admission: ActiveTurnAdmission | undefined, work: () => T): T {
  if (!admission) return work();
  return host.storage.runImmediateTransaction(() => {
    assertPrepTurnAdmission(host, admission);
    const result = work();
    assertPrepTurnAdmission(host, admission);
    return result;
  });
}

function resolveCompactionRecoveryActor(input: ChatSendMessageRequest): string | undefined {
  if (input.authActorSource !== "token" && input.authActorSource !== "basic" && input.authActorSource !== "loopback") {
    return undefined;
  }
  const actorId = input.authActorId?.trim();
  return actorId && actorId !== "auth:none" ? actorId : undefined;
}

function requireRoutedContextWindow(
  host: ChatTurnPrepHost,
  providerId: string | undefined,
  model: string | undefined,
): number {
  if (!providerId || !model) {
    throw new ConflictError({ message: "Routed context requires a frozen effective provider and model." });
  }
  const contextWindow = host.llmService.getModelContextWindow(providerId, model);
  if (!Number.isSafeInteger(contextWindow) || (contextWindow ?? 0) <= 0) {
    throw new ConflictError({
      message: `The frozen route ${providerId}/${model} lacks trusted context-window metadata.`,
    });
  }
  return contextWindow as number;
}

function collectOrdinaryAttachmentIds(input: ChatSendMessageRequest): string[] {
  const ids = new Set((input.attachments ?? []).map((id) => id.trim()).filter(Boolean));
  for (const part of input.parts ?? []) {
    if (part.type !== "text" && part.attachmentId.trim()) {
      ids.add(part.attachmentId.trim());
    }
  }
  return [...ids];
}

function assertRoutedContextRouteDecisionMatchesFrozenRoute(
  decision: ChatSendMessageRequest["routeDecision"],
  route: ResolvedChatRouteDescriptor,
): void {
  if (
    decision &&
    (decision.effectiveProviderId !== route.effectiveProviderId || decision.effectiveModel !== route.effectiveModel)
  ) {
    throw new ConflictError({
      message: "The routed-context request no longer matches its frozen provider/model route.",
    });
  }
}

const ROUTED_CONTEXT_SYSTEM_PREFIX = "Routed context snapshot (immutable).";

export function upsertChatRoutedContextSystemInstruction(
  history: ChatCompletionRequest["messages"],
  contextText: string,
): ChatCompletionRequest["messages"] {
  const withoutPriorBinding = history.filter(
    (message) =>
      !(
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith(ROUTED_CONTEXT_SYSTEM_PREFIX)
      ),
  );
  if (!contextText) {
    return withoutPriorBinding;
  }
  const insertionIndex = withoutPriorBinding.findIndex((message) => message.role !== "system");
  const next = [...withoutPriorBinding];
  next.splice(insertionIndex < 0 ? next.length : insertionIndex, 0, { role: "system", content: contextText });
  return next;
}

function assertCapabilityProfileMatchesFrozenRoute(
  profile: ChatTurnCapabilityProfileRecord,
  route: ResolvedChatRouteDescriptor,
): void {
  if (
    profile.selection.effectiveProviderId !== route.effectiveProviderId ||
    profile.selection.effectiveModel !== route.effectiveModel
  ) {
    throw new ConflictError({
      message: "The capability profile route did not match the provider/model route frozen for prompt preparation.",
    });
  }
}

function assertCapabilityProfileMatchesCurrentScope(
  profile: ChatTurnCapabilityProfileRecord,
  current: {
    sessionId: string;
    turnId: string;
    workspaceId: string;
    citadelId: string;
    route: ChatTurnRoute;
  },
): void {
  const expectedSource = buildChatTurnCapabilityProfileSourceScope(current.route);
  if (
    profile.identity.sessionId !== current.sessionId ||
    profile.identity.turnId !== current.turnId ||
    profile.identity.workspaceId !== current.workspaceId ||
    profile.identity.citadelId !== current.citadelId ||
    canonicalJsonString(profile.source) !== canonicalJsonString(expectedSource)
  ) {
    throw new ConflictError({
      message: "The capability profile does not match the current Chat turn, workspace, Citadel, or source scope.",
    });
  }
}

export function upsertChatCapabilityProfileSystemInstruction(
  history: ChatCompletionRequest["messages"],
  profile: ChatTurnCapabilityProfileRecord,
): ChatCompletionRequest["messages"] {
  const withoutPriorBinding = history.filter(
    (message) =>
      !(
        message.role === "system" &&
        typeof message.content === "string" &&
        message.content.startsWith("Server-owned capability profile:")
      ),
  );
  const toolNames = profile.selection.tools.map((tool) => tool.canonicalName);
  const skillIds = profile.selection.trustedSkills.map((skill) => skill.skillId);
  const instruction = [
    `Server-owned capability profile: ${profile.profileId} (${profile.hashes.profileHash}).`,
    `Callable tools for this turn: ${toolNames.length > 0 ? toolNames.join(", ") : "none"}.`,
    `Trusted skills for this turn: ${skillIds.length > 0 ? skillIds.join(", ") : "none"}.`,
    `Memory scope: ${profile.selection.memory.mode}/${profile.selection.memory.retrievalMode}.`,
    "Treat this profile as an immutable upper bound. Capabilities not listed here are unavailable for this turn.",
  ].join("\n");
  const insertionIndex = withoutPriorBinding.findIndex((message) => message.role !== "system");
  const next = [...withoutPriorBinding];
  next.splice(insertionIndex < 0 ? next.length : insertionIndex, 0, { role: "system", content: instruction });
  return next;
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
  if (enforcePreparedRoutedContextOrchestrationBypass(prepared)) {
    return undefined;
  }
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
    // Round-3 review M3: stage-leveling fallback can drop fan-out extras from
    // the executed plan; trim the draft to match so the persisted
    // execution-plan record cannot carry forever-pending phantom steps.
    executionPlanDraft: trimExecutionPlanDraftToPlan(executionPlanDraft, plan),
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
    prepared.prefs.subagentPolicy !== "off" && !advisoryOnly && !host.isFeatureEnabled("plannerFanoutV1Disabled");
  const maxExtraWorkerSteps = Math.max(0, MAX_PLANNER_PRODUCTION_STEPS - countPlannerProductionSteps(templatePlan));
  // Bound and drain the planner so a timeout cannot return a deterministic
  // fallback while model-usage settlement is still in flight.
  const plannerRequest: ChatCompletionRequest = {
    providerId: plannerDraftModel?.providerId ?? prepared.prefs.providerId,
    model: plannerDraftModel?.model ?? prepared.prefs.model,
    stream: false,
    timeoutMs: CHAT_PLANNER_COMPLETION_TIMEOUT_MS,
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
          "If subagentPolicy is off, delegatedRole must be null for all steps. Otherwise, preserve delegatedRole where the template calls for worker, specialist, review, or synthesis handoff.",
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
          subagentPolicy: prepared.prefs.subagentPolicy,
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
  };
  const plannerLogicalRef = prepared.turnId
    ? encodeURIComponent(prepared.turnId)
    : createHash("sha256").update(prepared.content).digest("hex").slice(0, 32);
  const attribution = createUtilityModelUsageAttribution({
    operationId: `chat-turn:${plannerLogicalRef}:execution-plan-draft`,
    utilityKind: "chat_execution_plan_draft",
    requestedProviderId: plannerRequest.providerId,
    requestedModelId: plannerRequest.model,
    lineage: {
      workspaceId: prepared.workspaceId,
      sessionId: prepared.session?.sessionId,
      turnId: prepared.turnId,
      agentId: "execution-planner",
      parentOperationId: `chat-turn:${plannerLogicalRef}`,
    },
  });

  try {
    const outcome = await runBoundedUtilityModelCall({
      timeoutMs: CHAT_PLANNER_COMPLETION_TIMEOUT_MS,
      timeoutMessage: "chat execution planner timed out",
      start: (boundedSignal) => host.createChatCompletion({ ...plannerRequest, signal: boundedSignal }, attribution),
    });
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
  } catch (error) {
    if (isAuthoritativeModelUsageAccountingError(error)) {
      throw error;
    }
    // Planner rejected before the timeout (the race surfaced its rejection).
    return fallbackDraft;
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
