import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { ExternalConnectorReviewStateRepository } from "./external-connector-state-repo.js";

const createdFiles: string[] = [];

afterEach(() => {
  for (const file of createdFiles.splice(0)) {
    try {
      fs.rmSync(file, { force: true });
      fs.rmSync(`${file}-wal`, { force: true });
      fs.rmSync(`${file}-shm`, { force: true });
    } catch {
      // ignore cleanup failures
    }
  }
});

function createRepo(): ExternalConnectorReviewStateRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-external-connectors-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  return new ExternalConnectorReviewStateRepository(createDatabase({ dbPath }));
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
