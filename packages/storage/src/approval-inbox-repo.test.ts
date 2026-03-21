import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { ApprovalInboxRepository } from "./approval-inbox-repo.js";

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

function createRepo(): ApprovalInboxRepository {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-approval-inbox-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return new ApprovalInboxRepository(db);
}

describe("ApprovalInboxRepository", () => {
  it("stores MCP approval deliveries and lists them by receiver", () => {
    const repo = createRepo();
    const first = repo.receiveMcpApprovalDelivery({
      connectorId: "mcp:server-1",
      receiverId: "server-1",
      approvalId: "apr-1",
      tokenId: "tok-1",
      token: "grat_tok_1",
      approvalKind: "tool.invoke",
      riskLevel: "danger",
      approvalStatus: "pending",
      preview: { summary: "Approve deployment?" },
      expiresAt: "2026-03-21T12:30:00.000Z",
      receivedAt: "2026-03-21T12:00:00.000Z",
    });

    assert.equal(first.deliveryCount, 1);
    const listed = repo.listByReceiver("mcp", "server-1");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.approvalId, "apr-1");
    assert.equal(listed[0]?.tokenId, "tok-1");
    assert.equal(listed[0]?.token, "grat_tok_1");
    assert.equal(listed[0]?.state, "pending");
  });

  it("coalesces redelivery for the same receiver and token", () => {
    const repo = createRepo();
    const first = repo.receiveMcpApprovalDelivery({
      connectorId: "mcp:server-1",
      receiverId: "server-1",
      approvalId: "apr-1",
      tokenId: "tok-1",
      token: "grat_tok_1",
      approvalKind: "tool.invoke",
      riskLevel: "danger",
      approvalStatus: "pending",
      preview: { summary: "First delivery" },
      expiresAt: "2026-03-21T12:30:00.000Z",
      receivedAt: "2026-03-21T12:00:00.000Z",
    });

    const second = repo.receiveMcpApprovalDelivery({
      connectorId: "mcp:server-1",
      receiverId: "server-1",
      approvalId: "apr-1",
      tokenId: "tok-1",
      token: "grat_tok_1",
      approvalKind: "tool.invoke",
      riskLevel: "danger",
      approvalStatus: "pending",
      preview: { summary: "Second delivery" },
      expiresAt: "2026-03-21T12:45:00.000Z",
      receivedAt: "2026-03-21T12:05:00.000Z",
    });

    assert.equal(second.inboxItemId, first.inboxItemId);
    assert.equal(second.deliveryCount, 2);
    assert.equal(second.preview.summary, "Second delivery");
    assert.equal(second.lastDeliveredAt, "2026-03-21T12:05:00.000Z");
  });

  it("marks inbox items resolved with terminal state", () => {
    const repo = createRepo();
    const item = repo.receiveMcpApprovalDelivery({
      connectorId: "mcp:server-1",
      receiverId: "server-1",
      approvalId: "apr-1",
      tokenId: "tok-1",
      token: "grat_tok_1",
      approvalKind: "tool.invoke",
      riskLevel: "danger",
      approvalStatus: "pending",
      preview: { summary: "Approve deployment?" },
      expiresAt: "2026-03-21T12:30:00.000Z",
    });

    const updated = repo.markResolved(item.inboxItemId, {
      state: "approved",
      approvalStatus: "approved",
      resolvedAt: "2026-03-21T12:06:00.000Z",
      resolvedBy: "operator:mcp",
    });

    assert.equal(updated.state, "approved");
    assert.equal(updated.approvalStatus, "approved");
    assert.equal(updated.resolvedBy, "operator:mcp");
  });
});
