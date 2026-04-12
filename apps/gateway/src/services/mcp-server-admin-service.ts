import { randomUUID } from "node:crypto";
import type {
  McpToolRecord,
  McpOAuthStartResponse,
  McpServerCreateInput,
  McpServerPolicy,
  McpServerRecord,
  McpServerUpdateInput,
} from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import { inferMcpCategory, normalizeMcpPolicy } from "./mcp-server-policy.js";

interface McpAuthStateRecord {
  accessTokenRef?: string;
  refreshTokenRef?: string;
  tokenExpiresAt?: string;
  oauthState?: string;
  scopes?: string[];
  updatedAt: string;
  lastCodePreview?: string;
}

export interface McpServerAdminHost {
  readonly storage: {
    approvalInbox: Pick<Storage["approvalInbox"], "deleteByReceiver">;
  };
  readMcpServers(): McpServerRecord[];
  writeMcpServers(servers: McpServerRecord[]): void;
  patchMcpServerState(serverId: string, patch: Partial<McpServerRecord>): McpServerRecord;
  readMcpTools(): McpToolRecord[];
  writeMcpTools(tools: McpToolRecord[]): void;
  resolveConnectedMcpTools(server: McpServerRecord, existing: McpToolRecord[]): Promise<McpToolRecord[]>;
  requireMcpServer(serverId: string): McpServerRecord;
  readMcpAuthState(): Record<string, McpAuthStateRecord>;
  writeMcpAuthState(state: Record<string, McpAuthStateRecord>): void;
  publishRealtime(eventType: string, source: string, payload: Record<string, unknown>): void;
}

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

export async function connectMcpServer(host: McpServerAdminHost, serverId: string): Promise<McpServerRecord> {
  const connecting = host.patchMcpServerState(serverId, {
    status: "connecting",
    lastError: undefined,
  });
  try {
    const tools = host.readMcpTools();
    const existing = tools.filter((item) => item.serverId === serverId);
    const resolvedTools = await host.resolveConnectedMcpTools(connecting, existing);
    if (resolvedTools.length > 0) {
      host.writeMcpTools([...tools.filter((item) => item.serverId !== serverId), ...resolvedTools]);
    }
    return host.patchMcpServerState(serverId, {
      status: "connected",
      lastConnectedAt: new Date().toISOString(),
      lastError: undefined,
    });
  } catch (error) {
    host.patchMcpServerState(serverId, {
      status: "error",
      lastError: (error as Error).message,
    });
    throw error;
  }
}

export function disconnectMcpServer(host: McpServerAdminHost, serverId: string): McpServerRecord {
  return host.patchMcpServerState(serverId, {
    status: "disconnected",
  });
}

export function startMcpOAuth(host: McpServerAdminHost, serverId: string): McpOAuthStartResponse {
  const server = host.requireMcpServer(serverId);
  const state = randomUUID();
  const callback = encodeURIComponent("http://127.0.0.1:8787/api/v1/mcp/oauth/callback");
  const authorizeUrl = `${server.url ?? "https://example-mcp-provider.local/oauth/authorize"}?state=${encodeURIComponent(state)}&redirect_uri=${callback}`;
  const authRows = host.readMcpAuthState();
  authRows[serverId] = {
    ...(authRows[serverId] ?? {}),
    oauthState: state,
    updatedAt: new Date().toISOString(),
  };
  host.writeMcpAuthState(authRows);
  return { authorizeUrl, state };
}

export async function completeMcpOAuth(
  host: McpServerAdminHost,
  serverId: string,
  code: string,
  state?: string,
): Promise<McpServerRecord> {
  const authRows = host.readMcpAuthState();
  const authRow = authRows[serverId];
  if (!authRow) {
    throw new Error("No OAuth handshake in progress for this server.");
  }
  if (state && authRow.oauthState && authRow.oauthState !== state) {
    throw new Error("OAuth state mismatch.");
  }
  authRows[serverId] = {
    ...authRow,
    accessTokenRef: `keychain:goatcitadel:mcp:${serverId}:access-token`,
    refreshTokenRef: `keychain:goatcitadel:mcp:${serverId}:refresh-token`,
    oauthState: undefined,
    updatedAt: new Date().toISOString(),
    lastCodePreview: code.slice(0, 8),
  };
  host.writeMcpAuthState(authRows);
  return connectMcpServer(host, serverId);
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
