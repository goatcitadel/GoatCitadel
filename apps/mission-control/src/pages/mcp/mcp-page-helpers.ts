/**
 * Pure helpers extracted from McpPage.tsx (Step 10 page slimming).
 */

import type { ApprovalInboxItemRecord, ConnectorRecord } from "@goatcitadel/contracts";

export function formatMcpError(message: string): string {
  if (message.includes("Unknown MCP server")) {
    return "That MCP server no longer exists. Select another server from the list or add one from the template library.";
  }
  if (message.startsWith("API error")) {
    return `MCP request failed: ${message}`;
  }
  return message;
}

export function describeMcpBlockReason(server: {
  status: "disconnected" | "connecting" | "connected" | "error";
  enabled: boolean;
  trustTier: "trusted" | "restricted" | "quarantined";
  policy: {
    requireFirstToolApproval: boolean;
    blockedToolPatterns: string[];
    allowedToolPatterns: string[];
  };
}): string {
  if (!server.enabled) {
    return "Server is disabled. Enable it before any MCP tools can run.";
  }
  if (server.status !== "connected") {
    return "Server is not connected yet. Connect first, then invoke tools.";
  }
  if (server.trustTier === "quarantined") {
    return "Trust tier is quarantined, so all tool execution is blocked.";
  }
  if (server.policy.requireFirstToolApproval) {
    return "First tool execution requires explicit approval.";
  }
  if (server.policy.blockedToolPatterns.length > 0) {
    return "Some tool names are blocked by policy patterns.";
  }
  if (server.policy.allowedToolPatterns.length > 0) {
    return "Only tool names matching allow patterns can run.";
  }
  return "No active policy blocks detected.";
}

export function parseApprovalInboxItems(value: unknown): ApprovalInboxItemRecord[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is ApprovalInboxItemRecord =>
      Boolean(item) &&
      typeof item === "object" &&
      typeof (item as ApprovalInboxItemRecord).inboxItemId === "string" &&
      typeof (item as ApprovalInboxItemRecord).approvalId === "string",
  );
}

export function readConnectorApprovalReady(connector: ConnectorRecord): boolean {
  return connector.metadata?.approvalDeliveryReady === true;
}

export function describeConnectorApprovalDelivery(connector: ConnectorRecord): string {
  const reason =
    typeof connector.metadata?.approvalDeliveryReason === "string"
      ? connector.metadata.approvalDeliveryReason
      : "No approval delivery details reported.";
  const mode =
    typeof connector.metadata?.approvalDeliveryMode === "string" ? connector.metadata.approvalDeliveryMode : undefined;
  if (!mode) {
    return reason;
  }
  return `${mode}: ${reason}`;
}

export function summarizeApprovalPreview(preview: Record<string, unknown>): string {
  const summary = preview.summary;
  if (typeof summary === "string" && summary.trim().length > 0) {
    return summary.trim();
  }
  const serialized = JSON.stringify(preview);
  if (!serialized || serialized === "{}") {
    return "No preview summary provided.";
  }
  return serialized.length <= 220 ? serialized : `${serialized.slice(0, 217)}...`;
}
