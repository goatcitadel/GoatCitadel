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
import {
  SCHEDULED_TURN_PERMISSION_PROFILE_ID,
  type ApprovalRequest,
  type ApprovalWaitWorkflowPayload,
  type DurableCheckpointRecord,
  type DurableRunRecord,
  type DurableRunTimelineEvent,
  type ExternalSideEffectRunRecord,
  type PendingApprovalAction,
  type ProactiveActionRecord,
  type ProactiveRunRecord,
  type SessionMeta,
  type TaskRecord,
  type ToolInvokeRequest,
  type ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { ServiceContext } from "./service-context.js";
import type { RuntimeSettings } from "./gateway/runtime-settings.js";
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

  it("skips scheduler ticks when the autonomy kill switch is engaged", async () => {
    const harness = createHarness({ autonomyV1Disabled: true });
    const triggerSpy = vi.spyOn(harness.service, "triggerChatSessionProactive");

    await (harness.service as unknown as { runSchedulerTick: () => Promise<void> }).runSchedulerTick();

    expect(triggerSpy).not.toHaveBeenCalled();
    expect(harness.state.durableRuns.size).toBe(0);
  });

  it("does not schedule work while closing and uses default off prefs when none are stored", async () => {
    const closingHarness = createHarness({ callbacks: { closing: true } });
    const closingTriggerSpy = vi.spyOn(closingHarness.service, "triggerChatSessionProactive");

    await (closingHarness.service as unknown as { runSchedulerTick: () => Promise<void> }).runSchedulerTick();

    expect(closingTriggerSpy).not.toHaveBeenCalled();
    expect(closingHarness.state.durableRuns.size).toBe(0);

    const missingPrefsHarness = createHarness();
    missingPrefsHarness.state.prefs.delete(missingPrefsHarness.state.session.sessionId);
    const missingPrefsTriggerSpy = vi.spyOn(missingPrefsHarness.service, "triggerChatSessionProactive");

    await (missingPrefsHarness.service as unknown as { runSchedulerTick: () => Promise<void> }).runSchedulerTick();

    expect(missingPrefsTriggerSpy).not.toHaveBeenCalled();
    expect(missingPrefsHarness.state.durableRuns.size).toBe(0);
  });

  it("publishes scheduler interval errors and keeps startScheduler idempotent", async () => {
    vi.useFakeTimers();
    try {
      const listChatSessions = vi.fn(() => {
        throw new Error("session query failed");
      });
      const harness = createHarness({
        callbacks: {
          listChatSessions,
        },
      });

      harness.service.startScheduler();
      harness.service.startScheduler();
      await vi.advanceTimersByTimeAsync(120_000);
      await Promise.allSettled([...harness.backgroundTasks]);
      harness.service.stopScheduler();

      expect(listChatSessions).toHaveBeenCalledTimes(1);
      expect(harness.publishRealtime).toHaveBeenCalledWith(
        "system",
        "chat",
        expect.objectContaining({
          type: "proactive_scheduler_error",
          message: "session query failed",
        }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("skips scheduler ticks when the session has no activity since the last proactive tick", async () => {
    const harness = createHarness();
    const triggerSpy = vi.spyOn(harness.service, "triggerChatSessionProactive");
    const prefs = harness.state.prefs.get(harness.state.session.sessionId)!;
    harness.state.prefs.set(harness.state.session.sessionId, {
      ...prefs,
      lastProactiveAt: "2026-04-04T18:56:00.000Z",
      lastProactiveRunId: "previous-run",
    });

    await (harness.service as unknown as { runSchedulerTick: () => Promise<void> }).runSchedulerTick();

    expect(triggerSpy).not.toHaveBeenCalled();
    expect(harness.state.durableRuns.size).toBe(0);
  });

  it("allows scheduler ticks after newer session activity", async () => {
    const harness = createHarness();
    const triggerSpy = vi.spyOn(harness.service, "triggerChatSessionProactive");
    const prefs = harness.state.prefs.get(harness.state.session.sessionId)!;
    harness.state.prefs.set(harness.state.session.sessionId, {
      ...prefs,
      lastProactiveAt: "2026-04-04T18:54:00.000Z",
      lastProactiveRunId: "previous-run",
    });

    await (harness.service as unknown as { runSchedulerTick: () => Promise<void> }).runSchedulerTick();

    expect(triggerSpy).toHaveBeenCalledWith(
      harness.state.session.sessionId,
      expect.objectContaining({ source: "scheduler" }),
    );
    expect(harness.state.durableRuns.size).toBe(1);
    const run = [...harness.state.proactiveRuns.values()][0];
    expect(JSON.parse(run?.resume_metadata_json ?? "{}")).toMatchObject({
      operatorId: "system-proactive",
      authActorId: "system-proactive",
      authActorSource: "none",
      permissionProfileId: SCHEDULED_TURN_PERMISSION_PROFILE_ID,
    });
  });

  it("treats invalid proactive timestamps as eligible instead of stale", async () => {
    const harness = createHarness();
    const triggerSpy = vi.spyOn(harness.service, "triggerChatSessionProactive");
    const prefs = harness.state.prefs.get(harness.state.session.sessionId)!;
    harness.state.prefs.set(harness.state.session.sessionId, {
      ...prefs,
      lastProactiveAt: "not-a-date",
      lastProactiveRunId: "previous-run",
    });

    await (harness.service as unknown as { runSchedulerTick: () => Promise<void> }).runSchedulerTick();

    expect(triggerSpy).toHaveBeenCalledWith(
      harness.state.session.sessionId,
      expect.objectContaining({ source: "scheduler" }),
    );
    expect(harness.state.durableRuns.size).toBe(1);
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

  it("patchProactiveRun performs the read-modify-write atomically (no lost update on concurrent resume)", () => {
    const harness = createHarness();
    const { service, state } = harness;
    state.proactiveRuns.set(
      "run-race",
      createProactiveRunRow({
        runId: "run-race",
        linkedDurableRunId: "durable-old",
        approvalId: "approval-1",
        startedAt: "2026-04-04T18:00:00.000Z",
      }),
    );

    const patch = (
      service as unknown as {
        patchProactiveRun: (runId: string, patch: Partial<ProactiveRunRecord>) => ProactiveRunRecord;
      }
    ).patchProactiveRun.bind(service);

    // Both the read and the write of patchProactiveRun must run inside a single
    // immediate transaction so a concurrent resolution cannot read the same row,
    // merge, and clobber the other writer's field updates.
    const txSpy = vi.spyOn(
      (service as unknown as { ctx: { gatewaySql: { runImmediateTransaction: <T>(cb: () => T) => T } } }).ctx
        .gatewaySql,
      "runImmediateTransaction",
    );

    // Models the documented interleave: the durable tick re-queue path links a
    // fresh durable run id, while the approval-resume path clears the approval
    // and flips status back to running. Each writes a DIFFERENT field on the
    // same run; after both, BOTH updates must survive.
    patch("run-race", { linkedDurableRunId: "durable-new" });
    patch("run-race", { status: "running", approvalId: undefined });

    expect(txSpy).toHaveBeenCalledTimes(2);

    const row = state.proactiveRuns.get("run-race")!;
    expect(row.linked_durable_run_id).toBe("durable-new"); // first writer's field preserved
    expect(row.status).toBe("running"); // second writer's field applied
    expect(row.approval_id).toBeNull(); // second writer cleared the approval
  });

  it("preserves same-owner metadata written before the waiting transaction locks the durable run", () => {
    const harness = createHarness();
    const runId = "durable-waiting-metadata-race";
    const claimed: DurableRunRecord = {
      runId,
      workflowKey: "proactive.tick",
      status: "running",
      attemptCount: 0,
      maxAttempts: 3,
      version: 1,
      payload: {},
      metadata: {
        stableMarker: "v1",
        proactive: { phase: "planning", taskId: "task-v1" },
      },
      leaseOwnerId: "worker-race",
      leaseHeartbeatAt: "2026-07-11T10:00:00.000Z",
      leaseExpiresAt: "2099-12-31T23:59:59.999Z",
      createdAt: "2026-07-11T10:00:00.000Z",
      updatedAt: "2026-07-11T10:00:00.000Z",
    };
    harness.state.durableRuns.set(runId, claimed);
    const sameOwnerV2: DurableRunRecord = {
      ...claimed,
      version: 2,
      metadata: {
        stableMarker: "v2",
        sameOwnerWrite: { revision: 2, source: "heartbeat" },
        proactive: { phase: "planning", taskId: "task-v2" },
      },
      updatedAt: "2026-07-11T10:00:01.000Z",
    };
    let enteredTransaction = false;
    const runImmediateTransaction = harness.storage.runImmediateTransaction;
    harness.storage.runImmediateTransaction = <T>(work: () => T): T => {
      if (!enteredTransaction) {
        enteredTransaction = true;
        harness.state.durableRuns.set(runId, sameOwnerV2);
      }
      return runImmediateTransaction(work);
    };
    const lockFreshActiveLeaseForUpdate = vi.spyOn(harness.storage.durableRuns, "lockFreshActiveLeaseForUpdate");

    const updated = (
      harness.service as unknown as {
        markDurableRunWaiting(
          run: DurableRunRecord,
          waitForEvent: { eventKey: string; correlationId?: string; payload?: Record<string, unknown> },
          statePatch: Record<string, unknown>,
        ): DurableRunRecord;
      }
    ).markDurableRunWaiting(
      claimed,
      {
        eventKey: "approval.resolved",
        correlationId: "approval-race",
        payload: { proactiveRunId: "proactive-race" },
      },
      { phase: "awaiting_approval", approvalId: "approval-race" },
    );

    expect(lockFreshActiveLeaseForUpdate).toHaveBeenCalledWith(runId, "worker-race");
    expect(updated.metadata).toMatchObject({
      stableMarker: "v2",
      sameOwnerWrite: { revision: 2, source: "heartbeat" },
      proactive: {
        phase: "awaiting_approval",
        taskId: "task-v2",
        approvalId: "approval-race",
      },
    });
    expect(harness.state.checkpoints.at(-1)?.state).toMatchObject({
      waitForEvent: { eventKey: "approval.resolved", correlationId: "approval-race" },
      proactive: {
        phase: "awaiting_approval",
        taskId: "task-v2",
        approvalId: "approval-race",
      },
    });
  });

  it("uses the database-clock lease lock for proactive state updates and completion", () => {
    const harness = createHarness();
    const runId = "durable-proactive-fresh-lease";
    const claimed: DurableRunRecord = {
      runId,
      workflowKey: "proactive.tick",
      status: "running",
      attemptCount: 0,
      maxAttempts: 3,
      version: 1,
      payload: {},
      metadata: { proactive: { phase: "planning" } },
      leaseOwnerId: "worker-fresh",
      leaseHeartbeatAt: "2026-07-11T10:00:00.000Z",
      leaseExpiresAt: "2099-12-31T23:59:59.999Z",
      createdAt: "2026-07-11T10:00:00.000Z",
      updatedAt: "2026-07-11T10:00:00.000Z",
    };
    harness.state.durableRuns.set(runId, claimed);
    const lockFreshActiveLeaseForUpdate = vi.spyOn(harness.storage.durableRuns, "lockFreshActiveLeaseForUpdate");
    const service = harness.service as unknown as {
      updateProactiveDurableRunState(run: DurableRunRecord, patch: Record<string, unknown>): DurableRunRecord;
      completeDurableRun(run: DurableRunRecord, checkpointState: Record<string, unknown>): void;
    };

    const updated = service.updateProactiveDurableRunState(claimed, { phase: "executing" });
    service.completeDurableRun(updated, { proactiveRunId: "proactive-fresh" });

    expect(lockFreshActiveLeaseForUpdate).toHaveBeenNthCalledWith(1, runId, "worker-fresh");
    expect(lockFreshActiveLeaseForUpdate).toHaveBeenNthCalledWith(2, runId, "worker-fresh");
    expect(harness.state.durableRuns.get(runId)).toMatchObject({ status: "completed", leaseOwnerId: undefined });
  });

  it("resumes approval-blocked proactive durable runs from checkpoint without rerunning completed actions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T19:00:00.000Z"));
    try {
      const resolveToolPolicyContext = vi.fn(
        (input: Parameters<NonNullable<ChatProactiveServiceCallbacks["resolveToolPolicyContext"]>>[0]) => ({
          ...input,
          permissionProfileId: input.permissionProfileId ?? "safe",
          localOperatorOverrideId: input.localOperatorOverrideId,
        }),
      );
      const harness = createHarness({
        callbacks: {
          resolveToolPolicyContext,
        },
      });
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

      const started = await service.triggerChatSessionProactive(state.session.sessionId, {
        source: "manual",
        operatorId: "operator-1",
        authActorId: "operator-1",
        authActorSource: "token",
        permissionProfileId: "profile-1",
        localOperatorOverrideId: "override-1",
      });
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
      expect(blockedRun.resumeMetadata).toMatchObject({
        operatorId: "operator-1",
        authActorId: "operator-1",
        authActorSource: "token",
        permissionProfileId: "profile-1",
        localOperatorOverrideId: "override-1",
      });
      expect(blockedActions.map((action) => action.status)).toEqual(["executed", "blocked"]);
      expect(invokeTool).toHaveBeenCalledTimes(2);
      expect(resolveToolPolicyContext).toHaveBeenCalledWith(
        expect.objectContaining({
          operatorId: "operator-1",
          authActorId: "operator-1",
          authActorSource: "token",
          permissionProfileId: "profile-1",
          localOperatorOverrideId: "override-1",
        }),
      );
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
      const queuedParent = state.durableRuns.get(parentRunId)!;
      state.durableRuns.set(parentRunId, {
        ...queuedParent,
        status: "running",
        version: queuedParent.version + 1,
        leaseOwnerId: `test-resume-claim:${parentRunId}`,
        leaseHeartbeatAt: new Date().toISOString(),
        leaseExpiresAt: "2099-12-31T23:59:59.999Z",
      });
      await service.executeDurableProactiveTickRun(state.durableRuns.get(parentRunId)!);

      const completedRun = readRun(state, started.runId);
      const completedActions = actionsForRun(state, started.runId);
      const parentTimeline = durableRunService.listDurableRunTimeline(parentRunId);
      const childTimeline = durableRunService.listDurableRunTimeline(approvalWaitRun.runId);

      expect(completedRun.status).toBe("executed");
      expect(completedRun.stopReason).toBe("completed");
      expect(completedRun.resumeMetadata).toMatchObject({
        operatorId: "operator-1",
        authActorId: "operator-1",
        authActorSource: "token",
        permissionProfileId: "profile-1",
        localOperatorOverrideId: "override-1",
        resumedFromApproval: true,
        approvalId,
      });
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

  it("recovers an already-resolved approval when the durable wait linkage was never committed", async () => {
    const harness = createHarness();
    const { service, state, invokeTool } = harness;
    const planSpy = vi.spyOn(
      service as unknown as { planProactiveActions: (sessionId: string) => Promise<unknown> },
      "planProactiveActions",
    );
    planSpy.mockResolvedValue({
      confidence: 0.9,
      reasoningSummary: "One approval-gated action is required.",
      actions: [{ kind: "tool", toolName: "http.get", args: { url: "https://example.com/private" } }],
    });

    let approvalId = "";
    invokeTool.mockImplementationOnce(async () => {
      const approval = harness.storage.approvals.create({
        kind: "tool.invoke",
        riskLevel: "caution",
        payload: { toolName: "http.get" },
        preview: { title: "Approve private fetch" },
        linkage: { sessionId: state.session.sessionId, originSurface: "chat" },
      });
      approvalId = approval.approvalId;
      harness.storage.pendingApprovalActions.upsertPending({
        approvalId,
        actionType: "tool.invoke",
        request: { toolName: "http.get", args: { url: "https://example.com/private" } },
      });
      return {
        outcome: "approval_required",
        approvalId,
        policyReason: "Approval required by policy.",
        auditEventId: "audit-approval",
      } satisfies ToolInvokeResult;
    });

    const started = await service.triggerChatSessionProactive(state.session.sessionId, { source: "manual" });
    const durableRunId = started.linkedDurableRunId!;
    const waitSpy = vi
      .spyOn(service as unknown as { markDurableRunWaiting: (...args: unknown[]) => unknown }, "markDurableRunWaiting")
      .mockImplementationOnce(() => {
        throw new Error("simulated crash before wait commit");
      });

    await expect(service.executeDurableProactiveTickRun(state.durableRuns.get(durableRunId)!)).rejects.toThrow(
      "simulated crash before wait commit",
    );
    expect(actionsForRun(state, started.runId)).toEqual([expect.objectContaining({ status: "blocked", approvalId })]);
    expect(state.durableRuns.get(durableRunId)?.status).toBe("running");

    harness.storage.pendingApprovalActions.markResolved(approvalId, "executed", {
      outcome: "executed",
      result: { ok: true, recovered: true },
    });
    harness.storage.approvals.resolve(approvalId, { decision: "approve", resolvedBy: "operator-1" });
    waitSpy.mockRestore();

    await service.executeDurableProactiveTickRun(state.durableRuns.get(durableRunId)!);

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(readRun(state, started.runId)).toMatchObject({ status: "executed", stopReason: "completed" });
    expect(actionsForRun(state, started.runId)).toEqual([
      expect.objectContaining({
        status: "executed",
        approvalId,
        result: expect.objectContaining({ approvedResult: { ok: true, recovered: true } }),
      }),
    ]);
    expect(state.durableRuns.get(durableRunId)?.status).toBe("completed");
  });

  it.each([
    {
      caseName: "HTTP 5xx",
      domainResult: { status: 503, error: "provider returned 503 after dispatch" },
      expectedError: "provider returned 503 after dispatch",
    },
    {
      caseName: "ok false",
      domainResult: { ok: false, error: "provider rejected the approved mutation" },
      expectedError: "provider rejected the approved mutation",
    },
    {
      caseName: "manual reconciliation",
      domainResult: {
        externalOutcome: "unknown_after_send",
        manualReconciliationRequired: true,
        fallbackReason: "manual reconciliation required after dispatch",
      },
      expectedError: "manual reconciliation required after dispatch",
    },
  ])(
    "does not report a resumed approval action as executed when its stored domain result failed ($caseName)",
    async ({ domainResult, expectedError }) => {
      const harness = createHarness();
      const { service, state, invokeTool } = harness;
      const planSpy = vi.spyOn(
        service as unknown as { planProactiveActions: (sessionId: string) => Promise<unknown> },
        "planProactiveActions",
      );
      planSpy.mockResolvedValue({
        confidence: 0.9,
        reasoningSummary: "One approval-gated action is required.",
        actions: [{ kind: "tool", toolName: "http.post", args: { url: "https://example.com/mutate" } }],
      });

      let approvalId = "";
      invokeTool.mockImplementationOnce(async () => {
        const approval = harness.storage.approvals.create({
          kind: "tool.invoke",
          riskLevel: "danger",
          payload: { toolName: "http.post" },
          preview: { title: "Approve external mutation" },
          linkage: { sessionId: state.session.sessionId, originSurface: "chat" },
        });
        approvalId = approval.approvalId;
        harness.storage.pendingApprovalActions.upsertPending({
          approvalId,
          actionType: "tool.invoke",
          request: { toolName: "http.post", args: { url: "https://example.com/mutate" } },
        });
        return {
          outcome: "approval_required",
          approvalId,
          policyReason: "Approval required by policy.",
          auditEventId: "audit-approval-domain-failure",
        } satisfies ToolInvokeResult;
      });

      const started = await service.triggerChatSessionProactive(state.session.sessionId, { source: "manual" });
      const durableRunId = started.linkedDurableRunId!;
      await service.executeDurableProactiveTickRun(state.durableRuns.get(durableRunId)!);

      harness.storage.pendingApprovalActions.markResolved(approvalId, "executed", {
        outcome: "executed",
        policyReason: "execution outcome unknown",
        result: domainResult,
      });
      harness.storage.approvals.resolve(approvalId, { decision: "approve", resolvedBy: "operator-1" });
      const waiting = state.durableRuns.get(durableRunId)!;
      state.durableRuns.set(durableRunId, {
        ...waiting,
        status: "running",
        version: waiting.version + 1,
        leaseOwnerId: `test-resume-claim:${durableRunId}`,
        leaseHeartbeatAt: new Date().toISOString(),
        leaseExpiresAt: "2099-12-31T23:59:59.999Z",
      });

      await service.executeDurableProactiveTickRun(state.durableRuns.get(durableRunId)!);

      expect(invokeTool).toHaveBeenCalledTimes(1);
      expect(readRun(state, started.runId)).toMatchObject({
        status: "failed",
        stopReason: "terminal_failure",
        error: expectedError,
      });
      expect(actionsForRun(state, started.runId)).toEqual([
        expect.objectContaining({
          status: "failed",
          approvalId,
          error: expectedError,
        }),
      ]);
    },
  );

  it("fails before invoking a proactive tool when the durable boundary marker cannot be recorded", async () => {
    const harness = createHarness();
    const { service, state, invokeTool } = harness;
    const markerSpy = vi
      .spyOn(harness.storage.externalSideEffectRuns, "markExternalCallStarted")
      .mockImplementationOnce(() => {
        throw new Error("side-effect ledger unavailable");
      });
    invokeTool.mockResolvedValue({
      outcome: "executed",
      policyReason: "allowlisted",
      auditEventId: "audit-1",
      result: { ok: true },
    } satisfies ToolInvokeResult);
    harness.callbacks.invokeTool = async (request, options) => {
      options?.externalSideEffect?.markStarted();
      return invokeTool(request);
    };

    const started = await service.triggerChatSessionProactive(state.session.sessionId, { source: "manual" });
    const durableRunId = started.linkedDurableRunId!;
    await expect(service.executeDurableProactiveTickRun(state.durableRuns.get(durableRunId)!)).rejects.toThrow(
      "side-effect ledger unavailable",
    );

    expect(invokeTool).not.toHaveBeenCalled();
    expect(actionsForRun(state, started.runId)).toEqual([expect.objectContaining({ status: "suggested" })]);

    markerSpy.mockRestore();
    await service.executeDurableProactiveTickRun(state.durableRuns.get(durableRunId)!);
    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(readRun(state, started.runId).status).toBe("executed");
  });

  it("checks the database-clock lease immediately before proactive tool execution", async () => {
    const harness = createHarness();
    const started = await harness.service.triggerChatSessionProactive(harness.state.session.sessionId, {
      source: "manual",
    });
    const durableRunId = started.linkedDurableRunId!;
    const durableRun = harness.state.durableRuns.get(durableRunId)!;
    harness.state.durableRuns.set(durableRunId, {
      ...durableRun,
      status: "running",
      leaseOwnerId: "worker-tool-fence",
      leaseHeartbeatAt: "2026-07-11T10:00:00.000Z",
      leaseExpiresAt: "2099-12-31T23:59:59.999Z",
    });
    const action: ProactiveActionRecord = {
      actionId: "action-tool-lease-fence",
      runId: started.runId,
      sessionId: harness.state.session.sessionId,
      kind: "tool",
      status: "suggested",
      triggerSource: "manual",
      originSurface: "chat",
      toolName: "browser.search",
      args: { query: "latest state" },
      createdAt: "2026-07-11T10:00:00.000Z",
    };
    (
      harness.service as unknown as {
        insertProactiveAction(current: ProactiveActionRecord): void;
      }
    ).insertProactiveAction(action);
    const lockFreshActiveLeaseForUpdate = vi.spyOn(harness.storage.durableRuns, "lockFreshActiveLeaseForUpdate");
    harness.callbacks.invokeTool = vi.fn(async (_request, options) => {
      options?.executionFence?.();
      options?.externalSideEffect?.markNotRequired();
      return {
        outcome: "executed",
        policyReason: "allowed",
        auditEventId: "audit-tool-lease-fence",
        result: { ok: true },
      } satisfies ToolInvokeResult;
    });

    await (
      harness.service as unknown as {
        executeProactiveToolAction(
          current: ProactiveActionRecord,
          durableRunId: string,
          signal: AbortSignal | undefined,
          expectedLeaseOwnerId: string,
        ): Promise<ProactiveActionRecord>;
      }
    ).executeProactiveToolAction(action, durableRunId, undefined, "worker-tool-fence");

    expect(lockFreshActiveLeaseForUpdate).toHaveBeenCalledWith(durableRunId, "worker-tool-fence");
  });

  it("keeps proactive preflight failures retryable before the external-call boundary", async () => {
    const harness = createHarness();
    const preflightInvoke = vi.fn(async () => {
      throw new Error("tool preflight unavailable");
    });
    harness.callbacks.invokeTool = preflightInvoke;
    const started = await harness.service.triggerChatSessionProactive(harness.state.session.sessionId, {
      source: "manual",
    });
    const action: ProactiveActionRecord = {
      actionId: "action-preflight-failure",
      runId: started.runId,
      sessionId: harness.state.session.sessionId,
      kind: "tool",
      status: "suggested",
      triggerSource: "manual",
      originSurface: "chat",
      toolName: "browser.search",
      args: { query: "latest state" },
      createdAt: "2026-07-11T10:00:00.000Z",
    };
    (
      harness.service as unknown as {
        insertProactiveAction(current: ProactiveActionRecord): void;
      }
    ).insertProactiveAction(action);
    const markExternalCallStarted = vi.spyOn(harness.storage.externalSideEffectRuns, "markExternalCallStarted");
    const markSideEffectFailure = vi.spyOn(harness.storage.externalSideEffectRuns, "markFailureIfStatus");
    const reopenMutation = vi.spyOn(harness.storage.mutationIdempotency, "markFailed");

    await expect(
      (
        harness.service as unknown as {
          executeProactiveToolAction(
            current: ProactiveActionRecord,
            durableRunId: string,
          ): Promise<ProactiveActionRecord>;
        }
      ).executeProactiveToolAction(action, started.linkedDurableRunId!),
    ).rejects.toThrow("tool preflight unavailable");

    expect(markExternalCallStarted).not.toHaveBeenCalled();
    expect(markSideEffectFailure).toHaveBeenCalledWith(
      expect.any(String),
      "claimed_not_sent",
      expect.objectContaining({ status: "failed_before_boundary", errorText: "tool preflight unavailable" }),
      expect.any(String),
    );
    expect(reopenMutation).toHaveBeenCalledOnce();
    expect(actionsForRun(harness.state, started.runId)).toEqual([
      expect.objectContaining({ actionId: action.actionId, status: "suggested" }),
    ]);
  });

  it("rejects an executed tool envelope whose concrete domain result failed before dispatch", async () => {
    const harness = createHarness();
    const invokeTool = vi.fn(
      async (_request: ToolInvokeRequest, options?: Parameters<ChatProactiveServiceCallbacks["invokeTool"]>[1]) => {
        options?.externalSideEffect?.markNotRequired();
        return {
          outcome: "executed",
          policyReason: "allowed",
          auditEventId: "audit-domain-failure",
          result: {
            status: "failed",
            deliveryStatus: "blocked",
            error: "blocked: Integration connection is disabled or disconnected.",
          },
        } satisfies ToolInvokeResult;
      },
    );
    harness.callbacks.invokeTool = invokeTool;
    const started = await harness.service.triggerChatSessionProactive(harness.state.session.sessionId, {
      source: "manual",
    });
    const action: ProactiveActionRecord = {
      actionId: "action-domain-failure",
      runId: started.runId,
      sessionId: harness.state.session.sessionId,
      kind: "tool",
      status: "suggested",
      triggerSource: "manual",
      originSurface: "chat",
      toolName: "channel.send",
      args: { connectionId: "disconnected", message: "hello" },
      createdAt: "2026-07-11T10:00:00.000Z",
    };
    (
      harness.service as unknown as {
        insertProactiveAction(current: ProactiveActionRecord): void;
      }
    ).insertProactiveAction(action);
    const markExternalCallStarted = vi.spyOn(harness.storage.externalSideEffectRuns, "markExternalCallStarted");
    const markSideEffectFailure = vi.spyOn(harness.storage.externalSideEffectRuns, "markFailureIfStatus");
    const reopenMutation = vi.spyOn(harness.storage.mutationIdempotency, "markFailed");

    await expect(
      (
        harness.service as unknown as {
          executeProactiveToolAction(
            current: ProactiveActionRecord,
            durableRunId: string,
          ): Promise<ProactiveActionRecord>;
        }
      ).executeProactiveToolAction(action, started.linkedDurableRunId!),
    ).rejects.toThrow("Integration connection is disabled or disconnected");

    expect(markExternalCallStarted).not.toHaveBeenCalled();
    expect(markSideEffectFailure).toHaveBeenCalledWith(
      expect.any(String),
      "claimed_not_sent",
      expect.objectContaining({
        status: "failed_before_boundary",
        errorText: "blocked: Integration connection is disabled or disconnected.",
      }),
      expect.any(String),
    );
    expect(reopenMutation).toHaveBeenCalledOnce();
    expect(actionsForRun(harness.state, started.runId)).toEqual([
      expect.objectContaining({ actionId: action.actionId, status: "suggested" }),
    ]);
  });

  it("keeps proactive provider-call failures unknown and non-replayable after the boundary", async () => {
    const harness = createHarness();
    const providerInvoke = vi.fn(
      async (
        _request: ToolInvokeRequest,
        options?: Parameters<ChatProactiveServiceCallbacks["invokeTool"]>[1],
      ): Promise<ToolInvokeResult> => {
        options?.externalSideEffect?.markStarted();
        return {
          outcome: "executed",
          policyReason: "execution outcome unknown: provider call failed after dispatch",
          auditEventId: "audit-provider-failure",
          result: {
            status: "failed",
            deliveryStatus: "manual_reconciliation_required",
            manualReconciliationRequired: true,
            error: "execution error: provider call failed after dispatch",
          },
        };
      },
    );
    harness.callbacks.invokeTool = providerInvoke;
    const started = await harness.service.triggerChatSessionProactive(harness.state.session.sessionId, {
      source: "manual",
    });
    const action: ProactiveActionRecord = {
      actionId: "action-provider-failure",
      runId: started.runId,
      sessionId: harness.state.session.sessionId,
      kind: "tool",
      status: "suggested",
      triggerSource: "manual",
      originSurface: "chat",
      toolName: "browser.search",
      args: { query: "latest state" },
      createdAt: "2026-07-11T10:00:00.000Z",
    };
    (
      harness.service as unknown as {
        insertProactiveAction(current: ProactiveActionRecord): void;
      }
    ).insertProactiveAction(action);
    const markSideEffectFailure = vi.spyOn(harness.storage.externalSideEffectRuns, "markFailureIfStatus");
    const reopenMutation = vi.spyOn(harness.storage.mutationIdempotency, "markFailed");
    const execute = () =>
      (
        harness.service as unknown as {
          executeProactiveToolAction(
            current: ProactiveActionRecord,
            durableRunId: string,
          ): Promise<ProactiveActionRecord>;
        }
      ).executeProactiveToolAction(action, started.linkedDurableRunId!);

    await expect(execute()).resolves.toMatchObject({
      actionId: action.actionId,
      status: "failed",
      error: "execution error: provider call failed after dispatch",
    });
    expect(providerInvoke).toHaveBeenCalledWith(
      expect.objectContaining({ toolName: "browser.search" }),
      expect.objectContaining({
        externalSideEffect: expect.objectContaining({
          markStarted: expect.any(Function),
          markNotRequired: expect.any(Function),
        }),
      }),
    );
    expect(markSideEffectFailure).toHaveBeenCalledWith(
      expect.any(String),
      "external_call_started",
      expect.objectContaining({
        status: "unknown_external_outcome",
        errorText: "execution error: provider call failed after dispatch",
      }),
      expect.any(String),
    );
    expect(reopenMutation).not.toHaveBeenCalled();

    await expect(execute()).resolves.toMatchObject({ actionId: action.actionId, status: "failed" });
    expect(providerInvoke).toHaveBeenCalledTimes(1);
  });

  it("does not invoke the same proactive action twice when executions overlap", async () => {
    const harness = createHarness();
    const { service, state, invokeTool } = harness;
    let releaseTool: ((result: ToolInvokeResult) => void) | undefined;
    let toolStartedResolve: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      toolStartedResolve = resolve;
    });
    invokeTool.mockImplementation(
      async () =>
        await new Promise<ToolInvokeResult>((resolve) => {
          releaseTool = resolve;
          toolStartedResolve?.();
        }),
    );

    const started = await service.triggerChatSessionProactive(state.session.sessionId, { source: "manual" });
    const durableRunId = started.linkedDurableRunId!;
    const first = service.executeDurableProactiveTickRun(state.durableRuns.get(durableRunId)!);
    await toolStarted;
    const second = service.executeDurableProactiveTickRun(state.durableRuns.get(durableRunId)!);

    await expect(second).rejects.toThrow("manual reconciliation is required");
    expect(invokeTool).toHaveBeenCalledTimes(1);
    releaseTool?.({
      outcome: "executed",
      policyReason: "allowlisted",
      auditEventId: "audit-1",
      result: { ok: true },
    });
    await first;

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(readRun(state, started.runId).status).toBe("executed");
  });

  it("preserves proactive completion and cooldown truth when realtime projection fails", async () => {
    const harness = createHarness();
    const { service, state, invokeTool, publishRealtime } = harness;
    invokeTool.mockResolvedValue({
      outcome: "executed",
      policyReason: "allowlisted",
      auditEventId: "audit-1",
      result: { ok: true },
    } satisfies ToolInvokeResult);
    publishRealtime.mockImplementation(() => {
      throw new Error("realtime unavailable");
    });

    const started = await service.triggerChatSessionProactive(state.session.sessionId, { source: "manual" });
    const durableRunId = started.linkedDurableRunId!;
    await service.executeDurableProactiveTickRun(state.durableRuns.get(durableRunId)!);

    expect(invokeTool).toHaveBeenCalledTimes(1);
    expect(readRun(state, started.runId).status).toBe("executed");
    expect(state.durableRuns.get(durableRunId)?.status).toBe("completed");
    expect(state.prefs.get(state.session.sessionId)).toMatchObject({ lastProactiveRunId: started.runId });
  });

  it("aborts proactive durable execution without marking the pending action failed", async () => {
    const harness = createHarness();
    const { service, state, invokeTool } = harness;
    const controller = new AbortController();
    let toolStartedResolve: (() => void) | undefined;
    const toolStarted = new Promise<void>((resolve) => {
      toolStartedResolve = resolve;
    });

    invokeTool.mockImplementation(
      async (request) =>
        await new Promise((_, reject) => {
          expect(request.signal).toBe(controller.signal);
          toolStartedResolve?.();
          request.signal?.addEventListener("abort", () => reject(request.signal?.reason), { once: true });
        }),
    );
    harness.callbacks.invokeTool = async (request, options) => {
      options?.externalSideEffect?.markStarted();
      return invokeTool(request);
    };

    const started = await service.triggerChatSessionProactive(state.session.sessionId, { source: "manual" });
    const durableRunId = started.linkedDurableRunId!;
    const runPromise = service.executeDurableProactiveTickRun(state.durableRuns.get(durableRunId)!, {
      signal: controller.signal,
    });
    await toolStarted;
    controller.abort(new Error("lease lost"));

    await expect(runPromise).rejects.toThrow("lease lost");

    const actions = actionsForRun(state, started.runId);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.status).toBe("suggested");

    await expect(service.executeDurableProactiveTickRun(state.durableRuns.get(durableRunId)!)).rejects.toThrow(
      "manual reconciliation is required",
    );
    expect(invokeTool).toHaveBeenCalledTimes(1);
  });

  it("propagates string abort reasons before starting durable proactive work", async () => {
    const harness = createHarness();
    const { service, state, invokeTool } = harness;
    const started = await service.triggerChatSessionProactive(state.session.sessionId, { source: "manual" });
    const durableRunId = started.linkedDurableRunId!;
    const controller = new AbortController();
    controller.abort("lease released");

    await expect(
      service.executeDurableProactiveTickRun(state.durableRuns.get(durableRunId)!, {
        signal: controller.signal,
      }),
    ).rejects.toThrow("lease released");

    expect(invokeTool).not.toHaveBeenCalled();
    expect(actionsForRun(state, started.runId)).toEqual([]);
  });

  it("marks thrown proactive tool failures as terminal run failures", async () => {
    const harness = createHarness();
    const { service, state, invokeTool, publishRealtime } = harness;
    const planSpy = vi.spyOn(
      service as unknown as { planProactiveActions: (sessionId: string) => Promise<unknown> },
      "planProactiveActions",
    );
    planSpy.mockResolvedValue({
      confidence: 0.81,
      reasoningSummary: "Need to inspect current time before continuing.",
      actions: [{ kind: "tool", toolName: "time.now", args: { timezone: "UTC" } }],
    });
    invokeTool.mockRejectedValueOnce(new Error("tool runtime unavailable"));
    harness.callbacks.invokeTool = async (request, options) => {
      options?.externalSideEffect?.markStarted();
      return invokeTool(request);
    };

    const started = await service.triggerChatSessionProactive(state.session.sessionId, { source: "manual" });
    const durableRunId = started.linkedDurableRunId!;
    await service.executeDurableProactiveTickRun(state.durableRuns.get(durableRunId)!);

    const failedRun = readRun(state, started.runId);
    const actions = actionsForRun(state, started.runId);

    expect(failedRun.status).toBe("failed");
    expect(failedRun.stopReason).toBe("terminal_failure");
    expect(failedRun.error).toBe("tool runtime unavailable");
    expect(actions).toEqual([
      expect.objectContaining({
        status: "failed",
        linkedDurableRunId: durableRunId,
        error: "tool runtime unavailable",
      }),
    ]);
    expect(state.durableRuns.get(durableRunId)?.status).toBe("completed");
    expect(publishRealtime).toHaveBeenCalledWith(
      "task_updated",
      "tasks",
      expect.objectContaining({
        task: expect.objectContaining({
          status: "blocked",
          proactiveContext: expect.objectContaining({
            proactiveRunId: started.runId,
            durableRunId,
            stopReason: "terminal_failure",
          }),
        }),
      }),
      expect.objectContaining({
        eventClass: "domain_fact",
        eventAuthority: "retained_stream",
      }),
    );
  });

  it("fails closed to the scheduled-restricted profile when resolveToolPolicyContext is not wired", async () => {
    // Safety invariant: a background/autonomous proactive turn must always invoke
    // tools under a restricted permission profile. When the host does not wire the
    // optional resolveToolPolicyContext callback, the proactive path must NOT fall
    // back to an undefined permissionProfileId (which the gateway would resolve to
    // whatever interactive profile is active for the session — potentially a bypass
    // profile). It must pin the scheduled-restricted profile.
    const harness = createHarness();
    const { service, state, invokeTool } = harness;
    expect(harness.callbacks.resolveToolPolicyContext).toBeUndefined();
    const planSpy = vi.spyOn(
      service as unknown as { planProactiveActions: (sessionId: string) => Promise<unknown> },
      "planProactiveActions",
    );
    planSpy.mockResolvedValue({
      confidence: 0.8,
      reasoningSummary: "Inspect current time on a background tick.",
      actions: [{ kind: "tool", toolName: "time.now", args: { timezone: "UTC" } }],
    });
    invokeTool.mockResolvedValue({
      outcome: "executed",
      policyReason: "allowlisted",
      auditEventId: "audit-restricted",
      result: { ok: true },
    } satisfies ToolInvokeResult);

    // Non-manual source => background autonomous trigger => actor carries the
    // scheduled-restricted profile in its resume metadata.
    const started = await service.triggerChatSessionProactive(state.session.sessionId, { source: "scheduler" });
    await service.executeDurableProactiveTickRun(state.durableRuns.get(started.linkedDurableRunId!)!);

    expect(invokeTool).toHaveBeenCalledTimes(1);
    const invokeArgs = invokeTool.mock.calls[0]![0] as {
      permissionProfileId?: string;
      policyContext?: { permissionProfileId?: string };
    };
    expect(invokeArgs.permissionProfileId).toBe(SCHEDULED_TURN_PERMISSION_PROFILE_ID);
    expect(invokeArgs.policyContext).toBeDefined();
    expect(invokeArgs.policyContext?.permissionProfileId).toBe(SCHEDULED_TURN_PERMISSION_PROFILE_ID);

    const actions = actionsForRun(state, started.runId);
    expect(actions.map((action) => action.status)).toEqual(["executed"]);
  });

  it("uses the resolved policy context unchanged when resolveToolPolicyContext IS wired", async () => {
    // The wired path must be untouched by the fail-closed fallback: whatever the
    // host's resolveToolPolicyContext returns is what invokeTool receives.
    const resolveToolPolicyContext = vi.fn(
      (input: Parameters<NonNullable<ChatProactiveServiceCallbacks["resolveToolPolicyContext"]>>[0]) => ({
        ...input,
        permissionProfileId: input.permissionProfileId ?? "wired-profile",
        localOperatorOverrideId: "wired-override",
      }),
    );
    const harness = createHarness({ callbacks: { resolveToolPolicyContext } });
    const { service, state, invokeTool } = harness;
    const planSpy = vi.spyOn(
      service as unknown as { planProactiveActions: (sessionId: string) => Promise<unknown> },
      "planProactiveActions",
    );
    planSpy.mockResolvedValue({
      confidence: 0.8,
      reasoningSummary: "Inspect current time on a manual tick.",
      actions: [{ kind: "tool", toolName: "time.now", args: { timezone: "UTC" } }],
    });
    invokeTool.mockResolvedValue({
      outcome: "executed",
      policyReason: "allowlisted",
      auditEventId: "audit-wired",
      result: { ok: true },
    } satisfies ToolInvokeResult);

    const started = await service.triggerChatSessionProactive(state.session.sessionId, {
      source: "manual",
      operatorId: "operator-1",
      permissionProfileId: "explicit-profile",
    });
    await service.executeDurableProactiveTickRun(state.durableRuns.get(started.linkedDurableRunId!)!);

    expect(resolveToolPolicyContext).toHaveBeenCalledTimes(1);
    expect(invokeTool).toHaveBeenCalledTimes(1);
    const invokeArgs = invokeTool.mock.calls[0]![0] as {
      permissionProfileId?: string;
      localOperatorOverrideId?: string;
      policyContext?: { permissionProfileId?: string; localOperatorOverrideId?: string };
    };
    // Callback echoes back the explicit profile id; the fallback must not override it.
    expect(invokeArgs.permissionProfileId).toBe("explicit-profile");
    expect(invokeArgs.localOperatorOverrideId).toBe("wired-override");
    expect(invokeArgs.policyContext?.permissionProfileId).toBe("explicit-profile");
    expect(invokeArgs.policyContext?.localOperatorOverrideId).toBe("wired-override");
  });

  it("completes suggest-mode durable ticks with suggested actions but no linked task", async () => {
    const harness = createHarness();
    const { service, state, publishRealtime } = harness;
    state.prefs.set(state.session.sessionId, {
      ...state.prefs.get(state.session.sessionId)!,
      proactiveMode: "suggest",
    });
    vi.spyOn(
      service as unknown as { planProactiveActions: (sessionId: string) => Promise<unknown> },
      "planProactiveActions",
    ).mockResolvedValue({
      confidence: 0.74,
      reasoningSummary: "Suggest a follow-up without executing it.",
      actions: [{ kind: "note", note: "Consider asking Cowork for a plan." }],
    });

    const started = await service.triggerChatSessionProactive(state.session.sessionId, { source: "manual" });
    expect(started.executionClass).toBe("prompted_notification");
    await service.executeDurableProactiveTickRun(state.durableRuns.get(started.linkedDurableRunId!)!);

    const completed = readRun(state, started.runId);
    const actions = actionsForRun(state, started.runId);
    const status = service.getChatSessionProactiveStatus(state.session.sessionId);
    expect(completed).toMatchObject({
      status: "suggested",
      linkedTaskId: undefined,
      stopReason: "no_action",
      reasoningSummary: "Suggest a follow-up without executing it.",
    });
    expect(actions).toEqual([
      expect.objectContaining({
        kind: "note",
        status: "suggested",
        result: { note: "Consider asking Cowork for a plan." },
      }),
    ]);
    expect(status.lastRun).toMatchObject({
      executionClass: "prompted_notification",
      suggestedActions: [expect.objectContaining({ executionClass: "prompted_notification" })],
    });
    expect(publishRealtime).toHaveBeenCalledWith(
      "proactive_suggestion_created",
      "chat",
      expect.objectContaining({ actionCount: 1 }),
      expect.objectContaining({ eventAuthority: "retained_stream" }),
    );
  });

  it("skips durable ticks during cooldown and records the next wake", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-04T19:00:00.000Z"));
    try {
      const harness = createHarness();
      const { service, state, invokeTool } = harness;
      state.prefs.set(state.session.sessionId, {
        ...state.prefs.get(state.session.sessionId)!,
        cooldownSeconds: 120,
        lastProactiveAt: "2026-04-04T18:59:30.000Z",
      });
      const planSpy = vi.spyOn(
        service as unknown as { planProactiveActions: (sessionId: string) => Promise<unknown> },
        "planProactiveActions",
      );

      const started = await service.triggerChatSessionProactive(state.session.sessionId, { source: "manual" });
      await service.executeDurableProactiveTickRun(state.durableRuns.get(started.linkedDurableRunId!)!);

      const completed = readRun(state, started.runId);
      expect(completed).toMatchObject({
        status: "no_action",
        stopReason: "cooldown",
        nextWakeAt: "2026-04-04T19:01:30.000Z",
      });
      expect(completed.reasoningSummary).toContain("90s remaining");
      expect(planSpy).not.toHaveBeenCalled();
      expect(invokeTool).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks non-allowlisted auto_safe actions as policy conflicts", async () => {
    const harness = createHarness();
    const { service, state, invokeTool, publishRealtime } = harness;
    state.prefs.set(state.session.sessionId, {
      ...state.prefs.get(state.session.sessionId)!,
      proactiveMode: "auto_safe",
    });
    vi.spyOn(
      service as unknown as { planProactiveActions: (sessionId: string) => Promise<unknown> },
      "planProactiveActions",
    ).mockResolvedValue({
      confidence: 0.9,
      reasoningSummary: "Need a shell command, but safe mode should block it.",
      actions: [{ kind: "tool", toolName: "shell.exec", args: { command: "pnpm test" } }],
    });

    const started = await service.triggerChatSessionProactive(state.session.sessionId, { source: "manual" });
    expect(started.executionClass).toBe("autonomous_durable");
    await service.executeDurableProactiveTickRun(state.durableRuns.get(started.linkedDurableRunId!)!);

    const completed = readRun(state, started.runId);
    const actions = actionsForRun(state, started.runId);
    expect(completed).toMatchObject({
      status: "blocked",
      stopReason: "policy_conflict",
    });
    expect(actions).toEqual([
      expect.objectContaining({
        status: "blocked",
        error: "Tool shell.exec is not allowlisted for auto_safe mode.",
      }),
    ]);
    expect(invokeTool).not.toHaveBeenCalled();
    expect(publishRealtime).toHaveBeenCalledWith(
      "proactive_action_blocked",
      "chat",
      expect.objectContaining({
        actionId: actions[0]?.actionId,
        reason: "Tool shell.exec is not allowlisted for auto_safe mode.",
      }),
      expect.objectContaining({ eventClass: "operational_signal" }),
    );
  });

  it("reports proactive status and publishes policy updates from autonomy prefs", () => {
    const harness = createHarness();
    const { service, state, publishRealtime } = harness;
    state.proactiveRuns.set(
      "run-latest",
      createProactiveRunRow({
        runId: "run-latest",
        linkedDurableRunId: "durable-latest",
        approvalId: "approval-latest",
        startedAt: "2026-04-04T21:00:00.000Z",
      }),
    );
    state.proactiveActions.set("action-suggested", {
      action_id: "action-suggested",
      run_id: "run-latest",
      session_id: state.session.sessionId,
      linked_task_id: null,
      linked_durable_run_id: null,
      approval_id: null,
      kind: "note",
      status: "suggested",
      trigger_source: "manual",
      origin_surface: "chat",
      tool_name: null,
      args_json: null,
      result_json: null,
      error: null,
      external_reference_roots_json: null,
      created_at: "2026-04-04T21:00:00.000Z",
      updated_at: null,
    });
    state.proactiveActions.set("action-executed", {
      ...state.proactiveActions.get("action-suggested")!,
      action_id: "action-executed",
      status: "executed",
      created_at: new Date().toISOString(),
    });

    const status = service.getChatSessionProactiveStatus(state.session.sessionId);
    expect(status).toEqual(
      expect.objectContaining({
        policy: expect.objectContaining({
          sessionId: state.session.sessionId,
          mode: "auto_full",
          autonomyBudget: {
            maxActionsPerHour: 10,
            maxActionsPerTurn: 5,
            cooldownSeconds: 0,
          },
          retrievalMode: "standard",
          reflectionMode: "off",
        }),
        idleSeconds: 600,
        hasRunningTurn: false,
        pendingSuggestions: 1,
        actionsLastHour: 1,
        lastRun: expect.objectContaining({ runId: "run-latest" }),
      }),
    );

    const updated = service.updateChatSessionProactivePolicy(state.session.sessionId, {
      proactiveMode: "suggest",
      autonomyBudget: {
        maxActionsPerHour: 3,
        maxActionsPerTurn: 2,
        cooldownSeconds: 30,
      },
      retrievalMode: "layered",
      reflectionMode: "on",
    });

    expect(updated).toEqual(
      expect.objectContaining({
        mode: "suggest",
        autonomyBudget: {
          maxActionsPerHour: 3,
          maxActionsPerTurn: 2,
          cooldownSeconds: 30,
        },
        retrievalMode: "layered",
        reflectionMode: "on",
      }),
    );
    expect(state.prefs.get(state.session.sessionId)).toMatchObject({
      proactiveMode: "suggest",
      maxActionsPerHour: 3,
      maxActionsPerTurn: 2,
      cooldownSeconds: 30,
      retrievalMode: "layered",
      reflectionMode: "on",
    });
    expect(publishRealtime).toHaveBeenCalledWith(
      "system",
      "chat",
      expect.objectContaining({
        type: "proactive_policy_updated",
        sessionId: state.session.sessionId,
        policy: updated,
      }),
    );
  });
});

function createHarness(options?: {
  durableKernelV1Enabled?: boolean;
  autonomyV1Disabled?: boolean;
  callbacks?: Partial<ChatProactiveServiceCallbacks>;
}) {
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
    gatewaySql: {
      prepare: (sql: string) => createStatement(sql, state),
      runImmediateTransaction: <T>(callback: () => T): T => callback(),
    },
    publishRealtime,
    requireFeatureEnabled: () => undefined,
    isFeatureEnabled: (flag: keyof RuntimeSettings["features"]) => {
      if (flag === "autonomyV1Disabled") {
        return options?.autonomyV1Disabled === true;
      }
      return flag !== "durableKernelV1Enabled" || options?.durableKernelV1Enabled !== false;
    },
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
    invokeTool: async (request, options) => {
      const result = await invokeTool(request);
      if (result?.outcome === "executed") {
        options?.externalSideEffect?.markStarted();
      }
      return result;
    },
    detectDelegationRoles: () => [],
    createDurableRun: (input) => {
      const created = durableRunService.createDurableRun(input);
      const claimed = {
        ...created,
        status: "running" as const,
        version: created.version + 1,
        leaseOwnerId: `test-claim:${created.runId}`,
        leaseHeartbeatAt: new Date().toISOString(),
        leaseExpiresAt: "2099-12-31T23:59:59.999Z",
      };
      state.durableRuns.set(created.runId, claimed);
      return claimed;
    },
    requestDurableRunProcessing: () => undefined,
    backgroundTasks,
    closing: false,
  };
  Object.assign(callbacks, options?.callbacks);
  return {
    state,
    storage,
    service: new ChatProactiveService(ctx, callbacks),
    durableRunService,
    invokeTool,
    publishRealtime,
    callbacks,
    backgroundTasks,
  };
}

function createStorage(state: HarnessState) {
  const mutationRecords = new Map<
    string,
    {
      method: string;
      routePath: string;
      idempotencyKey: string;
      actorScope: string;
      payloadHash: string;
      status: "pending" | "completed" | "failed";
      createdAt: string;
      updatedAt: string;
    }
  >();
  const sideEffectRecords = new Map<string, ExternalSideEffectRunRecord>();
  const mutationKey = (input: { routePath: string; idempotencyKey: string; actorScope?: string }) =>
    `${input.routePath}:${input.idempotencyKey}:${input.actorScope ?? ""}`;
  return {
    runImmediateTransaction: <T>(callback: () => T): T => callback(),
    mutationIdempotency: {
      claim: (input: {
        method: string;
        routePath: string;
        idempotencyKey: string;
        actorScope?: string;
        payloadHash: string;
        now?: string;
      }) => {
        const key = mutationKey(input);
        const existing = mutationRecords.get(key);
        const now = input.now ?? new Date().toISOString();
        if (!existing) {
          const record = {
            method: input.method,
            routePath: input.routePath,
            idempotencyKey: input.idempotencyKey,
            actorScope: input.actorScope ?? "",
            payloadHash: input.payloadHash,
            status: "pending" as const,
            createdAt: now,
            updatedAt: now,
          };
          mutationRecords.set(key, record);
          return { outcome: "claimed" as const, claimKind: "new" as const, record };
        }
        if (existing.payloadHash !== input.payloadHash) {
          return { outcome: "payload_mismatch" as const, record: existing };
        }
        if (existing.status === "failed") {
          const record = { ...existing, status: "pending" as const, updatedAt: now };
          mutationRecords.set(key, record);
          return { outcome: "claimed" as const, claimKind: "retry_after_failure" as const, record };
        }
        return {
          outcome: existing.status === "completed" ? ("duplicate" as const) : ("in_progress" as const),
          record: existing,
        };
      },
      markCompleted: (input: {
        routePath: string;
        idempotencyKey: string;
        actorScope?: string;
        updatedAt?: string;
      }) => {
        const key = mutationKey(input);
        const current = mutationRecords.get(key)!;
        mutationRecords.set(key, {
          ...current,
          status: "completed",
          updatedAt: input.updatedAt ?? new Date().toISOString(),
        });
      },
      markFailed: (input: { routePath: string; idempotencyKey: string; actorScope?: string; updatedAt?: string }) => {
        const key = mutationKey(input);
        const current = mutationRecords.get(key)!;
        mutationRecords.set(key, {
          ...current,
          status: "failed",
          updatedAt: input.updatedAt ?? new Date().toISOString(),
        });
      },
    },
    externalSideEffectRuns: {
      createOrGet: (
        input: {
          workspaceId?: string;
          boundary: string;
          routePath: string;
          catalogId?: string;
          connectionId?: string;
          actionId?: string;
          actorScope?: string;
          idempotencyKey: string;
          payloadHash: string;
          status?: ExternalSideEffectRunRecord["status"];
          replayOutcome?: ExternalSideEffectRunRecord["replayOutcome"];
          replayAttempt?: ExternalSideEffectRunRecord["replayAttempt"];
          requestPayload?: Record<string, unknown>;
        },
        now = new Date().toISOString(),
      ) => {
        const existing = [...sideEffectRecords.values()].find(
          (candidate) => candidate.boundary === input.boundary && candidate.idempotencyKey === input.idempotencyKey,
        );
        if (existing) return existing;
        const record: ExternalSideEffectRunRecord = {
          runId: randomUUID(),
          workspaceId: input.workspaceId ?? "default",
          boundary: input.boundary,
          routePath: input.routePath,
          catalogId: input.catalogId,
          connectionId: input.connectionId,
          actionId: input.actionId,
          actorScope: input.actorScope ?? "",
          idempotencyKey: input.idempotencyKey,
          payloadHash: input.payloadHash,
          status: input.status ?? "claimed_not_sent",
          replayPolicy: "idempotent_external",
          replayOutcome: input.replayOutcome,
          replayAttempt: input.replayAttempt,
          resumeState: "not_resumable",
          requestPayload: input.requestPayload,
          attemptCount: 0,
          createdAt: now,
          updatedAt: now,
        };
        sideEffectRecords.set(record.runId, record);
        return record;
      },
      markExternalCallStarted: (runId: string, _input?: unknown, now = new Date().toISOString()) => {
        const record = { ...sideEffectRecords.get(runId)!, status: "external_call_started" as const, updatedAt: now };
        sideEffectRecords.set(runId, record);
        return record;
      },
      markCompleted: (runId: string, _input?: unknown, now = new Date().toISOString()) => {
        const record = {
          ...sideEffectRecords.get(runId)!,
          status: "completed" as const,
          resumeState: "completed" as const,
          updatedAt: now,
        };
        sideEffectRecords.set(runId, record);
        return record;
      },
      markFailure: (
        runId: string,
        input: { status: "failed_before_boundary" | "unknown_external_outcome"; errorText: string },
        now = new Date().toISOString(),
      ) => {
        const record = {
          ...sideEffectRecords.get(runId)!,
          status: input.status,
          errorText: input.errorText,
          updatedAt: now,
        };
        sideEffectRecords.set(runId, record);
        return record;
      },
      markFailureIfStatus: (
        runId: string,
        expectedStatus: ExternalSideEffectRunRecord["status"],
        input: { status: "failed_before_boundary" | "unknown_external_outcome"; errorText: string },
        now = new Date().toISOString(),
      ) => {
        const current = sideEffectRecords.get(runId)!;
        if (current.status !== expectedStatus) {
          return current;
        }
        const record = {
          ...current,
          status: input.status,
          errorText: input.errorText,
          updatedAt: now,
        };
        sideEffectRecords.set(runId, record);
        return record;
      },
      get: (runId: string) => sideEffectRecords.get(runId)!,
    },
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
      lockActiveLeaseForUpdate: (runId: string, expectedLeaseOwnerId: string, now: string) => {
        const run = state.durableRuns.get(runId);
        if (
          !run ||
          run.status !== "running" ||
          run.leaseOwnerId !== expectedLeaseOwnerId ||
          !run.leaseExpiresAt ||
          Date.parse(run.leaseExpiresAt) <= Date.parse(now)
        ) {
          return undefined;
        }
        return run;
      },
      lockFreshActiveLeaseForUpdate: (runId: string, expectedLeaseOwnerId: string) => {
        const run = state.durableRuns.get(runId);
        if (
          !run ||
          run.status !== "running" ||
          run.leaseOwnerId !== expectedLeaseOwnerId ||
          !run.leaseExpiresAt ||
          Date.parse(run.leaseExpiresAt) <= Date.now()
        ) {
          return undefined;
        }
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
        clearLease?: boolean;
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
      if (query.includes("FROM proactive_actions") && query.includes("status = 'suggested'"))
        return {
          count: [...state.proactiveActions.values()].filter(
            (row) => row.session_id === args[0] && row.status === "suggested",
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
