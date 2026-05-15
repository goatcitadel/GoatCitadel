import type { ConnectorDiagnosticReport, ConnectorRecord } from "@goatcitadel/contracts";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { IntegrationConnection } from "../../api/client";
import { IntegrationsConnectionsTable, type IntegrationsConnectionsTableProps } from "./IntegrationsConnectionsTable";

function connection(overrides: Partial<IntegrationConnection> = {}): IntegrationConnection {
  return {
    connectionId: "conn-1",
    catalogId: "slack",
    kind: "channel",
    key: "slack",
    label: "Ops channel",
    enabled: true,
    status: "connected",
    config: {
      defaultChannel: "#ops",
    },
    createdAt: "2026-05-14T12:00:00.000Z",
    updatedAt: "2026-05-14T12:10:00.000Z",
    ...overrides,
  };
}

function connector(): ConnectorRecord {
  return {
    connectorId: "connector-1",
    connectorType: "integration_connection",
    label: "Slack connector",
    sourceId: "conn-1",
    status: "active",
    capabilities: [{ id: "approvals", version: "1", enabled: true }],
    metadata: {
      approvalDeliveryMode: "channel",
      approvalDeliveryTarget: "#ops",
      channelCapabilities: {
        supportedActions: ["channel.send", "channel.react"],
        setupReady: true,
      },
    },
  };
}

function diagnostics(): ConnectorDiagnosticReport {
  return {
    connectorType: "integration_connection",
    connectorId: "conn-1",
    status: "warn",
    checkedAt: "2026-05-14T12:20:00.000Z",
    checks: [{ key: "token", status: "warn", message: "Token expires soon." }],
    recommendedNextAction: "Refresh the workspace token.",
    probe: {
      kind: "slack",
      checkedAt: "2026-05-14T12:20:00.000Z",
      steps: [{ key: "post", label: "Post test", status: "pass", message: "Delivered." }],
    },
  };
}

function props(overrides: Partial<IntegrationsConnectionsTableProps> = {}): IntegrationsConnectionsTableProps {
  const item = connection();
  return {
    connectionsTitle: "Connections",
    connectionsSubtitle: "Configured delivery channels.",
    connectionSearch: "",
    onConnectionSearchChange: vi.fn(),
    connections: [item],
    filteredConnections: [item],
    catalogLabelById: new Map([["slack", "Slack"]]),
    connectorBySourceId: new Map([["conn-1", connector()]]),
    connectorDiagnosticsEnabled: true,
    pluginBusyId: null,
    deleteActionPending: false,
    onToggle: vi.fn(),
    onRunDiagnostics: vi.fn(),
    onSetDeleteTarget: vi.fn(),
    selectedDiagnosticConnectionId: null,
    selectedDiagnostics: undefined,
    ...overrides,
  };
}

function text(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") {
    return String(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => text(item)).join("");
  }
  if (value && typeof value === "object" && "children" in value) {
    return text((value as { children?: unknown }).children);
  }
  return "";
}

describe("IntegrationsConnectionsTable", () => {
  it("distinguishes empty connection state from an empty filtered result", () => {
    const emptyMarkup = renderToStaticMarkup(
      <IntegrationsConnectionsTable {...props({ connections: [], filteredConnections: [] })} />,
    );
    const filteredMarkup = renderToStaticMarkup(
      <IntegrationsConnectionsTable {...props({ connections: [connection()], filteredConnections: [] })} />,
    );

    expect(emptyMarkup).toContain("No configured connections yet. Create one above to get started.");
    expect(filteredMarkup).toContain("No connections match this filter.");
  });

  it("wires filter and row actions without hiding visible connection metadata", () => {
    const onConnectionSearchChange = vi.fn();
    const onToggle = vi.fn();
    const onRunDiagnostics = vi.fn();
    const onSetDeleteTarget = vi.fn();
    const item = connection({ enabled: false, status: "error", lastError: "Webhook expired." });
    const renderer = create(
      <IntegrationsConnectionsTable
        {...props({
          connectionSearch: "ops",
          connections: [item],
          filteredConnections: [item],
          onConnectionSearchChange,
          onToggle,
          onRunDiagnostics,
          onSetDeleteTarget,
        })}
      />,
    );

    const input = renderer.root.findByType("input");
    act(() => {
      input.props.onChange({ target: { value: "slack" } });
    });
    expect(onConnectionSearchChange).toHaveBeenCalledWith("slack");

    const buttons = renderer.root.findAllByType("button");
    expect(text(renderer.toJSON())).toContain("Webhook expired.");
    expect(text(renderer.toJSON())).toContain("Slack");
    expect(text(renderer.toJSON())).toContain("Enable");

    act(() => {
      buttons.find((button) => text(button.props.children) === "Enable")?.props.onClick();
      buttons.find((button) => text(button.props.children) === "Diagnose")?.props.onClick();
      buttons.find((button) => text(button.props.children) === "Remove")?.props.onClick();
    });

    expect(onToggle).toHaveBeenCalledWith(item);
    expect(onRunDiagnostics).toHaveBeenCalledWith("conn-1");
    expect(onSetDeleteTarget).toHaveBeenCalledWith(item);
  });

  it("renders diagnostics details, busy labels, and disabled-diagnostics help text", () => {
    const busyMarkup = renderToStaticMarkup(
      <IntegrationsConnectionsTable
        {...props({
          pluginBusyId: "diag:conn-1",
          selectedDiagnosticConnectionId: "conn-1",
          selectedDiagnostics: diagnostics(),
        })}
      />,
    );
    const disabledMarkup = renderToStaticMarkup(
      <IntegrationsConnectionsTable
        {...props({
          connectorDiagnosticsEnabled: false,
          deleteActionPending: true,
        })}
      />,
    );

    expect(busyMarkup).toContain("Running...");
    expect(busyMarkup).toContain("Diagnostics for");
    expect(busyMarkup).toContain("Token expires soon.");
    expect(busyMarkup).toContain("Probe truth");
    expect(busyMarkup).toContain("Next step: Refresh the workspace token.");
    expect(disabledMarkup).toContain("Diagnostics disabled");
    expect(disabledMarkup).toContain("Connector diagnostics are disabled in this runtime.");
  });
});
