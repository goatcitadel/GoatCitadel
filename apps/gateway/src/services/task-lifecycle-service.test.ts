import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { ConflictError, ValidationError } from "@goatcitadel/contracts";
import { TaskLifecycleService } from "./task-lifecycle-service.js";

const storages: Storage[] = [];
const createdDirs: string[] = [];

afterEach(() => {
  for (const storage of storages.splice(0)) {
    storage.close();
  }
  for (const dir of createdDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createService(overrides: Partial<ConstructorParameters<typeof TaskLifecycleService>[0]> = {}) {
  const root = path.join(os.tmpdir(), `goatcitadel-task-lifecycle-${randomUUID()}`);
  createdDirs.push(root);
  fs.mkdirSync(root, { recursive: true });
  const storage = new Storage({
    dbPath: path.join(root, "gateway.db"),
    transcriptsDir: path.join(root, "transcripts"),
    auditDir: path.join(root, "audit"),
  });
  storages.push(storage);
  const publishRealtime = vi.fn().mockResolvedValue(undefined);
  const asyncStorage = createSqliteAsyncStorage(storage);
  const service = new TaskLifecycleService({
    storage: asyncStorage,
    publishRealtime,
    ...overrides,
  });
  return { service, storage, asyncStorage, publishRealtime };
}

describe("TaskLifecycleService agentic runtime", () => {
  it("keeps A2A durable linkage idempotent and refuses a locked conflicting target", async () => {
    const { service, storage, asyncStorage } = createService();
    const task = await service.createTask({
      workspaceId: "default",
      title: "A2A durable link",
      status: "in_progress",
      agenticContext: { runId: "a2a-run-link", surface: "chat", status: "running" },
    });

    const first = await asyncStorage.runImmediateTransaction(() =>
      service.persistA2ADurableRunLink(task.taskId, "durable-a"),
    );
    const replay = await asyncStorage.runImmediateTransaction(() =>
      service.persistA2ADurableRunLink(task.taskId, "durable-a"),
    );
    expect(first.agenticContext?.durableRunId).toBe("durable-a");
    expect(replay.agenticContext?.durableRunId).toBe("durable-a");

    await expect(
      asyncStorage.runImmediateTransaction(() => service.persistA2ADurableRunLink(task.taskId, "durable-b")),
    ).rejects.toThrow(ConflictError);
    expect(storage.tasks.get(task.taskId).agenticContext?.durableRunId).toBe("durable-a");
  });

  it("preserves task lifecycle ownership when an internal workflow supplies a stable task identity", async () => {
    const { service, publishRealtime } = createService();

    const task = await service.createTask(
      { workspaceId: "default", title: "Stable delegation task", createdBy: "chat" },
      { taskId: "delegation-task-stable" },
    );

    expect(task.taskId).toBe("delegation-task-stable");
    expect((await service.getTask(task.taskId)).title).toBe("Stable delegation task");
    expect(publishRealtime).toHaveBeenCalledWith(
      "task_created",
      "tasks",
      expect.objectContaining({ task: expect.objectContaining({ taskId: "delegation-task-stable" }) }),
      expect.any(Object),
    );
    await expect(
      service.createTask({ workspaceId: "default", title: "Conflicting task" }, { taskId: task.taskId }),
    ).rejects.toThrow(/UNIQUE|constraint/i);
  });

  it("does not resolve a task mutation before retained realtime publication settles", async () => {
    let releasePublication!: () => void;
    const publication = new Promise<void>((resolve) => {
      releasePublication = resolve;
    });
    const publishRealtime = vi.fn(() => publication);
    const { service } = createService({ publishRealtime });

    let mutationSettled = false;
    const mutation = service.createTask({ workspaceId: "default", title: "Await retained publication" }).finally(() => {
      mutationSettled = true;
    });

    await vi.waitFor(() => expect(publishRealtime).toHaveBeenCalledTimes(1));
    expect(mutationSettled).toBe(false);

    releasePublication();
    await expect(mutation).resolves.toMatchObject({ title: "Await retained publication" });
    expect(mutationSettled).toBe(true);
  });

  it("publishes a delegation subagent projection only after its caller-owned transaction commits", async () => {
    const { service, publishRealtime } = createService();
    const task = await service.createTask({
      workspaceId: "default",
      title: "Dispatch-fenced delegation",
      status: "in_progress",
      createdBy: "chat",
    });
    await service.registerTaskSubagent(task.taskId, {
      agentSessionId: "child-dispatch-fenced",
      agentName: "researcher",
    });
    publishRealtime.mockClear();

    const persisted = await service.persistDelegationSubagentProjection("child-dispatch-fenced", {
      status: "paused",
      metadata: { runId: "run-dispatch-fenced", heartbeatAt: "2026-07-11T00:00:00.000Z" },
    });

    expect(persisted).toEqual(
      expect.objectContaining({
        taskId: task.taskId,
        agentSessionId: "child-dispatch-fenced",
        status: "paused",
        endedAt: undefined,
      }),
    );
    expect(publishRealtime).not.toHaveBeenCalled();

    await service.publishDelegationSubagentProjection(persisted);

    expect(publishRealtime).toHaveBeenCalledWith(
      "subagent_updated",
      "tasks",
      { taskId: task.taskId, session: persisted },
      expect.any(Object),
    );
  });

  it("projects canonical waiting provenance into the operator run tree", async () => {
    const { service } = createService();
    const task = await service.createTask({
      workspaceId: "default",
      title: "Waiting delegation",
      status: "in_progress",
      createdBy: "chat",
      agenticContext: {
        runId: "run-waiting-provenance",
        surface: "chat",
        status: "running",
      },
    });
    await service.registerTaskSubagent(task.taskId, {
      agentSessionId: "child-waiting-provenance",
      agentName: "researcher",
      metadata: {
        runId: "child-run-waiting-provenance",
        profileId: "researcher",
        waiting: {
          status: "waiting_for_approval",
          reason: "Approve read access to the project workspace.",
          childTurnId: "turn-waiting-provenance",
          durableRunId: "durable-waiting-provenance",
          observedAt: "2026-07-11T00:00:00.000Z",
        },
      },
    });

    const tree = await service.getAgenticRunTree("run-waiting-provenance");
    const node = tree.nodes.find((candidate) => candidate.id === "subagent:child-waiting-provenance");

    expect(node).toEqual(
      expect.objectContaining({
        status: "active",
        summary: "Approve read access to the project workspace.",
        agentSessionId: "child-waiting-provenance",
        metadata: expect.objectContaining({
          role: "researcher",
          childTraceStatus: "waiting_for_approval",
          childSessionId: "child-waiting-provenance",
          childTurnId: "turn-waiting-provenance",
          durableRunId: "durable-waiting-provenance",
          waitObservedAt: "2026-07-11T00:00:00.000Z",
        }),
      }),
    );
  });

  it("lists durable agentic runs, builds run trees, records diagnostics, and applies controls", async () => {
    const { service, storage, publishRealtime } = createService();
    const task = await service.createTask({
      workspaceId: "default",
      title: "Delegation: map launch plan",
      description: "Map the launch plan with child agents.",
      status: "in_progress",
      priority: "normal",
      agenticContext: {
        boardId: "cowork:default",
        runId: "run-1",
        durableRunId: "durable-run-1",
        childRunIds: ["run-1:researcher"],
        parentSessionId: "sess-1",
        surface: "cowork",
        status: "running",
        contextMode: "fork",
        workspaceScope: { kind: "session" },
        maxSpawn: 4,
      },
    });
    await service.registerTaskSubagent(task.taskId, {
      agentSessionId: "child-session-1",
      agentName: "researcher",
      metadata: {
        runId: "run-1:researcher",
        parentRunId: "run-1",
        index: 2,
        depth: 1,
        dependsOnStepIds: ["plan-step"],
        profileId: "researcher",
        contextMode: "isolated",
        heartbeatAt: "2020-01-01T12:00:00.000Z",
        timeoutAt: "2020-01-01T12:30:00.000Z",
      },
    });
    await service.appendTaskDeliverable(task.taskId, {
      deliverableType: "artifact",
      title: "Research handoff",
      description: "Source-backed handoff",
    });
    await service.appendTaskDiagnostic(task.taskId, {
      code: "final_delivery_retry",
      severity: "warning",
      title: "Final delivery retry queued",
      summary: "The channel final response needs retry.",
    });

    const runs = await service.listAgenticRuns({ surface: "cowork" });
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]).toMatchObject({
      taskId: task.taskId,
      runId: "run-1",
      boardId: "cowork:default",
      status: "running",
      surface: "cowork",
    });

    const tree = await service.getAgenticRunTree("run-1");
    expect(tree.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "run:run-1", kind: "run" }),
        expect.objectContaining({ id: `task:${task.taskId}`, kind: "task" }),
        expect.objectContaining({
          id: "subagent:child-session-1",
          kind: "subagent",
          metadata: expect.objectContaining({
            index: 2,
            depth: 1,
            dependsOnStepIds: ["plan-step"],
          }),
        }),
        expect.objectContaining({ kind: "artifact", label: "Research handoff" }),
        expect.objectContaining({ kind: "diagnostic", label: "Final delivery retry queued" }),
      ]),
    );
    expect(tree.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "child_timeout", title: "Child agent exceeded timeout" }),
        expect.objectContaining({ code: "stale_worker", title: "Child agent heartbeat is stale" }),
      ]),
    );
    expect(tree.controls.find((control) => control.action === "pause")?.enabled).toBe(true);
    expect(tree.controls.find((control) => control.action === "pause")?.runtimeEffect).toBe("runtime_pause");

    const control = await service.invokeAgenticControl("run-1", {
      action: "kill_child",
      controlId: "kill-child-once",
      agentSessionId: "child-session-1",
      actorId: "operator",
    });
    expect(control).toMatchObject({
      action: "kill_child",
      taskId: task.taskId,
      status: "recorded",
      controlId: "kill-child-once",
    });
    expect(storage.taskSubagents.getByAgentSessionId("child-session-1").status).toBe("active");
    const replay = await service.invokeAgenticControl("run-1", {
      action: "kill_child",
      controlId: "kill-child-once",
      agentSessionId: "child-session-1",
      actorId: "operator",
    });
    expect(replay).toMatchObject({
      action: "kill_child",
      status: "recorded",
      idempotentReplay: true,
      controlId: "kill-child-once",
    });
    expect(
      storage.taskActivities.listByTask(task.taskId).filter((activity) => activity.activityType === "control"),
    ).toHaveLength(1);
    expect(storage.taskActivities.listByTask(task.taskId).some((activity) => activity.activityType === "control")).toBe(
      true,
    );
    expect(publishRealtime).toHaveBeenCalledWith(
      "task_created",
      "tasks",
      expect.any(Object),
      expect.objectContaining({
        links: expect.objectContaining({ runId: "run-1", durableRunId: "durable-run-1" }),
      }),
    );
  });

  it("resolves Cowork orchestration run IDs through projected delegation state", async () => {
    const { service, storage } = createService();
    storage.chatSessionMeta.ensure("parent-session", "2026-06-22T00:00:00.000Z", "default");
    storage.chatSessionMeta.ensure("child-session", "2026-06-22T00:00:00.000Z", "default");
    storage.durableRuns.createRun({
      runId: "durable-parent",
      workflowKey: "chat.turn.execute",
      status: "completed",
      startedAt: "2026-06-22T00:00:00.000Z",
      finishedAt: "2026-06-22T00:04:00.000Z",
    });
    storage.durableRuns.createRun({
      runId: "durable-child",
      workflowKey: "chat.turn.execute",
      status: "completed",
      startedAt: "2026-06-22T00:01:00.000Z",
      finishedAt: "2026-06-22T00:03:00.000Z",
    });
    storage.chatTurnTraces.create({
      turnId: "parent-turn",
      sessionId: "parent-session",
      userMessageId: "parent-message",
      status: "running",
      mode: "cowork",
      model: "gpt-5",
      webMode: "deep",
      memoryMode: "off",
      thinkingLevel: "standard",
      routing: {},
      durable: {
        runId: "durable-parent",
        workflowKey: "chat.turn.execute",
        status: "queued",
        createdAt: "2026-06-22T00:00:00.000Z",
        updatedAt: "2026-06-22T00:00:00.000Z",
      },
    });
    storage.chatTurnTraces.create({
      turnId: "child-turn",
      sessionId: "child-session",
      userMessageId: "child-message",
      status: "completed",
      mode: "cowork",
      model: "gpt-5",
      webMode: "deep",
      memoryMode: "off",
      thinkingLevel: "standard",
      routing: {},
      durable: {
        runId: "durable-child",
        workflowKey: "chat.turn.execute",
        status: "completed",
        createdAt: "2026-06-22T00:01:00.000Z",
        updatedAt: "2026-06-22T00:03:00.000Z",
      },
    });
    storage.chatDelegationRuns.create({
      runId: "orch-91303",
      sessionId: "parent-session",
      taskId: "chat-orchestration:parent-turn",
      objective: "Locate boardgame stores near 91303",
      roles: ["Researcher"],
      mode: "sequential",
      status: "running",
      workflowTemplate: "research_then_summarize",
      startedAt: "2026-06-22T00:00:00.000Z",
    });
    storage.chatDelegationSteps.create({
      stepId: "orch-91303:researcher",
      runId: "orch-91303",
      role: "Researcher",
      index: 0,
      status: "running",
      durableRunId: "durable-child",
      childSessionId: "child-session",
      childTurnId: "child-turn",
      startedAt: "2026-06-22T00:01:00.000Z",
    });

    const tree = await service.getAgenticRunTree("orch-91303", { workspaceId: "default" });

    expect(tree).toMatchObject({ runId: "orch-91303", boardId: "cowork:default" });
    expect(tree.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "run:orch-91303", kind: "run", status: "completed" }),
        expect.objectContaining({ id: "subagent:orch-91303:researcher", status: "completed" }),
      ]),
    );
    expect(tree.diagnostics).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "projection_status_drift" })]),
    );
    expect((await service.listAgenticRuns({ surface: "cowork" })).items).toEqual(
      expect.arrayContaining([expect.objectContaining({ runId: "orch-91303", status: "completed" })]),
    );
  });

  it("does not resolve orphaned projected Cowork runs through caller workspace fallback", async () => {
    const { service, storage } = createService();
    storage.durableRuns.createRun({
      runId: "durable-orphan-child",
      workflowKey: "chat.turn.execute",
      status: "completed",
      startedAt: "2026-06-22T00:01:00.000Z",
      finishedAt: "2026-06-22T00:03:00.000Z",
    });
    storage.chatDelegationRuns.create({
      runId: "orch-orphan",
      sessionId: "missing-parent-session",
      taskId: "chat-orchestration:missing-parent-turn",
      objective: "Should not inherit caller workspace",
      roles: ["Researcher"],
      mode: "sequential",
      status: "running",
      startedAt: "2026-06-22T00:00:00.000Z",
    });
    storage.chatDelegationSteps.create({
      stepId: "orch-orphan:researcher",
      runId: "orch-orphan",
      role: "Researcher",
      index: 0,
      status: "running",
      durableRunId: "durable-orphan-child",
      startedAt: "2026-06-22T00:01:00.000Z",
    });

    await expect(service.getAgenticRunTree("orch-orphan", { workspaceId: "workspace-a" })).rejects.toThrow(
      /Agentic run not found/,
    );
    await expect(service.getAgenticRunTree("orch-orphan")).rejects.toThrow(/Agentic run not found/);
    expect(storage.chatDelegationSteps.get("orch-orphan:researcher").status).toBe("running");
    expect(storage.chatDelegationRuns.get("orch-orphan").status).toBe("running");
  });

  it("rejects unsafe terminal-state controls with a visible diagnostic", async () => {
    const { service, storage } = createService();
    const task = await service.createTask({
      workspaceId: "default",
      title: "Finished Code run",
      status: "done",
      priority: "normal",
      agenticContext: {
        boardId: "code:default",
        runId: "run-terminal",
        parentSessionId: "sess-code",
        surface: "code",
        status: "completed",
        contextMode: "isolated",
      },
    });

    const response = await service.invokeAgenticControl("run-terminal", {
      action: "pause",
      controlId: "pause-terminal",
      reason: "terminal runs cannot pause",
      actorId: "operator",
    });

    expect(response).toMatchObject({
      action: "pause",
      status: "rejected",
      runtimeEffect: "state_only",
      controlId: "pause-terminal",
    });
    const updated = storage.tasks.get(task.taskId);
    expect(updated.status).toBe("done");
    expect(updated.agenticContext?.status).toBe("completed");
    expect(updated.agenticContext?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "unsafe_status_transition", title: "Unsafe run control rejected" }),
      ]),
    );
    const replay = await service.invokeAgenticControl("run-terminal", {
      action: "pause",
      controlId: "pause-terminal",
      reason: "terminal runs cannot pause",
      actorId: "operator",
    });
    expect(replay).toMatchObject({ status: "rejected", idempotentReplay: true });
    await expect(
      service.invokeAgenticControl("run-terminal", {
        action: "pause",
        controlId: "pause-terminal",
        reason: "different terminal reason",
        actorId: "operator",
      }),
    ).rejects.toThrow(/different agentic control payload/);
  });

  it.each([
    { action: "pause" as const, taskStatus: "in_progress" as const, agenticStatus: "running" as const },
    { action: "cancel" as const, taskStatus: "in_progress" as const, agenticStatus: "running" as const },
    { action: "retry" as const, taskStatus: "blocked" as const, agenticStatus: "failed" as const },
    { action: "kill_child" as const, taskStatus: "in_progress" as const, agenticStatus: "running" as const },
    { action: "approve" as const, taskStatus: "in_progress" as const, agenticStatus: "running" as const },
    { action: "reject" as const, taskStatus: "in_progress" as const, agenticStatus: "running" as const },
  ])(
    "records $action intent without claiming a state-only executor transition",
    async ({ action, taskStatus, agenticStatus }) => {
      const { service, storage } = createService();
      const runId = `state-only-${action}`;
      const task = await service.createTask({
        workspaceId: "default",
        title: `State-only ${action}`,
        status: taskStatus,
        agenticContext: { runId, surface: "chat", status: agenticStatus },
      });
      await service.registerTaskSubagent(task.taskId, {
        agentSessionId: `child-${action}`,
        agentName: "worker",
      });

      const claim = vi.spyOn(storage.mutationIdempotency, "claim");
      const result = await service.invokeAgenticControl(runId, {
        action,
        controlId: `control-${action}`,
        reason: `operator requested ${action}`,
        ...(action === "kill_child" ? { agentSessionId: `child-${action}` } : {}),
      });

      expect(result).toMatchObject({ status: "recorded", runtimeEffect: "state_only" });
      expect(claim).toHaveBeenCalledWith(expect.objectContaining({ leaseDurationMs: expect.any(Number) }));
      if (action === "approve" || action === "reject") {
        expect(result.message).toMatch(/No approval was resolved.*canonical approval-resolution endpoint/i);
      }
      expect(storage.tasks.get(task.taskId)).toEqual(
        expect.objectContaining({
          status: taskStatus,
          agenticContext: expect.objectContaining({ status: agenticStatus }),
        }),
      );
      expect(storage.taskSubagents.getByAgentSessionId(`child-${action}`).status).toBe("active");
      expect(storage.taskActivities.listByTask(task.taskId, 20)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            activityType: "control",
            metadata: expect.objectContaining({
              action,
              resultStatus: "recorded",
              runtimeEffect: "state_only",
            }),
          }),
        ]),
      );
    },
  );

  it("applies pause through the attached durable run when one is available", async () => {
    const pauseDurableRun = vi.fn(async () => ({ status: "paused" }));
    const { service, storage } = createService({ pauseDurableRun });
    const task = await service.createTask({
      workspaceId: "default",
      title: "Durable Cowork run",
      description: "A run with an attached durable executor.",
      status: "in_progress",
      priority: "normal",
      agenticContext: {
        runId: "agentic-run-1",
        durableRunId: "durable-run-1",
        surface: "cowork",
        status: "running",
      },
    });

    const tree = await service.getAgenticRunTree("agentic-run-1");
    expect(tree.controls.find((control) => control.action === "pause")).toMatchObject({
      label: "Pause durable run",
      runtimeEffect: "runtime_pause",
    });

    const result = await service.invokeAgenticControl("agentic-run-1", {
      action: "pause",
      controlId: "  pause-durable-once  ",
      actorId: "operator",
    });
    expect(pauseDurableRun).toHaveBeenCalledWith("durable-run-1", "operator");
    expect(result).toMatchObject({
      taskId: task.taskId,
      controlId: "pause-durable-once",
      status: "applied",
      runtimeEffect: "runtime_pause",
    });
    const replay = await service.invokeAgenticControl("agentic-run-1", {
      action: "pause",
      controlId: "pause-durable-once",
      actorId: "operator",
    });
    expect(pauseDurableRun).toHaveBeenCalledTimes(1);
    expect(replay).toMatchObject({
      controlId: "pause-durable-once",
      status: "applied",
      runtimeEffect: "runtime_pause",
      idempotentReplay: true,
    });
    expect(replay.message).toBe(result.message);
    expect(storage.tasks.get(task.taskId).agenticContext?.status).toBe("paused");
  });

  it("claims a controlId before the runtime effect and rejects a concurrent duplicate", async () => {
    const serviceRef: { current?: TaskLifecycleService } = {};
    let nestedError: unknown;
    let attemptedNestedReplay = false;
    const pauseDurableRun = vi.fn(async () => {
      if (!attemptedNestedReplay) {
        attemptedNestedReplay = true;
        try {
          await serviceRef.current!.invokeAgenticControl("agentic-run-concurrent-pause", {
            action: "pause",
            controlId: "pause-concurrent-once",
            actorId: "operator",
          });
        } catch (error) {
          nestedError = error;
        }
      }
      return { status: "paused" };
    });
    const built = createService({ pauseDurableRun });
    const service = built.service;
    serviceRef.current = service;
    const { storage } = built;
    const task = await service.createTask({
      workspaceId: "default",
      title: "Concurrently controlled run",
      status: "in_progress",
      agenticContext: {
        runId: "agentic-run-concurrent-pause",
        durableRunId: "durable-run-concurrent-pause",
        surface: "chat",
        status: "running",
      },
    });
    const originalMarkCompleted = storage.mutationIdempotency.markCompleted.bind(storage.mutationIdempotency);
    const markCompleted = vi.spyOn(storage.mutationIdempotency, "markCompleted").mockImplementation((input) => {
      expect(storage.taskActivities.findControlByTaskAndControlId(task.taskId, "pause-concurrent-once")).toBeDefined();
      return originalMarkCompleted(input);
    });

    const result = await service.invokeAgenticControl("agentic-run-concurrent-pause", {
      action: "pause",
      controlId: "pause-concurrent-once",
      actorId: "operator",
    });

    expect(result).toMatchObject({ status: "applied", runtimeEffect: "runtime_pause" });
    expect(nestedError).toBeInstanceOf(ConflictError);
    expect(pauseDurableRun).toHaveBeenCalledTimes(1);
    expect(
      storage.taskActivities.listByTask(task.taskId).filter((activity) => activity.activityType === "control"),
    ).toHaveLength(1);
    expect(markCompleted).toHaveBeenCalledTimes(1);
  });

  it("derives the same missing runtime controlId for concurrency and response-loss retry, then advances after resume", async () => {
    const serviceRef: { current?: TaskLifecycleService } = {};
    let nestedError: unknown;
    let nestedAttempted = false;
    let durableState = { status: "running", version: 8 };
    const pauseDurableRun = vi.fn(async () => {
      if (!nestedAttempted) {
        nestedAttempted = true;
        try {
          await serviceRef.current!.invokeAgenticControl("agentic-run-derived-control", {
            action: "pause",
            actorId: "operator",
          });
        } catch (error) {
          nestedError = error;
        }
      }
      return { status: "paused" };
    });
    const built = createService({ pauseDurableRun });
    const service = built.service;
    serviceRef.current = service;
    const { storage } = built;
    vi.spyOn(storage.durableRuns, "getRun").mockImplementation(() => durableState as never);
    const task = await service.createTask({
      workspaceId: "default",
      title: "Derived control generation",
      status: "in_progress",
      agenticContext: {
        runId: "agentic-run-derived-control",
        durableRunId: "durable-run-derived-control",
        surface: "chat",
        status: "running",
      },
    });

    const first = await service.invokeAgenticControl("agentic-run-derived-control", {
      action: "pause",
      actorId: "operator",
    });
    expect(first.controlId).toMatch(/^implicit-agentic-control-/);
    expect(nestedError).toBeInstanceOf(ConflictError);
    expect(pauseDurableRun).toHaveBeenCalledTimes(1);

    durableState = { status: "paused", version: 9 };
    const responseLossRetry = await service.invokeAgenticControl("agentic-run-derived-control", {
      action: "pause",
      actorId: "operator",
    });
    expect(responseLossRetry).toMatchObject({ controlId: first.controlId, idempotentReplay: true });
    expect(pauseDurableRun).toHaveBeenCalledTimes(1);

    durableState = { status: "running", version: 10 };
    storage.tasks.update(task.taskId, {
      agenticContext: { ...storage.tasks.get(task.taskId).agenticContext!, status: "running" },
    });
    const afterResume = await service.invokeAgenticControl("agentic-run-derived-control", {
      action: "pause",
      actorId: "operator",
    });
    expect(afterResume.controlId).toMatch(/^implicit-agentic-control-/);
    expect(afterResume.controlId).not.toBe(first.controlId);
    expect(pauseDurableRun).toHaveBeenCalledTimes(2);
  });

  it("generates and returns distinct reservations for repeated missing-ID state-only intent", async () => {
    const { service, storage } = createService();
    const task = await service.createTask({
      workspaceId: "default",
      title: "Repeated steering intent",
      status: "in_progress",
      agenticContext: { runId: "agentic-run-generated-control", surface: "chat", status: "running" },
    });

    const first = await service.invokeAgenticControl("agentic-run-generated-control", {
      action: "steer",
      instruction: "Check the latest logs.",
    });
    const second = await service.invokeAgenticControl("agentic-run-generated-control", {
      action: "steer",
      instruction: "Check the latest logs.",
    });

    expect(first.controlId).toMatch(/^generated-agentic-control-/);
    expect(second.controlId).toMatch(/^generated-agentic-control-/);
    expect(second.controlId).not.toBe(first.controlId);
    expect(
      storage.taskActivities.listByTask(task.taskId).filter((activity) => activity.activityType === "control"),
    ).toHaveLength(2);
  });

  it("rejects a concurrent controlId payload mismatch before either second runtime effect", async () => {
    const serviceRef: { current?: TaskLifecycleService } = {};
    let nestedError: unknown;
    const cancelDurableRun = vi.fn(async () => ({ status: "cancelled" }));
    const pauseDurableRun = vi.fn(async () => {
      try {
        await serviceRef.current!.invokeAgenticControl("agentic-run-concurrent-mismatch", {
          action: "cancel",
          controlId: "shared-concurrent-control",
          actorId: "operator",
        });
      } catch (error) {
        nestedError = error;
      }
      return { status: "paused" };
    });
    const built = createService({ pauseDurableRun, cancelDurableRun });
    const service = built.service;
    serviceRef.current = service;
    await service.createTask({
      workspaceId: "default",
      title: "Concurrent mismatch run",
      status: "in_progress",
      agenticContext: {
        runId: "agentic-run-concurrent-mismatch",
        durableRunId: "durable-run-concurrent-mismatch",
        surface: "chat",
        status: "running",
      },
    });

    await service.invokeAgenticControl("agentic-run-concurrent-mismatch", {
      action: "pause",
      controlId: "shared-concurrent-control",
      actorId: "operator",
    });

    expect(nestedError).toBeInstanceOf(ValidationError);
    expect(pauseDurableRun).toHaveBeenCalledTimes(1);
    expect(cancelDurableRun).not.toHaveBeenCalled();
  });

  it("rolls back the task and receipt when control activity persistence fails, then probes before retry", async () => {
    const pauseDurableRun = vi.fn(async () => ({ status: "paused" }));
    const { service, storage } = createService({ pauseDurableRun });
    vi.spyOn(storage.durableRuns, "getRun").mockReturnValue({ status: "paused" } as never);
    const task = await service.createTask({
      workspaceId: "default",
      title: "Receipt rollback control",
      status: "in_progress",
      agenticContext: {
        runId: "agentic-run-receipt-rollback",
        durableRunId: "durable-run-receipt-rollback",
        surface: "chat",
        status: "running",
      },
    });
    const append = storage.taskActivities.append.bind(storage.taskActivities);
    vi.spyOn(storage.taskActivities, "append")
      .mockImplementationOnce(() => {
        throw new Error("control receipt append failed");
      })
      .mockImplementation(append);
    const request = {
      action: "pause" as const,
      controlId: "pause-receipt-rollback",
      actorId: "operator",
    };

    await expect(service.invokeAgenticControl("agentic-run-receipt-rollback", request)).rejects.toThrow(
      "control receipt append failed",
    );
    expect(storage.tasks.get(task.taskId).agenticContext?.status).toBe("running");
    expect(storage.taskActivities.findControlByTaskAndControlId(task.taskId, request.controlId)).toBeUndefined();

    expect(await service.invokeAgenticControl("agentic-run-receipt-rollback", request)).toMatchObject({
      status: "applied",
      runtimeEffect: "runtime_pause",
    });
    expect(pauseDurableRun).toHaveBeenCalledTimes(1);
    expect(storage.tasks.get(task.taskId).agenticContext?.status).toBe("paused");
  });

  it("rolls back a control receipt when the idempotency claim token is lost", async () => {
    const pauseDurableRun = vi.fn(async () => ({ status: "paused" }));
    const { service, storage } = createService({ pauseDurableRun });
    vi.spyOn(storage.durableRuns, "getRun").mockReturnValue({ status: "paused" } as never);
    const task = await service.createTask({
      workspaceId: "default",
      title: "Lost control ownership",
      status: "in_progress",
      agenticContext: {
        runId: "agentic-run-lost-control-token",
        durableRunId: "durable-run-lost-control-token",
        surface: "chat",
        status: "running",
      },
    });
    const markCompleted = storage.mutationIdempotency.markCompleted.bind(storage.mutationIdempotency);
    vi.spyOn(storage.mutationIdempotency, "markCompleted")
      .mockImplementationOnce(() => false)
      .mockImplementation(markCompleted);
    const request = {
      action: "pause" as const,
      controlId: "pause-lost-control-token",
      actorId: "operator",
    };

    await expect(service.invokeAgenticControl("agentic-run-lost-control-token", request)).rejects.toThrow(
      ConflictError,
    );
    expect(storage.tasks.get(task.taskId).agenticContext?.status).toBe("running");
    expect(storage.taskActivities.findControlByTaskAndControlId(task.taskId, request.controlId)).toBeUndefined();

    expect(await service.invokeAgenticControl("agentic-run-lost-control-token", request)).toMatchObject({
      status: "applied",
      runtimeEffect: "runtime_pause",
    });
    expect(pauseDurableRun).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a thrown runtime control cannot be reconciled to durable status", async () => {
    const pauseDurableRun = vi.fn(async () => {
      throw new Error("ambiguous runtime failure");
    });
    const { service, storage } = createService({ pauseDurableRun });
    const task = await service.createTask({
      workspaceId: "default",
      title: "Ambiguous runtime control",
      status: "in_progress",
      agenticContext: {
        runId: "agentic-run-ambiguous-control",
        durableRunId: "missing-durable-run",
        surface: "chat",
        status: "running",
      },
    });

    await expect(
      service.invokeAgenticControl("agentic-run-ambiguous-control", {
        action: "pause",
        controlId: "pause-ambiguous-control",
        actorId: "operator",
      }),
    ).rejects.toThrow(ConflictError);
    expect(
      storage.taskActivities.findControlByTaskAndControlId(task.taskId, "pause-ambiguous-control"),
    ).toBeUndefined();
    expect(storage.tasks.get(task.taskId).agenticContext?.status).toBe("running");
  });

  it("applies cancel through the attached durable run when one is available", async () => {
    const cancelDurableRun = vi.fn(async () => ({ status: "cancelled" }));
    const { service, storage } = createService({ cancelDurableRun });
    const task = await service.createTask({
      workspaceId: "default",
      title: "Durable Cowork run",
      description: "A cancellable run with an attached durable executor.",
      status: "in_progress",
      priority: "normal",
      agenticContext: {
        runId: "agentic-run-cancel",
        durableRunId: "durable-run-cancel",
        surface: "cowork",
        status: "running",
      },
    });

    const tree = await service.getAgenticRunTree("agentic-run-cancel");
    expect(tree.controls.find((control) => control.action === "cancel")).toMatchObject({
      label: "Cancel durable run",
      runtimeEffect: "runtime_cancel",
    });

    const result = await service.invokeAgenticControl("agentic-run-cancel", {
      action: "cancel",
      controlId: "cancel-durable-once",
      actorId: "operator",
    });
    expect(cancelDurableRun).toHaveBeenCalledWith("durable-run-cancel", "operator");
    expect(result).toMatchObject({
      taskId: task.taskId,
      controlId: "cancel-durable-once",
      status: "applied",
      runtimeEffect: "runtime_cancel",
    });
    const replay = await service.invokeAgenticControl("agentic-run-cancel", {
      action: "cancel",
      controlId: "cancel-durable-once",
      actorId: "operator",
    });
    expect(cancelDurableRun).toHaveBeenCalledTimes(1);
    expect(replay).toMatchObject({
      controlId: "cancel-durable-once",
      status: "applied",
      runtimeEffect: "runtime_cancel",
      idempotentReplay: true,
    });
    const updated = storage.tasks.get(task.taskId);
    expect(updated.status).toBe("blocked");
    expect(updated.agenticContext?.status).toBe("cancelled");
  });

  it("keeps cancellation authoritative and conflicts the stale pause after a concurrent cancel", async () => {
    let nestedCancelResponse: Awaited<ReturnType<TaskLifecycleService["invokeAgenticControl"]>> | undefined;
    const cancelDurableRun = vi.fn(async (durableRunId: string) => {
      const current = storageRef.durableRuns.getRun(durableRunId);
      storageRef.durableRuns.updateRun({
        runId: durableRunId,
        status: "cancelled",
        expectedVersion: current.version,
      });
      return { status: "cancelled" };
    });
    const pauseDurableRun = vi.fn(async (durableRunId: string) => {
      const current = storageRef.durableRuns.getRun(durableRunId);
      storageRef.durableRuns.updateRun({
        runId: durableRunId,
        status: "paused",
        expectedVersion: current.version,
      });
      nestedCancelResponse = await serviceRef.invokeAgenticControl("agentic-run-pause-cancel-race", {
        action: "cancel",
        controlId: "cancel-wins-race",
        actorId: "worker-b",
      });
      return { status: "paused" };
    });
    const built = createService({ pauseDurableRun, cancelDurableRun });
    const serviceRef = built.service;
    const storageRef = built.storage;
    storageRef.durableRuns.createRun({
      runId: "durable-run-pause-cancel-race",
      workflowKey: "approval.wait",
      status: "running",
    });
    const task = await serviceRef.createTask({
      workspaceId: "default",
      title: "Pause versus cancel race",
      status: "in_progress",
      agenticContext: {
        runId: "agentic-run-pause-cancel-race",
        durableRunId: "durable-run-pause-cancel-race",
        surface: "chat",
        status: "running",
      },
    });

    await expect(
      serviceRef.invokeAgenticControl("agentic-run-pause-cancel-race", {
        action: "pause",
        controlId: "pause-loses-race",
        actorId: "worker-a",
        expectedRevision: task.revision,
      }),
    ).rejects.toThrow(ConflictError);

    expect(nestedCancelResponse).toMatchObject({ status: "applied", runtimeEffect: "runtime_cancel" });
    expect(storageRef.durableRuns.getRun("durable-run-pause-cancel-race").status).toBe("cancelled");
    expect(storageRef.tasks.get(task.taskId)).toMatchObject({
      status: "blocked",
      agenticContext: expect.objectContaining({ status: "cancelled" }),
    });
    expect(storageRef.taskActivities.findControlByTaskAndControlId(task.taskId, "pause-loses-race")).toBeUndefined();
    expect(pauseDurableRun).toHaveBeenCalledTimes(1);
    expect(cancelDurableRun).toHaveBeenCalledTimes(1);
  });

  it("records stale durable pause failures as rejected controls", async () => {
    const pauseDurableRun = vi.fn(async () => {
      throw new Error("Durable run is already completed.");
    });
    const { service, storage } = createService({ pauseDurableRun });
    storage.durableRuns.createRun({
      runId: "durable-run-stale-pause",
      workflowKey: "approval.wait",
      status: "completed",
      startedAt: "2026-07-11T00:00:00.000Z",
      finishedAt: "2026-07-11T00:01:00.000Z",
    });
    const task = await service.createTask({
      workspaceId: "default",
      title: "Stale durable Cowork run",
      status: "in_progress",
      priority: "normal",
      agenticContext: {
        runId: "agentic-run-stale-pause",
        durableRunId: "durable-run-stale-pause",
        surface: "cowork",
        status: "running",
      },
    });

    const result = await service.invokeAgenticControl("agentic-run-stale-pause", {
      action: "pause",
      controlId: "pause-stale-durable",
      reason: "operator paused from stale UI",
      actorId: "operator",
    });

    expect(pauseDurableRun).toHaveBeenCalledWith("durable-run-stale-pause", "operator");
    expect(result).toMatchObject({
      taskId: task.taskId,
      controlId: "pause-stale-durable",
      status: "rejected",
      runtimeEffect: "state_only",
    });
    expect(result.message).toContain("Could not pause attached durable run");
    const updated = storage.tasks.get(task.taskId);
    expect(updated.status).toBe("in_progress");
    expect(updated.agenticContext?.status).toBe("running");
    expect(updated.agenticContext?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unsafe_status_transition",
          evidenceRef: "durable-run-stale-pause",
          title: "Durable run control rejected",
        }),
      ]),
    );
    const replay = await service.invokeAgenticControl("agentic-run-stale-pause", {
      action: "pause",
      controlId: "pause-stale-durable",
      reason: "operator paused from stale UI",
      actorId: "operator",
    });
    expect(pauseDurableRun).toHaveBeenCalledTimes(1);
    expect(replay).toMatchObject({ status: "rejected", idempotentReplay: true });
    await expect(
      service.invokeAgenticControl("agentic-run-stale-pause", {
        action: "pause",
        controlId: "pause-stale-durable",
        reason: "changed stale UI reason",
        actorId: "operator",
      }),
    ).rejects.toThrow(/different agentic control payload/);
  });

  it("records stale dead-lettered durable control failures as rejected controls", async () => {
    const pauseDurableRun = vi.fn(async () => {
      throw new Error("Durable run is already terminal (dead_lettered)");
    });
    const cancelDurableRun = vi.fn(async () => {
      throw new Error("Durable run is already terminal (dead_lettered)");
    });
    const { service, storage } = createService({ pauseDurableRun, cancelDurableRun });
    storage.durableRuns.createRun({
      runId: "durable-run-dead-lettered",
      workflowKey: "approval.wait",
      status: "dead_lettered",
      startedAt: "2026-07-11T00:00:00.000Z",
      finishedAt: "2026-07-11T00:01:00.000Z",
    });
    const task = await service.createTask({
      workspaceId: "default",
      title: "Stale dead-lettered durable Cowork run",
      status: "in_progress",
      priority: "normal",
      agenticContext: {
        runId: "agentic-run-dead-lettered",
        durableRunId: "durable-run-dead-lettered",
        surface: "cowork",
        status: "running",
      },
    });

    const pause = await service.invokeAgenticControl("agentic-run-dead-lettered", {
      action: "pause",
      controlId: "pause-dead-lettered",
      actorId: "operator",
    });
    const cancel = await service.invokeAgenticControl("agentic-run-dead-lettered", {
      action: "cancel",
      controlId: "cancel-dead-lettered",
      actorId: "operator",
    });

    expect(pause).toMatchObject({ status: "rejected", runtimeEffect: "state_only" });
    expect(cancel).toMatchObject({ status: "rejected", runtimeEffect: "state_only" });
    expect(pauseDurableRun).toHaveBeenCalledWith("durable-run-dead-lettered", "operator");
    expect(cancelDurableRun).toHaveBeenCalledWith("durable-run-dead-lettered", "operator");
    const updated = storage.tasks.get(task.taskId);
    expect(updated.status).toBe("in_progress");
    expect(updated.agenticContext?.status).toBe("running");
    expect(updated.agenticContext?.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          evidenceRef: "durable-run-dead-lettered",
          title: "Durable run control rejected",
        }),
      ]),
    );
  });

  it("records an applied pause when the runtime reaches paused state before throwing", async () => {
    const pauseDurableRun = vi.fn(async () => {
      throw new Error("post-commit notification failed");
    });
    const { service, storage } = createService({ pauseDurableRun });
    vi.spyOn(storage.durableRuns, "getRun").mockReturnValue({ status: "paused" } as never);
    const task = await service.createTask({
      workspaceId: "default",
      title: "Pause post-commit failure",
      status: "in_progress",
      agenticContext: {
        runId: "agentic-run-pause-post-commit",
        durableRunId: "durable-run-pause-post-commit",
        surface: "chat",
        status: "running",
      },
    });

    const result = await service.invokeAgenticControl("agentic-run-pause-post-commit", {
      action: "pause",
      controlId: "pause-post-commit-once",
      actorId: "operator",
    });

    expect(result).toMatchObject({ status: "applied", runtimeEffect: "runtime_pause" });
    expect(storage.tasks.get(task.taskId).agenticContext?.status).toBe("paused");
    expect(storage.taskActivities.findControlByTaskAndControlId(task.taskId, "pause-post-commit-once")).toEqual(
      expect.objectContaining({ metadata: expect.objectContaining({ resultStatus: "applied" }) }),
    );
  });

  it("rejects state-only cancel for failed agentic runs without erasing failure truth", async () => {
    const { service, storage } = createService();
    const task = await service.createTask({
      workspaceId: "default",
      title: "Failed agentic run",
      status: "blocked",
      priority: "normal",
      agenticContext: {
        runId: "agentic-run-failed",
        surface: "cowork",
        status: "failed",
      },
    });

    const tree = await service.getAgenticRunTree("agentic-run-failed");
    expect(tree.controls.find((control) => control.action === "cancel")?.enabled).toBe(false);

    const result = await service.invokeAgenticControl("agentic-run-failed", {
      action: "cancel",
      controlId: "cancel-failed-run",
      actorId: "operator",
    });

    expect(result).toMatchObject({ status: "rejected", runtimeEffect: "state_only" });
    const updated = storage.tasks.get(task.taskId);
    expect(updated.status).toBe("blocked");
    expect(updated.agenticContext?.status).toBe("failed");
  });

  it("bridges explicit diagnostics to the improvement ledger without blocking task truth", async () => {
    const bridge = vi.fn();
    const { service } = createService({ recordAgenticDiagnosticSignal: bridge });
    const task = await service.createTask({
      workspaceId: "default",
      title: "Agentic diagnostic bridge",
      status: "in_progress",
      priority: "normal",
      agenticContext: {
        runId: "run-bridge",
        surface: "cowork",
        status: "running",
        parentSessionId: "sess-bridge",
      },
    });

    const diagnostic = await service.appendTaskDiagnostic(task.taskId, {
      signalId: "signal-bridge",
      code: "stale_worker",
      severity: "warning",
      title: "Worker stale",
      summary: "Worker heartbeat is stale.",
    });

    expect(bridge).toHaveBeenCalledTimes(1);
    expect(bridge).toHaveBeenCalledWith({
      task: expect.objectContaining({
        taskId: task.taskId,
        agenticContext: expect.objectContaining({ runId: "run-bridge" }),
      }),
      diagnostic,
    });

    const failingBridge = vi.fn(() => {
      throw new Error("ledger unavailable");
    });
    const { service: serviceWithFailingBridge } = createService({ recordAgenticDiagnosticSignal: failingBridge });
    const secondTask = await serviceWithFailingBridge.createTask({
      title: "Bridge failure still records",
      status: "in_progress",
      priority: "normal",
    });
    await expect(
      serviceWithFailingBridge.appendTaskDiagnostic(secondTask.taskId, {
        code: "worker_crash",
        severity: "critical",
        title: "Worker crashed",
        summary: "The worker process crashed.",
      }),
    ).resolves.toBeDefined();
    const secondTaskActivities = await serviceWithFailingBridge.listTaskActivities(secondTask.taskId);
    expect(
      secondTaskActivities.some((activity) => activity.metadata?.code === "agentic_diagnostic_mirror_failed"),
    ).toBe(true);
  }, 15_000);

  it("paginates agentic-filtered runs with a cursor from returned records", async () => {
    const { service, storage } = createService();
    storage.tasks.create(
      {
        title: "Newest Cowork run",
        status: "in_progress",
        priority: "normal",
        agenticContext: {
          runId: "run-newest",
          surface: "cowork",
          status: "running",
          parentSessionId: "sess-cowork",
        },
      },
      "2026-05-05T12:04:00.000Z",
    );
    storage.tasks.create(
      {
        title: "Plain task between runs",
        status: "in_progress",
        priority: "normal",
      },
      "2026-05-05T12:03:00.000Z",
    );
    storage.tasks.create(
      {
        title: "Second Cowork run",
        status: "in_progress",
        priority: "normal",
        agenticContext: {
          runId: "run-second",
          surface: "cowork",
          status: "running",
          parentSessionId: "sess-cowork",
        },
      },
      "2026-05-05T12:02:00.000Z",
    );
    storage.tasks.create(
      {
        title: "Chat run filtered out",
        status: "in_progress",
        priority: "normal",
        agenticContext: {
          runId: "run-chat",
          surface: "chat",
          status: "running",
          parentSessionId: "sess-chat",
        },
      },
      "2026-05-05T12:01:00.000Z",
    );
    storage.tasks.create(
      {
        title: "Oldest Cowork run",
        status: "in_progress",
        priority: "normal",
        agenticContext: {
          runId: "run-oldest",
          surface: "cowork",
          status: "running",
          parentSessionId: "sess-cowork",
        },
      },
      "2026-05-05T12:00:00.000Z",
    );

    const firstPage = await service.listAgenticRuns({ surface: "cowork", limit: 2 });
    expect(firstPage.items.map((item) => item.runId)).toEqual(["run-newest", "run-second"]);
    expect(firstPage.nextCursor).toBe(`${firstPage.items[1]!.updatedAt}|${firstPage.items[1]!.taskId}`);

    const secondPage = await service.listAgenticRuns({ surface: "cowork", limit: 2, cursor: firstPage.nextCursor });
    expect(secondPage.items.map((item) => item.runId)).toEqual(["run-oldest"]);
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it("merges fresh projected Cowork runs before task-backed rows on the first page", async () => {
    const { service, storage } = createService();
    storage.chatSessionMeta.ensure("projected-session", "2026-05-05T12:05:00.000Z", "default");
    storage.chatDelegationRuns.create({
      runId: "projected-newest",
      sessionId: "projected-session",
      taskId: "chat-orchestration:turn-projected",
      objective: "Fresh projected orchestration",
      roles: ["Researcher"],
      mode: "sequential",
      status: "running",
      startedAt: "2026-05-05T12:05:00.000Z",
    });
    storage.tasks.create(
      {
        title: "Task backed run",
        status: "in_progress",
        priority: "normal",
        agenticContext: {
          runId: "task-backed",
          surface: "cowork",
          status: "running",
          parentSessionId: "sess-task",
        },
      },
      "2026-05-05T12:04:00.000Z",
    );
    storage.tasks.create(
      {
        title: "Older task backed run",
        status: "in_progress",
        priority: "normal",
        agenticContext: {
          runId: "task-older",
          surface: "cowork",
          status: "running",
          parentSessionId: "sess-task",
        },
      },
      "2026-05-05T12:03:00.000Z",
    );

    const firstPage = await service.listAgenticRuns({ surface: "cowork", limit: 2 });

    expect(firstPage.items.map((item) => item.runId)).toEqual(["projected-newest", "task-backed"]);
    expect(firstPage.nextCursor).toBe(`${firstPage.items[1]!.updatedAt}|${firstPage.items[1]!.taskId}`);
    expect(
      (await service.listAgenticRuns({ surface: "cowork", limit: 2, cursor: firstPage.nextCursor })).items,
    ).toEqual([expect.objectContaining({ runId: "task-older" })]);
  });

  it("defaults agentic run listings to the default workspace", async () => {
    const { service } = createService();
    await service.createTask({
      workspaceId: "default",
      title: "Default workspace run",
      status: "in_progress",
      agenticContext: {
        runId: "run-default",
        surface: "cowork",
        status: "running",
      },
    });
    await service.createTask({
      workspaceId: "workspace-a",
      title: "Other workspace run",
      status: "in_progress",
      agenticContext: {
        runId: "run-workspace-a",
        surface: "cowork",
        status: "running",
      },
    });

    expect((await service.listAgenticRuns({ surface: "cowork" })).items.map((item) => item.runId)).toEqual([
      "run-default",
    ]);
    expect(
      (await service.listAgenticRuns({ workspaceId: "workspace-a", surface: "cowork" })).items.map(
        (item) => item.runId,
      ),
    ).toEqual(["run-workspace-a"]);
  });

  it("builds run trees for agentic runs beyond the first active task page", async () => {
    const { service, storage } = createService();
    const olderRun = storage.tasks.create(
      {
        title: "Older durable run",
        status: "in_progress",
        priority: "normal",
        agenticContext: {
          runId: "run-after-first-page",
          surface: "cowork",
          status: "running",
          parentSessionId: "sess-old",
        },
      },
      "2026-05-05T10:00:00.000Z",
    );

    for (let index = 0; index < 510; index += 1) {
      storage.tasks.create(
        {
          title: `Plain active task ${index}`,
          status: "in_progress",
          priority: "normal",
        },
        `2026-05-05T12:${String(index % 60).padStart(2, "0")}:00.000Z`,
      );
    }

    const tree = await service.getAgenticRunTree("run-after-first-page");
    expect(tree.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "run:run-after-first-page", taskId: olderRun.taskId })]),
    );
    expect(await service.invokeAgenticControl("run-after-first-page", { action: "pause" })).toMatchObject({
      taskId: olderRun.taskId,
      status: "recorded",
    });
  }, 20_000);

  it("records child-run kill intent without mutating child or parent subagents", async () => {
    const { service, storage } = createService();
    const parent = await service.createTask({
      workspaceId: "default",
      title: "Parent run",
      status: "in_progress",
      agenticContext: {
        runId: "run-parent",
        childRunIds: ["run-child"],
        surface: "cowork",
        status: "running",
      },
    });
    const child = await service.createTask({
      workspaceId: "default",
      title: "Child run",
      status: "in_progress",
      agenticContext: {
        runId: "run-child",
        parentRunId: "run-parent",
        surface: "cowork",
        status: "running",
      },
    });
    await service.registerTaskSubagent(parent.taskId, {
      agentSessionId: "parent-subagent",
      agentName: "parent-worker",
    });
    await service.registerTaskSubagent(child.taskId, {
      agentSessionId: "child-subagent",
      agentName: "child-worker",
    });

    await expect(
      service.invokeAgenticControl("run-child", {
        action: "kill_child",
        agentSessionId: "parent-subagent",
      }),
    ).rejects.toThrow(/Sub-agent session .* not found/);

    expect(
      await service.invokeAgenticControl("run-child", {
        action: "kill_child",
        agentSessionId: "child-subagent",
      }),
    ).toMatchObject({ status: "recorded" });
    expect(storage.taskSubagents.findByAgentSessionId("child-subagent")?.status).toBe("active");
    expect(storage.taskSubagents.findByAgentSessionId("parent-subagent")?.status).toBe("active");
  });

  it("rejects idempotent control replays when the payload changes", async () => {
    const { service } = createService();
    await service.createTask({
      workspaceId: "default",
      title: "Controlled run",
      status: "in_progress",
      agenticContext: {
        runId: "run-control",
        surface: "cowork",
        status: "running",
      },
    });

    await service.invokeAgenticControl("run-control", {
      action: "pause",
      controlId: "control-1",
      reason: "pause for operator review",
    });
    expect(
      await service.invokeAgenticControl("run-control", {
        action: "pause",
        controlId: "control-1",
        reason: "pause for operator review",
      }),
    ).toMatchObject({ idempotentReplay: true });
    await expect(
      service.invokeAgenticControl("run-control", {
        action: "pause",
        controlId: "control-1",
        reason: "pause a different target",
      }),
    ).rejects.toThrow(/different agentic control payload/);
  });

  it("rejects old idempotent control replays after newer task activity churn", async () => {
    const { service, storage } = createService();
    const task = await service.createTask({
      workspaceId: "default",
      title: "Long-running controlled run",
      status: "in_progress",
      agenticContext: {
        runId: "run-control-churn",
        surface: "cowork",
        status: "running",
      },
    });
    storage.taskActivities.append(
      task.taskId,
      {
        activityType: "control",
        message: "pause control recorded: first target",
        metadata: {
          action: "pause",
          controlId: "control-old",
          reason: "first target",
          resultStatus: "recorded",
          runtimeEffect: "state_only",
        },
      },
      "2026-05-20T00:00:00.000Z",
    );
    for (let index = 0; index < 201; index += 1) {
      storage.taskActivities.append(
        task.taskId,
        {
          activityType: "comment",
          message: `newer activity ${index}`,
        },
        new Date(Date.UTC(2026, 4, 20, 0, 0, index + 1)).toISOString(),
      );
    }

    await expect(
      service.invokeAgenticControl("run-control-churn", {
        action: "pause",
        controlId: "control-old",
        reason: "different target",
      }),
    ).rejects.toThrow(/different agentic control payload/);
  });
});

