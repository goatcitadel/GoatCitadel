import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { ExternalConnectorReviewStateRepository } from "./external-connector-state-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function createRepo(): ExternalConnectorReviewStateRepository {
  const dbPath = tempDbs.path("goatcitadel-external-connectors");
  return new ExternalConnectorReviewStateRepository(tempDbs.open({ dbPath }));
}

describe("ExternalConnectorReviewStateRepository", () => {
  it("persists service and action review state independently per workspace", () => {
    const repo = createRepo();

    const serviceState = repo.upsert(
      { workspaceId: "default", sourceId: "mscr", serviceId: "notion" },
      { status: "reviewed", pinned: true, note: "Worth auditing" },
      "2026-06-21T10:00:00.000Z",
    );
    const actionState = repo.upsert(
      { workspaceId: "default", sourceId: "mscr", serviceId: "notion", actionId: "append-block-children" },
      { status: "staged", proposalId: "proposal-1" },
      "2026-06-21T10:01:00.000Z",
    );

    assert.equal(serviceState.actionId, undefined);
    assert.equal(serviceState.status, "reviewed");
    assert.equal(serviceState.pinned, true);
    assert.equal(actionState.actionId, "append-block-children");
    assert.equal(actionState.proposalId, "proposal-1");

    const listed = repo.list({ workspaceId: "default", sourceId: "mscr", serviceId: "notion" });
    assert.equal(listed.length, 2);
    assert.deepEqual(listed.map((item) => item.actionId ?? "service").sort(), ["append-block-children", "service"]);

    assert.equal(
      repo.find({
        workspaceId: "other",
        sourceId: "mscr",
        serviceId: "notion",
        actionId: "append-block-children",
      }),
      undefined,
    );
  });
});
