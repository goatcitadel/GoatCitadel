import type { ConnectorRecord, IntegrationConnection } from "@goatcitadel/contracts";
import { expect, it, vi } from "vitest";
import { resolveAutonomousChannelDestination } from "./autonomous-channel-destination.js";

it("uses the reviewed connector and rejects a destination, mode, or workspace change", async () => {
  const target = "123456789012345678";
  const delivery = { channelKey: "discord", connectionId: "reviewed", connectionRevision: "reviewed-revision", target };
  const connection = {
    connectionId: delivery.connectionId,
    key: delivery.channelKey,
    workspaceId: "project",
    enabled: true,
    status: "connected",
    revision: delivery.connectionRevision,
    config: { runtimeMode: "gateway", defaultChannelId: target },
  } as IntegrationConnection;
  const connectors = ["other", delivery.connectionId].map(
    (sourceId) =>
      ({
        sourceId,
        connectorId: `integration:${sourceId}`,
        status: "active",
        metadata: { key: delivery.channelKey },
      }) as ConnectorRecord,
  );
  const get = vi.fn().mockResolvedValue(connection);
  const resolve = () => resolveAutonomousChannelDestination(delivery, "project", connectors, { get });
  await expect(resolve()).resolves.toEqual({ connector: connectors[1], target });
  expect(get).toHaveBeenCalledWith(delivery.connectionId);
  get.mockResolvedValueOnce({ ...connection, revision: "new-revision" });
  await expect(resolve()).resolves.toBeUndefined();
  get.mockResolvedValueOnce({
    ...connection,
    config: { ...connection.config, defaultChannelId: "123456789012000000" },
  });
  await expect(resolve()).resolves.toBeUndefined();
  get.mockResolvedValueOnce({ ...connection, config: { ...connection.config, runtimeMode: "bridge" } });
  await expect(resolve()).resolves.toBeUndefined();
  get.mockResolvedValueOnce({ ...connection, workspaceId: "other" });
  await expect(resolve()).resolves.toBeUndefined();
});
