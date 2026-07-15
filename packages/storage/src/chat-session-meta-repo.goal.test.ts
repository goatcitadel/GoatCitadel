import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import type { DatabaseClient } from "./db.js";
import { createDatabase } from "./sqlite.js";
import { ChatSessionMetaRepository } from "./chat-session-meta-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup noise
    }
  }
});

function newRepo(): { db: DatabaseClient; repo: ChatSessionMetaRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-chat-meta-goal-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new ChatSessionMetaRepository(db) };
}

describe("ChatSessionMetaRepository goal slot", () => {
  let repo: ChatSessionMetaRepository;

  beforeEach(() => {
    repo = newRepo().repo;
  });

  it("ensures default goal fields are absent on a fresh session", () => {
    const record = repo.ensure("s-1", undefined, "default");
    assert.equal(record.pinnedGoal, undefined);
    assert.equal(record.goalTurnBudget, undefined);
    assert.equal(record.goalTurnsUsed, 0);
    assert.equal(record.goalSetAt, undefined);
  });

  it("persists pinnedGoal + budget on patch and resets goalTurnsUsed", () => {
    repo.ensure("s-2", undefined, "default");
    const patched = repo.patch("s-2", {
      pinnedGoal: "ship kanban",
      goalTurnBudget: 12,
      goalSetAt: "2026-05-15T10:00:00Z",
    });
    assert.equal(patched.pinnedGoal, "ship kanban");
    assert.equal(patched.goalTurnBudget, 12);
    assert.equal(patched.goalTurnsUsed, 0);
    assert.equal(patched.goalSetAt, "2026-05-15T10:00:00Z");
  });

  it("increments goalTurnsUsed independently of patch", () => {
    repo.ensure("s-3", undefined, "default");
    repo.patch("s-3", {
      pinnedGoal: "ship kanban",
      goalTurnBudget: 3,
      goalSetAt: "2026-05-15T10:00:00Z",
    });
    assert.equal(repo.incrementGoalTurnsUsed("s-3"), 1);
    assert.equal(repo.incrementGoalTurnsUsed("s-3"), 2);
    const reloaded = repo.get("s-3");
    assert.ok(reloaded);
    assert.equal(reloaded.goalTurnsUsed, 2);
  });

  it("clears the goal via patch with explicit null", () => {
    repo.ensure("s-4", undefined, "default");
    repo.patch("s-4", {
      pinnedGoal: "x",
      goalTurnBudget: 5,
      goalSetAt: "2026-05-15T10:00:00Z",
    });
    repo.incrementGoalTurnsUsed("s-4");
    const cleared = repo.patch("s-4", {
      pinnedGoal: null,
      goalTurnBudget: null,
      goalSetAt: null,
    });
    assert.equal(cleared.pinnedGoal, undefined);
    assert.equal(cleared.goalTurnBudget, undefined);
    assert.equal(cleared.goalSetAt, undefined);
    assert.equal(cleared.goalTurnsUsed, 0);
  });

  it("does not clobber other fields when incrementing goal turns used", () => {
    repo.ensure("s-5", undefined, "default");
    repo.patch("s-5", {
      title: "Important session",
      pinnedGoal: "ship kanban",
      goalTurnBudget: 4,
      goalSetAt: "2026-05-15T10:00:00Z",
      tags: ["alpha"],
    });
    repo.incrementGoalTurnsUsed("s-5");
    const reloaded = repo.get("s-5");
    assert.ok(reloaded);
    assert.equal(reloaded.title, "Important session");
    assert.equal(reloaded.pinnedGoal, "ship kanban");
    assert.equal(reloaded.goalTurnBudget, 4);
    assert.equal(reloaded.goalSetAt, "2026-05-15T10:00:00Z");
    assert.equal(reloaded.goalTurnsUsed, 1);
    assert.deepEqual(reloaded.tags, ["alpha"]);
  });
});
