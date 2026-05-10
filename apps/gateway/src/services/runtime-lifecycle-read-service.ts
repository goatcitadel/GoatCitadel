import type {
  ApprovalEffectRecord,
  ApprovalRequest,
  ChatDelegationRunRecord,
  ChatDelegationStepRecord,
  ChatExecutionPlanRecord,
  ChatExecutionPlanStepRecord,
  ChatTurnTraceRecord,
  DurableRunRecord,
  ProactiveRunRecord,
  RuntimeLifecycleFieldSource,
  RuntimeLifecycleQuery,
  RuntimeLifecycleResponse,
  SessionMeta,
  SessionSummary,
  TaskRecord,
} from "@goatcitadel/contracts";

interface LifecycleLinkedSets {
  sessionIds: Set<string>;
  turnIds: Set<string>;
  runIds: Set<string>;
  proactiveRunIds: Set<string>;
  approvalIds: Set<string>;
  taskIds: Set<string>;
  workspaceIds: Set<string>;
}

type LifecycleFieldName = "sessionId" | "turnId" | "runId" | "approvalId" | "taskId";

interface LifecycleResolutionState {
  sessionId?: string;
  turnId?: string;
  runId?: string;
  approvalId?: string;
  taskId?: string;
  executionPlanId?: string;
  preferApprovalCanonical: boolean;
  fallbackSources: Set<RuntimeLifecycleFieldSource>;
  resolution: NonNullable<RuntimeLifecycleResponse["resolution"]>;
  sourceRanks: Record<LifecycleFieldName, number>;
}

export interface RuntimeLifecycleReadHost {
  getApproval(approvalId: string): ApprovalRequest;
  getApprovalWaitRunId(approvalId: string): string | undefined;
  getDurableRun(runId: string): DurableRunRecord;
  findDurableRunMaybe(runId: string): DurableRunRecord | undefined;
  findTask(taskId: string): TaskRecord | undefined;
  getTurnTrace(turnId: string): ChatTurnTraceRecord;
  listHydratedChatTurnTraces(sessionId: string, limit: number): ChatTurnTraceRecord[];
  listChatExecutionPlans(sessionId: string, limit: number): ChatExecutionPlanRecord[];
  listChatDelegationRuns(sessionId: string, limit: number): ChatDelegationRunRecord[];
  listChatDelegationSteps(runId: string): ChatDelegationStepRecord[];
  getSession(sessionId: string): SessionMeta;
  getSessionSummary(sessionId: string): Promise<SessionSummary>;
  listChatSessionProactiveRuns(sessionId: string, limit: number): ProactiveRunRecord[];
  listApprovalEffects(approvalId: string): ApprovalEffectRecord[];
}

export class RuntimeLifecycleReadService {
  public constructor(private readonly host: RuntimeLifecycleReadHost) {}

