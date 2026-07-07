import { randomUUID } from "node:crypto";
import type {
  McpToolRecord,
  McpOAuthStartResponse,
  McpOAuthConfig,
  McpServerCreateInput,
  McpServerPolicy,
  McpServerRecord,
  McpServerUpdateInput,
} from "@goatcitadel/contracts";
import { normalizeSafeEnvKeyNames } from "@goatcitadel/policy-engine";
import type { Storage } from "@goatcitadel/storage";
import type { ToolPolicyActorContext } from "@goatcitadel/contracts";
import { inferMcpCategory, normalizeMcpPolicy } from "./mcp-server-policy.js";
import { discoverMcpTools, inferMcpToolsForServer } from "./mcp-runtime.js";
import { createInternalMcpApprovalInboxTools, isInternalMcpApprovalInboxServer } from "./mcp-approval-inbox.js";
import { createInternalMcpDurableTasksTools, isInternalMcpDurableTasksServer } from "./mcp-durable-tasks.js";
import {
  buildInternalMcpServerCreateBlockedMessage,
  buildUnsupportedMcpTransportMessage,
  isAllowedMcpDefinitionForCallerCreate,
  isInternalMcpServerUrl,
  isRuntimeSupportedMcpDefinition,
} from "./mcp-template-visibility.js";

export interface McpAuthStateRecord {
  accessTokenRef?: string;
  refreshTokenRef?: string;
  tokenExpiresAt?: string;
  oauthState?: string;
  scopes?: string[];
  /**
   * MCP v2 resource indicator: the resource server this token is scoped to. Makes
   * the per-server token scoping explicit/auditable so a token minted for one MCP
   * server is not reused against another (resource-indicator semantics).
   */
  resourceIndicator?: string;
  updatedAt: string;
  lastRefreshedAt?: string;
  error?: string;
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
  exchangeMcpOAuthCode?(
    server: McpServerRecord,
    code: string,
    stateRecord: McpAuthStateRecord,
  ): Promise<McpAuthStateRecord>;
  requireMcpServer(serverId: string): McpServerRecord;
  readMcpAuthState(): Record<string, McpAuthStateRecord>;
  writeMcpAuthState(state: Record<string, McpAuthStateRecord>): void;
  publishRealtime(eventType: string, source: string, payload: Record<string, unknown>): void;
}

export function createMcpServer(host: McpServerAdminHost, input: McpServerCreateInput): McpServerRecord {
  if (isInternalMcpServerUrl(input.url)) {
    throw new Error(buildInternalMcpServerCreateBlockedMessage());
  }
  if (!isAllowedMcpDefinitionForCallerCreate(input)) {
    throw new Error(buildUnsupportedMcpTransportMessage(input.transport));
  }
  const now = new Date().toISOString();
  const created: McpServerRecord = {
    serverId: randomUUID(),
    label: input.label.trim(),
    transport: input.transport,
    command: input.command?.trim() || undefined,
    args: input.args?.map((item) => item.trim()).filter(Boolean),
    url: input.url?.trim() || undefined,
    authType: input.authType ?? "none",
    oauth: normalizeMcpOAuthConfig(input.oauth),
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
  if (isInternalMcpServerUrl(input.url)) {
    throw new Error(buildInternalMcpServerCreateBlockedMessage());
  }
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
      oauth: input.oauth === undefined ? item.oauth : normalizeMcpOAuthConfig(input.oauth),
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
  const server = host.requireMcpServer(serverId);
  if (!isRuntimeSupportedMcpDefinition(server)) {
    throw new Error(buildUnsupportedMcpTransportMessage(server.transport));
  }
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
  if (server.authType !== "oauth2") {
    throw new Error("MCP OAuth can only be started for oauth2 servers.");
  }
  if (!server.oauth?.authorizationUrl?.trim() || !server.oauth.tokenUrl?.trim()) {
    throw new Error("MCP OAuth requires authorizationUrl and tokenUrl metadata.");
  }
  const state = randomUUID();
  const callback = server.oauth.redirectUri?.trim() || "http://127.0.0.1:8787/api/v1/mcp/oauth/callback";
  const authorizeUrl = new URL(server.oauth.authorizationUrl);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("redirect_uri", callback);
  const clientId = resolveEnvValue(server.oauth.clientIdEnv);
  if (clientId) {
    authorizeUrl.searchParams.set("client_id", clientId);
  }
  if (server.oauth.scopes?.length) {
    authorizeUrl.searchParams.set("scope", server.oauth.scopes.join(" "));
  }
  const authRows = host.readMcpAuthState();
  authRows[serverId] = {
    ...(authRows[serverId] ?? {}),
    oauthState: state,
    error: undefined,
    updatedAt: new Date().toISOString(),
  };
  host.writeMcpAuthState(authRows);
  return { authorizeUrl: authorizeUrl.toString(), state };
}

export async function completeMcpOAuth(
  host: McpServerAdminHost,
  serverId: string,
  code: string,
  state?: string,
): Promise<McpServerRecord> {
  const authRows = host.readMcpAuthState();
  const authRow = authRows[serverId];
  if (!authRow?.oauthState) {
    throw new Error("No OAuth handshake in progress for this server.");
  }
  if (!state) {
    throw new Error("OAuth state is required to complete this handshake.");
  }
  if (authRow.oauthState !== state) {
    throw new Error("OAuth state mismatch.");
  }
  const server = host.requireMcpServer(serverId);
  if (!host.exchangeMcpOAuthCode) {
    throw new Error("MCP OAuth token exchange is not available in this Gateway runtime.");
  }
  authRows[serverId] = await host.exchangeMcpOAuthCode(server, code, authRow);
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
    const authRows = host.readMcpAuthState();
    if (authRows[serverId]) {
      delete authRows[serverId];
      host.writeMcpAuthState(authRows);
    }
    host.storage.approvalInbox.deleteByReceiver("mcp", serverId);
    host.publishRealtime("system", "mcp", {
      type: "mcp_server_deleted",
      serverId,
    });
  }
  return { deleted };
}

