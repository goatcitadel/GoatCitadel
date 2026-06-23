/* eslint-disable max-lines -- Chat delegation centralizes run persistence, child sessions, dependency ordering, and synthesis truth. */
import { randomUUID } from "node:crypto";
import type {
  AgenticDiagnosticSignal,
  AgenticSubagentMetadata,
  AgenticTaskContext,
  ChatCitationRecord,
  ChatDelegateAcceptRequest,
  ChatDelegateRequest,
  ChatDelegateResponse,
  ChatDelegateSuggestRequest,
  ChatDelegateSuggestResponse,
  ChatDelegationRunRecord,
  ChatDelegationStepRecord,
  ChatDelegationSuggestionRecord,
  ChatMode,
  ChatSendMessageRequest,
  ChatSendMessageResponse,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatTurnTraceRecord,
  SubagentSessionStatus,
  TaskSubagentSession,
  TaskStatus,
  ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import { chatModeRequiresProjectBinding, ValidationError } from "@goatcitadel/contracts";
import { buildDelegatedChatSendRequest } from "./delegated-chat-request.js";
import type { ChildTimeoutLateSettleEvent } from "./subagent-budget-enforcer.js";
import {
  buildDelegationFailureGuidance,
  buildIncompleteDelegatedTraceFailureGuidance,
  DEFAULT_DELEGATION_ROLES,
  detectDelegationRoles,
  isIncompleteDelegatedTraceFailure,
  toTitleCase,
  truncateSummaryLine,
} from "./chat-turn-helpers.js";
import {
  computeChildDepth,
  enforceMaxDepth,
  runWithChildTimeout,
  SubagentBudgetError,
} from "./subagent-budget-enforcer.js";

const DEFAULT_SUBAGENT_DEFAULTS = {
  childTimeoutSeconds: 600,
  coworkChildTimeoutSeconds: null,
  maxDepth: 4,
} as const;

interface ChatDelegationProgressStatusEvent {
  runId: string;
  taskId: string;
  message: string;
}

export interface ChatDelegationProgressCallbacks {
  onStatus?: (event: ChatDelegationProgressStatusEvent) => Promise<void> | void;
  onStep?: (step: ChatDelegationStepRecord) => Promise<void> | void;
}

export interface ChatDelegationRunOptions {
  abortSignal?: AbortSignal;
}

interface NormalizedDelegationStep {
  stepId: string;
  index: number;
  role: string;
  parallelizable: boolean;
  dependsOnStepIds: string[];
}

interface DelegationStepExecutionResult {
  step: ChatDelegationStepRecord;
  output?: string;
  citations: ChatCitationRecord[];
  trace?: ChatTurnTraceRecord["routing"];
  completed: boolean;
}

export interface ChatDelegationServiceHost {
  storage: {
    chatSessionPrefs: {
      ensure(sessionId: string): ChatSessionPrefsRecord;
    };
    chatSessionMeta: {
      ensure(sessionId: string): { workspaceId?: string };
    };
    chatSessionProjects: {
      get(sessionId: string): { projectId: string } | undefined;
    };
    chatDelegationRuns: {
      create(input: {
        runId: string;
        parentRunId?: string;
        sessionId: string;
        taskId: string;
        objective: string;
        roles: string[];
        mode: "sequential" | "parallel";
        providerId?: string;
        model?: string;
        status: ChatDelegationRunRecord["status"];
        citations: ChatCitationRecord[];
      }): ChatDelegationRunRecord;
      patch(runId: string, patch: Partial<ChatDelegationRunRecord>): ChatDelegationRunRecord;
    };
    chatDelegationSteps: {
      create(
        input: Partial<ChatDelegationStepRecord> & {
          stepId: string;
          runId: string;
          role: string;
          index: number;
          status: ChatDelegationStepRecord["status"];
          startedAt: string;
        },
      ): ChatDelegationStepRecord;
      patch(stepId: string, patch: Partial<ChatDelegationStepRecord>): ChatDelegationStepRecord;
      listByRun(runId: string): ChatDelegationStepRecord[];
    };
    taskSubagents: {
      findByAgentSessionId(agentSessionId: string): TaskSubagentSession | undefined;
    };
  };
  gatewaySql: {
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
    };
  };
  taskLifecycleService: {
    createTask(input: {
      workspaceId: string;
      title: string;
      description: string;
      status: "in_progress";
      priority: "normal";
      createdBy: string;
      agenticContext?: AgenticTaskContext;
    }): { taskId: string };
    appendTaskActivity(
      taskId: string,
      input: {
        activityType: "comment" | "diagnostic" | "handoff";
        message: string;
        agentId?: string;
        metadata?: Record<string, unknown>;
      },
    ): unknown;
    appendTaskDeliverable(
      taskId: string,
      input: { deliverableType: "artifact"; title: string; description: string },
    ): unknown;
    updateTask(taskId: string, patch: { status: TaskStatus }): unknown;
    updateTaskAgenticContext(taskId: string, patch: Partial<AgenticTaskContext>): unknown;
    registerTaskSubagent(
      taskId: string,
      input: { agentSessionId: string; agentName: string; metadata?: AgenticSubagentMetadata },
    ): unknown;
    updateTaskSubagent(
      agentSessionId: string,
      patch: { status: SubagentSessionStatus; endedAt?: string; metadata?: AgenticSubagentMetadata },
    ): unknown;
  };
  getSession(sessionId: string): unknown;
  listChatMessages(sessionId: string, limit: number): Promise<Array<{ role: string; content: string }>>;
  normalizeWorkspaceId(workspaceId?: string): string;
  ensureChatSessionModelDefaults(sessionId: string, prefs: ChatSessionPrefsRecord): ChatSessionPrefsRecord;
  createChatSession(input: {
    workspaceId?: string;
    title?: string;
    projectId?: string;
    mode?: ChatMode;
  }): ChatSessionRecord;
  inheritDelegatedSessionToolGrants(parentSessionId: string, childSessionId: string): void;
  updateChatSessionPrefs(sessionId: string, patch: Partial<ChatSessionPrefsRecord>): ChatSessionPrefsRecord;
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
  agentSendChatMessage(
    sessionId: string,
    input: ChatSendMessageRequest,
    options?: { abortSignal?: AbortSignal },
  ): Promise<ChatSendMessageResponse>;
  extractAndPersistLearnedMemory(
    sessionId: string,
    content: string,
    source: { role: "user" | "assistant"; sourceRef: string },
  ): void;
  scheduleChatMemoryContextPrewarm(input: { sessionId: string; prompt: string; relationScope: "peer" }): void;
  /**
   * Runtime budgets enforced on every child delegation step. When omitted the
   * service falls back to `{ childTimeoutSeconds: 600, maxDepth: 4 }`.
   */
  subagentDefaults?: {
    childTimeoutSeconds: number;
    coworkChildTimeoutSeconds?: number | null;
    maxDepth: number;
  };
}