  public async getRuntimeLifecycle(input: RuntimeLifecycleQuery): Promise<RuntimeLifecycleResponse> {
    const linked: LifecycleLinkedSets = {
      sessionIds: new Set<string>(),
      turnIds: new Set<string>(),
      runIds: new Set<string>(),
      proactiveRunIds: new Set<string>(),
      approvalIds: new Set<string>(),
      taskIds: new Set<string>(),
      workspaceIds: new Set<string>(),
    };

    const state: LifecycleResolutionState = {
      sessionId: normalizeLifecycleId(input.sessionId),
      turnId: normalizeLifecycleId(input.turnId),
      runId: normalizeLifecycleId(input.runId),
      approvalId: normalizeLifecycleId(input.approvalId),
      taskId: normalizeLifecycleId(input.taskId),
      executionPlanId: undefined,
      preferApprovalCanonical: Boolean(input.approvalId),
      fallbackSources: new Set<RuntimeLifecycleFieldSource>(),
      resolution: {
        sessionIdSource: input.sessionId ? "query" : undefined,
        turnIdSource: input.turnId ? "query" : undefined,
        runIdSource: input.runId ? "query" : undefined,
        approvalIdSource: input.approvalId ? "query" : undefined,
        taskIdSource: input.taskId ? "query" : undefined,
        fallbackSources: [],
      },
      sourceRanks: {
        sessionId: input.sessionId ? getLifecycleSourceRank("query") : 0,
        turnId: input.turnId ? getLifecycleSourceRank("query") : 0,
        runId: input.runId ? getLifecycleSourceRank("query") : 0,
        approvalId: input.approvalId ? getLifecycleSourceRank("query") : 0,
        taskId: input.taskId ? getLifecycleSourceRank("query") : 0,
      },
    };

    let approval = state.approvalId ? this.host.getApproval(state.approvalId) : undefined;
    if (approval) {
      state.preferApprovalCanonical = true;
      collectLifecycleLinksFromUnknown(linked, approval.linkage);
      collectLifecycleLinksFromUnknown(linked, approval.payload);
      collectLifecycleLinksFromUnknown(linked, approval.preview);
      if (approval.preview) {
        state.fallbackSources.add("fallback_preview");
      }
    }

    let task = state.taskId ? this.host.findTask(state.taskId) : undefined;
    if (task) {
      collectLifecycleLinksFromUnknown(linked, task.proactiveContext);
      linked.taskIds.add(task.taskId);
      if (task.workspaceId) {
        linked.workspaceIds.add(task.workspaceId);
      }
    }

    let durableRun = state.runId ? this.host.getDurableRun(state.runId) : undefined;
    if (durableRun) {
      applyDurableFallbacks(durableRun, linked, state);
      linked.runIds.add(durableRun.runId);
    }

    let turns = this.loadTurns(state);
    applyTurnTraceLinkage(turns, linked, state);

    if (approval) {
      applyApprovalCanonical(approval, linked, state, this.host.getApprovalWaitRunId.bind(this.host));
    }
    if (task) {
      applyTaskCanonical(task, linked, state);
    }

    turns = this.ensureTurnsLoaded(state, turns);
    applyTurnTraceLinkage(turns, linked, state);

    const executionPlans = state.sessionId
      ? this.host.listChatExecutionPlans(state.sessionId, 50).filter((plan) => this.isPlanRelevant(plan, state))
      : [];
    applyExecutionPlanLinkage(executionPlans, linked, state, this.host.findDurableRunMaybe.bind(this.host));

    const delegationRuns = state.sessionId
      ? this.host.listChatDelegationRuns(state.sessionId, 50).filter((run) => this.isDelegationRunRelevant(run, state))
      : [];
    const delegationSteps = delegationRuns.flatMap((run) => this.host.listChatDelegationSteps(run.runId));
    applyDelegationLinkage(delegationRuns, delegationSteps, linked, state);

    if (state.turnId && !turns.some((turn) => turn.turnId === state.turnId)) {
      turns = this.ensureTurnsLoaded(state, turns);
      applyTurnTraceLinkage(turns, linked, state);
    }

    if (state.runId && !durableRun) {
      durableRun = this.host.getDurableRun(state.runId);
      applyDurableFallbacks(durableRun, linked, state);
      linked.runIds.add(durableRun.runId);
    }
    if (state.approvalId && !approval) {
      approval = this.host.getApproval(state.approvalId);
      state.preferApprovalCanonical = true;
      collectLifecycleLinksFromUnknown(linked, approval.linkage);
      collectLifecycleLinksFromUnknown(linked, approval.payload);
      collectLifecycleLinksFromUnknown(linked, approval.preview);
      applyApprovalCanonical(approval, linked, state, this.host.getApprovalWaitRunId.bind(this.host));
    }
    if (state.taskId && !task) {
      task = this.host.findTask(state.taskId);
      if (task) {
        linked.taskIds.add(task.taskId);
        if (task.workspaceId) {
          linked.workspaceIds.add(task.workspaceId);
        }
        applyTaskCanonical(task, linked, state);
      }
    }

    let session: SessionMeta | undefined;
    let sessionSummary: SessionSummary | undefined;
    if (state.sessionId) {
      session = this.host.getSession(state.sessionId);
      sessionSummary = await this.host.getSessionSummary(state.sessionId);
      linked.sessionIds.add(session.sessionId);
    }

    const toolRuns = turns.flatMap((turn) => turn.toolRuns ?? []);
    for (const toolRun of toolRuns) {
      linked.turnIds.add(toolRun.turnId);
      linked.sessionIds.add(toolRun.sessionId);
      if (toolRun.approvalId) {
        linked.approvalIds.add(toolRun.approvalId);
        assignLifecycleField(state, "approvalId", toolRun.approvalId, "turn_trace");
      }
    }

    const proactiveRuns = state.sessionId
      ? this.host.listChatSessionProactiveRuns(state.sessionId, 50).filter((run) => {
          if (state.taskId && run.linkedTaskId === state.taskId) {
            return true;
          }
          if (state.approvalId && run.approvalId === state.approvalId) {
            return true;
          }
          if (state.runId && (run.runId === state.runId || run.linkedDurableRunId === state.runId)) {
            return true;
          }
          return !state.taskId && !state.approvalId && !state.runId;
        })
      : [];
    for (const proactiveRun of proactiveRuns) {
      linked.proactiveRunIds.add(proactiveRun.runId);
      if (proactiveRun.linkedDurableRunId) {
        linked.runIds.add(proactiveRun.linkedDurableRunId);
      }
    }

    const proactiveDurableRunId =
      proactiveRuns
        .map((candidate) => candidate.linkedDurableRunId)
        .find((candidate): candidate is string => typeof candidate === "string" && candidate.trim().length > 0) ??
      task?.proactiveContext?.durableRunId;
    const approvalWaitDurableRunId = state.approvalId ? this.host.getApprovalWaitRunId(state.approvalId) : undefined;
    const proactiveDurableRun = proactiveDurableRunId
      ? durableRun?.runId === proactiveDurableRunId
        ? durableRun
        : this.host.findDurableRunMaybe(proactiveDurableRunId)
      : undefined;
    const approvalWaitDurableRun = approvalWaitDurableRunId
      ? durableRun?.runId === approvalWaitDurableRunId
        ? durableRun
        : this.host.findDurableRunMaybe(approvalWaitDurableRunId)
      : undefined;
    const approvalEffects = state.approvalId ? this.host.listApprovalEffects(state.approvalId) : [];

    return {
      query: {
        sessionId: state.sessionId,
        turnId: state.turnId,
        runId: state.runId,
        approvalId: state.approvalId,
        taskId: state.taskId,
      },
      canonical: {
        sessionId: state.sessionId,
        turnId: state.turnId,
        runId: state.runId,
        approvalId: state.approvalId,
        taskId: state.taskId,
      },
      resolution: {
        ...state.resolution,
        fallbackSources: Array.from(state.fallbackSources),
      },
      linked: {
        sessionIds: Array.from(linked.sessionIds),
        turnIds: Array.from(linked.turnIds),
        runIds: Array.from(linked.runIds),
        proactiveRunIds: Array.from(linked.proactiveRunIds),
        approvalIds: Array.from(linked.approvalIds),
        taskIds: Array.from(linked.taskIds),
        workspaceIds: Array.from(linked.workspaceIds),
      },
      session,
      sessionSummary,
      task,
      approval,
      durableRun,
      proactiveDurableRun,
      approvalWaitDurableRun,
      proactiveRuns,
      approvalEffects,
      turns: turns.map((turn) => ({
        turnId: turn.turnId,
        sessionId: turn.sessionId,
        userMessageId: turn.userMessageId,
        parentTurnId: turn.parentTurnId,
        assistantMessageId: turn.assistantMessageId,
        status: turn.status,
        mode: turn.mode,
        model: turn.model,
        routing: turn.routing,
        startedAt: turn.startedAt,
        finishedAt: turn.finishedAt,
        durableRunId: turn.durable?.runId,
        completion: turn.completion,
        failure: turn.failure,
      })),
      toolRuns: toolRuns.map((toolRun) => ({
        toolRunId: toolRun.toolRunId,
        turnId: toolRun.turnId,
        sessionId: toolRun.sessionId,
        toolName: toolRun.toolName,
        status: toolRun.status,
        approvalId: toolRun.approvalId,
        startedAt: toolRun.startedAt,
        finishedAt: toolRun.finishedAt,
        reused: toolRun.reused,
        reusedFromToolRunId: toolRun.reusedFromToolRunId,
        reuseReason: toolRun.reuseReason,
      })),
      executionPlans: executionPlans.map((plan) => ({
        planId: plan.planId,
        sessionId: plan.sessionId,
        turnId: plan.turnId,
        mode: plan.mode,
        planningMode: plan.planningMode,
        status: plan.status,
        source: plan.source,
        advisoryOnly: plan.advisoryOnly,
        objective: plan.objective,
        summary: plan.summary,
        startedAt: plan.startedAt,
        finishedAt: plan.finishedAt,
        steps: plan.steps.map((step) => ({
          stepId: step.stepId,
          index: step.index,
          objective: step.objective,
          status: step.status,
          delegatedRole: step.delegatedRole,
          childRunId: step.childRunId,
          durableRunId: step.durableRunId,
          childSessionId: step.childSessionId,
          childTurnId: step.childTurnId,
        })),
      })),
      delegationRuns: delegationRuns.map((run) => ({
        runId: run.runId,
        sessionId: run.sessionId,
        taskId: run.taskId,
        objective: run.objective,
        roles: run.roles,
        mode: run.mode,
        status: run.status,
        executionPlanId: run.executionPlanId,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt,
      })),
      delegationSteps: delegationSteps.map((step) => ({
        stepId: step.stepId,
        runId: step.runId,
        role: step.role,
        status: step.status,
        index: step.index,
        summary: step.summary,
        error: step.error,
        childSessionId: step.childSessionId,
        childTurnId: step.childTurnId,
        durableRunId: step.durableRunId,
      })),
    };
  }

