import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { randomUUID } from "node:crypto";
import { createDatabase } from "./sqlite.js";
import { __approvalInboxInternals, ApprovalInboxRepository } from "./approval-inbox-repo.js";
import type { DatabaseClient } from "./db.js";

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

function createStore(): { db: DatabaseClient; repo: ApprovalInboxRepository } {
  const dbPath = path.join(os.tmpdir(), `goatcitadel-approval-inbox-${randomUUID()}.db`);
  createdFiles.push(dbPath);
  const db = createDatabase({ dbPath });
  return { db, repo: new ApprovalInboxRepository(db) };
}

function createRepo(): ApprovalInboxRepository {
  return createStore().repo;
}

function setRawField(db: DatabaseClient, inboxItemId: string, field: string, value: unknown): void {
  db.prepare(`UPDATE approval_inbox_items SET ${field} = ? WHERE inbox_item_id = ?`).run(value, inboxItemId);
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
    assert.equal(listed[0]?.token, "redacted:tok-1");
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

  it("reloads the pending inbox item when the resolution update is ignored", () => {
    const { db, repo } = createStore();
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
    db.exec(`
      CREATE TRIGGER ignore_approval_inbox_resolution
      BEFORE UPDATE OF state ON approval_inbox_items
      WHEN OLD.inbox_item_id = '${item.inboxItemId}'
      BEGIN
        SELECT RAISE(IGNORE);
      END;
    `);

    const unchanged = repo.markResolved(item.inboxItemId, {
      state: "approved",
      approvalStatus: "approved",
      resolvedAt: "2026-03-21T12:06:00.000Z",
    });

    assert.equal(unchanged.state, "pending");
    assert.equal(unchanged.approvalStatus, "pending");
  });

  it("does not let redelivery overwrite a terminal inbox item", () => {
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
      preview: { summary: "First delivery" },
      expiresAt: "2026-03-21T12:30:00.000Z",
      receivedAt: "2026-03-21T12:00:00.000Z",
    });
    repo.markResolved(item.inboxItemId, {
      state: "approved",
      approvalStatus: "approved",
      resolvedAt: "2026-03-21T12:05:00.000Z",
      resolvedBy: "operator:mcp",
    });

    const redelivered = repo.receiveMcpApprovalDelivery({
      connectorId: "mcp:server-1",
      receiverId: "server-1",
      approvalId: "apr-1",
      tokenId: "tok-1",
      token: "grat_tok_1",
      approvalKind: "tool.invoke",
      riskLevel: "danger",
      approvalStatus: "pending",
      preview: { summary: "Late retry" },
      expiresAt: "2026-03-21T12:45:00.000Z",
      receivedAt: "2026-03-21T12:06:00.000Z",
    });

    assert.equal(redelivered.state, "approved");
    assert.equal(redelivered.approvalStatus, "approved");
    assert.equal(redelivered.preview.summary, "First delivery");
    assert.equal(redelivered.deliveryCount, 1);
  });

  it("keeps the first terminal resolution when a second resolver arrives later", () => {
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

    const approved = repo.markResolved(item.inboxItemId, {
      state: "approved",
      approvalStatus: "approved",
      resolvedAt: "2026-03-21T12:06:00.000Z",
      resolvedBy: "operator:mcp",
    });
    const second = repo.markResolved(item.inboxItemId, {
      state: "failed",
      approvalStatus: "pending",
      resolvedAt: "2026-03-21T12:07:00.000Z",
      resolvedBy: "operator:mcp",
      lastError: "token already consumed",
    });

    assert.equal(approved.state, "approved");
    assert.equal(second.state, "approved");
    assert.equal(second.lastError, undefined);
  });

  it("supports state-filtered listing, approval-token lookup, deletion, and validation failures", () => {
    const repo = createRepo();
    const item = repo.receiveMcpApprovalDelivery({
      connectorId: " mcp:server-1 ",
      receiverId: " server-1 ",
      approvalId: " apr-1 ",
      tokenId: " tok-1 ",
      token: " grat_tok_1 ",
      approvalKind: "tool.invoke",
      riskLevel: "caution",
      approvalStatus: "pending",
      preview: [] as unknown as Record<string, unknown>,
      expiresAt: "2026-03-21T12:30:00.000Z",
      receivedAt: "2026-03-21T12:00:00.000Z",
    });

    assert.deepEqual(item.preview, {});
    assert.deepEqual(repo.findByApprovalAndToken("apr-1", "tok-1")?.inboxItemId, item.inboxItemId);
    assert.deepEqual(
      repo.listByReceiver("mcp", "server-1", { state: "pending", limit: 1 }).map((record) => record.inboxItemId),
      [item.inboxItemId],
    );
    assert.equal(repo.deleteByReceiver("mcp", "missing-server"), 0);
    assert.equal(repo.deleteByReceiver("mcp", "server-1"), 1);
    assert.deepEqual(repo.listByReceiver("mcp", "server-1"), []);

    assert.throws(
      () =>
        repo.receiveMcpApprovalDelivery({
          connectorId: " ",
          receiverId: "server-1",
          approvalId: "apr-2",
          tokenId: "tok-2",
          token: "grat_tok_2",
          approvalKind: "tool.invoke",
          riskLevel: "safe",
          approvalStatus: "pending",
          preview: {},
          expiresAt: "2026-03-21T12:30:00.000Z",
        }),
      /connectorId is required/,
    );
    for (const [field, override] of [
      ["receiverId", { receiverId: " " }],
      ["approvalId", { approvalId: " " }],
      ["tokenId", { tokenId: " " }],
      ["token", { token: " " }],
    ] as const) {
      assert.throws(
        () =>
          repo.receiveMcpApprovalDelivery({
            connectorId: "mcp:server-1",
            receiverId: "server-1",
            approvalId: "apr-2",
            tokenId: "tok-2",
            token: "grat_tok_2",
            approvalKind: "tool.invoke",
            riskLevel: "safe",
            approvalStatus: "pending",
            preview: {},
            expiresAt: "2026-03-21T12:30:00.000Z",
            ...override,
          }),
        new RegExp(`${field} is required`),
      );
    }
    assert.deepEqual(__approvalInboxInternals.toApprovalInboxRowsForTest(undefined), []);
  });

  it("filters malformed rows and malformed preview payloads defensively", () => {
    const { db, repo } = createStore();
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

    setRawField(db, item.inboxItemId, "preview_json", "[]");
    assert.deepEqual(repo.get(item.inboxItemId).preview, {});

    setRawField(db, item.inboxItemId, "state", "cancelled");
    assert.throws(() => repo.get(item.inboxItemId), /Approval inbox item .* not found/);
    assert.equal(repo.getByReceiverAndToken("mcp", "server-1", "tok-1"), undefined);
    assert.equal(repo.findByApprovalAndToken("apr-1", "tok-1"), undefined);
    assert.deepEqual(repo.listByReceiver("mcp", "server-1"), []);

    setRawField(db, item.inboxItemId, "state", "pending");
    setRawField(db, item.inboxItemId, "risk_level", "catastrophic");
    assert.throws(() => repo.get(item.inboxItemId), /Approval inbox item .* not found/);

    setRawField(db, item.inboxItemId, "risk_level", "danger");
    setRawField(db, item.inboxItemId, "approval_status", "cancelled");
    assert.throws(() => repo.get(item.inboxItemId), /Approval inbox item .* not found/);

    assert.throws(() => repo.get("missing-inbox-item"), /Approval inbox item missing-inbox-item not found/);
  });
});
