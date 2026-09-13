import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import type { ToolInvokeRequest } from "@goatcitadel/contracts";
import { createDatabase } from "./sqlite.js";
import type { DatabaseClient } from "./db.js";
import { ApprovalRepository } from "./approval-repo.js";
import { PendingApprovalActionRepository } from "./pending-approval-action-repo.js";
import { CommsDeliveryRepository } from "./comms-delivery-repo.js";
import { ChannelDeliveryPartRepository, channelDeliveryPartRequestHash } from "./channel-delivery-part-repo.js";

const databases: DatabaseClient[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = createDatabase({ dbPath: ":memory:" });
  databases.push(db);
  const deliveries = new CommsDeliveryRepository(db);
  const parts = new ChannelDeliveryPartRepository(db);
  const approvals = new ApprovalRepository(db);
  const actions = new PendingApprovalActionRepository(db);
  const now = new Date().toISOString();
  const lease = new Date(Date.now() + 60_000).toISOString();
  const input = {
    connectionId: "connection",
    channelKey: "telegram",
    target: "-123456",
    payload: { message: "one send" },
  };
  const queued = deliveries.createQueued(input, now);
  assert.equal(deliveries.claimAttempt(queued.deliveryId, 0, 1, lease, now), true);
  const request: ToolInvokeRequest = {
    toolName: "channel.send",
    agentId: "operator",
    sessionId: "session",
    runId: "run",
    args: { connectionId: input.connectionId, target: input.target, message: "one send" },
  };
  const binding = {
    deliveryId: queued.deliveryId,
    attempt: 1,
    partIndex: 0,
    payloadHash: queued.payloadHash,
    requestHash: channelDeliveryPartRequestHash(request),
    claimExpiresAt: lease,
  };
  const part = parts.prepare(binding, now);
  request.toolRunId = part.partId;
  function registerApproval(pendingRequest = request) {
    return db.transaction("immediate", () => {
      const approval = approvals.create({
        kind: "channel.send",
        riskLevel: "danger",
        payload: request.args,
        preview: {},
        expiresAt: new Date(Date.now() + 120_000).toISOString(),
      });
      actions.upsertPending({
        approvalId: approval.approvalId,
        actionType: "tool.invoke",
        request: pendingRequest as unknown as Record<string, unknown>,
        expiresAt: approval.expiresAt,
      });
      parts.bindApproval(part.partId, binding.requestHash, approval.approvalId, now);
      return approval;
    });
  }
  return {
    db,
    deliveries,
    parts,
    approvals,
    actions,
    now,
    lease,
    input,
    queued,
    request,
    binding,
    part,
    registerApproval,
  };
}

test("channel part preparation binds the queue claim, attempt, payload and normalized request", () => {
  const f = fixture();
  assert.equal(f.parts.prepare(f.binding).partId, f.part.partId);
  assert.equal(f.parts.list(f.queued.deliveryId, 1).length, 1);
  assert.throws(() => f.parts.prepare({ ...f.binding, requestHash: "a".repeat(64) }), /material changed/);
  assert.throws(
    () => f.parts.prepare({ ...f.binding, partIndex: 1, payloadHash: "b".repeat(64) }),
    /current queue attempt/,
  );
  assert.throws(() => f.parts.prepare({ ...f.binding, attempt: 2 }), /current queue attempt/);
  assert.throws(() => f.parts.prepare({ ...f.binding, partIndex: 1, claimExpiresAt: f.now }), /current queue attempt/);
});

test("channel part SQL rejects forged identities, revisions, transitions and deletion", () => {
  const f = fixture();
  for (const assignment of ["request_hash = '" + "b".repeat(64) + "'", "revision = revision + 2", "status = 'sent'"]) {
    assert.throws(() => f.db.exec(`UPDATE channel_delivery_parts SET ${assignment}`));
  }
  assert.throws(() => f.db.exec("DELETE FROM channel_delivery_parts"), /cannot be deleted/);
  assert.equal(f.parts.find(f.part.partId)?.status, "prepared");
});

test("approval registration rolls back approval and pending action on a mismatched request", () => {
  const f = fixture();
  assert.throws(() => f.registerApproval({ ...f.request, runId: "another-run" }), /identity changed/);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM approvals").get<{ n: number }>()?.n, 0);
  assert.equal(f.db.prepare("SELECT COUNT(*) AS n FROM pending_approval_actions").get<{ n: number }>()?.n, 0);
  assert.equal(f.parts.find(f.part.partId)?.status, "prepared");
  assert.equal(f.deliveries.getById(f.queued.deliveryId)?.nextAttemptAt, f.lease);
});

