import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Storage } from "./index.js";

describe("NotificationRoutingRepository", () => {
  it("persists revisioned workspace configuration, presence, events, and idempotent deliveries", () => {
    const storage = new Storage({ dbPath: ":memory:", transcriptsDir: "data/transcripts", auditDir: "data/audit" });
    const repository = storage.notificationRouting;
    const now = "2026-07-27T20:00:00.000Z";
    const target = repository.createTarget(
      "target-1",
      "workspace-1",
      {
        label: "Ops webhook",
        kind: "https_webhook",
        webhookUrlSecretRef: "keychain:goatcitadel:notification-webhook:ops",
      },
      now,
    );
    assert.equal(target.revision, 1);
    assert.throws(
      () => repository.updateTarget(target.targetId, 9, { ...target, label: "stale" }, now),
      /revision changed/i,
    );

    const updated = repository.updateTarget(target.targetId, 1, { ...target, label: "Ops alerts" }, now);
    assert.equal(updated.revision, 2);
    const rule = repository.createRule(
      "rule-1",
      "workspace-1",
      {
        label: "Failures",
        eventTypes: ["turn.failed"],
        targetIds: [target.targetId],
        deliveryPolicy: "when_away",
      },
      now,
    );
    assert.deepEqual(rule.eventTypes, ["turn.failed"]);

    repository.upsertPresence({
      leaseId: "lease-1",
      workspaceId: "workspace-1",
      clientId: "client-1",
      focused: true,
      visible: true,
      expiresAt: "2026-07-27T20:01:00.000Z",
      updatedAt: now,
    });
    assert.equal(repository.hasActivePresence("workspace-1", "2026-07-27T20:00:30.000Z"), true);
    assert.equal(repository.hasActivePresence("workspace-1", "2026-07-27T20:02:00.000Z"), false);

    const event = repository.createEvent({
      eventId: "event-1",
      workspaceId: "workspace-1",
      eventType: "turn.failed",
      title: "Turn failed",
      message: "Inspect the trace.",
      source: "chat.turn",
      createdAt: now,
    });
    assert.deepEqual(repository.createEvent({ ...event, title: "forged replacement" }), event);

    const delivery = repository.createDelivery({
      deliveryId: "delivery-1",
      eventId: event.eventId,
      ruleId: rule.ruleId,
      targetId: target.targetId,
      workspaceId: "workspace-1",
      idempotencyKey: "notification:event-1:rule-1:target-1",
      status: "pending",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(
      repository.createDelivery({ ...delivery, deliveryId: "delivery-duplicate", status: "failed" }).deliveryId,
      "delivery-1",
    );
    storage.close();
  });
});
