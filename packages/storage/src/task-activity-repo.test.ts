import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { createDatabase } from "./sqlite.js";
import { TaskActivityRepository } from "./task-activity-repo.js";
import { TaskRepository } from "./task-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // Ignore best-effort temp database cleanup failures.
    }
  }
});

function createRepos() {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-task-activity-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return {
    activities: new TaskActivityRepository(db),
    tasks: new TaskRepository(db),
  };
}

describe("TaskActivityRepository", () => {
  it("returns the original row for an exact replay even when the replay timestamp differs", () => {
    const { activities, tasks } = createRepos();
    const task = tasks.create({ title: "Idempotent activity" });
    const input = {
      activityType: "control" as const,
      agentId: "operator",
      message: "Pause requested",
      metadata: { controlId: "control-1", nested: { reason: "operator request" } },
    };

    const first = activities.appendOnce("activity-stable", task.taskId, input, "2026-07-11T00:00:00.000Z");
    const replay = activities.appendOnce(
      "activity-stable",
      task.taskId,
      { ...input, metadata: { nested: { reason: "operator request" }, controlId: "control-1" } },
      "2026-07-11T00:10:00.000Z",
    );

    assert.equal(first.created, true);
    assert.equal(replay.created, false);
    assert.deepEqual(replay.activity, first.activity);
    assert.equal(replay.activity.createdAt, "2026-07-11T00:00:00.000Z");
  });

  it("fails closed when an existing activity id is replayed with conflicting payload or task ownership", () => {
    const { activities, tasks } = createRepos();
    const firstTask = tasks.create({ title: "First activity owner" });
    const secondTask = tasks.create({ title: "Second activity owner" });
    const input = {
      activityType: "control" as const,
      agentId: "operator",
      message: "Cancel requested",
      metadata: { controlId: "control-2", reason: "operator request" },
    };
    activities.appendOnce("activity-conflict", firstTask.taskId, input, "2026-07-11T00:00:00.000Z");

    const conflicts = [
      { taskId: secondTask.taskId, input },
      { taskId: firstTask.taskId, input: { ...input, agentId: "other-operator" } },
      { taskId: firstTask.taskId, input: { ...input, activityType: "comment" as const } },
      { taskId: firstTask.taskId, input: { ...input, message: "Retry requested" } },
      { taskId: firstTask.taskId, input: { ...input, metadata: { ...input.metadata, reason: "different" } } },
    ];

    for (const conflict of conflicts) {
      assert.throws(
        () => activities.appendOnce("activity-conflict", conflict.taskId, conflict.input, "2026-07-11T00:10:00.000Z"),
        /activity-conflict.*conflicting payload/i,
      );
    }

    assert.equal(activities.listByTask(firstTask.taskId).length, 1);
    assert.equal(activities.listByTask(secondTask.taskId).length, 0);
  });
});
