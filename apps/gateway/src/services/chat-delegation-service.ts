/* eslint-disable max-lines -- Chat delegation centralizes run persistence, child sessions, dependency ordering, and synthesis truth. */
import { createHash, randomUUID } from "node:crypto";
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
  TaskActivityRecord,
  TaskDeliverableRecord,
  TaskRecord,
  TaskStatus,
  ToolPolicyActorContext,
} from "@goatcitadel/contracts";
import { chatModeRequiresProjectBinding, NotFoundError, ValidationError } from "@goatcitadel/contracts";
import { isAuthoritativeModelUsageAccountingError } from "@goatcitadel/gateway-core";
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

interface DelegationTurnIdentity {
  turnId: string;
  userMessageId: string;
  assistantMessageId: string;
}

class DelegationDispatchOwnershipError extends Error {
  public constructor(stepId: string) {
    super(`Delegation step ${stepId} dispatch ownership was superseded.`);
    this.name = "DelegationDispatchOwnershipError";
  }
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
      patch(
        runId: string,
        patch: Partial<ChatDelegationRunRecord> & { clearFinishedAt?: boolean },
      ): ChatDelegationRunRecord;
      get(runId: string): ChatDelegationRunRecord;
      getForUpdate(runId: string): ChatDelegationRunRecord;
      listRecent?(input: { sessionId?: string; parentRunId?: string; limit?: number }): ChatDelegationRunRecord[];
    };
    chatDelegationSteps: {
      readDatabaseNow(): string;
      get(stepId: string): ChatDelegationStepRecord;
      getDispatchClaim(stepId: string): { token: string; expiresAt: string } | undefined;
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
      patch(
        stepId: string,
        patch: Omit<Partial<ChatDelegationStepRecord>, "childSessionId" | "childTurnId"> & {
          childSessionId?: string | null;
          childTurnId?: string | null;
        },
      ): ChatDelegationStepRecord;
      listByRun(runId: string): ChatDelegationStepRecord[];
      listByRunForUpdate(runId: string): ChatDelegationStepRecord[];
      claimPendingForDispatch(
        stepId: string,
        claimToken: string,
        claimExpiresAt: string,
        startedAt: string,
      ): ChatDelegationStepRecord | undefined;
      reclaimRunningForDispatch(
        stepId: string,
        expectedClaimToken: string | undefined,
        claimToken: string,
        claimExpiresAt: string,
        startedAt: string,
      ): ChatDelegationStepRecord | undefined;
      linkClaimedDispatch(
        stepId: string,
        claimToken: string,
        childSessionId: string,
        dispatchToken: string,
        dispatchExpiresAt: string,
      ): ChatDelegationStepRecord | undefined;
      claimLinkedForDispatch(
        stepId: string,
        childSessionId: string,
        expectedChildTurnId: string | undefined,
        dispatchToken: string,
        dispatchExpiresAt: string,
        startedAt: string,
      ): ChatDelegationStepRecord | undefined;
      reclaimLinkedDispatch(
        stepId: string,
        childSessionId: string,
        expectedDispatchToken: string,
        dispatchToken: string,
        dispatchExpiresAt: string,
        startedAt: string,
      ): ChatDelegationStepRecord | undefined;
      finalizeLinkedDispatch(
        stepId: string,
        childSessionId: string,
        expectedDispatchMarker: string,
        childTurnId: string,
      ): ChatDelegationStepRecord | undefined;
      ownsLinkedDispatch(stepId: string, childSessionId: string, dispatchToken: string): boolean;
      finishOwnedDispatchWithError(input: {
        stepId: string;
        expectedDispatchToken: string;
        expectedChildSessionId?: string;
        status: "failed" | "cancelled";
        label?: string;
        summary?: string;
        error: string;
        failureGuidance?: string;
        finishedAt: string;
        durationMs: number;
      }): ChatDelegationStepRecord | undefined;
      finishOwnedDispatchWithResponse(input: {
        stepId: string;
        expectedDispatchToken: string;
        childSessionId: string;
        childTurnId: string;
        status: "running" | "completed" | "failed" | "cancelled";
        providerId?: string;
        model?: string;
        label?: string;
        summary?: string;
        output: string;
        error?: string;
        failureGuidance?: string;
        durableRunId?: string;
        citations: ChatCitationRecord[];
        workResult?: ChatDelegationStepRecord["workResult"];
        finishedAt?: string;
        durationMs?: number;
      }): ChatDelegationStepRecord | undefined;
      releaseOwnedWaitingDispatch(input: {
        stepId: string;
        expectedDispatchToken: string;
        childSessionId: string;
        childTurnId: string;
      }): ChatDelegationStepRecord | undefined;
      finishUnclaimedPendingWithError(input: {
        stepId: string;
        status: "failed" | "cancelled" | "skipped";
        label?: string;
        summary?: string;
        error: string;
        failureGuidance?: string;
        finishedAt: string;
        durationMs: number;
      }): ChatDelegationStepRecord | undefined;
    };
    chatTurnTraces: {
      get(turnId: string): ChatTurnTraceRecord;
    };
    taskSubagents: {
      findByAgentSessionId(agentSessionId: string): TaskSubagentSession | undefined;
    };
    runImmediateTransaction<T>(callback: () => T): T;
  };
  gatewaySql: {
    prepare(sql: string): {
      get(...params: unknown[]): unknown;
    };
  };
  taskLifecycleService: {
    createTask(
      input: {
        workspaceId: string;
        title: string;
        description: string;
        status: "in_progress";
        priority: "normal";
        createdBy: string;
        agenticContext?: AgenticTaskContext;
      },
      options?: { taskId?: string },
    ): { taskId: string };
    getTask(taskId: string): {
      taskId: string;
      workspaceId?: string;
      title?: string;
      description?: string;
      agenticContext?: AgenticTaskContext;
    };
    lockTaskForDelegationAggregate(taskId: string): {
      taskId: string;
      status: TaskStatus;
      agenticContext?: AgenticTaskContext;
    };
    lockDelegationSubagentProjection(agentSessionId: string): TaskSubagentSession;
    persistDelegationAggregateTask(
      taskId: string,
      input: { status: TaskStatus; agenticContext: Partial<AgenticTaskContext> },
    ): TaskRecord;
    publishDelegationAggregateTask(task: TaskRecord): void;
    persistDelegationSubagentProjection(
      agentSessionId: string,
      patch: { status: SubagentSessionStatus; endedAt?: string; metadata?: AgenticSubagentMetadata },
    ): TaskSubagentSession;
    publishDelegationSubagentProjection(session: TaskSubagentSession): void;
    persistDelegationActivity(
      taskId: string,
      input: {
        activityType: "comment" | "diagnostic" | "handoff";
        message: string;
        agentId?: string;
        metadata?: Record<string, unknown>;
      },
      createdAt: string,
    ): TaskActivityRecord;
    persistDelegationActivityOnce(
      activityId: string,
      taskId: string,
      input: {
        activityType: "comment" | "diagnostic" | "handoff";
        message: string;
        agentId?: string;
        metadata?: Record<string, unknown>;
      },
      createdAt: string,
    ): { activity: TaskActivityRecord; created: boolean };
    publishDelegationActivity(activity: TaskActivityRecord): void;
    persistDelegationDeliverable(
      taskId: string,
      input: { deliverableType: "artifact"; title: string; description: string },
      createdAt: string,
    ): TaskDeliverableRecord;
    publishDelegationDeliverable(deliverable: TaskDeliverableRecord): void;
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
    stableKey?: string;
    workspaceId?: string;
    title?: string;
    projectId?: string;
    mode?: ChatMode;
  }): ChatSessionRecord;
  inheritDelegatedSessionToolGrants(parentSessionId: string, childSessionId: string): void;
  ensureSessionInternalToolGrant?(sessionId: string, toolName: string, reason: string): void;
  resolveDelegatedFilesystemScope?(
    parentSessionId: string,
    dispatchGeneration: string,
    current?: ChatDelegationStepRecord["scopeControl"],
  ): ChatDelegationStepRecord["scopeControl"] | undefined;
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
    options?: {
      abortSignal?: AbortSignal;
      turnIdentity?: DelegationTurnIdentity;
      assertDispatchOwnership?: () => void;
    },
  ): Promise<ChatSendMessageResponse>;
  extractAndPersistLearnedMemory(
    sessionId: string,
    content: string,
    source: { role: "user" | "assistant"; sourceRef: string },
  ): void;
  scheduleChatMemoryContextPrewarm(input: { sessionId: string; prompt: string; relationScope: "peer" }): void;
  watchDurableChildRun?(input: {
    parentRunId: string;
    childRunId: string;
    watcherId: string;
    source: string;
    metadata: Record<string, unknown>;
  }): void;
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
    const requestedDelegationSteps = normalizeDelegationSteps({
      roles,
      mode,
      steps: input.steps,
    });
    const prefs = deps.ensureChatSessionModelDefaults(sessionId, deps.storage.chatSessionPrefs.ensure(sessionId));
    const executionMode: ChatMode = "chat";
    const providerId = input.providerId ?? prefs.providerId;
    const model = input.model ?? prefs.model;
    const sessionWorkspaceId = deps.normalizeWorkspaceId(deps.storage.chatSessionMeta.ensure(sessionId).workspaceId);
    const parentProjectId = deps.storage.chatSessionProjects.get(sessionId)?.projectId;
    if (chatModeRequiresProjectBinding(executionMode) && !parentProjectId) {
      throw new ValidationError({ message: "Code delegation requires a project-bound parent session." });
    }
    throwIfChatDelegationAborted(options.abortSignal);

    let stableParentRun = findStableParentDelegationRun(deps, {
      sessionId,
      policyRunId: input.policyRunId,
      objective,
      mode,
      roles,
    });
    let repairStableParentBeforeDispatch = false;
    const stablePolicyRunId = input.policyRunId?.trim();
    const runId =
      stableParentRun?.runId ??
      (stablePolicyRunId ? buildStableDelegationId("delegation-run", sessionId, stablePolicyRunId) : randomUUID());
    let existingSteps = stableParentRun ? deps.storage.chatDelegationSteps.listByRun(runId) : [];
    const normalizedRequestedSteps = stablePolicyRunId
      ? stabilizeDelegationPlan(runId, requestedDelegationSteps)
      : requestedDelegationSteps;
    let delegationSteps = rebuildResumableDelegationPlan(existingSteps, normalizedRequestedSteps);
    if (stableParentRun && stableParentRun.status !== "running") {
      const terminalReplay = resolveStableTerminalDelegationReplay(
        deps,
        stableParentRun.runId,
        stableParentRun.taskId,
        normalizedRequestedSteps,
      );
      if (terminalReplay.kind === "terminal") {
        if (terminalReplay.committedAggregate) {
          publishDelegationAggregateCommit(deps, terminalReplay.committedAggregate);
        } else if (terminalReplay.summaryReceipt?.created) {
          publishDelegationPostCommitSafely("terminal summary", () =>
            deps.taskLifecycleService.publishDelegationActivity(terminalReplay.summaryReceipt!.activity),
          );
        }
        return {
          runId: stableParentRun.runId,
          taskId: stableParentRun.taskId,
          status: terminalReplay.projection.status,
          executionPlanId: stableParentRun.executionPlanId,
          steps: terminalReplay.persistedSteps,
          stitchedOutput: terminalReplay.projection.stitchedOutput,
          citations: terminalReplay.projection.citations,
          trace: stableParentRun.trace,
        };
      }
      repairStableParentBeforeDispatch = true;
      existingSteps = deps.storage.chatDelegationSteps.listByRun(runId);
      delegationSteps = rebuildResumableDelegationPlan(existingSteps, normalizedRequestedSteps);
    }
    const stages = buildDelegationStages(delegationSteps);
    const maxSpawn = mode === "parallel" ? 4 : 1;
    const childRunIds = delegationSteps.map((step) => `${runId}:${step.stepId}`);
    const taskInput = {
      workspaceId: sessionWorkspaceId,
      title: `Delegation: ${objective.slice(0, 120)}`,
      description: objective,
      status: "in_progress" as const,
      priority: "normal" as const,
      createdBy: "chat",
      agenticContext: {
        boardId: `chat:${sessionWorkspaceId}`,
        runId,
        parentRunId: input.policyRunId,
        childRunIds,
        parentSessionId: sessionId,
        surface: executionMode,
        status: "running" as const,
        contextMode: "fork" as const,
        workspaceScope: {
          kind: "session" as const,
        },
        providerId,
        model,
        maxSpawn,
        activeChildCount: 0,
        deliveryState: {
          status: "not_required" as const,
          attempts: 0,
        },
      },
    };
    const task = stableParentRun
      ? { taskId: stableParentRun.taskId }
      : stablePolicyRunId
        ? createOrLoadStableDelegationTask(deps, buildStableDelegationId("delegation-task", runId), taskInput)
        : deps.taskLifecycleService.createTask(taskInput);

    if (repairStableParentBeforeDispatch && stableParentRun) {
      const repaired = commitDelegationAggregate(deps, {
        runId,
        taskId: task.taskId,
        trace: stableParentRun.trace,
        observedAt: new Date().toISOString(),
      });
      stableParentRun = {
        ...stableParentRun,
        status: repaired.status,
        stitchedOutput: repaired.stitchedOutput,
        citations: repaired.citations,
      };
    }

    let resumedExistingRun = Boolean(stableParentRun);
    const persistPlan = () => {
      if (!stableParentRun) {
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
      }
      const existingStepIds = new Set(existingSteps.map((step) => step.stepId));
      const plannedAt = new Date().toISOString();
      for (const step of delegationSteps) {
        if (existingStepIds.has(step.stepId)) {
          continue;
        }
        deps.storage.chatDelegationSteps.create({
          stepId: step.stepId,
          runId,
          role: step.role,
          label: step.role,
          index: step.index,
          status: "pending",
          parallelizable: step.parallelizable,
          dependsOnStepIds: step.dependsOnStepIds,
          startedAt: plannedAt,
        });
      }
    };
    try {
      if (deps.storage.runImmediateTransaction) {
        deps.storage.runImmediateTransaction(persistPlan);
      } else {
        persistPlan();
      }
    } catch (error) {
      const concurrentRun = findStableParentDelegationRun(deps, {
        sessionId,
        policyRunId: input.policyRunId,
        objective,
        mode,
        roles,
      });
      if (!concurrentRun || concurrentRun.runId !== runId || concurrentRun.taskId !== task.taskId) {
        throw error;
      }
      stableParentRun = concurrentRun;
      existingSteps = deps.storage.chatDelegationSteps.listByRun(runId);
      rebuildResumableDelegationPlan(existingSteps, normalizedRequestedSteps);
      resumedExistingRun = true;
    }
    let ownsAnyOutcome = false;
    let ownsTerminalSummary = false;
    await callbacks?.onStatus?.({
      runId,
      taskId: task.taskId,
      message: resumedExistingRun ? "Delegation resumed." : "Delegation started.",
    });
    deps.taskLifecycleService.appendTaskActivity(task.taskId, {
      activityType: "comment",
      message: `Delegation ${resumedExistingRun ? "resumed" : "started"} (${delegationSteps.map((step) => step.role).join(mode === "parallel" ? " | " : " -> ")})`,
      metadata: { runId, sessionId, mode, requestedMode, surfaceMode: executionMode },
    });

    let trace: ChatTurnTraceRecord["routing"] | undefined = stableParentRun?.trace;
    const completedOutputs = new Map<string, { role: string; output: string }>();
    const stepResults = new Map<string, DelegationStepExecutionResult>();
    for (const persistedStep of deps.storage.chatDelegationSteps.listByRun(runId)) {
      stepResults.set(persistedStep.stepId, {
        step: persistedStep,
        output: persistedStep.output,
        citations: persistedStep.citations ?? [],
        completed: persistedStep.status === "completed",
      });
      if (persistedStep.status === "completed" && persistedStep.output?.trim()) {
        completedOutputs.set(persistedStep.stepId, {
          role: persistedStep.role,
          output: persistedStep.output.slice(0, 4000),
        });
      }
    }
    const subagentDefaults = deps.subagentDefaults ?? DEFAULT_SUBAGENT_DEFAULTS;
    const childTimeoutSeconds = subagentDefaults.childTimeoutSeconds;
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
      const committedFailure = deps.storage.runImmediateTransaction(() => {
        const locks = lockDelegationAggregateTruth(deps, runId, task.taskId);
        const aggregate = persistDelegationAggregateFromLockedTruth(
          deps,
          {
            runId,
            taskId: task.taskId,
            observedAt: finishedAt,
            preDispatchFailure: message,
          },
          locks,
        );
        const activity = aggregate.aggregatePersisted
          ? deps.taskLifecycleService.persistDelegationActivity(
              task.taskId,
              {
                activityType: "diagnostic",
                message: `Delegation failed before dispatch: ${message}`,
                metadata: { runId, sessionId, surfaceMode: executionMode, error: message },
              },
              finishedAt,
            )
          : undefined;
        return { aggregate, activity };
      });
      if (committedFailure.activity) {
        publishDelegationPostCommitSafely("pre-dispatch failure activity", () =>
          deps.taskLifecycleService.publishDelegationActivity(committedFailure.activity!),
        );
      }
      publishDelegationAggregateCommit(deps, committedFailure.aggregate);
      if (committedFailure.aggregate.aggregatePersisted) {
        await callbacks?.onStatus?.({
          runId,
          taskId: task.taskId,
          message: "Delegation failed before dispatch.",
        });
      }
      throw error;
    }

    const executeDelegationStep = async (step: NormalizedDelegationStep): Promise<DelegationStepExecutionResult> => {
      const startedAt = deps.storage.chatDelegationSteps.readDatabaseNow();
      const childRunId = `${runId}:${step.stepId}`;
      const turnIdentity = buildStableDelegationTurnIdentity(runId, step.stepId);
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
      let dispatchOwnership: { token: string; childSessionId?: string } | undefined;
      let subagentDiagnostics: AgenticDiagnosticSignal[] = [];
      let timeoutFailureFenceState: "pending" | "won" | "lost" = "pending";
      let bufferedLateSettle: ChildTimeoutLateSettleEvent<ChatSendMessageResponse> | undefined;
      let lateSettleRecordScheduled = false;
      let scheduleLateSettleRecord: ((event: ChildTimeoutLateSettleEvent<ChatSendMessageResponse>) => void) | undefined;

      try {
        throwIfChatDelegationAborted(options.abortSignal);
        enforceMaxDepth({ depth: childDepth, maxDepth: subagentDefaults.maxDepth });
        const dispatchLease = acquireDelegationDispatchLease(deps, {
          stepId: step.stepId,
          turnIdentity,
          startedAt,
          leaseDurationMs: Math.max(60_000, (childTimeoutSeconds + 60) * 1000),
        });
        if (!dispatchLease) {
          const current = deps.storage.chatDelegationSteps.get(step.stepId);
          return {
            step: current,
            output: current.output,
            citations: current.citations ?? [],
            completed: current.status === "completed",
          };
        }
        dispatchOwnership = {
          token: dispatchLease.childSessionId
            ? dispatchLease.dispatchMarker
            : (dispatchLease.claimMarker ?? dispatchLease.dispatchMarker),
          childSessionId: dispatchLease.childSessionId,
        };

        let agentSessionId = dispatchLease.childSessionId;
        let runningStep = dispatchLease.step;
        if (!agentSessionId) {
          const childSessionInput = {
            ...(stablePolicyRunId ? { stableKey: `chat-delegation:${runId}:${step.stepId}` } : {}),
            workspaceId: sessionWorkspaceId,
            title: `Delegate · ${toTitleCase(step.role)}`,
            projectId: parentProjectId,
            mode: executionMode,
          };
          const childSession = deps.createChatSession(childSessionInput);
          agentSessionId = childSession.sessionId;
          const linkedStep = deps.storage.chatDelegationSteps.linkClaimedDispatch(
            step.stepId,
            dispatchLease.claimMarker!,
            agentSessionId,
            dispatchLease.dispatchMarker,
            dispatchLease.dispatchExpiresAt,
          );
          if (!linkedStep) {
            const current = deps.storage.chatDelegationSteps.get(step.stepId);
            return {
              step: current,
              output: current.output,
              citations: current.citations ?? [],
              completed: current.status === "completed",
            };
          }
          runningStep = linkedStep;
          dispatchOwnership = {
            token: dispatchLease.dispatchMarker,
            childSessionId: agentSessionId,
          };
        }
        await callbacks?.onStep?.(runningStep);
        registeredAgentSessionId = agentSessionId;
        childSessionId = agentSessionId;
        deps.inheritDelegatedSessionToolGrants(sessionId, agentSessionId);
        const delegatedScope = deps.resolveDelegatedFilesystemScope?.(
          sessionId,
          dispatchLease.dispatchMarker,
          runningStep.scopeControl,
        );
        if (delegatedScope) {
          // The durable patch is the authority; its returned projection is intentionally unused after scope setup.
          deps.storage.chatDelegationSteps.patch(step.stepId, { scopeControl: delegatedScope });
          deps.ensureSessionInternalToolGrant?.(agentSessionId, "submit_work_result", "delegated-work-result-envelope");
        }
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
        const existingSubagent = deps.storage.taskSubagents.findByAgentSessionId(agentSessionId);
        if (!existingSubagent) {
          deps.taskLifecycleService.registerTaskSubagent(task.taskId, {
            agentSessionId,
            agentName: step.role,
            metadata: childMetadataBase,
          });
        } else if (existingSubagent.taskId !== task.taskId) {
          throw new Error(
            `Delegated child session ${agentSessionId} is already linked to task ${existingSubagent.taskId}.`,
          );
        }
        const taskFirstMessage = buildSubagentTaskFirstMessage({
          role: step.role,
          objective,
          mode,
          parentDelegationStepId: step.stepId,
          sharedContext: dependencyContext,
        });
        scheduleLateSettleRecord = (event) => {
          if (lateSettleRecordScheduled) {
            return;
          }
          lateSettleRecordScheduled = true;
          void Promise.resolve()
            .then(() => {
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
            })
            .catch(() => {
              // The canonical timeout outcome is already committed; diagnostics stay best-effort.
            });
        };
        const response = await runWithChildTimeout<ChatSendMessageResponse>({
          timeoutSeconds: childTimeoutSeconds,
          onLateSettle: (event) => {
            if (timeoutFailureFenceState === "lost" || lateSettleRecordScheduled) {
              return;
            }
            if (timeoutFailureFenceState === "pending") {
              bufferedLateSettle ??= event;
              return;
            }
            scheduleLateSettleRecord?.(event);
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
              {
                abortSignal: composeChatDelegationAbortSignal(signal, options.abortSignal),
                turnIdentity,
                assertDispatchOwnership: () =>
                  assertDelegationDispatchOwnership(deps, step.stepId, agentSessionId, dispatchLease.dispatchMarker),
              },
            ),
        });
        const responseTurnId = response.turnId?.trim();
        if (!responseTurnId) {
          throw new Error(`Delegated child ${agentSessionId} returned without a canonical turn identity.`);
        }
        const traceStatus = response.trace?.status;
        const latestStep = deps.storage.chatDelegationSteps.get(step.stepId);
        const submittedWorkResult = latestStep.workResult;
        const currentScopedWorkResult =
          !latestStep.scopeControl ||
          (submittedWorkResult?.scopeHash === latestStep.scopeControl.scopeHash &&
            submittedWorkResult.dispatchGeneration === latestStep.scopeControl.dispatchGeneration);
        const pendingScopeExpansion =
          currentScopedWorkResult &&
          submittedWorkResult?.disposition === "scope_expansion" &&
          submittedWorkResult.scopeExpansion?.decision === undefined;
        const blockedWorkResult = currentScopedWorkResult && submittedWorkResult?.disposition === "blocked";
        const waitingForApproval = traceStatus === "waiting_for_approval" || pendingScopeExpansion;
        const waitingForUserInput = traceStatus === "waiting_for_user_input";
        const stillActive = traceStatus === "queued" || traceStatus === "running" || traceStatus === "waiting_for_tool";
        const waiting = waitingForApproval || waitingForUserInput || stillActive;
        const traceFailure = response.trace?.failure;
        const degradedFailure = !waiting && isIncompleteDelegatedTraceFailure(traceFailure);
        const missingScopedTerminalResult =
          Boolean(latestStep.scopeControl) &&
          !waiting &&
          (!currentScopedWorkResult || submittedWorkResult?.disposition !== "completed");
        const failed = traceStatus === "failed" || degradedFailure || blockedWorkResult || missingScopedTerminalResult;
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
                ? traceStatus === "waiting_for_tool"
                  ? "Delegate is still waiting on a tool result."
                  : "Delegate turn is still running."
                : "(delegate returned no output)");
        const observedAt = new Date().toISOString();
        const responseCommitInput = {
          stepId: step.stepId,
          expectedDispatchToken: dispatchLease.dispatchMarker,
          childSessionId: agentSessionId,
          childTurnId: responseTurnId,
          status: stepStatus,
          providerId: response.trace?.routing?.effectiveProviderId ?? providerId,
          model: response.trace?.model ?? model,
          label: step.role,
          summary: truncateSummaryLine(output, 180),
          output,
          error: missingScopedTerminalResult
            ? "Delegated code work ended without a current submit_work_result completion envelope."
            : incomplete
              ? (response.trace?.failure?.message ?? output)
              : undefined,
          failureGuidance: incomplete
            ? buildIncompleteDelegatedTraceFailureGuidance(traceFailure, output, step.role)
            : undefined,
          durableRunId: response.trace?.durable?.runId,
          citations: response.citations ?? [],
          workResult: submittedWorkResult,
          ...(waiting
            ? {}
            : {
                finishedAt: observedAt,
                durationMs: Math.max(0, Date.parse(observedAt) - Date.parse(startedAt)),
              }),
        } satisfies Parameters<
          ChatDelegationServiceHost["storage"]["chatDelegationSteps"]["finishOwnedDispatchWithResponse"]
        >[0];
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
        const waitingProjectionStatus = pendingScopeExpansion
          ? ("waiting_for_approval" as const)
          : traceStatus === "queued" ||
              traceStatus === "running" ||
              traceStatus === "waiting_for_approval" ||
              traceStatus === "waiting_for_tool" ||
              traceStatus === "waiting_for_user_input"
            ? traceStatus
            : ("running" as const);
        const subagentPatch = {
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
            waiting: waiting
              ? {
                  status: waitingProjectionStatus,
                  reason: output,
                  childTurnId: responseTurnId,
                  durableRunId: response.trace?.durable?.runId,
                  observedAt,
                }
              : undefined,
          },
        } satisfies Parameters<
          ChatDelegationServiceHost["taskLifecycleService"]["persistDelegationSubagentProjection"]
        >[1];
        const completionRouting = response.routing ?? response.trace?.routing;
        const aggregateTrace = completionRouting ? { ...(trace ?? {}), ...completionRouting } : trace;
        let completedStep: ChatDelegationStepRecord;
        if (waiting) {
          const committedOutcome = deps.storage.runImmediateTransaction(() => {
            const locks = lockDelegationAggregateTruth(deps, runId, task.taskId, agentSessionId);
            const waitingStep = deps.storage.chatDelegationSteps.finishOwnedDispatchWithResponse(responseCommitInput);
            if (!waitingStep) {
              return undefined;
            }
            attachDelegationChildWatcher(deps, {
              parentRunId: input.policyRunId,
              childRunId: response.trace?.durable?.runId,
              watcherId: `delegation-child:${step.stepId}`,
              delegationRunId: runId,
              stepId: step.stepId,
              childSessionId: agentSessionId,
              childTurnId: responseTurnId,
            });
            const releasedStep = deps.storage.chatDelegationSteps.releaseOwnedWaitingDispatch({
              stepId: step.stepId,
              expectedDispatchToken: dispatchLease.dispatchMarker,
              childSessionId: agentSessionId,
              childTurnId: responseTurnId,
            });
            if (!releasedStep) {
              throw new DelegationDispatchOwnershipError(step.stepId);
            }
            const subagentProjection = deps.taskLifecycleService.persistDelegationSubagentProjection(
              agentSessionId,
              subagentPatch,
            );
            const aggregate = persistDelegationAggregateFromLockedTruth(
              deps,
              { runId, taskId: task.taskId, trace: aggregateTrace, observedAt },
              locks,
            );
            return { step: releasedStep, subagentProjection, aggregate };
          });
          if (!committedOutcome) {
            const current = deps.storage.chatDelegationSteps.get(step.stepId);
            return {
              step: current,
              output: current.output,
              citations: current.citations ?? [],
              completed: current.status === "completed",
            };
          }
          completedStep = committedOutcome.step;
          ownsAnyOutcome = true;
          ownsTerminalSummary ||= committedOutcome.aggregate.summaryCreated;
          publishDelegationPostCommitSafely("subagent projection", () =>
            deps.taskLifecycleService.publishDelegationSubagentProjection(committedOutcome.subagentProjection),
          );
          publishDelegationAggregateCommit(deps, committedOutcome.aggregate);
        } else {
          const activityInput = {
            activityType: incomplete ? ("diagnostic" as const) : ("handoff" as const),
            agentId: step.role,
            message: incomplete
              ? `${step.role} ${cancelled ? "cancelled" : "failed"} delegation step ${step.index + 1}/${delegationSteps.length}.`
              : `${step.role} completed delegation step ${step.index + 1}/${delegationSteps.length}.`,
            metadata: {
              runId,
              childRunId,
              stepId: step.stepId,
              childSessionId: agentSessionId,
              childTurnId: responseTurnId,
              durableRunId: response.trace?.durable?.runId,
              handoffEvidence,
            },
          };
          const deliverableInput = !incomplete
            ? {
                deliverableType: "artifact" as const,
                title: `${toTitleCase(step.role)} step`,
                description: output.slice(0, 6000),
              }
            : undefined;
          const committedOutcome = deps.storage.runImmediateTransaction(() => {
            const locks = lockDelegationAggregateTruth(deps, runId, task.taskId, agentSessionId);
            const terminalStep = deps.storage.chatDelegationSteps.finishOwnedDispatchWithResponse(responseCommitInput);
            if (!terminalStep) {
              return undefined;
            }
            attachDelegationChildWatcher(deps, {
              parentRunId: input.policyRunId,
              childRunId: response.trace?.durable?.runId,
              watcherId: `delegation-child:${step.stepId}`,
              delegationRunId: runId,
              stepId: step.stepId,
              childSessionId: agentSessionId,
              childTurnId: responseTurnId,
            });
            const subagentProjection = deps.taskLifecycleService.persistDelegationSubagentProjection(
              agentSessionId,
              subagentPatch,
            );
            const activity = deps.taskLifecycleService.persistDelegationActivity(
              task.taskId,
              activityInput,
              observedAt,
            );
            const deliverable = deliverableInput
              ? deps.taskLifecycleService.persistDelegationDeliverable(task.taskId, deliverableInput, observedAt)
              : undefined;
            const aggregate = persistDelegationAggregateFromLockedTruth(
              deps,
              { runId, taskId: task.taskId, trace: aggregateTrace, observedAt },
              locks,
            );
            return { step: terminalStep, subagentProjection, activity, deliverable, aggregate };
          });
          if (!committedOutcome) {
            const current = deps.storage.chatDelegationSteps.get(step.stepId);
            return {
              step: current,
              output: current.output,
              citations: current.citations ?? [],
              completed: current.status === "completed",
            };
          }
          completedStep = committedOutcome.step;
          ownsAnyOutcome = true;
          ownsTerminalSummary ||= committedOutcome.aggregate.summaryCreated;
          publishDelegationPostCommitSafely("subagent projection", () =>
            deps.taskLifecycleService.publishDelegationSubagentProjection(committedOutcome.subagentProjection),
          );
          publishDelegationPostCommitSafely("step activity", () =>
            deps.taskLifecycleService.publishDelegationActivity(committedOutcome.activity),
          );
          if (committedOutcome.deliverable) {
            publishDelegationPostCommitSafely("step deliverable", () =>
              deps.taskLifecycleService.publishDelegationDeliverable(committedOutcome.deliverable!),
            );
          }
          publishDelegationAggregateCommit(deps, committedOutcome.aggregate);
          await callbacks?.onStep?.(completedStep);
        }
        if (!incomplete && !waiting) {
          completedOutputs.set(step.stepId, {
            role: step.role,
            output: output.slice(0, 4000),
          });
        }
        if (completionRouting) {
          trace = aggregateTrace;
        }
        return {
          step: completedStep,
          output,
          citations: response.citations ?? [],
          trace: completionRouting,
          completed: !incomplete && !waiting,
        };
      } catch (error) {
        if (isAuthoritativeModelUsageAccountingError(error)) {
          const authoritativeTimeout = error instanceof SubagentBudgetError && error.code === "timeout_exceeded";
          timeoutFailureFenceState = authoritativeTimeout ? "won" : "lost";
          if (authoritativeTimeout && bufferedLateSettle) {
            const lateSettle = bufferedLateSettle;
            bufferedLateSettle = undefined;
            scheduleLateSettleRecord?.(lateSettle);
          } else if (!authoritativeTimeout) {
            bufferedLateSettle = undefined;
          }
          throw error;
        }
        if (error instanceof DelegationDispatchOwnershipError) {
          const current = deps.storage.chatDelegationSteps.get(step.stepId);
          return {
            step: current,
            output: current.output,
            citations: current.citations ?? [],
            completed: current.status === "completed",
          };
        }
        const finishedAt = new Date().toISOString();
        const message = formatUnknownError(error);
        const aborted = isChatDelegationAbortError(error, options.abortSignal);
        const isBudgetError = error instanceof SubagentBudgetError;
        const budgetCode = isBudgetError ? error.code : undefined;
        const isTimeoutFailure = isBudgetError && budgetCode === "timeout_exceeded";
        const status = aborted ? "cancelled" : "failed";
        const summary = aborted
          ? "Child cancelled."
          : isBudgetError
            ? budgetCode === "timeout_exceeded"
              ? "Child timed out."
              : "Maximum delegation depth exceeded."
            : undefined;
        const failureGuidance = buildDelegationFailureGuidance(message, step.role);
        const durationMs = Math.max(0, Date.parse(finishedAt) - Date.parse(startedAt));
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
        const failureSubagentPatch = registeredAgentSessionId
          ? {
              status: aborted ? ("killed" as const) : ("failed" as const),
              endedAt: finishedAt,
              metadata: {
                ...childMetadataBase,
                heartbeatAt: finishedAt,
                failureClass: aborted
                  ? ("other" as const)
                  : isBudgetError
                    ? budgetCode === "timeout_exceeded"
                      ? ("timeout" as const)
                      : ("spawn_failure" as const)
                    : ("crash" as const),
                diagnostics: subagentDiagnostics.length > 0 ? subagentDiagnostics : undefined,
                waiting: undefined,
              },
            }
          : undefined;
        let committedFailure:
          | {
              step: ChatDelegationStepRecord;
              subagentProjection?: TaskSubagentSession;
              activity: TaskActivityRecord;
              aggregate: DelegationAggregateCommitResult;
            }
          | undefined;
        try {
          committedFailure = deps.storage.runImmediateTransaction(() => {
            const locks = lockDelegationAggregateTruth(deps, runId, task.taskId, registeredAgentSessionId);
            const failedStep = dispatchOwnership
              ? deps.storage.chatDelegationSteps.finishOwnedDispatchWithError({
                  stepId: step.stepId,
                  expectedDispatchToken: dispatchOwnership.token,
                  expectedChildSessionId: dispatchOwnership.childSessionId,
                  status,
                  label: step.role,
                  summary,
                  error: message,
                  failureGuidance,
                  finishedAt,
                  durationMs,
                })
              : deps.storage.chatDelegationSteps.finishUnclaimedPendingWithError({
                  stepId: step.stepId,
                  status,
                  label: step.role,
                  error: message,
                  summary,
                  failureGuidance,
                  finishedAt,
                  durationMs,
                });
            if (!failedStep) {
              return undefined;
            }
            const subagentProjection =
              registeredAgentSessionId && failureSubagentPatch
                ? deps.taskLifecycleService.persistDelegationSubagentProjection(
                    registeredAgentSessionId,
                    failureSubagentPatch,
                  )
                : undefined;
            const activity = deps.taskLifecycleService.persistDelegationActivity(
              task.taskId,
              {
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
              },
              finishedAt,
            );
            const aggregate = persistDelegationAggregateFromLockedTruth(
              deps,
              { runId, taskId: task.taskId, trace, observedAt: finishedAt },
              locks,
            );
            return { step: failedStep, subagentProjection, activity, aggregate };
          });
        } catch (commitError) {
          timeoutFailureFenceState = "lost";
          bufferedLateSettle = undefined;
          throw commitError;
        }
        if (!committedFailure) {
          timeoutFailureFenceState = "lost";
          bufferedLateSettle = undefined;
          const current = deps.storage.chatDelegationSteps.get(step.stepId);
          return {
            step: current,
            output: current.output,
            citations: current.citations ?? [],
            completed: current.status === "completed",
          };
        }
        timeoutFailureFenceState = isTimeoutFailure ? "won" : "lost";
        if (timeoutFailureFenceState === "won" && bufferedLateSettle) {
          const lateSettle = bufferedLateSettle;
          bufferedLateSettle = undefined;
          scheduleLateSettleRecord?.(lateSettle);
        } else if (timeoutFailureFenceState === "lost") {
          bufferedLateSettle = undefined;
        }
        if (committedFailure.subagentProjection) {
          publishDelegationPostCommitSafely("subagent projection", () =>
            deps.taskLifecycleService.publishDelegationSubagentProjection(committedFailure.subagentProjection!),
          );
        }
        ownsAnyOutcome = true;
        ownsTerminalSummary ||= committedFailure.aggregate.summaryCreated;
        publishDelegationPostCommitSafely("step failure activity", () =>
          deps.taskLifecycleService.publishDelegationActivity(committedFailure.activity),
        );
        publishDelegationAggregateCommit(deps, committedFailure.aggregate);
        await callbacks?.onStep?.(committedFailure.step);
        return {
          step: committedFailure.step,
          output: message,
          citations: [],
          completed: false,
        };
      }
    };

    for (const stage of stages) {
      const runnableSteps: NormalizedDelegationStep[] = [];
      for (const step of stage) {
        const persistedStep = stepResults.get(step.stepId)?.step;
        if (persistedStep && persistedStep.status !== "pending" && persistedStep.status !== "running") {
          continue;
        }
        const expectedTurnId = buildStableDelegationTurnIdentity(runId, step.stepId).turnId;
        const databaseNowMs = Date.parse(deps.storage.chatDelegationSteps.readDatabaseNow());
        const dispatchClaim = persistedStep
          ? deps.storage.chatDelegationSteps.getDispatchClaim(persistedStep.stepId)
          : undefined;
        if (
          persistedStep &&
          !isDelegationStepDispatchRecoverable(persistedStep, dispatchClaim, expectedTurnId, databaseNowMs)
        ) {
          continue;
        }
        const snapshotDependencies = step.dependsOnStepIds
          .map((dependencyStepId) => stepResults.get(dependencyStepId)?.step)
          .filter((dependency): dependency is ChatDelegationStepRecord => Boolean(dependency));
        const snapshotDependenciesAreComplete =
          snapshotDependencies.length === step.dependsOnStepIds.length &&
          snapshotDependencies.every((dependency) => dependency.status === "completed");
        if (snapshotDependenciesAreComplete) {
          runnableSteps.push(step);
          continue;
        }
        const observedAt = deps.storage.chatDelegationSteps.readDatabaseNow();
        const dependencyResolution = deps.storage.runImmediateTransaction(() => {
          const locks = lockDelegationAggregateTruth(deps, runId, task.taskId);
          const lockedStepById = new Map(locks.persistedSteps.map((lockedStep) => [lockedStep.stepId, lockedStep]));
          const lockedDependencies = step.dependsOnStepIds
            .map((dependencyStepId) => lockedStepById.get(dependencyStepId))
            .filter((dependency): dependency is ChatDelegationStepRecord => Boolean(dependency));
          const hasMissingOrActiveDependency =
            lockedDependencies.length !== step.dependsOnStepIds.length ||
            lockedDependencies.some((dependency) => dependency.status === "running" || dependency.status === "pending");
          if (hasMissingOrActiveDependency) {
            return { kind: "waiting" as const, dependencies: lockedDependencies };
          }
          const lockedFailedDependencies = lockedDependencies.filter(
            (dependency) =>
              dependency.status === "failed" || dependency.status === "skipped" || dependency.status === "cancelled",
          );
          if (lockedFailedDependencies.length === 0) {
            return { kind: "runnable" as const, dependencies: lockedDependencies };
          }
          const failedDependencyRoles = lockedFailedDependencies.map((dependency) => dependency.role);
          const skippedStep = deps.storage.chatDelegationSteps.finishUnclaimedPendingWithError({
            stepId: step.stepId,
            status: "skipped",
            error: `Skipped because dependency did not complete: ${failedDependencyRoles.join(", ")}`,
            failureGuidance: buildDelegationFailureGuidance(
              `Blocked by incomplete dependency from ${failedDependencyRoles.join(", ")}`,
              step.role,
            ),
            finishedAt: observedAt,
            durationMs: 0,
          });
          if (!skippedStep) {
            return { kind: "stale" as const, dependencies: lockedDependencies };
          }
          const activity = deps.taskLifecycleService.persistDelegationActivity(
            task.taskId,
            {
              activityType: "comment",
              agentId: step.role,
              message: `${step.role} skipped delegation step ${step.index + 1}/${delegationSteps.length} due to incomplete dependency.`,
              metadata: {
                runId,
                stepId: step.stepId,
                failedDependencyStepIds: lockedFailedDependencies.map((dependency) => dependency.stepId),
              },
            },
            observedAt,
          );
          const aggregate = persistDelegationAggregateFromLockedTruth(
            deps,
            { runId, taskId: task.taskId, trace, observedAt },
            locks,
          );
          return {
            kind: "skipped" as const,
            dependencies: lockedDependencies,
            step: skippedStep,
            activity,
            aggregate,
          };
        });
        for (const dependency of dependencyResolution.dependencies) {
          stepResults.set(dependency.stepId, {
            step: dependency,
            output: dependency.output,
            citations: dependency.citations ?? [],
            completed: dependency.status === "completed",
          });
          if (dependency.status === "completed" && dependency.output?.trim()) {
            completedOutputs.set(dependency.stepId, {
              role: dependency.role,
              output: dependency.output.slice(0, 4000),
            });
          }
        }
        if (dependencyResolution.kind === "runnable") {
          runnableSteps.push(step);
          continue;
        }
        if (dependencyResolution.kind === "waiting") {
          continue;
        }
        if (dependencyResolution.kind === "stale") {
          const current = deps.storage.chatDelegationSteps.get(step.stepId);
          stepResults.set(step.stepId, {
            step: current,
            output: current.output,
            citations: current.citations ?? [],
            completed: current.status === "completed",
          });
          continue;
        }
        publishDelegationPostCommitSafely("dependency resolution activity", () =>
          deps.taskLifecycleService.publishDelegationActivity(dependencyResolution.activity),
        );
        ownsAnyOutcome = true;
        ownsTerminalSummary ||= dependencyResolution.aggregate.summaryCreated;
        publishDelegationAggregateCommit(deps, dependencyResolution.aggregate);
        await callbacks?.onStep?.(dependencyResolution.step);
        stepResults.set(step.stepId, {
          step: dependencyResolution.step,
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

    const repairedAggregate = deps.storage.runImmediateTransaction(() => {
      const locks = lockDelegationAggregateTruth(deps, runId, task.taskId);
      const projection = deriveDelegationAggregate(locks.persistedSteps);
      if (!hasDelegationAggregateDrift(locks, projection)) {
        return undefined;
      }
      return persistDelegationAggregateFromLockedTruth(
        deps,
        {
          runId,
          taskId: task.taskId,
          trace: locks.parent.trace,
          observedAt: deps.storage.chatDelegationSteps.readDatabaseNow(),
        },
        locks,
      );
    });
    if (repairedAggregate) {
      ownsAnyOutcome ||= repairedAggregate.summaryCreated;
      ownsTerminalSummary ||= repairedAggregate.summaryCreated;
      publishDelegationAggregateCommit(deps, repairedAggregate);
    }

    const parent = deps.storage.chatDelegationRuns.get(runId);
    const persistedSteps = deps.storage.chatDelegationSteps.listByRun(runId);
    const projection = deriveDelegationAggregate(persistedSteps);
    const stitchedOutput = parent.stitchedOutput ?? projection.stitchedOutput;
    const citations = parent.citations.length > 0 ? parent.citations : projection.citations;
    const status = parent.status;
    if (ownsAnyOutcome) {
      deps.extractAndPersistLearnedMemory(sessionId, objective, {
        role: "user",
        sourceRef: runId,
      });
    }
    if (ownsTerminalSummary && status === "completed" && stitchedOutput.trim()) {
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
      trace: parent.trace ?? trace,
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

interface DelegationAggregateCommitResult {
  persistedSteps: ChatDelegationStepRecord[];
  stitchedOutput: string;
  citations: ChatCitationRecord[];
  status: ChatDelegationRunRecord["status"];
  completedSteps: number;
  activeChildCount: number;
  committedTask: TaskRecord;
  aggregatePersisted: boolean;
  transitionedPendingSteps: number;
  summaryActivity?: TaskActivityRecord;
  summaryCreated: boolean;
}

interface DelegationAggregateLocks {
  parent: ChatDelegationRunRecord;
  persistedSteps: ChatDelegationStepRecord[];
  task: TaskRecord;
  subagent?: TaskSubagentSession;
}

type StableTerminalDelegationReplay =
  | { kind: "resume" }
  | {
      kind: "terminal";
      persistedSteps: ChatDelegationStepRecord[];
      projection: ReturnType<typeof deriveDelegationAggregate>;
      committedAggregate?: DelegationAggregateCommitResult;
      summaryReceipt?: { activity: TaskActivityRecord; created: boolean };
    };

function resolveStableTerminalDelegationReplay(
  deps: ChatDelegationServiceHost,
  runId: string,
  taskId: string,
  requestedSteps: readonly NormalizedDelegationStep[],
): StableTerminalDelegationReplay {
  return deps.storage.runImmediateTransaction(() => {
    const locks = lockDelegationAggregateTruth(deps, runId, taskId);
    rebuildResumableDelegationPlan(locks.persistedSteps, requestedSteps);
    const projection = deriveDelegationAggregate(locks.persistedSteps);
    if (projection.status === "running") {
      return { kind: "resume" };
    }
    const observedAt = deps.storage.chatDelegationSteps.readDatabaseNow();
    if (hasDelegationAggregateDrift(locks, projection)) {
      const committedAggregate = persistDelegationAggregateFromLockedTruth(
        deps,
        {
          runId,
          taskId,
          trace: locks.parent.trace,
          observedAt,
        },
        locks,
      );
      return {
        kind: "terminal",
        persistedSteps: committedAggregate.persistedSteps,
        projection: committedAggregate,
        committedAggregate,
      };
    }
    return {
      kind: "terminal",
      persistedSteps: locks.persistedSteps,
      projection,
      summaryReceipt: persistDelegationSummaryOnce(
        deps,
        runId,
        taskId,
        locks.persistedSteps,
        projection.status,
        observedAt,
      ),
    };
  });
}

function commitDelegationAggregate(
  deps: ChatDelegationServiceHost,
  input: {
    runId: string;
    taskId: string;
    trace?: ChatTurnTraceRecord["routing"];
    observedAt: string;
    preDispatchFailure?: string;
  },
): DelegationAggregateCommitResult {
  const committed = deps.storage.runImmediateTransaction(() => {
    const locks = lockDelegationAggregateTruth(deps, input.runId, input.taskId);
    return persistDelegationAggregateFromLockedTruth(deps, input, locks);
  });
  publishDelegationAggregateCommit(deps, committed);
  return committed;
}

function publishDelegationAggregateCommit(
  deps: ChatDelegationServiceHost,
  committed: DelegationAggregateCommitResult,
): void {
  if (committed.aggregatePersisted) {
    publishDelegationPostCommitSafely("aggregate task", () =>
      deps.taskLifecycleService.publishDelegationAggregateTask(committed.committedTask),
    );
  }
  if (committed.summaryCreated && committed.summaryActivity) {
    publishDelegationPostCommitSafely("terminal summary", () =>
      deps.taskLifecycleService.publishDelegationActivity(committed.summaryActivity!),
    );
  }
}

function publishDelegationPostCommitSafely(label: string, publish: () => void): void {
  try {
    publish();
  } catch (error) {
    try {
      process.stderr.write(
        `[chat-delegation] ${label} publication failed after commit: ${formatUnknownError(error)}\n`,
      );
    } catch {
      // Canonical database truth is already committed; diagnostics are best-effort too.
    }
  }
}

function lockDelegationAggregateTruth(
  deps: ChatDelegationServiceHost,
  runId: string,
  taskId: string,
  agentSessionId?: string,
): DelegationAggregateLocks {
  const parent = deps.storage.chatDelegationRuns.getForUpdate(runId);
  const persistedSteps = deps.storage.chatDelegationSteps.listByRunForUpdate(runId);
  const task = deps.taskLifecycleService.lockTaskForDelegationAggregate(taskId) as TaskRecord;
  const subagent = agentSessionId
    ? deps.taskLifecycleService.lockDelegationSubagentProjection(agentSessionId)
    : undefined;
  return { parent, persistedSteps, task, subagent };
}

function hasDelegationAggregateDrift(
  locks: DelegationAggregateLocks,
  projection: ReturnType<typeof deriveDelegationAggregate>,
): boolean {
  // A running projection can legitimately be newer than the last published
  // parent snapshot while another dispatch owner is still active. Only a
  // terminal projection is safe for a non-owner wake to repair.
  if (projection.status === "running") {
    return false;
  }
  const parentDrifted =
    locks.parent.status !== projection.status ||
    (locks.parent.stitchedOutput ?? "") !== projection.stitchedOutput ||
    JSON.stringify(locks.parent.citations) !== JSON.stringify(projection.citations) ||
    locks.parent.finishedAt === undefined;
  if (parentDrifted) {
    return true;
  }

  const authoritativeTaskStatus = locks.task.agenticContext?.status;
  if (authoritativeTaskStatus === "paused" || authoritativeTaskStatus === "cancelled") {
    return false;
  }
  const expectedTaskStatus = projection.completedSteps > 0 && projection.status === "completed" ? "review" : "blocked";
  const expectedAgenticStatus = projection.status === "completed" ? "completed" : "failed";
  const expectedFailureClass = projection.status === "completed" ? undefined : "missing_handoff";
  return (
    locks.task.status !== expectedTaskStatus ||
    authoritativeTaskStatus !== expectedAgenticStatus ||
    locks.task.agenticContext?.failureClass !== expectedFailureClass
  );
}

function persistDelegationAggregateFromLockedTruth(
  deps: ChatDelegationServiceHost,
  input: {
    runId: string;
    taskId: string;
    trace?: ChatTurnTraceRecord["routing"];
    observedAt: string;
    preDispatchFailure?: string;
  },
  locks: DelegationAggregateLocks,
): DelegationAggregateCommitResult {
  let persistedSteps = locks.persistedSteps;
  let transitionedPendingSteps = 0;
  if (input.preDispatchFailure) {
    for (const step of persistedSteps) {
      if (step.status !== "pending") {
        continue;
      }
      const transitioned = deps.storage.chatDelegationSteps.finishUnclaimedPendingWithError({
        stepId: step.stepId,
        status: "failed",
        label: step.role,
        summary: "Child failed before dispatch.",
        error: input.preDispatchFailure,
        failureGuidance: buildDelegationFailureGuidance(input.preDispatchFailure, step.role),
        finishedAt: input.observedAt,
        durationMs: Math.max(0, Date.parse(input.observedAt) - Date.parse(step.startedAt)),
      });
      if (transitioned) {
        transitionedPendingSteps += 1;
      }
    }
  }
  // Refresh already-locked step truth after an outcome CAS in this transaction.
  persistedSteps = deps.storage.chatDelegationSteps.listByRunForUpdate(input.runId);
  const projection = deriveDelegationAggregate(persistedSteps);
  if (input.preDispatchFailure && transitionedPendingSteps === 0) {
    return {
      ...projection,
      persistedSteps,
      committedTask: locks.task,
      aggregatePersisted: false,
      transitionedPendingSteps,
      summaryCreated: false,
    };
  }
  deps.storage.chatDelegationRuns.patch(input.runId, {
    status: projection.status,
    stitchedOutput: projection.stitchedOutput,
    citations: projection.citations,
    trace: input.trace ?? locks.parent.trace,
    ...(projection.status === "running" ? { clearFinishedAt: true } : { finishedAt: input.observedAt }),
  });
  const authoritativeTaskStatus = locks.task.agenticContext?.status;
  const preservesOperatorControl = authoritativeTaskStatus === "paused" || authoritativeTaskStatus === "cancelled";
  const committedTask = deps.taskLifecycleService.persistDelegationAggregateTask(input.taskId, {
    status: preservesOperatorControl
      ? locks.task.status
      : projection.status === "running"
        ? "in_progress"
        : projection.completedSteps > 0 && projection.status === "completed"
          ? "review"
          : "blocked",
    agenticContext: {
      status: preservesOperatorControl
        ? authoritativeTaskStatus
        : projection.status === "running"
          ? "running"
          : projection.status === "completed"
            ? "completed"
            : "failed",
      activeChildCount: projection.activeChildCount,
      failureClass: preservesOperatorControl
        ? locks.task.agenticContext?.failureClass
        : projection.status === "running" || projection.status === "completed"
          ? undefined
          : "missing_handoff",
      handoffEvidence:
        projection.status !== "running" && projection.stitchedOutput.trim()
          ? [
              {
                summary: projection.stitchedOutput.slice(0, 1000),
                artifactRefs: persistedSteps
                  .filter((step) => step.status === "completed")
                  .map((step) => `delegation-step:${step.stepId}`),
                createdAt: input.observedAt,
              },
            ]
          : undefined,
    },
  });
  const summaryReceipt = persistDelegationSummaryOnce(
    deps,
    input.runId,
    input.taskId,
    persistedSteps,
    projection.status,
    input.observedAt,
  );
  return {
    ...projection,
    persistedSteps,
    committedTask,
    aggregatePersisted: true,
    transitionedPendingSteps,
    summaryActivity: summaryReceipt?.activity,
    summaryCreated: summaryReceipt?.created ?? false,
  };
}

function persistDelegationSummaryOnce(
  deps: ChatDelegationServiceHost,
  runId: string,
  taskId: string,
  persistedSteps: ChatDelegationStepRecord[],
  status: ChatDelegationRunRecord["status"],
  observedAt: string,
): { activity: TaskActivityRecord; created: boolean } | undefined {
  if (status === "running") {
    return undefined;
  }
  const counts = {
    completedSteps: persistedSteps.filter((step) => step.status === "completed").length,
    failedSteps: persistedSteps.filter((step) => step.status === "failed").length,
    skippedSteps: persistedSteps.filter((step) => step.status === "skipped").length,
    cancelledSteps: persistedSteps.filter((step) => step.status === "cancelled").length,
    steps: persistedSteps.length,
  };
  const activityInput = {
    activityType: "comment" as const,
    message: `Delegation ${status}.`,
    metadata: { runId, ...counts },
  };
  const legacyActivityId = buildStableDelegationId("delegation-summary-activity", runId);
  try {
    return deps.taskLifecycleService.persistDelegationActivityOnce(legacyActivityId, taskId, activityInput, observedAt);
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes("conflicting payload")) {
      throw error;
    }
  }
  const correctionActivityId = buildStableDelegationId(
    "delegation-summary-activity",
    runId,
    status,
    String(counts.completedSteps),
    String(counts.failedSteps),
    String(counts.skippedSteps),
    String(counts.cancelledSteps),
    String(counts.steps),
  );
  return deps.taskLifecycleService.persistDelegationActivityOnce(
    correctionActivityId,
    taskId,
    activityInput,
    observedAt,
  );
}

function deriveDelegationAggregate(
  persistedSteps: ChatDelegationStepRecord[],
): Omit<
  DelegationAggregateCommitResult,
  | "persistedSteps"
  | "committedTask"
  | "aggregatePersisted"
  | "transitionedPendingSteps"
  | "summaryActivity"
  | "summaryCreated"
> {
  const stitchedOutput = buildDelegationStitchedOutput(persistedSteps);
  const completedSteps = persistedSteps.filter((step) => step.status === "completed").length;
  const failedStepsWithPartialOutput = persistedSteps.filter(
    (step) => step.status === "failed" && Boolean(step.output?.trim()),
  ).length;
  const unfinishedSteps = persistedSteps.filter(
    (step) => step.status === "running" || step.status === "pending",
  ).length;
  const terminalSteps = persistedSteps.filter(
    (step) =>
      step.status === "completed" ||
      step.status === "failed" ||
      step.status === "skipped" ||
      step.status === "cancelled",
  ).length;
  const status: ChatDelegationRunRecord["status"] =
    unfinishedSteps > 0
      ? "running"
      : persistedSteps.length > 0 && terminalSteps === persistedSteps.length && completedSteps === persistedSteps.length
        ? "completed"
        : completedSteps > 0 || failedStepsWithPartialOutput > 0
          ? "partial"
          : "failed";
  const citationsById = new Map<string, ChatCitationRecord>();
  for (const citation of persistedSteps.flatMap((step) => step.citations ?? [])) {
    citationsById.set(citation.citationId, citation);
  }
  return {
    stitchedOutput,
    citations: [...citationsById.values()],
    status,
    completedSteps,
    activeChildCount: persistedSteps.filter((step) => step.status === "running").length,
  };
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

function buildStableDelegationId(prefix: string, ...parts: string[]): string {
  const digest = createHash("sha256")
    .update(parts.map((part) => `${part.length}:${part}`).join("|"))
    .digest("hex")
    .slice(0, 32);
  return `${prefix}-${digest}`;
}

function stabilizeDelegationPlan(
  runId: string,
  requestedSteps: readonly NormalizedDelegationStep[],
): NormalizedDelegationStep[] {
  const stableStepIdByRequestedId = new Map(
    requestedSteps.map((step) => [
      step.stepId,
      buildStableDelegationId("delegation-step", runId, String(step.index), step.role),
    ]),
  );
  return requestedSteps.map((step) => ({
    ...step,
    stepId: stableStepIdByRequestedId.get(step.stepId)!,
    dependsOnStepIds: step.dependsOnStepIds.map(
      (dependencyStepId) => stableStepIdByRequestedId.get(dependencyStepId) ?? dependencyStepId,
    ),
  }));
}

function createOrLoadStableDelegationTask(
  deps: ChatDelegationServiceHost,
  taskId: string,
  input: Parameters<ChatDelegationServiceHost["taskLifecycleService"]["createTask"]>[0],
): { taskId: string } {
  try {
    return deps.taskLifecycleService.createTask(input, { taskId });
  } catch (createError) {
    let existing: ReturnType<ChatDelegationServiceHost["taskLifecycleService"]["getTask"]> | undefined;
    try {
      existing = deps.taskLifecycleService.getTask(taskId);
    } catch {
      // Preserve the original create failure when no canonical task owns the stable identity.
    }
    if (existing?.taskId === taskId) {
      assertStableDelegationTaskMatches(existing, input);
      return existing;
    }
    throw createError;
  }
}

function assertStableDelegationTaskMatches(
  task: ReturnType<ChatDelegationServiceHost["taskLifecycleService"]["getTask"]>,
  expected: Parameters<ChatDelegationServiceHost["taskLifecycleService"]["createTask"]>[0],
): void {
  const taskContext = task.agenticContext;
  const expectedContext = expected.agenticContext;
  const matches =
    task.workspaceId === expected.workspaceId &&
    task.title === expected.title &&
    task.description === expected.description &&
    taskContext?.runId === expectedContext?.runId &&
    taskContext?.parentRunId === expectedContext?.parentRunId &&
    JSON.stringify(taskContext?.childRunIds ?? []) === JSON.stringify(expectedContext?.childRunIds ?? []);
  if (!matches) {
    throw new Error(`Stable delegation task ${task.taskId} is already owned by a different persisted plan.`);
  }
}

interface DelegationDispatchMarker {
  kind: "claim" | "dispatch";
  expiresAtMs: number;
  turnId: string;
}

interface DelegationDispatchLease {
  step: ChatDelegationStepRecord;
  claimMarker?: string;
  childSessionId?: string;
  dispatchMarker: string;
  dispatchExpiresAt: string;
}

function buildStableDelegationTurnIdentity(runId: string, stepId: string): DelegationTurnIdentity {
  return {
    turnId: buildStableDelegationId("delegation-turn", runId, stepId),
    userMessageId: buildStableDelegationId("delegation-user", runId, stepId),
    assistantMessageId: buildStableDelegationId("delegation-assistant", runId, stepId),
  };
}

function buildDelegationDispatchMarker(
  kind: DelegationDispatchMarker["kind"],
  turnId: string,
  expiresAtMs: number,
): string {
  return `delegation-${kind}:v1:${Math.trunc(expiresAtMs)}:${turnId}:${randomUUID()}`;
}

function parseDelegationDispatchMarker(value: string | undefined): DelegationDispatchMarker | undefined {
  if (!value) {
    return undefined;
  }
  const match = /^delegation-(claim|dispatch):v1:(\d+):([^:]+):([^:]+)$/.exec(value);
  if (!match) {
    return undefined;
  }
  const expiresAtMs = Number(match[2]);
  if (!Number.isSafeInteger(expiresAtMs)) {
    return undefined;
  }
  return {
    kind: match[1] as DelegationDispatchMarker["kind"],
    expiresAtMs,
    turnId: match[3]!,
  };
}

function acquireDelegationDispatchLease(
  deps: ChatDelegationServiceHost,
  input: {
    stepId: string;
    turnIdentity: DelegationTurnIdentity;
    startedAt: string;
    leaseDurationMs: number;
  },
): DelegationDispatchLease | undefined {
  const current = deps.storage.chatDelegationSteps.get(input.stepId);
  const nowMs = Date.parse(input.startedAt);
  if (!Number.isFinite(nowMs)) {
    throw new Error("Database did not return a valid delegation dispatch clock.");
  }
  const expiresAtMs = nowMs + input.leaseDurationMs;
  const expiresAt = new Date(expiresAtMs).toISOString();
  const claimMarker = buildDelegationDispatchMarker("claim", input.turnIdentity.turnId, expiresAtMs);
  const dispatchMarker = buildDelegationDispatchMarker("dispatch", input.turnIdentity.turnId, expiresAtMs);
  const existingDispatchClaim = deps.storage.chatDelegationSteps.getDispatchClaim(input.stepId);

  if (current.status === "pending") {
    const claimed = deps.storage.chatDelegationSteps.claimPendingForDispatch(
      input.stepId,
      claimMarker,
      expiresAt,
      input.startedAt,
    );
    return claimed ? { step: claimed, claimMarker, dispatchMarker, dispatchExpiresAt: expiresAt } : undefined;
  }
  if (current.status !== "running") {
    return undefined;
  }

  if (!current.childSessionId && !existingDispatchClaim) {
    const reclaimed = deps.storage.chatDelegationSteps.reclaimRunningForDispatch(
      input.stepId,
      undefined,
      claimMarker,
      expiresAt,
      input.startedAt,
    );
    return reclaimed ? { step: reclaimed, claimMarker, dispatchMarker, dispatchExpiresAt: expiresAt } : undefined;
  }

  if (!current.childSessionId && existingDispatchClaim) {
    const existingClaim = parseDelegationDispatchMarker(existingDispatchClaim.token);
    if (existingClaim?.kind !== "claim") {
      throw new Error(`Delegation step ${input.stepId} has an invalid unlinked dispatch claim.`);
    }
    assertDelegationMarkerTurn(existingClaim, input.turnIdentity.turnId, input.stepId);
    if (Date.parse(existingDispatchClaim.expiresAt) > nowMs) {
      return undefined;
    }
    const reclaimed = deps.storage.chatDelegationSteps.reclaimRunningForDispatch(
      input.stepId,
      existingDispatchClaim.token,
      claimMarker,
      expiresAt,
      input.startedAt,
    );
    return reclaimed ? { step: reclaimed, claimMarker, dispatchMarker, dispatchExpiresAt: expiresAt } : undefined;
  }

  if (!current.childSessionId) {
    return undefined;
  }
  if (current.childTurnId && current.childTurnId !== input.turnIdentity.turnId) {
    return undefined;
  }
  assertCanonicalDelegationTurnIfPresent(deps, input.turnIdentity, current.childSessionId);
  if (existingDispatchClaim) {
    const existingDispatch = parseDelegationDispatchMarker(existingDispatchClaim.token);
    if (existingDispatch?.kind !== "dispatch") {
      throw new Error(`Delegation step ${input.stepId} has an invalid linked dispatch claim.`);
    }
    assertDelegationMarkerTurn(existingDispatch, input.turnIdentity.turnId, input.stepId);
    if (Date.parse(existingDispatchClaim.expiresAt) > nowMs) {
      return undefined;
    }
    const reclaimed = deps.storage.chatDelegationSteps.reclaimLinkedDispatch(
      input.stepId,
      current.childSessionId,
      existingDispatchClaim.token,
      dispatchMarker,
      expiresAt,
      input.startedAt,
    );
    return reclaimed
      ? {
          step: reclaimed,
          childSessionId: current.childSessionId,
          dispatchMarker,
          dispatchExpiresAt: expiresAt,
        }
      : undefined;
  }
  const claimed = deps.storage.chatDelegationSteps.claimLinkedForDispatch(
    input.stepId,
    current.childSessionId,
    current.childTurnId === input.turnIdentity.turnId ? current.childTurnId : undefined,
    dispatchMarker,
    expiresAt,
    input.startedAt,
  );
  return claimed
    ? {
        step: claimed,
        childSessionId: current.childSessionId,
        dispatchMarker,
        dispatchExpiresAt: expiresAt,
      }
    : undefined;
}

function assertDelegationMarkerTurn(marker: DelegationDispatchMarker, turnId: string, stepId: string): void {
  if (marker.turnId !== turnId) {
    throw new Error(`Delegation step ${stepId} dispatch marker belongs to unexpected turn ${marker.turnId}.`);
  }
}

function assertCanonicalDelegationTurnIfPresent(
  deps: ChatDelegationServiceHost,
  identity: DelegationTurnIdentity,
  childSessionId: string,
): void {
  try {
    const trace = deps.storage.chatTurnTraces.get(identity.turnId);
    if (trace.sessionId !== childSessionId || trace.userMessageId !== identity.userMessageId) {
      throw new Error(`Canonical delegated turn ${identity.turnId} does not match child session linkage.`);
    }
  } catch (error) {
    if (error instanceof NotFoundError) {
      return;
    }
    throw error;
  }
}

function assertDelegationDispatchOwnership(
  deps: ChatDelegationServiceHost,
  stepId: string,
  childSessionId: string,
  dispatchMarker: string,
): void {
  if (!deps.storage.chatDelegationSteps.ownsLinkedDispatch(stepId, childSessionId, dispatchMarker)) {
    throw new DelegationDispatchOwnershipError(stepId);
  }
}

function isDelegationStepDispatchRecoverable(
  step: ChatDelegationStepRecord,
  dispatchClaim: { token: string; expiresAt: string } | undefined,
  expectedTurnId: string,
  nowMs: number,
): boolean {
  if (step.status === "pending") {
    return true;
  }
  if (step.status !== "running") {
    return false;
  }
  if (dispatchClaim) {
    return Date.parse(dispatchClaim.expiresAt) <= nowMs;
  }
  if (!step.childSessionId || !step.childTurnId) {
    return true;
  }
  return step.childTurnId === expectedTurnId;
}

function findStableParentDelegationRun(
  deps: ChatDelegationServiceHost,
  input: {
    sessionId: string;
    policyRunId?: string;
    objective: string;
    mode: "sequential" | "parallel";
    roles: string[];
  },
): ChatDelegationRunRecord | undefined {
  const parentRunId = input.policyRunId?.trim();
  if (!parentRunId || !deps.storage.chatDelegationRuns.listRecent) {
    return undefined;
  }
  const existing = deps.storage.chatDelegationRuns
    .listRecent({ sessionId: input.sessionId, parentRunId, limit: 10 })
    .find((run) => run.sessionId === input.sessionId && run.parentRunId === parentRunId);
  if (!existing) {
    return undefined;
  }
  const expectedRoles = dedupeStrings(input.roles);
  if (
    existing.objective !== input.objective ||
    existing.mode !== input.mode ||
    existing.roles.length !== expectedRoles.length ||
    existing.roles.some((role, index) => role !== expectedRoles[index])
  ) {
    throw new Error(
      `Durable parent ${parentRunId} is already linked to delegation ${existing.runId} with a different persisted plan.`,
    );
  }
  return existing;
}

function attachDelegationChildWatcher(
  deps: ChatDelegationServiceHost,
  input: {
    parentRunId?: string;
    childRunId?: string;
    watcherId: string;
    delegationRunId: string;
    stepId: string;
    childSessionId: string;
    childTurnId: string;
  },
): void {
  const parentRunId = input.parentRunId?.trim();
  const childRunId = input.childRunId?.trim();
  if (!deps.watchDurableChildRun || !parentRunId || !childRunId) {
    return;
  }
  deps.watchDurableChildRun({
    parentRunId,
    childRunId,
    watcherId: input.watcherId,
    source: "chat_delegation",
    metadata: {
      delegationRunId: input.delegationRunId,
      stepId: input.stepId,
      childSessionId: input.childSessionId,
      childTurnId: input.childTurnId,
    },
  });
}

function rebuildResumableDelegationPlan(
  existingSteps: readonly ChatDelegationStepRecord[],
  requestedSteps: readonly NormalizedDelegationStep[],
): NormalizedDelegationStep[] {
  if (existingSteps.length === 0) {
    return [...requestedSteps];
  }
  if (existingSteps.length > requestedSteps.length) {
    throw new Error("Persisted delegation plan has more steps than the durable parent plan.");
  }
  const existingByIndex = new Map<number, ChatDelegationStepRecord>();
  const existingIndexById = new Map<string, number>();
  for (const step of existingSteps) {
    if (existingByIndex.has(step.index) || existingIndexById.has(step.stepId)) {
      throw new Error(`Persisted delegation plan has duplicate step index ${step.index}.`);
    }
    const requested = requestedSteps[step.index];
    if (
      !requested ||
      requested.index !== step.index ||
      requested.role !== step.role ||
      requested.parallelizable !== Boolean(step.parallelizable)
    ) {
      throw new Error(`Persisted delegation step ${step.stepId} does not match the durable parent plan.`);
    }
    existingByIndex.set(step.index, step);
    existingIndexById.set(step.stepId, step.index);
  }

  const requestedIndexById = new Map(requestedSteps.map((step) => [step.stepId, step.index] as const));
  const canonicalIndexById = new Map<string, number>(requestedIndexById);
  for (const [stepId, index] of existingIndexById) {
    canonicalIndexById.set(stepId, index);
  }
  const dependencyIndexes = (stepId: string, dependencyIds: readonly string[]): number[] =>
    dependencyIds
      .map((dependencyId) => {
        const dependencyIndex = canonicalIndexById.get(dependencyId);
        if (dependencyIndex === undefined) {
          throw new Error(
            `Persisted delegation step ${stepId} depends on unknown step ${dependencyId} and does not match the durable parent plan.`,
          );
        }
        return dependencyIndex;
      })
      .sort((left, right) => left - right);
  for (const persisted of existingSteps) {
    const requested = requestedSteps[persisted.index]!;
    const persistedDependencies = dependencyIndexes(persisted.stepId, persisted.dependsOnStepIds ?? []);
    const requestedDependencies = dependencyIndexes(requested.stepId, requested.dependsOnStepIds);
    if (
      persistedDependencies.length !== requestedDependencies.length ||
      persistedDependencies.some((dependencyIndex, index) => dependencyIndex !== requestedDependencies[index])
    ) {
      throw new Error(`Persisted delegation step ${persisted.stepId} does not match the durable parent plan.`);
    }
  }
  const actualIdByIndex = new Map(
    requestedSteps.map((step) => [step.index, existingByIndex.get(step.index)?.stepId ?? step.stepId] as const),
  );
  return requestedSteps.map((requested) => {
    const persisted = existingByIndex.get(requested.index);
    const requestedDependencies = requested.dependsOnStepIds.map((dependencyId) => {
      const dependencyIndex = requestedIndexById.get(dependencyId);
      return dependencyIndex === undefined ? dependencyId : (actualIdByIndex.get(dependencyIndex) ?? dependencyId);
    });
    return {
      stepId: persisted?.stepId ?? requested.stepId,
      index: requested.index,
      role: requested.role,
      parallelizable: requested.parallelizable,
      dependsOnStepIds: dedupeStrings(persisted ? (persisted.dependsOnStepIds ?? []) : requestedDependencies),
    };
  });
}

function buildDelegationStitchedOutput(steps: readonly ChatDelegationStepRecord[]): string {
  return steps
    .map((step) => {
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
    })
    .join("\n\n")
    .trim();
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