describe("TaskLifecycleService — distress signals", () => {
  it("emitDistressSignal persists the new signal and publishes a realtime event", async () => {
    const { service, storage, publishRealtime } = createService();
    const task = await service.createTask({ title: "t" });
    const updated = await service.emitDistressSignal(task.taskId, {
      code: "needs_user",
      severity: "warn",
      title: "Need input",
      summary: "worker is asking",
      emittedBy: "agent-7",
    });
    expect(updated.distressSignals?.length).toBe(1);
    expect(storage.tasks.get(task.taskId).distressSignals?.[0]?.code).toBe("needs_user");
    const distressCall = publishRealtime.mock.calls.find((c) => c[0] === "task_distress_emitted");
    expect(distressCall).toBeTruthy();
  });

  it("resolveDistressSignal marks it resolved", async () => {
    const { service } = createService();
    const task = await service.createTask({ title: "t" });
    const withSignal = await service.emitDistressSignal(task.taskId, {
      code: "tool_error",
      severity: "warn",
      title: "Tool blew up",
      summary: "boom",
    });
    const signalId = withSignal.distressSignals![0].signalId;
    const resolved = await service.resolveDistressSignal(task.taskId, signalId, { resolvedBy: "op-1" });
    expect(resolved.distressSignals![0].resolvedAt).toBeTruthy();
    expect(resolved.distressSignals![0].resolvedBy).toBe("op-1");
  });

  it("resolveDistressSignal throws when signalId does not exist", async () => {
    const { service } = createService();
    const task = await service.createTask({ title: "t" });
    await expect(service.resolveDistressSignal(task.taskId, "ds-nonexistent", { resolvedBy: "op" })).rejects.toThrow(
      /No unresolved distress signal/,
    );
  });

  it("rejects a stale distress append without losing the winning signal", async () => {
    const { service } = createService();
    const task = await service.createTask({ title: "t" });
    const winner = await service.emitDistressSignalWithRevision(
      task.taskId,
      { code: "needs_user", severity: "warn", title: "Winner", summary: "Keep this signal" },
      task.revision,
    );

    await expect(
      service.emitDistressSignalWithRevision(
        task.taskId,
        { code: "tool_error", severity: "critical", title: "Stale", summary: "Must not overwrite" },
        task.revision,
      ),
    ).rejects.toThrow(ConflictError);
    expect(await service.getTask(task.taskId)).toMatchObject({
      revision: winner.revision,
      distressSignals: [expect.objectContaining({ title: "Winner" })],
    });
  });
});

