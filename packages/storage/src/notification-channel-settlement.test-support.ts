import assert from "node:assert/strict";
import { sanitizeChannelOutboundMessage } from "@goatcitadel/contracts";
import type { DatabaseClient, DbBindParams } from "./db.js";
import { CommsDeliveryRepository } from "./comms-delivery-repo.js";
import { NotificationRoutingRepository } from "./notification-routing-repo.js";

const now = "2026-09-30T12:00:00.000Z";
export function seedNotificationChannel(db: DatabaseClient, id: string, override: Record<string, unknown> = {}) {
  const notifications = new NotificationRoutingRepository(db);
  const channels = new CommsDeliveryRepository(db);
  const target = notifications.createTarget(
    `target-${id}`,
    id,
    {
      kind: "channel_connection",
      label: "Fixture",
      channelConnectionId: `connection-${id}`,
    },
    now,
  );
  const event = notifications.createEvent({
    eventId: `event-${id}`,
    workspaceId: id,
    eventType: "turn.failed",
    title: "Fixture notification",
    message: "Visible <think>private reasoning</think>content",
    source: "operator_test",
    createdAt: now,
  });
  const notification = notifications.createDelivery({
    deliveryId: `notification-${id}`,
    eventId: event.eventId,
    targetId: target.targetId,
    ruleId: "operator_test",
    workspaceId: id,
    idempotencyKey: `notification:${event.eventId}:operator_test:${target.targetId}`,
    status: "pending",
    attemptCount: 1,
    createdAt: now,
    updatedAt: now,
  });
  const payload = {
    connectionId: target.channelConnectionId,
    target: "fixture-topic",
    workspaceId: id,
    effectId: notification.idempotencyKey,
    operatorId: "notification-routing",
    message: sanitizeChannelOutboundMessage(`${event.title}\n\n${event.message}`).message,
    ...override,
  };
  const channel = channels.createQueued(
    {
      connectionId: target.channelConnectionId!,
      channelKey: "ntfy",
      target: "fixture-topic",
      payload,
      idempotencyKey: `channel-delivery:effect:${notification.idempotencyKey}`,
    },
    now,
  );
  return { notifications, channels, notification, channel, target, event, payload };
}

export function verifyNotificationChannelSettlement(db: DatabaseClient): void {
  const fixture = seedNotificationChannel(db, "settlement");
  const { notifications, channels, channel, notification } = fixture;
  const read = () => notifications.listDeliveries(notification.workspaceId)[0]!;
  assert.deepEqual(read(), notification, "admission remains pending without claiming transport success");
  db.prepare(
    "UPDATE comms_deliveries SET delivery_status = 'waiting_approval', attempts = 1 WHERE delivery_id = ?",
  ).run(channel.deliveryId);
  assert.equal(read().status, "pending");
  assert.match(read().lastError!, /awaiting approval/);
  const waiting = read();
  assert.deepEqual(read(), waiting, "unchanged observations do not rewrite history timestamps");
  channels.markFailed(channel.deliveryId, "provider-private failure", now, "manual_reconciliation_required");
  assert.equal(read().status, "unknown_after_send");
  assert.doesNotMatch(read().lastError!, /provider-private/);
  channels.markSent(channel.deliveryId, "provider-receipt");
  assert.equal(read().status, "delivered");
  assert.equal(read().lastError, undefined);
  assert.equal(read().attemptCount, 1);
  assert.equal(channels.list(undefined, 500).length, 1, "settlement never enqueues another delivery");
  assert.deepEqual(notifications.listDeliveries("foreign"), []);

  const failed = seedNotificationChannel(db, "blocked");
  failed.channels.markFailed(failed.channel.deliveryId, "private URL", now, "blocked");
  const blocked = failed.notifications.listDeliveries("blocked")[0]!;
  assert.equal(blocked.status, "failed");
  assert.doesNotMatch(blocked.lastError!, /private URL/);

  const split = seedNotificationChannel(db, "split");
  const message = split.payload.message;
  db.prepare("UPDATE comms_deliveries SET payload_json = ? WHERE delivery_id = ?").run(
    JSON.stringify({
      ...split.payload,
      message: message.slice(0, 10),
      messageParts: [message.slice(0, 10), message.slice(10)],
    }),
    split.channel.deliveryId,
  );
  split.channels.markSent(split.channel.deliveryId);
  assert.equal(split.notifications.listDeliveries("split")[0]!.status, "delivered");
}