function normalizeMcpOAuthConfig(input?: McpOAuthConfig): McpOAuthConfig | undefined {
  if (!input) {
    return undefined;
  }
  const normalized: McpOAuthConfig = {
    authorizationUrl: input.authorizationUrl?.trim() || undefined,
    tokenUrl: input.tokenUrl?.trim() || undefined,
    clientIdEnv: input.clientIdEnv?.trim() || undefined,
    clientSecretEnv: input.clientSecretEnv?.trim() || undefined,
    scopes: input.scopes?.map((item) => item.trim()).filter(Boolean),
    redirectUri: input.redirectUri?.trim() || undefined,
    tokenRefreshSkewSeconds: input.tokenRefreshSkewSeconds,
  };
  return Object.values(normalized).some((value) => (Array.isArray(value) ? value.length > 0 : value !== undefined))
    ? normalized
    : undefined;
}

function resolveEnvValue(envKey?: string): string | undefined {
  const key = normalizeSafeEnvKeyNames(envKey ? [envKey] : [])[0];
  return key ? process.env[key]?.trim() || undefined : undefined;
}

/** Deps for connected-tool discovery (B5b): sandbox network policy + per-server OAuth token minting. */
export interface ResolveConnectedMcpToolsDeps {
  networkAllowlist: NonNullable<Parameters<typeof discoverMcpTools>[2]>["networkAllowlist"];
  resolveOAuthAccessToken: NonNullable<NonNullable<Parameters<typeof discoverMcpTools>[2]>["oauthAccessTokenResolver"]>;
}

/**
 * Resolve the live tool list for a connecting MCP server: internal servers get
 * their synthesized tools, stdio/http/sse servers get real discovery (with the
 * sandbox network allowlist + OAuth token resolver applied to remote
 * transports), and anything undiscoverable falls back to inference over the
 * previously known tools. Verbatim move from GatewayService; the gateway keeps
 * a thin delegator for the route-composition port.
 */
export async function resolveConnectedMcpTools(
  deps: ResolveConnectedMcpToolsDeps,
  server: McpServerRecord,
  existingTools: McpToolRecord[],
  actorContext?: ToolPolicyActorContext,
): Promise<McpToolRecord[]> {
  if (isInternalMcpApprovalInboxServer(server)) {
    return createInternalMcpApprovalInboxTools(server.serverId);
  }
  if (isInternalMcpDurableTasksServer(server)) {
    return createInternalMcpDurableTasksTools(server.serverId);
  }
  if (server.transport === "stdio") {
    const discovered = await discoverMcpTools(server, undefined, { actorContext });
    if (discovered.length > 0) {
      return discovered;
    }
  }
  if (server.transport === "http" || server.transport === "sse") {
    const discovered = await discoverMcpTools(server, undefined, {
      networkAllowlist: deps.networkAllowlist,
      oauthAccessTokenResolver: deps.resolveOAuthAccessToken,
      actorContext,
    });
    if (discovered.length > 0) {
      return discovered;
    }
  }
  return inferMcpToolsForServer(server, existingTools);
}
