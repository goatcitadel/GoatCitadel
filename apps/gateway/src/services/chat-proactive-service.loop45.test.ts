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
  DurableCheckpointRecord,
  DurableRunRecord,
  ExternalSideEffectRunRecord,
  ProactiveActionRecord,
  ProactiveRunRecord,
  SessionMeta,
  TaskRecord,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import { ChatProactiveService, type ChatProactiveServiceCallbacks } from "./chat-proactive-service.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
import type { ServiceContext } from "./service-context.js";

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

type HarnessState = {
  session: SessionMeta;
  prefs: Map<string, Prefs>;
  mode: "chat" | "cowork" | "code";
  messages: Array<{ role: string; content: string }>;
  proactiveRuns: Map<string, ProactiveRunRow>;
  proactiveActions: Map<string, ProactiveActionRow>;
  durableRuns: Map<string, DurableRunRecord>;
  checkpoints: DurableCheckpointRecord[];
  tasks: Map<string, TaskRecord>;
};

describe("ChatProactiveService loop45 coverage", () => {
  it("plans no-user, empty, delegated tool, and note-only proactive actions", async () => {
    const noUser = createHarness({ messages: [] });
    await expect(callPlan(noUser.service, noUser.state.session.sessionId)).resolves.toEqual({
      confidence: 0.1,
      reasoningSummary: "No recent user prompt found.",
      actions: [],
    });

    const blank = createHarness({ messages: [{ role: "user", content: "   " }] });
    await expect(callPlan(blank.service, blank.state.session.sessionId)).resolves.toEqual({
      confidence: 0.1,
      reasoningSummary: "Latest user prompt is empty.",
      actions: [],
    });

    const delegatedTool = createHarness({
      messages: [{ role: "user", content: "Route this PRD and QA handoff with latest weather today." }],
      detectDelegationRoles: () => ["Product", "QA"],
    });
    await expect(callPlan(delegatedTool.service, delegatedTool.state.session.sessionId)).resolves.toMatchObject({
      confidence: 0.78,
      reasoningSummary: "Generated actions from latest user intent and route hints.",
      actions: [
        {
          kind: "delegate",
          roles: ["Product", "QA"],
        },
        {
          kind: "tool",
          toolName: "browser.search",
          args: { query: "Route this PRD and QA handoff with latest weather today.", maxResults: 5 },
        },
      ],
    });

    const noteOnly = createHarness({ messages: [{ role: "user", content: "Please follow up later." }] });
    await expect(callPlan(noteOnly.service, noteOnly.state.session.sessionId)).resolves.toMatchObject({
      confidence: 0.42,
      actions: [{ kind: "note", note: "Consider running /delegate for structured multi-role output." }],
    });
  });

  it("finishes durable ticks for policy-off, running-turn, idle, and planner-no-action exits", async () => {
    const exits = [
      {
        name: "mode_off",
        harness: createHarness({ prefs: { proactiveMode: "off" } }),
        expected: { reasoningSummary: "Proactive mode is off.", stopReason: "no_action" },
      },
      {
        name: "running_turn",
        harness: createHarness({ hasRunningTurn: () => true }),
        expected: { reasoningSummary: "Skipped because a chat turn is still running.", stopReason: "no_action" },
      },
      {
        name: "idle_below_threshold",
        harness: createHarness({ idleSeconds: () => 12 }),
        expected: {
          reasoningSummary: "Skipped because session idle time (12s) is below 90s.",
          stopReason: "no_action",
        },
      },
      {
        name: "planner_no_action",
        harness: createHarness({ messages: [] }),
        expected: { reasoningSummary: "No recent user prompt found.", stopReason: "no_action" },
      },
    ];

    for (const entry of exits) {
      const started = await entry.harness.service.triggerChatSessionProactive(entry.harness.state.session.sessionId, {
        source: "manual",
      });
      const claimed = claimDurableRun(entry.harness.state, started.linkedDurableRunId!);
      await entry.harness.service.executeDurableProactiveTickRun(claimed);

      const completed = readRun(entry.harness.state, started.runId);
      expect(completed, entry.name).toMatchObject({
        status: "no_action",
        linkedDurableRunId: started.linkedDurableRunId,
        ...entry.expected,
      });
      expect(entry.harness.state.durableRuns.get(started.linkedDurableRunId!)?.status, entry.name).toBe("completed");
      expect(entry.harness.state.checkpoints.at(-1), entry.name).toMatchObject({
        runId: started.linkedDurableRunId,
        checkpointKind: "run_completed",
      });
    }
  });

  it("resolves autonomy budget and tool eligibility branches", () => {
    const { service } = createHarness();
    const action = createActionRecord({ kind: "tool", toolName: "time.now" });
    const resolve = service as unknown as {
      resolveProactiveAction: (
        action: ProactiveActionRecord,
        mode: "off" | "suggest" | "auto_safe" | "auto_full",
        remainingHourBudget: number,
        remainingTurnBudget: number,
      ) => { execute: boolean; reason?: string };
    };

    expect(resolve.resolveProactiveAction(action, "auto_full", 0, 1)).toEqual({
      execute: false,
      reason: "Autonomy hour budget exhausted.",
    });
    expect(resolve.resolveProactiveAction(action, "auto_full", 1, 0)).toEqual({
      execute: false,
      reason: "Autonomy turn budget exhausted.",
    });
    expect(resolve.resolveProactiveAction(createActionRecord({ kind: "note" }), "auto_full", 1, 1)).toEqual({
      execute: false,
      reason: "Only tool actions are eligible for automatic execution.",
    });
    expect(
      resolve.resolveProactiveAction(createActionRecord({ kind: "tool", toolName: "shell.exec" }), "auto_safe", 1, 1),
    ).toEqual({
      execute: false,
      reason: "Tool shell.exec is not allowlisted for auto_safe mode.",
    });
    expect(resolve.resolveProactiveAction(action, "auto_full", 1, 1)).toEqual({ execute: true });
    expect(resolve.resolveProactiveAction(action, "auto_safe", 1, 1)).toEqual({ execute: true });
  });

  it("persists invalid durable payloads, active-run reuse, and tool block outcomes", async () => {
    const invalidPayload = createHarness();
    const invalidRun = createDurableRun({ payload: { version: "not-proactive" } });
    invalidPayload.state.durableRuns.set(invalidRun.runId, invalidRun);
    await expect(invalidPayload.service.executeDurableProactiveTickRun(invalidRun)).rejects.toThrow(
      "Durable proactive tick payload is invalid or incomplete.",
    );

    const active = createHarness({ mode: "cowork" });
    const existingDurable = createDurableRun({ status: "running" });
    active.state.durableRuns.set(existingDurable.runId, existingDurable);
    const existingRun = createRunRow({
      runId: "existing-run",
      sessionId: active.state.session.sessionId,
      linkedDurableRunId: existingDurable.runId,
      originSurface: "cowork",
    });
    active.state.proactiveRuns.set(existingRun.run_id, existingRun);
    await expect(active.service.triggerChatSessionProactive(active.state.session.sessionId)).resolves.toMatchObject({
      runId: "existing-run",
      originSurface: "cowork",
      linkedDurableRunId: existingDurable.runId,
    });

    const toolBlock = createHarness();
    const missingTool = createActionRecord({ actionId: "missing-tool", kind: "tool", toolName: undefined });
    toolBlock.state.proactiveActions.set(missingTool.actionId, actionToRow(missingTool));
    await expect(callExecuteTool(toolBlock.service, missingTool, "durable-missing")).resolves.toMatchObject({
      status: "blocked",
      linkedDurableRunId: "durable-missing",
      error: "Missing tool name.",
    });

    const denied = createActionRecord({
      actionId: "denied-tool",
      kind: "tool",
      toolName: "browser.search",
      args: { query: "latest status" },
    });
    toolBlock.state.proactiveActions.set(denied.actionId, { ...actionToRow(denied), args_json: "{bad-json" });
    toolBlock.invokeTool.mockResolvedValueOnce({
      outcome: "blocked",
      policyReason: "Network egress denied.",
      auditEventId: "audit-denied",
    } satisfies ToolInvokeResult);

    await expect(callExecuteTool(toolBlock.service, denied, "durable-denied")).resolves.toMatchObject({
      status: "blocked",
      linkedDurableRunId: "durable-denied",
      error: "Network egress denied.",
      args: {},
    });
  });
});

