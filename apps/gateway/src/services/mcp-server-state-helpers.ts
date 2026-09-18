import { isDeepStrictEqual } from "node:util";
import { ConflictError, type McpServerRecord } from "@goatcitadel/contracts";
import { inferMcpCategory, normalizeMcpPolicy } from "./mcp-server-policy.js";
import { MCP_APPROVAL_INBOX_URL } from "./mcp-approval-inbox.js";
import { MCP_DURABLE_TASKS_URL } from "./mcp-durable-tasks.js";
export const GATEWAY_OWNED_MCP_SERVER_IDS = new Set([
  "goatcitadel-internal-approval-inbox",
  "goatcitadel-internal-durable-tasks",
]);

export function callerOwnedServers(value: unknown): McpServerRecord[] {
  return (Array.isArray(value) ? value : [])
    .filter((item): item is McpServerRecord => Boolean(item?.serverId))
    .filter((item) => !isGatewayOwnedMcpServerUrl(item.url) && !GATEWAY_OWNED_MCP_SERVER_IDS.has(item.serverId))
    .map((item) => ({
      ...item,
      category: item.category ?? inferMcpCategory(item.transport),
      trustTier: item.trustTier ?? "restricted",
      costTier: item.costTier ?? "unknown",
      policy: normalizeMcpPolicy(item.policy),
    }));
}

export function jsonMaterial(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

export function assertUniqueServers(servers: McpServerRecord[]): void {
  if (new Set(servers.map((server) => server.serverId)).size !== servers.length) {
    throw new ConflictError({ message: "MCP registry contains duplicate server identities." });
  }
  for (const server of servers) {
    if (
      server.configurationBindingId !== undefined &&
      !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u.test(server.configurationBindingId)
    ) {
      throw new ConflictError({ message: "MCP configuration identity is invalid." });
    }
  }
}

export function configurationMaterial(server: McpServerRecord): unknown {
  const material: Partial<McpServerRecord> = {
    ...server,
    category: server.category ?? inferMcpCategory(server.transport),
    trustTier: server.trustTier ?? "restricted",
    costTier: server.costTier ?? "unknown",
    policy: normalizeMcpPolicy(server.policy),
  };
  for (const key of [
    "revision",
    "connectionRevision",
    "authState",
    "configurationBindingId",
    "status",
    "lastConnectedAt",
    "lastError",
    "updatedAt",
  ] as const) {
    delete material[key];
  }
  // Inventory normalization adds optional undefined fields; persistence omits them.
  return JSON.parse(JSON.stringify(material)) as unknown;
}

export function sameConfiguration(left: McpServerRecord, right: McpServerRecord): boolean {
  return isDeepStrictEqual(configurationMaterial(left), configurationMaterial(right));
}

export function assertConfigurationSnapshot(current: McpServerRecord[], expected: McpServerRecord[]): void {
  if (
    current.length !== expected.length ||
    current.some((server) => {
      const previous = expected.find((item) => item.serverId === server.serverId);
      return (
        !previous ||
        previous.configurationBindingId !== server.configurationBindingId ||
        !sameConfiguration(previous, server)
      );
    })
  ) {
    throw new ConflictError({ message: "MCP configuration changed; reload before applying this edit." });
  }
}

export function isGatewayOwnedMcpServerUrl(url: string | undefined): boolean {
  const normalized = url?.trim().toLowerCase();
  return normalized === MCP_APPROVAL_INBOX_URL || normalized === MCP_DURABLE_TASKS_URL;
}
