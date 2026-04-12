import type {
  ApprovalEffectRecord,
  ApprovalRequest,
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

interface LifecycleResolutionState {
  sessionId?: string;
  turnId?: string;
  runId?: string;
  approvalId?: string;
  taskId?: string;
  fallbackSources: Set<RuntimeLifecycleFieldSource>;
  resolution: NonNullable<RuntimeLifecycleResponse["resolution"]>;
}

export interface RuntimeLifecycleReadHost {
  getApproval(approvalId: string): ApprovalRequest;
  getApprovalWaitRunId(approvalId: string): string | undefined;
  getDurableRun(runId: string): DurableRunRecord;
  findDurableRunMaybe(runId: string): DurableRunRecord | undefined;
  findTask(taskId: string): TaskRecord | undefined;
  getTurnTrace(turnId: string): ChatTurnTraceRecord;
  listHydratedChatTurnTraces(sessionId: string, limit: number): ChatTurnTraceRecord[];
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
      fallbackSources: new Set<RuntimeLifecycleFieldSource>(),
      resolution: {
        sessionIdSource: input.sessionId ? "query" : undefined,
        turnIdSource: input.turnId ? "query" : undefined,
        runIdSource: input.runId ? "query" : undefined,
        approvalIdSource: input.approvalId ? "query" : undefined,
        taskIdSource: input.taskId ? "query" : undefined,
        fallbackSources: [],
      },
    };

    let approval = state.approvalId ? this.host.getApproval(state.approvalId) : undefined;
    if (approval) {
      applyApproval(approval, linked, state, this.host.getApprovalWaitRunId.bind(this.host));
    }

    let durableRun = state.runId ? this.host.getDurableRun(state.runId) : undefined;
    if (durableRun) {
      applyDurableRun(durableRun, linked, state);
    }

    let task = state.taskId ? this.host.findTask(state.taskId) : undefined;
    if (task) {
      applyTask(task, linked, state);
    }

    const turns = state.turnId
      ? [this.host.getTurnTrace(state.turnId)]
      : state.sessionId
        ? this.host.listHydratedChatTurnTraces(state.sessionId, 200)
        : [];
    for (const turn of turns) {
      linked.sessionIds.add(turn.sessionId);
      linked.turnIds.add(turn.turnId);
      if (turn.durable?.runId) {
        linked.runIds.add(turn.durable.runId);
      }
      for (const toolRun of turn.toolRuns ?? []) {
        if (toolRun.approvalId) {
          linked.approvalIds.add(toolRun.approvalId);
        }
      }
    }
    if (!state.sessionId && turns[0]?.sessionId) {
      state.sessionId = turns[0].sessionId;
      state.resolution.sessionIdSource ??= "turn_trace";
    }

    if (!state.runId && linked.runIds.size > 0) {
      const linkedRunId = Array.from(linked.runIds)[0];
      if (linkedRunId) {
        state.runId = linkedRunId;
        state.resolution.runIdSource ??= "turn_trace";
      }
    }
    if (!state.approvalId && linked.approvalIds.size > 0) {
      const linkedApprovalId = Array.from(linked.approvalIds)[0];
      if (linkedApprovalId) {
        state.approvalId = linkedApprovalId;
        state.resolution.approvalIdSource ??= "turn_trace";
      }
    }
    if (!state.taskId && linked.taskIds.size > 0) {
      const linkedTaskId = Array.from(linked.taskIds)[0];
      if (linkedTaskId) {
        state.taskId = linkedTaskId;
        state.resolution.taskIdSource ??= "turn_trace";
      }
    }

    if (state.runId && !durableRun) {
      durableRun = this.host.getDurableRun(state.runId);
      applyDurableRun(durableRun, linked, state);
    }
    if (state.approvalId && !approval) {
      approval = this.host.getApproval(state.approvalId);
      applyApproval(approval, linked, state, this.host.getApprovalWaitRunId.bind(this.host));
    }
    if (state.taskId && !task) {
      task = this.host.findTask(state.taskId);
      if (task) {
        applyTask(task, linked, state);
      }
    }

    if (approval?.approvalId) {
      linked.approvalIds.add(approval.approvalId);
    }
    if (durableRun?.runId) {
      linked.runIds.add(durableRun.runId);
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
        startedAt: turn.startedAt,
        finishedAt: turn.finishedAt,
        durableRunId: turn.durable?.runId,
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
      })),
    };
  }
}

