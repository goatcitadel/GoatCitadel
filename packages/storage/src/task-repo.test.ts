import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { TaskRepository } from "./task-repo.js";
import { TaskActivityRepository } from "./task-activity-repo.js";
import { TaskDeliverableRepository } from "./task-deliverable-repo.js";
import { TaskSubagentRepository } from "./task-subagent-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore
    }
  }
});

function createRepos() {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-task-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return {
    tasks: new TaskRepository(db),
    activities: new TaskActivityRepository(db),
    deliverables: new TaskDeliverableRepository(db),
    subagents: new TaskSubagentRepository(db),
  };
}

describe("task repositories", () => {
  it("stores task workflow records", () => {
    const repos = createRepos();
    const task = repos.tasks.create({
      title: "Build event stream",
      priority: "high",
    });

    repos.activities.append(task.taskId, {
      activityType: "comment",
      message: "Started implementing SSE route",
      agentId: "agent-main",
    });
    repos.deliverables.append(task.taskId, {
      deliverableType: "file",
      title: "events.ts",
      path: "apps/gateway/src/routes/events.ts",
    });
    repos.subagents.create(task.taskId, {
      agentSessionId: "agent:main:subagent:test",
      agentName: "sse-agent",
    });
    repos.subagents.updateByAgentSessionId("agent:main:subagent:test", {
      status: "completed",
    });

    const updated = repos.tasks.update(task.taskId, { status: "review" });
    const listed = repos.tasks.list({ limit: 20 });
    const statusCounts = repos.tasks.statusCounts();
    const activities = repos.activities.listByTask(task.taskId);
    const deliverables = repos.deliverables.listByTask(task.taskId);
    const subagents = repos.subagents.listByTask(task.taskId);

    assert.equal(updated.status, "review");
    assert.equal(listed.length, 1);
    assert.equal(statusCounts.find((entry) => entry.status === "review")?.count, 1);
    assert.equal(activities.length, 1);
    assert.equal(deliverables.length, 1);
    assert.equal(subagents[0]?.status, "completed");
    assert.equal(repos.subagents.activeCount(), 0);
  });

  it("supports composite cursors and explicit assignment clearing", () => {
    const repos = createRepos();
    const timestamp = "2026-02-27T12:00:00.000Z";
    const first = repos.tasks.create({ title: "Task A", assignedAgentId: "architect" }, timestamp);
    repos.tasks.create({ title: "Task B" }, timestamp);
    repos.tasks.create({ title: "Task C" }, "2026-02-27T11:59:59.000Z");

    const firstPage = repos.tasks.list({ limit: 1 });
    const cursor = `${firstPage[0]!.updatedAt}|${firstPage[0]!.taskId}`;
    const secondPage = repos.tasks.list({ limit: 10, cursor });
    assert.equal(secondPage.length, 2);

    const cleared = repos.tasks.update(first.taskId, { assignedAgentId: null });
    assert.equal(cleared.assignedAgentId, undefined);
  });

  it("supports soft delete, trash view, restore, and hard delete", () => {
    const repos = createRepos();
    const task = repos.tasks.create({ title: "Delete flow test" });

    const softDeleted = repos.tasks.softDelete(task.taskId, "tester", "cleanup");
    assert.equal(softDeleted, true);

    const active = repos.tasks.list({ limit: 20, view: "active" });
    assert.equal(
      active.find((item) => item.taskId === task.taskId),
      undefined,
    );

    const trash = repos.tasks.list({ limit: 20, view: "trash" });
    assert.equal(trash.find((item) => item.taskId === task.taskId)?.deletedBy, "tester");

    const restored = repos.tasks.restore(task.taskId);
    assert.equal(restored, true);
    const restoredTask = repos.tasks.get(task.taskId);
    assert.equal(restoredTask.deletedAt, undefined);

    const hardDeleted = repos.tasks.hardDelete(task.taskId);
    assert.equal(hardDeleted, true);
    assert.equal(repos.tasks.find(task.taskId), undefined);
  });

  it("round-trips proactive task context and allows clearing it", () => {
    const repos = createRepos();
    const task = repos.tasks.create({
      title: "Drive proactive follow-up",
      proactiveContext: {
        sessionId: "sess-1",
        originSurface: "cowork",
        proactiveRunId: "run-1",
        durableRunId: "durable-1",
        approvalId: "approval-1",
        nextWakeAt: "2026-04-04T12:00:00.000Z",
        stopReason: "approval_block",
        externalReferenceRoots: [
          {
            label: "claude-code-reference",
            rootPath: "F:\\code\\claude-code",
            access: "read_only",
          },
        ],
      },
    });

    assert.equal(task.proactiveContext?.originSurface, "cowork");
    assert.deepEqual(task.proactiveContext?.externalReferenceRoots, [
      {
        label: "claude-code-reference",
        rootPath: "F:\\code\\claude-code",
        access: "read_only",
      },
    ]);

    const cleared = repos.tasks.update(task.taskId, { proactiveContext: null });
    assert.equal(cleared.proactiveContext, undefined);
  });

  it("round-trips agentic task context and subagent metadata", () => {
    const repos = createRepos();
    const task = repos.tasks.create({
      title: "Coordinate cowork run",
      status: "in_progress",
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

    assert.equal(task.agenticContext?.runId, "run-1");
    assert.equal(task.agenticContext?.workspaceScope?.kind, "session");

    const subagent = repos.subagents.create(task.taskId, {
      agentSessionId: "agent:main:subagent:researcher",
      agentName: "researcher",
      metadata: {
        runId: "run-1:researcher",
        parentRunId: "run-1",
        profileId: "researcher",
        contextMode: "isolated",
        heartbeatAt: "2026-05-05T12:00:00.000Z",
      },
    });
    assert.equal(subagent.metadata?.parentRunId, "run-1");

    const completed = repos.subagents.updateByAgentSessionId("agent:main:subagent:researcher", {
      status: "completed",
      metadata: {
        ...subagent.metadata,
        heartbeatAt: "2026-05-05T12:05:00.000Z",
        handoffEvidence: {
          summary: "Research complete",
          artifactRefs: ["delegation-step:researcher"],
          createdAt: "2026-05-05T12:05:00.000Z",
        },
      },
    });
    assert.equal(completed.metadata?.handoffEvidence?.summary, "Research complete");

    const patched = repos.tasks.update(task.taskId, {
      agenticContext: {
        ...task.agenticContext,
        status: "completed",
        handoffEvidence: [
          {
            summary: "Run complete",
            createdAt: "2026-05-05T12:06:00.000Z",
          },
        ],
      },
    });
    assert.equal(patched.agenticContext?.status, "completed");
    assert.equal(patched.agenticContext?.handoffEvidence?.[0]?.summary, "Run complete");

    const cleared = repos.tasks.update(task.taskId, { agenticContext: null });
    assert.equal(cleared.agenticContext, undefined);
  });
});
