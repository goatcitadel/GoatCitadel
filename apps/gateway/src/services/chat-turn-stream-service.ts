/* eslint-disable max-lines -- Streaming remains centralized so turn persistence, SSE replay, and completion sequencing stay auditable together. */
/**
 * Chat turn streaming execution.
 *
 * Streaming chat-turn execution over the bounded runtime host.
 */

import { randomUUID } from "node:crypto";
import type {
  ChatCapabilityUpgradeSuggestion,
  ChatCitationRecord,
  ChatCompletionRequest,
  ChatCompletionResponse,
  ChatMode,
  ChatOrchestrationSummary,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatStreamChunkDraft,
  ChatSpecialistCandidateSuggestionRecord,
  ChatSessionCreateInput,
  ChatSessionPrefsPatch,
  ChatSessionRecord,
  ChatToolRunRecord,
  ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { TurnRuntime } from "@goatcitadel/orchestration";
import type {
  OrchestrationExecutionResult,
  OrchestrationPlan as ModeOrchestrationPlan,
  OrchestrationRouterInput,
  OrchestrationStepExecutionResult,
} from "../orchestration/types.js";
import { executeOrchestrationPlan } from "../orchestration/engine.js";
import { buildDelegatedChatSendRequest } from "./delegated-chat-request.js";
import {
  buildDelegationFailureGuidance,
  buildEmptyAssistantTurnFallbackText,
  ChatTurnCancelledError,
  dedupeChatCitations,
  isChatTurnCancelledError,
  mergeExecutionPlanStepStatuses,
  renderExecutionPlanAsMarkdown,
  splitIntoChunks,
  toTitleCase,
  truncateSummaryLine,
} from "./chat-turn-helpers.js";
import type { PreparedChatExecutionPlanResolution } from "./chat-turn-types.js";
import { buildChatTurnRealtimeOptions } from "./chat-turn-realtime.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";
import type { HooksService } from "./hooks-service.js";
import { enqueueAgentEndHook, observeBeforeAssistantMessageWrite } from "./chat-turn-stream-events.js";
import type {
  ChatTurnActiveExecutionControl,
  ChatTurnMemorySideEffects,
  ChatTurnRealtimeEmitter,
  ChatTurnSteerCollaborator,
  ChatTurnTranscriptIngress,
} from "./chat-turn-runtime-collaborators.js";
import { PROMPT_LAB_LOCAL_FILE_TOOL_NAMES } from "./chat-tool-families.js";

type ChatTurnStreamStorage = Pick<
  Storage,
  | "chatDelegationSteps"
  | "chatToolRuns"
  | "chatExecutionPlans"
  | "chatDelegationRuns"
  | "chatSessionProjects"
  | "chatTurnTraces"
>;

export interface ChatTurnStreamHost
  extends
    ChatTurnActiveExecutionControl,
    ChatTurnMemorySideEffects,
    ChatTurnRealtimeEmitter,
    ChatTurnSteerCollaborator,
    ChatTurnTranscriptIngress {
  readonly storage: ChatTurnStreamStorage;
  readonly turnRuntime: Pick<TurnRuntime, "runStream">;
  readonly hooksService: Pick<HooksService, "runInlineHooks" | "enqueueAfterHooks">;
  resolvePreparedTurnOrchestration(
    prepared: PreparedAgentChatTurn,
  ): Promise<PreparedChatExecutionPlanResolution | undefined>;
  createChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse>;
  recordDevDiagnostic(input: {
    level: "info" | "warn";
    category: string;
    event: string;
    message: string;
    sessionId?: string;
    turnId?: string;
    runId?: string;
    taskId?: string;
    stepId?: string;
    providerId?: string;
    modelId?: string;
    durationMs?: number;
    runtimeKind?: string;
    runtimeStatus?: "started" | "running" | "completed" | "failed" | "cancelled" | "blocked" | "degraded";
    runtimeError?: {
      name?: string;
      message: string;
      code?: string;
      retryable?: boolean;
    };
    context?: Record<string, unknown>;
  }): void;
  buildChatOrchestrationSummary(input: {
    runId: string;
    objective: string;
    modePolicy: ChatMode;
    routeDecision: ChatOrchestrationSummary["routeDecision"];
    stepResults: OrchestrationStepExecutionResult[];
    finalSummary?: string;
    integritySignals?: string[];
    finalized?: boolean;
    advisoryOnly?: boolean;
  }): NonNullable<ChatTurnTraceRecord["orchestration"]>;
  createChatSession(input: ChatSessionCreateInput): ChatSessionRecord;
  inheritDelegatedSessionToolGrants(sessionId: string, delegatedSessionId: string): void;
  updateChatSessionPrefs(sessionId: string, input: ChatSessionPrefsPatch): unknown;
  agentSendChatMessage(sessionId: string, input: ChatSendMessageRequest): Promise<ChatSendMessageResponse>;
  updateActiveLeafOrThrow(sessionId: string, previousActiveTurnId: string | undefined, nextActiveTurnId: string): void;
  collectCapabilityUpgradeSuggestions(input: {
    sessionId: string;
    content: string;
    assistantText: string;
    trace?: ChatTurnTraceRecord;
  }): Promise<ChatCapabilityUpgradeSuggestion[]>;
  collectSpecialistCandidateSuggestions(input: {
    sessionId: string;
    mode: ChatMode;
    content: string;
    capabilitySuggestions: ChatCapabilityUpgradeSuggestion[];
    trace: ChatTurnTraceRecord;
  }): ChatSpecialistCandidateSuggestionRecord[];
}

/**
 * Build the user-role chat messages that should be appended to the next LLM call so the
 * model sees the operator's mid-turn steers. Returns an empty array when no steers are
 * pending. Drains the steer queue as a side effect.
 */
export function drainSteerMessagesForLlm(
  steerService: ChatTurnStreamHost["steerService"],
  input: { sessionId: string; turnId: string },
): Array<{ role: "user"; content: string }> {
  const drained = steerService.drainPending({ sessionId: input.sessionId, turnId: input.turnId });
  return drained.map((item) => ({
    role: "user" as const,
    content: `[Steer] ${item.instruction}`,
  }));
}

export interface StreamWithSteerDrainInput {
  host: Pick<ChatTurnStreamHost, "steerService" | "createChatCompletion">;
  sessionId: string;
  turnId: string;
  request: ChatCompletionRequest;
}

/**
 * Wrap a single createChatCompletion call so any pending /steer instructions are
 * drained and appended to the request's messages before delegating to the underlying
 * completion. Used by orchestration so each step "sees" mid-turn nudges, and exposed
 * separately for focused tests.
 */
export async function streamWithSteerDrain(input: StreamWithSteerDrainInput): Promise<ChatCompletionResponse> {
  const steerMessages = drainSteerMessagesForLlm(input.host.steerService, {
    sessionId: input.sessionId,
    turnId: input.turnId,
  });
  if (steerMessages.length === 0) {
    return input.host.createChatCompletion(input.request);
  }
  const composed: ChatCompletionRequest = {
    ...input.request,
    messages: [...input.request.messages, ...steerMessages],
  };
  return input.host.createChatCompletion(composed);
}

export function collectOrchestrationToolRuns(host: ChatTurnStreamHost, runId: string): ChatToolRunRecord[] {
  const steps = host.storage.chatDelegationSteps.listByRun(runId);
  const childTurnIds = steps.map((step) => step.childTurnId).filter((value): value is string => Boolean(value));
  if (childTurnIds.length === 0) {
    return [];
  }
  const toolRunsByTurnId = host.storage.chatToolRuns.listByTurnIds(childTurnIds);
  const orderedToolRuns: ChatToolRunRecord[] = [];
  for (const step of steps) {
    if (!step.childTurnId) {
      continue;
    }
    const toolRuns = toolRunsByTurnId.get(step.childTurnId);
    if (toolRuns?.length) {
      orderedToolRuns.push(...toolRuns);
    }
  }
  return orderedToolRuns;
}

export async function executePreparedModeOrchestration(
  host: ChatTurnStreamHost,
  prepared: PreparedAgentChatTurn,
  input: ChatSendMessageRequest,
  signal?: AbortSignal,
  onProgress?: (summary: NonNullable<ChatTurnTraceRecord["orchestration"]>) => Promise<void> | void,
  resolvedOrchestration?: PreparedChatExecutionPlanResolution,
): Promise<
  OrchestrationExecutionResult & {
    summary: NonNullable<ChatTurnTraceRecord["orchestration"]>;
    executionPlanId: string;
  }
> {
  const orchestration = resolvedOrchestration ?? (await host.resolvePreparedTurnOrchestration(prepared));
  if (!orchestration) {
    throw new Error("Prepared chat turn is not eligible for orchestration");
  }
  const runId = randomUUID();
  const runMode = orchestration.orchestrationPlan.routeDecision.parallelism === "parallel" ? "parallel" : "sequential";
  const persistedExecutionPlan = host.storage.chatExecutionPlans.create({
    sessionId: prepared.session.sessionId,
    turnId: prepared.turnId,
    mode: orchestration.routerInput.task.mode,
    planningMode: prepared.prefs.planningMode,
    source: orchestration.executionPlanDraft.source,
    advisoryOnly: orchestration.executionPlanDraft.advisoryOnly,
    objective: orchestration.executionPlanDraft.objective,
    summary: orchestration.executionPlanDraft.summary,
    status: "running",
    startedAt: new Date().toISOString(),
    steps: orchestration.executionPlanDraft.steps,
  });
  host.recordDevDiagnostic({
    level: "info",
    category: "orchestration",
    event: "orchestration.run.start",
    message: "Starting chat orchestration run",
    sessionId: prepared.session.sessionId,
    turnId: prepared.turnId,
    runId,
    taskId: `chat-orchestration:${prepared.turnId}`,
    providerId: orchestration.orchestrationPlan.steps.at(0)?.providerId,
    modelId: orchestration.orchestrationPlan.steps.at(0)?.model,
    runtimeKind: "run.lifecycle",
    runtimeStatus: "started",
    context: {
      workflowTemplate: orchestration.orchestrationPlan.workflowTemplate,
      visibility: orchestration.orchestrationPlan.routeDecision.visibility,
      roles: orchestration.orchestrationPlan.routeDecision.selectedRoles,
      parallelism: runMode,
    },
  });
  const runTrace = {
    primaryProviderId: input.providerId ?? prepared.prefs.providerId,
    primaryModel: input.model ?? prepared.prefs.model,
    effectiveProviderId:
      orchestration.orchestrationPlan.steps.at(-1)?.providerId ?? input.providerId ?? prepared.prefs.providerId,
    effectiveModel: orchestration.orchestrationPlan.steps.at(-1)?.model ?? input.model ?? prepared.prefs.model,
  } satisfies ChatTurnTraceRecord["routing"];
  host.storage.chatDelegationRuns.create({
    runId,
    sessionId: prepared.session.sessionId,
    taskId: `chat-orchestration:${prepared.turnId}`,
    objective: prepared.content,
    roles: orchestration.orchestrationPlan.routeDecision.selectedRoles,
    mode: runMode,
    providerId: input.providerId ?? prepared.prefs.providerId,
    model: input.model ?? prepared.prefs.model,
    status: "running",
    visibility: orchestration.orchestrationPlan.routeDecision.visibility,
    workflowTemplate: orchestration.orchestrationPlan.workflowTemplate,
    executionPlanId: persistedExecutionPlan.planId,
    routeDecision: orchestration.orchestrationPlan.routeDecision,
    citations: [],
    trace: runTrace,
  });

  const persistedStepIds = new Map<string, string>();
  for (const [index, step] of orchestration.orchestrationPlan.steps.entries()) {
    const persistedStepId = `${runId}:${step.stepId}`;
    persistedStepIds.set(step.stepId, persistedStepId);
    host.storage.chatDelegationSteps.create({
      stepId: persistedStepId,
      runId,
      role: step.role,
      label: step.label,
      index,
      status: "pending",
      providerId: step.providerId,
      model: step.model,
    });
  }

  let currentSteps: OrchestrationStepExecutionResult[] = [];
  const initialSummary = host.buildChatOrchestrationSummary({
    runId,
    objective: prepared.content,
    modePolicy: orchestration.routerInput.task.mode,
    routeDecision: orchestration.orchestrationPlan.routeDecision,
    stepResults: currentSteps,
    finalized: false,
  });
  await onProgress?.(initialSummary);

  if (orchestration.executionPlanDraft.advisoryOnly) {
    const advisoryOutput = renderExecutionPlanAsMarkdown({
      mode: orchestration.routerInput.task.mode,
      objective: orchestration.executionPlanDraft.objective,
      summary: orchestration.executionPlanDraft.summary,
      steps: persistedExecutionPlan.steps,
    });
    const advisorySummary = host.buildChatOrchestrationSummary({
      runId,
      objective: prepared.content,
      modePolicy: orchestration.routerInput.task.mode,
      routeDecision: orchestration.orchestrationPlan.routeDecision,
      stepResults: [],
      finalSummary: orchestration.executionPlanDraft.summary,
      finalized: true,
      advisoryOnly: true,
    });
    host.storage.chatDelegationRuns.patch(runId, {
      status: "completed",
      visibility: advisorySummary.visibility,
      workflowTemplate: advisorySummary.workflowTemplate,
      routeDecision: advisorySummary.routeDecision,
      finalSummary: orchestration.executionPlanDraft.summary,
      stitchedOutput: advisoryOutput,
      citations: [],
      trace: runTrace,
      finishedAt: new Date().toISOString(),
    });
    host.storage.chatExecutionPlans.patch(persistedExecutionPlan.planId, {
      status: "ready",
      summary: orchestration.executionPlanDraft.summary,
      finishedAt: new Date().toISOString(),
    });
    await onProgress?.(advisorySummary);
    return {
      finalOutput: advisoryOutput,
      finalSummary: orchestration.executionPlanDraft.summary,
      citations: [],
      routeDecision: orchestration.orchestrationPlan.routeDecision,
      stepResults: [],
      summary: advisorySummary,
      executionPlanId: persistedExecutionPlan.planId,
    };
  }

  const result = await executeOrchestrationPlan({
    task: orchestration.routerInput.task,
    plan: orchestration.orchestrationPlan,
    callbacks: {
      createChatCompletion: async (request) => {
        const orchestrationDrainedSteers = host.steerService.drainPending({
          sessionId: prepared.session.sessionId,
          turnId: prepared.turnId,
        });
        for (const steerItem of orchestrationDrainedSteers) {
          await host.ingestEvent(randomUUID(), {
            eventId: randomUUID(),
            route: prepared.route,
            actor: { type: "user", id: "operator" },
            message: {
              role: "user",
              content: steerItem.instruction,
              steered: true,
            },
          });
        }
        const composed =
          orchestrationDrainedSteers.length > 0
            ? {
                ...request,
                messages: [
                  ...request.messages,
                  ...orchestrationDrainedSteers.map((item) => ({
                    role: "user" as const,
                    content: `[Steer] ${item.instruction}`,
                  })),
                ],
              }
            : request;
        return host.createChatCompletion({
          ...composed,
          signal,
        });
      },
      executeDelegatedStep: async ({ task, plan, priorSteps, step, stepIndex }) =>
        executeDelegatedPlanStep(host, prepared, {
          task,
          plan,
          priorSteps,
          step,
          stepIndex,
          runId,
          signal,
        }),
      onStepResult: async (step, allSteps) => {
        currentSteps = [...allSteps];
        const childToolRuns = step.childTurnId
          ? (host.storage.chatToolRuns.listByTurnIds([step.childTurnId]).get(step.childTurnId) ?? [])
          : [];
        const activeToolWork = childToolRuns.some(
          (toolRun) => toolRun.status === "started" || toolRun.status === "approval_required",
        );
        host.recordDevDiagnostic({
          level: step.status === "failed" ? "warn" : "info",
          category: "orchestration",
          event: "orchestration.step.complete",
          message: `Completed orchestration step ${step.role}`,
          sessionId: prepared.session.sessionId,
          turnId: prepared.turnId,
          runId,
          taskId: `chat-orchestration:${prepared.turnId}`,
          stepId: step.stepId,
          providerId: step.providerId,
          modelId: step.model,
          durationMs: step.durationMs,
          runtimeKind: "delegation.lifecycle",
          runtimeStatus:
            step.status === "failed" && activeToolWork ? "degraded" : step.status === "failed" ? "failed" : "completed",
          runtimeError: step.error
            ? {
                message: step.error,
                retryable: /\btimeout|timed out|deadline|aborted\b/i.test(step.error),
              }
            : undefined,
          context: {
            stepId: step.stepId,
            role: step.role,
            status: step.status,
            index: step.index,
            activeToolWork,
            activeToolRunCount: childToolRuns.filter(
              (toolRun) => toolRun.status === "started" || toolRun.status === "approval_required",
            ).length,
          },
        });
        host.storage.chatDelegationSteps.patch(persistedStepIds.get(step.stepId) ?? step.stepId, {
          status: step.status,
          providerId: step.providerId,
          model: step.model,
          label: step.label,
          summary: step.summary,
          output: step.output,
          error: step.error,
          failureGuidance:
            step.failureGuidance ?? (step.error ? buildDelegationFailureGuidance(step.error, step.role) : undefined),
          childSessionId: step.childSessionId,
          childTurnId: step.childTurnId,
          citations: step.citations,
          finishedAt: step.finishedAt,
          durationMs: step.durationMs,
        });
        host.storage.chatExecutionPlans.patch(persistedExecutionPlan.planId, {
          steps: mergeExecutionPlanStepStatuses(
            host.storage.chatExecutionPlans.get(persistedExecutionPlan.planId).steps,
            allSteps,
          ),
        });
        const summary = host.buildChatOrchestrationSummary({
          runId,
          objective: prepared.content,
          modePolicy: orchestration.routerInput.task.mode,
          routeDecision: orchestration.orchestrationPlan.routeDecision,
          stepResults: currentSteps,
          finalized: false,
        });
        await onProgress?.(summary);
      },
    },
  });

  const summary = host.buildChatOrchestrationSummary({
    runId,
    objective: prepared.content,
    modePolicy: orchestration.routerInput.task.mode,
    routeDecision: orchestration.orchestrationPlan.routeDecision,
    stepResults: result.stepResults,
    finalSummary: result.finalSummary,
    integritySignals: result.integritySignals,
    finalized: true,
  });
  host.storage.chatDelegationRuns.patch(runId, {
    status: summary.status,
    visibility: summary.visibility,
    workflowTemplate: summary.workflowTemplate,
    routeDecision: summary.routeDecision,
    finalSummary: result.finalSummary,
    stitchedOutput: result.finalOutput,
    citations: result.citations,
    trace: {
      ...runTrace,
      effectiveProviderId:
        result.finalStep?.providerId ?? result.stepResults.at(-1)?.providerId ?? runTrace.effectiveProviderId,
      effectiveModel: result.finalStep?.model ?? result.stepResults.at(-1)?.model ?? runTrace.effectiveModel,
    },
    finishedAt: new Date().toISOString(),
  });
  host.storage.chatExecutionPlans.patch(persistedExecutionPlan.planId, {
    status: summary.status === "failed" ? "failed" : summary.status === "partial" ? "partial" : "completed",
    summary: result.finalSummary,
    finishedAt: new Date().toISOString(),
    steps: mergeExecutionPlanStepStatuses(
      host.storage.chatExecutionPlans.get(persistedExecutionPlan.planId).steps,
      result.stepResults,
    ),
  });
  await onProgress?.(summary);
  host.recordDevDiagnostic({
    level: summary.status === "failed" ? "warn" : "info",
    category: "orchestration",
    event: "orchestration.run.complete",
    message: "Completed chat orchestration run",
    sessionId: prepared.session.sessionId,
    turnId: prepared.turnId,
    runId,
    taskId: `chat-orchestration:${prepared.turnId}`,
    providerId: result.finalStep?.providerId ?? result.stepResults.at(-1)?.providerId,
    modelId: result.finalStep?.model ?? result.stepResults.at(-1)?.model,
    runtimeKind: "run.lifecycle",
    runtimeStatus: summary.status === "failed" ? "failed" : "completed",
    context: {
      status: summary.status,
      workflowTemplate: summary.workflowTemplate,
    },
  });
  return {
    ...result,
    summary,
    executionPlanId: persistedExecutionPlan.planId,
  };
}

export async function executeDelegatedPlanStep(
  host: ChatTurnStreamHost,
  prepared: PreparedAgentChatTurn,
  input: {
    task: OrchestrationRouterInput["task"];
    plan: ModeOrchestrationPlan;
    priorSteps: OrchestrationStepExecutionResult[];
    step: ModeOrchestrationPlan["steps"][number];
    stepIndex: number;
    runId: string;
    signal?: AbortSignal;
  },
): Promise<OrchestrationStepExecutionResult> {
  const startedAt = new Date().toISOString();
  const delegatedRole = input.step.delegatedRole ?? input.step.role;
  const parentProjectId = host.storage.chatSessionProjects.get(prepared.session.sessionId)?.projectId;
  const childSession = host.createChatSession({
    workspaceId: prepared.workspaceId,
    title: `Delegate · ${toTitleCase(delegatedRole)}`,
    projectId: parentProjectId,
    mode: input.task.mode,
  });
  host.inheritDelegatedSessionToolGrants(prepared.session.sessionId, childSession.sessionId);

  host.updateChatSessionPrefs(childSession.sessionId, {
    mode: input.task.mode,
    planningMode: "off",
    providerId: input.step.providerId ?? prepared.prefs.providerId,
    model: input.step.model ?? prepared.prefs.model,
    webMode: prepared.prefs.webMode,
    memoryMode: prepared.prefs.memoryMode,
    thinkingLevel: prepared.prefs.thinkingLevel,
    speedMode: prepared.prefs.speedMode,
    subagentPolicy: "off",
    toolAutonomy: prepared.effectiveToolAutonomy,
    orchestrationEnabled: false,
    orchestrationIntensity: "minimal",
    orchestrationVisibility: "explicit",
    orchestrationProviderPreference: prepared.prefs.orchestrationProviderPreference,
    orchestrationReviewDepth: prepared.prefs.orchestrationReviewDepth,
    orchestrationParallelism: "sequential",
    codeAutoApply: prepared.prefs.codeAutoApply,
    proactiveMode: "off",
    retrievalMode: prepared.autonomy.retrievalMode,
    reflectionMode: "off",
  });

  const conversationContext = input.task.conversation
    .slice(-6)
    .map((message) => `${message.role.toUpperCase()}: ${truncateSummaryLine(message.content, 320)}`)
    .join("\n");
  const priorStepContext = buildDelegatedPriorStepContext(input.priorSteps, input.step.role);
  const suggestedTools = filterDelegatedSuggestedToolsForPromptLab(input.step.suggestedTools ?? [], {
    mode: input.task.mode,
    normalizationProfile: prepared.normalized.normalizationProfile,
  });
  const content = [
    `Delegated role: ${delegatedRole}`,
    `Parent objective: ${input.task.objective}`,
    `Plan summary: ${input.plan.summary}`,
    `Current step objective: ${input.step.objective}`,
    input.step.successCriteria ? `Success criteria: ${input.step.successCriteria}` : undefined,
    input.step.expectedOutput ? `Expected output: ${input.step.expectedOutput}` : undefined,
    suggestedTools.length ? `Suggested tools: ${suggestedTools.join(", ")}` : undefined,
    input.step.dependsOnStepIds?.length ? `Depends on: ${input.step.dependsOnStepIds.join(", ")}` : undefined,
    conversationContext ? `Conversation context:\n${conversationContext}` : undefined,
    priorStepContext ? `Prior handoffs:\n${priorStepContext}` : undefined,
    "Produce only the delegated output for this step. Be concrete, cite evidence when available, and name any blocking issue explicitly.",
  ]
    .filter(Boolean)
    .join("\n\n");

  host.recordDevDiagnostic({
    level: "info",
    category: "orchestration",
    event: "orchestration.step.start",
    message: `Starting delegated orchestration step ${delegatedRole}`,
    sessionId: prepared.session.sessionId,
    turnId: prepared.turnId,
    runId: input.runId,
    taskId: `chat-orchestration:${prepared.turnId}`,
    stepId: input.step.stepId,
    providerId: input.step.providerId ?? prepared.prefs.providerId,
    modelId: input.step.model ?? prepared.prefs.model,
    runtimeKind: "delegation.lifecycle",
    runtimeStatus: "started",
    context: {
      role: input.step.role,
      delegatedRole,
      childSessionId: childSession.sessionId,
      suggestedTools,
    },
  });

  let delegatedDispatchStarted = false;
  let delegatedResponseReceived = false;
  try {
    if (input.signal?.aborted) {
      throw new ChatTurnCancelledError(prepared.turnId);
    }
    delegatedDispatchStarted = true;
    const response = await host.agentSendChatMessage(
      childSession.sessionId,
      buildDelegatedChatSendRequest({
        content,
        providerId: input.step.providerId ?? prepared.prefs.providerId,
        model: input.step.model ?? prepared.prefs.model,
        mode: input.task.mode,
        webMode: prepared.prefs.webMode,
        memoryMode: prepared.prefs.memoryMode,
        thinkingLevel: prepared.prefs.thinkingLevel,
        speedMode: prepared.prefs.speedMode,
        subagentPolicy: "off",
        retrievalMode: prepared.autonomy.retrievalMode,
        toolAutonomy: prepared.effectiveToolAutonomy,
        normalizationProfile: prepared.normalized.normalizationProfile,
      }),
    );
    delegatedResponseReceived = true;
    if (input.signal?.aborted) {
      throw new ChatTurnCancelledError(prepared.turnId);
    }

    const output =
      response.assistantMessage?.content?.trim() ||
      response.trace?.failure?.message?.trim() ||
      "(delegate returned no output)";
    const finishedAt = new Date().toISOString();
    const failed = response.trace?.status === "failed" || response.trace?.status === "cancelled";
    const failureGuidance =
      failed && response.trace?.failure?.message
        ? buildDelegationFailureGuidance(response.trace.failure.message, delegatedRole)
        : undefined;

    return {
      stepId: input.step.stepId,
      role: input.step.role,
      label: input.step.label,
      index: input.stepIndex,
      specialistCandidateId: input.step.specialistCandidate?.candidateId,
      specialistTitle: input.step.specialistCandidate?.title,
      specialistRole: input.step.specialistCandidate?.role,
      providerId: response.trace?.routing?.effectiveProviderId ?? input.step.providerId ?? prepared.prefs.providerId,
      model: response.trace?.model ?? input.step.model ?? prepared.prefs.model,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      status: failed ? "failed" : "completed",
      output,
      summary: truncateSummaryLine(output, 180),
      error: failed ? (response.trace?.failure?.message ?? output) : undefined,
      failureGuidance,
      citations: response.citations ?? [],
      routing: response.routing,
      childRunId: undefined,
      durableRunId: response.trace?.durable?.runId,
      childSessionId: childSession.sessionId,
      childTurnId: response.turnId,
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const timeoutWithoutProviderResult = /\btimeout|timed out|deadline\b/i.test(message);
    host.recordDevDiagnostic({
      level: "warn",
      category: "orchestration",
      event: timeoutWithoutProviderResult
        ? "orchestration.step.timeout_without_provider_result"
        : "orchestration.step.failed_before_result",
      message: timeoutWithoutProviderResult
        ? "Delegated orchestration step timed out before any provider result was returned"
        : `Delegated orchestration step ${delegatedRole} failed before returning a result`,
      sessionId: prepared.session.sessionId,
      turnId: prepared.turnId,
      runId: input.runId,
      taskId: `chat-orchestration:${prepared.turnId}`,
      stepId: input.step.stepId,
      providerId: input.step.providerId ?? prepared.prefs.providerId,
      modelId: input.step.model ?? prepared.prefs.model,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      runtimeKind: "delegation.lifecycle",
      runtimeStatus: "failed",
      runtimeError: {
        name: error instanceof Error ? error.name : undefined,
        message,
        retryable: timeoutWithoutProviderResult,
      },
      context: {
        childSessionId: childSession.sessionId,
        delegatedDispatchStarted,
        delegatedResponseReceived,
        timeoutClassification: timeoutWithoutProviderResult ? "timeout_without_provider_result" : undefined,
      },
    });
    return {
      stepId: input.step.stepId,
      role: input.step.role,
      label: input.step.label,
      index: input.stepIndex,
      specialistCandidateId: input.step.specialistCandidate?.candidateId,
      specialistTitle: input.step.specialistCandidate?.title,
      specialistRole: input.step.specialistCandidate?.role,
      providerId: input.step.providerId ?? prepared.prefs.providerId,
      model: input.step.model ?? prepared.prefs.model,
      startedAt,
      finishedAt,
      durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
      status: "failed",
      summary: `${toTitleCase(delegatedRole)} failed`,
      error: message,
      failureGuidance: buildDelegationFailureGuidance(message, delegatedRole),
      citations: [],
      childRunId: undefined,
      durableRunId: undefined,
      childSessionId: childSession.sessionId,
    };
  }
}

function createAsyncProgressQueue<T>(maxBufferedValues = 256) {
  const values: T[] = [];
  const waiters: Array<(value: T | undefined) => void> = [];
  let closed = false;

  return {
    close() {
      closed = true;
      while (waiters.length > 0) {
        waiters.shift()?.(undefined);
      }
    },
    push(value: T) {
      if (closed) {
        return;
      }
      const waiter = waiters.shift();
      if (waiter) {
        waiter(value);
        return;
      }
      if (values.length >= maxBufferedValues) {
        values.shift();
      }
      values.push(value);
    },
    next(): Promise<T | undefined> {
      if (values.length > 0) {
        return Promise.resolve(values.shift());
      }
      if (closed) {
        return Promise.resolve(undefined);
      }
      return new Promise((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

function buildDelegatedPriorStepContext(
  priorSteps: OrchestrationStepExecutionResult[],
  role: OrchestrationStepExecutionResult["role"],
): string {
  if (role !== "synthesizer" && role !== "reviewer" && role !== "critic" && role !== "qa-validator") {
    return priorSteps
      .slice(-4)
      .map((step) =>
        [
          `${formatDelegatedStepTitle(step)} (${step.status})`,
          truncateSummaryLine(step.summary ?? step.output ?? step.error ?? "No handoff provided.", 320),
        ].join(": "),
      )
      .join("\n");
  }

  let remaining = 16_000;
  const sections: string[] = [];
  for (const step of priorSteps) {
    if (remaining <= 0) {
      break;
    }
    const raw = step.output?.trim() || step.error?.trim() || step.summary?.trim() || "No handoff provided.";
    const excerpt = raw.slice(0, Math.min(3_000, remaining));
    remaining -= excerpt.length;
    sections.push(
      [
        `### ${formatDelegatedStepTitle(step)} (${step.status})`,
        excerpt,
        raw.length > excerpt.length ? "[truncated]" : undefined,
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return sections.join("\n\n");
}

function formatDelegatedStepTitle(step: Pick<OrchestrationStepExecutionResult, "label" | "role">): string {
  return step.label?.trim() || toTitleCase(step.role);
}

function filterDelegatedSuggestedToolsForPromptLab(
  suggestedTools: string[],
  input: {
    mode: ChatMode;
    normalizationProfile?: ChatSendMessageRequest["normalizationProfile"];
  },
): string[] {
  if (input.normalizationProfile !== "prompt_pack_harness" || input.mode === "code") {
    return suggestedTools;
  }
  return suggestedTools.filter((toolName) => !PROMPT_LAB_LOCAL_FILE_TOOL_NAMES.has(toolName));
}

export async function* streamPreparedAgentChatTurn(
  host: ChatTurnStreamHost,
  sessionId: string,
  input: ChatSendMessageRequest,
  prepared: PreparedAgentChatTurn,
  threadEventType: "chat_thread_turn_appended" | "chat_thread_turn_retried" | "chat_thread_turn_edited",
  resolvedOrchestration?: PreparedChatExecutionPlanResolution,
  options?: {
    skipMessageStart?: boolean;
  },
): AsyncGenerator<ChatStreamChunkDraft> {
  const turnId = prepared.turnId;
  const assistantMessageId = prepared.assistantMessageId;
  const controller = host.beginActiveChatTurnExecution(sessionId, turnId, threadEventType);
  host.steerService.registerActiveTurn({ sessionId, turnId });

  try {
    if (!options?.skipMessageStart) {
      yield {
        type: "message_start",
        sessionId,
        turnId,
        messageId: assistantMessageId,
        parentTurnId: prepared.parentTurnId,
        branchKind: prepared.branchKind,
        sourceTurnId: prepared.sourceTurnId,
      };
    }

    const modeOrchestration = resolvedOrchestration ?? (await host.resolvePreparedTurnOrchestration(prepared));
    if (modeOrchestration) {
      const mode = prepared.normalized.mode ?? prepared.prefs.mode;
      const initialTrace = host.storage.chatTurnTraces.create({
        turnId,
        sessionId,
        userMessageId: prepared.userEventId,
        parentTurnId: prepared.parentTurnId,
        branchKind: prepared.branchKind,
        sourceTurnId: prepared.sourceTurnId,
        status: "running",
        mode,
        model: modeOrchestration.orchestrationPlan.steps.at(0)?.model ?? input.model ?? prepared.prefs.model,
        webMode: prepared.normalized.webMode ?? prepared.prefs.webMode,
        memoryMode: prepared.normalized.memoryMode ?? prepared.prefs.memoryMode,
        thinkingLevel: prepared.normalized.thinkingLevel ?? prepared.prefs.thinkingLevel,
        speedMode: prepared.normalized.speedMode ?? prepared.prefs.speedMode,
        subagentPolicy: prepared.normalized.subagentPolicy ?? prepared.prefs.subagentPolicy,
        effectiveToolAutonomy: prepared.effectiveToolAutonomy,
        routing: {
          primaryProviderId: input.providerId ?? prepared.prefs.providerId,
          primaryModel: input.model ?? prepared.prefs.model,
          effectiveProviderId:
            modeOrchestration.orchestrationPlan.steps.at(0)?.providerId ??
            input.providerId ??
            prepared.prefs.providerId,
          effectiveModel: modeOrchestration.orchestrationPlan.steps.at(0)?.model ?? input.model ?? prepared.prefs.model,
        },
      });
      yield {
        type: "trace_update",
        sessionId,
        turnId,
        trace: initialTrace,
      };

      // eslint-disable-next-line prefer-const
      let executionPlanId: string | undefined;
      const progressQueue = createAsyncProgressQueue<ChatTurnTraceRecord>();
      const orchestrationResultPromise = executePreparedModeOrchestration(
        host,
        prepared,
        input,
        controller.signal,
        async (summary) => {
          const progressTrace = host.storage.chatTurnTraces.patch(turnId, {
            executionPlanId,
            orchestration: summary,
            model:
              summary.steps.at(-1)?.model ??
              modeOrchestration.orchestrationPlan.steps.at(0)?.model ??
              input.model ??
              prepared.prefs.model,
            routing: {
              primaryProviderId: input.providerId ?? prepared.prefs.providerId,
              primaryModel: input.model ?? prepared.prefs.model,
              effectiveProviderId:
                summary.steps.at(-1)?.providerId ??
                modeOrchestration.orchestrationPlan.steps.at(0)?.providerId ??
                input.providerId ??
                prepared.prefs.providerId,
              effectiveModel:
                summary.steps.at(-1)?.model ??
                modeOrchestration.orchestrationPlan.steps.at(0)?.model ??
                input.model ??
                prepared.prefs.model,
            },
          });
          progressQueue.push(progressTrace);
        },
        modeOrchestration,
      ).finally(() => {
        progressQueue.close();
      });
      while (true) {
        const progressTrace = await progressQueue.next();
        if (!progressTrace) {
          break;
        }
        yield {
          type: "trace_update",
          sessionId,
          turnId,
          trace: progressTrace,
        };
      }
      const orchestrationResult = await orchestrationResultPromise;
      executionPlanId = orchestrationResult.executionPlanId;

      let finalText = orchestrationResult.finalOutput.trim();
      if (!finalText) {
        finalText = buildEmptyAssistantTurnFallbackText();
      }

      await observeBeforeAssistantMessageWrite(host, {
        workspaceId: prepared.workspaceId,
        sessionId,
        turnId,
        messageId: assistantMessageId,
        content: finalText,
        stream: true,
        runId: orchestrationResult.summary.runId,
        taskId: `chat-orchestration:${turnId}`,
        providerId:
          orchestrationResult.finalStep?.providerId ??
          orchestrationResult.summary.steps.at(-1)?.providerId ??
          input.providerId ??
          prepared.prefs.providerId,
        model:
          orchestrationResult.finalStep?.model ??
          orchestrationResult.summary.steps.at(-1)?.model ??
          input.model ??
          prepared.prefs.model,
      });
      await host.ingestEvent(randomUUID(), {
        eventId: assistantMessageId,
        route: prepared.route,
        actor: {
          type: "agent",
          id: "assistant",
        },
        message: {
          role: "assistant",
          content: finalText,
        },
      });

      const orchestrationCitations = dedupeChatCitations([
        ...(prepared.threadKnowledgeCitations ?? []),
        ...orchestrationResult.citations,
      ]);
      for (const citation of orchestrationCitations) {
        yield {
          type: "citation",
          sessionId,
          turnId,
          citation,
        };
      }
      const orchestrationToolRuns = collectOrchestrationToolRuns(host, orchestrationResult.summary.runId);

      let hydratedTrace: ChatTurnTraceRecord = {
        ...host.storage.chatTurnTraces.patch(turnId, {
          assistantMessageId,
          executionPlanId: orchestrationResult.executionPlanId,
          status:
            orchestrationResult.summary.status === "failed"
              ? "failed"
              : orchestrationResult.summary.status === "partial"
                ? "partial"
                : "completed",
          finishedAt: new Date().toISOString(),
          model:
            orchestrationResult.finalStep?.model ??
            orchestrationResult.summary.steps.at(-1)?.model ??
            modeOrchestration.orchestrationPlan.steps.at(0)?.model ??
            input.model ??
            prepared.prefs.model,
          routing: {
            primaryProviderId: input.providerId ?? prepared.prefs.providerId,
            primaryModel: input.model ?? prepared.prefs.model,
            effectiveProviderId:
              orchestrationResult.finalStep?.providerId ??
              orchestrationResult.summary.steps.at(-1)?.providerId ??
              modeOrchestration.orchestrationPlan.steps.at(0)?.providerId ??
              input.providerId ??
              prepared.prefs.providerId,
            effectiveModel:
              orchestrationResult.finalStep?.model ??
              orchestrationResult.summary.steps.at(-1)?.model ??
              modeOrchestration.orchestrationPlan.steps.at(0)?.model ??
              input.model ??
              prepared.prefs.model,
          },
          retrieval: prepared.retrievalTrace,
          reflection: {
            attempted: false,
            attemptCount: 0,
            outcome: "not_needed",
          },
          proactive: {
            runId: prepared.autonomy.lastProactiveRunId,
            mode: prepared.autonomy.proactiveMode,
          },
          orchestration: orchestrationResult.summary,
          guidance: {
            workspaceId: prepared.workspaceId,
            globalFilesUsed: prepared.resolvedGuidance.globalFilesUsed,
            workspaceFilesUsed: prepared.resolvedGuidance.workspaceFilesUsed,
            truncated: prepared.resolvedGuidance.truncated,
          },
          citations: orchestrationCitations,
        }),
        toolRuns: orchestrationToolRuns,
      };
      host.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, turnId);
      for (const slice of splitIntoChunks(finalText, 120)) {
        yield {
          type: "delta",
          sessionId,
          turnId,
          messageId: assistantMessageId,
          delta: slice,
        };
      }
      yield {
        type: "message_done",
        sessionId,
        turnId,
        messageId: assistantMessageId,
        content: finalText,
        repaired: Boolean(hydratedTrace.completion?.repaired),
        repair: hydratedTrace.completion?.repair,
      };
      const capabilityUpgradeSuggestions = await host.collectCapabilityUpgradeSuggestions({
        sessionId,
        content: prepared.content,
        assistantText: finalText,
        trace: hydratedTrace,
      });
      const specialistCandidateSuggestions = host.collectSpecialistCandidateSuggestions({
        sessionId,
        mode: prepared.normalized.mode ?? prepared.prefs.mode,
        content: prepared.content,
        capabilitySuggestions: capabilityUpgradeSuggestions,
        trace: hydratedTrace,
      });
      if (capabilityUpgradeSuggestions.length > 0 || specialistCandidateSuggestions.length > 0) {
        hydratedTrace = {
          ...host.storage.chatTurnTraces.patch(turnId, {
            capabilityUpgradeSuggestions: capabilityUpgradeSuggestions.length > 0 ? capabilityUpgradeSuggestions : [],
            specialistCandidateSuggestions:
              specialistCandidateSuggestions.length > 0 ? specialistCandidateSuggestions : [],
          }),
          toolRuns: orchestrationToolRuns,
        };
        if (capabilityUpgradeSuggestions.length > 0) {
          yield {
            type: "capability_upgrade_suggestion",
            sessionId,
            turnId,
            capabilityUpgradeSuggestions,
          };
        }
      }
      yield {
        type: "trace_update",
        sessionId,
        turnId,
        trace: hydratedTrace,
      };
      host.publishRealtime(
        "chat_thread_updated",
        "chat",
        {
          type: threadEventType,
          sessionId,
          turnId,
          activeLeafTurnId: turnId,
        },
        buildChatTurnRealtimeOptions({ sessionId, turnId }),
      );
      host.extractAndPersistLearnedMemory(sessionId, prepared.content, {
        role: "user",
        sourceRef: prepared.userEventId,
        trace: hydratedTrace,
      });
      host.extractAndPersistLearnedMemory(sessionId, finalText, {
        role: "assistant",
        sourceRef: assistantMessageId,
        trace: hydratedTrace,
      });
      host.scheduleChatMemoryContextPrewarm({
        sessionId,
        prompt: finalText,
        relationScope: "self",
      });
      host.scheduleMemoryMaintenancePostTurnEvaluation(sessionId, prepared.parentTurnId);
      enqueueAgentEndHook(host, {
        workspaceId: prepared.workspaceId,
        sessionId,
        turnId,
        status: hydratedTrace.status,
        toolRunCount: orchestrationToolRuns.length,
        stream: true,
        repaired: Boolean(hydratedTrace.completion?.repaired),
        runId: orchestrationResult.summary.runId,
        taskId: `chat-orchestration:${turnId}`,
        providerId: hydratedTrace.routing?.effectiveProviderId ?? hydratedTrace.routing?.primaryProviderId,
        model: hydratedTrace.routing?.effectiveModel ?? hydratedTrace.model,
      });
      if ((hydratedTrace.completion?.status ?? "complete") === "complete" && hydratedTrace.status === "completed") {
        yield {
          type: "done",
          sessionId,
          turnId,
          messageId: assistantMessageId,
        };
      }
      return;
    }

    let finalText = "";
    let assistantUsage:
      | {
          inputTokens?: number;
          outputTokens?: number;
          cachedInputTokens?: number;
          costUsd?: number;
        }
      | undefined;
    let hasStreamedDelta = false;
    let streamLayerRepaired = false;
    let streamLayerRepair:
      | {
          applied: true;
          kind: "deterministic_empty_output_synthesis";
          source: "stream_layer";
          preRepairContent: string;
          postRepairContent: string;
        }
      | undefined;
    let approvalRequired = false;
    let userInputRequired = false;
    let pendingUserInput = undefined as ChatTurnTraceRecord["pendingUserInput"];
    const streamCitations: ChatCitationRecord[] = [...(prepared.threadKnowledgeCitations ?? [])];
    const drainedSteers = host.steerService.drainPending({ sessionId, turnId: prepared.turnId });
    const steerHistoryMessages = drainedSteers.map((item) => ({
      role: "user" as const,
      content: `[Steer] ${item.instruction}`,
    }));
    const historyWithSteers =
      drainedSteers.length > 0 ? [...prepared.history, ...steerHistoryMessages] : prepared.history;
    for (const steerItem of drainedSteers) {
      await host.ingestEvent(randomUUID(), {
        eventId: randomUUID(),
        route: prepared.route,
        actor: { type: "user", id: "operator" },
        message: {
          role: "user",
          content: steerItem.instruction,
          steered: true,
        },
      });
    }
    for await (const chunk of host.turnRuntime.runStream({
      sessionId,
      turnId,
      userMessageId: prepared.userEventId,
      parentTurnId: prepared.parentTurnId,
      branchKind: prepared.branchKind,
      sourceTurnId: prepared.sourceTurnId,
      outputMessageId: assistantMessageId,
      content: prepared.content,
      mode: prepared.normalized.mode ?? prepared.prefs.mode,
      providerId: input.providerId ?? prepared.prefs.providerId,
      model: input.model ?? prepared.prefs.model,
      webMode: prepared.normalized.webMode ?? prepared.prefs.webMode,
      memoryMode: prepared.normalized.memoryMode ?? prepared.prefs.memoryMode,
      thinkingLevel: prepared.normalized.thinkingLevel ?? prepared.prefs.thinkingLevel,
      speedMode: prepared.normalized.speedMode ?? prepared.prefs.speedMode,
      subagentPolicy: prepared.normalized.subagentPolicy ?? prepared.prefs.subagentPolicy,
      normalizationProfile: prepared.normalized.normalizationProfile,
      toolAutonomy: prepared.effectiveToolAutonomy,
      historyMessages: historyWithSteers,
      signal: controller.signal,
    })) {
      if (chunk.type === "message_done" && chunk.content) {
        finalText = chunk.content;
      }
      if (chunk.type === "approval_required") {
        if (userInputRequired) {
          throw new Error(`Chat turn ${turnId} emitted both user input and approval interrupts.`);
        }
        approvalRequired = true;
        yield chunk;
      }
      if (chunk.type === "user_input_required") {
        if (approvalRequired) {
          throw new Error(`Chat turn ${turnId} emitted both approval and user-input interrupts.`);
        }
        userInputRequired = true;
        pendingUserInput = chunk.prompt;
        yield chunk;
      }
      if (chunk.type === "usage") {
        assistantUsage = chunk.usage;
        yield chunk;
      }
      if (chunk.type === "message_done") {
        if (chunk.content.trim() && !hasStreamedDelta) {
          finalText = chunk.content;
          for (const slice of splitIntoChunks(chunk.content, 120)) {
            yield {
              type: "delta",
              sessionId,
              turnId,
              messageId: assistantMessageId,
              delta: slice,
            };
          }
        }
      }
      if (chunk.type === "citation") {
        const nextCitations = dedupeChatCitations([...streamCitations, chunk.citation]);
        streamCitations.length = 0;
        streamCitations.push(...nextCitations);
        yield chunk;
      }
      if (
        chunk.type === "tool_start" ||
        chunk.type === "tool_result" ||
        chunk.type === "trace_update" ||
        chunk.type === "error"
      ) {
        yield chunk;
      }
      if (chunk.type === "delta") {
        hasStreamedDelta = true;
        yield {
          ...chunk,
          messageId: chunk.messageId ?? assistantMessageId,
        };
      }
    }

    if (!approvalRequired && !userInputRequired && !finalText.trim()) {
      const preRepairContent = finalText;
      finalText = buildEmptyAssistantTurnFallbackText();
      streamLayerRepaired = true;
      streamLayerRepair = {
        applied: true,
        kind: "deterministic_empty_output_synthesis",
        source: "stream_layer",
        preRepairContent,
        postRepairContent: finalText,
      };
      if (!hasStreamedDelta) {
        for (const slice of splitIntoChunks(finalText, 120)) {
          yield {
            type: "delta",
            sessionId,
            turnId,
            messageId: assistantMessageId,
            delta: slice,
          };
        }
      }
    }

    if (approvalRequired) {
      host.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, turnId);
      host.publishRealtime(
        "chat_thread_updated",
        "chat",
        {
          type: threadEventType,
          sessionId,
          turnId,
          activeLeafTurnId: turnId,
        },
        buildChatTurnRealtimeOptions({ sessionId, turnId }),
      );
      const traceWithMeta = host.storage.chatTurnTraces.patch(turnId, {
        retrieval: prepared.retrievalTrace,
        reflection: {
          attempted: false,
          attemptCount: 0,
          outcome: "not_needed",
        },
        proactive: {
          runId: prepared.autonomy.lastProactiveRunId,
          mode: prepared.autonomy.proactiveMode,
        },
        guidance: {
          workspaceId: prepared.workspaceId,
          globalFilesUsed: prepared.resolvedGuidance.globalFilesUsed,
          workspaceFilesUsed: prepared.resolvedGuidance.workspaceFilesUsed,
          truncated: prepared.resolvedGuidance.truncated,
        },
        citations: dedupeChatCitations(streamCitations),
      });
      const approvalTraceBase: ChatTurnTraceRecord = {
        ...traceWithMeta,
        toolRuns: host.storage.chatToolRuns.listByTurn(turnId),
      };
      const capabilityUpgradeSuggestions = await host.collectCapabilityUpgradeSuggestions({
        sessionId,
        content: prepared.content,
        assistantText: finalText,
        trace: approvalTraceBase,
      });
      const approvalTrace =
        capabilityUpgradeSuggestions.length > 0
          ? {
              ...host.storage.chatTurnTraces.patch(turnId, {
                capabilityUpgradeSuggestions,
              }),
              toolRuns: host.storage.chatToolRuns.listByTurn(turnId),
            }
          : approvalTraceBase;
      if (capabilityUpgradeSuggestions.length > 0) {
        yield {
          type: "capability_upgrade_suggestion",
          sessionId,
          turnId,
          capabilityUpgradeSuggestions,
        };
      }
      host.recordCapabilityGapFromTrace({
        sessionId,
        turnId,
        content: prepared.content,
        trace: approvalTrace,
      });
      yield {
        type: "trace_update",
        sessionId,
        turnId,
        trace: approvalTrace,
      };
      enqueueAgentEndHook(host, {
        workspaceId: prepared.workspaceId,
        sessionId,
        turnId,
        status: approvalTrace.status,
        toolRunCount: approvalTrace.toolRuns.length,
        stream: true,
        repaired: Boolean(approvalTrace.completion?.repaired),
        runId: approvalTrace.durable?.runId,
        approvalId: approvalTrace.toolRuns.find((toolRun) => toolRun.approvalId)?.approvalId,
        providerId: approvalTrace.routing?.effectiveProviderId ?? approvalTrace.routing?.primaryProviderId,
        model: approvalTrace.routing?.effectiveModel ?? approvalTrace.model,
      });
      return;
    }

    if (userInputRequired && pendingUserInput) {
      host.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, turnId);
      host.publishRealtime(
        "chat_thread_updated",
        "chat",
        {
          type: threadEventType,
          sessionId,
          turnId,
          activeLeafTurnId: turnId,
        },
        buildChatTurnRealtimeOptions({ sessionId, turnId }),
      );
      const traceWithMeta = host.storage.chatTurnTraces.patch(turnId, {
        status: "waiting_for_user_input",
        pendingUserInput,
        retrieval: prepared.retrievalTrace,
        reflection: {
          attempted: false,
          attemptCount: 0,
          outcome: "not_needed",
        },
        proactive: {
          runId: prepared.autonomy.lastProactiveRunId,
          mode: prepared.autonomy.proactiveMode,
        },
        guidance: {
          workspaceId: prepared.workspaceId,
          globalFilesUsed: prepared.resolvedGuidance.globalFilesUsed,
          workspaceFilesUsed: prepared.resolvedGuidance.workspaceFilesUsed,
          truncated: prepared.resolvedGuidance.truncated,
        },
        citations: dedupeChatCitations(streamCitations),
      });
      const userInputTrace: ChatTurnTraceRecord = {
        ...traceWithMeta,
        toolRuns: host.storage.chatToolRuns.listByTurn(turnId),
      };
      yield {
        type: "trace_update",
        sessionId,
        turnId,
        trace: userInputTrace,
      };
      enqueueAgentEndHook(host, {
        workspaceId: prepared.workspaceId,
        sessionId,
        turnId,
        status: userInputTrace.status,
        toolRunCount: userInputTrace.toolRuns.length,
        stream: true,
        repaired: Boolean(userInputTrace.completion?.repaired),
        runId: userInputTrace.durable?.runId,
        providerId: userInputTrace.routing?.effectiveProviderId ?? userInputTrace.routing?.primaryProviderId,
        model: userInputTrace.routing?.effectiveModel ?? userInputTrace.model,
      });
      return;
    }

    if (finalText.trim()) {
      const currentTraceBeforeWrite = host.storage.chatTurnTraces.get(turnId);
      await observeBeforeAssistantMessageWrite(host, {
        workspaceId: prepared.workspaceId,
        sessionId,
        turnId,
        messageId: assistantMessageId,
        content: finalText,
        stream: true,
        runId: currentTraceBeforeWrite.durable?.runId,
        providerId:
          currentTraceBeforeWrite.routing?.effectiveProviderId ?? currentTraceBeforeWrite.routing?.primaryProviderId,
        model: currentTraceBeforeWrite.routing?.effectiveModel ?? currentTraceBeforeWrite.model,
      });
      await host.ingestEvent(randomUUID(), {
        eventId: assistantMessageId,
        route: prepared.route,
        actor: {
          type: "agent",
          id: "assistant",
        },
        message: {
          role: "assistant",
          content: finalText,
        },
        usage: assistantUsage,
      });
      let hydratedTrace: ChatTurnTraceRecord = {
        ...host.storage.chatTurnTraces.patch(turnId, {
          assistantMessageId,
          status: "completed",
          ...(streamLayerRepaired
            ? {
                completion: {
                  status: "complete",
                  repaired: true,
                  repair: streamLayerRepair,
                },
              }
            : {}),
          finishedAt: new Date().toISOString(),
          retrieval: prepared.retrievalTrace,
          reflection: {
            attempted: false,
            attemptCount: 0,
            outcome: "not_needed",
          },
          proactive: {
            runId: prepared.autonomy.lastProactiveRunId,
            mode: prepared.autonomy.proactiveMode,
          },
          guidance: {
            workspaceId: prepared.workspaceId,
            globalFilesUsed: prepared.resolvedGuidance.globalFilesUsed,
            workspaceFilesUsed: prepared.resolvedGuidance.workspaceFilesUsed,
            truncated: prepared.resolvedGuidance.truncated,
          },
          citations: dedupeChatCitations(streamCitations),
        }),
        toolRuns: host.storage.chatToolRuns.listByTurn(turnId),
      };
      host.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, turnId);
      yield {
        type: "message_done",
        sessionId,
        turnId,
        messageId: assistantMessageId,
        content: finalText,
        repaired: streamLayerRepaired || Boolean(hydratedTrace.completion?.repaired),
        repair: streamLayerRepair ?? hydratedTrace.completion?.repair,
      };
      const capabilityUpgradeSuggestions = await host.collectCapabilityUpgradeSuggestions({
        sessionId,
        content: prepared.content,
        assistantText: finalText,
        trace: hydratedTrace,
      });
      const specialistCandidateSuggestions = host.collectSpecialistCandidateSuggestions({
        sessionId,
        mode: prepared.normalized.mode ?? prepared.prefs.mode,
        content: prepared.content,
        capabilitySuggestions: capabilityUpgradeSuggestions,
        trace: hydratedTrace,
      });
      if (capabilityUpgradeSuggestions.length > 0 || specialistCandidateSuggestions.length > 0) {
        hydratedTrace = {
          ...host.storage.chatTurnTraces.patch(turnId, {
            capabilityUpgradeSuggestions: capabilityUpgradeSuggestions.length > 0 ? capabilityUpgradeSuggestions : [],
            specialistCandidateSuggestions:
              specialistCandidateSuggestions.length > 0 ? specialistCandidateSuggestions : [],
          }),
          toolRuns: host.storage.chatToolRuns.listByTurn(turnId),
        };
        if (capabilityUpgradeSuggestions.length > 0) {
          yield {
            type: "capability_upgrade_suggestion",
            sessionId,
            turnId,
            capabilityUpgradeSuggestions,
          };
        }
      }
      host.recordCapabilityGapFromTrace({
        sessionId,
        turnId,
        content: prepared.content,
        trace: hydratedTrace,
      });
      yield {
        type: "trace_update",
        sessionId,
        turnId,
        trace: hydratedTrace,
      };
      host.publishRealtime(
        "chat_thread_updated",
        "chat",
        {
          type: threadEventType,
          sessionId,
          turnId,
          activeLeafTurnId: turnId,
        },
        buildChatTurnRealtimeOptions({ sessionId, turnId }),
      );
      host.extractAndPersistLearnedMemory(sessionId, prepared.content, {
        role: "user",
        sourceRef: prepared.userEventId,
        trace: hydratedTrace,
      });
      host.extractAndPersistLearnedMemory(sessionId, finalText, {
        role: "assistant",
        sourceRef: assistantMessageId,
        trace: hydratedTrace,
      });
      host.scheduleChatMemoryContextPrewarm({
        sessionId,
        prompt: finalText,
        relationScope: "self",
      });
      host.scheduleMemoryMaintenancePostTurnEvaluation(sessionId, prepared.parentTurnId);
    }

    const completedTrace = host.storage.chatTurnTraces.get(turnId);
    enqueueAgentEndHook(host, {
      workspaceId: prepared.workspaceId,
      sessionId,
      turnId,
      status: completedTrace.status,
      toolRunCount: host.storage.chatToolRuns.listByTurn(turnId).length,
      stream: true,
      repaired: Boolean(completedTrace.completion?.repaired),
      runId: completedTrace.durable?.runId,
      approvalId: host.storage.chatToolRuns.listByTurn(turnId).find((toolRun) => toolRun.approvalId)?.approvalId,
      providerId: completedTrace.routing?.effectiveProviderId ?? completedTrace.routing?.primaryProviderId,
      model: completedTrace.routing?.effectiveModel ?? completedTrace.model,
    });
    if (completedTrace.completion?.status === "complete") {
      yield {
        type: "done",
        sessionId,
        turnId,
        messageId: assistantMessageId,
      };
    }
  } catch (error) {
    if (controller.signal.aborted || isChatTurnCancelledError(error)) {
      const trace = host.markChatTurnCancelled(sessionId, turnId);
      yield {
        type: "trace_update",
        sessionId,
        turnId,
        trace,
      };
      enqueueAgentEndHook(host, {
        workspaceId: prepared.workspaceId,
        sessionId,
        turnId,
        status: trace.status,
        toolRunCount: trace.toolRuns?.length ?? host.storage.chatToolRuns.listByTurn(turnId).length,
        stream: true,
        repaired: Boolean(trace.completion?.repaired),
        runId: trace.durable?.runId,
        approvalId:
          trace.toolRuns?.find((toolRun) => toolRun.approvalId)?.approvalId ??
          host.storage.chatToolRuns.listByTurn(turnId).find((toolRun) => toolRun.approvalId)?.approvalId,
        providerId: trace.routing?.effectiveProviderId ?? trace.routing?.primaryProviderId,
        model: trace.routing?.effectiveModel ?? trace.model,
      });
      return;
    }
    throw error;
  } finally {
    host.steerService.unregisterActiveTurn({ sessionId, turnId });
    host.endActiveChatTurnExecution(turnId, controller);
  }
}
