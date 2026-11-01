import type { ChangePlanReceipt } from "./change-plan.js";
import type { McpApprovalPosture, McpServerCategory } from "./mcp.js";

/** One merged list of connectors (apps the AI can use), returned by the Gateway for the Capabilities area. */
export type CapabilityConnectorKind = "built_in" | "mcp" | "channel";

export type CapabilityConnectorSource = "mcp_template" | "mcp_server" | "integration" | "web_search";

export type CapabilityConnectorState =
  | "connected"
  | "needs_sign_in"
  | "sign_in_expired"
  | "broken"
  | "available"
  | "turned_off";

export type CapabilityConnectorGroup = "connected" | "on_this_device" | "available" | "turned_off";

export type CapabilityConnectorCategory = McpServerCategory | "messaging" | "search";

export type CapabilityConnectorAuth = "none" | "oauth" | "api_key" | "bot_token" | "google";

export type CapabilityConnectorReason =
  | "ready"
  | "not_connected"
  | "sign_in_needed"
  | "sign_in_expired"
  | "error"
  | "turned_off"
  | "not_installed"
  | "needs_api_key"
  | "missing_sign_in_setup";

export type CapabilityConnectorChatBlock = "mcp_in_chat_off" | "background_runs_off";

export interface CapabilityConnectorItem {
  /** "mcp-template:<templateId>" | "mcp-server:<serverId>" | "integration:<connectionId|catalogId>" | "web-search:<targetId>" */
  id: string;
  name: string;
  description: string;
  kind: CapabilityConnectorKind;
  source: CapabilityConnectorSource;
  category: CapabilityConnectorCategory;
  state: CapabilityConnectorState;
  reason: CapabilityConnectorReason;
  group: CapabilityConnectorGroup;
  auth: CapabilityConnectorAuth;
  runsOnThisDevice: boolean;
  /** Exact command line, only when runsOnThisDevice. */
  command?: string;
  networkHosts: string[];
  templateId?: string;
  /** A template's own plain-words risk notes, shown before it is installed. Missing when it has none. */
  riskNotes?: string[];
  serverId?: string;
  /** McpServerRecord.revision (opaque). */
  serverRevision?: string;
  /** McpServerRecord.connectionRevision (opaque). */
  serverConnectionRevision?: string;
  /** A saved server's "what asks first" setting. Missing behaves like `everything_asks`. */
  approvalPosture?: McpApprovalPosture;
  /** Set on a saved server whose tools are listed per chat, so its approval setting never applies and every call asks. */
  requesterScoped?: boolean;
  /** Set on an app that can move or spend money, or reach bank data; its changes can't be set to run on their own. */
  movesMoney?: boolean;
  catalogId?: string;
  connectionId?: string;
  chat: { available: boolean; blockedBy?: CapabilityConnectorChatBlock };
  hiddenInWorkspace: boolean;
  /** Shown only inside TechnicalDetails. */
  lastError?: string;
  /** A saved server a plugin added: only uninstalling that plugin removes it. Absent for every other connector. */
  fromPlugin?: { pluginId: string; name: string };
}

export interface CapabilityConnectorsIssue {
  source: CapabilityConnectorSource;
  message: string;
}

export interface CapabilityConnectorsResponse {
  workspaceId: string;
  items: CapabilityConnectorItem[];
  issues: CapabilityConnectorsIssue[];
  /**
   * Whether a saved server's "what asks first" setting can let any call run on its own on this install. False on a
   * remote_hardened install, where every MCP call asks whatever the setting says.
   */
  approvalReliefAvailable: boolean;
  generatedAt: string;
}

/**
 * `POST /api/v1/capabilities/connectors/install`: install a connector from its template through one Change Plan. It
 * allows the template's hosts, saves the connector switched off with "Reading is free" and, when asked, lets Chat use
 * connectors.
 */
export interface ConnectorInstallRequest {
  templateId: string;
  /** Also turn on connectors in Chat when they are off. */
  enableChatConnectors: boolean;
}

/** The plan either finished, or waits for your approval in the Inbox; its receipt says which. */
export interface ConnectorInstallResponse {
  templateId: string;
  changePlanReceipt: ChangePlanReceipt;
}

/** Display order of the connector groups in the Capabilities list. */
export const CAPABILITY_CONNECTOR_GROUP_ORDER: readonly CapabilityConnectorGroup[] = [
  "connected",
  "on_this_device",
  "available",
  "turned_off",
];