test("approval waits release the queue lease without consuming an attempt or enabling dispatch", () => {
  const f = fixture();
  const approval = f.registerApproval();
  assert.equal(f.deliveries.getById(f.queued.deliveryId)?.deliveryStatus, "waiting_approval");
  assert.equal(f.deliveries.getById(f.queued.deliveryId)?.attempts, 1);
  const provider = f.deliveries.createQueued(f.input);
  assert.throws(
    () => f.parts.attachProvider(f.part.partId, f.binding.requestHash, provider.deliveryId),
    /current approval/,
  );
  f.approvals.resolve(approval.approvalId, { decision: "approve", resolvedBy: "operator" });
  const dispatch = f.parts.attachProvider(f.part.partId, f.binding.requestHash, provider.deliveryId);
  assert.equal(dispatch.status, "dispatching");
  assert.throws(
    () => f.parts.attachProvider(f.part.partId, f.binding.requestHash, provider.deliveryId),
    /already dispatched/,
  );
});

test("provider receipts cannot attach to another destination and failed attachment rolls back insertion", () => {
  const f = fixture();
  const count = f.deliveries.list().length;
  assert.throws(
    () =>
      f.db.transaction("immediate", () => {
        const provider = f.deliveries.createQueued({ ...f.input, target: "another-chat" });
        f.parts.attachProvider(f.part.partId, f.binding.requestHash, provider.deliveryId);
      }),
    /does not belong/,
  );
  assert.equal(f.deliveries.list().length, count);
  assert.equal(f.parts.find(f.part.partId)?.status, "prepared");
});

test("one linked provider receipt is required for settlement and excluded from logical queue inventory", () => {
  const f = fixture();
  const provider = f.deliveries.createQueued(f.input);
  const dispatch = f.parts.attachProvider(f.part.partId, f.binding.requestHash, provider.deliveryId);
  assert.throws(
    () => f.parts.finish(f.part.partId, provider.deliveryId, dispatch.revision, "sent"),
    /terminal provider receipt/,
  );
  assert.deepEqual(
    f.deliveries.list().map((row) => row.deliveryId),
    [f.queued.deliveryId],
  );
  assert.deepEqual(
    f.deliveries.list(f.input.connectionId).map((row) => row.deliveryId),
    [f.queued.deliveryId],
  );
  assert.equal(
    f.deliveries
      .listDue(new Date(Date.now() + 120_000).toISOString())
      .some((row) => row.deliveryId === provider.deliveryId),
    false,
  );
  f.db.transaction("immediate", () => {
    f.deliveries.markSent(provider.deliveryId, "provider-ack");
    assert.equal(f.parts.finish(f.part.partId, provider.deliveryId, dispatch.revision, "sent"), true);
  });
  assert.equal(f.parts.finish(f.part.partId, provider.deliveryId, dispatch.revision, "sent"), false);
  assert.equal(f.deliveries.getById(provider.deliveryId)?.providerMessageId, "provider-ack");
});

test("an approved part cannot send after the queue has been finalized", () => {
  const f = fixture();
  const approval = f.registerApproval();
  f.approvals.resolve(approval.approvalId, { decision: "approve", resolvedBy: "operator" });
  f.deliveries.markFailed(f.queued.deliveryId, "cancelled", undefined, "blocked");
  const provider = f.deliveries.createQueued(f.input);
  assert.throws(
    () => f.parts.attachProvider(f.part.partId, f.binding.requestHash, provider.deliveryId),
    /current queue attempt/,
  );
  assert.equal(f.parts.park(f.part.partId, f.lease, f.now), false);
});

test("an edited approval cannot authorize the originally queued bytes", () => {
  const f = fixture();
  const approval = f.registerApproval();
  f.approvals.resolve(approval.approvalId, {
    decision: "approve",
    resolvedBy: "operator",
    editedPayload: { ...f.request.args, message: "different message" },
  });
  const provider = f.deliveries.createQueued(f.input);
  assert.throws(
    () => f.parts.attachProvider(f.part.partId, f.binding.requestHash, provider.deliveryId),
    /identity changed/,
  );
  assert.equal(f.parts.find(f.part.partId)?.status, "waiting_approval");
});

test("approval polling cannot steal a competing runtime claim", () => {
  const f = fixture();
  f.registerApproval();
  const pollAt = new Date(Date.now() + 5_000).toISOString();
  assert.equal(f.parts.park(f.part.partId, f.lease, pollAt), true);
  const newerLease = new Date(Date.parse(pollAt) + 60_000).toISOString();
  assert.equal(f.deliveries.claimAttempt(f.queued.deliveryId, 1, 1, newerLease, pollAt), true);
  assert.equal(f.parts.park(f.part.partId, f.lease, pollAt, pollAt), false);
  assert.equal(f.deliveries.getById(f.queued.deliveryId)?.nextAttemptAt, newerLease);
  assert.equal(f.deliveries.getById(f.queued.deliveryId)?.attempts, 1);
});