export class ChatDelegationService {
  public constructor(private readonly deps: ChatDelegationServiceHost) {}

  public async runChatDelegation(
    sessionId: string,
    input: ChatDelegateRequest,
    callbacks?: ChatDelegationProgressCallbacks,
    options: ChatDelegationRunOptions = {},
  ): Promise<ChatDelegateResponse> {
    const deps = this.deps;
    const parentSession = deps.getSession(sessionId) as { origin?: string } | undefined;
    // Prompt-pack sessions are headless evals: children must inherit the
    // eval-integrity profile or they could park on approvals forever.
    const inheritedNormalizationProfile =
      parentSession?.origin === "prompt_pack" ? ("prompt_pack_harness" as const) : undefined;
    const objective = input.objective.trim();
    if (!objective) {
      throw new Error("objective is required");
    }
    const roles = normalizeDelegationRoles(input.roles);
    if (roles.length === 0) {
      throw new Error("at least one role is required");
    }
    const requestedMode = input.mode ?? "sequential";
    const mode = requestedMode;
    const delegationSteps = normalizeDelegationSteps({
      roles,
      mode,
      steps: input.steps,
    });
    const stages = buildDelegationStages(delegationSteps);
    const prefs = deps.ensureChatSessionModelDefaults(sessionId, deps.storage.chatSessionPrefs.ensure(sessionId));
    const executionMode: ChatMode = input.surfaceMode ?? prefs.mode;
    const providerId = input.providerId ?? prefs.providerId;
    const model = input.model ?? prefs.model;
    const sessionWorkspaceId = deps.normalizeWorkspaceId(deps.storage.chatSessionMeta.ensure(sessionId).workspaceId);
    const parentProjectId = deps.storage.chatSessionProjects.get(sessionId)?.projectId;
    if (chatModeRequiresProjectBinding(executionMode) && !parentProjectId) {
      throw new ValidationError({ message: "Code delegation requires a project-bound parent session." });
    }
    throwIfChatDelegationAborted(options.abortSignal);

    const runId = randomUUID();
    const maxSpawn = mode === "parallel" ? 4 : 1;
    const childRunIds = delegationSteps.map((step) => `${runId}:${step.stepId}`);
    const task = deps.taskLifecycleService.createTask({
      workspaceId: sessionWorkspaceId,
      title: `Delegation: ${objective.slice(0, 120)}`,
      description: objective,
      status: "in_progress",
      priority: "normal",
      createdBy: "chat",
      agenticContext: {
        boardId: `cowork:${sessionWorkspaceId}`,
        runId,
        parentRunId: input.policyRunId,
        childRunIds,
        parentSessionId: sessionId,
        surface: executionMode,
        status: "running",
        contextMode: "fork",
        workspaceScope: {
          kind: executionMode === "code" ? "worktree" : "session",
        },
        providerId,
        model,
        maxSpawn,
        activeChildCount: 0,
        deliveryState: {
          status: "not_required",
          attempts: 0,
        },
      },
    });

    deps.storage.chatDelegationRuns.create({
      runId,
      parentRunId: input.policyRunId,
      sessionId,
      taskId: task.taskId,
      objective,
      roles: dedupeStrings(delegationSteps.map((step) => step.role)),
      mode,
      providerId,
      model,
      status: "running",
      citations: [],
    });
    await callbacks?.onStatus?.({
      runId,
      taskId: task.taskId,
      message: "Delegation started.",
    });
    deps.taskLifecycleService.appendTaskActivity(task.taskId, {
      activityType: "comment",
      message: `Delegation started (${delegationSteps.map((step) => step.role).join(mode === "parallel" ? " | " : " -> ")})`,
      metadata: { runId, sessionId, mode, requestedMode, surfaceMode: executionMode },
    });

    const citations: ChatCitationRecord[] = [];
    let trace: ChatTurnTraceRecord["routing"] | undefined;
    const completedOutputs = new Map<string, { role: string; output: string }>();
    const stepResults = new Map<string, DelegationStepExecutionResult>();
    const subagentDefaults = deps.subagentDefaults ?? DEFAULT_SUBAGENT_DEFAULTS;
    const childTimeoutSeconds =
      executionMode === "cowork"
        ? (subagentDefaults.coworkChildTimeoutSeconds ?? 0)
        : subagentDefaults.childTimeoutSeconds;
    const inferredParentDepth = resolveInferredParentDepth(deps, sessionId);
    const parentDepth = input.parentSubagentDepth ?? inferredParentDepth;
    const childDepth = computeChildDepth(parentDepth);
    let inheritedPolicyContext: ToolPolicyActorContext | undefined;
    try {
      inheritedPolicyContext = deps.resolveToolPolicyContext?.({
        operatorId: input.operatorId,
        authActorId: input.authActorId,
        authActorSource: input.authActorSource,
        workspaceId: sessionWorkspaceId,
        sessionId,
        taskId: task.taskId,
        runId,
        surface: executionMode,
        permissionProfileId: input.permissionProfileId,
        localOperatorOverrideId: input.localOperatorOverrideId,
      });
    } catch (error) {
      const finishedAt = new Date().toISOString();
      const message = formatUnknownError(error);
      deps.storage.chatDelegationRuns.patch(runId, {
        status: "failed",
        stitchedOutput: `FAILED: ${message}`,
        citations: [],
        finishedAt,
      });
      deps.taskLifecycleService.appendTaskActivity(task.taskId, {
        activityType: "diagnostic",
        message: `Delegation failed before dispatch: ${message}`,
        metadata: { runId, sessionId, surfaceMode: executionMode, error: message },
      });
      deps.taskLifecycleService.updateTask(task.taskId, { status: "blocked" });
      deps.taskLifecycleService.updateTaskAgenticContext(task.taskId, {
        status: "failed",
        activeChildCount: 0,
        failureClass: "other",
      });
      await callbacks?.onStatus?.({
        runId,
        taskId: task.taskId,
        message: "Delegation failed before dispatch.",
      });
      throw error;
    }

    const executeDelegationStep = async (step: NormalizedDelegationStep): Promise<DelegationStepExecutionResult> => {
      const startedAt = new Date().toISOString();
      const runningStep = deps.storage.chatDelegationSteps.create({
        stepId: step.stepId,
        runId,
        role: step.role,
        label: step.role,
        index: step.index,
        status: "running",
        startedAt,
      });
      await callbacks?.onStep?.(runningStep);

      const childRunId = `${runId}:${step.stepId}`;
      const childMetadataBase: AgenticSubagentMetadata = {
        runId: childRunId,
        parentRunId: runId,
        profileId: step.role,
        contextMode: "isolated",
        index: step.index,
        depth: childDepth,
        dependsOnStepIds: step.dependsOnStepIds,
        heartbeatAt: startedAt,
      };
      const dependencyContext = step.dependsOnStepIds
        .map((dependencyStepId) => completedOutputs.get(dependencyStepId))
        .filter((item): item is { role: string; output: string } => Boolean(item));
      let registeredAgentSessionId: string | undefined;
      let childSessionId: string | undefined;
      let subagentDiagnostics: AgenticDiagnosticSignal[] = [];

      try {
        throwIfChatDelegationAborted(options.abortSignal);
        enforceMaxDepth({ depth: childDepth, maxDepth: subagentDefaults.maxDepth });
        const childSession = deps.createChatSession({
          workspaceId: sessionWorkspaceId,
          title: `Delegate · ${toTitleCase(step.role)}`,
          projectId: parentProjectId,
          mode: executionMode,
        });
        const agentSessionId = childSession.sessionId;
        registeredAgentSessionId = agentSessionId;
        childSessionId = agentSessionId;
        deps.inheritDelegatedSessionToolGrants(sessionId, agentSessionId);
        deps.updateChatSessionPrefs(agentSessionId, {
          mode: executionMode,
          planningMode: "off",
          providerId,
          model,
          webMode: prefs.webMode,
          memoryMode: prefs.memoryMode,
          thinkingLevel: prefs.thinkingLevel,
          speedMode: prefs.speedMode,
          subagentPolicy: "off",
          toolAutonomy: prefs.toolAutonomy,
          orchestrationEnabled: false,
          orchestrationIntensity: "minimal",
          orchestrationVisibility: "explicit",
          orchestrationProviderPreference: prefs.orchestrationProviderPreference,
          orchestrationReviewDepth: prefs.orchestrationReviewDepth,
          orchestrationParallelism: "sequential",
          codeAutoApply: prefs.codeAutoApply,
          proactiveMode: "off",
          retrievalMode: prefs.retrievalMode,
          reflectionMode: "off",
        });
        deps.taskLifecycleService.registerTaskSubagent(task.taskId, {
          agentSessionId,
          agentName: step.role,
          metadata: childMetadataBase,
        });
        const taskFirstMessage = buildSubagentTaskFirstMessage({
          role: step.role,
          objective,
          mode,
          parentDelegationStepId: step.stepId,
          sharedContext: dependencyContext,
        });
        const response = await runWithChildTimeout<ChatSendMessageResponse>({
          timeoutSeconds: childTimeoutSeconds,
          onLateSettle: (event) => {
            const diagnostic = buildLateChildTimeoutDiagnostic({ event, role: step.role, stepId: step.stepId });
            subagentDiagnostics = [...subagentDiagnostics, diagnostic];
            deps.taskLifecycleService.updateTaskSubagent(agentSessionId, {
              status: "failed",
              endedAt: diagnostic.createdAt,
              metadata: {
                ...childMetadataBase,
                heartbeatAt: diagnostic.createdAt,
                failureClass: "timeout",
                diagnostics: subagentDiagnostics,
              },
            });
            deps.taskLifecycleService.appendTaskActivity(task.taskId, {
              activityType: "diagnostic",
              agentId: step.role,
              message: diagnostic.summary,
              metadata: buildLateChildTimeoutActivityMetadata({
                event,
                runId,
                childRunId,
                stepId: step.stepId,
                childSessionId: agentSessionId,
                diagnostic,
              }),
            });
          },
          run: async (signal) =>
            deps.agentSendChatMessage(
              agentSessionId,
              buildDelegatedChatSendRequest({
                content: taskFirstMessage,
                parentDelegationStepId: step.stepId,
                providerId,
                model,
                mode: executionMode,
                webMode: prefs.webMode,
                memoryMode: prefs.memoryMode,
                thinkingLevel: prefs.thinkingLevel,
                speedMode: prefs.speedMode,
                subagentPolicy: "off",
                retrievalMode: prefs.retrievalMode ?? "standard",
                toolAutonomy: prefs.toolAutonomy,
                normalizationProfile: inheritedNormalizationProfile,
                operatorId: input.operatorId,
                authActorId: input.authActorId,
                authActorSource: input.authActorSource,
                permissionProfileId: inheritedPolicyContext?.permissionProfileId,
                localOperatorOverrideId: inheritedPolicyContext?.localOperatorOverrideId,
                policyRunId: runId,
                policyTaskId: task.taskId,
                fullWebAccess: input.fullWebAccess,
              }),
              { abortSignal: composeChatDelegationAbortSignal(signal, options.abortSignal) },
            ),
        });
        const traceStatus = response.trace?.status;
        const waitingForApproval = traceStatus === "waiting_for_approval";
        const waitingForUserInput = traceStatus === "waiting_for_user_input";
        const stillActive = traceStatus === "waiting_for_tool";
        const waiting = waitingForApproval || waitingForUserInput || stillActive;
        const traceFailure = response.trace?.failure;
        const degradedFailure = !waiting && isIncompleteDelegatedTraceFailure(traceFailure);
        const failed = traceStatus === "failed" || degradedFailure;
        const cancelled = traceStatus === "cancelled";
        const incomplete = failed || cancelled;
        const stepStatus: ChatDelegationStepRecord["status"] = waiting
          ? "running"
          : cancelled
            ? "cancelled"
            : failed
              ? "failed"
              : "completed";
        const output =
          response.assistantMessage?.content?.trim() ||
          response.trace?.failure?.message?.trim() ||
          (waitingForApproval
            ? response.trace?.pendingApprovalSummary?.reason?.trim() || "Delegate is waiting for approval."
            : waitingForUserInput
              ? response.trace?.pendingUserInput?.question?.trim() || "Delegate is waiting for user input."
              : stillActive
                ? "Delegate is still waiting on a tool result."
                : "(delegate returned no output)");
        const observedAt = new Date().toISOString();
        const completedStep = deps.storage.chatDelegationSteps.patch(step.stepId, {
          status: stepStatus,
          providerId: response.trace?.routing?.effectiveProviderId ?? providerId,
          model: response.trace?.model ?? model,
          label: step.role,
          summary: truncateSummaryLine(output, 180),
          output,
          error: incomplete ? (response.trace?.failure?.message ?? output) : undefined,
          failureGuidance: incomplete
            ? buildIncompleteDelegatedTraceFailureGuidance(traceFailure, output, step.role)
            : undefined,
          durableRunId: response.trace?.durable?.runId,
          childSessionId: agentSessionId,
          childTurnId: response.turnId,
          citations: response.citations ?? [],
          ...(waiting
            ? {}
            : {
                finishedAt: observedAt,
                durationMs: Math.max(0, Date.parse(observedAt) - Date.parse(startedAt)),
              }),
        });
        await callbacks?.onStep?.(completedStep);
        const handoffEvidence =
          !incomplete && !waiting
            ? {
                summary: output.slice(0, 1000),
                artifactRefs: [`delegation-step:${step.stepId}`],
                sourceStepId: step.stepId,
                createdAt: observedAt,
              }
            : undefined;
        const subagentStatus: SubagentSessionStatus = waiting
          ? waitingForApproval || waitingForUserInput
            ? "paused"
            : "active"
          : incomplete
            ? "failed"
            : "completed";
        deps.taskLifecycleService.updateTaskSubagent(agentSessionId, {
          status: subagentStatus,
          ...(waiting ? {} : { endedAt: observedAt }),
          metadata: {
            ...childMetadataBase,
            heartbeatAt: observedAt,
            failureClass: incomplete
              ? traceFailure?.failureClass === "tool_run_budget_exceeded" ||
                traceFailure?.failureClass === "tool_loop_guard" ||
                traceFailure?.failureClass === "global_circuit_breaker"
                ? "repeated_tool_loop"
                : "missing_handoff"
              : undefined,
            handoffEvidence,
          },
        });
        deps.taskLifecycleService.appendTaskActivity(task.taskId, {
          activityType: incomplete ? "diagnostic" : waiting ? "comment" : "handoff",
          agentId: step.role,
          message: incomplete
            ? `${step.role} ${cancelled ? "cancelled" : "failed"} delegation step ${step.index + 1}/${delegationSteps.length}.`
            : waiting
              ? `${step.role} is waiting on delegation step ${step.index + 1}/${delegationSteps.length}.`
              : `${step.role} completed delegation step ${step.index + 1}/${delegationSteps.length}.`,
          metadata: {
            runId,
            childRunId,
            stepId: step.stepId,
            childSessionId: agentSessionId,
            childTurnId: response.turnId,
            durableRunId: response.trace?.durable?.runId,
            waitStatus: waiting ? traceStatus : undefined,
            handoffEvidence,
          },
        });
        if (!incomplete && !waiting) {
          deps.taskLifecycleService.appendTaskDeliverable(task.taskId, {
            deliverableType: "artifact",
            title: `${toTitleCase(step.role)} step`,
            description: output.slice(0, 6000),
          });
          completedOutputs.set(step.stepId, {
            role: step.role,
            output: output.slice(0, 4000),
          });
        }

        const completionRouting = response.routing ?? response.trace?.routing;
        if (completionRouting) {
          trace = {
            ...(trace ?? {}),
            ...completionRouting,
          };
        }
        for (const citation of response.citations ?? []) {
          citations.push(citation);
        }

        return {
          step: completedStep,
          output,
          citations: response.citations ?? [],
          trace: completionRouting,
          completed: !incomplete && !waiting,
        };
      } catch (error) {
        const finishedAt = new Date().toISOString();
        const message = formatUnknownError(error);
        const aborted = isChatDelegationAbortError(error, options.abortSignal);
        const isBudgetError = error instanceof SubagentBudgetError;
        const budgetCode = isBudgetError ? error.code : undefined;
        const failedStep = deps.storage.chatDelegationSteps.patch(step.stepId, {
          status: aborted ? "cancelled" : "failed",
          label: step.role,
          error: message,
          summary: aborted
            ? "Child cancelled."
            : isBudgetError
              ? budgetCode === "timeout_exceeded"
                ? "Child timed out."
                : "Maximum delegation depth exceeded."
              : undefined,
          failureGuidance: buildDelegationFailureGuidance(message, step.role),
          ...(childSessionId ? { childSessionId } : {}),
          finishedAt,
          durationMs: Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt)),
        });
        await callbacks?.onStep?.(failedStep);
        const budgetDiagnostic: AgenticDiagnosticSignal | undefined = isBudgetError
          ? {
              signalId: randomUUID(),
              code: budgetCode as "timeout_exceeded" | "max_depth_exceeded",
              severity: "critical" as const,
              title:
                budgetCode === "timeout_exceeded" ? "Subagent child timed out" : "Subagent maxDepth budget exhausted",
              summary: message,
              createdAt: finishedAt,
            }
          : undefined;
        if (budgetDiagnostic) {
          subagentDiagnostics = [...subagentDiagnostics, budgetDiagnostic];
        }
        if (registeredAgentSessionId) {
          deps.taskLifecycleService.updateTaskSubagent(registeredAgentSessionId, {
            status: aborted ? "killed" : "failed",
            endedAt: finishedAt,
            metadata: {
              ...childMetadataBase,
              heartbeatAt: finishedAt,
              failureClass: aborted
                ? "other"
                : isBudgetError
                  ? budgetCode === "timeout_exceeded"
                    ? "timeout"
                    : "spawn_failure"
                  : "crash",
              diagnostics: subagentDiagnostics.length > 0 ? subagentDiagnostics : undefined,
            },
          });
        }
        deps.taskLifecycleService.appendTaskActivity(task.taskId, {
          activityType: "diagnostic",
          agentId: step.role,
          message: `${step.role} ${aborted ? "cancelled" : "failed"} delegation step ${step.index + 1}/${delegationSteps.length}: ${message}`,
          metadata: {
            runId,
            childRunId,
            stepId: step.stepId,
            ...(childSessionId ? { childSessionId } : {}),
            error: message,
            ...(aborted ? { cancellation: "abort_signal" } : {}),
            ...(isBudgetError ? { diagnosticCode: budgetCode } : {}),
          },
        });
        return {
          step: failedStep,
          output: message,
          citations: [],
          completed: false,
        };
      }
    };

    for (const stage of stages) {
      const runnableSteps: NormalizedDelegationStep[] = [];
      for (const step of stage) {
        const unresolvedDependencies = step.dependsOnStepIds.reduce<ChatDelegationStepRecord[]>(
          (out, dependencyStepId) => {
            const dependency = stepResults.get(dependencyStepId)?.step;
            if (dependency && dependency.status !== "completed") {
              out.push(dependency);
            }
            return out;
          },
          [],
        );
        const waitingDependencies = unresolvedDependencies.filter(
          (dependency) => dependency.status === "running" || dependency.status === "pending",
        );
        const failedDependencies = unresolvedDependencies.filter(
          (dependency) =>
            dependency.status === "failed" || dependency.status === "skipped" || dependency.status === "cancelled",
        );
        if (waitingDependencies.length > 0) {
          continue;
        }
        if (failedDependencies.length === 0) {
          runnableSteps.push(step);
          continue;
        }
        const failedDependencyRoles = failedDependencies.map((dependency) => dependency?.role ?? "unknown");
        const startedAt = new Date().toISOString();
        const skippedStep = deps.storage.chatDelegationSteps.create({
          stepId: step.stepId,
          runId,
          role: step.role,
          label: step.role,
          index: step.index,
          status: "skipped",
          error: `Skipped because dependency did not complete: ${failedDependencyRoles.join(", ")}`,
          failureGuidance: buildDelegationFailureGuidance(
            `Blocked by incomplete dependency from ${failedDependencyRoles.join(", ")}`,
            step.role,
          ),
          startedAt,
          finishedAt: startedAt,
          durationMs: 0,
        });
        await callbacks?.onStep?.(skippedStep);
        deps.taskLifecycleService.appendTaskActivity(task.taskId, {
          activityType: "comment",
          agentId: step.role,
          message: `${step.role} skipped delegation step ${step.index + 1}/${delegationSteps.length} due to incomplete dependency.`,
          metadata: {
            runId,
            stepId: step.stepId,
            failedDependencyStepIds: failedDependencies.map((dependency) => dependency.stepId),
          },
        });
        stepResults.set(step.stepId, {
          step: skippedStep,
          citations: [],
          completed: false,
        });
      }

      await mapWithConcurrency(runnableSteps, 4, async (step) => {
        const result = await executeDelegationStep(step);
        stepResults.set(step.stepId, result);
        return result;
      });
    }

    const finishedAt = new Date().toISOString();
    const persistedSteps = deps.storage.chatDelegationSteps.listByRun(runId);
    const stitchedSections = persistedSteps.map((step) => {
      const body =
        step.status === "completed"
          ? (step.output ?? "(delegate returned no output)")
          : step.status === "running" || step.status === "pending"
            ? `WAITING: ${step.output ?? "Delegate is still running."}`
            : step.status === "cancelled"
              ? `CANCELLED: ${step.error ?? step.output ?? "Delegate was cancelled."}`
              : step.status === "skipped"
                ? `SKIPPED: ${step.error ?? "Dependency did not complete."}`
                : [
                    `FAILED: ${step.error ?? "Delegate failed without an error message."}`,
                    step.output?.trim() && step.output.trim() !== step.error?.trim()
                      ? `Partial output:\n${step.output.trim()}`
                      : undefined,
                  ]
                    .filter(Boolean)
                    .join("\n\n");
      return `### ${toTitleCase(step.role)}\n${body}`;
    });
    const stitchedOutput = stitchedSections.join("\n\n").trim();
    const completedSteps = persistedSteps.filter((step) => step.status === "completed").length;
    const failedStepsWithPartialOutput = persistedSteps.filter(
      (step) => step.status === "failed" && Boolean(step.output?.trim()),
    ).length;
    const activeSteps = persistedSteps.filter((step) => step.status === "running" || step.status === "pending").length;
    const terminalSteps = persistedSteps.filter(
      (step) =>
        step.status === "completed" ||
        step.status === "failed" ||
        step.status === "skipped" ||
        step.status === "cancelled",
    ).length;
    const status: ChatDelegationRunRecord["status"] =
      activeSteps > 0
        ? "running"
        : terminalSteps === persistedSteps.length && completedSteps === persistedSteps.length
          ? "completed"
          : completedSteps > 0 || failedStepsWithPartialOutput > 0
            ? "partial"
            : "failed";
    deps.storage.chatDelegationRuns.patch(runId, {
      status,
      stitchedOutput,
      citations,
      trace,
      ...(status === "running" ? {} : { finishedAt }),
    });
    deps.taskLifecycleService.appendTaskActivity(task.taskId, {
      activityType: "comment",
      message: `Delegation ${status}.`,
      metadata: {
        runId,
        completedSteps,
        failedSteps: persistedSteps.filter((step) => step.status === "failed").length,
        skippedSteps: persistedSteps.filter((step) => step.status === "skipped").length,
        cancelledSteps: persistedSteps.filter((step) => step.status === "cancelled").length,
        steps: delegationSteps.length,
      },
    });
    deps.taskLifecycleService.updateTask(task.taskId, {
      status:
        status === "running" ? "in_progress" : completedSteps > 0 && status === "completed" ? "review" : "blocked",
    });
    deps.taskLifecycleService.updateTaskAgenticContext(task.taskId, {
      status: status === "running" ? "running" : status === "completed" ? "completed" : "failed",
      activeChildCount: activeSteps,
      failureClass: status === "running" || status === "completed" ? undefined : "missing_handoff",
      handoffEvidence:
        status !== "running" && stitchedOutput.trim()
          ? [
              {
                summary: stitchedOutput.slice(0, 1000),
                artifactRefs: persistedSteps
                  .filter((step) => step.status === "completed")
                  .map((step) => `delegation-step:${step.stepId}`),
                createdAt: finishedAt,
              },
            ]
          : undefined,
    });

    deps.extractAndPersistLearnedMemory(sessionId, objective, {
      role: "user",
      sourceRef: runId,
    });
    if (status === "completed" && stitchedOutput.trim()) {
      deps.extractAndPersistLearnedMemory(sessionId, stitchedOutput, {
        role: "assistant",
        sourceRef: runId,
      });
      deps.scheduleChatMemoryContextPrewarm({
        sessionId,
        prompt: stitchedOutput,
        relationScope: "peer",
      });
    }

    return {
      runId,
      taskId: task.taskId,
      status,
      steps: persistedSteps,
      stitchedOutput,
      citations,
      trace,
    };
  }

  public async *runChatDelegationStream(
    sessionId: string,
    input: ChatDelegateRequest,
    options: ChatDelegationRunOptions = {},
  ): AsyncGenerator<{
    type: "status" | "step" | "done" | "error";
    runId?: string;
    taskId?: string;
    message?: string;
    step?: ChatDelegationStepRecord;
    result?: ChatDelegateResponse;
    error?: string;
  }> {
    const queue: Array<{
      type: "status" | "step" | "done";
      runId?: string;
      taskId?: string;
      message?: string;
      step?: ChatDelegationStepRecord;
      result?: ChatDelegateResponse;
    }> = [];
    let wake: (() => void) | null = null;
    let finished = false;
    let runError: unknown = null;
    const push = (chunk: {
      type: "status" | "step" | "done";
      runId?: string;
      taskId?: string;
      message?: string;
      step?: ChatDelegationStepRecord;
      result?: ChatDelegateResponse;
    }) => {
      queue.push(chunk);
      const notify = wake;
      wake = null;
      notify?.();
    };

    void this.runChatDelegation(
      sessionId,
      input,
      {
        onStatus: async (event) => {
          push({
            type: "status",
            runId: event.runId,
            taskId: event.taskId,
            message: event.message,
          });
        },
        onStep: async (step) => {
          push({
            type: "step",
            runId: step.runId,
            step,
          });
        },
      },
      options,
    )
      .then((result) => {
        push({
          type: "done",
          runId: result.runId,
          taskId: result.taskId,
          result,
        });
      })
      .catch((error) => {
        runError = error;
      })
      .finally(() => {
        finished = true;
        const notify = wake;
        wake = null;
        notify?.();
      });

    while (!finished || queue.length > 0) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        continue;
      }
      const chunk = queue.shift();
      if (chunk) {
        yield chunk;
      }
    }

    if (runError) {
      throw runError;
    }
  }

  public async suggestChatDelegation(
    sessionId: string,
    input: ChatDelegateSuggestRequest = {},
  ): Promise<ChatDelegateSuggestResponse> {
    this.deps.getSession(sessionId);
    const objective = (input.objective?.trim() || (await this.inferLatestUserObjective(sessionId))).trim();
    if (!objective) {
      throw new Error("No objective provided and no recent user request was found.");
    }
    const detectedRoles = normalizeDelegationRoles(
      input.roles?.length ? input.roles : detectDelegationRoles(objective),
    );
    const roles = detectedRoles.length > 0 ? detectedRoles : DEFAULT_DELEGATION_ROLES.slice(0, 3);
    const confidence = computeDelegationSuggestionConfidence(objective, roles);
    const suggestion: ChatDelegationSuggestionRecord = {
      suggestionId: randomUUID(),
      sessionId,
      objective,
      roles,
      mode: "sequential",
      confidence,
      reason: "Detected multi-role objective and generated delegation plan.",
      source: "manual",
      createdAt: new Date().toISOString(),
    };
    return { suggestion };
  }

  public async acceptChatDelegation(
    sessionId: string,
    input: ChatDelegateAcceptRequest,
  ): Promise<ChatDelegateResponse> {
    this.deps.getSession(sessionId);
    if (input.suggestionId) {
      const actionRow = this.deps.gatewaySql
        .prepare(
          `
        SELECT args_json
        FROM proactive_actions
        WHERE action_id = ? AND session_id = ?
      `,
        )
        .get(input.suggestionId, sessionId) as { args_json?: string } | undefined;
      if (actionRow?.args_json) {
        const parsed = safeJsonParse<Record<string, unknown>>(actionRow.args_json, {});
        const objectiveFromSuggestion = typeof parsed.objective === "string" ? parsed.objective.trim() : "";
        const rolesFromSuggestion = Array.isArray(parsed.roles) ? parsed.roles.map((item) => String(item)) : [];
        return this.runChatDelegation(sessionId, {
          objective: objectiveFromSuggestion || input.objective,
          roles: rolesFromSuggestion.length > 0 ? rolesFromSuggestion : input.roles,
          mode: input.mode ?? "sequential",
          providerId: input.providerId,
          model: input.model,
          surfaceMode: input.surfaceMode,
          steps: input.steps,
          operatorId: input.operatorId,
          authActorId: input.authActorId,
          authActorSource: input.authActorSource,
          permissionProfileId: input.permissionProfileId,
          localOperatorOverrideId: input.localOperatorOverrideId,
          policyRunId: input.policyRunId,
          policyTaskId: input.policyTaskId,
          fullWebAccess: input.fullWebAccess,
        });
      }
    }
    return this.runChatDelegation(sessionId, {
      objective: input.objective,
      roles: input.roles,
      mode: input.mode ?? "sequential",
      providerId: input.providerId,
      model: input.model,
      surfaceMode: input.surfaceMode,
      steps: input.steps,
      operatorId: input.operatorId,
      authActorId: input.authActorId,
      authActorSource: input.authActorSource,
      permissionProfileId: input.permissionProfileId,
      localOperatorOverrideId: input.localOperatorOverrideId,
      policyRunId: input.policyRunId,
      policyTaskId: input.policyTaskId,
      fullWebAccess: input.fullWebAccess,
    });
  }

  private async inferLatestUserObjective(sessionId: string): Promise<string> {
    const messages = await this.deps.listChatMessages(sessionId, 40);
    const latestUser = [...messages].reverse().find((item) => item.role === "user");
    return latestUser?.content ?? "";
  }
}

