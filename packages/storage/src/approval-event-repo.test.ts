import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ApprovalEventRepository } from "./approval-event-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function createRepo(): ApprovalEventRepository {
  const dbPath = tempDbs.path("goatcitadel-approval-events");
  const db = tempDbs.open({ dbPath });
  return new ApprovalEventRepository(db);
}

describe("ApprovalEventRepository", () => {
  it("stores and replays approval events", () => {
    const repo = createRepo();
    repo.append({
      approvalId: "ap-1",
      eventType: "created",
      actorId: "system",
      payload: { foo: "bar" },
      timestamp: "2026-02-27T10:00:00.000Z",
    });
    repo.append({
      approvalId: "ap-1",
      eventType: "resolved",
      actorId: "operator",
      payload: { decision: "approve" },
      timestamp: "2026-02-27T10:01:00.000Z",
    });

    const events = repo.listByApprovalId("ap-1");
    assert.equal(events.length, 2);
    assert.equal(events[0]?.eventType, "created");
    assert.equal(events[1]?.eventType, "resolved");
  });
});
