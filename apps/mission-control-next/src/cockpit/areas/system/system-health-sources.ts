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
import { describeApiError, type ApiErrorDescription } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import type { HealthSummaryResponse } from "@goatcitadel/mission-control-shared/api/types";

/** `deferred`: not read here; the full check runs on System › Health. */
export type HealthSource<T> =
  | { state: "current"; value: T; observedAt?: number }
  | { state: "unavailable"; detail: string; category?: ApiErrorDescription["category"]; retryable?: boolean;
      lastKnown?: { value: T; observedAt?: number } }
  | { state: "deferred" };
const CHANNEL_LIMIT = 20;

async function read<T>(work: () => Promise<T>, previous?: HealthSource<T>): Promise<HealthSource<T>> {
  // Only the caller's installation/workspace/access-scoped query record can suppress this read.
  if (previous?.state === "unavailable" && previous.retryable === false) return previous;
  try {
    return { state: "current", value: await work(), observedAt: Date.now() };
  } catch (error) {
    const description = describeApiError(error);
    const lastKnown = previous?.state === "current" ? { value: previous.value, observedAt: previous.observedAt }
      : previous?.state === "unavailable" ? previous.lastKnown : undefined;
    return { state: "unavailable", detail: description.summary, category: description.category,
      retryable: description.retryable !== false, ...(lastKnown ? { lastKnown } : {}) };
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
  return mapSource(response, (value) => value.items);
}

function connectionResponse(previous?: HealthSource<IntegrationConnection[]>): HealthSource<{ items: IntegrationConnection[] }> | undefined {
  return previous ? mapSource(previous, (value) => ({ items: value })) : undefined;
}

function mapSource<T, U>(source: HealthSource<T>, map: (value: T) => U): HealthSource<U> {
  if (source.state === "current") return { ...source, value: map(source.value) };
  if (source.state === "deferred") return source;
  const { lastKnown, ...failure } = source;
  return { ...failure, ...(lastKnown ? { lastKnown: { ...lastKnown, value: map(lastKnown.value) } } : {}) };
}

export function staleHealthSources(sources: SystemHealthSources) {
  const stale = Object.entries(sources).flatMap(([name, source]) => source.state === "unavailable" && source.lastKnown
    ? [{ name: name as keyof SystemHealthSources, observedAt: source.lastKnown.observedAt }] : []);
  if (sources.channels.state === "current") for (const entry of sources.channels.value.checked) {
    if (entry.runtime.state === "unavailable" && entry.runtime.lastKnown) stale.push({ name: "channels", observedAt: entry.runtime.lastKnown.observedAt });
  }
  return stale;
}

/** Presentation-only prior observations; callers must label them stale, never fresh health. */
export function retainedHealthObservations(sources: SystemHealthSources): SystemHealthSources {
  const retained = <T>(source: HealthSource<T>): HealthSource<T> => source.state === "unavailable" && source.lastKnown
    ? { state: "current", value: source.lastKnown.value, observedAt: source.lastKnown.observedAt } : source;
  const channels = retained(sources.channels);
  return { summary: retained(sources.summary), llama: retained(sources.llama), npu: retained(sources.npu),
    connections: retained(sources.connections), workers: retained(sources.workers),
    channels: channels.state === "current" ? { ...channels, value: { ...channels.value,
      checked: channels.value.checked.map((entry) => ({ ...entry, runtime: retained(entry.runtime) })) } } : channels };
}

/**
 * The cheap digest behind the sidebar dot and the phone strip: four reads (summary, llama.cpp, NPU and
 * connections). Channel runtimes and remote workers are deferred to System › Health (NV-09).
 */
export async function loadSystemHealthDigest(previous?: SystemHealthSources): Promise<SystemHealthSources> {
  const [summary, llama, npu, connections] = await Promise.all([
    read(() => fetchHealthSummary(), previous?.summary),
    read(() => fetchLlamaCppStatus(), previous?.llama),
    read(() => fetchNpuStatus(), previous?.npu),
    read(() => fetchIntegrationConnections(), connectionResponse(previous?.connections)),
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
export async function loadSystemHealthSources(workspaceId: string, previous?: SystemHealthSources): Promise<SystemHealthSources> {
  const [summary, llama, npu, connectionsResponse, workers] = await Promise.all([
    read(() => fetchHealthSummary(), previous?.summary),
    read(() => fetchLlamaCppStatus(), previous?.llama),
    read(() => fetchNpuStatus(), previous?.npu),
    read(() => fetchIntegrationConnections(), connectionResponse(previous?.connections)),
    read(() => fetchRemoteWorkerRegistry(workspaceId, { limit: 100 }), previous?.workers),
  ]);
  const connections = connectionItems(connectionsResponse);
  if (connections.state !== "current")
    return {
      summary,
      llama,
      npu,
      connections,
      workers,
      channels: { state: "unavailable", detail: "Channel connections could not be listed.",
        ...(connections.state === "unavailable" ? { category: connections.category, retryable: connections.retryable } : {}),
        ...(previous?.channels.state === "current" ? { lastKnown: { value: previous.channels.value, observedAt: previous.channels.observedAt } }
          : previous?.channels.state === "unavailable" && previous.channels.lastKnown ? { lastKnown: previous.channels.lastKnown } : {}) },
    };
  const enabled = connections.value.filter((connection) => connection.kind === "channel" && connection.enabled);
  const earlierChannels = previous?.channels.state === "current" ? previous.channels.value
    : previous?.channels.state === "unavailable" ? previous.channels.lastKnown?.value : undefined;
  const checked = await Promise.all(
    enabled.slice(0, CHANNEL_LIMIT).map(async (connection) => ({
      connection,
      runtime: await read(() => fetchChannelRuntimeStatus(connection.connectionId), earlierChannels?.checked.find((item) => item.connection.connectionId === connection.connectionId)?.runtime),
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
