import type { IntegrationConnection } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import {
  dispatchInboundWebhookMessage,
  type DurableInboundChannelAcceptInput,
  type DurableInboundChannelAcceptResult,
} from "./channel-inbound-dispatch.js";
import type { ChannelSecretOwner } from "./channel-secret-resolution.js";
import { createSystemSettingsChannelStreamCursorStore } from "./channel-stream-cursor-store.js";
import { createMatrixStreamAdapter } from "./channel-stream-adapters/matrix-stream-adapter.js";
import { createMattermostStreamAdapter } from "./channel-stream-adapters/mattermost-stream-adapter.js";
import { createNtfyStreamAdapter } from "./channel-stream-adapters/ntfy-stream-adapter.js";
import { createTelegramStreamAdapter } from "./channel-stream-adapters/telegram-stream-adapter.js";
import { ChannelStreamRuntimeService, type ChannelStreamEvent } from "./channel-stream-runtime-service.js";
import { runTelegramUpdate, type TelegramUpdateDeps } from "./telegram-update-processor.js";

/** The narrow Gateway surface the stream runtime needs. All members are read lazily, at call time. */
export interface ChannelStreamRuntimeHost {
  storage: {
    integrationConnections: { list(workspaceId?: string, limit?: number): Promise<IntegrationConnection[]> };
    systemSettings: Pick<AsyncStorage["systemSettings"], "get" | "set">;
  };
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
    catalogId: string | undefined,
    owner: ChannelSecretOwner,
  ): string | undefined;
  isConnectionUrlAllowlisted(urlValue: string): boolean;
}

const runtimes = new WeakMap<object, ChannelStreamRuntimeService>();
// Keyed by storage: it is the one object the Gateway and its route-composition port share.
const telegramUpdateHandlers = new WeakMap<object, TelegramUpdateDeps>();

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
    runtime = createStreamRuntime(host, key);
    runtimes.set(key, runtime);
  }
  return runtime;
}

/**
 * Hands the Telegram poller the update handler the webhook route uses. The route composition owns the
 * integration-webhook port, so it provides it here; polled updates wait (and are retried) until it has.
 */
export function provideTelegramUpdateDeps(
  host: Pick<ChannelStreamRuntimeHost, "storage">,
  deps: TelegramUpdateDeps,
): void {
  telegramUpdateHandlers.set(host.storage, deps);
}

function createStreamRuntime(host: ChannelStreamRuntimeHost, runtimeKey: object): ChannelStreamRuntimeService {
  const recordDevDiagnostic = (input: Parameters<ChannelStreamRuntimeHost["recordDevDiagnostic"]>[0]) =>
    host.recordDevDiagnostic(input);
  const dispatch = (connection: IntegrationConnection, event: ChannelStreamEvent) =>
    dispatchInboundWebhookMessage(
      {
        acceptInboundChannelEvent: (input) => host.acceptInboundChannelEvent(input),
        recordDevDiagnostic,
      },
      {
        channel: connection.key,
        connectionId: connection.connectionId,
        idempotencyKey: event.idempotencyKey,
        eventType: event.eventType,
        bindingTarget: event.bindingTarget,
        // Stream channels never had inbound, so legacy-open (open_legacy or unset) must never apply:
        // force allowlist semantics and keep the connection's allowedSenders (empty means deny all).
        inboundAccessConfig: { ...connection.config, inboundAccessMode: "allowlist" },
        acceptedConnectionRevision: connection.revision,
        message: event.message,
        ...(event.responseOptions ? { responseOptions: event.responseOptions } : {}),
      },
    );
  // Read host.storage.systemSettings at call time, like every other host member.
  const systemSettings = () => host.storage.systemSettings;
  const cursorStore = createSystemSettingsChannelStreamCursorStore({
    get: (key) => systemSettings().get(key),
    set: (key, value, now) => systemSettings().set(key, value, now),
  });
  const sharedDeps = {
    // Plain fetch: a persistent stream must not inherit the diagnostics request timeout.
    fetch: ((input, init) => fetch(input, init)) as typeof fetch,
    resolveSecret: (
      config: Record<string, unknown>,
      directKey: string,
      envKey: string,
      catalogId: string | undefined,
      owner: ChannelSecretOwner,
    ) => host.resolveConnectionSecret(config, directKey, envKey, catalogId, owner),
    isUrlAllowlisted: (urlValue: string) => host.isConnectionUrlAllowlisted(urlValue),
  };
  return new ChannelStreamRuntimeService({
    listConnections: async () => await host.storage.integrationConnections.list(undefined, 1000),
    adapters: [
      createNtfyStreamAdapter(sharedDeps),
      createMattermostStreamAdapter({ ...sharedDeps, createWebSocket: (url) => new WebSocket(url) }),
      createMatrixStreamAdapter({ ...sharedDeps, cursorStore }),
      createTelegramStreamAdapter({
        ...sharedDeps,
        cursorStore,
        // Looked up per update: the route composition provides the handler after this runtime may have started.
        processUpdate: async (connectionId, update) => {
          const deps = telegramUpdateHandlers.get(runtimeKey);
          if (!deps) throw new Error("Telegram receiving isn't ready yet.");
          return await runTelegramUpdate(deps, connectionId, update);
        },
      }),
    ],
    dispatch,
    recordDevDiagnostic,
  });
}
