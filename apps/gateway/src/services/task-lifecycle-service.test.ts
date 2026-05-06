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
  });

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
  });
});
