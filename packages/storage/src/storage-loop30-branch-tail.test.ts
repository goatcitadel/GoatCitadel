import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { ApprovalInboxRepository } from "./approval-inbox-repo.js";
import { DurableRunRepository } from "./durable-run-repo.js";
import { TempSqliteFiles } from "./temp-sqlite.test-support.js";

const tempDbs = new TempSqliteFiles();

afterEach(() => tempDbs.cleanup());

function db() {
  return tempDbs.open({ dbPath: tempDbs.path("goatcitadel-storage-loop30") });
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
