import { describe, expect, it } from "vitest";
import {
  describeConnectorApprovalDelivery,
  describeMcpBlockReason,
  formatMcpError,
  parseApprovalInboxItems,
  readConnectorApprovalReady,
  summarizeApprovalPreview,
} from "./mcp-page-helpers";

const connectedServer = {
  status: "connected" as const,
  enabled: true,
  trustTier: "trusted" as const,
  policy: {
    requireFirstToolApproval: false,
    blockedToolPatterns: [],
    allowedToolPatterns: [],
  },
};

describe("mcp-page-helpers", () => {
  it("normalizes MCP errors into operator-facing copy", () => {
    expect(formatMcpError("Unknown MCP server abc")).toContain("no longer exists");
    expect(formatMcpError("API error 500")).toBe("MCP request failed: API error 500");
    expect(formatMcpError("plain failure")).toBe("plain failure");
  });

  it("explains every MCP execution block reason in precedence order", () => {
    expect(describeMcpBlockReason({ ...connectedServer, enabled: false })).toContain("disabled");
    expect(describeMcpBlockReason({ ...connectedServer, status: "connecting" })).toContain("not connected");
    expect(describeMcpBlockReason({ ...connectedServer, trustTier: "quarantined" })).toContain("quarantined");
    expect(
      describeMcpBlockReason({
        ...connectedServer,
        policy: { ...connectedServer.policy, requireFirstToolApproval: true },
      }),
    ).toContain("requires explicit approval");
    expect(
      describeMcpBlockReason({
        ...connectedServer,
        policy: { ...connectedServer.policy, blockedToolPatterns: ["danger.*"] },
      }),
    ).toContain("blocked by policy");
    expect(
      describeMcpBlockReason({
        ...connectedServer,
        policy: { ...connectedServer.policy, allowedToolPatterns: ["safe.*"] },
      }),
    ).toContain("allow patterns");
    expect(describeMcpBlockReason(connectedServer)).toBe("No active policy blocks detected.");
  });

  it("parses approval inbox records defensively", () => {
    expect(parseApprovalInboxItems("nope")).toEqual([]);
    expect(
      parseApprovalInboxItems([null, { inboxItemId: "item-1", approvalId: "approval-1" }, { inboxItemId: "item-2" }]),
    ).toEqual([{ inboxItemId: "item-1", approvalId: "approval-1" }]);
  });

  it("summarizes connector approval readiness and preview payloads", () => {
    const connector = {
      connectorId: "slack",
      metadata: {
        approvalDeliveryReady: true,
        approvalDeliveryMode: "dm",
        approvalDeliveryReason: "Slack app is installed.",
      },
    } as any;

    expect(readConnectorApprovalReady(connector)).toBe(true);
    expect(describeConnectorApprovalDelivery(connector)).toBe("dm: Slack app is installed.");
    expect(describeConnectorApprovalDelivery({ connectorId: "none", metadata: {} } as any)).toBe(
      "No approval delivery details reported.",
    );
    expect(summarizeApprovalPreview({ summary: "  Ready to approve  " })).toBe("Ready to approve");
    expect(summarizeApprovalPreview({})).toBe("No preview summary provided.");
    expect(summarizeApprovalPreview({ details: "x".repeat(260) })).toHaveLength(220);
  });
});
