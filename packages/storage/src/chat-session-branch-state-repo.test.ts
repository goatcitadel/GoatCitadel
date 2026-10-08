import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ChatSessionBranchStateRepository } from "./chat-session-branch-state-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function createRepo(): ChatSessionBranchStateRepository {
  const dbPath = tempDbs.path("goatcitadel-branch-state");
  const db = tempDbs.open({ dbPath });
  return new ChatSessionBranchStateRepository(db);
}

describe("ChatSessionBranchStateRepository", () => {
  it("inserts the active leaf when there is no prior row and enforces compare-and-set on updates", () => {
    const repo = createRepo();

    assert.equal(repo.setActiveLeafIfCurrent("sess-1", undefined, "turn-1", "2026-03-07T00:00:00.000Z"), true);
    assert.deepEqual(repo.get("sess-1"), {
      sessionId: "sess-1",
      activeLeafTurnId: "turn-1",
      updatedAt: "2026-03-07T00:00:00.000Z",
    });

    assert.equal(repo.setActiveLeafIfCurrent("sess-1", "turn-1", "turn-2", "2026-03-07T00:01:00.000Z"), true);
    assert.equal(repo.get("sess-1")?.activeLeafTurnId, "turn-2");

    assert.equal(repo.setActiveLeafIfCurrent("sess-1", "turn-1", "turn-3", "2026-03-07T00:02:00.000Z"), false);
    assert.equal(repo.get("sess-1")?.activeLeafTurnId, "turn-2");
  });

  it("treats duplicate writes of the same active leaf as idempotent", () => {
    const repo = createRepo();

    assert.equal(repo.setActiveLeafIfCurrent("sess-1", undefined, "turn-1", "2026-03-07T00:00:00.000Z"), true);
    assert.equal(repo.setActiveLeafIfCurrent("sess-1", undefined, "turn-1", "2026-03-07T00:01:00.000Z"), true);
    assert.equal(repo.get("sess-1")?.activeLeafTurnId, "turn-1");
    assert.equal(repo.get("sess-1")?.updatedAt, "2026-03-07T00:01:00.000Z");

    assert.equal(repo.setActiveLeafIfCurrent("sess-1", "turn-0", "turn-1", "2026-03-07T00:02:00.000Z"), true);
    assert.equal(repo.get("sess-1")?.activeLeafTurnId, "turn-1");
    assert.equal(repo.get("sess-1")?.updatedAt, "2026-03-07T00:02:00.000Z");
  });

  it("sets active leaves directly and reports unreadable post-write rows", () => {
    const repo = createRepo();

    assert.deepEqual(repo.setActiveLeaf("sess-1", "turn-1", "2026-03-07T00:00:00.000Z"), {
      sessionId: "sess-1",
      activeLeafTurnId: "turn-1",
      updatedAt: "2026-03-07T00:00:00.000Z",
    });

    const internal = repo as unknown as {
      getStmt: { get: (...args: unknown[]) => unknown };
    };
    internal.getStmt = { get: () => undefined };

    assert.throws(
      () => repo.setActiveLeaf("sess-2", "turn-2", "2026-03-07T00:01:00.000Z"),
      /chat session branch state sess-2 not found/,
    );
  });
});
