import type { McpServerRecord, McpToolRecord } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { McpAuthStateRecord } from "./mcp-server-admin-service.js";
import { MCP_APPROVAL_INBOX_URL, createInternalMcpApprovalInboxTools } from "./mcp-approval-inbox.js";
import { MCP_DURABLE_TASKS_URL, createInternalMcpDurableTasksTools } from "./mcp-durable-tasks.js";
import { buildPublicMcpAuthState } from "./mcp-oauth-token-service.js";
import { inferMcpCategory, normalizeMcpPolicy } from "./mcp-server-policy.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";

const MCP_SERVERS_SETTING_KEY = "mcp_servers_v1";
const MCP_TOOLS_SETTING_KEY = "mcp_tools_v1";
const MCP_TOOL_FIRST_APPROVAL_SETTING_KEY = "mcp_tool_first_approval_v1";
const GATEWAY_OWNED_MCP_CREATED_AT = "2026-05-26T00:00:00.000Z";

/**
 * Server ids the gateway itself owns and synthesizes at read time; they are never
 * persisted and callers cannot register or overwrite them.
 */
export const GATEWAY_OWNED_MCP_SERVER_IDS = new Set([
  "goatcitadel-internal-approval-inbox",
  "goatcitadel-internal-durable-tasks",
]);

export interface McpServerStoreCtx {
  systemSettings: Pick<Storage["systemSettings"], "get" | "set">;
}

/**
 * Owns the system-settings-backed MCP registry: persisted caller servers/tools
 * plus the synthesized gateway-owned internal servers, MCP auth state, and the
 * first-use tool approvals. Extracted from GatewayService (B5a).
 */
export class McpServerStore {
  constructor(private readonly ctx: McpServerStoreCtx) {}

  readServers(): McpServerRecord[] {
    const stored = this.ctx.systemSettings.get<McpServerRecord[]>(MCP_SERVERS_SETTING_KEY)?.value;
    const authRows = this.readAuthState();
    const persisted = Array.isArray(stored) ? stored : [];
    const callerOwned = persisted
      .filter((item): item is McpServerRecord => Boolean(item?.serverId))
      .filter((item) => !isGatewayOwnedMcpServerUrl(item.url) && !GATEWAY_OWNED_MCP_SERVER_IDS.has(item.serverId))
      .map((item) => ({
        ...item,
        category: item.category ?? inferMcpCategory(item.transport),
        trustTier: item.trustTier ?? "restricted",
        costTier: item.costTier ?? "unknown",
        policy: normalizeMcpPolicy(item.policy),
        authState: buildPublicMcpAuthState(item, authRows[item.serverId]),
      }));
    return [...buildGatewayOwnedInternalMcpServers(authRows), ...callerOwned];
  }

  writeServers(servers: McpServerRecord[]): void {
    this.ctx.systemSettings.set(
      MCP_SERVERS_SETTING_KEY,
      servers
        .filter(
          (server) => !isGatewayOwnedMcpServerUrl(server.url) && !GATEWAY_OWNED_MCP_SERVER_IDS.has(server.serverId),
        )
        .map((server) => {
          const persisted = { ...server };
          delete persisted.authState;
          return persisted;
        }),
    );
  }

  requireServer(serverId: string): McpServerRecord {
    const server = this.readServers().find((item) => item.serverId === serverId);
    if (!server) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    return server;
  }

  patchServerState(
    serverId: string,
    patch: Partial<Pick<McpServerRecord, "status" | "lastConnectedAt" | "lastError">>,
  ): McpServerRecord {
    const now = new Date().toISOString();
    const hasStatus = Object.prototype.hasOwnProperty.call(patch, "status");
    const hasLastConnectedAt = Object.prototype.hasOwnProperty.call(patch, "lastConnectedAt");
    const hasLastError = Object.prototype.hasOwnProperty.call(patch, "lastError");
    let updated: McpServerRecord | undefined;
    const servers = this.readServers().map((item) => {
      if (item.serverId !== serverId) {
        return item;
      }
      updated = {
        ...item,
        status: hasStatus ? (patch.status ?? item.status) : item.status,
        lastConnectedAt: hasLastConnectedAt ? patch.lastConnectedAt : item.lastConnectedAt,
        lastError: hasLastError ? patch.lastError : item.lastError,
        updatedAt: now,
      };
      return updated;
    });
    if (!updated) {
      throw new Error(`Unknown MCP server: ${serverId}`);
    }
    this.writeServers(servers);
    return updated;
  }

