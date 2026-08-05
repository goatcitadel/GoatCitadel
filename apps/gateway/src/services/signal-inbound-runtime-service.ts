import type { IntegrationConnection } from "@goatcitadel/contracts";

export const SIGNAL_INBOUND_BLOCKED_REASON =
  "Signal is outbound-only because the current signal-cli bridge receive endpoint has no acknowledgement or replay contract.";

export interface SignalInboundRuntimeCallbacks {
  /** Legacy flag retained only so old true values can produce operator evidence. */
  isEnabled(): Promise<boolean>;
  listConnections(): Promise<IntegrationConnection[]>;
  recordDevDiagnostic?: (input: {
    level: "info" | "warn" | "error";
    category: string;
    event: string;
    message: string;
    context?: Record<string, unknown>;
  }) => void;
}

/**
 * Compatibility facade for the retired Signal receive poller.
 *
 * The signal-cli REST receive endpoint destructively drains its upstream queue
 * before GoatCitadel can commit the payload and exposes no offset/ack/replay
 * contract. Therefore this service intentionally owns no scheduler, fetcher,
 * receive URL, or inbound dispatcher. `sync()` only turns legacy configuration
 * into durable operator-visible evidence. Outbound Signal sending remains owned
 * by the existing JSON-RPC send path.
 */
export class SignalInboundRuntimeService {
  private readonly reportedPostures = new Set<string>();
  private closed = false;

  public constructor(private readonly callbacks: SignalInboundRuntimeCallbacks) {}

  public async sync(): Promise<void> {
    if (this.closed) {
      return;
    }

    const legacyFeatureEnabled = await this.callbacks.isEnabled();
    const signalConnections = (await this.callbacks.listConnections()).filter(
      (connection) => connection.kind === "channel" && connection.key === "signal",
    );

    if (legacyFeatureEnabled && signalConnections.length === 0) {
      this.reportBlockedPosture("feature:global", {
        legacyFeatureEnabled: true,
        legacyConnectionInboundEnabled: false,
      });
    }

    for (const connection of signalConnections) {
      const legacyConnectionInboundEnabled = readLegacyInboundEnabled(connection.config);
      if (!legacyFeatureEnabled && !legacyConnectionInboundEnabled) {
        continue;
      }
      this.reportBlockedPosture(
        `connection:${connection.connectionId}:${legacyFeatureEnabled}:${legacyConnectionInboundEnabled}`,
        {
          connectionId: connection.connectionId,
          legacyFeatureEnabled,
          legacyConnectionInboundEnabled,
          connectionEnabled: connection.enabled,
          connectionStatus: connection.status,
        },
      );
    }
  }

  public stop(): void {
    this.closed = true;
  }

  /** No Signal inbound poller can exist in this runtime posture. */
  public get activePollerCount(): number {
    return 0;
  }

  private reportBlockedPosture(key: string, context: Record<string, unknown>): void {
    if (this.reportedPostures.has(key)) {
      return;
    }
    this.reportedPostures.add(key);
    this.callbacks.recordDevDiagnostic?.({
      level: "warn",
      category: "channels",
      event: "signal.inbound.blocked_outbound_only",
      message: SIGNAL_INBOUND_BLOCKED_REASON,
      context: {
        ...context,
        legacyFeatureFlag: "signalInboundV1Enabled",
        bridgeCapability: "no_ack_or_replay",
        effectivePosture: "outbound_only",
        remediation:
          "Disable the legacy Signal inbound setting. Inbound can return only after the bridge exposes a durable offset/ack/replay contract.",
      },
    });
  }
}

export function readLegacyInboundEnabled(config: Record<string, unknown>): boolean {
  const value = config.inboundEnabled;
  return value === true || (typeof value === "string" && value.trim().toLowerCase() === "true");
}