  private loadTurns(state: LifecycleResolutionState): ChatTurnTraceRecord[] {
    if (state.turnId) {
      return [this.host.getTurnTrace(state.turnId)];
    }
    if (state.sessionId) {
      return this.host.listHydratedChatTurnTraces(state.sessionId, 200);
    }
    return [];
  }

  private ensureTurnsLoaded(state: LifecycleResolutionState, turns: ChatTurnTraceRecord[]): ChatTurnTraceRecord[] {
    const byId = new Map(turns.map((turn) => [turn.turnId, turn] as const));
    if (state.turnId && !byId.has(state.turnId)) {
      const resolvedTurn = this.host.getTurnTrace(state.turnId);
      byId.set(resolvedTurn.turnId, resolvedTurn);
    }
    if (byId.size === 0 && state.sessionId) {
      for (const turn of this.host.listHydratedChatTurnTraces(state.sessionId, 200)) {
        byId.set(turn.turnId, turn);
      }
    }
    return [...byId.values()];
  }

  private isPlanRelevant(plan: ChatExecutionPlanRecord, state: LifecycleResolutionState): boolean {
    if (!state.turnId && !state.runId && !state.taskId && !state.approvalId && !state.executionPlanId) {
      return true;
    }
    if (state.executionPlanId && plan.planId === state.executionPlanId) {
      return true;
    }
    if (state.turnId && plan.turnId === state.turnId) {
      return true;
    }
    if (
      state.runId &&
      plan.steps.some(
        (step) =>
          step.durableRunId === state.runId ||
          resolveDeprecatedChildRunId(step, this.host.findDurableRunMaybe.bind(this.host)) === state.runId,
      )
    ) {
      return true;
    }
    return false;
  }

