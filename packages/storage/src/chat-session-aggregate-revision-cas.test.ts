import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ConflictError } from "@goatcitadel/contracts";
import type { DatabaseClient } from "./db.js";
import { Storage } from "./index.js";
import { createDatabase } from "./sqlite.js";

const createdRoots: string[] = [];

afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    fs.rmSync(root, { force: true, recursive: true });
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
      resourceKind: "chat_session",
      resourceId: expected.resourceId,
      expectedRevision: expected.expectedRevision,
      currentRevision: expected.currentRevision,
    });
    return true;
  });
}

function createStorage(root: string, client: DatabaseClient, name: string): Storage {
  return new Storage({
    db: client,
    transcriptsDir: path.join(root, name, "transcripts"),
    auditDir: path.join(root, name, "audit"),
  });
}

describe("Chat session aggregate revision CAS", () => {
  it("fences stale writers across meta, prefs, project, autonomy, and hard delete", () => {
    const root = path.join(os.tmpdir(), `goatcitadel-session-cas-${randomUUID()}`);
    const dbPath = path.join(root, "shared.db");
    createdRoots.push(root);
    fs.mkdirSync(root, { recursive: true });
    let storageA: Storage | undefined;
    let storageB: Storage | undefined;
    try {
      storageA = createStorage(root, createDatabase({ dbPath }), "a");
      storageB = createStorage(root, createDatabase({ dbPath }), "b");
      const sessionId = `session-${randomUUID()}`;
      const createdAt = "2026-07-12T00:00:00.000Z";
      storageA.sessions.upsert({
        sessionId,
        sessionKey: `mission:local:${sessionId}`,
        kind: "thread",
        channel: "mission",
        account: "local",
        timestamp: createdAt,
      });
      const initialA = storageA.chatSessionMeta.ensure(sessionId, createdAt, "default");
      const initialB = storageB.chatSessionMeta.get(sessionId);
      assert.equal(initialA.revision, 1);
      assert.equal(initialB?.revision, 1);

      const metaWinner = storageA.chatSessionMeta.patchWithRevision(
        sessionId,
        { title: "Winner title" },
        1,
        "2026-07-12T00:01:00.000Z",
      );
      assert.equal(metaWinner.revision, 2);
      assertWriteConflict(
        () => storageB?.chatSessionPrefs.patchWithRevision(sessionId, { planningMode: "advisory" }, 1),
        { resourceId: sessionId, expectedRevision: 1, currentRevision: 2 },
      );
      assert.equal(
        storageA.chatSessionPrefs.get(sessionId),
        undefined,
        "stale prefs CAS must fail before defaults are written",
      );

      const prefsWinner = storageA.chatSessionPrefs.patchWithRevision(
        sessionId,
        { planningMode: "advisory" },
        2,
        "2026-07-12T00:02:00.000Z",
      );
      assert.equal(prefsWinner.revision, 3);
      assert.equal(storageB.chatSessionPrefs.get(sessionId)?.revision, 3);
      assert.equal(
        storageB.chatSessionPrefs.patchWithRevision(sessionId, { planningMode: "advisory" }, 3).revision,
        3,
        "semantic prefs no-op must validate the fence without bumping",
      );

      const workspace = storageA.workspaces.create({ name: "Session CAS" }, "2026-07-12T00:03:00.000Z");
      const project = storageA.chatProjects.create(
        { workspaceId: workspace.workspaceId, name: "CAS Project", workspacePath: "repo" },
        "2026-07-12T00:03:00.000Z",
      );
      assertWriteConflict(() => storageB?.chatSessionProjects.assignWithRevision(sessionId, project.projectId, 2), {
        resourceId: sessionId,
        expectedRevision: 2,
        currentRevision: 3,
      });
      assert.equal(storageA.chatSessionProjects.get(sessionId), undefined);
      const assignment = storageA.chatSessionProjects.assignWithRevision(
        sessionId,
        project.projectId,
        3,
        "2026-07-12T00:04:00.000Z",
      );
      assert.equal(assignment.revision, 4);
      assert.equal(storageB.chatSessionProjects.get(sessionId)?.revision, 4);
      assert.equal(
        storageB.chatSessionProjects.assignWithRevision(sessionId, project.projectId, 4).revision,
        4,
        "same-project assignment must not bump",
      );

      const goal = storageA.chatSessionMeta.patchWithRevision(
        sessionId,
        {
          pinnedGoal: "Preserve the runtime counter",
          goalTurnBudget: 8,
          goalSetAt: "2026-07-12T00:05:00.000Z",
        },
        4,
        "2026-07-12T00:05:00.000Z",
      );
      assert.equal(goal.revision, 5);
      assert.equal(storageB.chatSessionMeta.incrementGoalTurnsUsed(sessionId, "2026-07-12T00:06:00.000Z"), 1);
      assert.equal(
        storageA.chatSessionMeta.get(sessionId)?.revision,
        5,
        "runtime goal telemetry must not bump revision",
      );

      const operatorPatch = storageA.chatSessionMeta.patchWithRevision(
        sessionId,
        { title: "Operator update after runtime turn" },
        5,
        "2026-07-12T00:07:00.000Z",
      );
      assert.equal(operatorPatch.revision, 6);
      assert.equal(operatorPatch.goalTurnsUsed, 1, "operator patch must preserve the latest runtime counter");
      assert.equal(
        storageB.chatSessionMeta.patchWithRevision(sessionId, { title: "Operator update after runtime turn" }, 6)
          .revision,
        6,
        "semantic meta no-op must validate without bumping",
      );
      assertWriteConflict(
        () =>
          storageB?.chatSessionMeta.patchWithRevision(
            sessionId,
            { pinnedGoal: null, goalTurnBudget: null, goalSetAt: null },
            5,
          ),
        { resourceId: sessionId, expectedRevision: 5, currentRevision: 6 },
      );
      assert.equal(storageA.chatSessionMeta.get(sessionId)?.pinnedGoal, "Preserve the runtime counter");

      const autonomy = storageA.sessionAutonomyPrefs.patchWithRevision(
        sessionId,
        { reflectionMode: "on" },
        6,
        "2026-07-12T00:08:00.000Z",
      );
      assert.equal(autonomy.revision, 7);
      const touched = storageB.sessionAutonomyPrefs.touch(sessionId, "proactive-run-1", "2026-07-12T00:09:00.000Z");
      assert.equal(touched.revision, 7, "runtime proactive telemetry must not bump revision");
      assert.equal(touched.lastProactiveRunId, "proactive-run-1");
      assert.equal(
        storageA.sessionAutonomyPrefs.patchWithRevision(sessionId, { reflectionMode: "on" }, 7).revision,
        7,
        "semantic autonomy no-op must validate without bumping",
      );

      assertWriteConflict(() => storageB?.deleteChatSessionDataWithRevision(sessionId, 6), {
        resourceId: sessionId,
        expectedRevision: 6,
        currentRevision: 7,
      });
      assert.equal(storageA.chatSessionMeta.get(sessionId)?.revision, 7, "stale delete must have no side effects");
      const deleted = storageA.deleteChatSessionDataWithRevision(sessionId, 7);
      assert.equal(deleted.deleted, true);
      assert.equal(storageB.chatSessionMeta.get(sessionId), undefined);
    } finally {
      storageB?.close();
      storageA?.close();
    }
  });
});
