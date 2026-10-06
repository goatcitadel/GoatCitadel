import type {
  ChannelRuntimeStatus,
  IntegrationConnection,
  LlamaCppRuntimeStatus,
  NpuRuntimeStatus,
  RemoteWorkerRegistryPage,
} from "@goatcitadel/contracts";
import {
  fetchHealthSummary,
  fetchIntegrationConnections,
  fetchChannelRuntimeStatus,
  fetchLlamaCppStatus,
  fetchNpuStatus,
} from "@goatcitadel/mission-control-shared/api/client";
import { fetchRemoteWorkerRegistry } from "@goatcitadel/mission-control-shared/api/remote-workers";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import type { HealthSummaryResponse } from "@goatcitadel/mission-control-shared/api/types";

/** `deferred`: not read here; the full check runs on System › Health. */
export type HealthSource<T> =
  | { state: "current"; value: T }
  | { state: "unavailable"; detail: string }
  | { state: "deferred" };
const CHANNEL_LIMIT = 20;

async function read<T>(work: Promise<T>): Promise<HealthSource<T>> {
  try {
    return { state: "current", value: await work };
  } catch (error) {
    return { state: "unavailable", detail: describeApiError(error).summary };
  }
}

export interface SystemHealthSources {
  summary: HealthSource<HealthSummaryResponse>;
  llama: HealthSource<LlamaCppRuntimeStatus>;
  npu: HealthSource<NpuRuntimeStatus>;
  connections: HealthSource<IntegrationConnection[]>;
  channels: HealthSource<{
    enabledCount: number;
    checked: Array<{ connection: IntegrationConnection; runtime: HealthSource<ChannelRuntimeStatus> }>;
  }>;
  workers: HealthSource<RemoteWorkerRegistryPage>;
}

function connectionItems(
  response: HealthSource<{ items: IntegrationConnection[] }>,
): HealthSource<IntegrationConnection[]> {
  return response.state === "current" ? { state: "current", value: response.value.items } : response;
}

/**
 * The cheap digest behind the sidebar dot and the phone strip: four reads (summary, llama.cpp, NPU and
 * connections). Channel runtimes and remote workers are deferred to System › Health (NV-09).
 */
export async function loadSystemHealthDigest(): Promise<SystemHealthSources> {
  const [summary, llama, npu, connections] = await Promise.all([
    read(fetchHealthSummary()),
    read(fetchLlamaCppStatus()),
    read(fetchNpuStatus()),
    read(fetchIntegrationConnections()),
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
export async function loadSystemHealthSources(workspaceId: string): Promise<SystemHealthSources> {
  const [summary, llama, npu, connectionsResponse, workers] = await Promise.all([
    read(fetchHealthSummary()),
    read(fetchLlamaCppStatus()),
    read(fetchNpuStatus()),
    read(fetchIntegrationConnections()),
    read(fetchRemoteWorkerRegistry(workspaceId, { limit: 100 })),
  ]);
  const connections = connectionItems(connectionsResponse);
  if (connections.state !== "current")
    return {
      summary,
      llama,
      npu,
      connections,
      workers,
      channels: { state: "unavailable", detail: "Channel connections could not be listed." },
    };
  const enabled = connections.value.filter((connection) => connection.kind === "channel" && connection.enabled);
  const checked = await Promise.all(
    enabled.slice(0, CHANNEL_LIMIT).map(async (connection) => ({
      connection,
      runtime: await read(fetchChannelRuntimeStatus(connection.connectionId)),
    })),
  );
  return {
    summary,
    llama,
    npu,
    connections,
    workers,
    channels: { state: "current", value: { enabledCount: enabled.length, checked } },
  };
}
