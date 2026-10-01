import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createSqliteAsyncStorage, Storage } from "@goatcitadel/storage";
import { buildChannelDeliveryPayload, buildChannelDeliveryIdempotencyKey } from "./gateway/channel-delivery-helpers.js";
import { NotificationRoutingService } from "./notification-routing-service.js";

it("returns honest queue admission then reads exact settlement without invoking delivery again", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "gc-notification-settlement-"));
  const raw = new Storage({
    dbPath: ":memory:",
    transcriptsDir: path.join(directory, "transcripts"),
    auditDir: path.join(directory, "audit"),
  });
  const storage = createSqliteAsyncStorage(raw);
  try {
    const deliver = vi.fn<ConstructorParameters<typeof NotificationRoutingService>[0]["deliver"]>(
      async (target, event, key) => {
        const input = {
          connectionId: target.channelConnectionId!,
          target: "topic",
          message: `${event.title}\n\n${event.message}`,
          workspaceId: event.workspaceId,
          sessionId: event.sessionId,
          taskId: event.turnId,
          operatorId: "notification-routing",
          effectId: key,
          surface: "tools" as const,
        };
        await storage.commsDeliveries.createQueued({
          connectionId: input.connectionId,
          channelKey: "ntfy",
          target: input.target,
          payload: buildChannelDeliveryPayload(input, "ntfy"),
          idempotencyKey: buildChannelDeliveryIdempotencyKey(input, "ntfy"),
        });
        return { status: "pending", attemptCount: 1 };
      },
    );
    const service = new NotificationRoutingService({
      repository: storage.notificationRouting,
      normalizeWorkspaceId: (workspace) => workspace ?? "default",
      getIntegrationConnection: async (connectionId) => ({
        connectionId,
        catalogId: "channel.ntfy",
        key: "ntfy",
        kind: "channel",
        label: "Fixture",
        enabled: true,
        status: "connected",
        workspaceId: "fixture-workspace",
        config: { topic: "topic" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
      deliver,
      publishRealtime: vi.fn(async () => {}),
    });
    const target = await service.createTarget("fixture-workspace", {
      kind: "channel_connection",
      channelConnectionId: "fixture-channel",
      label: "Fixture",
    });
    const response = await service.sendTest("fixture-workspace", target.targetId);
    expect(response.status).toBe("pending");
    const queued = await storage.commsDeliveries.list("fixture-channel");
    expect(queued).toHaveLength(1);
    await storage.commsDeliveries.markSent(queued[0]!.deliveryId, "fixture-receipt");
    const records = await service.listDeliveries("fixture-workspace");
    expect(records).toEqual([
      expect.objectContaining({ deliveryId: response.deliveries[0]!.deliveryId, status: "delivered" }),
    ]);
    expect(await service.listDeliveries("fixture-workspace")).toEqual(records);
    expect(await service.listDeliveries("foreign")).toEqual([]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await storage.commsDeliveries.list("fixture-channel")).toHaveLength(1);
  } finally {
    await storage.close();
    await rm(directory, { recursive: true, force: true });
  }
});
