import { describeRetiredChannel, type IntegrationConnection } from "@goatcitadel/contracts";
import {
  fetchIntegrationConnections,
  fetchChannelRuntimeStatus,
  fetchLlamaCppStatus,
  fetchNpuStatus,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  loadHealthSummarySource,
  readHealthSource,
  type HealthSource,
  type SystemHealthSources,
} from "./system-health-sources";

const CHANNEL_LIMIT = 20;

function connectionItems(
  response: HealthSource<{ items: IntegrationConnection[] }>,
): HealthSource<IntegrationConnection[]> {
  return mapSource(response, (value) => value.items);
}

function connectionResponse(
  previous?: HealthSource<IntegrationConnection[]>,
): HealthSource<{ items: IntegrationConnection[] }> | undefined {
  return previous ? mapSource(previous, (value) => ({ items: value })) : undefined;
}

function mapSource<T, U>(source: HealthSource<T>, map: (value: T) => U): HealthSource<U> {
  if (source.state === "current") return { ...source, value: map(source.value) };
  if (source.state === "deferred") return source;
  const { lastKnown, ...failure } = source;
  return { ...failure, ...(lastKnown ? { lastKnown: { ...lastKnown, value: map(lastKnown.value) } } : {}) };
}

export async function loadDetailedHealthDigest(previous?: SystemHealthSources): Promise<SystemHealthSources> {
  const [summary, llama, npu, connections] = await Promise.all([
    loadHealthSummarySource(previous?.summary),
    readHealthSource(() => fetchLlamaCppStatus(), previous?.llama),
    readHealthSource(() => fetchNpuStatus(), previous?.npu),
    readHealthSource(() => fetchIntegrationConnections(), connectionResponse(previous?.connections)),
  ]);
  return {
    summary,
    llama,
    npu,
    connections: connectionItems(connections),
    channels: { state: "deferred" },
    workers: { state: "deferred" },
  };
}

/** Independent owner reads preserve partial truth when one service is unavailable. */
export async function loadDetailedHealthSources(
  workspaceId: string,
  previous?: SystemHealthSources,
): Promise<SystemHealthSources> {
  const [summary, llama, npu, connectionsResponse, workers] = await Promise.all([
    loadHealthSummarySource(previous?.summary),
    readHealthSource(() => fetchLlamaCppStatus(), previous?.llama),
    readHealthSource(() => fetchNpuStatus(), previous?.npu),
    readHealthSource(() => fetchIntegrationConnections(), connectionResponse(previous?.connections)),
    readHealthSource(
      async () =>
        (await import("@goatcitadel/mission-control-shared/api/remote-workers")).fetchRemoteWorkerRegistry(
          workspaceId,
          { limit: 100 },
        ),
      previous?.workers,
    ),
  ]);
  const connections = connectionItems(connectionsResponse);
  if (connections.state !== "current")
    return {
      summary,
      llama,
      npu,
      connections,
      workers,
      channels: {
        state: "unavailable",
        detail: "Channel connections could not be listed.",
        ...(connections.state === "unavailable"
          ? { category: connections.category, retryable: connections.retryable }
          : {}),
        ...(previous?.channels.state === "current"
          ? { lastKnown: { value: previous.channels.value, observedAt: previous.channels.observedAt } }
          : previous?.channels.state === "unavailable" && previous.channels.lastKnown
            ? { lastKnown: previous.channels.lastKnown }
            : {}),
      },
    };
  // A retired channel's connection stays saved as it was left, but it is out of service for good: not checked, not counted.
  const enabled = connections.value.filter(
    (connection) => connection.kind === "channel" && connection.enabled && !describeRetiredChannel(connection.key),
  );
  const earlierChannels =
    previous?.channels.state === "current"
      ? previous.channels.value
      : previous?.channels.state === "unavailable"
        ? previous.channels.lastKnown?.value
        : undefined;
  const checked = await Promise.all(
    enabled.slice(0, CHANNEL_LIMIT).map(async (connection) => ({
      connection,
      runtime: await readHealthSource(
        () => fetchChannelRuntimeStatus(connection.connectionId),
        earlierChannels?.checked.find((item) => item.connection.connectionId === connection.connectionId)?.runtime,
      ),
    })),
  );
  return {
    summary,
    llama,
    npu,
    connections,
    workers,
    channels: { state: "current", value: { enabledCount: enabled.length, checked }, observedAt: Date.now() },
  };
}
