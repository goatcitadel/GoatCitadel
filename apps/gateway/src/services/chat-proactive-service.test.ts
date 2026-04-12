import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
vi.mock("@goatcitadel/storage", () => ({
  DEFAULT_SESSION_AUTONOMY_PREFS: {
    proactiveMode: "off",
    maxActionsPerHour: 0,
    maxActionsPerTurn: 0,
    cooldownSeconds: 0,
    retrievalMode: "standard",
    reflectionMode: "off",
  },
}));
import type {
  ApprovalRequest,
  ApprovalWaitWorkflowPayload,
  DurableCheckpointRecord,
  DurableRunRecord,
  DurableRunTimelineEvent,
  PendingApprovalAction,
  ProactiveActionRecord,
  ProactiveRunRecord,
  SessionMeta,
  TaskRecord,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { ServiceContext } from "./service-context.js";
import type { RuntimeSettings } from "./gateway-service.js";
import { ChatProactiveService, type ChatProactiveServiceCallbacks } from "./chat-proactive-service.js";
import { DurableRunService } from "./durable-run-service.js";

type Mode = "chat" | "cowork" | "code";
type Prefs = {
  sessionId: string;
  proactiveMode: "off" | "suggest" | "auto_safe" | "auto_full";
  maxActionsPerHour: number;
  maxActionsPerTurn: number;
  cooldownSeconds: number;
  retrievalMode: "standard" | "layered";
  reflectionMode: "off" | "on";
  lastProactiveAt?: string;
  lastProactiveRunId?: string;
  createdAt: string;
  updatedAt: string;
};
type ProactiveRunRow = {
  run_id: string;
  session_id: string;
  linked_task_id: string | null;
  linked_durable_run_id: string | null;
  approval_id: string | null;
  status: ProactiveRunRecord["status"] | "waiting";
  mode: ProactiveRunRecord["mode"];
  trigger_source: string | null;
  origin_surface: string | null;
  confidence: number;
  reasoning_summary: string | null;
  suggested_actions_json: string;
  executed_actions_json: string;
  next_wake_at: string | null;
  stop_reason: string | null;
  external_reference_roots_json: string | null;
  resume_metadata_json: string | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
};
type ProactiveActionRow = {
  action_id: string;
  run_id: string;
  session_id: string;
  linked_task_id: string | null;
  linked_durable_run_id: string | null;
  approval_id: string | null;
  kind: ProactiveActionRecord["kind"];
  status: ProactiveActionRecord["status"];
  trigger_source: string | null;
  origin_surface: string | null;
  tool_name: string | null;
  args_json: string | null;
  result_json: string | null;
  error: string | null;
  external_reference_roots_json: string | null;
  created_at: string;
  updated_at: string | null;
};
type TimelineRow = {
  event_id: string;
  run_id: string;
  event_type: DurableRunTimelineEvent["eventType"];
  step_key: string | null;
  payload_json: string | null;
  created_at: string;
};
type HarnessState = {
  session: SessionMeta;
  prefs: Map<string, Prefs>;
  modes: Map<string, Mode>;
  metas: Map<string, { workspaceId?: string }>;
  messages: Map<string, Array<{ role: string; content: string }>>;
  tasks: Map<string, TaskRecord>;
  approvals: Map<string, ApprovalRequest>;
  pendingApprovalActions: Map<string, PendingApprovalAction>;
  proactiveRuns: Map<string, ProactiveRunRow>;
  proactiveActions: Map<string, ProactiveActionRow>;
  durableRuns: Map<string, DurableRunRecord>;
  checkpoints: DurableCheckpointRecord[];
  timeline: TimelineRow[];
};

describe("ChatProactiveService", () => {
  it("skips scheduler ticks when durable kernel is disabled", async () => {
    const harness = createHarness({ durableKernelV1Enabled: false });
    const triggerSpy = vi.spyOn(harness.service, "triggerChatSessionProactive");

    await (harness.service as unknown as { runSchedulerTick: () => Promise<void> }).runSchedulerTick();

    expect(triggerSpy).not.toHaveBeenCalled();
  });

  it("finds approval-linked durable runs in latest-started order without duplicate ids", () => {
    const { service, state } = createHarness();
    state.proactiveRuns.set(
      "run-old",
      createProactiveRunRow({
        runId: "run-old",
        linkedDurableRunId: "durable-old",
        approvalId: "approval-1",
        startedAt: "2026-04-04T18:00:00.000Z",
      }),
    );
    state.proactiveRuns.set(
      "run-new-duplicate",
      createProactiveRunRow({
        runId: "run-new-duplicate",
        linkedDurableRunId: "durable-old",
        approvalId: "approval-1",
        startedAt: "2026-04-04T19:00:00.000Z",
      }),
    );
    state.proactiveRuns.set(
      "run-new",
      createProactiveRunRow({
        runId: "run-new",
        linkedDurableRunId: "durable-new",
        approvalId: "approval-1",
        startedAt: "2026-04-04T20:00:00.000Z",
      }),
    );
    state.proactiveRuns.set(
      "run-other-approval",
      createProactiveRunRow({
        runId: "run-other-approval",
        linkedDurableRunId: "durable-other",
        approvalId: "approval-2",
        startedAt: "2026-04-04T21:00:00.000Z",
      }),
    );

    expect(service.findDurableRunIdsForApproval("approval-1")).toEqual(["durable-new", "durable-old"]);
  });

  it("resumes approval-blocked proactive durable runs from checkpoint without rerunning completed actions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T19:00:00.000Z"));
    try {
      const harness = createHarness();
      const { service, durableRunService, invokeTool, state, publishRealtime } = harness;
      const planSpy = vi.spyOn(
        service as unknown as { planProactiveActions: (sessionId: string) => Promise<unknown> },
        "planProactiveActions",
      );
      planSpy.mockResolvedValue({
        confidence: 0.93,
        reasoningSummary: "Need one safe fetch, then one approval-gated fetch.",
        actions: [
          { kind: "tool", toolName: "time.now", args: { timezone: "UTC" } },
          { kind: "tool", toolName: "http.get", args: { url: "https://example.com/private" } },
        ],
      });

      let approvalId = "";
      invokeTool.mockImplementationOnce(
        async (): Promise<ToolInvokeResult> => ({
          outcome: "executed",
          policyReason: "allowlisted",
          auditEventId: "audit-1",
          result: { ok: true, step: 1 },
        }),
      );
      invokeTool.mockImplementationOnce(async () => {
        const approval = harness.storage.approvals.create({
          kind: "tool.invoke",
          riskLevel: "caution",
          payload: { toolName: "http.get" },
          preview: { title: "Approve private fetch" },
          linkage: { sessionId: state.session.sessionId, proactiveRunId: "pending", originSurface: "chat" },
        });
        approvalId = approval.approvalId;
        return {
          outcome: "approval_required",
          approvalId,
          policyReason: "Approval required by policy.",
          auditEventId: "audit-2",
        } satisfies ToolInvokeResult;
      });

      const started = await service.triggerChatSessionProactive(state.session.sessionId, { source: "manual" });
      const parentRunId = started.linkedDurableRunId!;
      await service.executeDurableProactiveTickRun(state.durableRuns.get(parentRunId)!);

      const blockedRun = readRun(state, started.runId);
      const blockedActions = actionsForRun(state, started.runId);
      const firstActionId = blockedActions[0]?.actionId;
      const secondActionId = blockedActions[1]?.actionId;
      const waitingCheckpoint = state.checkpoints.find(
        (checkpoint) => checkpoint.runId === parentRunId && checkpoint.checkpointKind === "run_waiting",
      );

      expect(blockedRun.status).toBe("blocked");
      expect(blockedRun.stopReason).toBe("approval_block");
      expect(blockedActions.map((action) => action.status)).toEqual(["executed", "blocked"]);
      expect(invokeTool).toHaveBeenCalledTimes(2);
      expect(publishRealtime).toHaveBeenCalledWith(
        "proactive_tick_started",
        "chat",
        expect.objectContaining({
          sessionId: state.session.sessionId,
          runId: started.runId,
          durableRunId: parentRunId,
        }),
        expect.objectContaining({
          eventClass: "operational_signal",
          eventAuthority: "retained_stream",
          links: expect.objectContaining({
            sessionId: state.session.sessionId,
            proactiveRunId: started.runId,
            runId: parentRunId,
            workspaceId: "default",
          }),
        }),
      );
      expect(publishRealtime).toHaveBeenCalledWith(
        "task_created",
        "tasks",
        expect.objectContaining({
          task: expect.objectContaining({
            proactiveContext: expect.objectContaining({
              proactiveRunId: started.runId,
            }),
          }),
        }),
        expect.objectContaining({
          eventClass: "domain_fact",
          eventAuthority: "retained_stream",
          links: expect.objectContaining({
            sessionId: state.session.sessionId,
            proactiveRunId: started.runId,
            taskId: blockedRun.linkedTaskId,
            workspaceId: "default",
          }),
        }),
      );
      expect(waitingCheckpoint?.state).toMatchObject({
        waitForEvent: { eventKey: "approval.resolved", correlationId: approvalId },
        proactive: {
          phase: "awaiting_approval",
          approvalId,
          blockedActionId: secondActionId,
        },
        proactiveRunId: started.runId,
        approvalId,
        blockedActionId: secondActionId,
      });

      vi.setSystemTime(new Date("2026-04-04T19:00:05.000Z"));
      const approvalWaitRun = durableRunService.createDurableRun({
        workflowKey: "approval.wait",
        payload: {
          version: "approval.wait.v1",
          approvalId,
          approvalKind: "tool.invoke",
          createdAt: new Date().toISOString(),
          originSurface: "chat",
        } satisfies ApprovalWaitWorkflowPayload as unknown as Record<string, unknown>,
        waitForEvent: { eventKey: "approval.resolved", correlationId: approvalId },
      });
      harness.storage.approvals.mergeLinkage(approvalId, {
        durableRunId: approvalWaitRun.runId,
        proactiveRunId: started.runId,
      });
      harness.storage.pendingApprovalActions.upsertPending({
        approvalId,
        actionType: "tool.invoke",
        request: { toolName: "http.get", args: { url: "https://example.com/private" } },
      });
      harness.storage.pendingApprovalActions.markResolved(approvalId, "executed", {
        outcome: "executed",
        result: { ok: true, resumed: true },
      });
      harness.storage.approvals.resolve(approvalId, { decision: "approve", resolvedBy: "operator-1" });
      durableRunService.wakeDurableRun(approvalWaitRun.runId, {
        eventKey: "approval.resolved",
        correlationId: approvalId,
        payload: { approvalId },
      });
      durableRunService.wakeDurableRun(parentRunId, {
        eventKey: "approval.resolved",
        correlationId: approvalId,
        payload: { approvalId },
      });
      await service.executeDurableProactiveTickRun(state.durableRuns.get(parentRunId)!);

      const completedRun = readRun(state, started.runId);
      const completedActions = actionsForRun(state, started.runId);
      const parentTimeline = durableRunService.listDurableRunTimeline(parentRunId);
      const childTimeline = durableRunService.listDurableRunTimeline(approvalWaitRun.runId);

      expect(completedRun.status).toBe("executed");
      expect(completedRun.stopReason).toBe("completed");
      expect(completedRun.resumeMetadata).toMatchObject({ resumedFromApproval: true, approvalId });
      expect(completedActions.map((action) => action.actionId)).toEqual([firstActionId, secondActionId]);
      expect(completedActions.map((action) => action.status)).toEqual(["executed", "executed"]);
      expect(completedActions[0]?.result).toEqual({ ok: true, step: 1 });
      expect(completedActions[1]?.result).toMatchObject({
        approvalId,
        approvalStatus: "approved",
        approvedResult: { ok: true, resumed: true },
      });
      expect(invokeTool).toHaveBeenCalledTimes(2);
      expect(state.durableRuns.get(parentRunId)?.status).toBe("completed");
      expect(parentTimeline.map((event) => event.eventType)).toEqual(
        expect.arrayContaining(["run_waiting", "run_woken", "run_completed"]),
      );
      expect(childTimeline.map((event) => event.eventType)).toEqual(
        expect.arrayContaining(["run_created", "run_waiting", "run_woken"]),
      );
    } finally {
      vi.useRealTimers();
    }
  });
});