function applyApproval(
  approval: ApprovalRequest,
  linked: LifecycleLinkedSets,
  state: LifecycleResolutionState,
  getApprovalWaitRunId: (approvalId: string) => string | undefined,
): void {
  collectLifecycleLinksFromUnknown(linked, approval.linkage);
  collectLifecycleLinksFromUnknown(linked, approval.payload);
  collectLifecycleLinksFromUnknown(linked, approval.preview);
  if (!state.sessionId && approval.linkage?.sessionId) {
    state.sessionId = approval.linkage.sessionId;
    state.resolution.sessionIdSource = "approval_linkage";
  }
  if (!state.taskId && approval.linkage?.taskId) {
    state.taskId = approval.linkage.taskId;
    state.resolution.taskIdSource = "approval_linkage";
  }
  if (approval.linkage?.workspaceId) {
    linked.workspaceIds.add(approval.linkage.workspaceId);
  }
  if (approval.linkage?.proactiveRunId) {
    linked.proactiveRunIds.add(approval.linkage.proactiveRunId);
  }
  if (!state.runId && approval.linkage?.durableRunId) {
    state.runId = approval.linkage.durableRunId;
    state.resolution.runIdSource = "approval_linkage";
  }
  if (!state.runId) {
    const approvalWaitRunId = getApprovalWaitRunId(approval.approvalId);
    if (approvalWaitRunId) {
      state.runId = approvalWaitRunId;
      state.resolution.runIdSource = "approval_wait_run";
    }
  }
  if (!state.turnId) {
    const payloadTurnId = typeof approval.payload?.turnId === "string" ? approval.payload.turnId.trim() : "";
    if (payloadTurnId) {
      linked.turnIds.add(payloadTurnId);
      state.fallbackSources.add("fallback_payload");
    }
  }
  if (approval.preview) {
    state.fallbackSources.add("fallback_preview");
  }
}

function applyDurableRun(
  durableRun: DurableRunRecord,
  linked: LifecycleLinkedSets,
  state: LifecycleResolutionState,
): void {
  collectLifecycleLinksFromUnknown(linked, durableRun.payload);
  collectLifecycleLinksFromUnknown(linked, durableRun.metadata);
  if (!state.sessionId) {
    const payloadSessionId = findLifecycleString(durableRun.payload, ["sessionId"]);
    if (payloadSessionId) {
      state.sessionId = payloadSessionId;
      state.resolution.sessionIdSource = "durable_payload";
    }
  }
  if (!state.taskId) {
    const payloadTaskId = findLifecycleString(durableRun.payload, ["taskId"]);
    if (payloadTaskId) {
      state.taskId = payloadTaskId;
      state.resolution.taskIdSource = "durable_payload";
    }
  }
}

function applyTask(task: TaskRecord, linked: LifecycleLinkedSets, state: LifecycleResolutionState): void {
  linked.taskIds.add(task.taskId);
  if (task.workspaceId) {
    linked.workspaceIds.add(task.workspaceId);
  }
  collectLifecycleLinksFromUnknown(linked, task.proactiveContext);
  if (!state.sessionId && task.proactiveContext?.sessionId) {
    state.sessionId = task.proactiveContext.sessionId;
    state.resolution.sessionIdSource = "task_context";
  }
  if (!state.runId && task.proactiveContext?.durableRunId) {
    state.runId = task.proactiveContext.durableRunId;
    state.resolution.runIdSource = "task_context";
  }
  if (!state.approvalId && task.proactiveContext?.approvalId) {
    state.approvalId = task.proactiveContext.approvalId;
    state.resolution.approvalIdSource = "task_context";
  }
  if (task.proactiveContext?.proactiveRunId) {
    linked.proactiveRunIds.add(task.proactiveContext.proactiveRunId);
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
