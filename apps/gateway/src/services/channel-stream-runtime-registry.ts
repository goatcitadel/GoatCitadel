import type { IntegrationConnection } from "@goatcitadel/contracts";
import {
  dispatchInboundWebhookMessage,
  type DurableInboundChannelAcceptInput,
  type DurableInboundChannelAcceptResult,
} from "./channel-inbound-dispatch.js";
import { createNtfyStreamAdapter } from "./channel-stream-adapters/ntfy-stream-adapter.js";
import { ChannelStreamRuntimeService, type ChannelStreamEvent } from "./channel-stream-runtime-service.js";

/** The narrow Gateway surface the stream runtime needs. All members are read lazily, at call time. */
export interface ChannelStreamRuntimeHost {
  storage: { integrationConnections: { list(workspaceId?: string, limit?: number): Promise<IntegrationConnection[]> } };
  acceptInboundChannelEvent(input: DurableInboundChannelAcceptInput): Promise<DurableInboundChannelAcceptResult>;
  recordDevDiagnostic(input: {
    level: "info" | "warn" | "error";
    category: string;
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }): void;
  resolveConnectionSecret(
    config: Record<string, unknown>,
    directKey: string,
    envKey: string,
    catalogId?: string,
  ): string | undefined;
  isConnectionUrlAllowlisted(urlValue: string): boolean;
}

const runtimes = new WeakMap<object, ChannelStreamRuntimeService>();
// Keyed by storage: it is the one object the Gateway and its route-composition port share.

/**
 * Returns the one channel stream runtime for a Gateway host, creating it with
 * every registered stream adapter on first use. The Gateway lifecycle
 * (startup sync, shutdown close) and the route composition (status, connection
 * commit sync) share this instance. Only `host.storage` is read here; every
 * other member is read lazily when the runtime runs.
 */
export function getChannelStreamRuntime(host: ChannelStreamRuntimeHost): ChannelStreamRuntimeService {
  const key = host.storage;
  let runtime = runtimes.get(key);
  if (!runtime) {
    runtime = createStreamRuntime(host);
    runtimes.set(key, runtime);
  }
  return runtime;
}

function createStreamRuntime(host: ChannelStreamRuntimeHost): ChannelStreamRuntimeService {
  const dispatch = (connection: IntegrationConnection, event: ChannelStreamEvent) =>
    dispatchInboundWebhookMessage(
      {
        acceptInboundChannelEvent: (input) => host.acceptInboundChannelEvent(input),
        recordDevDiagnostic: (input) => host.recordDevDiagnostic(input),
      },
      {
        channel: connection.key,
        connectionId: connection.connectionId,
        idempotencyKey: event.idempotencyKey,
        eventType: event.eventType,
        bindingTarget: event.bindingTarget,
        inboundAccessConfig: connection.config,
        acceptedConnectionRevision: connection.revision,
        message: event.message,
      },
    );
  return new ChannelStreamRuntimeService({
    listConnections: async () => await host.storage.integrationConnections.list(undefined, 1000),
    adapters: [
      createNtfyStreamAdapter({
        // Plain fetch: a persistent stream must not inherit the diagnostics request timeout.
        fetch: (input, init) => fetch(input, init),
        resolveSecret: (config, directKey, envKey, catalogId) =>
          host.resolveConnectionSecret(config, directKey, envKey, catalogId),
        isUrlAllowlisted: (urlValue) => host.isConnectionUrlAllowlisted(urlValue),
      }),
    ],
    dispatch,
    recordDevDiagnostic: (input) => host.recordDevDiagnostic(input),
  });
}