  private isDelegationRunRelevant(run: ChatDelegationRunRecord, state: LifecycleResolutionState): boolean {
    if (!state.runId && !state.taskId && !state.approvalId && !state.executionPlanId && !state.turnId) {
      return true;
    }
    if (state.taskId && run.taskId === state.taskId) {
      return true;
    }
    if (state.executionPlanId && run.executionPlanId === state.executionPlanId) {
      return true;
    }
    if (state.runId && run.runId === state.runId) {
      return true;
    }
    return false;
  }
}

function applyTurnTraceLinkage(
  turns: readonly ChatTurnTraceRecord[],
  linked: LifecycleLinkedSets,
  state: LifecycleResolutionState,
): void {
  for (const turn of turns) {
    linked.sessionIds.add(turn.sessionId);
    linked.turnIds.add(turn.turnId);
    assignLifecycleField(state, "sessionId", turn.sessionId, "turn_trace");
    assignLifecycleField(state, "turnId", turn.turnId, "turn_trace");
    if (turn.executionPlanId) {
      state.executionPlanId = turn.executionPlanId;
    }
    if (turn.durable?.runId) {
      linked.runIds.add(turn.durable.runId);
      assignLifecycleField(state, "runId", turn.durable.runId, "turn_trace");
    }
    for (const toolRun of turn.toolRuns ?? []) {
      if (toolRun.approvalId) {
        linked.approvalIds.add(toolRun.approvalId);
      }
    }
  }
}

