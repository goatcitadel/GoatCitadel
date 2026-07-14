import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ConflictError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { TaskRepository } from "./task-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    for (const candidate of [file, `${file}-wal`, `${file}-shm`]) {
      fs.rmSync(candidate, { force: true });
    }
  }
});

function assertWriteConflict(
  action: () => unknown,
  expected: { resourceId: string; expectedRevision: number; currentRevision: number },
): void {
  assert.throws(action, (error: unknown) => {
    assert.ok(error instanceof ConflictError);
    assert.equal(error.code, "WRITE_CONFLICT");
    assert.deepEqual(error.details, {
      resourceKind: "task",
      resourceId: expected.resourceId,
      expectedRevision: expected.expectedRevision,
      currentRevision: expected.currentRevision,
    });
    return true;
  });
}

describe("task resource revision CAS", () => {
  it("fences stale two-client writes and does not bump semantic no-ops", () => {
    const dbPath = path.join(os.tmpdir(), `goatcitadel-task-cas-${randomUUID()}.db`);
    createdFiles.push(dbPath);
    let clientA: DatabaseClient | undefined;
    let clientB: DatabaseClient | undefined;
    try {
      clientA = createDatabase({ dbPath });
      clientB = createDatabase({ dbPath });
      const tasksA = new TaskRepository(clientA);
      const tasksB = new TaskRepository(clientB);
      const created = tasksA.create({ title: "Original", priority: "high" }, "2026-07-13T00:00:00.000Z");
      assert.equal(created.revision, 1);
      const stale = tasksB.get(created.taskId);

      const winner = tasksA.updateWithRevision(
        created.taskId,
        { title: "Operator winner", status: "in_progress" },
        created.revision,
        "2026-07-13T00:01:00.000Z",
      );
      assert.equal(winner.revision, 2);
      assert.equal(winner.title, "Operator winner");

      assertWriteConflict(
        () => tasksB.updateWithRevision(created.taskId, { title: "Stale overwrite" }, stale.revision),
        { resourceId: created.taskId, expectedRevision: 1, currentRevision: 2 },
      );
      const noOp = tasksB.updateWithRevision(
        created.taskId,
        { title: "Operator winner", status: "in_progress" },
        winner.revision,
      );
      assert.equal(noOp.revision, 2);

      assertWriteConflict(() => tasksB.softDeleteWithRevision(created.taskId, stale.revision), {
        resourceId: created.taskId,
        expectedRevision: 1,
        currentRevision: 2,
      });
      assert.equal(tasksA.softDeleteWithRevision(created.taskId, 2, "operator", "cleanup"), true);
      assert.equal(tasksA.get(created.taskId).revision, 3);
      assert.equal(tasksB.restoreWithRevision(created.taskId, 3), true);
      assert.equal(tasksB.get(created.taskId).revision, 4);
      assertWriteConflict(() => tasksA.hardDeleteWithRevision(created.taskId, 3), {
        resourceId: created.taskId,
        expectedRevision: 3,
        currentRevision: 4,
      });
      assert.equal(tasksA.hardDeleteWithRevision(created.taskId, 4), true);
      assert.equal(tasksB.find(created.taskId), undefined);
    } finally {
      clientB?.close();
      clientA?.close();
    }
  });
});
