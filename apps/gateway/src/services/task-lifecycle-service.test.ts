import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Storage } from "@goatcitadel/storage";
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
  const publishRealtime = vi.fn();
  const service = new TaskLifecycleService({ storage, publishRealtime, ...overrides });
  return { service, storage, publishRealtime };
}

describe("TaskLifecycleService agentic runtime", () => {
  it("lists durable agentic runs, builds run trees, records diagnostics, and applies controls", () => {
    const { service, storage, publishRealtime } = createService();
    const task = service.createTask({
      workspaceId: "default",
      title: "Delegation: map launch plan",
      description: "Map the launch plan with child agents.",
      status: "in_progress",
      priority: "normal",
      agenticContext: {
        boardId: "cowork:default",
        runId: "run-1",
        childRunIds: ["run-1:researcher"],
        parentSessionId: "sess-1",
        surface: "cowork",
        status: "running",
        contextMode: "fork",
        workspaceScope: { kind: "session" },
        maxSpawn: 4,
      },
    });
    service.registerTaskSubagent(task.taskId, {
      agentSessionId: "child-session-1",
      agentName: "researcher",
      metadata: {
        runId: "run-1:researcher",
        parentRunId: "run-1",
        profileId: "researcher",
        contextMode: "isolated",
        heartbeatAt: "2020-01-01T12:00:00.000Z",
        timeoutAt: "2020-01-01T12:30:00.000Z",
      },
    });
    service.appendTaskDeliverable(task.taskId, {
      deliverableType: "artifact",
      title: "Research handoff",
      description: "Source-backed handoff",
    });
    service.appendTaskDiagnostic(task.taskId, {
      code: "final_delivery_retry",
      severity: "warning",
      title: "Final delivery retry queued",
      summary: "The channel final response needs retry.",
    });

    const runs = service.listAgenticRuns({ surface: "cowork" });
    expect(runs.items).toHaveLength(1);
    expect(runs.items[0]).toMatchObject({
      taskId: task.taskId,
      runId: "run-1",
      boardId: "cowork:default",
      status: "running",
      surface: "cowork",
    });

    const tree = service.getAgenticRunTree("run-1");
    expect(tree.nodes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "run:run-1", kind: "run" }),
        expect.objectContaining({ id: `task:${task.taskId}`, kind: "task" }),
        expect.objectContaining({ id: "subagent:child-session-1", kind: "subagent" }),
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
    expect(tree.controls.find((control) => control.action === "pause")?.runtimeEffect).toBe("state_only");

    const control = service.invokeAgenticControl("run-1", {
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
    expect(storage.taskSubagents.getByAgentSessionId("child-session-1").status).toBe("killed");
    const replay = service.invokeAgenticControl("run-1", {
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
        links: expect.objectContaining({ runId: "run-1" }),
      }),
    );
  });

  it("rejects unsafe terminal-state controls with a visible diagnostic", () => {
    const { service, storage } = createService();
    const task = service.createTask({
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

    const response = service.invokeAgenticControl("run-terminal", {
      action: "pause",
      controlId: "pause-terminal",
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
    const replay = service.invokeAgenticControl("run-terminal", {
      action: "pause",
      controlId: "pause-terminal",
      actorId: "operator",
    });
    expect(replay).toMatchObject({ status: "rejected", idempotentReplay: true });
  });

  it("applies pause through the attached durable run when one is available", () => {
    const pauseDurableRun = vi.fn(() => ({ status: "paused" }));
    const { service, storage } = createService({ pauseDurableRun });
    const task = service.createTask({
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

    const tree = service.getAgenticRunTree("agentic-run-1");
    expect(tree.controls.find((control) => control.action === "pause")).toMatchObject({
      label: "Pause durable run",
      runtimeEffect: "runtime_pause",
    });

    const result = service.invokeAgenticControl("agentic-run-1", {
      action: "pause",
      controlId: "pause-durable-once",
      actorId: "operator",
    });
    expect(pauseDurableRun).toHaveBeenCalledWith("durable-run-1", "operator");
    expect(result).toMatchObject({
      taskId: task.taskId,
      controlId: "pause-durable-once",
      status: "applied",
      runtimeEffect: "runtime_pause",
    });
    const replay = service.invokeAgenticControl("agentic-run-1", {
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
    expect(storage.tasks.get(task.taskId).agenticContext?.status).toBe("paused");
  });

  it("bridges explicit diagnostics to the improvement ledger without blocking task truth", () => {
    const bridge = vi.fn();
    const { service } = createService({ recordAgenticDiagnosticSignal: bridge });
    const task = service.createTask({
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

    const diagnostic = service.appendTaskDiagnostic(task.taskId, {
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
    const secondTask = serviceWithFailingBridge.createTask({
      title: "Bridge failure still records",
      status: "in_progress",
      priority: "normal",
    });
    expect(() =>
      serviceWithFailingBridge.appendTaskDiagnostic(secondTask.taskId, {
        code: "worker_crash",
        severity: "critical",
        title: "Worker crashed",
        summary: "The worker process crashed.",
      }),
    ).not.toThrow();
    expect(
      serviceWithFailingBridge
        .listTaskActivities(secondTask.taskId)
        .some((activity) => activity.metadata?.code === "agentic_diagnostic_mirror_failed"),
    ).toBe(true);
  }, 15_000);

  it("paginates agentic-filtered runs with a cursor from returned records", () => {
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

    const firstPage = service.listAgenticRuns({ surface: "cowork", limit: 2 });
    expect(firstPage.items.map((item) => item.runId)).toEqual(["run-newest", "run-second"]);
    expect(firstPage.nextCursor).toBe(`${firstPage.items[1]!.updatedAt}|${firstPage.items[1]!.taskId}`);

    const secondPage = service.listAgenticRuns({ surface: "cowork", limit: 2, cursor: firstPage.nextCursor });
    expect(secondPage.items.map((item) => item.runId)).toEqual(["run-oldest"]);
    expect(secondPage.nextCursor).toBeUndefined();
  });

  it("builds run trees for agentic runs beyond the first active task page", () => {
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

    const tree = service.getAgenticRunTree("run-after-first-page");
    expect(tree.nodes).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "run:run-after-first-page", taskId: olderRun.taskId })]),
    );
    expect(service.invokeAgenticControl("run-after-first-page", { action: "pause" })).toMatchObject({
      taskId: olderRun.taskId,
      status: "recorded",
    });
  }, 20_000);
});

describe("TaskLifecycleService — distress signals", () => {
  it("emitDistressSignal persists the new signal and publishes a realtime event", () => {
    const { service, storage, publishRealtime } = createService();
    const task = service.createTask({ title: "t" });
    const updated = service.emitDistressSignal(task.taskId, {
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

  it("resolveDistressSignal marks it resolved", () => {
    const { service } = createService();
    const task = service.createTask({ title: "t" });
    const withSignal = service.emitDistressSignal(task.taskId, {
      code: "tool_error",
      severity: "warn",
      title: "Tool blew up",
      summary: "boom",
    });
    const signalId = withSignal.distressSignals![0].signalId;
    const resolved = service.resolveDistressSignal(task.taskId, signalId, { resolvedBy: "op-1" });
    expect(resolved.distressSignals![0].resolvedAt).toBeTruthy();
    expect(resolved.distressSignals![0].resolvedBy).toBe("op-1");
  });

  it("resolveDistressSignal throws when signalId does not exist", () => {
    const { service } = createService();
    const task = service.createTask({ title: "t" });
    expect(() => service.resolveDistressSignal(task.taskId, "ds-nonexistent", { resolvedBy: "op" })).toThrow(
      /No unresolved distress signal/,
    );
  });
});

describe("TaskLifecycleService — retry budget", () => {
  it("setRetryBudget initializes the budget when none exists", () => {
    const { service } = createService();
    const task = service.createTask({ title: "t" });
    const updated = service.setRetryBudget(task.taskId, 3);
    expect(updated.retryBudget?.maxRetries).toBe(3);
    expect(updated.retryBudget?.retryCount).toBe(0);
  });

  it("recordRetryAttempt increments retryCount but stays in progress when below budget", () => {
    const { service } = createService();
    const task = service.createTask({ title: "t", status: "in_progress" });
    service.setRetryBudget(task.taskId, 2);
    const after1 = service.recordRetryAttempt(task.taskId, "transient_error");
    expect(after1.retryBudget?.retryCount).toBe(1);
    expect(after1.status).toBe("in_progress");
  });

  it("recordRetryAttempt transitions task to blocked when budget exhausted", () => {
    const { service, publishRealtime } = createService();
    const task = service.createTask({ title: "t", status: "in_progress" });
    service.setRetryBudget(task.taskId, 1);
    service.recordRetryAttempt(task.taskId, "first failure");
    const blocked = service.recordRetryAttempt(task.taskId, "second failure");
    expect(blocked.status).toBe("blocked");
    expect(blocked.retryBudget?.retryCount).toBe(2);
    expect(blocked.retryBudget?.exhaustedAt).toBeTruthy();
    const exhaustedSignal = blocked.distressSignals?.find((s) => s.code === "retry_budget_exhausted");
    expect(exhaustedSignal?.severity).toBe("critical");
    const exhaustedEvent = publishRealtime.mock.calls.find((c) => c[0] === "task_retry_budget_exhausted");
    expect(exhaustedEvent).toBeTruthy();
    expect(exhaustedEvent?.[2]).toMatchObject({ taskId: task.taskId, retryCount: 2, reason: "second failure" });
  });

  it("recordRetryAttempt publishes task_retry_attempted event on non-exhausted path", () => {
    const { service, publishRealtime } = createService();
    const task = service.createTask({ title: "t", status: "in_progress" });
    service.setRetryBudget(task.taskId, 3);
    service.recordRetryAttempt(task.taskId, "transient");
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
    const task = service.createTask({ title: "t", status: "in_progress" });
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
    const task = service.createTask({ title: "t", status: "in_progress" });
    const updated = await service.verifyTaskArtifacts(task.taskId, [{ kind: "file", value: "ok.txt" }]);
    expect(updated.status).toBe("in_progress");
    expect(updated.distressSignals?.find((s) => s.code === "artifact_missing")).toBeUndefined();
  });

  it("throws ValidationError when probers are not configured", async () => {
    const { service } = createService(); // no probers
    const task = service.createTask({ title: "t" });
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
    const task = service.createTask({ title: "t", status: "in_progress" });
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
    const task = service.createTask({ workspaceId: "workspace-a", title: "Scoped task", status: "in_progress" });

    await expect(
      service.verifyTaskArtifacts(task.taskId, [{ kind: "file", value: "safe.txt" }], {
        workspaceId: "workspace-b",
      }),
    ).rejects.toThrow(/Task .* not found/);
    expect(statExists).not.toHaveBeenCalled();
  });
});

describe("TaskLifecycleService.autoBlockOnIncompleteExit", () => {
  it("transitions an in-progress task to blocked and emits worker_crash distress", () => {
    const { service, publishRealtime } = createService();
    const task = service.createTask({ title: "t", status: "in_progress" });
    const blocked = service.autoBlockOnIncompleteExit(task.taskId, "run-xyz");
    expect(blocked.status).toBe("blocked");
    const crash = blocked.distressSignals?.find((s) => s.code === "worker_crash");
    expect(crash?.severity).toBe("critical");
    expect(crash?.evidenceRef).toBe("durable-run:run-xyz");
    const event = publishRealtime.mock.calls.find((c) => c[0] === "task_auto_blocked");
    expect(event).toBeTruthy();
  });

  it("is a no-op when task is already blocked", () => {
    const { service } = createService();
    const task = service.createTask({ title: "t", status: "blocked" });
    const result = service.autoBlockOnIncompleteExit(task.taskId, "run-xyz");
    expect(result.status).toBe("blocked");
    expect(result.distressSignals?.length ?? 0).toBe(0);
  });

  it("is a no-op when task is done", () => {
    const { service, storage } = createService();
    // Create + add a deliverable so we can mark done legitimately
    const task = service.createTask({ title: "t", status: "in_progress" });
    storage.taskDeliverables.append(task.taskId, { deliverableType: "artifact", title: "out" });
    service.updateTask(task.taskId, { status: "done" });
    const result = service.autoBlockOnIncompleteExit(task.taskId, "run-xyz");
    expect(result.status).toBe("done");
  });
});

describe("TaskLifecycleService.bulkUpdateTasks", () => {
  it("unblock action moves blocked tasks to assigned and resets retry count + clears exhaustedAt", () => {
    const { service } = createService();
    const a = service.createTask({ title: "a", status: "blocked" });
    service.setRetryBudget(a.taskId, 1);
    service.recordRetryAttempt(a.taskId, "fail-1");
    service.recordRetryAttempt(a.taskId, "fail-2"); // exhausted → already blocked
    const results = service.bulkUpdateTasks({ action: "unblock", taskIds: [a.taskId] });
    expect(results.length).toBe(1);
    expect(results[0].status).toBe("assigned");
    expect(results[0].retryBudget?.retryCount).toBe(0);
    expect(results[0].retryBudget?.exhaustedAt).toBeUndefined();
  });

  it("retry action records a fresh attempt without status change when budget allows", () => {
    const { service } = createService();
    const a = service.createTask({ title: "a", status: "in_progress" });
    service.setRetryBudget(a.taskId, 3);
    const results = service.bulkUpdateTasks({ action: "retry", taskIds: [a.taskId], reason: "operator" });
    expect(results[0].retryBudget?.retryCount).toBe(1);
    expect(results[0].status).toBe("in_progress");
  });

  it("reassign action sets the new assignedAgentId on each task and publishes task_updated", () => {
    const { service, publishRealtime } = createService();
    const a = service.createTask({ title: "a" });
    const b = service.createTask({ title: "b" });
    const results = service.bulkUpdateTasks({
      action: "reassign",
      taskIds: [a.taskId, b.taskId],
      assignedAgentId: "agent-9",
    });
    expect(results[0].assignedAgentId).toBe("agent-9");
    expect(results[1].assignedAgentId).toBe("agent-9");
    const updateCalls = publishRealtime.mock.calls.filter((c) => c[0] === "task_updated");
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);
  });

  it("unblock action publishes task_updated so subscribers see the transition", () => {
    const { service, publishRealtime } = createService();
    const a = service.createTask({ title: "a", status: "blocked" });
    service.bulkUpdateTasks({ action: "unblock", taskIds: [a.taskId] });
    const updateCalls = publishRealtime.mock.calls.filter((c) => c[0] === "task_updated");
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("close action moves tasks to done when they have a deliverable", () => {
    const { service, storage } = createService();
    const a = service.createTask({ title: "a" });
    storage.taskDeliverables.append(a.taskId, { deliverableType: "artifact", title: "out" });
    const results = service.bulkUpdateTasks({ action: "close", taskIds: [a.taskId] });
    expect(results[0].status).toBe("done");
  });

  it("close action throws ValidationError when a task has no deliverable", () => {
    const { service } = createService();
    const a = service.createTask({ title: "a" });
    expect(() => service.bulkUpdateTasks({ action: "close", taskIds: [a.taskId] })).toThrow(
      /at least one deliverable/i,
    );
  });
});

describe("TaskLifecycleService workspace access", () => {
  it("hides direct task reads and mutations when workspace expectations do not match", () => {
    const { service } = createService();
    const task = service.createTask({ workspaceId: "workspace-a", title: "Scoped task", status: "in_progress" });

    expect(() => service.getTask(task.taskId, { workspaceId: "workspace-b" })).toThrow(/Task .* not found/);
    expect(() => service.updateTask(task.taskId, { title: "wrong workspace" }, { workspaceId: "workspace-b" })).toThrow(
      /Task .* not found/,
    );
    expect(service.softDeleteTask(task.taskId, "operator", "wrong workspace", { workspaceId: "workspace-b" })).toBe(
      false,
    );
    expect(service.getTask(task.taskId, { workspaceId: "workspace-a" }).title).toBe("Scoped task");
  });

  it("applies bulk workspace checks before Kanban mutations", () => {
    const { service } = createService();
    const task = service.createTask({ workspaceId: "workspace-a", title: "Blocked task", status: "blocked" });

    expect(() =>
      service.bulkUpdateTasks({ action: "unblock", taskIds: [task.taskId] }, { workspaceId: "workspace-b" }),
    ).toThrow(/Task .* not found/);
    expect(
      service.bulkUpdateTasks({ action: "unblock", taskIds: [task.taskId] }, { workspaceId: "workspace-a" })[0],
    ).toMatchObject({ taskId: task.taskId, status: "assigned" });
  });

  it("scopes agentic run tree and control endpoints to the requested workspace", () => {
    const { service } = createService();
    const task = service.createTask({
      workspaceId: "workspace-a",
      title: "Scoped run",
      status: "in_progress",
      agenticContext: {
        runId: "run-workspace-a",
        status: "running",
        surface: "cowork",
      },
    });

    expect(() => service.getAgenticRunTree("run-workspace-a", { workspaceId: "workspace-b" })).toThrow(
      /Agentic run not found/,
    );
    expect(() =>
      service.invokeAgenticControl(
        "run-workspace-a",
        {
          action: "pause",
          actorId: "operator",
        },
        { workspaceId: "workspace-b" },
      ),
    ).toThrow(/Agentic run not found/);
    expect(service.getAgenticRunTree("run-workspace-a", { workspaceId: "workspace-a" })).toMatchObject({
      runId: "run-workspace-a",
    });
    expect(
      service.invokeAgenticControl(
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

  it("rejects kill_child controls for subagents outside the selected run", () => {
    const { service, storage } = createService();
    const runA = service.createTask({
      workspaceId: "workspace-a",
      title: "Run A",
      status: "in_progress",
      agenticContext: {
        runId: "run-a",
        status: "running",
        surface: "cowork",
      },
    });
    const runB = service.createTask({
      workspaceId: "workspace-a",
      title: "Run B",
      status: "in_progress",
      agenticContext: {
        runId: "run-b",
        status: "running",
        surface: "cowork",
      },
    });
    service.registerTaskSubagent(runB.taskId, {
      agentSessionId: "run-b-child",
      agentName: "analyst",
    });

    expect(() =>
      service.invokeAgenticControl("run-a", {
        action: "kill_child",
        controlId: "wrong-run-child",
        agentSessionId: "run-b-child",
        actorId: "operator",
      }),
    ).toThrow(/Sub-agent session run-b-child not found/);
    expect(storage.taskSubagents.getByAgentSessionId("run-b-child").status).toBe("active");
    expect(
      storage.taskActivities.listByTask(runA.taskId).filter((activity) => activity.activityType === "control"),
    ).toHaveLength(0);
  });
});