describe("TaskLifecycleService — retry budget", () => {
  it("setRetryBudget initializes the budget when none exists", async () => {
    const { service } = createService();
    const task = await service.createTask({ title: "t" });
    const updated = await service.setRetryBudget(task.taskId, 3);
    expect(updated.retryBudget?.maxRetries).toBe(3);
    expect(updated.retryBudget?.retryCount).toBe(0);
  });

  it("recordRetryAttempt increments retryCount but stays in progress when below budget", async () => {
    const { service } = createService();
    const task = await service.createTask({ title: "t", status: "in_progress" });
    await service.setRetryBudget(task.taskId, 2);
    const after1 = await service.recordRetryAttempt(task.taskId, "transient_error");
    expect(after1.retryBudget?.retryCount).toBe(1);
    expect(after1.status).toBe("in_progress");
  });

  it("recordRetryAttempt transitions task to blocked when budget exhausted", async () => {
    const { service, publishRealtime } = createService();
    const task = await service.createTask({ title: "t", status: "in_progress" });
    await service.setRetryBudget(task.taskId, 1);
    await service.recordRetryAttempt(task.taskId, "first failure");
    const blocked = await service.recordRetryAttempt(task.taskId, "second failure");
    expect(blocked.status).toBe("blocked");
    expect(blocked.retryBudget?.retryCount).toBe(2);
    expect(blocked.retryBudget?.exhaustedAt).toBeTruthy();
    const exhaustedSignal = blocked.distressSignals?.find((s) => s.code === "retry_budget_exhausted");
    expect(exhaustedSignal?.severity).toBe("critical");
    const exhaustedEvent = publishRealtime.mock.calls.find((c) => c[0] === "task_retry_budget_exhausted");
    expect(exhaustedEvent).toBeTruthy();
    expect(exhaustedEvent?.[2]).toMatchObject({ taskId: task.taskId, retryCount: 2, reason: "second failure" });
  });

  it("recordRetryAttempt publishes task_retry_attempted event on non-exhausted path", async () => {
    const { service, publishRealtime } = createService();
    const task = await service.createTask({ title: "t", status: "in_progress" });
    await service.setRetryBudget(task.taskId, 3);
    await service.recordRetryAttempt(task.taskId, "transient");
    const call = publishRealtime.mock.calls.find((c) => c[0] === "task_retry_attempted");
    expect(call).toBeTruthy();
    expect(call?.[2]).toMatchObject({ taskId: task.taskId, retryCount: 1, reason: "transient" });
  });
});

