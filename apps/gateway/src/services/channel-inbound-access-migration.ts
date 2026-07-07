import type { IntegrationConnection, RealtimeEvent } from "@goatcitadel/contracts";
import { resolveAllowedSenders } from "@goatcitadel/contracts";
import { OPEN_INBOUND_CHANNELS } from "./integration-channel-service.js";

/**
 * One-time stamp of the ambiguous "legacy open" inbound-access population.
 *
 * Existing channel connections persisted before the allowlist default (no
 * `inboundAccessMode`, no `allowedSenders`) evaluate as `legacy_open_unset` —
 * open with a warning. This migration makes that state EXPLICIT
 * (`inboundAccessMode: "open_legacy"` + an `inboundAccessMigratedAt`
 * breadcrumb) without changing behavior: the gate keeps allowing (reason
 * becomes `legacy_open_explicit`), diagnostics keep warning, and moving to an
 * allowlist stays a deliberate operator act. The ambiguous class itself dies.
 *
 * Deliberately NOT stamped:
 * - non-channel kinds, and open-by-design channels (tui/ntfy);
 * - configs with an explicit mode (operator already chose);
 * - unset-mode configs WITH allowedSenders — those already evaluate with
 *   allowlist semantics, and stamping them open would LOOSEN security.
 *
 * Idempotent twice over: a system_settings done-marker skips re-runs, and the
 * unset-only predicate means even a wiped marker can never overwrite an
 * operator's later choice.
 */
export const LEGACY_OPEN_STAMP_SETTING_KEY = "channels.inbound_access.legacy_open_stamp.v1";

export interface ChannelInboundAccessMigrationDeps {
  storage: {
    integrationConnections: {
      list(kind?: IntegrationConnection["kind"], limit?: number): IntegrationConnection[];
      update(connectionId: string, input: { config: Record<string, unknown> }): IntegrationConnection;
    };
    systemSettings: {
      get<T>(key: string): { value: T } | undefined;
      set(key: string, value: unknown): void;
    };
  };
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">,
  ): RealtimeEvent;
  recordDevDiagnostic?(input: {
    level: "info" | "warn";
    category: "channels";
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }): void;
  now: string;
}

export interface ChannelInboundAccessMigrationResult {
  ranNow: boolean;
  stampedConnectionIds: string[];
}

export function stampLegacyOpenChannelInboundAccess(
  deps: ChannelInboundAccessMigrationDeps,
): ChannelInboundAccessMigrationResult {
  const marker = deps.storage.systemSettings.get<{ completedAt: string }>(LEGACY_OPEN_STAMP_SETTING_KEY)?.value;
  if (marker?.completedAt) {
    return { ranNow: false, stampedConnectionIds: [] };
  }

  const connections = deps.storage.integrationConnections.list("channel", 1_000);
  const stampedConnectionIds: string[] = [];
  const stampedLabels: string[] = [];

  for (const connection of connections) {
    if (!isLegacyOpenUnset(connection)) {
      continue;
    }
    try {
      deps.storage.integrationConnections.update(connection.connectionId, {
        config: {
          ...connection.config,
          inboundAccessMode: "open_legacy",
          inboundAccessMigratedAt: deps.now,
        },
      });
      stampedConnectionIds.push(connection.connectionId);
      stampedLabels.push(connection.label ?? connection.key);
    } catch (error) {
      // Best-effort per connection: a single failed write must not block boot
      // or the remaining stamps; the connection simply stays in the unset
      // class and is retried on the next boot (marker is only set on success).
      deps.recordDevDiagnostic?.({
        level: "warn",
        category: "channels",
        event: "channel.inbound_access_legacy_stamp_failed",
        message: "failed to stamp legacy-open inbound access on a connection",
        context: {
          connectionId: connection.connectionId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      return { ranNow: true, stampedConnectionIds };
    }
  }

  deps.storage.systemSettings.set(LEGACY_OPEN_STAMP_SETTING_KEY, {
    completedAt: deps.now,
    stampedConnectionIds,
  });

  if (stampedConnectionIds.length > 0) {
    deps.publishRealtime(
      "channel_inbound_access_migrated",
      "channels",
      {
        type: "channel_inbound_access_legacy_stamped",
        count: stampedConnectionIds.length,
        connectionIds: stampedConnectionIds,
        labels: stampedLabels,
        migratedAt: deps.now,
      },
      {
        eventClass: "ui_notification",
        eventAuthority: "derived_projection",
        links: {},
      },
    );
    deps.recordDevDiagnostic?.({
      level: "info",
      category: "channels",
      event: "channel.inbound_access_legacy_stamped",
      message: "stamped legacy-open inbound access to explicit open_legacy",
      context: { count: stampedConnectionIds.length, connectionIds: stampedConnectionIds },
    });
  }

  return { ranNow: true, stampedConnectionIds };
}

function isLegacyOpenUnset(connection: IntegrationConnection): boolean {
  if (connection.kind !== "channel" || OPEN_INBOUND_CHANNELS.has(connection.key)) {
    return false;
  }
  const config = (connection.config ?? {}) as Record<string, unknown>;
  if (config.inboundAccessMode !== undefined) {
    return false;
  }
  return resolveAllowedSenders(config).length === 0;
}