function applyExecutionPlanLinkage(
  executionPlans: readonly ChatExecutionPlanRecord[],
  linked: LifecycleLinkedSets,
  state: LifecycleResolutionState,
  findDurableRunMaybe: (runId: string) => DurableRunRecord | undefined,
): void {
  for (const plan of executionPlans) {
    linked.sessionIds.add(plan.sessionId);
    linked.turnIds.add(plan.turnId);
    if (state.executionPlanId === plan.planId || (!state.executionPlanId && plan.turnId === state.turnId)) {
      state.executionPlanId = plan.planId;
    }
    for (const step of plan.steps) {
      if (step.childSessionId) {
        linked.sessionIds.add(step.childSessionId);
        assignLifecycleField(state, "sessionId", step.childSessionId, "execution_plan");
      }
      if (step.childTurnId) {
        linked.turnIds.add(step.childTurnId);
        assignLifecycleField(state, "turnId", step.childTurnId, "execution_plan");
      }
      if (step.durableRunId) {
        linked.runIds.add(step.durableRunId);
        assignLifecycleField(state, "runId", step.durableRunId, "execution_plan");
      }
      const deprecatedChildRunId = resolveDeprecatedChildRunId(step, findDurableRunMaybe);
      if (deprecatedChildRunId) {
        linked.runIds.add(deprecatedChildRunId);
      }
    }
  }
}

function applyDelegationLinkage(
  delegationRuns: readonly ChatDelegationRunRecord[],
  delegationSteps: readonly ChatDelegationStepRecord[],
  linked: LifecycleLinkedSets,
  state: LifecycleResolutionState,
): void {
  for (const run of delegationRuns) {
    linked.sessionIds.add(run.sessionId);
    linked.taskIds.add(run.taskId);
    assignLifecycleField(state, "taskId", run.taskId, "delegation_step");
    if (run.executionPlanId && !state.executionPlanId) {
      state.executionPlanId = run.executionPlanId;
    }
  }
  for (const step of delegationSteps) {
    if (step.childSessionId) {
      linked.sessionIds.add(step.childSessionId);
      assignLifecycleField(state, "sessionId", step.childSessionId, "delegation_step");
    }
    if (step.childTurnId) {
      linked.turnIds.add(step.childTurnId);
      assignLifecycleField(state, "turnId", step.childTurnId, "delegation_step");
    }
    if (step.durableRunId) {
      linked.runIds.add(step.durableRunId);
      assignLifecycleField(state, "runId", step.durableRunId, "delegation_step");
    }
  }
}

