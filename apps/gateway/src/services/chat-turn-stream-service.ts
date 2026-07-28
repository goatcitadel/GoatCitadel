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
  ModelUsageAttributionContext,
  ModelCouncilExecutionResult,
  ChatOrchestrationSummary,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatStreamChunk,
  ChatStreamChunkDraft,
  ChatSpecialistCandidateSuggestionRecord,
  ChatSessionCreateInput,
  ChatSessionPrefsPatch,
  ChatSessionRecord,
  ChatToolRunRecord,
  ChatStreamUsageRecord,
  ChatTurnTraceRecord,
  RuntimeDecisionTraceAppendInput,
  ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import { CHAT_TURN_ACTIVE_STATUSES, isChatTurnTerminalStatus, NotFoundError } from "@goatcitadel/contracts";
import { isAuthoritativeModelUsageAccountingError } from "@goatcitadel/gateway-core";
import type { Storage } from "@goatcitadel/storage";
import type { TurnRuntime } from "@goatcitadel/orchestration";
import type {
  OrchestrationExecutionResult,
  OrchestrationPlan as ModeOrchestrationPlan,
  OrchestrationRouterInput,
  OrchestrationStepExecutionResult,
} from "../orchestration/types.js";
import { executeOrchestrationPlan } from "../orchestration/engine.js";
import {
  createSubagentFanoutExecutor,
  shouldRegisterSubagentFanoutExecutor,
  type SubagentFanoutExecutor,
  type SubagentFanoutExecutorOptions,
  type SubagentFanoutRuntime,
} from "./chat-subagent-fanout-service.js";
import { buildDelegatedChatSendRequest } from "./delegated-chat-request.js";
import type { ChatTurnAgentRunnerInput } from "./chat-turn-agent-runner.js";
import {
  buildDelegationFailureGuidance,
  buildEmptyAssistantTurnFallbackText,
  buildIncompleteDelegatedTraceFailureGuidance,
  ChatTurnCancelledError,
  dedupeChatCitations,
  isIncompleteDelegatedTraceFailure,
  isChatTurnCancelledError,
  mergeExecutionPlanStepStatuses,
  patchChatTurnTraceIfStatus,
  renderExecutionPlanAsMarkdown,
  splitIntoChunks,
  toTitleCase,
  truncateSummaryLine,
} from "./chat-turn-helpers.js";
import type { ChatStreamMutationLifecycle, PreparedChatExecutionPlanResolution } from "./chat-turn-types.js";
import { buildChatTurnRealtimeOptions } from "./chat-turn-realtime.js";
import {
  enforcePreparedRoutedContextOrchestrationBypass,
  resolvePreparedTurnMode,
  type PreparedAgentChatTurn,
} from "./chat-turn-prep-service.js";
import type { HooksService } from "./hooks-service.js";
import { enqueueAgentEndHook, observeBeforeAssistantMessageWrite } from "./chat-turn-stream-events.js";
import type {
  ChatTurnActiveExecutionControl,
  ChatTurnAdmissionControl,
  ChatTurnMemorySideEffects,
  ChatTurnRealtimeEmitter,
  ChatTurnSteerCollaborator,
  ChatTurnTranscriptIngress,
} from "./chat-turn-runtime-collaborators.js";
import { PROMPT_LAB_LOCAL_FILE_TOOL_NAMES } from "./chat-tool-families.js";
import { isDurableControlError } from "./durable-control-error.js";

type ChatTurnStreamStorage = Pick<
  Storage,
  | "chatDelegationSteps"
  | "chatToolRuns"
  | "chatExecutionPlans"
  | "chatDelegationRuns"
  | "chatSessionProjects"
  | "chatTurnTraces"
  | "chatTurnCapabilityProfiles"
  | "capabilityCatalogSnapshots"
>;

type ChatSendMessageRequestWithPolicyContext = ChatSendMessageRequest & {
  policyContext?: ToolPolicyActorContext;
};

type PreparedRoutedContextUsageAttribution = Readonly<
  NonNullable<ChatTurnAgentRunnerInput["serverContextUsageAttribution"]>
>;

function buildPreparedRoutedContextUsageAttribution(
  prepared: Pick<PreparedAgentChatTurn, "routedContextSnapshot">,
): PreparedRoutedContextUsageAttribution | undefined {
  const snapshot = prepared.routedContextSnapshot;
  if (!snapshot) {
    return undefined;
  }
  return Object.freeze({
    contextSnapshotId: snapshot.snapshotId,
    contextIntentHash: snapshot.sourceRequestHash,
    contextResolutionHash: snapshot.snapshotHash,
  });
}

const LOCAL_BUSINESS_RESEARCH_TOOL_NAME = "local_business.research";
const LOCAL_BUSINESS_CONTACT_TASK_PATTERN =
  /\b(?:board\s*game|boardgame|tabletop|game store|hobby store|local business|businesses|stores?|shops?|contact|email|address(?:es)?|who I should address)\b/i;
const LOCAL_BUSINESS_LOCATION_PATTERN =
  /\b(?:within\s+\d+\s*-?\s*miles?|radius|zip|zipcode|postal|9\d{4}|city|near|around)\b/i;

export interface ChatTurnStreamHost
  extends
    ChatTurnActiveExecutionControl,
    ChatTurnAdmissionControl,
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
  createChatCompletion(
    request: ChatCompletionRequest,
    attribution?: ModelUsageAttributionContext,
  ): Promise<ChatCompletionResponse>;
  executeChatModelCouncil?(prepared: PreparedAgentChatTurn, signal?: AbortSignal): Promise<ModelCouncilExecutionResult>;
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
  recordRuntimeDecision?(input: RuntimeDecisionTraceAppendInput): void;
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
  agentSendChatMessage(
    sessionId: string,
    input: ChatSendMessageRequest,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ChatSendMessageResponse>;
  isFeatureEnabled(flag: string): boolean;
  agentSendChatMessageStream(
    sessionId: string,
    input: ChatSendMessageRequest,
    options?: { abortSignal?: AbortSignal },
  ): AsyncGenerator<ChatStreamChunk>;
  resolveToolPolicyContext?(input: {
    operatorId?: string;
    authActorId?: string;
    authActorSource?: ToolPolicyActorContext["authActorSource"];
    workspaceId?: string;
    sessionId?: string;
    taskId?: string;
    runId?: string;
    surface?: ToolPolicyActorContext["surface"];
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
  }): ToolPolicyActorContext;
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
  /**
   * R3-8 `agent.fanout` session registry. Optional so lightweight test hosts
   * keep working; when absent, no executor is registered and a model
   * `agent.fanout` call fails closed inside the policy-engine runtime hook.
   */
  readonly subagentFanout?: Pick<SubagentFanoutRuntime, "register">;
}

export type ChatTurnCanonicalWriteFence = <T>(work: () => T) => T;

const executeUnfencedChatTurnWrite: ChatTurnCanonicalWriteFence = <T>(work: () => T): T => work();

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

function recordRuntimeDecision(
  host: ChatTurnStreamHost,
  input: RuntimeDecisionTraceAppendInput,
  canonicalWriteFence: ChatTurnCanonicalWriteFence = executeUnfencedChatTurnWrite,
): void {
  try {
    canonicalWriteFence(() => host.recordRuntimeDecision?.(input));
  } catch (error) {
    if (isAuthoritativeModelUsageAccountingError(error)) {
      throw error;
    }
    if (isDurableControlError(error)) {
      throw error;
    }
    // Best-effort decision tracing is non-fatal and must not affect chat turn execution.
  }
}

/** Exported for focused effect-truth trace tests. */
export function recordStepRuntimeDecisions(
  host: ChatTurnStreamHost,
  prepared: PreparedAgentChatTurn,
  input: {
    runId: string;
    planId: string;
    step: OrchestrationStepExecutionResult;
    childToolRuns: ChatToolRunRecord[];
  },
  canonicalWriteFence: ChatTurnCanonicalWriteFence = executeUnfencedChatTurnWrite,
): void {
  for (const toolRun of input.childToolRuns) {
    const kind = resolveToolDecisionKind(toolRun);
    if (!kind) {
      continue;
    }
    recordRuntimeDecision(
      host,
      {
        kind,
        scope: {
          workspaceId: prepared.workspaceId,
          sessionId: prepared.session.sessionId,
          turnId: prepared.turnId,
          runId: input.runId,
          planId: input.planId,
          stepId: input.step.stepId,
          toolRunId: toolRun.toolRunId,
          approvalId: toolRun.approvalId,
        },
        selected: renderToolDecisionSelected(kind, toolRun),
        rationale: renderToolDecisionRationale(kind, toolRun),
        signals: [
          { source: "capability", key: "tool_name", value: toolRun.toolName, weight: "strong" },
          { source: "tool_result", key: "tool_status", value: toolRun.status, weight: "strong" },
          { source: "tool_result", key: "reused", value: Boolean(toolRun.reused), weight: "informational" },
          {
            source: "capability",
            key: "effect_potential",
            value: toolRun.effectPotential ?? null,
            weight: "strong",
          },
          {
            source: "tool_result",
            key: "effect_disposition",
            value: toolRun.effectDisposition ?? null,
            weight: toolRun.effectDisposition === "unknown" ? "blocking" : "strong",
          },
          {
            source: "tool_result",
            key: "effect_outcome_kind",
            value: toolRun.effectOutcomeKind ?? null,
            weight: toolRun.effectOutcomeKind === "uncertain" ? "blocking" : "strong",
          },
          {
            source: "tool_result",
            key: "effect_evidence_reason",
            value: toolRun.effectEvidence?.reason ?? null,
            weight: "informational",
          },
          { source: "approval", key: "approval_id", value: toolRun.approvalId ?? null },
        ],
        evidenceRefs: [
          { refType: "tool_run", refId: toolRun.toolRunId },
          ...(toolRun.approvalId ? [{ refType: "approval" as const, refId: toolRun.approvalId }] : []),
          ...(toolRun.effectEvidence?.refs.map((ref) => ({
            refType: "event" as const,
            refId: ref.refId,
            label: `tool_effect:${ref.owner}`,
          })) ?? []),
        ],
      },
      canonicalWriteFence,
    );
  }
}

