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
  SessionMeta,
} from "@goatcitadel/contracts";
import type { SessionAutonomyPrefsRecord, Storage } from "@goatcitadel/storage";
import { normalizeAgentInputFromSend, type NormalizedAgentInputFromSend } from "./chat-agent-input-normalization.js";
import { assertChatSessionActive, splitChatPrefsPatch } from "./chat-session-utils.js";
import { buildSelectedPathTurnIds } from "./chat-thread-utils.js";
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
  coercePlannerExecutionPlanDraft,
  extractCompletionText,
  extractSpecialistObjectiveKeywords,
  inferSpecialistBaseRole,
  mergeChatSystemInstructions,
  normalizeChatInputParts,
  parseLooseJsonRecord,
  type ResolvedRuntimeGuidance,
  scoreSpecialistCandidateMatch,
} from "./chat-turn-planning-helpers.js";
import type { PreparedChatExecutionPlanResolution } from "./chat-turn-types.js";
import type { LlmService } from "./llm-service.js";
import type { ResolvedThreadKnowledgeContext } from "./chat-thread-knowledge-service.js";

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
  "chatAttachments" | "chatSessionMeta" | "chatSessionPrefs" | "chatSessionProjects" | "chatSpecialistCandidates"
>;

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
      guidanceSystemInstruction?: string;
    },
    state?: ChatTurnSessionState,
  ): Promise<ChatCompletionRequest["messages"]>;
  createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
}

export interface PreparedAgentChatTurn {
  session: SessionMeta;
  route: ChatTurnRoute;
  workspaceId: string;
  content: string;
  userEventId: string;
  userMessage: ChatMessageRecord;
  prefs: ChatSessionPrefsRecord;
  autonomy: SessionAutonomyPrefsRecord;
  normalized: NormalizedAgentInputFromSend;
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
  const branchKind = options?.branchKind ?? "append";
  const content = (options?.existingUserMessage?.content ?? input.content).trim();
  if (!content) {
    throw new Error("content is required");
  }
  if (branchKind !== "retry") {
    host.maybeAutoTitleChatSession(sessionId, content);
  }

  const route = host.routeFromSession(session);
  const ingestUserMessage = options?.ingestUserMessage ?? !options?.existingUserMessage;
  let userEventId = options?.existingUserMessage?.messageId ?? "";
  let userMessage: ChatMessageRecord;
  if (ingestUserMessage || !options?.existingUserMessage) {
    const uploadAttachments = host.storage.chatAttachments.listByIds(input.attachments ?? [], workspaceId);
    const inputParts = normalizeChatInputParts(content, input.parts, uploadAttachments);
    userEventId = randomUUID();
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
  const normalized = normalizeAgentInputFromSend(input);
  const projectId = host.storage.chatSessionProjects.get(sessionId)?.projectId;
  const requiresProjectBinding = chatModeRequiresProjectBinding(prefs.mode);
  const missingRequiredProjectBinding = requiresProjectBinding && !projectId;
  const effectiveToolAutonomy =
    prefs.planningMode === "advisory" || missingRequiredProjectBinding ? "manual" : prefs.toolAutonomy;
  const retrievalTrace = buildRetrievalTrace({
    content,
    retrievalMode: autonomy.retrievalMode,
    webMode: normalized.webMode ?? prefs.webMode,
    memoryMode: normalized.memoryMode ?? prefs.memoryMode,
  });
  const resolvedGuidance = await host.resolveRuntimeGuidance(workspaceId);
  const threadKnowledgeContext = await host.resolveThreadKnowledgeContext(sessionId, content);
  const personalityOverlay = prefs.mode === "chat" ? host.buildDefaultChatPersonalityOverlay() : undefined;
  const goalAdjustedBaseGuidance = applyGoalToGuidanceSystemInstruction({
    baseInstruction: undefined,
    goal: sessionMeta.pinnedGoal ?? null,
  });
  const guidanceSystemInstruction = mergeChatSystemInstructions(
    goalAdjustedBaseGuidance || undefined,
    resolvedGuidance.systemInstruction,
    threadKnowledgeContext.systemInstruction,
    personalityOverlay,
    buildPlanningModeSystemInstruction(prefs.planningMode),
    missingRequiredProjectBinding
      ? "Code mode requires a bound project before execution-heavy work. Until a project is attached, stay in planning and review posture, and do not imply that repository-bound edits or filesystem inspection were executed."
      : undefined,
    options?.extraSystemInstruction,
  );

  const sessionState = await host.loadChatTurnSessionState(sessionId);
  const hasExplicitParentTurnId = Object.prototype.hasOwnProperty.call(options ?? {}, "parentTurnId");
  const parentTurnId = hasExplicitParentTurnId ? options?.parentTurnId : sessionState.activeLeafTurnId;
  const pathTurnIds = parentTurnId ? buildSelectedPathTurnIds(sessionState.turnLineageById, parentTurnId) : [];
  const conversationMessages = pathTurnIds.flatMap((turnId) => {
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
    pathTurnIds,
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

  return {
    session,
    route,
    workspaceId,
    content,
    userEventId,
    userMessage,
    prefs,
    autonomy,
    normalized,
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
}

export async function resolvePreparedTurnOrchestration(
  host: ChatTurnPrepHost,
  prepared: PreparedAgentChatTurn,
): Promise<PreparedChatExecutionPlanResolution | undefined> {
  const mode = prepared.normalized.mode ?? prepared.prefs.mode;
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
      objective: prepared.content,
      prefs: prepared.prefs,
      conversation: prepared.conversationMessages,
      historyMessages: prepared.history,
    },
    runtime,
    capabilities,
    policy,
  };
  const advisoryOnly = prepared.prefs.planningMode === "advisory";
  if (!advisoryOnly && !shouldUseModeOrchestration(routerInput)) {
    return undefined;
  }
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
  const mode = prepared.normalized.mode ?? prepared.prefs.mode;
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
  try {
    const completion = await host.createChatCompletion({
      providerId: prepared.prefs.providerId,
      model: prepared.prefs.model,
      stream: false,
      memory: {
        enabled: false,
        mode: "off",
      },
      response_format: {
        type: "json_object",
      },
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
    });
    const payload = parseLooseJsonRecord(extractCompletionText(completion));
    const planned = payload
      ? coercePlannerExecutionPlanDraft(payload, templatePlan, {
          advisoryOnly,
          mode: routerInput.task.mode,
          objective: prepared.content,
        })
      : undefined;
    if (!planned) {
      return fallbackDraft;
    }
    return planned;
  } catch {
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
    })),
    integritySignals: input.integritySignals,
  };
}