function callPlan(service: ChatProactiveService, sessionId: string) {
  return (
    service as unknown as {
      planProactiveActions: (sessionId: string) => Promise<{
        confidence: number;
        reasoningSummary: string;
        actions: Array<Record<string, unknown>>;
      }>;
    }
  ).planProactiveActions(sessionId);
}

function claimDurableRun(state: HarnessState, runId: string): DurableRunRecord {
  const current = state.durableRuns.get(runId)!;
  const claimed = {
    ...current,
    status: "running" as const,
    version: current.version + 1,
    leaseOwnerId: "worker-loop45",
    leaseHeartbeatAt: new Date().toISOString(),
    leaseExpiresAt: "2099-12-31T23:59:59.999Z",
  };
  state.durableRuns.set(runId, claimed);
  return claimed;
}

function callExecuteTool(service: ChatProactiveService, action: ProactiveActionRecord, durableRunId: string) {
  return (
    service as unknown as {
      executeProactiveToolAction: (
        action: ProactiveActionRecord,
        durableRunId: string,
      ) => Promise<ProactiveActionRecord>;
    }
  ).executeProactiveToolAction(action, durableRunId);
}

function createHarness(
  options: {
    prefs?: Partial<Prefs>;
    messages?: Array<{ role: string; content: string }>;
    mode?: "chat" | "cowork" | "code";
    idleSeconds?: () => number;
    hasRunningTurn?: () => boolean;
    detectDelegationRoles?: (text: string) => string[];
  } = {},
) {
  const session: SessionMeta = {
    sessionId: "session-loop45",
    sessionKey: "chat:session-loop45",
    kind: "dm",
    channel: "chat",
    account: "local",
    displayName: "Loop45",
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
  const now = new Date().toISOString();
  const prefs: Prefs = {
    sessionId: session.sessionId,
    proactiveMode: "auto_full",
    maxActionsPerHour: 10,
    maxActionsPerTurn: 5,
    cooldownSeconds: 0,
    retrievalMode: "standard",
    reflectionMode: "off",
    createdAt: now,
    updatedAt: now,
    ...options.prefs,
  };
  const state: HarnessState = {
    session,
    prefs: new Map([[session.sessionId, prefs]]),
    mode: options.mode ?? "chat",
    messages: options.messages ?? [{ role: "user", content: "What is the current time?" }],
    proactiveRuns: new Map(),
    proactiveActions: new Map(),
    durableRuns: new Map(),
    checkpoints: [],
    tasks: new Map(),
  };
  const storage = createStorage(state);
  const publishRealtime = vi.fn();
  const invokeTool = vi.fn();
  const callbacks: ChatProactiveServiceCallbacks = {
    listChatSessions: () => [{ sessionId: session.sessionId, lastActivityAt: session.lastActivityAt }],
    getSession: () => session,
    hasRunningTurn: options.hasRunningTurn ?? (() => false),
    getSessionIdleSeconds: options.idleSeconds ?? (() => 600),
    listChatMessages: async () => state.messages,
    invokeTool: async (request, options) => {
      const result = await invokeTool(request);
      if (result?.outcome === "executed") {
        options?.externalSideEffect?.markStarted();
      }
      return result;
    },
    detectDelegationRoles: options.detectDelegationRoles ?? (() => []),
    createDurableRun: (input) => {
      const run = createDurableRun({
        workflowKey: input.workflowKey,
        payload: input.payload,
        metadata: input.metadata,
      });
      state.durableRuns.set(run.runId, run);
      return run;
    },
    requestDurableRunProcessing: vi.fn(),
    backgroundTasks: new Set(),
    closing: false,
  };
  const ctx = {
    storage,
    gatewaySql: {
      prepare: (sql: string) => createStatement(sql, state),
      runImmediateTransaction: <T>(callback: () => T): T => callback(),
    },
    publishRealtime,
    isFeatureEnabled: (flag: keyof RuntimeSettings["features"]) => flag === "durableKernelV1Enabled",
  } as unknown as ServiceContext;
  return {
    state,
    service: new ChatProactiveService(ctx, callbacks),
    invokeTool,
    publishRealtime,
  };
}

function createStorage(state: HarnessState) {
  const mutations = new Map<string, { payloadHash: string; status: "pending" | "completed" | "failed" }>();
  const sideEffects = new Map<string, ExternalSideEffectRunRecord>();
  return {
    runImmediateTransaction: <T>(callback: () => T): T => callback(),
    mutationIdempotency: {
      claim: (input: { routePath: string; idempotencyKey: string; actorScope?: string; payloadHash: string }) => {
        const key = `${input.routePath}:${input.idempotencyKey}:${input.actorScope ?? ""}`;
        const existing = mutations.get(key);
        if (!existing) {
          const record = { payloadHash: input.payloadHash, status: "pending" as const };
          mutations.set(key, record);
          return { outcome: "claimed" as const, claimKind: "new" as const, record };
        }
        if (existing.payloadHash !== input.payloadHash) {
          return { outcome: "payload_mismatch" as const, record: existing };
        }
        return {
          outcome: existing.status === "completed" ? ("duplicate" as const) : ("in_progress" as const),
          record: existing,
        };
      },
      markCompleted: (input: { routePath: string; idempotencyKey: string; actorScope?: string }) => {
        const key = `${input.routePath}:${input.idempotencyKey}:${input.actorScope ?? ""}`;
        const current = mutations.get(key)!;
        mutations.set(key, { ...current, status: "completed" });
      },
      markFailed: (input: { routePath: string; idempotencyKey: string; actorScope?: string }) => {
        const key = `${input.routePath}:${input.idempotencyKey}:${input.actorScope ?? ""}`;
        const current = mutations.get(key)!;
        mutations.set(key, { ...current, status: "failed" });
      },
    },
    externalSideEffectRuns: {
      createOrGet: (input: Record<string, unknown>, createdAt = new Date().toISOString()) => {
        const key = `${String(input.boundary)}:${String(input.idempotencyKey)}`;
        const existing = sideEffects.get(key);
        if (existing) return existing;
        const record = {
          runId: key,
          workspaceId: String(input.workspaceId ?? "default"),
          boundary: String(input.boundary),
          routePath: String(input.routePath),
          catalogId: typeof input.catalogId === "string" ? input.catalogId : undefined,
          actionId: typeof input.actionId === "string" ? input.actionId : undefined,
          actorScope: String(input.actorScope ?? ""),
          idempotencyKey: String(input.idempotencyKey),
          payloadHash: String(input.payloadHash),
          status: (input.status ?? "claimed_not_sent") as ExternalSideEffectRunRecord["status"],
          replayPolicy: "idempotent_external" as const,
          replayOutcome: input.replayOutcome as ExternalSideEffectRunRecord["replayOutcome"],
          replayAttempt: input.replayAttempt as ExternalSideEffectRunRecord["replayAttempt"],
          resumeState: "not_resumable" as const,
          attemptCount: 0,
          createdAt,
          updatedAt: createdAt,
        } satisfies ExternalSideEffectRunRecord;
        sideEffects.set(key, record);
        return record;
      },
      markExternalCallStarted: (runId: string) => updateSideEffect(sideEffects, runId, "external_call_started"),
      markCompleted: (runId: string) => updateSideEffect(sideEffects, runId, "completed"),
      markFailure: (runId: string, input: { status: "failed_before_boundary" | "unknown_external_outcome" }) =>
        updateSideEffect(sideEffects, runId, input.status),
    },
    sessionAutonomyPrefs: {
      ensure: (sessionId: string) => state.prefs.get(sessionId)!,
      patch: (sessionId: string, patch: Partial<Prefs>) => {
        const next = { ...state.prefs.get(sessionId)!, ...patch, updatedAt: new Date().toISOString() };
        state.prefs.set(sessionId, next);
        return next;
      },
      touch: (sessionId: string, runId: string) => {
        const next = {
          ...state.prefs.get(sessionId)!,
          lastProactiveAt: new Date().toISOString(),
          lastProactiveRunId: runId,
        };
        state.prefs.set(sessionId, next);
      },
      listBySessionIds: (sessionIds: string[]) =>
        new Map(
          sessionIds.flatMap((sessionId) =>
            state.prefs.has(sessionId) ? [[sessionId, state.prefs.get(sessionId)!]] : [],
          ),
        ),
    },
    chatSessionPrefs: { ensure: () => ({ mode: state.mode }) },
    chatSessionMeta: { ensure: () => ({ workspaceId: "default" }) },
    chatMessages: { list: () => state.messages },
    tasks: {
      find: (taskId: string) => state.tasks.get(taskId),
      get: (taskId: string) => state.tasks.get(taskId)!,
      create: (input: Partial<TaskRecord> & { title: string }) => {
        const task = {
          taskId: randomUUID(),
          title: input.title,
          status: input.status ?? "in_progress",
          priority: input.priority ?? "normal",
          workspaceId: input.workspaceId,
          proactiveContext: input.proactiveContext,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        } as TaskRecord;
        state.tasks.set(task.taskId, task);
        return task;
      },
      update: (taskId: string, patch: Partial<TaskRecord>) => {
        const task = { ...state.tasks.get(taskId)!, ...patch, updatedAt: new Date().toISOString() };
        state.tasks.set(taskId, task);
        return task;
      },
    },
    durableRuns: {
      getRun: (runId: string) => state.durableRuns.get(runId)!,
      lockFreshActiveLeaseForUpdate: (runId: string, expectedLeaseOwnerId: string) => {
        const run = state.durableRuns.get(runId);
        return run?.status === "running" &&
          run.leaseOwnerId === expectedLeaseOwnerId &&
          run.leaseExpiresAt &&
          Date.parse(run.leaseExpiresAt) > Date.now()
          ? run
          : undefined;
      },
      updateRun: (input: {
        runId: string;
        status: DurableRunRecord["status"];
        metadata?: Record<string, unknown>;
        finishedAt?: string;
        startedAt?: string;
        updatedAt?: string;
        lastError?: string;
        clearLease?: boolean;
      }) => {
        const current = state.durableRuns.get(input.runId)!;
        const next = {
          ...current,
          status: input.status,
          metadata: input.metadata ?? current.metadata,
          startedAt: input.startedAt ?? current.startedAt,
          finishedAt: input.finishedAt ?? current.finishedAt,
          lastError: input.lastError ?? current.lastError,
          updatedAt: input.updatedAt ?? new Date().toISOString(),
          ...(input.clearLease
            ? { leaseOwnerId: undefined, leaseHeartbeatAt: undefined, leaseExpiresAt: undefined }
            : {}),
        };
        state.durableRuns.set(next.runId, next);
        return next;
      },
      createCheckpoint: (input: {
        runId: string;
        checkpointKind: DurableCheckpointRecord["checkpointKind"];
        state?: Record<string, unknown>;
        createdAt?: string;
      }) => {
        const checkpoint = {
          checkpointId: randomUUID(),
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
      append: vi.fn(),
    },
    approvals: {
      get: vi.fn(),
      mergeLinkage: vi.fn(),
    },
    pendingApprovalActions: {
      find: vi.fn(),
    },
  };
}

function updateSideEffect(
  records: Map<string, ExternalSideEffectRunRecord>,
  runId: string,
  status: ExternalSideEffectRunRecord["status"],
): ExternalSideEffectRunRecord {
  const current = records.get(runId)!;
  const next = { ...current, status, updatedAt: new Date().toISOString() };
  records.set(runId, next);
  return next;
}

function createStatement(sql: string, state: HarnessState) {
  const query = sql.replace(/\s+/g, " ").trim();
  return {
    get: (...args: unknown[]) => {
      if (query.includes("FROM proactive_runs pr JOIN durable_runs dr")) {
        return [...state.proactiveRuns.values()].find(
          (row) =>
            row.session_id === args[0] &&
            row.linked_durable_run_id &&
            isActiveDurable(state, row.linked_durable_run_id),
        );
      }
      if (query.includes("FROM proactive_runs") && query.includes("WHERE run_id = ?")) {
        return state.proactiveRuns.get(String(args[0]));
      }
      if (query.includes("FROM proactive_actions") && query.includes("WHERE action_id = ?")) {
        return state.proactiveActions.get(String(args[0]));
      }
      if (query.includes("FROM proactive_actions") && query.includes("status = 'executed'")) {
        return {
          count: [...state.proactiveActions.values()].filter(
            (row) => row.session_id === args[0] && row.status === "executed" && row.created_at >= String(args[1]),
          ).length,
        };
      }
      if (query.includes("FROM proactive_actions") && query.includes("status = 'suggested'")) {
        return {
          count: [...state.proactiveActions.values()].filter(
            (row) => row.session_id === args[0] && row.status === "suggested",
          ).length,
        };
      }
      return undefined;
    },
    all: (...args: unknown[]) => {
      if (query.includes("FROM proactive_actions") && query.includes("WHERE run_id = ?")) {
        return [...state.proactiveActions.values()]
          .filter((row) => row.run_id === args[0])
          .sort((left, right) => left.created_at.localeCompare(right.created_at));
      }
      if (query.includes("FROM proactive_runs") && query.includes("WHERE session_id = ?")) {
        return [...state.proactiveRuns.values()]
          .filter((row) => row.session_id === args[0])
          .sort((left, right) => right.started_at.localeCompare(left.started_at))
          .slice(0, Number(args[1] ?? 50));
      }
      return [];
    },
    run: (params: Record<string, unknown>) => {
      if (query.includes("INSERT INTO proactive_runs")) {
        state.proactiveRuns.set(String(params.runId), {
          run_id: String(params.runId),
          session_id: String(params.sessionId),
          linked_task_id: nullable(params.linkedTaskId),
          linked_durable_run_id: nullable(params.linkedDurableRunId),
          approval_id: nullable(params.approvalId),
          status: params.status as ProactiveRunRow["status"],
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
      }
      if (query.includes("UPDATE proactive_runs")) {
        const current = state.proactiveRuns.get(String(params.runId))!;
        state.proactiveRuns.set(current.run_id, {
          ...current,
          status: params.status as ProactiveRunRow["status"],
          linked_task_id: nullable(params.linkedTaskId),
          linked_durable_run_id: nullable(params.linkedDurableRunId),
          approval_id: nullable(params.approvalId),
          confidence: Number(params.confidence ?? current.confidence),
          reasoning_summary: nullable(params.reasoningSummary),
          suggested_actions_json: String(params.suggestedActionsJson ?? current.suggested_actions_json),
          executed_actions_json: String(params.executedActionsJson ?? current.executed_actions_json),
          next_wake_at: nullable(params.nextWakeAt),
          stop_reason: nullable(params.stopReason),
          external_reference_roots_json: nullable(params.externalReferenceRootsJson),
          resume_metadata_json: nullable(params.resumeMetadataJson),
          finished_at: nullable(params.finishedAt),
          error: nullable(params.error),
        });
      }
      if (query.includes("UPDATE proactive_actions")) {
        const current = state.proactiveActions.get(String(params.actionId))!;
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
      return { changes: 1 };
    },
  };
}

function createDurableRun(
  input: {
    workflowKey?: string;
    status?: DurableRunRecord["status"];
    payload?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
  } = {},
): DurableRunRecord {
  const now = new Date().toISOString();
  return {
    runId: randomUUID(),
    workflowKey: input.workflowKey ?? "proactive.tick",
    status: input.status ?? "queued",
    attemptCount: 0,
    maxAttempts: 3,
    version: 1,
    payload: input.payload ?? {},
    metadata: input.metadata,
    createdAt: now,
    updatedAt: now,
  };
}

function createRunRow(input: {
  runId: string;
  sessionId: string;
  linkedDurableRunId: string;
  originSurface?: "chat" | "cowork" | "code";
}): ProactiveRunRow {
  return {
    run_id: input.runId,
    session_id: input.sessionId,
    linked_task_id: null,
    linked_durable_run_id: input.linkedDurableRunId,
    approval_id: null,
    status: "running",
    mode: "auto_full",
    trigger_source: "manual",
    origin_surface: input.originSurface ?? "chat",
    confidence: 0,
    reasoning_summary: "existing active run",
    suggested_actions_json: "[]",
    executed_actions_json: "[]",
    next_wake_at: null,
    stop_reason: null,
    external_reference_roots_json: null,
    resume_metadata_json: null,
    started_at: new Date().toISOString(),
    finished_at: null,
    error: null,
  };
}

function createActionRecord(input: Partial<ProactiveActionRecord>): ProactiveActionRecord {
  return {
    actionId: input.actionId ?? randomUUID(),
    runId: input.runId ?? "run-loop45",
    sessionId: input.sessionId ?? "session-loop45",
    kind: input.kind ?? "tool",
    status: input.status ?? "suggested",
    triggerSource: input.triggerSource ?? "manual",
    originSurface: input.originSurface ?? "chat",
    toolName: input.toolName,
    args: input.args,
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

function actionToRow(action: ProactiveActionRecord): ProactiveActionRow {
  return {
    action_id: action.actionId,
    run_id: action.runId,
    session_id: action.sessionId,
    linked_task_id: action.linkedTaskId ?? null,
    linked_durable_run_id: action.linkedDurableRunId ?? null,
    approval_id: action.approvalId ?? null,
    kind: action.kind,
    status: action.status,
    trigger_source: action.triggerSource ?? null,
    origin_surface: action.originSurface ?? null,
    tool_name: action.toolName ?? null,
    args_json: action.args ? JSON.stringify(action.args) : null,
    result_json: action.result ? JSON.stringify(action.result) : null,
    error: action.error ?? null,
    external_reference_roots_json: action.externalReferenceRoots ? JSON.stringify(action.externalReferenceRoots) : null,
    created_at: action.createdAt,
    updated_at: action.updatedAt ?? null,
  };
}

function readRun(state: HarnessState, runId: string): ProactiveRunRecord {
  const row = state.proactiveRuns.get(runId)!;
  return {
    runId: row.run_id,
    sessionId: row.session_id,
    linkedDurableRunId: row.linked_durable_run_id ?? undefined,
    status: row.status as ProactiveRunRecord["status"],
    mode: row.mode,
    triggerSource: row.trigger_source as ProactiveRunRecord["triggerSource"],
    originSurface: row.origin_surface as ProactiveRunRecord["originSurface"],
    confidence: row.confidence,
    reasoningSummary: row.reasoning_summary ?? "",
    stopReason: row.stop_reason as ProactiveRunRecord["stopReason"],
    suggestedActions: JSON.parse(row.suggested_actions_json) as ProactiveActionRecord[],
    executedActions: JSON.parse(row.executed_actions_json) as ProactiveActionRecord[],
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? undefined,
    error: row.error ?? undefined,
  };
}

function isActiveDurable(state: HarnessState, runId: string) {
  const run = state.durableRuns.get(runId);
  return run?.workflowKey === "proactive.tick" && ["queued", "running", "waiting", "paused"].includes(run.status);
}

function nullable(value: unknown) {
  if (value === undefined || value === null) return null;
  const stringValue = String(value);
  return stringValue.length > 0 ? stringValue : null;
}
