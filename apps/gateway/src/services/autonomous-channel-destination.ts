import { NotFoundError, type ConnectorRecord, type CronAgentTurnConfig } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { resolveFollowThroughDestination } from "./follow-through-schedule-input.js";

export async function resolveAutonomousChannelDestination(
  delivery: NonNullable<CronAgentTurnConfig["deliveryChannel"]>,
  workspaceId: string,
  connectors: ConnectorRecord[],
  connections: Pick<AsyncStorage["integrationConnections"], "get">,
): Promise<{ connector: ConnectorRecord; target: string } | undefined> {
  const channelKey = delivery.channelKey.trim();
  const explicitTarget = delivery.target?.trim();
  if (delivery.connectionId) {
    try {
      const current = resolveFollowThroughDestination(await connections.get(delivery.connectionId), workspaceId);
      if (
        !explicitTarget ||
        current?.channelKey !== channelKey ||
        current.target !== explicitTarget ||
        current.revision !== delivery.connectionRevision
      )
        return undefined;
    } catch (error) {
      if (error instanceof NotFoundError) return undefined;
      throw error;
    }
  }
  const connector = connectors.find(
    (item) =>
      item.status === "active" &&
      item.metadata?.key === channelKey &&
      (!delivery.connectionId || item.sourceId === delivery.connectionId),
  );
  if (!connector) return undefined;
  const fallback = connector.metadata?.approvalDeliveryTarget;
  const target = explicitTarget || (typeof fallback === "string" ? fallback.trim() : undefined);
  return target ? { connector, target } : undefined;
}