export function verifyNotificationBindingFailures(db: DatabaseClient): void {
  const invalid: Record<string, unknown>[] = [
    { effectId: "foreign" },
    { workspaceId: "foreign" },
    { connectionId: "foreign" },
    { target: "foreign" },
    { operatorId: "foreign" },
    { sessionId: "foreign" },
    { taskId: "foreign" },
    { message: "foreign" },
    { messageParts: ["foreign"] },
  ];
  invalid.forEach((override, index) => {
    const id = `invalid-${index}`;
    const fixture = seedNotificationChannel(db, id, override);
    fixture.channels.markSent(fixture.channel.deliveryId);
    assert.deepEqual(fixture.notifications.listDeliveries(id), [fixture.notification]);
  });
  for (const payload of ["{", "null", "[]", '"text"']) {
    const id = `corrupt-${payload}`;
    const fixture = seedNotificationChannel(db, id);
    db.prepare("UPDATE comms_deliveries SET payload_json = ? WHERE delivery_id = ?").run(
      payload,
      fixture.channel.deliveryId,
    );
    fixture.channels.markSent(fixture.channel.deliveryId);
    assert.deepEqual(fixture.notifications.listDeliveries(id), [fixture.notification]);
  }
  for (const column of ["target", "event", "key", "unadmitted"] as const) {
    const fixture = seedNotificationChannel(db, column);
    fixture.channels.markSent(fixture.channel.deliveryId);
    if (column === "target")
      fixture.notifications.updateTarget(fixture.target.targetId, 1, {
        ...fixture.target,
        channelConnectionId: "replacement",
      });
    if (column === "event")
      db.prepare("UPDATE notification_events SET workspace_id = 'foreign' WHERE event_id = ?").run(
        fixture.event.eventId,
      );
    if (column === "key")
      db.prepare("UPDATE notification_deliveries SET idempotency_key = 'foreign' WHERE delivery_id = ?").run(
        fixture.notification.deliveryId,
      );
    if (column === "unadmitted")
      db.prepare("UPDATE notification_deliveries SET attempt_count = 0 WHERE delivery_id = ?").run(
        fixture.notification.deliveryId,
      );
    assert.equal(fixture.notifications.listDeliveries(column)[0]!.status, "pending");
  }
}

export function verifyNotificationSettlementCas(db: DatabaseClient, competingDb: DatabaseClient = db): void {
  const competingChannels = new CommsDeliveryRepository(competingDb);
  const competingNotifications = new NotificationRoutingRepository(competingDb);
  for (const changed of ["queue", "target", "notification"] as const) {
    const id = `racing-${changed}`;
    const fixture = seedNotificationChannel(db, id);
    fixture.channels.markSent(fixture.channel.deliveryId);
    let raced = false;
    const intercepted: DatabaseClient = {
      dialect: db.dialect,
      exec: (sql) => db.exec(sql),
      close: () => {},
      transaction: (mode, callback) => db.transaction(mode, callback),
      prepare(sql) {
        const statement = db.prepare(sql);
        return {
          get: <T>(...args: DbBindParams[]) => statement.get<T>(...args),
          all: <T>(...args: DbBindParams[]) => statement.all<T>(...args),
          run: (...args: DbBindParams[]) => {
            if (!raced && sql.includes("previousStatus")) {
              raced = true;
              if (changed === "queue")
                competingChannels.markFailed(fixture.channel.deliveryId, "failure", now, "blocked");
              if (changed === "target")
                competingNotifications.updateTarget(fixture.target.targetId, 1, {
                  ...fixture.target,
                  channelConnectionId: "other",
                });
              if (changed === "notification")
                competingNotifications.patchDelivery(fixture.notification.deliveryId, {
                  status: "unknown_after_send",
                  attemptCount: 2,
                  updatedAt: now,
                });
            }
            return statement.run(...args);
          },
        };
      },
    };
    const result = new NotificationRoutingRepository(intercepted).listDeliveries(id)[0]!;
    assert.equal(raced, true);
    assert.equal(
      result.status,
      changed === "notification" ? "unknown_after_send" : "pending",
      "stale observed evidence cannot overwrite a competing owner change",
    );
    if (changed === "queue") assert.equal(fixture.notifications.listDeliveries(id)[0]!.status, "failed");
  }
}