describe("TaskLifecycleService.verifyTaskArtifacts", () => {
  it("records verification results and emits artifact_missing distress when any claim is missing", async () => {
    const { service, storage } = createService({
      probers: {
        fs: { statExists: async (p: string) => p !== "missing.txt" },
        http: { headOk: async () => true },
        git: { hasCommit: async () => true },
      },
    });
    const task = await service.createTask({ title: "t", status: "in_progress" });
    const updated = await service.verifyTaskArtifacts(task.taskId, [
      { kind: "file", value: "exists.txt" },
      { kind: "file", value: "missing.txt" },
    ]);
    const persisted = storage.tasks.get(task.taskId);
    expect(persisted.artifactVerification?.length).toBe(2);
    const missing = persisted.distressSignals?.find((s) => s.code === "artifact_missing");
    expect(missing).toBeTruthy();
    expect(missing?.severity).toBe("critical");
    expect(updated.status).toBe("blocked");
  });

  it("does not emit distress when all claims verify", async () => {
    const { service } = createService({
      probers: {
        fs: { statExists: async () => true },
        http: { headOk: async () => true },
        git: { hasCommit: async () => true },
      },
    });
    const task = await service.createTask({ title: "t", status: "in_progress" });
    const updated = await service.verifyTaskArtifacts(task.taskId, [{ kind: "file", value: "ok.txt" }]);
    expect(updated.status).toBe("in_progress");
    expect(updated.distressSignals?.find((s) => s.code === "artifact_missing")).toBeUndefined();
  });

  it("throws ValidationError when probers are not configured", async () => {
    const { service } = createService(); // no probers
    const task = await service.createTask({ title: "t" });
    await expect(service.verifyTaskArtifacts(task.taskId, [{ kind: "file", value: "x" }])).rejects.toThrow(
      /probers not configured/i,
    );
  });

  it("merges new verification results with prior ones", async () => {
    const { service, storage } = createService({
      probers: {
        fs: { statExists: async () => true },
        http: { headOk: async () => true },
        git: { hasCommit: async () => true },
        networkAllowlist: ["x"],
      },
    });
    const task = await service.createTask({ title: "t", status: "in_progress" });
    await service.verifyTaskArtifacts(task.taskId, [{ kind: "file", value: "a.txt" }]);
    await service.verifyTaskArtifacts(task.taskId, [{ kind: "url", value: "https://x" }]);
    const persisted = storage.tasks.get(task.taskId);
    expect(persisted.artifactVerification?.length).toBe(2);
  });

  it("loads task existence before probing claimed artifacts", async () => {
    const statExists = vi.fn(async () => true);
    const { service } = createService({
      probers: {
        fs: { statExists },
        http: { headOk: async () => true },
        git: { hasCommit: async () => true },
      },
    });

    await expect(service.verifyTaskArtifacts("missing-task", [{ kind: "file", value: "safe.txt" }])).rejects.toThrow(
      /Task missing-task not found/,
    );
    expect(statExists).not.toHaveBeenCalled();
  });

  it("checks workspace scope before probing claimed artifacts", async () => {
    const statExists = vi.fn(async () => true);
    const { service } = createService({
      probers: {
        fs: { statExists },
        http: { headOk: async () => true },
        git: { hasCommit: async () => true },
      },
    });
    const task = await service.createTask({
      workspaceId: "workspace-a",
      title: "Scoped task",
      status: "in_progress",
    });

    await expect(
      service.verifyTaskArtifacts(task.taskId, [{ kind: "file", value: "safe.txt" }], {
        workspaceId: "workspace-b",
      }),
    ).rejects.toThrow(/Task .* not found/);
    expect(statExists).not.toHaveBeenCalled();
  });

  it("does not overwrite distress written while artifact probing is in flight", async () => {
    const serviceRef: { current?: TaskLifecycleService } = {};
    let taskId = "";
    const { service } = createService({
      probers: {
        fs: {
          statExists: async () => {
            const current = await serviceRef.current!.getTask(taskId);
            await serviceRef.current!.emitDistressSignalWithRevision(
              taskId,
              {
                code: "needs_user",
                severity: "warn",
                title: "Concurrent operator signal",
                summary: "Preserve this during artifact verification",
              },
              current.revision,
            );
            return true;
          },
        },
        http: { headOk: async () => true },
        git: { hasCommit: async () => true },
      },
    });
    serviceRef.current = service;
    const task = await service.createTask({ title: "t", status: "in_progress" });
    taskId = task.taskId;

    await expect(
      service.verifyTaskArtifactsWithRevision(task.taskId, [{ kind: "file", value: "artifact.txt" }], task.revision),
    ).rejects.toThrow(ConflictError);
    const persisted = await service.getTask(task.taskId);
    expect(persisted.distressSignals).toEqual([expect.objectContaining({ title: "Concurrent operator signal" })]);
    expect(persisted.artifactVerification).toBeUndefined();
    expect(persisted.revision).toBe(task.revision + 1);
  });
});