  readTools(): McpToolRecord[] {
    const stored = this.ctx.systemSettings.get<McpToolRecord[]>(MCP_TOOLS_SETTING_KEY)?.value;
    const persisted = Array.isArray(stored) ? stored : [];
    const callerOwned = persisted.filter(
      (item): item is McpToolRecord =>
        Boolean(item?.serverId && item?.toolName) && !GATEWAY_OWNED_MCP_SERVER_IDS.has(item.serverId),
    );
    return [...buildGatewayOwnedInternalMcpTools(), ...callerOwned];
  }

  writeTools(tools: McpToolRecord[]): void {
    this.ctx.systemSettings.set(
      MCP_TOOLS_SETTING_KEY,
      tools.filter((tool) => !GATEWAY_OWNED_MCP_SERVER_IDS.has(tool.serverId)),
    );
  }

  readAuthState(): Record<string, McpAuthStateRecord> {
    return this.ctx.systemSettings.get<Record<string, McpAuthStateRecord>>("mcp_auth_state_v1")?.value ?? {};
  }

  writeAuthState(state: Record<string, McpAuthStateRecord>): void {
    this.ctx.systemSettings.set("mcp_auth_state_v1", state);
  }

  readFirstApprovals(): Record<string, string[]> {
    return this.ctx.systemSettings.get<Record<string, string[]>>(MCP_TOOL_FIRST_APPROVAL_SETTING_KEY)?.value ?? {};
  }

  isToolApproved(serverId: string, toolName: string): boolean {
    const approved = this.readFirstApprovals();
    return approved[serverId]?.includes(toolName) ?? false;
  }
}

function buildGatewayOwnedInternalMcpServers(authRows: Record<string, McpAuthStateRecord>): McpServerRecord[] {
  return [
    buildGatewayOwnedInternalMcpServer("goatcitadel-internal-approval-inbox", MCP_APPROVAL_INBOX_URL, authRows),
    buildGatewayOwnedInternalMcpServer("goatcitadel-internal-durable-tasks", MCP_DURABLE_TASKS_URL, authRows),
  ].filter((server): server is McpServerRecord => Boolean(server));
}

function buildGatewayOwnedInternalMcpServer(
  serverId: string,
  url: string,
  authRows: Record<string, McpAuthStateRecord>,
): McpServerRecord | undefined {
  const template = MCP_SERVER_TEMPLATES.find((item) => item.url === url);
  if (!template) {
    return undefined;
  }
  const server: McpServerRecord = {
    serverId,
    label: template.label,
    transport: template.transport,
    command: template.command,
    args: template.args,
    url: template.url,
    authType: template.authType,
    oauth: template.oauth,
    enabled: true,
    status: "connected",
    category: template.category,
    trustTier: template.trustTier,
    costTier: template.costTier,
    policy: normalizeMcpPolicy(template.policy),
    verifiedAt: GATEWAY_OWNED_MCP_CREATED_AT,
    lastConnectedAt: GATEWAY_OWNED_MCP_CREATED_AT,
    createdAt: GATEWAY_OWNED_MCP_CREATED_AT,
    updatedAt: GATEWAY_OWNED_MCP_CREATED_AT,
  };
  return {
    ...server,
    authState: buildPublicMcpAuthState(server, authRows[serverId]),
  };
}

function buildGatewayOwnedInternalMcpTools(): McpToolRecord[] {
  return [
    ...createInternalMcpApprovalInboxTools("goatcitadel-internal-approval-inbox"),
    ...createInternalMcpDurableTasksTools("goatcitadel-internal-durable-tasks"),
  ];
}

function isGatewayOwnedMcpServerUrl(url: string | undefined): boolean {
  const normalized = url?.trim().toLowerCase();
  return normalized === MCP_APPROVAL_INBOX_URL || normalized === MCP_DURABLE_TASKS_URL;
}
