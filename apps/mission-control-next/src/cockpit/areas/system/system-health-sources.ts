import type {
  ChannelRuntimeStatus,
  IntegrationConnection,
  LlamaCppRuntimeStatus,
  NpuRuntimeStatus,
  RemoteWorkerRegistryPage,
} from "@goatcitadel/contracts";
import { fetchHealthSummary } from "@goatcitadel/mission-control-shared/api/client";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { getGatewayAccessRevision } from "@goatcitadel/mission-control-shared/api/access-scope";
import { describeApiError, type ApiErrorDescription } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import type { HealthSummaryResponse } from "@goatcitadel/mission-control-shared/api/types";

/** `deferred`: not read here; the full check runs on System › Health. */
export type HealthSource<T> =
  | { state: "current"; value: T; observedAt?: number }
  | {
      state: "unavailable";
      detail: string;
      category?: ApiErrorDescription["category"];
      retryable?: boolean;
      lastKnown?: { value: T; observedAt?: number };
    }
  | { state: "deferred" };

export async function readHealthSource<T>(work: () => Promise<T>, previous?: HealthSource<T>): Promise<HealthSource<T>> {
  // Only the caller's installation/workspace/access-scoped query record can suppress this read.
  if (previous?.state === "unavailable" && previous.retryable === false) return previous;
  try {
    return { state: "current", value: await work(), observedAt: Date.now() };
  } catch (error) {
    const description = describeApiError(error);
    const lastKnown =
      previous?.state === "current"
        ? { value: previous.value, observedAt: previous.observedAt }
        : previous?.state === "unavailable"
          ? previous.lastKnown
          : undefined;
    return {
      state: "unavailable",
      detail: description.summary,
      category: description.category,
      retryable: description.retryable !== false,
      ...(lastKnown ? { lastKnown } : {}),
    };
  }
}

export function loadHealthSummarySource(previous?: HealthSource<HealthSummaryResponse>) {
  return readHealthSource(() => fetchHealthSummary(), previous);
}

async function withHealthDetailCode(
  dispatch: (detail: typeof import("./system-health-source-details")) => Promise<SystemHealthSources>,
  signal?: AbortSignal,
) {
  signal?.throwIfAborted();
  const installation = getGatewayApiBaseUrl();
  const access = getGatewayAccessRevision();
  const detail = await import("./system-health-source-details");
  // Loading code grants no permission to read on behalf of the previous query owner.
  signal?.throwIfAborted();
  if (getGatewayApiBaseUrl() !== installation || getGatewayAccessRevision() !== access)
    throw new DOMException("Health check scope changed", "AbortError");
  return dispatch(detail);
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

export function staleHealthSources(sources: SystemHealthSources) {
  const stale = Object.entries(sources).flatMap(([name, source]) =>
    source.state === "unavailable" && source.lastKnown
      ? [{ name: name as keyof SystemHealthSources, observedAt: source.lastKnown.observedAt }]
      : [],
  );
  if (sources.channels.state === "current")
    for (const entry of sources.channels.value.checked) {
      if (entry.runtime.state === "unavailable" && entry.runtime.lastKnown)
        stale.push({ name: "channels", observedAt: entry.runtime.lastKnown.observedAt });
    }
  return stale;
}

/** Presentation-only prior observations; callers must label them stale, never fresh health. */
export function retainedHealthObservations(sources: SystemHealthSources): SystemHealthSources {
  const retained = <T>(source: HealthSource<T>): HealthSource<T> =>
    source.state === "unavailable" && source.lastKnown
      ? { state: "current", value: source.lastKnown.value, observedAt: source.lastKnown.observedAt }
      : source;
  const channels = retained(sources.channels);
  return {
    summary: retained(sources.summary),
    llama: retained(sources.llama),
    npu: retained(sources.npu),
    connections: retained(sources.connections),
    workers: retained(sources.workers),
    channels:
      channels.state === "current"
        ? {
            ...channels,
            value: {
              ...channels.value,
              checked: channels.value.checked.map((entry) => ({ ...entry, runtime: retained(entry.runtime) })),
            },
          }
        : channels,
  };
}

/**
 * Core shell status reads the summary only. Detailed callers retain the four-source digest;
 * optional inspections and the full channel/worker fan-out run on System › Health.
 */
export async function loadSystemHealthDigest(
  previous?: SystemHealthSources,
  options: { deferOptionalSources?: boolean; signal?: AbortSignal } = {},
): Promise<SystemHealthSources> {
  if (!options.deferOptionalSources)
    return withHealthDetailCode(({ loadDetailedHealthDigest }) => loadDetailedHealthDigest(previous), options.signal);
  return {
    summary: await loadHealthSummarySource(previous?.summary),
    llama: { state: "deferred" },
    npu: { state: "deferred" },
    connections: { state: "deferred" },
    channels: { state: "deferred" },
    workers: { state: "deferred" },
  };
}

/** Independent owner reads preserve partial truth when one service is unavailable. */
export async function loadSystemHealthSources(
  workspaceId: string,
  previous?: SystemHealthSources,
  signal?: AbortSignal,
): Promise<SystemHealthSources> {
  return withHealthDetailCode(
    ({ loadDetailedHealthSources }) => loadDetailedHealthSources(workspaceId, previous),
    signal,
  );
}