describe("TaskLifecycleService.autoBlockOnIncompleteExit", () => {
  it("transitions an in-progress task to blocked and emits worker_crash distress", async () => {
    const recordAgenticDiagnosticSignal = vi.fn();
    const { service, publishRealtime } = createService({ recordAgenticDiagnosticSignal });
    const task = await service.createTask({
      title: "t",
      status: "in_progress",
      agenticContext: {
        runId: "run-xyz",
        durableRunId: "durable-run-xyz",
        surface: "cowork",
        status: "running",
      },
    });
    const blocked = await service.autoBlockOnIncompleteExit(task.taskId, "run-xyz");
    expect(blocked.status).toBe("blocked");
    expect(blocked.agenticContext).toMatchObject({
      runId: "run-xyz",
      status: "failed",
      failureClass: "crash",
      diagnostics: [
        expect.objectContaining({
          code: "worker_crash",
          evidenceRef: "durable-run:run-xyz",
        }),
      ],
    });
    const crash = blocked.distressSignals?.find((s) => s.code === "worker_crash");
    expect(crash?.severity).toBe("critical");
    expect(crash?.evidenceRef).toBe("durable-run:run-xyz");
    const event = publishRealtime.mock.calls.find((c) => c[0] === "task_auto_blocked");
    expect(event).toBeTruthy();
    expect(event?.[2]).toMatchObject({
      reason: "worker_incomplete_exit",
      diagnostic: expect.objectContaining({
        code: "worker_crash",
        evidenceRef: "durable-run:run-xyz",
      }),
    });
    expect(recordAgenticDiagnosticSignal).toHaveBeenCalledWith({
      task: expect.objectContaining({ taskId: task.taskId }),
      diagnostic: expect.objectContaining({ code: "worker_crash" }),
    });
  });

  it("is a no-op when task is already blocked", async () => {
    const { service } = createService();
    const task = await service.createTask({ title: "t", status: "blocked" });
    const result = await service.autoBlockOnIncompleteExit(task.taskId, "run-xyz");
    expect(result.status).toBe("blocked");
    expect(result.distressSignals?.length ?? 0).toBe(0);
  });

  it("is a no-op when task is done", async () => {
    const { service, storage } = createService();
    // Create + add a deliverable so we can mark done legitimately
    const task = await service.createTask({ title: "t", status: "in_progress" });
    storage.taskDeliverables.append(task.taskId, { deliverableType: "artifact", title: "out" });
    await service.updateTask(task.taskId, { status: "done" });
    const result = await service.autoBlockOnIncompleteExit(task.taskId, "run-xyz");
    expect(result.status).toBe("done");
  });
});

