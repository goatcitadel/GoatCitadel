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
import { resolveMcpServerConnectionMode } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { ToolPolicyActorContext } from "@goatcitadel/contracts";
import { inferMcpCategory, normalizeMcpPolicy } from "./mcp-server-policy.js";
import { discoverMcpTools } from "./mcp-runtime.js";
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
  readMcpServers(): Promise<McpServerRecord[]>;
  writeMcpServers(servers: McpServerRecord[]): Promise<void>;
  patchMcpServerState(serverId: string, patch: Partial<McpServerRecord>): Promise<McpServerRecord>;
  readMcpTools(): Promise<McpToolRecord[]>;
  writeMcpTools(tools: McpToolRecord[]): Promise<void>;
  resolveConnectedMcpTools(server: McpServerRecord, existing: McpToolRecord[]): Promise<McpToolRecord[]>;
  exchangeMcpOAuthCode?(
    server: McpServerRecord,
    code: string,
    stateRecord: McpAuthStateRecord,
  ): Promise<McpAuthStateRecord>;
  requireMcpServer(serverId: string): Promise<McpServerRecord>;
  readMcpAuthState(): Promise<Record<string, McpAuthStateRecord>>;
  writeMcpAuthState(state: Record<string, McpAuthStateRecord>): Promise<void>;
  publishRealtime(eventType: string, source: string, payload: Record<string, unknown>): Promise<unknown>;
}

export async function createMcpServer(host: McpServerAdminHost, input: McpServerCreateInput): Promise<McpServerRecord> {
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
  const servers = [created, ...(await host.readMcpServers())];
  await host.writeMcpServers(servers);
  await host.publishRealtime("system", "mcp", {
    type: "mcp_server_created",
    serverId: created.serverId,
    transport: created.transport,
  });
  return created;
}

export async function updateMcpServer(
  host: McpServerAdminHost,
  serverId: string,
  input: McpServerUpdateInput,
): Promise<McpServerRecord> {
  if (isInternalMcpServerUrl(input.url)) {
    throw new Error(buildInternalMcpServerCreateBlockedMessage());
  }
  const now = new Date().toISOString();
  let updated: McpServerRecord | undefined;
  const servers = (await host.readMcpServers()).map((item) => {
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
  await host.writeMcpServers(servers);
  return updated;
}

export async function updateMcpServerPolicy(
  host: McpServerAdminHost,
  serverId: string,
  policy: Partial<McpServerPolicy>,
): Promise<McpServerRecord> {
  return await updateMcpServer(host, serverId, { policy });
}

export async function connectMcpServer(host: McpServerAdminHost, serverId: string): Promise<McpServerRecord> {
  const server = await host.requireMcpServer(serverId);
  // HX-415: a requester-scoped server resolves its connection per authenticated
  // requester. It is never connected or discovered globally, and never mutates
  // shared server status, tool cache, or error state. Fail closed BEFORE any
  // `connecting`/`error` status patch so no global state is written.
  if (resolveMcpServerConnectionMode(server) === "requester_scoped") {
    throw new Error(
      "Requester-scoped MCP servers require an authenticated requester context and cannot be connected or discovered globally.",
    );
  }
  if (!isRuntimeSupportedMcpDefinition(server)) {
    throw new Error(buildUnsupportedMcpTransportMessage(server.transport));
  }
  const connecting = await host.patchMcpServerState(serverId, {
    status: "connecting",
    lastError: undefined,
  });
  try {
    const tools = await host.readMcpTools();
    const existing = tools.filter((item) => item.serverId === serverId);
    const resolvedTools = await host.resolveConnectedMcpTools(connecting, existing);
    // Live discovery is authoritative, including a valid empty catalog. Always
    // replace this server's cache so removed tools cannot survive reconnect.
    await host.writeMcpTools([...tools.filter((item) => item.serverId !== serverId), ...resolvedTools]);
    return await host.patchMcpServerState(serverId, {
      status: "connected",
      lastConnectedAt: new Date().toISOString(),
      lastError: undefined,
    });
  } catch (error) {
    await host.patchMcpServerState(serverId, {
      status: "error",
      lastError: (error as Error).message,
    });
    throw error;
  }
}

export async function disconnectMcpServer(host: McpServerAdminHost, serverId: string): Promise<McpServerRecord> {
  return await host.patchMcpServerState(serverId, {
    status: "disconnected",
  });
}

export async function startMcpOAuth(host: McpServerAdminHost, serverId: string): Promise<McpOAuthStartResponse> {
  const server = await host.requireMcpServer(serverId);
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
  const authRows = await host.readMcpAuthState();
  authRows[serverId] = {
    ...(authRows[serverId] ?? {}),
    oauthState: state,
    error: undefined,
    updatedAt: new Date().toISOString(),
  };
  await host.writeMcpAuthState(authRows);
  return { authorizeUrl: authorizeUrl.toString(), state };
}

export async function completeMcpOAuth(
  host: McpServerAdminHost,
  serverId: string,
  code: string,
  state?: string,
): Promise<McpServerRecord> {
  const authRows = await host.readMcpAuthState();
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
  const server = await host.requireMcpServer(serverId);
  if (!host.exchangeMcpOAuthCode) {
    throw new Error("MCP OAuth token exchange is not available in this Gateway runtime.");
  }
  authRows[serverId] = await host.exchangeMcpOAuthCode(server, code, authRow);
  await host.writeMcpAuthState(authRows);
  return await connectMcpServer(host, serverId);
}

export async function deleteMcpServer(host: McpServerAdminHost, serverId: string): Promise<{ deleted: boolean }> {
  const previous = await host.readMcpServers();
  const next = previous.filter((item) => item.serverId !== serverId);
  const deleted = next.length !== previous.length;
  if (deleted) {
    await host.writeMcpServers(next);
    await host.writeMcpTools((await host.readMcpTools()).filter((tool) => tool.serverId !== serverId));
    const authRows = await host.readMcpAuthState();
    if (authRows[serverId]) {
      delete authRows[serverId];
      await host.writeMcpAuthState(authRows);
    }
    await host.storage.approvalInbox.deleteByReceiver("mcp", serverId);
    await host.publishRealtime("system", "mcp", {
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
 * their synthesized tools, while stdio/http/sse servers get exact live
 * discovery (with the sandbox network allowlist + OAuth token resolver applied
 * to remote transports). A valid empty catalog stays empty; guessed or stale
 * tools are never substituted for authoritative discovery.
 */
export async function resolveConnectedMcpTools(
  deps: ResolveConnectedMcpToolsDeps,
  server: McpServerRecord,
  _existingTools: McpToolRecord[],
  actorContext?: ToolPolicyActorContext,
): Promise<McpToolRecord[]> {
  // HX-415 defense in depth: requester-scoped discovery is ephemeral and
  // profile-bound. The global tool-resolution path never discovers or infers
  // tools for a requester-scoped server, and never writes them to shared state.
  if (resolveMcpServerConnectionMode(server) === "requester_scoped") {
    return [];
  }
  if (isInternalMcpApprovalInboxServer(server)) {
    return createInternalMcpApprovalInboxTools(server.serverId);
  }
  if (isInternalMcpDurableTasksServer(server)) {
    return createInternalMcpDurableTasksTools(server.serverId);
  }
  if (server.transport === "stdio") {
    return discoverMcpTools(server, undefined, { actorContext });
  }
  if (server.transport === "http" || server.transport === "sse") {
    return discoverMcpTools(server, undefined, {
      networkAllowlist: deps.networkAllowlist,
      oauthAccessTokenResolver: deps.resolveOAuthAccessToken,
      actorContext,
    });
  }
  return [];
}