function applyApprovalCanonical(
  approval: ApprovalRequest,
  linked: LifecycleLinkedSets,
  state: LifecycleResolutionState,
  getApprovalWaitRunId: (approvalId: string) => string | undefined,
): void {
  linked.approvalIds.add(approval.approvalId);
  assignLifecycleField(state, "approvalId", approval.approvalId, "approval_linkage");
  if (approval.linkage?.sessionId) {
    assignLifecycleField(state, "sessionId", approval.linkage.sessionId, "approval_linkage");
  }
  if (approval.linkage?.taskId) {
    linked.taskIds.add(approval.linkage.taskId);
    assignLifecycleField(state, "taskId", approval.linkage.taskId, "approval_linkage");
  }
  if (approval.linkage?.workspaceId) {
    linked.workspaceIds.add(approval.linkage.workspaceId);
  }
  if (approval.linkage?.proactiveRunId) {
    linked.proactiveRunIds.add(approval.linkage.proactiveRunId);
  }
  if (approval.linkage?.durableRunId) {
    linked.runIds.add(approval.linkage.durableRunId);
    assignLifecycleField(state, "runId", approval.linkage.durableRunId, "approval_linkage");
  }
  const payloadTurnId = typeof approval.payload?.turnId === "string" ? approval.payload.turnId.trim() : "";
  if (payloadTurnId) {
    linked.turnIds.add(payloadTurnId);
    state.fallbackSources.add("fallback_payload");
    assignLifecycleField(state, "turnId", payloadTurnId, "fallback_payload");
  }
  if (!state.runId) {
    const approvalWaitRunId = getApprovalWaitRunId(approval.approvalId);
    if (approvalWaitRunId) {
      linked.runIds.add(approvalWaitRunId);
      assignLifecycleField(state, "runId", approvalWaitRunId, "approval_wait_run");
    }
  }
}

function applyTaskCanonical(task: TaskRecord, linked: LifecycleLinkedSets, state: LifecycleResolutionState): void {
  linked.taskIds.add(task.taskId);
  assignLifecycleField(state, "taskId", task.taskId, "task_context");
  if (task.workspaceId) {
    linked.workspaceIds.add(task.workspaceId);
  }
  if (task.proactiveContext?.sessionId) {
    assignLifecycleField(state, "sessionId", task.proactiveContext.sessionId, "task_context");
  }
  if (task.proactiveContext?.durableRunId) {
    linked.runIds.add(task.proactiveContext.durableRunId);
    assignLifecycleField(state, "runId", task.proactiveContext.durableRunId, "task_context");
  }
  if (task.proactiveContext?.approvalId) {
    linked.approvalIds.add(task.proactiveContext.approvalId);
    assignLifecycleField(state, "approvalId", task.proactiveContext.approvalId, "task_context");
  }
  if (task.proactiveContext?.proactiveRunId) {
    linked.proactiveRunIds.add(task.proactiveContext.proactiveRunId);
  }
}

function applyDurableFallbacks(
  durableRun: DurableRunRecord,
  linked: LifecycleLinkedSets,
  state: LifecycleResolutionState,
): void {
  collectLifecycleLinksFromUnknown(linked, durableRun.payload);
  collectLifecycleLinksFromUnknown(linked, durableRun.metadata);

  const payloadSessionId = findLifecycleString(durableRun.payload, ["sessionId"]);
  if (payloadSessionId) {
    state.fallbackSources.add("fallback_payload");
    assignLifecycleField(state, "sessionId", payloadSessionId, "durable_payload");
  }
  const payloadTaskId = findLifecycleString(durableRun.payload, ["taskId"]);
  if (payloadTaskId) {
    state.fallbackSources.add("fallback_payload");
    linked.taskIds.add(payloadTaskId);
    assignLifecycleField(state, "taskId", payloadTaskId, "durable_payload");
  }
  const payloadTurnId = findLifecycleString(durableRun.payload, ["turnId"]);
  if (payloadTurnId) {
    state.fallbackSources.add("fallback_payload");
    linked.turnIds.add(payloadTurnId);
    assignLifecycleField(state, "turnId", payloadTurnId, "durable_payload");
  }

  const metadataSessionId = findLifecycleString(durableRun.metadata, ["sessionId"]);
  if (metadataSessionId) {
    state.fallbackSources.add("fallback_metadata");
    assignLifecycleField(state, "sessionId", metadataSessionId, "durable_metadata");
  }
  const metadataTaskId = findLifecycleString(durableRun.metadata, ["taskId"]);
  if (metadataTaskId) {
    state.fallbackSources.add("fallback_metadata");
    linked.taskIds.add(metadataTaskId);
    assignLifecycleField(state, "taskId", metadataTaskId, "durable_metadata");
  }
}