function createHarness(options?: { durableKernelV1Enabled?: boolean }) {
  const session: SessionMeta = {
    sessionId: "session-1",
    sessionKey: "chat:session-1",
    kind: "dm",
    channel: "chat",
    account: "local",
    displayName: "Approval Resume Test",
    lastActivityAt: "2026-04-04T18:55:00.000Z",
    updatedAt: "2026-04-04T18:55:00.000Z",
    health: "healthy",
    tokenInput: 0,
    tokenOutput: 0,
    tokenCachedInput: 0,
    tokenTotal: 0,
    costUsdTotal: 0,
    budgetState: "ok",
  };
  const state: HarnessState = {
    session,
    prefs: new Map([
      [
        session.sessionId,
        {
          sessionId: session.sessionId,
          proactiveMode: "auto_full",
          maxActionsPerHour: 10,
          maxActionsPerTurn: 5,
          cooldownSeconds: 0,
          retrievalMode: "standard",
          reflectionMode: "off",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    ]),
    modes: new Map([[session.sessionId, "chat"]]),
    metas: new Map([[session.sessionId, { workspaceId: "default" }]]),
    messages: new Map([[session.sessionId, [{ role: "user", content: "Please inspect and fetch the latest state." }]]]),
    tasks: new Map(),
    approvals: new Map(),
    pendingApprovalActions: new Map(),
    proactiveRuns: new Map(),
    proactiveActions: new Map(),
    durableRuns: new Map(),
    checkpoints: [],
    timeline: [],
  };
  const storage = createStorage(state);
  const publishRealtime = vi.fn();
  const ctx = {
    storage,
    config: { assistant: { durable: { enabled: true } } },
    llmService: {},
    policyEngine: {},
    gatewaySql: { prepare: (sql: string) => createStatement(sql, state) },
    publishRealtime,
    requireFeatureEnabled: () => undefined,
    isFeatureEnabled: (flag: keyof RuntimeSettings["features"]) =>
      flag !== "durableKernelV1Enabled" || options?.durableKernelV1Enabled !== false,
    normalizeWorkspaceId: (workspaceId?: string) => workspaceId ?? "default",
  } as unknown as ServiceContext;
  const durableRunService = new DurableRunService(ctx);
  const backgroundTasks = new Set<Promise<void>>();
  const invokeTool = vi.fn();
  const callbacks: ChatProactiveServiceCallbacks = {
    listChatSessions: () => [{ sessionId: session.sessionId, lastActivityAt: session.lastActivityAt }],
    getSession: (sessionId) => {
      if (sessionId !== session.sessionId) throw new Error(`Unknown session ${sessionId}`);
      return session;
    },
    hasRunningTurn: () => false,
    getSessionIdleSeconds: () => 600,
    listChatMessages: async (sessionId) => state.messages.get(sessionId) ?? [],
    invokeTool,
    detectDelegationRoles: () => [],
    createDurableRun: (input) => durableRunService.createDurableRun(input),
    requestDurableRunProcessing: () => undefined,
    backgroundTasks,
    closing: false,
  };
  return {
    state,
    storage,
    service: new ChatProactiveService(ctx, callbacks),
    durableRunService,
    invokeTool,
    publishRealtime,
  };
}

function createStorage(state: HarnessState) {
  return {
    durableRuns: {
      statusCounts: () =>
        [...state.durableRuns.values()].reduce(
          (counts, run) => ({ ...counts, [run.status]: (counts[run.status] ?? 0) + 1 }),
          {} as Record<string, number>,
        ),
      countRuns: () => state.durableRuns.size,
      listDeadLetters: () => [],
      listRuns: (limit = 25) =>
        [...state.durableRuns.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit),
      listCheckpoints: (runId: string, limit = 200) =>
        state.checkpoints.filter((checkpoint) => checkpoint.runId === runId).slice(0, limit),
      listRetries: () => [],
      getRun: (runId: string) => {
        const run = state.durableRuns.get(runId);
        if (!run) throw new Error(`Unknown run ${runId}`);
        return run;
      },
      createRun: (input: {
        workflowKey: string;
        status?: DurableRunRecord["status"];
        attemptCount?: number;
        maxAttempts?: number;
        payload?: Record<string, unknown>;
        metadata?: Record<string, unknown>;
        startedAt?: string;
        finishedAt?: string;
        lastError?: string;
        now?: string;
      }) => {
        const now = input.now ?? new Date().toISOString();
        const run: DurableRunRecord = {
          runId: randomUUID(),
          workflowKey: input.workflowKey,
          status: input.status ?? "queued",
          attemptCount: input.attemptCount ?? 0,
          maxAttempts: input.maxAttempts ?? 3,
          version: 1,
          payload: input.payload ?? {},
          metadata: input.metadata,
          startedAt: input.startedAt,
          finishedAt: input.finishedAt,
          lastError: input.lastError,
          createdAt: now,
          updatedAt: now,
        };
        state.durableRuns.set(run.runId, run);
        return run;
      },
      updateRun: (input: {
        runId: string;
        status: DurableRunRecord["status"];
        attemptCount?: number;
        maxAttempts?: number;
        metadata?: Record<string, unknown>;
        startedAt?: string;
        finishedAt?: string;
        lastError?: string;
        updatedAt?: string;
      }) => {
        const current = state.durableRuns.get(input.runId);
        if (!current) throw new Error(`Unknown run ${input.runId}`);
        const next = {
          ...current,
          status: input.status,
          attemptCount: input.attemptCount ?? current.attemptCount,
          maxAttempts: input.maxAttempts ?? current.maxAttempts,
          metadata: input.metadata !== undefined ? input.metadata : current.metadata,
          startedAt: input.startedAt !== undefined ? input.startedAt : current.startedAt,
          finishedAt: input.finishedAt !== undefined ? input.finishedAt : current.finishedAt,
          lastError: input.lastError !== undefined ? input.lastError : current.lastError,
          updatedAt: input.updatedAt ?? new Date().toISOString(),
        };
        state.durableRuns.set(next.runId, next);
        return next;
      },
      createCheckpoint: (input: {
        runId: string;
        checkpointKind: DurableCheckpointRecord["checkpointKind"];
        state?: Record<string, unknown>;
        createdAt?: string;
        checkpointId?: string;
      }) => {
        const checkpoint: DurableCheckpointRecord = {
          checkpointId: input.checkpointId ?? randomUUID(),
          runId: input.runId,
          checkpointKind: input.checkpointKind,
          state: input.state ?? {},
          createdAt: input.createdAt ?? new Date().toISOString(),
        };
        state.checkpoints.push(checkpoint);
        return checkpoint;
      },
    },
    durableRunEvents: {
      append: (event: DurableRunTimelineEvent) => {
        state.timeline.push({
          event_id: event.eventId,
          run_id: event.runId,
          event_type: event.eventType,
          step_key: event.stepKey ?? null,
          payload_json: event.payload ? JSON.stringify(event.payload) : null,
          created_at: event.createdAt,
        });
        return event;
      },
      listByRun: (runId: string, limit = 300) =>
        state.timeline
          .filter((event) => event.run_id === runId)
          .sort((left, right) => left.created_at.localeCompare(right.created_at))
          .slice(-limit)
          .map((event) => ({
            eventId: event.event_id,
            runId: event.run_id,
            eventType: event.event_type,
            stepKey: event.step_key ?? undefined,
            payload: event.payload_json ? JSON.parse(event.payload_json) : undefined,
            createdAt: event.created_at,
          })),
    },
    tasks: {
      create: (input: {
        workspaceId?: string;
        title: string;
        description?: string;
        status?: TaskRecord["status"];
        priority?: TaskRecord["priority"];
        createdBy?: string;
        proactiveContext?: TaskRecord["proactiveContext"];
      }) => {
        const now = new Date().toISOString();
        const task: TaskRecord = {
          taskId: randomUUID(),
          workspaceId: input.workspaceId,
          title: input.title,
          description: input.description,
          status: input.status ?? "planning",
          priority: input.priority ?? "normal",
          createdBy: input.createdBy,
          proactiveContext: input.proactiveContext,
          createdAt: now,
          updatedAt: now,
        };
        state.tasks.set(task.taskId, task);
        return task;
      },
      get: (taskId: string) => {
        const task = state.tasks.get(taskId);
        if (!task) throw new Error(`Unknown task ${taskId}`);
        return task;
      },
      find: (taskId: string) => state.tasks.get(taskId),
      update: (
        taskId: string,
        patch: Partial<TaskRecord> & {
          proactiveContext?: TaskRecord["proactiveContext"] | null;
          assignedAgentId?: string | null;
        },
      ) => {
        const current = state.tasks.get(taskId);
        if (!current) throw new Error(`Unknown task ${taskId}`);
        const next = {
          ...current,
          ...(patch.status ? { status: patch.status } : {}),
          ...(patch.priority ? { priority: patch.priority } : {}),
          ...(patch.proactiveContext !== undefined ? { proactiveContext: patch.proactiveContext ?? undefined } : {}),
          ...(patch.assignedAgentId !== undefined ? { assignedAgentId: patch.assignedAgentId ?? undefined } : {}),
          updatedAt: new Date().toISOString(),
        };
        state.tasks.set(taskId, next);
        return next;
      },
    },
    approvals: {
      create: (input: {
        kind: string;
        riskLevel: ApprovalRequest["riskLevel"];
        payload: Record<string, unknown>;
        preview: Record<string, unknown>;
        linkage?: ApprovalRequest["linkage"];
      }) => {
        const approval: ApprovalRequest = {
          approvalId: randomUUID(),
          kind: input.kind,
          riskLevel: input.riskLevel,
          status: "pending",
          payload: input.payload,
          preview: input.preview,
          linkage: input.linkage,
          createdAt: new Date().toISOString(),
          explanationStatus: "not_requested",
        };
        state.approvals.set(approval.approvalId, approval);
        return approval;
      },
      get: (approvalId: string) => {
        const approval = state.approvals.get(approvalId);
        if (!approval) throw new Error(`Unknown approval ${approvalId}`);
        return approval;
      },
      mergeLinkage: (approvalId: string, linkagePatch: NonNullable<ApprovalRequest["linkage"]>) => {
        const current = state.approvals.get(approvalId);
        if (!current) throw new Error(`Unknown approval ${approvalId}`);
        const next = { ...current, linkage: { ...(current.linkage ?? {}), ...linkagePatch } };
        state.approvals.set(approvalId, next);
        return next;
      },
      resolve: (approvalId: string, input: { decision: "approve" | "reject" | "edit"; resolvedBy: string }) => {
        const current = state.approvals.get(approvalId);
        if (!current) throw new Error(`Unknown approval ${approvalId}`);
        const status: ApprovalRequest["status"] =
          input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : "edited";
        const next = { ...current, status, resolvedAt: new Date().toISOString(), resolvedBy: input.resolvedBy };
        state.approvals.set(approvalId, next);
        return next;
      },
    },
    pendingApprovalActions: {
      upsertPending: (input: {
        approvalId: string;
        actionType: PendingApprovalAction["actionType"];
        request: Record<string, unknown>;
        createdAt?: string;
      }) => {
        const next: PendingApprovalAction = {
          approvalId: input.approvalId,
          actionType: input.actionType,
          request: input.request,
          createdAt: input.createdAt ?? new Date().toISOString(),
          resolutionStatus: "pending",
        };
        state.pendingApprovalActions.set(input.approvalId, next);
        return next;
      },
      find: (approvalId: string) => state.pendingApprovalActions.get(approvalId),
      markResolved: (
        approvalId: string,
        resolutionStatus: NonNullable<PendingApprovalAction["resolutionStatus"]>,
        result?: Record<string, unknown>,
      ) => {
        const current = state.pendingApprovalActions.get(approvalId);
        if (!current) throw new Error(`Unknown pending approval action ${approvalId}`);
        const next = { ...current, resolvedAt: new Date().toISOString(), resolutionStatus, result };
        state.pendingApprovalActions.set(approvalId, next);
        return next;
      },
    },
    sessionAutonomyPrefs: {
      ensure: (sessionId: string) => {
        const prefs = state.prefs.get(sessionId);
        if (!prefs) throw new Error(`Unknown prefs ${sessionId}`);
        return prefs;
      },
      patch: (sessionId: string, patch: Partial<Prefs>) => {
        const current = state.prefs.get(sessionId);
        if (!current) throw new Error(`Unknown prefs ${sessionId}`);
        const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
        state.prefs.set(sessionId, next);
        return next;
      },
      touch: (sessionId: string, runId: string) => {
        const current = state.prefs.get(sessionId);
        if (!current) throw new Error(`Unknown prefs ${sessionId}`);
        state.prefs.set(sessionId, {
          ...current,
          lastProactiveAt: new Date().toISOString(),
          lastProactiveRunId: runId,
          updatedAt: new Date().toISOString(),
        });
      },
      listBySessionIds: (sessionIds: string[]) =>
        new Map(
          sessionIds.flatMap((sessionId) =>
            state.prefs.has(sessionId) ? [[sessionId, state.prefs.get(sessionId)!]] : [],
          ),
        ),
    },
    chatSessionPrefs: { ensure: (sessionId: string) => ({ mode: state.modes.get(sessionId) ?? "chat" }) },
    chatSessionMeta: { ensure: (sessionId: string) => state.metas.get(sessionId) ?? { workspaceId: "default" } },
    chatMessages: { list: (sessionId: string) => state.messages.get(sessionId) ?? [] },
  };
}

function createStatement(sql: string, state: HarnessState) {
  const query = sql.replace(/\s+/g, " ").trim();
  return {
    get: (...args: unknown[]) => {
      if (query.includes("FROM proactive_runs pr JOIN durable_runs dr"))
        return [...state.proactiveRuns.values()]
          .filter(
            (row) =>
              row.session_id === args[0] &&
              row.linked_durable_run_id &&
              isActiveDurable(state, row.linked_durable_run_id),
          )
          .sort((a, b) => b.started_at.localeCompare(a.started_at))[0];
      if (query.includes("FROM proactive_runs") && query.includes("WHERE run_id = ?"))
        return state.proactiveRuns.get(String(args[0]));
      if (query.includes("FROM proactive_actions") && query.includes("WHERE action_id = ?"))
        return state.proactiveActions.get(String(args[0]));
      if (query.includes("FROM proactive_actions") && query.includes("status = 'executed'"))
        return {
          count: [...state.proactiveActions.values()].filter(
            (row) => row.session_id === args[0] && row.status === "executed" && row.created_at >= String(args[1]),
          ).length,
        };
      return undefined;
    },
    all: (...args: unknown[]) => {
      if (query.includes("FROM proactive_actions") && query.includes("WHERE run_id = ?"))
        return [...state.proactiveActions.values()]
          .filter((row) => row.run_id === args[0])
          .sort((a, b) => a.created_at.localeCompare(b.created_at));
      if (query.includes("FROM proactive_runs") && query.includes("WHERE session_id = ?"))
        return [...state.proactiveRuns.values()]
          .filter((row) => row.session_id === args[0])
          .sort((a, b) => b.started_at.localeCompare(a.started_at))
          .slice(0, Number(args[1] ?? 50));
      if (query.includes("FROM proactive_runs") && query.includes("WHERE approval_id = @approvalId")) {
        const params = args[0] as { approvalId?: string };
        const latestByDurableRunId = new Map<string, ProactiveRunRow>();
        for (const row of state.proactiveRuns.values()) {
          if (row.approval_id !== params.approvalId || !row.linked_durable_run_id) {
            continue;
          }
          const current = latestByDurableRunId.get(row.linked_durable_run_id);
          if (!current || row.started_at > current.started_at) {
            latestByDurableRunId.set(row.linked_durable_run_id, row);
          }
        }
        return [...latestByDurableRunId.values()]
          .sort((a, b) => b.started_at.localeCompare(a.started_at))
          .map((row) => ({ run_id: row.linked_durable_run_id }));
      }
      if (query.includes("FROM durable_run_events") && query.includes("WHERE run_id = ?"))
        return state.timeline
          .filter((row) => row.run_id === args[0])
          .sort((a, b) => a.created_at.localeCompare(b.created_at))
          .slice(0, Number(args[1] ?? 300));
      return [];
    },
    run: (params: Record<string, unknown>) => {
      if (query.includes("INSERT INTO proactive_runs"))
        state.proactiveRuns.set(String(params.runId), {
          run_id: String(params.runId),
          session_id: String(params.sessionId),
          linked_task_id: nullable(params.linkedTaskId),
          linked_durable_run_id: nullable(params.linkedDurableRunId),
          approval_id: nullable(params.approvalId),
          status: params.status as ProactiveRunRecord["status"],
          mode: params.mode as ProactiveRunRecord["mode"],
          trigger_source: nullable(params.triggerSource),
          origin_surface: nullable(params.originSurface),
          confidence: Number(params.confidence ?? 0),
          reasoning_summary: nullable(params.reasoningSummary),
          suggested_actions_json: String(params.suggestedActionsJson ?? "[]"),
          executed_actions_json: String(params.executedActionsJson ?? "[]"),
          next_wake_at: nullable(params.nextWakeAt),
          stop_reason: nullable(params.stopReason),
          external_reference_roots_json: nullable(params.externalReferenceRootsJson),
          resume_metadata_json: nullable(params.resumeMetadataJson),
          started_at: String(params.startedAt),
          finished_at: nullable(params.finishedAt),
          error: nullable(params.error),
        });
      if (query.includes("UPDATE proactive_runs")) {
        const current = state.proactiveRuns.get(String(params.runId));
        if (!current) throw new Error(`Unknown proactive run ${String(params.runId)}`);
        state.proactiveRuns.set(current.run_id, {
          ...current,
          status: params.status as ProactiveRunRecord["status"],
          confidence: Number(params.confidence ?? current.confidence),
          reasoning_summary: nullable(params.reasoningSummary),
          suggested_actions_json: String(params.suggestedActionsJson ?? current.suggested_actions_json),
          executed_actions_json: String(params.executedActionsJson ?? current.executed_actions_json),
          linked_task_id: nullable(params.linkedTaskId),
          linked_durable_run_id: nullable(params.linkedDurableRunId),
          approval_id: nullable(params.approvalId),
          trigger_source: nullable(params.triggerSource),
          origin_surface: nullable(params.originSurface),
          next_wake_at: nullable(params.nextWakeAt),
          stop_reason: nullable(params.stopReason),
          external_reference_roots_json: nullable(params.externalReferenceRootsJson),
          resume_metadata_json: nullable(params.resumeMetadataJson),
          error: nullable(params.error),
          finished_at: nullable(params.finishedAt),
        });
      }
      if (query.includes("INSERT INTO proactive_actions"))
        state.proactiveActions.set(String(params.actionId), {
          action_id: String(params.actionId),
          run_id: String(params.runId),
          session_id: String(params.sessionId),
          linked_task_id: nullable(params.linkedTaskId),
          linked_durable_run_id: nullable(params.linkedDurableRunId),
          approval_id: nullable(params.approvalId),
          kind: params.kind as ProactiveActionRecord["kind"],
          status: params.status as ProactiveActionRecord["status"],
          trigger_source: nullable(params.triggerSource),
          origin_surface: nullable(params.originSurface),
          tool_name: nullable(params.toolName),
          args_json: nullable(params.argsJson),
          result_json: nullable(params.resultJson),
          error: nullable(params.error),
          external_reference_roots_json: nullable(params.externalReferenceRootsJson),
          created_at: String(params.createdAt),
          updated_at: nullable(params.updatedAt),
        });
      if (query.includes("UPDATE proactive_actions")) {
        const current = state.proactiveActions.get(String(params.actionId));
        if (!current) throw new Error(`Unknown proactive action ${String(params.actionId)}`);
        state.proactiveActions.set(current.action_id, {
          ...current,
          status: params.status as ProactiveActionRecord["status"],
          result_json: nullable(params.resultJson),
          linked_task_id: nullable(params.linkedTaskId),
          linked_durable_run_id: nullable(params.linkedDurableRunId),
          approval_id: nullable(params.approvalId),
          trigger_source: nullable(params.triggerSource),
          origin_surface: nullable(params.originSurface),
          external_reference_roots_json: nullable(params.externalReferenceRootsJson),
          error: nullable(params.error),
          updated_at: nullable(params.updatedAt),
        });
      }
      if (query.includes("INSERT INTO durable_run_events"))
        state.timeline.push({
          event_id: String(params.eventId),
          run_id: String(params.runId),
          event_type: params.eventType as DurableRunTimelineEvent["eventType"],
          step_key: null,
          payload_json: nullable(params.payloadJson),
          created_at: String(params.createdAt),
        });
      return { changes: 1 };
    },
  };
}

function readRun(
  state: HarnessState,
  runId: string,
): Omit<ProactiveRunRecord, "status"> & { status: ProactiveRunRow["status"] } {
  const row = state.proactiveRuns.get(runId);
  if (!row) throw new Error(`Unknown proactive run ${runId}`);
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    linkedTaskId: row.linked_task_id ?? undefined,
    linkedDurableRunId: row.linked_durable_run_id ?? undefined,
    approvalId: row.approval_id ?? undefined,
    status: row.status,
    mode: row.mode,
    triggerSource: row.trigger_source as ProactiveRunRecord["triggerSource"],
    originSurface: row.origin_surface as ProactiveRunRecord["originSurface"],
    confidence: row.confidence,
    reasoningSummary: row.reasoning_summary ?? "",
    nextWakeAt: row.next_wake_at ?? undefined,
    stopReason: row.stop_reason as ProactiveRunRecord["stopReason"],
    externalReferenceRoots: parseJson(row.external_reference_roots_json),
    resumeMetadata: parseJson(row.resume_metadata_json),
    suggestedActions: parseJson<ProactiveActionRecord[]>(row.suggested_actions_json, []) ?? [],
    executedActions: parseJson<ProactiveActionRecord[]>(row.executed_actions_json, []) ?? [],
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    error: row.error ?? undefined,
  };
}

function actionsForRun(state: HarnessState, runId: string): ProactiveActionRecord[] {
  return [...state.proactiveActions.values()]
    .filter((row) => row.run_id === runId)
    .sort((a, b) => a.created_at.localeCompare(b.created_at))
    .map((row) => ({
      actionId: row.action_id,
      runId: row.run_id,
      sessionId: row.session_id,
      linkedTaskId: row.linked_task_id ?? undefined,
      linkedDurableRunId: row.linked_durable_run_id ?? undefined,
      approvalId: row.approval_id ?? undefined,
      kind: row.kind,
      status: row.status,
      triggerSource: row.trigger_source as ProactiveActionRecord["triggerSource"],
      originSurface: row.origin_surface as ProactiveActionRecord["originSurface"],
      toolName: row.tool_name ?? undefined,
      args: parseJson(row.args_json),
      result: parseJson(row.result_json),
      error: row.error ?? undefined,
      externalReferenceRoots: parseJson(row.external_reference_roots_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at ?? undefined,
    }));
}

function createProactiveRunRow(input: {
  runId: string;
  linkedDurableRunId: string;
  approvalId: string;
  startedAt: string;
}): ProactiveRunRow {
  return {
    run_id: input.runId,
    session_id: "session-1",
    linked_task_id: null,
    linked_durable_run_id: input.linkedDurableRunId,
    approval_id: input.approvalId,
    status: "waiting",
    mode: "auto_full",
    trigger_source: "scheduler",
    origin_surface: "chat",
    confidence: 0.8,
    reasoning_summary: "approval link test",
    suggested_actions_json: "[]",
    executed_actions_json: "[]",
    next_wake_at: null,
    stop_reason: null,
    external_reference_roots_json: null,
    resume_metadata_json: null,
    started_at: input.startedAt,
    finished_at: null,
    error: null,
  };
}

function isActiveDurable(state: HarnessState, runId: string) {
  const run = state.durableRuns.get(runId);
  return run?.workflowKey === "proactive.tick" && ["queued", "running", "waiting", "paused"].includes(run.status);
}

function parseJson<T>(raw: string | null, fallback?: T): T | undefined {
  if (!raw) return fallback;
  return JSON.parse(raw) as T;
}

function nullable(value: unknown) {
  if (value === undefined || value === null) return null;
  const stringValue = String(value);
  return stringValue.length > 0 ? stringValue : null;
}