describe("TaskLifecycleService.bulkUpdateTasks", () => {
  it("unblock action moves blocked tasks to assigned and resets retry count + clears exhaustedAt", async () => {
    const { service } = createService();
    const a = await service.createTask({ title: "a", status: "blocked" });
    await service.setRetryBudget(a.taskId, 1);
    await service.recordRetryAttempt(a.taskId, "fail-1");
    await service.recordRetryAttempt(a.taskId, "fail-2"); // exhausted → already blocked
    const current = await service.getTask(a.taskId);
    const results = await service.bulkUpdateTasks({
      action: "unblock",
      taskIds: [a.taskId],
      expectedRevisionsByTaskId: { [a.taskId]: current.revision },
    });
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("assigned");
    expect(results[0].retryBudget?.retryCount).toBe(0);
    expect(results[0].retryBudget?.exhaustedAt).toBeUndefined();
  });

  it("retry action records a fresh attempt without status change when budget allows", async () => {
    const { service } = createService();
    const a = await service.createTask({ title: "a", status: "in_progress" });
    await service.setRetryBudget(a.taskId, 3);
    const current = await service.getTask(a.taskId);
    const results = await service.bulkUpdateTasks({
      action: "retry",
      taskIds: [a.taskId],
      reason: "operator",
      expectedRevisionsByTaskId: { [a.taskId]: current.revision },
    });
    expect(results[0].retryBudget?.retryCount).toBe(1);
    expect(results[0].status).toBe("in_progress");
  });

  it("reassign action sets the new assignedAgentId on each task and publishes task_updated", async () => {
    const { service, publishRealtime } = createService();
    const a = await service.createTask({ title: "a" });
    const b = await service.createTask({ title: "b" });
    const results = await service.bulkUpdateTasks({
      action: "reassign",
      taskIds: [a.taskId, b.taskId],
      assignedAgentId: "agent-9",
      expectedRevisionsByTaskId: { [a.taskId]: a.revision, [b.taskId]: b.revision },
    });
    expect(results[0].assignedAgentId).toBe("agent-9");
    expect(results[1].assignedAgentId).toBe("agent-9");
    const updateCalls = publishRealtime.mock.calls.filter((c) => c[0] === "task_updated");
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts current bulk revision guards", async () => {
    const { service } = createService();
    const a = await service.createTask({ title: "a" });

    const results = await service.bulkUpdateTasks({
      action: "reassign",
      taskIds: [a.taskId],
      assignedAgentId: "agent-current",
      expectedRevisionsByTaskId: {
        [a.taskId]: a.revision,
      },
    });

    expect(results[0]).toMatchObject({ taskId: a.taskId, assignedAgentId: "agent-current" });
  });

  it("rejects stale bulk revision guards before applying partial updates", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));
    const { service } = createService();
    const a = await service.createTask({ title: "a" });
    const b = await service.createTask({ title: "b" });

    vi.setSystemTime(new Date("2026-05-01T12:00:01.000Z"));
    await service.updateTask(b.taskId, { title: "b changed" });

    await expect(
      service.bulkUpdateTasks({
        action: "reassign",
        taskIds: [a.taskId, b.taskId],
        assignedAgentId: "agent-stale",
        expectedRevisionsByTaskId: {
          [a.taskId]: a.revision,
          [b.taskId]: b.revision,
        },
      }),
    ).rejects.toThrow(ConflictError);
    expect((await service.getTask(a.taskId)).assignedAgentId).toBeUndefined();
    vi.useRealTimers();
  });

  it("unblock action publishes task_updated so subscribers see the transition", async () => {
    const { service, publishRealtime } = createService();
    const a = await service.createTask({ title: "a", status: "blocked" });
    await service.bulkUpdateTasks({
      action: "unblock",
      taskIds: [a.taskId],
      expectedRevisionsByTaskId: { [a.taskId]: a.revision },
    });
    const updateCalls = publishRealtime.mock.calls.filter((c) => c[0] === "task_updated");
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("close action moves tasks to done when they have a deliverable", async () => {
    const { service, storage } = createService();
    const a = await service.createTask({ title: "a" });
    storage.taskDeliverables.append(a.taskId, { deliverableType: "artifact", title: "out" });
    const results = await service.bulkUpdateTasks({
      action: "close",
      taskIds: [a.taskId],
      expectedRevisionsByTaskId: { [a.taskId]: a.revision },
    });
    expect(results[0].status).toBe("done");
  });

  it("close action throws ValidationError when a task has no deliverable", async () => {
    const { service } = createService();
    const a = await service.createTask({ title: "a" });
    await expect(
      service.bulkUpdateTasks({
        action: "close",
        taskIds: [a.taskId],
        expectedRevisionsByTaskId: { [a.taskId]: a.revision },
      }),
    ).rejects.toThrow(/at least one deliverable/i);
  });
});

