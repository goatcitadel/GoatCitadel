import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "@goatcitadel/contracts";
import {
  SIGNAL_INBOUND_BLOCKED_REASON,
  SignalInboundRuntimeService,
  readLegacyInboundEnabled,
} from "./signal-inbound-runtime-service.js";

describe("SignalInboundRuntimeService outbound-only posture", () => {
  it("never schedules, receives, or claims inbound work when every legacy switch is true", async () => {
    const receiveBridge = vi.fn();
    const schedule = vi.fn();
    const acceptInboundChannelEvents = vi.fn();
    const recordDevDiagnostic = vi.fn();
    const callbacks = {
      isEnabled: async () => true,
      listConnections: async () => [createSignalConnection({ inboundEnabled: true, pollIntervalSeconds: 5 })],
      recordDevDiagnostic,
      // Deliberate legacy extras: the compatibility facade must never touch
      // these even if an older composition still supplies them at runtime.
      fetchBridge: receiveBridge,
      scheduler: { schedule, cancel: vi.fn() },
      integrationWebhooks: { acceptInboundChannelEvents },
    };
    const service = new SignalInboundRuntimeService(callbacks);

    await service.sync();

    expect(service.activePollerCount).toBe(0);
    expect(schedule).not.toHaveBeenCalled();
    expect(receiveBridge).not.toHaveBeenCalled();
    expect(acceptInboundChannelEvents).not.toHaveBeenCalled();
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        level: "warn",
        category: "channels",
        event: "signal.inbound.blocked_outbound_only",
        message: SIGNAL_INBOUND_BLOCKED_REASON,
        context: expect.objectContaining({
          connectionId: "conn-signal-1",
          legacyFeatureEnabled: true,
          legacyConnectionInboundEnabled: true,
          effectivePosture: "outbound_only",
          bridgeCapability: "no_ack_or_replay",
        }),
      }),
    );
  });

  it("reports a legacy global feature value once even without a Signal connection", async () => {
    const recordDevDiagnostic = vi.fn();
    const service = new SignalInboundRuntimeService({
      isEnabled: async () => true,
      listConnections: async () => [],
      recordDevDiagnostic,
    });

    await service.sync();
    await service.sync();

    expect(recordDevDiagnostic).toHaveBeenCalledTimes(1);
    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "signal.inbound.blocked_outbound_only",
        context: expect.objectContaining({ legacyFeatureEnabled: true, legacyConnectionInboundEnabled: false }),
      }),
    );
  });

  it("reports connection-level legacy inbound=true even when the old feature flag is false", async () => {
    const recordDevDiagnostic = vi.fn();
    const service = new SignalInboundRuntimeService({
      isEnabled: async () => false,
      listConnections: async () => [createSignalConnection({ inboundEnabled: "true" })],
      recordDevDiagnostic,
    });

    await service.sync();

    expect(recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "signal.inbound.blocked_outbound_only",
        context: expect.objectContaining({
          legacyFeatureEnabled: false,
          legacyConnectionInboundEnabled: true,
        }),
      }),
    );
  });

  it("keeps a clean outbound-only connection quiet and stop prevents later reconciliation", async () => {
    let featureEnabled = false;
    const recordDevDiagnostic = vi.fn();
    const service = new SignalInboundRuntimeService({
      isEnabled: async () => featureEnabled,
      listConnections: async () => [createSignalConnection({})],
      recordDevDiagnostic,
    });

    await service.sync();
    expect(recordDevDiagnostic).not.toHaveBeenCalled();
    service.stop();
    featureEnabled = true;
    await service.sync();
    expect(recordDevDiagnostic).not.toHaveBeenCalled();
    expect(service.activePollerCount).toBe(0);
  });

  it("recognizes only explicit legacy true values", () => {
    expect(readLegacyInboundEnabled({ inboundEnabled: true })).toBe(true);
    expect(readLegacyInboundEnabled({ inboundEnabled: " TRUE " })).toBe(true);
    expect(readLegacyInboundEnabled({ inboundEnabled: false })).toBe(false);
    expect(readLegacyInboundEnabled({ inboundEnabled: "false" })).toBe(false);
    expect(readLegacyInboundEnabled({})).toBe(false);
  });
});

function createSignalConnection(config: Record<string, unknown>): IntegrationConnection {
  return {
    connectionId: "conn-signal-1",
    catalogId: "channel.signal",
    kind: "channel",
    key: "signal",
    label: "Signal",
    enabled: true,
    status: "connected",
    config: {
      baseUrl: "http://127.0.0.1:8080",
      accountId: "+15559990000",
      defaultRecipient: "+15551230000",
      ...config,
    },
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}