function resolveToolDecisionKind(toolRun: ChatToolRunRecord): RuntimeDecisionTraceAppendInput["kind"] | undefined {
  if (toolRun.reused) {
    return "tool_reused";
  }
  switch (toolRun.status) {
    case "started":
    case "executed":
      return "tool_selected";
    case "approval_required":
      return "tool_approval_required";
    case "blocked":
      return "tool_blocked";
    case "failed":
      return "tool_failed";
    default:
      return undefined;
  }
}

function renderToolDecisionSelected(kind: RuntimeDecisionTraceAppendInput["kind"], toolRun: ChatToolRunRecord): string {
  switch (kind) {
    case "tool_reused":
      return `Reuse ${toolRun.toolName}`;
    case "tool_approval_required":
      return `Request approval for ${toolRun.toolName}`;
    case "tool_blocked":
      return `Block ${toolRun.toolName}`;
    case "tool_failed":
      return `Mark ${toolRun.toolName} failed`;
    default:
      return `Select ${toolRun.toolName}`;
  }
}

function renderToolDecisionRationale(
  kind: RuntimeDecisionTraceAppendInput["kind"],
  toolRun: ChatToolRunRecord,
): string {
  if (kind === "tool_reused") {
    return toolRun.reuseReason ?? "A prior compatible tool result was reused for this step.";
  }
  if (kind === "tool_approval_required") {
    return "Gateway policy required operator approval before the tool could continue.";
  }
  if (kind === "tool_blocked") {
    return toolRun.failureGuidance ?? toolRun.error ?? "Gateway policy or capability checks blocked the tool.";
  }
  if (kind === "tool_failed") {
    return toolRun.failureGuidance ?? toolRun.error ?? "The tool invocation returned a failure.";
  }
  return "The delegated step selected this tool while executing the orchestration plan.";
}

export async function executePreparedModeOrchestration(
  host: ChatTurnStreamHost,
  prepared: PreparedAgentChatTurn,
  input: ChatSendMessageRequest,
  signal?: AbortSignal,
  onProgress?: (summary: NonNullable<ChatTurnTraceRecord["orchestration"]>) => Promise<void> | void,
  resolvedOrchestration?: PreparedChatExecutionPlanResolution,
  finalDeltaSink?: FinalDeltaSink,
  canonicalWriteFence: ChatTurnCanonicalWriteFence = executeUnfencedChatTurnWrite,
): Promise<
  OrchestrationExecutionResult & {
    summary: NonNullable<ChatTurnTraceRecord["orchestration"]>;
    executionPlanId: string;
  }