function computeDelegationSuggestionConfidence(objective: string, roles: string[]): number {
  let score = roles.length >= 3 ? 0.84 : roles.length >= 2 ? 0.72 : 0.58;
  if (/\b(prd|architecture|implement|qa|ops|handoff)\b/i.test(objective)) {
    score += 0.12;
  }
  return Math.max(0, Math.min(1, score));
}

function normalizeDelegationRoles(roles: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const role of roles) {
    const normalized = role
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!normalized || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    out.push(normalized);
  }
  if (out.length === 0) {
    return [...DEFAULT_DELEGATION_ROLES];
  }
  return out;
}

function normalizeDelegationSteps(input: {
  roles: string[];
  mode: "sequential" | "parallel";
  steps?: NonNullable<ChatDelegateRequest["steps"]>;
}): NormalizedDelegationStep[] {
  if (!input.steps || input.steps.length === 0) {
    const stepIds = input.roles.map(() => randomUUID());
    return input.roles.map((role, index) => ({
      stepId: stepIds[index]!,
      index,
      role,
      parallelizable: input.mode === "parallel",
      dependsOnStepIds: input.mode === "sequential" && index > 0 ? [stepIds[index - 1]!] : [],
    }));
  }

  const allowedRoles = new Set(input.roles);
  const provisional = input.steps.map((step, index) => {
    const normalizedRole = normalizeDelegationRoles([step.role])[0];
    if (!normalizedRole) {
      throw new Error(`delegation step ${index + 1} is missing a valid role`);
    }
    if (!allowedRoles.has(normalizedRole)) {
      throw new Error(`delegation step role "${normalizedRole}" must also appear in roles`);
    }
    return {
      requestedStepId: step.stepId?.trim(),
      requestedIndex: Number.isFinite(step.index) ? Math.max(0, Math.trunc(step.index!)) : index,
      role: normalizedRole,
      parallelizable: step.parallelizable ?? input.mode === "parallel",
      dependsOnStepIds: dedupeStrings(step.dependsOnStepIds ?? []),
    };
  });

  provisional.sort((left, right) => left.requestedIndex - right.requestedIndex);
  const seenRequestedStepIds = new Set<string>();
  for (const step of provisional) {
    if (!step.requestedStepId) {
      continue;
    }
    if (seenRequestedStepIds.has(step.requestedStepId)) {
      throw new Error(`delegation step id "${step.requestedStepId}" is duplicated`);
    }
    seenRequestedStepIds.add(step.requestedStepId);
  }

  const requestedToActualStepIds = new Map<string, string>();
  const actualStepIds: string[] = provisional.map((step) => {
    const actualStepId = randomUUID();
    if (step.requestedStepId) {
      requestedToActualStepIds.set(step.requestedStepId, actualStepId);
    }
    return actualStepId;
  });
  const normalized = provisional.map((step, index) => {
    const stepId = actualStepIds[index]!;
    return {
      stepId,
      index,
      role: step.role,
      parallelizable: step.parallelizable,
      dependsOnStepIds: step.dependsOnStepIds.map(
        (dependencyStepId) => requestedToActualStepIds.get(dependencyStepId) ?? dependencyStepId,
      ),
    };
  });

  const validStepIds = new Set(normalized.map((step) => step.stepId));
  for (const step of normalized) {
    for (const dependencyStepId of step.dependsOnStepIds) {
      if (!validStepIds.has(dependencyStepId)) {
        throw new Error(`delegation step "${step.stepId}" depends on unknown step "${dependencyStepId}"`);
      }
      if (dependencyStepId === step.stepId) {
        throw new Error(`delegation step "${step.stepId}" cannot depend on itself`);
      }
    }
  }
  return normalized;
}

