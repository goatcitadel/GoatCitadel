/**
 * Chat turn streaming execution.
 *
 * Step 8c of the gateway-service decomposition plan: extracts the streaming
 * generator (`streamPreparedAgentChatTurn`) and its execution helpers
 * (`executePreparedModeOrchestration`, `executeDelegatedPlanStep`,
 * `collectOrchestrationToolRuns`). All functions are pure over a
 * `GatewayService` host and use only its `/** @internal *\/` public surface.
 */

import { randomUUID } from "node:crypto";
import type {
  ChatCitationRecord,
  ChatSendMessageRequest,
  ChatStreamChunkDraft,
  ChatToolRunRecord,
  ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
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
  type PreparedChatExecutionPlanResolution,
} from "./gateway-service.js";
import type { GatewayService } from "./gateway-service.js";
import type { PreparedAgentChatTurn } from "./chat-turn-prep-service.js";

export type ChatTurnStreamHost = GatewayService;

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
    providerId: orchestration.orchestrationPlan.steps.at(0)?.providerId,
    modelId: orchestration.orchestrationPlan.steps.at(0)?.model,
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
      createChatCompletion: (request) =>
        host.createChatCompletion({
          ...request,
          signal,
        }),
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
        host.recordDevDiagnostic({
          level: step.status === "failed" ? "warn" : "info",
          category: "orchestration",
          event: "orchestration.step.complete",
          message: `Completed orchestration step ${step.role}`,
          sessionId: prepared.session.sessionId,
          turnId: prepared.turnId,
          providerId: step.providerId,
          modelId: step.model,
          context: {
            stepId: step.stepId,
            role: step.role,
            status: step.status,
            index: step.index,
          },
        });
        host.storage.chatDelegationSteps.patch(persistedStepIds.get(step.stepId) ?? step.stepId, {
          status: step.status,
          providerId: step.providerId,
          model: step.model,
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
    status: summary.status === "failed" ? "failed" : "completed",
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
    providerId: result.finalStep?.providerId ?? result.stepResults.at(-1)?.providerId,
    modelId: result.finalStep?.model ?? result.stepResults.at(-1)?.model,
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
  const priorStepContext = input.priorSteps
    .slice(-4)
    .map((step) =>
      [
        `${toTitleCase(step.role)} (${step.status})`,
        truncateSummaryLine(step.summary ?? step.output ?? step.error ?? "No handoff provided.", 320),
      ].join(": "),
    )
    .join("\n");
  const content = [
    `Delegated role: ${delegatedRole}`,
    `Parent objective: ${input.task.objective}`,
    `Plan summary: ${input.plan.summary}`,
    `Current step objective: ${input.step.objective}`,
    input.step.successCriteria ? `Success criteria: ${input.step.successCriteria}` : undefined,
    input.step.expectedOutput ? `Expected output: ${input.step.expectedOutput}` : undefined,
    input.step.suggestedTools?.length ? `Suggested tools: ${input.step.suggestedTools.join(", ")}` : undefined,
    input.step.dependsOnStepIds?.length ? `Depends on: ${input.step.dependsOnStepIds.join(", ")}` : undefined,
    conversationContext ? `Conversation context:\n${conversationContext}` : undefined,
    priorStepContext ? `Prior handoffs:\n${priorStepContext}` : undefined,
    "Produce only the delegated output for this step. Be concrete, cite evidence when available, and name any blocking issue explicitly.",
  ]
    .filter(Boolean)
    .join("\n\n");

  try {
    if (input.signal?.aborted) {
      throw new ChatTurnCancelledError(prepared.turnId);
    }
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
        retrievalMode: prepared.autonomy.retrievalMode,
      }),
    );
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
      childRunId: input.runId,
      childSessionId: childSession.sessionId,
      childTurnId: response.turnId,
    };
  } catch (error) {
    const finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    return {
      stepId: input.step.stepId,
      role: input.step.role,
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
      childRunId: input.runId,
      childSessionId: childSession.sessionId,
    };
  }
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
      const orchestrationResult = await executePreparedModeOrchestration(
        host,
        prepared,
        input,
        controller.signal,
        async (summary) => {
          host.storage.chatTurnTraces.patch(turnId, {
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
        },
        modeOrchestration,
      );
      executionPlanId = orchestrationResult.executionPlanId;

      let finalText = orchestrationResult.finalOutput.trim();
      if (!finalText) {
        finalText = buildEmptyAssistantTurnFallbackText();
      }

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

      for (const citation of orchestrationResult.citations) {
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
          status: orchestrationResult.summary.status === "failed" ? "failed" : "completed",
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
          citations: orchestrationResult.citations,
        }),
        toolRuns: orchestrationToolRuns,
      };
      host.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, turnId);
      yield {
        type: "message_done",
        sessionId,
        turnId,
        messageId: assistantMessageId,
        content: finalText,
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
      host.publishRealtime("chat_thread_updated", "chat", {
        type: threadEventType,
        sessionId,
        turnId,
        activeLeafTurnId: turnId,
      });
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
      host.scheduleMemoryMaintenancePostTurnEvaluation(sessionId, prepared.parentTurnId);
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
    let approvalRequired = false;
    const streamCitations: ChatCitationRecord[] = [];
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
      toolAutonomy: prepared.effectiveToolAutonomy,
      historyMessages: prepared.history,
      signal: controller.signal,
    })) {
      if (chunk.type === "message_done" && chunk.content) {
        finalText = chunk.content;
      }
      if (chunk.type === "approval_required") {
        approvalRequired = true;
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

    if (!approvalRequired && !finalText.trim()) {
      finalText = buildEmptyAssistantTurnFallbackText();
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
      host.publishRealtime("chat_thread_updated", "chat", {
        type: threadEventType,
        sessionId,
        turnId,
        activeLeafTurnId: turnId,
      });
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
      return;
    }

    if (finalText.trim()) {
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
      host.publishRealtime("chat_thread_updated", "chat", {
        type: threadEventType,
        sessionId,
        turnId,
        activeLeafTurnId: turnId,
      });
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
      host.scheduleMemoryMaintenancePostTurnEvaluation(sessionId, prepared.parentTurnId);
    }

    const completedTrace = host.storage.chatTurnTraces.get(turnId);
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
      return;
    }
    throw error;
  } finally {
    host.endActiveChatTurnExecution(turnId, controller);
  }
}
