import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { ApprovalInboxRepository } from "./approval-inbox-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { createDatabase } from "./sqlite.js";

const dbPaths: string[] = [];

afterEach(() => {
  for (const dbPath of dbPaths.splice(0)) {
    try {
      fs.rmSync(dbPath, { force: true });
      fs.rmSync(`${dbPath}-wal`, { force: true });
      fs.rmSync(`${dbPath}-shm`, { force: true });
    } catch {
      // Ignore SQLite sidecar cleanup races on Windows.
    }
  }
});

function db() {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-storage-loop30-${randomUUID()}.db`);
  dbPaths.push(dbPath);
  return createDatabase({ dbPath });
}

describe("storage loop 30 branch tails", () => {
  it("keeps approval inbox optional fields explicit through create/update paths", () => {
    const repo = new ApprovalInboxRepository(db());
    const created = repo.receiveMcpApprovalDelivery({
      connectorId: "connector-loop30",
      receiverId: "receiver-loop30",
      approvalId: "approval-loop30",
      tokenId: "token-loop30",
      token: "secret-token",
      approvalKind: "tool.invoke",
      riskLevel: "danger",
      approvalStatus: "pending",
      preview: {},
      expiresAt: "2026-05-15T00:10:00.000Z",
      receivedAt: "2026-05-15T00:00:00.000Z",
    });

    assert.equal(created.preview && Object.keys(created.preview).length, 0);
    assert.equal(created.token, "redacted:token-loop30");
    assert.equal(created.resolvedBy, undefined);

    const updated = repo.markResolved(created.inboxItemId, {
      state: "approved",
      approvalStatus: "approved",
      resolvedAt: "2026-05-15T00:01:00.000Z",
      resolvedBy: undefined,
    });
    assert.equal(updated.state, "approved");
    assert.equal(updated.resolvedBy, undefined);
    assert.equal(updated.lastError, undefined);
  });

  it("preserves durable run lease branches for stale and non-queued claims", () => {
    const repo = new DurableRunRepository(db());
    const running = repo.createRun({
      runId: "run-loop30-running",
      workflowKey: "workflow.loop30",
      status: "running",
      leaseOwnerId: "worker-a",
      leaseExpiresAt: "2026-05-15T00:10:00.000Z",
      now: "2026-05-15T00:00:00.000Z",
    });

    assert.equal(
      repo.tryClaimQueuedRun({
        runId: running.runId,
        workerId: "worker-b",
        leaseExpiresAt: "2026-05-15T00:20:00.000Z",
        leaseHeartbeatAt: "2026-05-15T00:11:00.000Z",
      }),
      undefined,
    );

    const queued = repo.createRun({
      runId: "run-loop30-queued",
      workflowKey: "workflow.loop30",
      now: "2026-05-15T00:00:00.000Z",
    });
    const claimed = repo.tryClaimQueuedRun({
      runId: queued.runId,
      workerId: "worker-c",
      leaseExpiresAt: "2026-05-15T00:30:00.000Z",
      leaseHeartbeatAt: "2026-05-15T00:15:00.000Z",
    });
    assert.equal(claimed?.status, "running");
    assert.equal(claimed?.leaseOwnerId, "worker-c");
  });
});