describe("TaskLifecycleService workspace access", () => {
  it("hides direct task reads and mutations when workspace expectations do not match", async () => {
    const { service } = createService();
    const task = await service.createTask({ workspaceId: "workspace-a", title: "Scoped task", status: "in_progress" });

    await expect(service.getTask(task.taskId, { workspaceId: "workspace-b" })).rejects.toThrow(/Task .* not found/);
    await expect(
      service.updateTask(task.taskId, { title: "wrong workspace" }, { workspaceId: "workspace-b" }),
    ).rejects.toThrow(/Task .* not found/);
    expect(
      await service.softDeleteTask(task.taskId, "operator", "wrong workspace", { workspaceId: "workspace-b" }),
    ).toBe(false);
    expect((await service.getTask(task.taskId, { workspaceId: "workspace-a" })).title).toBe("Scoped task");
  });

  it("applies bulk workspace checks before Kanban mutations", async () => {
    const { service } = createService();
    const task = await service.createTask({ workspaceId: "workspace-a", title: "Blocked task", status: "blocked" });

    await expect(
      service.bulkUpdateTasks(
        {
          action: "unblock",
          taskIds: [task.taskId],
          expectedRevisionsByTaskId: { [task.taskId]: task.revision },
        },
        { workspaceId: "workspace-b" },
      ),
    ).rejects.toThrow(/Task .* not found/);
    expect(
      (
        await service.bulkUpdateTasks(
          {
            action: "unblock",
            taskIds: [task.taskId],
            expectedRevisionsByTaskId: { [task.taskId]: task.revision },
          },
          { workspaceId: "workspace-a" },
        )
      )[0],
    ).toMatchObject({ taskId: task.taskId, status: "assigned" });
  });

  it("scopes agentic run tree and control endpoints to the requested workspace", async () => {
    const { service } = createService();
    await service.createTask({
      workspaceId: "default",
      title: "Default run",
      status: "in_progress",
      agenticContext: {
        runId: "run-default",
        status: "running",
        surface: "cowork",
      },
    });
    const task = await service.createTask({
      workspaceId: "workspace-a",
      title: "Scoped run",
      status: "in_progress",
      agenticContext: {
        runId: "run-workspace-a",
        status: "running",
        surface: "cowork",
      },
    });

    await expect(service.getAgenticRunTree("run-workspace-a", { workspaceId: "workspace-b" })).rejects.toThrow(
      /Agentic run not found/,
    );
    await expect(service.getAgenticRunTree("run-workspace-a")).rejects.toThrow(/Agentic run not found/);
    await expect(
      service.invokeAgenticControl("run-workspace-a", {
        action: "pause",
        actorId: "operator",
      }),
    ).rejects.toThrow(/Agentic run not found/);
    expect(await service.getAgenticRunTree("run-default")).toMatchObject({ runId: "run-default" });
    await expect(
      service.invokeAgenticControl(
        "run-workspace-a",
        {
          action: "pause",
          actorId: "operator",
        },
        { workspaceId: "workspace-b" },
      ),
    ).rejects.toThrow(/Agentic run not found/);
    expect(await service.getAgenticRunTree("run-workspace-a", { workspaceId: "workspace-a" })).toMatchObject({
      runId: "run-workspace-a",
    });
    expect(
      await service.invokeAgenticControl(
        "run-workspace-a",
        {
          action: "pause",
          actorId: "operator",
        },
        { workspaceId: "workspace-a" },
      ),
    ).toMatchObject({
      taskId: task.taskId,
      action: "pause",
    });
  });

  it("rejects kill_child controls for subagents outside the selected run", async () => {
    const { service, storage } = createService();
    const runA = await service.createTask({
      workspaceId: "workspace-a",
      title: "Run A",
      status: "in_progress",
      agenticContext: {
        runId: "run-a",
        status: "running",
        surface: "cowork",
      },
    });
    const runB = await service.createTask({
      workspaceId: "workspace-a",
      title: "Run B",
      status: "in_progress",
      agenticContext: {
        runId: "run-b",
        status: "running",
        surface: "cowork",
      },
    });
    await service.registerTaskSubagent(runB.taskId, {
      agentSessionId: "run-b-child",
      agentName: "analyst",
    });

    await expect(
      service.invokeAgenticControl(
        "run-a",
        {
          action: "kill_child",
          controlId: "wrong-run-child",
          agentSessionId: "run-b-child",
          actorId: "operator",
        },
        { workspaceId: "workspace-a" },
      ),
    ).rejects.toThrow(/Sub-agent session run-b-child not found/);
    expect(storage.taskSubagents.getByAgentSessionId("run-b-child").status).toBe("active");
    expect(
      storage.taskActivities.listByTask(runA.taskId).filter((activity) => activity.activityType === "control"),
    ).toHaveLength(0);
  });

  it("records kill_child intent for subagents attached to child tasks in the selected run tree", async () => {
    const { service, storage } = createService();
    await service.createTask({
      workspaceId: "workspace-a",
      title: "Root run",
      status: "in_progress",
      agenticContext: {
        runId: "run-root",
        status: "running",
        surface: "cowork",
        childRunIds: ["run-child"],
      },
    });
    const child = await service.createTask({
      workspaceId: "workspace-a",
      title: "Child run",
      status: "in_progress",
      agenticContext: {
        runId: "run-child",
        parentRunId: "run-root",
        status: "running",
        surface: "cowork",
      },
    });
    await service.registerTaskSubagent(child.taskId, {
      agentSessionId: "nested-child-agent",
      agentName: "analyst",
    });

    expect(
      await service.invokeAgenticControl(
        "run-root",
        {
          action: "kill_child",
          controlId: "kill-nested-child",
          agentSessionId: "nested-child-agent",
          actorId: "operator",
        },
        { workspaceId: "workspace-a" },
      ),
    ).toMatchObject({ action: "kill_child", status: "recorded" });
    expect(storage.taskSubagents.getByAgentSessionId("nested-child-agent").status).toBe("active");
  });
});
