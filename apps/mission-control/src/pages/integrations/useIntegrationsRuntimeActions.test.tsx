import type { ConnectorDiagnosticReport, DiscordPairingRecord, DiscordRuntimeStatus } from "@goatcitadel/contracts";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useIntegrationsRuntimeActions } from "./useIntegrationsRuntimeActions";

const apiMocks = vi.hoisted(() => ({
  approveDiscordPairing: vi.fn(),
  fetchDiscordPairings: vi.fn(),
  fetchIntegrationConnectionDiagnostics: vi.fn(),
  reconnectDiscordRuntime: vi.fn(),
  revokeDiscordPairing: vi.fn(),
}));

vi.mock("../../api/client", () => ({
  approveDiscordPairing: apiMocks.approveDiscordPairing,
  fetchDiscordPairings: apiMocks.fetchDiscordPairings,
  fetchIntegrationConnectionDiagnostics: apiMocks.fetchIntegrationConnectionDiagnostics,
  reconnectDiscordRuntime: apiMocks.reconnectDiscordRuntime,
  revokeDiscordPairing: apiMocks.revokeDiscordPairing,
}));

type RuntimeActions = ReturnType<typeof useIntegrationsRuntimeActions>;

function pairing(pairingId: string): DiscordPairingRecord {
  return {
    pairingId,
    connectionId: "discord-1",
    status: "pending",
    requestedBy: "coverage",
    createdAt: "2026-05-14T12:00:00.000Z",
    expiresAt: "2026-05-14T13:00:00.000Z",
  } as unknown as DiscordPairingRecord;
}

function runtime(connected: boolean): DiscordRuntimeStatus {
  return {
    connectionId: "discord-1",
    runtimeMode: "bot",
    enabled: true,
    ready: connected,
    guildIds: [],
    connected,
    checkedAt: "2026-05-14T12:00:00.000Z",
  } as unknown as DiscordRuntimeStatus;
}

function renderHarness(connectorDiagnosticsEnabled: boolean): {
  getActions: () => RuntimeActions;
  renderer: ReactTestRenderer;
} {
  let actions: RuntimeActions | null = null;

  function Harness() {
    const [error, setError] = React.useState<string | null>(null);
    const [pluginBusyId, setPluginBusyId] = React.useState<string | null>(null);
    const [diagnosticsByConnectionId, setDiagnosticsByConnectionId] = React.useState<
      Record<string, ConnectorDiagnosticReport>
    >({});
    const [selectedDiagnosticConnectionId, setSelectedDiagnosticConnectionId] = React.useState<string | null>(null);
    const [discordPairingBusyId, setDiscordPairingBusyId] = React.useState<string | null>(null);
    const [discordPairingsByConnectionId, setDiscordPairingsByConnectionId] = React.useState<
      Record<string, { runtime?: DiscordRuntimeStatus; items: DiscordPairingRecord[] }>
    >({});

    actions = useIntegrationsRuntimeActions({
      connectorDiagnosticsEnabled,
      setError,
      setPluginBusyId,
      setDiagnosticsByConnectionId,
      setSelectedDiagnosticConnectionId,
      setDiscordPairingBusyId,
      setDiscordPairingsByConnectionId,
    });

    const pairings = discordPairingsByConnectionId["discord-1"];
    return (
      <span>
        {error ?? "ok"}:{pluginBusyId ?? "plugin-idle"}:{discordPairingBusyId ?? "discord-idle"}:
        {selectedDiagnosticConnectionId ?? "no-diagnostic"}:{Object.keys(diagnosticsByConnectionId).join("|") || "none"}
        :{pairings?.runtime ? (pairings.runtime.ready ? "connected" : "disconnected") : "no-runtime"}:
        {pairings?.items.map((item) => item.pairingId).join("|") || "no-items"}
      </span>
    );
  }

  let renderer!: ReactTestRenderer;
  act(() => {
    renderer = create(<Harness />);
  });

  return {
    getActions: () => {
      expect(actions).toBeTruthy();
      return actions!;
    },
    renderer,
  };
}

function renderedText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => renderedText(item)).join("");
  }
  if (value && typeof value === "object" && "children" in value) {
    return renderedText((value as { children?: unknown }).children);
  }
  return "";
}

describe("useIntegrationsRuntimeActions", () => {
  beforeEach(() => {
    for (const mock of Object.values(apiMocks)) {
      mock.mockReset();
    }
  });

  it("blocks diagnostics when the runtime feature flag is disabled", async () => {
    const { getActions, renderer } = renderHarness(false);

    await act(async () => {
      await getActions().onRunDiagnostics("conn-1");
    });

    expect(renderedText(renderer.toJSON())).toContain("Connector diagnostics are disabled in this runtime.");
    expect(apiMocks.fetchIntegrationConnectionDiagnostics).not.toHaveBeenCalled();
  });

  it("stores successful diagnostics and clears failures back to idle", async () => {
    const { getActions, renderer } = renderHarness(true);
    apiMocks.fetchIntegrationConnectionDiagnostics.mockResolvedValueOnce({
      checkedAt: "2026-05-14T12:00:00.000Z",
      connectorId: "conn-1",
      connectorType: "integration_connection",
      checks: [],
      status: "ok",
    });

    await act(async () => {
      await getActions().onRunDiagnostics("conn-1");
    });

    expect(renderedText(renderer.toJSON())).toContain("ok:plugin-idle:discord-idle:conn-1:conn-1");

    apiMocks.fetchIntegrationConnectionDiagnostics.mockRejectedValueOnce(new Error("diagnostics failed"));
    await act(async () => {
      await getActions().onRunDiagnostics("conn-2");
    });

    expect(renderedText(renderer.toJSON())).toContain("diagnostics failed:plugin-idle");
  });

  it("approves, revokes, reconnects, and refreshes Discord pairing state", async () => {
    const { getActions, renderer } = renderHarness(true);
    apiMocks.approveDiscordPairing.mockResolvedValueOnce({});
    apiMocks.revokeDiscordPairing.mockRejectedValueOnce(new Error("revoke failed"));
    apiMocks.reconnectDiscordRuntime.mockResolvedValueOnce(runtime(true));
    apiMocks.fetchDiscordPairings
      .mockResolvedValueOnce({ runtime: runtime(false), items: [pairing("approved-1")] })
      .mockResolvedValueOnce({ runtime: runtime(true), items: [pairing("reconnected-1")] });

    await act(async () => {
      await getActions().onApproveDiscordPairing("discord-1", "pairing-1");
    });

    expect(apiMocks.approveDiscordPairing).toHaveBeenCalledWith("discord-1", "pairing-1");
    expect(renderedText(renderer.toJSON())).toContain("disconnected:approved-1");

    await act(async () => {
      await getActions().onRevokeDiscordPairing("discord-1", "pairing-2");
    });
    expect(apiMocks.revokeDiscordPairing).toHaveBeenCalledWith("discord-1", "pairing-2");
    expect(renderedText(renderer.toJSON())).toContain("revoke failed");

    await act(async () => {
      await getActions().onReconnectDiscordRuntime("discord-1");
    });

    expect(apiMocks.reconnectDiscordRuntime).toHaveBeenCalledWith("discord-1");
    expect(renderedText(renderer.toJSON())).toContain("ok");
    expect(renderedText(renderer.toJSON())).toContain("connected:reconnected-1");
  });
});