function buildDelegationStages(steps: readonly NormalizedDelegationStep[]): NormalizedDelegationStep[][] {
  const remaining = new Map(steps.map((step) => [step.stepId, step] as const));
  const resolved = new Set<string>();
  const stages: NormalizedDelegationStep[][] = [];

  while (remaining.size > 0) {
    const ready = [...remaining.values()]
      .filter((step) => step.dependsOnStepIds.every((dependencyStepId) => resolved.has(dependencyStepId)))
      .sort((left, right) => left.index - right.index);
    if (ready.length === 0) {
      throw new Error("delegation steps contain a dependency cycle or unresolved dependency");
    }
    const stage = ready.some((step) => !step.parallelizable) ? [ready[0]!] : ready;
    stages.push(stage);
    for (const step of stage) {
      remaining.delete(step.stepId);
      resolved.add(step.stepId);
    }
  }

  return stages;
}

function composeChatDelegationAbortSignal(childSignal: AbortSignal, parentSignal?: AbortSignal): AbortSignal {
  if (!parentSignal) {
    return childSignal;
  }
  return AbortSignal.any([childSignal, parentSignal]);
}

function throwIfChatDelegationAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }
  if (signal.reason instanceof Error) {
    throw signal.reason;
  }
  const error = new Error("Chat delegation cancelled.");
  error.name = "AbortError";
  throw error;
}