function assignLifecycleField(
  state: LifecycleResolutionState,
  field: LifecycleFieldName,
  value: string | undefined,
  source: RuntimeLifecycleFieldSource,
): void {
  const normalized = normalizeLifecycleId(value);
  if (!normalized) {
    return;
  }
  const rank = getLifecycleSourceRank(source, field, state.preferApprovalCanonical);
  if (rank < state.sourceRanks[field]) {
    return;
  }
  state[field] = normalized;
  state.sourceRanks[field] = rank;
  switch (field) {
    case "sessionId":
      state.resolution.sessionIdSource = source;
      break;
    case "turnId":
      state.resolution.turnIdSource = source;
      break;
    case "runId":
      state.resolution.runIdSource = source;
      break;
    case "approvalId":
      state.resolution.approvalIdSource = source;
      break;
    case "taskId":
      state.resolution.taskIdSource = source;
      break;
  }
}

function getLifecycleSourceRank(
  source: RuntimeLifecycleFieldSource,
  field?: LifecycleFieldName,
  preferApprovalCanonical = false,
): number {
  switch (source) {
    case "query":
      return 100;
    case "approval_linkage":
      if (preferApprovalCanonical && (field === "sessionId" || field === "runId" || field === "taskId")) {
        return 95;
      }
      return 60;
    case "turn_trace":
      return 90;
    case "execution_plan":
      return 80;
    case "delegation_step":
      return 70;
    case "approval_wait_run":
      return 55;
    case "task_context":
      return 50;
    case "durable_payload":
      return 40;
    case "durable_metadata":
      return 35;
    case "proactive_run":
      return 30;
    case "fallback_payload":
      return 20;
    case "fallback_preview":
      return 15;
    case "fallback_metadata":
      return 10;
    default:
      return 0;
  }
}

function normalizeLifecycleId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function collectLifecycleLinksFromUnknown(linked: LifecycleLinkedSets, payload: unknown): void {
  const sessionId = findLifecycleString(payload, ["sessionId"]);
  const turnId = findLifecycleString(payload, ["turnId"]);
  const runId = findLifecycleString(payload, ["runId", "durableRunId", "durable_run_id"]);
  const proactiveRunId = findLifecycleString(payload, ["proactiveRunId"]);
  const approvalId = findLifecycleString(payload, ["approvalId"]);
  const taskId = findLifecycleString(payload, ["taskId"]);
  const workspaceId = findLifecycleString(payload, ["workspaceId"]);

  if (sessionId) linked.sessionIds.add(sessionId);
  if (turnId) linked.turnIds.add(turnId);
  if (runId) linked.runIds.add(runId);
  if (proactiveRunId) linked.proactiveRunIds.add(proactiveRunId);
  if (approvalId) linked.approvalIds.add(approvalId);
  if (taskId) linked.taskIds.add(taskId);
  if (workspaceId) linked.workspaceIds.add(workspaceId);
}

function findLifecycleString(payload: unknown, keys: string[]): string | undefined {
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const stack: unknown[] = [payload];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object") {
      continue;
    }
    const record = current as Record<string, unknown>;
    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }
    for (const value of Object.values(record)) {
      if (value && typeof value === "object") {
        stack.push(value);
      }
    }
  }
  return undefined;
}

function resolveDeprecatedChildRunId(
  step: Pick<ChatExecutionPlanStepRecord, "childRunId" | "durableRunId">,
  findDurableRunMaybe: (runId: string) => DurableRunRecord | undefined,
): string | undefined {
  if (step.durableRunId || !step.childRunId) {
    return undefined;
  }
  return findDurableRunMaybe(step.childRunId)?.runId;
}
