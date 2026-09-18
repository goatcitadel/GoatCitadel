import type { McpServerRecord } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import type { McpAuthStateRecord } from "./mcp-server-admin-service.js";
import type { McpEnvironmentBindingRecord } from "./mcp-static-environment-service.js";
import { MCP_APPROVAL_INBOX_URL } from "./mcp-approval-inbox.js";
import { MCP_DURABLE_TASKS_URL } from "./mcp-durable-tasks.js";
import { normalizeMcpPolicy } from "./mcp-server-policy.js";
import { MCP_SERVER_TEMPLATES } from "./mcp-server-templates.js";
import { buildPublicMcpAuthState } from "./mcp-oauth-token-service.js";
import { mcpServerRevision } from "./mcp-server-revision.js";
import { callerOwnedServers } from "./mcp-server-state-helpers.js";
const MCP_SERVERS_SETTING_KEY = "mcp_servers_v1";
const MCP_TOOL_FIRST_APPROVAL_SETTING_KEY = "mcp_tool_first_approval_v1";
const MCP_ENVIRONMENT_SETTING_KEY = "mcp_environment_bindings_v1";
const GATEWAY_OWNED_MCP_CREATED_AT = "2026-05-26T00:00:00.000Z";
interface McpServerReadDependencies { systemSettings: Pick<AsyncStorage["systemSettings"], "get">; }

export async function readMcpServers(deps: McpServerReadDependencies): Promise<McpServerRecord[]> {
    const [setting, authRows] = await Promise.all([
      deps.systemSettings.get<McpServerRecord[]>(MCP_SERVERS_SETTING_KEY),
      readMcpAuthState(deps),
    ]);
    const callerOwned = callerOwnedServers(setting?.value).map((item) => ({
      ...item,
      revision: mcpServerRevision(item),
      authState: buildPublicMcpAuthState(item, authRows[item.serverId]),
    }));
    return [...buildGatewayOwnedInternalMcpServers(authRows), ...callerOwned];
  }

export async function readMcpAuthState(deps: McpServerReadDependencies): Promise<Record<string, McpAuthStateRecord>> {
    return (await deps.systemSettings.get<Record<string, McpAuthStateRecord>>("mcp_auth_state_v1"))?.value ?? {};
  }

export async function readMcpEnvironmentBinding(deps: McpServerReadDependencies, serverId: string): Promise<McpEnvironmentBindingRecord | undefined> {
    return (await deps.systemSettings.get<Record<string, McpEnvironmentBindingRecord>>(MCP_ENVIRONMENT_SETTING_KEY))
      ?.value[serverId];
  }

export async function readMcpFirstApprovals(deps: McpServerReadDependencies): Promise<Record<string, string[]>> {
    return (
      (await deps.systemSettings.get<Record<string, string[]>>(MCP_TOOL_FIRST_APPROVAL_SETTING_KEY))?.value ?? {}
    );
  }

export function buildGatewayOwnedInternalMcpServers(authRows: Record<string, McpAuthStateRecord>): McpServerRecord[] {
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
