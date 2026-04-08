import { describe, expect, it } from "vitest";
import type { ConnectorRecord } from "@goatcitadel/contracts";
import {
  connectorSetupReady,
  connectorSupportsDeliveryAction,
  getConnectorRuntimePostureSummary,
  getConnectorSetupDiagnostics,
  getConnectorSupportedAttachmentSources,
  getConnectorSupportedDeliveryActions,
  getConnectorSupportNotes,
  parseAttachmentIdInputs,
  parseAttachmentUrlInputs,
} from "./integrations-page-utils";

function makeConnector(metadata: Record<string, unknown>): ConnectorRecord {
  return {
    connectorId: "integration:test",
    connectorType: "integration_connection",
    label: "Test Connector",
    sourceId: "conn_test",
    status: "active",
    capabilities: [],
    metadata,
  };
}

describe("integration connector metadata helpers", () => {
  it("reads supported actions, attachment sources, notes, and setup diagnostics from connector metadata", () => {
    const connector = makeConnector({
      supportedDeliveryActions: ["channel.send", "channel.react", "channel.unsend"],
      supportedAttachmentSources: ["url", "inline"],
      channelSupportNotes: ["BlueBubbles chat/new must be enabled for new handles."],
      setupDiagnostics: ["Missing config.passwordEnv."],
      setupReady: false,
    });

    expect(getConnectorSupportedDeliveryActions(connector)).toEqual([
      "channel.send",
      "channel.react",
      "channel.unsend",
    ]);
    expect(getConnectorSupportedAttachmentSources(connector)).toEqual(["url", "inline"]);
    expect(getConnectorSupportNotes(connector)).toEqual(["BlueBubbles chat/new must be enabled for new handles."]);
    expect(getConnectorSetupDiagnostics(connector)).toEqual(["Missing config.passwordEnv."]);
    expect(connectorSupportsDeliveryAction(connector, "channel.react")).toBe(true);
    expect(connectorSupportsDeliveryAction(connector, "channel.unsend")).toBe(true);
    expect(connectorSetupReady(connector)).toBe(false);
  });

  it("falls back safely when metadata is absent or malformed", () => {
    const connector = makeConnector({
      supportedDeliveryActions: "channel.send",
      supportedAttachmentSources: null,
      setupDiagnostics: [123, "Missing config.bridgeUrl."],
    });

    expect(getConnectorSupportedDeliveryActions(connector)).toEqual([]);
    expect(getConnectorSupportedAttachmentSources(connector)).toEqual([]);
    expect(getConnectorSupportNotes(connector)).toEqual([]);
    expect(getConnectorSetupDiagnostics(connector)).toEqual(["Missing config.bridgeUrl."]);
    expect(connectorSupportsDeliveryAction(connector, "channel.react")).toBe(false);
    expect(connectorSetupReady(connector)).toBe(false);
  });

  it("prefers shared channel-core metadata when available", () => {
    const connector = makeConnector({
      channelCapabilities: {
        supportedActions: ["channel.send", "channel.reply", "channel.typing"],
        supportedAttachmentSources: ["inline"],
        supportNotes: ["Gateway mode enables typing and presence."],
        runtimePosture: {
          operatorSummary: "Persistent gateway runtime keeps inbound channel state synchronized.",
        },
        setupDiagnostics: [],
        setupReady: true,
      },
      supportedDeliveryActions: ["channel.send"],
      supportedAttachmentSources: ["url"],
      setupDiagnostics: ["legacy diagnostic"],
      setupReady: false,
    });

    expect(getConnectorSupportedDeliveryActions(connector)).toEqual([
      "channel.send",
      "channel.reply",
      "channel.typing",
    ]);
    expect(getConnectorSupportedAttachmentSources(connector)).toEqual(["inline"]);
    expect(getConnectorSupportNotes(connector)).toEqual(["Gateway mode enables typing and presence."]);
    expect(getConnectorRuntimePostureSummary(connector)).toBe(
      "Persistent gateway runtime keeps inbound channel state synchronized.",
    );
    expect(getConnectorSetupDiagnostics(connector)).toEqual([]);
    expect(connectorSetupReady(connector)).toBe(true);
  });

  it("parses attachment URL and id inputs into normalized send payload fields", () => {
    expect(parseAttachmentUrlInputs("https://example.com/a.png\n\n https://example.com/b.pdf ")).toEqual([
      { url: "https://example.com/a.png" },
      { url: "https://example.com/b.pdf" },
    ]);
    expect(parseAttachmentIdInputs("att-1\natt-2\natt-1\n")).toEqual(["att-1", "att-2"]);
  });
});