> {
  if (enforcePreparedRoutedContextOrchestrationBypass(prepared)) {
    throw new Error(
      "Routed-context turns cannot execute mode orchestration outside their frozen provider/model budget.",
    );
  }
  const orchestration = resolvedOrchestration ?? (await host.resolvePreparedTurnOrchestration(prepared));
  if (!orchestration) {
    throw new Error("Prepared chat turn is not eligible for orchestration");
  }
  const runId = randomUUID();
  const inputPolicyContext = (input as ChatSendMessageRequestWithPolicyContext).policyContext;
  const effectivePermissionProfileId = inputPolicyContext?.permissionProfileId ?? input.permissionProfileId;
  const runMode = orchestration.orchestrationPlan.routeDecision.parallelism === "parallel" ? "parallel" : "sequential";
  const persistedExecutionPlan = canonicalWriteFence(() =>
    host.storage.chatExecutionPlans.create({
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
    }),
  );
  recordRuntimeDecision(
    host,
    {
      kind: "workflow_choice",
      scope: {
        workspaceId: prepared.workspaceId,
        sessionId: prepared.session.sessionId,
        turnId: prepared.turnId,
        runId,
        planId: persistedExecutionPlan.planId,
      },
      selected: `Use ${orchestration.orchestrationPlan.workflowTemplate} workflow`,
      rationale: orchestration.orchestrationPlan.routeDecision.triggerReason,
      alternatives: [
        {
          label: "Direct answer",
          outcome: "not_chosen",
          reasonNotChosen: "The mode router selected an inspectable workflow for this turn.",
        },
        {
          label: "Single tool-backed response",
          outcome: "deferred",
          reasonNotChosen: "Tool invocation remains governed inside delegated steps and policy checks.",
        },
      ],
      signals: [
        { source: "routing", key: "mode", value: orchestration.routerInput.task.mode, weight: "strong" },
        {
          source: "orchestration",
          key: "workflow_template",
          value: orchestration.orchestrationPlan.workflowTemplate,
          weight: "strong",
        },
        {
          source: "orchestration",
          key: "parallelism",
          value: orchestration.orchestrationPlan.routeDecision.parallelism,
          weight: "informational",
        },
        {
          source: "model_router",
          key: "decision",
          value: prepared.modelRouterDecision.orchestration?.decision ?? "allowed",
          weight: "informational",
        },
      ],
      evidenceRefs: [
        { refType: "turn", refId: prepared.turnId },
        { refType: "run", refId: runId },
        { refType: "plan", refId: persistedExecutionPlan.planId },
      ],
    },
    canonicalWriteFence,
  );
  recordRuntimeDecision(
    host,
    {
      kind: "execution_plan_created",
      scope: {
        workspaceId: prepared.workspaceId,
        sessionId: prepared.session.sessionId,
        turnId: prepared.turnId,
        runId,
        planId: persistedExecutionPlan.planId,
      },
      selected: `Create ${persistedExecutionPlan.steps.length} step execution plan`,
      rationale: persistedExecutionPlan.summary,
      signals: [
        { source: "execution_plan", key: "step_count", value: persistedExecutionPlan.steps.length },
        { source: "execution_plan", key: "advisory_only", value: persistedExecutionPlan.advisoryOnly },
        { source: "execution_plan", key: "source", value: persistedExecutionPlan.source },
      ],
      evidenceRefs: [{ refType: "plan", refId: persistedExecutionPlan.planId }],
    },
    canonicalWriteFence,
  );
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
  const persistedStepIds = new Map(
    orchestration.orchestrationPlan.steps.map((step) => [step.stepId, `${runId}:${step.stepId}`] as const),
  );
  canonicalWriteFence(() => {
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
    for (const [index, step] of orchestration.orchestrationPlan.steps.entries()) {
      const persistedStepId = persistedStepIds.get(step.stepId)!;
      host.storage.chatDelegationSteps.create({
        stepId: persistedStepId,
        runId,
        role: step.role,
        label: step.label,
        index,
        status: "pending",
        parallelizable: step.parallelizable,
        dependsOnStepIds: (step.dependsOnStepIds ?? []).map(
          (dependencyStepId) => persistedStepIds.get(dependencyStepId) ?? dependencyStepId,
        ),
        providerId: step.providerId,
        model: step.model,
      });
    }
  });

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
    canonicalWriteFence(() => {
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
    });
    recordRuntimeDecision(
      host,
      {
        kind: "execution_plan_revised",
        scope: {
          workspaceId: prepared.workspaceId,
          sessionId: prepared.session.sessionId,
          turnId: prepared.turnId,
          runId,
          planId: persistedExecutionPlan.planId,
        },
        selected: "Finish advisory plan without tool execution",
        rationale:
          "Planning mode was advisory, so the runtime returned the drafted execution plan as the final answer.",
        signals: [
          { source: "execution_plan", key: "status", value: "ready", weight: "strong" },
          { source: "operator_pref", key: "planning_mode", value: prepared.prefs.planningMode },
        ],
        evidenceRefs: [{ refType: "plan", refId: persistedExecutionPlan.planId }],
      },
      canonicalWriteFence,
    );
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

  let orchestrationCompletionIndex = 0;
  const result = await executeOrchestrationPlan({
    task: orchestration.routerInput.task,
    plan: orchestration.orchestrationPlan,
    callbacks: {
      createChatCompletion: async (request, attribution = {}) => {
        const completionIndex = orchestrationCompletionIndex;
        orchestrationCompletionIndex += 1;
        const orchestrationDrainedSteers = host.steerService.drainPending({
          sessionId: prepared.session.sessionId,
          turnId: prepared.turnId,
        });
        for (const steerItem of orchestrationDrainedSteers) {
          let steerCommitted = false;
          await host.ingestEvent(
            randomUUID(),
            {
              eventId: randomUUID(),
              route: prepared.route,
              actor: { type: "user", id: "operator" },
              message: {
                role: "user",
                content: steerItem.instruction,
                steered: true,
              },
            },
            {
              onCommit: () =>
                canonicalWriteFence(() => {
                  steerCommitted = true;
                }),
            },
          );
          if (!steerCommitted) {
            throw new Error(`Chat turn ${prepared.turnId} steer ingest skipped its canonical write fence.`);
          }
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
        const logicalOperationId = attribution.operationId ?? `orchestration-call-${completionIndex}`;
        const logicalDispatchGeneration = attribution.dispatchGeneration ?? `${logicalOperationId}:generation-1`;
        canonicalWriteFence(() => undefined);
        return host.createChatCompletion(
          {
            ...composed,
            signal,
          },
          {
            ...attribution,
            operationId: `chat-turn:${prepared.turnId}:${logicalOperationId}`,
            dispatchGeneration: `chat-turn:${prepared.turnId}:${logicalDispatchGeneration}`,
            workspaceId: prepared.workspaceId,
            sessionId: prepared.session.sessionId,
            turnId: prepared.turnId,
            durableRunId: runId,
            taskId: `chat-orchestration:${prepared.turnId}`,
            agentId: attribution.agentId ?? "goatherder",
            attemptIndex: attribution.attemptIndex ?? 0,
          },
        );
      },
      executeDelegatedStep: async ({ task, plan, priorSteps, step, stepIndex }) => {
        const orchestrationMode = orchestration.routerInput.task.mode;
        const streamTerminalStep =
          Boolean(finalDeltaSink) &&
          !host.isFeatureEnabled("orchestrationFinalStreamingV1Disabled") &&
          (orchestrationMode === "cowork" || orchestrationMode === "code") &&
          isTerminalSynthesisStep(plan, step) &&
          typeof host.agentSendChatMessageStream === "function";
        return executeDelegatedPlanStep(host, prepared, {
          task,
          plan,
          priorSteps,
          step,
          stepIndex,
          runId,
          signal,
          operatorId: input.operatorId,
          authActorId: input.authActorId,
          authActorSource: input.authActorSource,
          permissionProfileId: effectivePermissionProfileId,
          policyContext: inputPolicyContext,
          localOperatorOverrideId: input.localOperatorOverrideId,
          fullWebAccess: input.fullWebAccess,
          streamTerminalStep,
          finalDeltaSink: streamTerminalStep ? finalDeltaSink : undefined,
          canonicalWriteFence,
        });
      },
      onStepResult: async (step, allSteps) => {
        currentSteps = [...allSteps];
        const childToolRuns = step.childTurnId
          ? (host.storage.chatToolRuns.listByTurnIds([step.childTurnId]).get(step.childTurnId) ?? [])
          : [];
        recordStepRuntimeDecisions(
          host,
          prepared,
          {
            runId,
            planId: persistedExecutionPlan.planId,
            step,
            childToolRuns,
          },
          canonicalWriteFence,
        );
        const activeToolWork = childToolRuns.some(
          (toolRun) => toolRun.status === "started" || toolRun.status === "approval_required",
        );
        host.recordDevDiagnostic({
          level: step.status === "failed" ? "warn" : "info",
          category: "orchestration",
          event: step.status === "running" ? "orchestration.step.waiting" : "orchestration.step.complete",
          message:
            step.status === "running"
              ? `Orchestration step ${step.role} is waiting`
              : `Completed orchestration step ${step.role}`,
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
            step.status === "running"
              ? "running"
              : step.degradedHandoffStepIds?.length
                ? "degraded"
                : step.status === "failed" && activeToolWork
                  ? "degraded"
                  : step.status === "failed"
                    ? "failed"
                    : "completed",
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
            waitStatus: step.waitStatus,
            index: step.index,
            activeToolWork,
            activeToolRunCount: childToolRuns.filter(
              (toolRun) => toolRun.status === "started" || toolRun.status === "approval_required",
            ).length,
          },
        });
        canonicalWriteFence(() => {
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
            degradedHandoffStepIds: step.degradedHandoffStepIds,
            durableRunId: step.durableRunId,
            childSessionId: step.childSessionId,
            childTurnId: step.childTurnId,
            citations: step.citations,
            ...(step.finishedAt ? { finishedAt: step.finishedAt } : {}),
            ...(typeof step.durationMs === "number" ? { durationMs: step.durationMs } : {}),
          });
          host.storage.chatExecutionPlans.patch(persistedExecutionPlan.planId, {
            steps: mergeExecutionPlanStepStatuses(
              host.storage.chatExecutionPlans.get(persistedExecutionPlan.planId).steps,
              allSteps,
            ),
          });
        });
        recordRuntimeDecision(
          host,
          {
            kind: "execution_plan_revised",
            scope: {
              workspaceId: prepared.workspaceId,
              sessionId: prepared.session.sessionId,
              turnId: prepared.turnId,
              runId,
              planId: persistedExecutionPlan.planId,
              stepId: step.stepId,
            },
            selected: `Step ${step.stepId} marked ${step.status}`,
            rationale:
              step.summary ??
              step.error ??
              step.waitStatus ??
              "Execution plan step status changed after runtime evidence.",
            signals: [
              { source: "execution_plan", key: "step_status", value: step.status, weight: "strong" },
              { source: "execution_plan", key: "wait_status", value: step.waitStatus ?? null },
              { source: "tool_result", key: "child_tool_run_count", value: childToolRuns.length },
            ],
            evidenceRefs: [
              { refType: "plan", refId: persistedExecutionPlan.planId },
              { refType: "step", refId: step.stepId },
            ],
          },
          canonicalWriteFence,
        );
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
  const orchestrationFinishedAt = summary.status === "running" ? undefined : new Date().toISOString();
  canonicalWriteFence(() => {
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
      ...(orchestrationFinishedAt ? { finishedAt: orchestrationFinishedAt } : {}),
    });
    host.storage.chatExecutionPlans.patch(persistedExecutionPlan.planId, {
      status:
        summary.status === "running"
          ? "running"
          : summary.status === "failed"
            ? "failed"
            : summary.status === "partial"
              ? "partial"
              : "completed",
      summary: result.finalSummary,
      ...(orchestrationFinishedAt ? { finishedAt: orchestrationFinishedAt } : {}),
      steps: mergeExecutionPlanStepStatuses(
        host.storage.chatExecutionPlans.get(persistedExecutionPlan.planId).steps,
        result.stepResults,
      ),
    });
  });
  recordRuntimeDecision(
    host,
    {
      kind: "execution_plan_revised",
      scope: {
        workspaceId: prepared.workspaceId,
        sessionId: prepared.session.sessionId,
        turnId: prepared.turnId,
        runId,
        planId: persistedExecutionPlan.planId,
      },
      selected: `Execution plan ${summary.status}`,
      rationale: result.finalSummary,
      signals: [
        { source: "execution_plan", key: "status", value: summary.status, weight: "strong" },
        { source: "orchestration", key: "integrity_signal_count", value: result.integritySignals?.length ?? 0 },
      ],
      evidenceRefs: [
        { refType: "plan", refId: persistedExecutionPlan.planId },
        { refType: "run", refId: runId },
      ],
    },
    canonicalWriteFence,
  );
  await onProgress?.(summary);
  const lifecycleEvent =
    summary.status === "running"
      ? "orchestration.run.waiting"
      : summary.status === "failed"
        ? "orchestration.run.failed"
        : "orchestration.run.complete";
  const lifecycleMessage =
    summary.status === "running"
      ? "Chat orchestration run is waiting."
      : summary.status === "failed"
        ? "Chat orchestration run failed."
        : "Completed chat orchestration run.";
  host.recordDevDiagnostic({
    level: summary.status === "failed" ? "warn" : "info",
    category: "orchestration",
    event: lifecycleEvent,
    message: lifecycleMessage,
    sessionId: prepared.session.sessionId,
    turnId: prepared.turnId,
    runId,
    taskId: `chat-orchestration:${prepared.turnId}`,
    providerId: result.finalStep?.providerId ?? result.stepResults.at(-1)?.providerId,
    modelId: result.finalStep?.model ?? result.stepResults.at(-1)?.model,
    runtimeKind: "run.lifecycle",
    runtimeStatus: summary.status === "running" ? "running" : summary.status === "failed" ? "failed" : "completed",
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
    operatorId?: string;
    authActorId?: string;
    authActorSource?: ChatSendMessageRequest["authActorSource"];
    permissionProfileId?: string;
    localOperatorOverrideId?: string;
    policyContext?: ToolPolicyActorContext;
    fullWebAccess?: boolean;
    streamTerminalStep?: boolean;
    finalDeltaSink?: FinalDeltaSink;
    canonicalWriteFence?: ChatTurnCanonicalWriteFence;
  },
): Promise<OrchestrationStepExecutionResult> {
  const startedAt = new Date().toISOString();
  const delegatedRole = input.step.delegatedRole ?? input.step.role;
  const orchestrationTaskId = `chat-orchestration:${prepared.turnId}`;
  const canonicalWriteFence = input.canonicalWriteFence ?? executeUnfencedChatTurnWrite;
  const childSession = canonicalWriteFence(() => {
    const parentProjectId = host.storage.chatSessionProjects.get(prepared.session.sessionId)?.projectId;
    const created = host.createChatSession({
      workspaceId: prepared.workspaceId,
      title: `Delegate · ${toTitleCase(delegatedRole)}`,
      projectId: parentProjectId,
      mode: input.task.mode,
    });
    host.inheritDelegatedSessionToolGrants(prepared.session.sessionId, created.sessionId);
    host.updateChatSessionPrefs(created.sessionId, {
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
    return created;
  });

  const conversationContext = input.task.conversation
    .slice(-6)
    .map((message) => `${message.role.toUpperCase()}: ${truncateSummaryLine(message.content, 320)}`)
    .join("\n");
  const priorStepContext = buildDelegatedPriorStepContext(input.priorSteps, input.step.role);
  const suggestedTools = enrichDelegatedSuggestedToolsForObjective(
    filterDelegatedSuggestedToolsForPromptLab(input.step.suggestedTools ?? [], {
      mode: input.task.mode,
      normalizationProfile: prepared.normalized.normalizationProfile,
    }),
    {
      mode: input.task.mode,
      objective: input.task.objective,
      stepObjective: input.step.objective,
      expectedOutput: input.step.expectedOutput,
    },
  );
  const localBusinessResearchHint = shouldPreferLocalBusinessResearchTool({
    mode: input.task.mode,
    objective: input.task.objective,
    stepObjective: input.step.objective,
    expectedOutput: input.step.expectedOutput,
  })
    ? "Local-business contact research: call local_business.research before broad browser browsing, then continue only for unresolved candidates, missing required contact fields, or source blockers."
    : undefined;
  const content = [
    `Delegated role: ${delegatedRole}`,
    `Parent objective: ${input.task.objective}`,
    `Plan summary: ${input.plan.summary}`,
    `Current step objective: ${input.step.objective}`,
    input.step.successCriteria ? `Success criteria: ${input.step.successCriteria}` : undefined,
    input.step.expectedOutput ? `Expected output: ${input.step.expectedOutput}` : undefined,
    suggestedTools.length ? `Suggested tools: ${suggestedTools.join(", ")}` : undefined,
    localBusinessResearchHint,
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
    taskId: orchestrationTaskId,
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
    const inheritedPolicyContext = host.resolveToolPolicyContext?.({
      operatorId: input.operatorId,
      authActorId: input.authActorId,
      authActorSource: input.authActorSource,
      workspaceId: prepared.workspaceId,
      sessionId: prepared.session.sessionId,
      taskId: orchestrationTaskId,
      runId: input.runId,
      surface: input.task.mode,
      permissionProfileId: input.policyContext?.permissionProfileId ?? input.permissionProfileId,
      localOperatorOverrideId: input.localOperatorOverrideId,
    });
    delegatedDispatchStarted = true;
    canonicalWriteFence(() =>
      patchActiveDelegationStep(host, {
        stepId: `${input.runId}:${input.step.stepId}`,
        childSessionId: childSession.sessionId,
        role: delegatedRole,
        label: input.step.label,
        providerId: input.step.providerId ?? prepared.prefs.providerId,
        model: input.step.model ?? prepared.prefs.model,
      }),
    );
    const delegatedSendRequest = buildDelegatedChatSendRequest({
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
      operatorId: input.operatorId,
      authActorId: input.authActorId,
      authActorSource: input.authActorSource,
      permissionProfileId: inheritedPolicyContext?.permissionProfileId,
      localOperatorOverrideId: inheritedPolicyContext?.localOperatorOverrideId,
      policyRunId: input.runId,
      policyTaskId: orchestrationTaskId,
      fullWebAccess: input.fullWebAccess,
      parentDelegationStepId: `${input.runId}:${input.step.stepId}`,
      policyContext: inheritedPolicyContext,
    });
    const sendOptions = input.signal ? { abortSignal: input.signal } : undefined;
    // S1: stream the terminal synthesizer child's live token deltas straight to
    // the parent SSE (default-on, gated by the caller). Falls back to a buffered
    // send only when the stream throws before the first delta, so the persisted
    // result is byte-identical to today's behavior on any pre-token failure.
    const response =
      input.streamTerminalStep && typeof host.agentSendChatMessageStream === "function"
        ? await driveTerminalDelegatedStream(host, {
            childSessionId: childSession.sessionId,
            request: delegatedSendRequest,
            options: sendOptions,
            finalDeltaSink: input.finalDeltaSink,
          })
        : await host.agentSendChatMessage(childSession.sessionId, delegatedSendRequest, sendOptions);
    delegatedResponseReceived = true;
    if (input.signal?.aborted) {
      throw new ChatTurnCancelledError(prepared.turnId);
    }

    const traceStatus = response.trace?.status;
    const waitStatus =
      traceStatus === "waiting_for_approval" ||
      traceStatus === "waiting_for_user_input" ||
      traceStatus === "waiting_for_tool"
        ? traceStatus
        : undefined;
    const waiting = Boolean(waitStatus);
    const output =
      response.assistantMessage?.content?.trim() ||
      response.trace?.failure?.message?.trim() ||
      (traceStatus === "waiting_for_approval"
        ? response.trace?.pendingApprovalSummary?.reason?.trim() || "Delegate is waiting for approval."
        : traceStatus === "waiting_for_user_input"
          ? response.trace?.pendingUserInput?.question?.trim() || "Delegate is waiting for user input."
          : traceStatus === "waiting_for_tool"
            ? "Delegate is still waiting on a tool result."
            : "(delegate returned no output)");
    const finishedAt = waiting ? undefined : new Date().toISOString();
    const traceFailure = response.trace?.failure;
    const degradedFailure = !waiting && isIncompleteDelegatedTraceFailure(traceFailure);
    const failed = traceStatus === "failed" || traceStatus === "cancelled" || degradedFailure;
    const failureGuidance = failed
      ? buildIncompleteDelegatedTraceFailureGuidance(traceFailure, output, delegatedRole)
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
      ...(finishedAt
        ? {
            finishedAt,
            durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
          }
        : {}),
      status: waiting ? "running" : traceStatus === "cancelled" ? "cancelled" : failed ? "failed" : "completed",
      waitStatus,
      output,
      summary: truncateSummaryLine(output, 180),
      error: failed ? (traceFailure?.message ?? output) : undefined,
      failureGuidance,
      citations: response.citations ?? [],
      routing: response.routing,
      childRunId: undefined,
      durableRunId: response.trace?.durable?.runId,
      childSessionId: childSession.sessionId,
      childTurnId: response.turnId,
    };
  } catch (error) {
    if (isAuthoritativeModelUsageAccountingError(error)) {
      throw error;
    }
    if (isDurableControlError(error)) {
      throw error;
    }
    const finishedAt = new Date().toISOString();
    const message = error instanceof Error ? error.message : String(error);
    const cancelled = Boolean(input.signal?.aborted) || isChatTurnCancelledError(error);
    const timeoutWithoutProviderResult = /\btimeout|timed out|deadline\b/i.test(message);
    host.recordDevDiagnostic({
      level: cancelled ? "info" : "warn",
      category: "orchestration",
      event: cancelled
        ? "orchestration.step.cancelled_before_result"
        : timeoutWithoutProviderResult
          ? "orchestration.step.timeout_without_provider_result"
          : "orchestration.step.failed_before_result",
      message: cancelled
        ? `Delegated orchestration step ${delegatedRole} was cancelled before returning a result`
        : timeoutWithoutProviderResult
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
      runtimeStatus: cancelled ? "cancelled" : "failed",
      runtimeError: {
        name: error instanceof Error ? error.name : undefined,
        message,
        retryable: !cancelled && timeoutWithoutProviderResult,
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
      status: cancelled ? "cancelled" : "failed",
      summary: cancelled ? `${toTitleCase(delegatedRole)} cancelled` : `${toTitleCase(delegatedRole)} failed`,
      error: message,
      failureGuidance: buildDelegationFailureGuidance(message, delegatedRole),
      citations: [],
      childRunId: undefined,
      durableRunId: undefined,
      childSessionId: childSession.sessionId,
    };
  }
}

/**
 * Bind the real delegated-step machinery into the R3-8 `agent.fanout` executor.
 * Lives here (not in chat-subagent-fanout-service) so that module never
 * value-imports this one — the executor factory takes the step runner as an
 * injected dependency instead of importing it.
 */
export function createTurnSubagentFanoutExecutor(
  host: ChatTurnStreamHost,
  prepared: PreparedAgentChatTurn,
  options: Omit<SubagentFanoutExecutorOptions, "runDelegatedStep">,
): SubagentFanoutExecutor {
  return createSubagentFanoutExecutor(host, prepared, { ...options, runDelegatedStep: executeDelegatedPlanStep });
}

/**
 * Register the turn's `agent.fanout` executor for exactly the lifetime of the
 * direct turn-runtime stream: registered before the runtime produces its first
 * chunk (so a mid-turn model call routed through the policy engine can find
 * it), disposed when the stream completes, throws, or is abandoned. Gated on
 * the turn's own eligibility so a delegated child (floored to subagentPolicy
 * "off") never holds a live executor.
 */
async function* runDirectTurnStreamWithSubagentFanout(
  host: ChatTurnStreamHost,
  prepared: PreparedAgentChatTurn,
  options: Omit<SubagentFanoutExecutorOptions, "runDelegatedStep">,
  makeStream: () => ReturnType<ChatTurnStreamHost["turnRuntime"]["runStream"]>,
): ReturnType<ChatTurnStreamHost["turnRuntime"]["runStream"]> {
  const disposeSubagentFanout = shouldRegisterSubagentFanoutExecutor(prepared, options.permissionProfileId)
    ? host.subagentFanout?.register(
        prepared.session.sessionId,
        createTurnSubagentFanoutExecutor(host, prepared, options),
      )
    : undefined;
  try {
    yield* makeStream();
  } finally {
    disposeSubagentFanout?.();
  }
}

/**
 * Drive the terminal synthesizer child's live stream, forwarding each `delta`
 * chunk to the parent SSE immediately (via `finalDeltaSink`) while reassembling
 * the authoritative {@link ChatSendMessageResponse} the buffered child-send would
 * have produced. The child's own answer-recovery happens at its `message_done`;
 * we forward deltas live (never gating first-token on recovery) and reconcile the
 * persisted/rendered string later through the parent's divergence guard.
 *
 * Fallback contract:
 *  - throws BEFORE any delta was pushed → fall back to the buffered
 *    `agentSendChatMessage` send so the result is byte-identical to today.
 *  - throws AFTER ≥1 delta was pushed → do NOT re-send (that would duplicate
 *    tokens); reconstruct from whatever terminal `message_done`/`trace_update`
 *    was already seen so the engine can shape the step exactly as the buffered
 *    branch (a failed/degraded child still yields the same downstream result).
 */
async function driveTerminalDelegatedStream(
  host: ChatTurnStreamHost,
  input: {
    childSessionId: string;
    request: ChatSendMessageRequest;
    options?: { abortSignal?: AbortSignal };
    finalDeltaSink?: FinalDeltaSink;
  },
): Promise<ChatSendMessageResponse> {
  let accumulatedText = "";
  let deltaCount = 0;
  let terminalContent: string | undefined;
  let terminalTrace: ChatTurnTraceRecord | undefined;
  let terminalTurnId: string | undefined;
  let terminalMessageId: string | undefined;
  const citations: ChatCitationRecord[] = [];

  try {
    for await (const chunk of host.agentSendChatMessageStream(input.childSessionId, input.request, input.options)) {
      switch (chunk.type) {
        case "delta": {
          if (chunk.delta) {
            accumulatedText += chunk.delta;
            input.finalDeltaSink?.push(chunk.delta);
            deltaCount += 1;
            if (deltaCount === 1) {
              input.finalDeltaSink?.markStreamed();
            }
          }
          break;
        }
        case "message_done": {
          terminalContent = chunk.content;
          terminalTurnId = chunk.turnId;
          terminalMessageId = chunk.messageId;
          break;
        }
        case "trace_update": {
          terminalTrace = chunk.trace;
          break;
        }
        case "citation": {
          citations.push(chunk.citation);
          break;
        }
        default:
          // The child's message_start / tool_* / approval / done chunks belong to
          // the child turn and must not be forwarded to the parent SSE.
          break;
      }
    }
  } catch (error) {
    if (isAuthoritativeModelUsageAccountingError(error)) {
      throw error;
    }
    if (deltaCount === 0) {
      // No token reached the parent yet: re-run buffered so behavior is
      // byte-identical to the non-streaming path on any pre-token failure.
      return host.agentSendChatMessage(input.childSessionId, input.request, input.options);
    }
    // Tokens already streamed: never re-send. Reconstruct only when a real
    // terminal signal was seen; a stale/running trace plus partial deltas is not
    // an authoritative child result and must flow through the delegated failure
    // path instead of being promoted to a successful final answer.
    if (terminalContent === undefined && !isTerminalDelegatedStreamTrace(terminalTrace)) {
      throw error;
    }
  }

  const assistantContent = terminalContent ?? accumulatedText;
  // Use the child's real assistant messageId from message_done when present;
  // never substitute the session id (a different identifier namespace). These
  // ids are not read by the delegated-step result shaping, but keeping them
  // honest avoids confusing any downstream message lookup/dedup.
  return {
    sessionId: input.childSessionId,
    userMessage: { messageId: terminalMessageId } as ChatSendMessageResponse["userMessage"],
    assistantMessage: assistantContent
      ? ({ messageId: terminalMessageId, content: assistantContent } as ChatSendMessageResponse["assistantMessage"])
      : undefined,
    transport: "llm",
    model: terminalTrace?.model,
    turnId: terminalTurnId ?? terminalTrace?.turnId,
    trace: terminalTrace,
    citations,
    routing: terminalTrace?.routing,
  };
}

function isTerminalDelegatedStreamTrace(trace: ChatTurnTraceRecord | undefined): boolean {
  // completed/partial/failed/cancelled are genuine final states. waiting_for_approval
  // and waiting_for_user_input are genuine resting states: the child has intentionally
  // parked awaiting external input, so a stream that ends here carries an authoritative
  // (if paused) child result.
  switch (trace?.status) {
    case "completed":
    case "partial":
    case "failed":
    case "cancelled":
    case "waiting_for_approval":
    case "waiting_for_user_input":
      return true;
    // waiting_for_tool is NOT terminal: it is a transient in-flight marker patched
    // in immediately before each tool call and superseded once the tool completes.
    // If the stream threw while the last-seen trace was still waiting_for_tool, the
    // child crashed mid-tool-execution — treat it as a running/stale trace so the
    // error is rethrown into the delegated failure path instead of being promoted
    // to a successful-looking partial result.
    default:
      return false;
  }
}

function patchActiveDelegationStep(
  host: ChatTurnStreamHost,
  input: {
    stepId: string;
    childSessionId: string;
    role: string;
    label?: string;
    providerId?: string;
    model?: string;
  },
): void {
  try {
    host.storage.chatDelegationSteps.patch(input.stepId, {
      status: "running",
      providerId: input.providerId,
      model: input.model,
      label: input.label ?? input.role,
      summary: `${toTitleCase(input.role)} is running delegated work.`,
      childSessionId: input.childSessionId,
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return;
    }
    throw error;
  }
}

function createAsyncProgressQueue<T>() {
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

/**
 * Sink for forwarding the terminal synthesizer child's live token deltas up to
 * the parent SSE stream. `push` emits a delta immediately as it arrives from the
 * child; `markStreamed` is called once at least one delta has been forwarded so
 * the parent can decide whether to skip the buffered synthetic-delta split.
 */
export interface FinalDeltaSink {
  push(delta: string): void;
  markStreamed(): void;
}

/**
 * Conservative, pure predicate: is `step` the single terminal synthesizer step
 * whose output becomes the orchestration `finalOutput`? Only such a step is safe
 * to stream live to the parent SSE, because the engine short-circuits final
 * synthesis on a completed synthesizer (no re-emit / repair pass). Any doubt
 * returns `false` so the buffered path is used.
 *
 * True ONLY when ALL hold:
 *  - `step.delegatedRole` is set (the step actually runs as a delegated child),
 *  - `step.role` is the synthesizer,
 *  - `step.stage` equals the maximum stage across all plan steps,
 *  - `step` is the SOLE step occupying that maximum stage.
 */
export function isTerminalSynthesisStep(
  plan: ModeOrchestrationPlan,
  step: ModeOrchestrationPlan["steps"][number],
): boolean {
  if (!step.delegatedRole) {
    return false;
  }
  if (step.role !== "synthesizer") {
    return false;
  }
  const stages = plan.steps.map((candidate) => candidate.stage);
  if (stages.length === 0) {
    return false;
  }
  const maxStage = Math.max(...stages);
  if (step.stage !== maxStage) {
    return false;
  }
  const stepsInMaxStage = plan.steps.filter((candidate) => candidate.stage === maxStage);
  return stepsInMaxStage.length === 1;
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

function enrichDelegatedSuggestedToolsForObjective(
  suggestedTools: string[],
  input: {
    mode: ChatMode;
    objective?: string;
    stepObjective?: string;
    expectedOutput?: string;
  },
): string[] {
  if (!shouldPreferLocalBusinessResearchTool(input)) {
    return suggestedTools;
  }
  const withoutDuplicate = suggestedTools.filter((toolName) => toolName !== LOCAL_BUSINESS_RESEARCH_TOOL_NAME);
  return [LOCAL_BUSINESS_RESEARCH_TOOL_NAME, ...withoutDuplicate];
}

function shouldPreferLocalBusinessResearchTool(input: {
  mode: ChatMode;
  objective?: string;
  stepObjective?: string;
  expectedOutput?: string;
}): boolean {
  if (input.mode !== "cowork") {
    return false;
  }
  const text = [input.objective, input.stepObjective, input.expectedOutput].filter(Boolean).join(" ");
  return LOCAL_BUSINESS_CONTACT_TASK_PATTERN.test(text) && LOCAL_BUSINESS_LOCATION_PATTERN.test(text);
}

export async function* streamChatModelCouncil(
  host: ChatTurnStreamHost,
  prepared: PreparedAgentChatTurn,
  signal?: AbortSignal,
  canonicalWriteFence: ChatTurnCanonicalWriteFence = executeUnfencedChatTurnWrite,
): AsyncGenerator<ChatStreamChunkDraft> {
  if (!host.executeChatModelCouncil) {
    throw new Error("Model council runtime collaborator is unavailable.");
  }
  canonicalWriteFence(() => undefined);
  const result = await host.executeChatModelCouncil(prepared, signal);
  if (result.usage || result.modelUsageEventIds.length > 0) {
    yield {
      type: "usage",
      sessionId: prepared.session.sessionId,
      turnId: prepared.turnId,
      usage: result.usage ?? {},
      ...(result.modelUsageEventIds.length > 0 ? { modelUsageEventIds: result.modelUsageEventIds } : {}),
    };
  }
  yield {
    type: "message_done",
    sessionId: prepared.session.sessionId,
    turnId: prepared.turnId,
    messageId: prepared.assistantMessageId,
    content: result.answer,
  };
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
    abortSignal?: AbortSignal;
    canonicalWriteFence?: ChatTurnCanonicalWriteFence;
    mutationLifecycle?: ChatStreamMutationLifecycle;
    /** Durable runs reconcile general post-commit effects after terminal run finalization. */
    deferGeneralPostCommit?: boolean;
  },
): AsyncGenerator<ChatStreamChunkDraft> {
  const inputPolicyContext = (input as ChatSendMessageRequestWithPolicyContext).policyContext;
  const effectivePermissionProfileId = inputPolicyContext?.permissionProfileId ?? input.permissionProfileId;
  const turnId = prepared.turnId;
  const assistantMessageId = prepared.assistantMessageId;
  const chatTurnTraces = host.storage.chatTurnTraces;
  const baseCanonicalWriteFence = options?.canonicalWriteFence ?? executeUnfencedChatTurnWrite;
  const canonicalWriteFence: ChatTurnCanonicalWriteFence = options?.mutationLifecycle
    ? <T>(work: () => T): T => {
        const result = baseCanonicalWriteFence(work);
        options.mutationLifecycle?.markCommitted();
        return result;
      }
    : baseCanonicalWriteFence;
  const deferGeneralPostCommit = options?.deferGeneralPostCommit === true;
  const controller = host.beginActiveChatTurnExecution(sessionId, turnId, threadEventType);
  const externalAbortListener = bindExternalAbortToController(options?.abortSignal, controller);
  host.steerService?.registerActiveTurn?.({ sessionId, turnId });

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

    const routedContextOrchestrationBypassed = enforcePreparedRoutedContextOrchestrationBypass(prepared);
    const modeOrchestration =
      routedContextOrchestrationBypassed || input.modelCouncil?.enabled
        ? undefined
        : (resolvedOrchestration ?? (await host.resolvePreparedTurnOrchestration(prepared)));
    if (modeOrchestration) {
      const mode = resolvePreparedTurnMode(prepared);
      const initialTrace = canonicalWriteFence(() =>
        createOrRefreshRunningChatTurnTrace(host, {
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
            effectiveModel:
              modeOrchestration.orchestrationPlan.steps.at(0)?.model ?? input.model ?? prepared.prefs.model,
            modelRouter: prepared.modelRouterDecision,
            ...(input.runVariableEvidence ? { runVariables: input.runVariableEvidence } : {}),
          },
        }),
      );
      yield {
        type: "trace_update",
        sessionId,
        turnId,
        trace: initialTrace,
      };

      // eslint-disable-next-line prefer-const
      let executionPlanId: string | undefined;
      // S1: a single tagged-union side-channel carries BOTH orchestration
      // `trace` progress and the terminal synthesizer's live `delta` tokens,
      // drained in one loop so their relative order is preserved on the parent
      // SSE. The `finalDeltaSink` pushes real model deltas as they arrive.
      const progressQueue = createAsyncProgressQueue<
        { kind: "trace"; trace: ChatTurnTraceRecord } | { kind: "delta"; delta: string }
      >();
      let streamedFinalText = "";
      let streamedRealFinalDeltas = false;
      const finalDeltaSink: FinalDeltaSink = {
        push(delta) {
          streamedFinalText += delta;
          progressQueue.push({ kind: "delta", delta });
        },
        markStreamed() {
          streamedRealFinalDeltas = true;
        },
      };
      const orchestrationResultPromise = executePreparedModeOrchestration(
        host,
        prepared,
        input,
        controller.signal,
        async (summary) => {
          const progressTrace = canonicalWriteFence(() =>
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
                modelRouter: prepared.modelRouterDecision,
                ...(input.runVariableEvidence ? { runVariables: input.runVariableEvidence } : {}),
              },
            }),
          );
          progressQueue.push({ kind: "trace", trace: progressTrace });
        },
        modeOrchestration,
        finalDeltaSink,
        canonicalWriteFence,
      ).finally(() => {
        progressQueue.close();
      });
      while (true) {
        const progressItem = await progressQueue.next();
        if (!progressItem) {
          break;
        }
        if (progressItem.kind === "delta") {
          yield {
            type: "delta",
            sessionId,
            turnId,
            messageId: assistantMessageId,
            delta: progressItem.delta,
          };
          continue;
        }
        yield {
          type: "trace_update",
          sessionId,
          turnId,
          trace: progressItem.trace,
        };
      }
      const orchestrationResult = await orchestrationResultPromise;
      executionPlanId = orchestrationResult.executionPlanId;

      let finalText = orchestrationResult.finalOutput.trim();
      if (!finalText) {
        finalText = buildEmptyAssistantTurnFallbackText();
      }
      // Divergence guard: only treat the live-streamed deltas as the rendered
      // final text when the terminal step completed AND the streamed concat
      // exactly matches the authoritative `finalText`. If the child recovered,
      // repaired, or returned empty (so the engine's finalOutput diverges), fall
      // back to the synthetic split of `finalText` below — the persisted and
      // rendered text always agree.
      const terminalStepCompleted = orchestrationResult.finalStep?.status === "completed";
      streamedRealFinalDeltas =
        streamedRealFinalDeltas && terminalStepCompleted && streamedFinalText.trim() === finalText;

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
      const waitingOrchestrationStep = orchestrationResult.summary.steps.find((step) => step.status === "running");
      const orchestrationTraceStatus =
        orchestrationResult.summary.status === "running"
          ? (waitingOrchestrationStep?.waitStatus ?? "running")
          : orchestrationResult.summary.status === "failed"
            ? "failed"
            : orchestrationResult.summary.status === "partial"
              ? "partial"
              : "completed";
      const completionPatch: Parameters<Storage["chatTurnTraces"]["patch"]>[1] = {
        assistantMessageId,
        executionPlanId: orchestrationResult.executionPlanId,
        status: orchestrationTraceStatus,
        ...(orchestrationResult.summary.status === "running" ? {} : { finishedAt: new Date().toISOString() }),
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
          modelRouter: prepared.modelRouterDecision,
          ...(input.runVariableEvidence ? { runVariables: input.runVariableEvidence } : {}),
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
      };
      let committedTrace: ChatTurnTraceRecord | undefined;
      assertChatStreamCompletionWritable(host, turnId, controller.signal);
      await host.ingestEvent(
        randomUUID(),
        {
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
        },
        {
          onCommit: () => {
            committedTrace = canonicalWriteFence(() => {
              const trace = patchChatTurnTraceIfStatus(
                chatTurnTraces,
                turnId,
                CHAT_TURN_ACTIVE_STATUSES,
                completionPatch,
              );
              host.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, turnId);
              return trace;
            });
          },
        },
      );
      if (!committedTrace) {
        throw new Error(`Chat turn ${turnId} assistant ingest did not execute its canonical completion commit.`);
      }

      let hydratedTrace: ChatTurnTraceRecord = {
        ...committedTrace,
        toolRuns: orchestrationToolRuns,
      };
      // Skip the synthetic post-hoc split when the real terminal-synthesizer
      // tokens were already streamed live above and matched the authoritative
      // final text (no double emit). Otherwise fall back to splitting finalText.
      if (!streamedRealFinalDeltas) {
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
      canonicalWriteFence(() => undefined);
      const specialistCandidateSuggestions = canonicalWriteFence(() =>
        host.collectSpecialistCandidateSuggestions({
          sessionId,
          mode: prepared.capabilityProfile?.selection.mode ?? resolvePreparedTurnMode(prepared),
          content: prepared.content,
          capabilitySuggestions: capabilityUpgradeSuggestions,
          trace: hydratedTrace,
        }),
      );
      if (capabilityUpgradeSuggestions.length > 0 || specialistCandidateSuggestions.length > 0) {
        hydratedTrace = {
          ...canonicalWriteFence(() =>
            host.storage.chatTurnTraces.patch(turnId, {
              capabilityUpgradeSuggestions: capabilityUpgradeSuggestions.length > 0 ? capabilityUpgradeSuggestions : [],
              specialistCandidateSuggestions:
                specialistCandidateSuggestions.length > 0 ? specialistCandidateSuggestions : [],
            }),
          ),
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
      if (!deferGeneralPostCommit) {
        canonicalWriteFence(() => {
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
          // Direct learned-memory promotion, commitments, and post-turn
          // prewarm are production-dark. Canonical durable post-commit owns
          // governed children and inspectable evidence.
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
        });
      }
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
    let assistantUsage: ChatStreamUsageRecord | undefined;
    let assistantModelUsageEventIds: string[] | undefined;
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
    recordRuntimeDecision(
      host,
      {
        kind: prepared.modelRouterDecision.requiresTools ? "routing_choice" : "direct_answer",
        scope: {
          workspaceId: prepared.workspaceId,
          sessionId,
          turnId,
        },
        selected: prepared.modelRouterDecision.requiresTools
          ? "Use direct tool-capable turn runtime"
          : "Answer directly",
        rationale:
          prepared.modelRouterDecision.orchestration?.reason ??
          "The turn did not enter the governed mode-orchestration workflow.",
        alternatives: [
          {
            label: "Mode orchestration workflow",
            outcome: "not_chosen",
            reasonNotChosen:
              prepared.modelRouterDecision.orchestration?.reason ??
              "Router and preference signals did not require a multi-step workflow.",
          },
        ],
        signals: [
          { source: "routing", key: "mode", value: resolvePreparedTurnMode(prepared), weight: "strong" },
          { source: "model_router", key: "route", value: prepared.modelRouterDecision.route, weight: "strong" },
          { source: "model_router", key: "requires_tools", value: prepared.modelRouterDecision.requiresTools },
          { source: "routing", key: "tool_autonomy", value: prepared.effectiveToolAutonomy },
        ],
        evidenceRefs: [{ refType: "turn", refId: turnId }],
      },
      canonicalWriteFence,
    );
    for (const steerItem of drainedSteers) {
      let steerCommitted = false;
      await host.ingestEvent(
        randomUUID(),
        {
          eventId: randomUUID(),
          route: prepared.route,
          actor: { type: "user", id: "operator" },
          message: {
            role: "user",
            content: steerItem.instruction,
            steered: true,
          },
        },
        {
          onCommit: () =>
            canonicalWriteFence(() => {
              steerCommitted = true;
            }),
        },
      );
      if (!steerCommitted) {
        throw new Error(`Chat turn ${turnId} steer ingest skipped its canonical write fence.`);
      }
    }
    const serverContextUsageAttribution = buildPreparedRoutedContextUsageAttribution(prepared);
    const directStream = input.modelCouncil?.enabled
      ? streamChatModelCouncil(host, prepared, controller.signal, canonicalWriteFence)
      : runDirectTurnStreamWithSubagentFanout(
          host,
          prepared,
          {
            signal: controller.signal,
            operatorId: input.operatorId,
            authActorId: input.authActorId,
            authActorSource: input.authActorSource,
            permissionProfileId: effectivePermissionProfileId,
            localOperatorOverrideId: input.localOperatorOverrideId,
            policyContext: inputPolicyContext,
            fullWebAccess: input.fullWebAccess,
            canonicalWriteFence,
          },
          () => {
            const runnerInput: ChatTurnAgentRunnerInput = {
              sessionId,
              turnId,
              userMessageId: prepared.userEventId,
              ...(prepared.parentDelegationStepId ? { parentDelegationStepId: prepared.parentDelegationStepId } : {}),
              parentTurnId: prepared.parentTurnId,
              branchKind: prepared.branchKind,
              sourceTurnId: prepared.sourceTurnId,
              outputMessageId: assistantMessageId,
              content: prepared.content,
              mode: resolvePreparedTurnMode(prepared),
              providerId:
                prepared.capabilityProfile?.selection.effectiveProviderId ??
                input.providerId ??
                prepared.prefs.providerId,
              model: prepared.capabilityProfile?.selection.effectiveModel ?? input.model ?? prepared.prefs.model,
              webMode:
                prepared.capabilityProfile?.selection.webMode ?? prepared.normalized.webMode ?? prepared.prefs.webMode,
              memoryMode:
                prepared.capabilityProfile?.selection.memory.mode ??
                prepared.normalized.memoryMode ??
                prepared.prefs.memoryMode,
              retrievalMode:
                prepared.capabilityProfile?.selection.memory.retrievalMode ?? prepared.autonomy.retrievalMode,
              thinkingLevel:
                prepared.capabilityProfile?.selection.thinkingLevel ??
                prepared.normalized.thinkingLevel ??
                prepared.prefs.thinkingLevel,
              speedMode:
                prepared.capabilityProfile?.selection.speedMode ??
                prepared.normalized.speedMode ??
                prepared.prefs.speedMode,
              subagentPolicy:
                prepared.capabilityProfile?.selection.subagentPolicy ??
                prepared.normalized.subagentPolicy ??
                prepared.prefs.subagentPolicy,
              normalizationProfile: prepared.normalized.normalizationProfile,
              toolAutonomy: prepared.capabilityProfile?.selection.toolAutonomy ?? prepared.effectiveToolAutonomy,
              routedContextRequested: Boolean(prepared.routedContextSnapshot),
              operatorId: prepared.capabilityProfile
                ? prepared.capabilityProfile.identity.operatorId
                : input.operatorId,
              authActorId: prepared.capabilityProfile
                ? prepared.capabilityProfile.identity.authActorId
                : input.authActorId,
              authActorSource: prepared.capabilityProfile
                ? prepared.capabilityProfile.identity.authActorSource
                : input.authActorSource,
              permissionProfileId:
                prepared.capabilityProfile?.governance.permission.profileId ?? effectivePermissionProfileId,
              policyContext: inputPolicyContext,
              localOperatorOverrideId: prepared.capabilityProfile
                ? prepared.capabilityProfile.governance.permission.localOperatorOverrideId
                : input.localOperatorOverrideId,
              policyRunId: input.policyRunId,
              policyTaskId: input.policyTaskId,
              fullWebAccess: input.fullWebAccess,
              historyMessages: historyWithSteers,
              modelRouter: prepared.modelRouterDecision,
              runVariableEvidence: input.runVariableEvidence,
              signal: controller.signal,
              canonicalWriteFence,
              capabilityProfile: prepared.capabilityProfile,
              ...(prepared.serverOnlyPosture ? { serverOnlyPosture: prepared.serverOnlyPosture } : {}),
              capabilityProfileContent: prepared.capabilityProfileContent,
              compactionDimensionHash: prepared.compactionDimensionHash,
              ...(serverContextUsageAttribution ? { serverContextUsageAttribution } : {}),
            };
            return host.turnRuntime.runStream(runnerInput);
          },
        );
    for await (const chunk of directStream) {
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
        assistantModelUsageEventIds = chunk.modelUsageEventIds;
        yield chunk;
      }
      if (chunk.type === "thinking_delta") {
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
        chunk.type === "tool_activity" ||
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

    assertChatStreamCompletionWritable(host, turnId, controller.signal);

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

    assertChatStreamCompletionWritable(host, turnId, controller.signal);

    if (approvalRequired) {
      const traceWithMeta = canonicalWriteFence(() => {
        const trace = host.storage.chatTurnTraces.patch(turnId, {
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
        host.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, turnId);
        return trace;
      });
      if (!deferGeneralPostCommit) {
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
      }
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
      canonicalWriteFence(() => undefined);
      const approvalTrace =
        capabilityUpgradeSuggestions.length > 0
          ? {
              ...canonicalWriteFence(() =>
                host.storage.chatTurnTraces.patch(turnId, {
                  capabilityUpgradeSuggestions,
                }),
              ),
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
      if (!deferGeneralPostCommit) {
        canonicalWriteFence(() =>
          host.recordCapabilityGapFromTrace({
            sessionId,
            turnId,
            content: prepared.content,
            trace: approvalTrace,
          }),
        );
      }
      yield {
        type: "trace_update",
        sessionId,
        turnId,
        trace: approvalTrace,
      };
      if (!deferGeneralPostCommit) {
        canonicalWriteFence(() =>
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
          }),
        );
      }
      return;
    }

    if (userInputRequired && pendingUserInput) {
      const traceWithMeta = canonicalWriteFence(() => {
        const trace = host.storage.chatTurnTraces.patch(turnId, {
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
        host.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, turnId);
        return trace;
      });
      if (!deferGeneralPostCommit) {
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
      }
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
      if (!deferGeneralPostCommit) {
        canonicalWriteFence(() =>
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
          }),
        );
      }
      return;
    }

    if (finalText.trim()) {
      assertChatStreamCompletionWritable(host, turnId, controller.signal);
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
      assertChatStreamCompletionWritable(host, turnId, controller.signal);
      const completionPatch: Parameters<Storage["chatTurnTraces"]["patch"]>[1] = {
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
      };
      const completionOwnerStatuses = ["running", "completed"] as const;
      let committedTrace: ChatTurnTraceRecord | undefined;
      await host.ingestEvent(
        randomUUID(),
        {
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
          usage:
            assistantUsage || (assistantModelUsageEventIds?.length ?? 0) > 0
              ? {
                  ...assistantUsage,
                  ...(assistantModelUsageEventIds?.length
                    ? {
                        canonicalUsageEventIds: assistantModelUsageEventIds,
                        canonicalUsageOwner: {
                          workspaceId: prepared.workspaceId,
                          sessionId,
                          turnId,
                          ...(input.policyTaskId ? { taskId: input.policyTaskId } : {}),
                        },
                      }
                    : {}),
                }
              : undefined,
        },
        {
          onCommit: () => {
            committedTrace = canonicalWriteFence(() => {
              const trace = patchChatTurnTraceIfStatus(
                chatTurnTraces,
                turnId,
                completionOwnerStatuses,
                completionPatch,
              );
              host.updateActiveLeafOrThrow(sessionId, prepared.parentTurnId, turnId);
              return trace;
            });
          },
        },
      );
      if (!committedTrace) {
        throw new Error(`Chat turn ${turnId} assistant ingest did not execute its canonical completion commit.`);
      }
      let hydratedTrace: ChatTurnTraceRecord = {
        ...committedTrace,
        toolRuns: host.storage.chatToolRuns.listByTurn(turnId),
      };
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
      canonicalWriteFence(() => undefined);
      const specialistCandidateSuggestions = canonicalWriteFence(() =>
        host.collectSpecialistCandidateSuggestions({
          sessionId,
          mode: resolvePreparedTurnMode(prepared),
          content: prepared.content,
          capabilitySuggestions: capabilityUpgradeSuggestions,
          trace: hydratedTrace,
        }),
      );
      if (capabilityUpgradeSuggestions.length > 0 || specialistCandidateSuggestions.length > 0) {
        hydratedTrace = {
          ...canonicalWriteFence(() =>
            host.storage.chatTurnTraces.patch(turnId, {
              capabilityUpgradeSuggestions: capabilityUpgradeSuggestions.length > 0 ? capabilityUpgradeSuggestions : [],
              specialistCandidateSuggestions:
                specialistCandidateSuggestions.length > 0 ? specialistCandidateSuggestions : [],
            }),
          ),
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
      if (!deferGeneralPostCommit) {
        canonicalWriteFence(() =>
          host.recordCapabilityGapFromTrace({
            sessionId,
            turnId,
            content: prepared.content,
            trace: hydratedTrace,
          }),
        );
      }
      yield {
        type: "trace_update",
        sessionId,
        turnId,
        trace: hydratedTrace,
      };
      if (!deferGeneralPostCommit) {
        canonicalWriteFence(() => {
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
          // Direct learned-memory promotion, commitments, and post-turn
          // prewarm are production-dark. Canonical durable post-commit owns
          // governed children and inspectable evidence.
        });
      }
    }

    const completedTrace = canonicalWriteFence(() => {
      const trace = host.storage.chatTurnTraces.get(turnId);
      const toolRuns = host.storage.chatToolRuns.listByTurn(turnId);
      if (!deferGeneralPostCommit) {
        enqueueAgentEndHook(host, {
          workspaceId: prepared.workspaceId,
          sessionId,
          turnId,
          status: trace.status,
          toolRunCount: toolRuns.length,
          stream: true,
          repaired: Boolean(trace.completion?.repaired),
          runId: trace.durable?.runId,
          approvalId: toolRuns.find((toolRun) => toolRun.approvalId)?.approvalId,
          providerId: trace.routing?.effectiveProviderId ?? trace.routing?.primaryProviderId,
          model: trace.routing?.effectiveModel ?? trace.model,
        });
      }
      return trace;
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
    if (isAuthoritativeModelUsageAccountingError(error)) {
      throw error;
    }
    const durableControlReason = readDurableControlReason(controller.signal, error);
    if (durableControlReason) {
      throw durableControlReason;
    }
    const exactSystemHeartbeat = Boolean(
      prepared.serverOnlyPosture?.kind === "system_heartbeat" &&
      prepared.serverOnlyPosture.actorId === "system-heartbeat" &&
      prepared.serverOnlyPosture.operation === "chat_system_heartbeat" &&
      prepared.serverOnlyPosture.durableRunId.trim().length > 0,
    );
    if (controller.signal.aborted || (!exactSystemHeartbeat && isChatTurnCancelledError(error))) {
      const trace = host.markChatTurnCancelled(sessionId, turnId);
      yield {
        type: "trace_update",
        sessionId,
        turnId,
        trace,
      };
      if (!deferGeneralPostCommit) {
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
      }
      return;
    }
    throw error;
  } finally {
    externalAbortListener?.();
    host.steerService?.unregisterActiveTurn?.({ sessionId, turnId });
    host.endActiveChatTurnExecution(turnId, controller);
  }
}

function readDurableControlReason(signal: AbortSignal, error: unknown): Error | undefined {
  const candidate = signal.aborted ? signal.reason : error;
  return isDurableControlError(candidate) ? candidate : undefined;
}

function assertChatStreamCompletionWritable(
  host: Pick<ChatTurnStreamHost, "storage">,
  turnId: string,
  signal: AbortSignal,
): void {
  if (signal.aborted) {
    throw new ChatTurnCancelledError(turnId);
  }
  let status: ChatTurnTraceRecord["status"];
  try {
    status = host.storage.chatTurnTraces.get(turnId).status;
  } catch (error) {
    if (error instanceof NotFoundError) {
      // The stream runtime may not have persisted its initial trace yet. The
      // abort signal remains the completion fence in that compatibility case.
      return;
    }
    throw error;
  }
  if (status === "cancelled") {
    throw new ChatTurnCancelledError(turnId);
  }
  if (isChatTurnTerminalStatus(status) && status !== "completed") {
    throw new Error(`Chat turn ${turnId} completion lost lifecycle ownership to ${status}.`);
  }
}

function createOrRefreshRunningChatTurnTrace(
  host: ChatTurnStreamHost,
  input: Parameters<Storage["chatTurnTraces"]["create"]>[0],
): ChatTurnTraceRecord {
  try {
    const existing = host.storage.chatTurnTraces.get(input.turnId);
    if (existing.status === "cancelled") {
      throw new ChatTurnCancelledError(input.turnId);
    }
    return host.storage.chatTurnTraces.patch(input.turnId, {
      parentTurnId: input.parentTurnId,
      branchKind: input.branchKind,
      sourceTurnId: input.sourceTurnId,
      assistantMessageId: input.assistantMessageId,
      status: "running",
      model: input.model,
      effectiveToolAutonomy: input.effectiveToolAutonomy,
      routing: input.routing,
    });
  } catch (error) {
    if (error instanceof NotFoundError) {
      return host.storage.chatTurnTraces.create(input);
    }
    throw error;
  }
}

function bindExternalAbortToController(
  externalSignal: AbortSignal | undefined,
  controller: AbortController,
): (() => void) | undefined {
  if (!externalSignal) {
    return undefined;
  }
  const abortController = (): void => {
    controller.abort(externalSignal.reason);
  };
  if (externalSignal.aborted) {
    abortController();
    return undefined;
  }
  externalSignal.addEventListener("abort", abortController, { once: true });
  return () => {
    externalSignal.removeEventListener("abort", abortController);
  };
}
