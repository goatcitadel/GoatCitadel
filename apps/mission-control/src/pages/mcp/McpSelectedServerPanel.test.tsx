import { act, create } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import type { ConnectorRecord } from "@goatcitadel/contracts";
import { McpSelectedServerPanel } from "./McpSelectedServerPanel";

const selected = {
  serverId: "server-1",
  status: "connected" as const,
  authType: "oauth2" as const,
  enabled: true,
  trustTier: "trusted" as const,
  policy: {
    requireFirstToolApproval: false,
    redactionMode: "basic" as const,
    blockedToolPatterns: [],
    allowedToolPatterns: [],
    notes: "Existing note",
  },
};

function buildProps(overrides: Partial<Parameters<typeof McpSelectedServerPanel>[0]> = {}) {
  return {
    selected,
    selectedConnector: {
      connectorId: "slack",
      connectorType: "integration_connection",
      label: "Slack",
      sourceId: "slack-connection",
      status: "active",
      capabilities: [{ id: "approvals", version: "1.0.0", enabled: true }],
      metadata: {
        approvalDeliveryReady: true,
        approvalDeliveryMode: "dm",
        approvalDeliveryReason: "Slack app is installed.",
      },
    } satisfies ConnectorRecord,
    selectedDiagnostic: {
      status: "warn" as const,
      checkedAt: "2026-03-10T18:00:00.000Z",
      recommendedNextAction: "Reconnect OAuth",
      checks: [{ key: "oauth", status: "warn" as const, message: "Token expires soon" }],
    },
    busy: false,
    policyRequireFirst: false,
    setPolicyRequireFirst: vi.fn(),
    policyRedaction: "basic" as const,
    setPolicyRedaction: vi.fn(),
    policyAllowed: "safe.*",
    setPolicyAllowed: vi.fn(),
    policyBlocked: "danger.*",
    setPolicyBlocked: vi.fn(),
    policyNotes: "Existing note",
    setPolicyNotes: vi.fn(),
    setPolicyDirty: vi.fn(),
    policyDirty: true,
    onToggleConnection: vi.fn().mockResolvedValue(undefined),
    onStartOAuth: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn(),
    onHealthCheck: vi.fn().mockResolvedValue(undefined),
    onSavePolicy: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("McpSelectedServerPanel", () => {
  it("renders null until a server is selected", () => {
    const renderer = create(<McpSelectedServerPanel {...buildProps({ selected: null })} />);

    expect(renderer.toJSON()).toBeNull();
  });

  it("renders connector readiness, diagnostics, and selected server actions", async () => {
    const props = buildProps();
    const renderer = create(<McpSelectedServerPanel {...props} />);
    const text = JSON.stringify(renderer.toJSON());

    expect(text).toContain("Disconnect");
    expect(text).toContain("Start OAuth");
    expect(text).toContain("Approval delivery");
    expect(text).toContain("ready");
    expect(text).toContain("dm: Slack app is installed.");
    expect(text).toContain("Latest health check");
    expect(text).toContain("warn");
    expect(text).toContain("Next step");
    expect(text).toContain("Reconnect OAuth");

    for (const label of ["Disconnect", "Start OAuth", "Delete", "Health Check", "Save Policy"]) {
      const button = renderer.root.findAllByType("button").find((candidate) => candidate.props.children === label);
      await act(async () => {
        button?.props.onClick?.();
      });
    }

    expect(props.onToggleConnection).toHaveBeenCalledTimes(1);
    expect(props.onStartOAuth).toHaveBeenCalledTimes(1);
    expect(props.onDelete).toHaveBeenCalledTimes(1);
    expect(props.onHealthCheck).toHaveBeenCalledTimes(1);
    expect(props.onSavePolicy).toHaveBeenCalledTimes(1);
  });

  it("marks policy dirty when switch, redaction, pattern, or note fields change", async () => {
    const props = buildProps();
    const renderer = create(<McpSelectedServerPanel {...props} />);

    const switchButton = renderer.root.findByProps({ role: "switch" });
    await act(async () => {
      switchButton.props.onClick();
    });

    const select = renderer.root.findByType("select");
    await act(async () => {
      select.props.onChange({ target: { value: "strict" } });
    });

    const inputs = renderer.root.findAllByType("input");
    await act(async () => {
      inputs[0]?.props.onChange({ target: { value: "read.*" } });
      inputs[1]?.props.onChange({ target: { value: "write.*" } });
      inputs[2]?.props.onChange({ target: { value: "Needs review" } });
    });

    expect(props.setPolicyRequireFirst).toHaveBeenCalledWith(true);
    expect(props.setPolicyRedaction).toHaveBeenCalledWith("strict");
    expect(props.setPolicyAllowed).toHaveBeenCalledWith("read.*");
    expect(props.setPolicyBlocked).toHaveBeenCalledWith("write.*");
    expect(props.setPolicyNotes).toHaveBeenCalledWith("Needs review");
    expect(props.setPolicyDirty).toHaveBeenCalledTimes(5);
  });

  it("shows connect copy and hides oauth/diagnostic/connector sections when unavailable", () => {
    const renderer = create(
      <McpSelectedServerPanel
        {...buildProps({
          selected: { ...selected, status: "disconnected", authType: "token" },
          selectedConnector: null,
          selectedDiagnostic: undefined,
          policyDirty: false,
        })}
      />,
    );
    const text = JSON.stringify(renderer.toJSON());

    expect(text).toContain("Connect");
    expect(text).toContain("Server is not connected yet");
    expect(text).not.toContain("Start OAuth");
    expect(text).not.toContain("Approval delivery");
    expect(text).not.toContain("Latest health check");
  });
});
