import { describe, expect, it, vi } from "vitest";
import { evaluateChannelInboundAccess, type IntegrationConnection } from "@goatcitadel/contracts";
import {
  LEGACY_OPEN_STAMP_SETTING_KEY,
  stampLegacyOpenChannelInboundAccess,
} from "./channel-inbound-access-migration.js";

const NOW = "2026-07-07T12:00:00.000Z";

function connection(input: {
  connectionId: string;
  kind?: IntegrationConnection["kind"];
  key?: string;
  config?: Record<string, unknown>;
  label?: string;
}): IntegrationConnection {
  return {
    connectionId: input.connectionId,
    catalogId: "channels.telegram",
    kind: input.kind ?? "channel",
    key: input.key ?? "telegram",
    label: input.label ?? input.connectionId,
    enabled: true,
    status: "connected",
    config: input.config ?? {},
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as IntegrationConnection;
}

function createHarness(connections: IntegrationConnection[], settings: Record<string, unknown> = {}) {
  const settingsMap = new Map<string, unknown>(Object.entries(settings));
  const updated = new Map<string, Record<string, unknown>>();
  const deps = {
    storage: {
      integrationConnections: {
        list: vi.fn(() => connections),
        update: vi.fn((connectionId: string, input: { config: Record<string, unknown> }) => {
          updated.set(connectionId, input.config);
          const current = connections.find((item) => item.connectionId === connectionId);
          return { ...current, config: input.config } as IntegrationConnection;
        }),
      },
      systemSettings: {
        get: vi.fn(<T>(key: string) => (settingsMap.has(key) ? { value: settingsMap.get(key) as T } : undefined)),
        set: vi.fn((key: string, value: unknown) => {
          settingsMap.set(key, value);
        }),
      },
    },
    publishRealtime: vi.fn(() => ({ eventId: "event-1" }) as never),
    recordDevDiagnostic: vi.fn(),
    now: NOW,
  };
  return { deps, updated, settingsMap };
}

describe("stampLegacyOpenChannelInboundAccess", () => {
  it("stamps exactly the ambiguous class and leaves every other posture untouched", () => {
    const target = connection({ connectionId: "conn-legacy" });
    const openByDesign = connection({ connectionId: "conn-tui", key: "tui" });
    const nonChannel = connection({ connectionId: "conn-service", kind: "service" as never });
    const modeSet = connection({ connectionId: "conn-allowlist", config: { inboundAccessMode: "allowlist" } });
    const explicitOpen = connection({ connectionId: "conn-open", config: { inboundAccessMode: "open_legacy" } });
    const sendersSet = connection({ connectionId: "conn-senders", config: { allowedSenders: ["123"] } });

    const { deps, updated, settingsMap } = createHarness([
      target,
      openByDesign,
      nonChannel,
      modeSet,
      explicitOpen,
      sendersSet,
    ]);

    const result = stampLegacyOpenChannelInboundAccess(deps);

    expect(result).toEqual({ ranNow: true, stampedConnectionIds: ["conn-legacy"] });
    expect([...updated.keys()]).toEqual(["conn-legacy"]);
    expect(updated.get("conn-legacy")).toMatchObject({
      inboundAccessMode: "open_legacy",
      inboundAccessMigratedAt: NOW,
    });
    expect(settingsMap.get(LEGACY_OPEN_STAMP_SETTING_KEY)).toMatchObject({
      completedAt: NOW,
      stampedConnectionIds: ["conn-legacy"],
    });
    expect(deps.publishRealtime).toHaveBeenCalledTimes(1);
    expect(deps.publishRealtime).toHaveBeenCalledWith(
      "channel_inbound_access_migrated",
      "channels",
      expect.objectContaining({ count: 1, connectionIds: ["conn-legacy"] }),
      expect.objectContaining({ eventClass: "ui_notification" }),
    );
  });

  it("keeps the gate allowing after the stamp, with the explicit legacy reason", () => {
    const stamped = {
      inboundAccessMode: "open_legacy",
      inboundAccessMigratedAt: NOW,
    };
    const decision = evaluateChannelInboundAccess({ config: stamped, actorId: "12345" });
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("legacy_open_explicit");
    expect(decision.legacyWarning).toBeTruthy();
  });

  it("is a no-op on the second run via the done-marker", () => {
    const target = connection({ connectionId: "conn-legacy" });
    const { deps, updated } = createHarness([target], {
      [LEGACY_OPEN_STAMP_SETTING_KEY]: { completedAt: NOW, stampedConnectionIds: ["conn-legacy"] },
    });

    const result = stampLegacyOpenChannelInboundAccess(deps);

    expect(result).toEqual({ ranNow: false, stampedConnectionIds: [] });
    expect(updated.size).toBe(0);
    expect(deps.publishRealtime).not.toHaveBeenCalled();
    expect(deps.storage.systemSettings.set).not.toHaveBeenCalled();
  });

  it("emits no notification when nothing needed stamping, but still sets the marker", () => {
    const { deps, settingsMap } = createHarness([
      connection({ connectionId: "conn-allowlist", config: { inboundAccessMode: "allowlist" } }),
    ]);

    const result = stampLegacyOpenChannelInboundAccess(deps);

    expect(result).toEqual({ ranNow: true, stampedConnectionIds: [] });
    expect(deps.publishRealtime).not.toHaveBeenCalled();
    expect(settingsMap.get(LEGACY_OPEN_STAMP_SETTING_KEY)).toMatchObject({ completedAt: NOW });
  });

  it("stops without the done-marker when a write fails, so the next boot retries", () => {
    const first = connection({ connectionId: "conn-a" });
    const second = connection({ connectionId: "conn-b" });
    const { deps, settingsMap } = createHarness([first, second]);
    deps.storage.integrationConnections.update.mockImplementationOnce(() => {
      throw new Error("db locked");
    });

    const result = stampLegacyOpenChannelInboundAccess(deps);

    expect(result.ranNow).toBe(true);
    expect(result.stampedConnectionIds).toEqual([]);
    expect(settingsMap.has(LEGACY_OPEN_STAMP_SETTING_KEY)).toBe(false);
    expect(deps.recordDevDiagnostic).toHaveBeenCalledWith(
      expect.objectContaining({ event: "channel.inbound_access_legacy_stamp_failed" }),
    );
  });
});
