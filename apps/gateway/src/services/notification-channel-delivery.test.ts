import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection, NotificationEventRecord, NotificationTarget } from "@goatcitadel/contracts";
import { deliverNotificationToChannel } from "./gateway-route-composition-integrations.js";

const now = "2026-09-30T18:00:00.000Z";
const connection: IntegrationConnection = {
  connectionId: "fixture-channel",
  catalogId: "channel.ntfy",
  kind: "channel",
  key: "ntfy",
  label: "Fixture receiver",
  enabled: true,
  status: "connected",
  workspaceId: "workspace",
  config: { baseUrl: "http://127.0.0.1:12345", topic: "fixture-topic" },
  revision: "a".repeat(64),
  createdAt: now,
  updatedAt: now,
};
const target: NotificationTarget = {
  targetId: "target",
  workspaceId: "workspace",
  revision: 1,
  label: "Fixture destination",
  kind: "channel_connection",
  channelConnectionId: connection.connectionId,
  lifecycleState: "active",
  createdAt: now,
  updatedAt: now,
};
const event: NotificationEventRecord = {
  eventId: "event",
  workspaceId: "workspace",
  eventType: "durable.attention_required",
  title: "Test notification",
  message: "Fixture content",
  source: "operator_test",
  createdAt: now,
};
function fixture(saved = connection) {
  const commsSend = vi.fn(async () => ({ outcome: "delivered" }));
  return { commsSend, storage: { integrationConnections: { get: vi.fn(async () => saved) } } };
}
describe("notification delivery through the existing channel owner", () => {
  it("resolves ntfy topic and retains exact workspace, operator and idempotency bindings", async () => {
    const gateway = fixture();
    await expect(deliverNotificationToChannel(gateway, target, event, "notification:fixture")).resolves.toEqual({
      status: "delivered",
      attemptCount: 1,
    });
    expect(gateway.commsSend).toHaveBeenCalledExactlyOnceWith({
      connectionId: connection.connectionId,
      target: "fixture-topic",
      message: "Test notification\n\nFixture content",
      workspaceId: "workspace",
      sessionId: undefined,
      taskId: undefined,
      operatorId: "notification-routing",
      effectId: "notification:fixture",
      surface: "tools",
    });
  });
  it("uses existing named Slack targets and preserves older generic destinations", async () => {
    for (const [key, config, expected] of [
      ["slack", { targets: [{ default: true, channel: "C123" }] }, "C123"],
      ["telegram", { defaultChatId: "123" }, "123"],
      ["custom", { channelId: "legacy-channel" }, "legacy-channel"],
    ] as const) {
      const gateway = fixture({ ...connection, key, config });
      await deliverNotificationToChannel(gateway, target, event, "notification:fixture");
      expect(gateway.commsSend).toHaveBeenCalledWith(expect.objectContaining({ target: expected }));
    }
  });
  it("does not dispatch a missing destination or a connection in another workspace", async () => {
    for (const saved of [
      { ...connection, config: {} },
      { ...connection, workspaceId: "foreign" },
    ]) {
      const gateway = fixture(saved);
      await expect(deliverNotificationToChannel(gateway, target, event, "notification:fixture")).resolves.toMatchObject(
        { status: "failed" },
      );
      expect(gateway.commsSend).not.toHaveBeenCalled();
    }
  });
  it("retains the governed owner's blocked or pending outcomes", async () => {
    for (const outcome of ["blocked", "pending"]) {
      const gateway = fixture();
      gateway.commsSend.mockResolvedValueOnce({ outcome });
      await expect(deliverNotificationToChannel(gateway, target, event, "notification:fixture")).resolves.toMatchObject(
        {
          status: outcome === "blocked" ? "failed" : "pending",
        },
      );
    }
  });
});
