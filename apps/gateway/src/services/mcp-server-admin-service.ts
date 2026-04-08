import { randomUUID } from "node:crypto";
import type {
  McpServerCreateInput,
  McpServerPolicy,
  McpServerRecord,
  McpServerUpdateInput,
} from "@goatcitadel/contracts";
import { inferMcpCategory, normalizeMcpPolicy, type GatewayService } from "./gateway-service.js";

export type McpServerAdminHost = GatewayService;

export function createMcpServer(host: McpServerAdminHost, input: McpServerCreateInput): McpServerRecord {
  const now = new Date().toISOString();
  const created: McpServerRecord = {
    serverId: randomUUID(),
    label: input.label.trim(),
    transport: input.transport,
    command: input.command?.trim() || undefined,
    args: input.args?.map((item) => item.trim()).filter(Boolean),
    url: input.url?.trim() || undefined,
    authType: input.authType ?? "none",
    enabled: input.enabled ?? true,
    category: input.category ?? inferMcpCategory(input.transport),
    trustTier: input.trustTier ?? "restricted",
    costTier: input.costTier ?? "unknown",
    policy: normalizeMcpPolicy(input.policy),
    verifiedAt: input.verifiedAt,
    status: "disconnected",
    createdAt: now,
    updatedAt: now,
  };
  const servers = [created, ...host.readMcpServers()];
  host.writeMcpServers(servers);
  host.publishRealtime("system", "mcp", {
    type: "mcp_server_created",
    serverId: created.serverId,
    transport: created.transport,
  });
  return created;
}

export function updateMcpServer(
  host: McpServerAdminHost,
  serverId: string,
  input: McpServerUpdateInput,
): McpServerRecord {
  const now = new Date().toISOString();
  let updated: McpServerRecord | undefined;
  const servers = host.readMcpServers().map((item) => {
    if (item.serverId !== serverId) {
      return item;
    }
    updated = {
      ...item,
      label: input.label?.trim() || item.label,
      command: input.command === undefined ? item.command : input.command.trim() || undefined,
      args: input.args === undefined ? item.args : input.args.map((entry) => entry.trim()).filter(Boolean),
      url: input.url === undefined ? item.url : input.url.trim() || undefined,
      authType: input.authType ?? item.authType,
      enabled: input.enabled ?? item.enabled,
      category: input.category ?? item.category,
      trustTier: input.trustTier ?? item.trustTier,
      costTier: input.costTier ?? item.costTier,
      policy: input.policy ? normalizeMcpPolicy({ ...item.policy, ...input.policy }) : item.policy,
      verifiedAt: input.verifiedAt ?? item.verifiedAt,
      updatedAt: now,
    };
    return updated;
  });
  if (!updated) {
    throw new Error(`Unknown MCP server: ${serverId}`);
  }
  host.writeMcpServers(servers);
  return updated;
}

export function updateMcpServerPolicy(
  host: McpServerAdminHost,
  serverId: string,
  policy: Partial<McpServerPolicy>,
): McpServerRecord {
  return updateMcpServer(host, serverId, { policy });
}

export function deleteMcpServer(host: McpServerAdminHost, serverId: string): { deleted: boolean } {
  const previous = host.readMcpServers();
  const next = previous.filter((item) => item.serverId !== serverId);
  const deleted = next.length !== previous.length;
  if (deleted) {
    host.writeMcpServers(next);
    host.writeMcpTools(host.readMcpTools().filter((tool) => tool.serverId !== serverId));
    host.storage.approvalInbox.deleteByReceiver("mcp", serverId);
    host.publishRealtime("system", "mcp", {
      type: "mcp_server_deleted",
      serverId,
    });
  }
  return { deleted };
}