function isChatDelegationAbortError(error: unknown, signal?: AbortSignal): boolean {
  if (signal?.aborted) {
    return true;
  }
  return error instanceof Error && error.name === "AbortError";
}

function dedupeStrings(values: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

export interface BuildDelegationSpecialistSystemPromptInput {
  role: string;
}

export function buildDelegationSpecialistSystemPrompt(input: BuildDelegationSpecialistSystemPromptInput): string {
  return [
    "You are a specialist subagent in a multi-step delegation run.",
    `Assigned role: ${input.role}.`,
    "Return concise, practical output in plain markdown.",
    "If you are missing data, call that out explicitly and propose a next best step.",
    "Never claim external data unless it was provided in the current context.",
  ].join("\n");
}

export interface BuildSubagentTaskFirstMessageInput {
  role: string;
  objective: string;
  mode: "sequential" | "parallel";
  parentDelegationStepId: string;
  sharedContext: Array<{ role: string; output: string }>;
}

export function buildSubagentTaskFirstMessage(input: BuildSubagentTaskFirstMessageInput): string {
  const dependencyBlock =
    input.sharedContext.length > 0
      ? input.sharedContext.map((item) => `Role ${item.role} output:\n${item.output}`).join("\n\n")
      : "None";
  return [
    `[Subagent Task] ${input.objective}`,
    `Assigned role: ${input.role}`,
    `Execution mode: ${input.mode}`,
    `Parent delegation step: ${input.parentDelegationStepId}`,
    "",
    "Completed dependency outputs available to this role:",
    dependencyBlock,
    "",
    "Produce your role output now.",
  ].join("\n");
}

function buildLateChildTimeoutDiagnostic(input: {
  event: ChildTimeoutLateSettleEvent<ChatSendMessageResponse>;
  role: string;
  stepId: string;
}): AgenticDiagnosticSignal {
  const roleLabel = toTitleCase(input.role);
  const createdAt = new Date().toISOString();
  if (input.event.status === "completed") {
    return {
      signalId: randomUUID(),
      code: "child_timeout",
      severity: "warning",
      title: "Subagent completed after timeout",
      summary: `${roleLabel} completed after its timeout; recorded as diagnostics only and ignored as deliverable truth.`,
      evidenceRef: `delegation-step:${input.stepId}`,
      createdAt,
    };
  }
  return {
    signalId: randomUUID(),
    code: "child_timeout",
    severity: "warning",
    title: "Subagent failed after timeout",
    summary: `${roleLabel} failed after its timeout: ${formatUnknownError(input.event.error)}`,
    evidenceRef: `delegation-step:${input.stepId}`,
    createdAt,
  };
}

function buildLateChildTimeoutActivityMetadata(input: {
  event: ChildTimeoutLateSettleEvent<ChatSendMessageResponse>;
  runId: string;
  childRunId: string;
  stepId: string;
  childSessionId: string;
  diagnostic: AgenticDiagnosticSignal;
}): Record<string, unknown> {
  const metadata: Record<string, unknown> = {
    runId: input.runId,
    childRunId: input.childRunId,
    stepId: input.stepId,
    childSessionId: input.childSessionId,
    diagnosticCode: input.diagnostic.code,
    diagnosticSignalId: input.diagnostic.signalId,
    lateStatus: input.event.status,
    elapsedMs: input.event.elapsedMs,
    ignoredAsDeliverableTruth: true,
  };
  if (input.event.status === "completed") {
    metadata.childTurnId = input.event.value.turnId;
    metadata.durableRunId = input.event.value.trace?.durable?.runId;
    metadata.citationCount = input.event.value.citations?.length ?? 0;
    metadata.outputPreview = input.event.value.assistantMessage?.content?.slice(0, 1000);
    return metadata;
  }
  metadata.error = formatUnknownError(input.event.error);
  return metadata;
}

async function mapWithConcurrency<TInput, TOutput>(
  items: readonly TInput[],
  concurrency: number,
  worker: (item: TInput, index: number) => Promise<TOutput>,
): Promise<TOutput[]> {
  const cappedConcurrency = Math.max(1, Math.min(concurrency, items.length || 1));
  const results = new Array<TOutput>(items.length);
  let nextIndex = 0;

  const runWorker = async () => {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) {
        return;
      }
      results[currentIndex] = await worker(items[currentIndex]!, currentIndex);
    }
  };

  await Promise.all(Array.from({ length: cappedConcurrency }, () => runWorker()));
  return results;
}

function safeJsonParse<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function formatUnknownError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  return String(error);
}

/**
 * When a chat session that is itself a subagent calls
 * `runChatDelegation`, infer the caller's depth from its registered
 * task-subagent record so the resulting child sits at `depth + 1` and is
 * subject to `maxDepth` enforcement. Returns `undefined` when no record
 * exists or the record has no usable depth (so the caller is treated as
 * a top-level operator -> child depth 1).
 */
function resolveInferredParentDepth(deps: ChatDelegationServiceHost, sessionId: string): number | undefined {
  const record = deps.storage.taskSubagents.findByAgentSessionId(sessionId);
  const depth = record?.metadata?.depth;
  if (typeof depth !== "number" || !Number.isFinite(depth) || depth < 0) {
    return undefined;
  }
  return depth;
}
