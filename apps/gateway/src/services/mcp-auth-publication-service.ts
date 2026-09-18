import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { ConflictError, resolveMcpServerConnectionMode, type McpServerRecord } from "@goatcitadel/contracts";
import type { McpServerStoreCtx } from "./mcp-server-store.js";
import type { McpAuthStateRecord, McpAuthStateUpdate } from "./mcp-server-admin-service.js";
import type { McpCredentialRetirementStore } from "./mcp-credential-retirement-store.js";
import type { McpCredentialStagingStore } from "./mcp-credential-staging-store.js";
import { isMcpOAuthTokenRefForServer } from "./mcp-oauth-token-service.js";
import { newMcpServerRevision } from "./mcp-server-revision.js";
import { callerOwnedServers, assertUniqueServers, assertConfigurationSnapshot, jsonMaterial } from "./mcp-server-state-helpers.js";
const MCP_SERVERS_SETTING_KEY = "mcp_servers_v1";
interface McpAuthPublicationPort {
  credentialRetirements: Pick<McpCredentialRetirementStore, "assertPublishable" | "record">;
  credentialStaging: Pick<McpCredentialStagingStore, "publish">;
  removeFirstApprovals(serverIds: string[]): Promise<void>;
}
export async function publishMcpAuthState(ctx: McpServerStoreCtx, port: McpAuthPublicationPort, input: McpAuthStateUpdate): Promise<void> {
    const update = structuredClone(input);
    if (!update?.server?.serverId) throw new TypeError("MCP auth publication requires its server configuration.");
    assertAuthStateTarget(update.server.serverId, update.next);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        await ctx.runImmediateTransaction(async () => {
          const before = await ctx.systemSettings.get<McpServerRecord[]>(MCP_SERVERS_SETTING_KEY);
          const servers = callerOwnedServers(before?.value);
          assertUniqueServers(servers);
          const current = servers.find((server) => server.serverId === update.server.serverId);
          if (!current) throw new ConflictError({ message: "MCP server was removed before auth publication." });
          assertConfigurationSnapshot([current], [update.server]);
          if (resolveMcpServerConnectionMode(current) !== "static" || (update.next && current.authType !== "oauth2")) {
            throw new ConflictError({ message: "MCP auth publication requires static OAuth configuration." });
          }
          const authBefore = await ctx.systemSettings.get<Record<string, McpAuthStateRecord>>("mcp_auth_state_v1");
          const authRows = authBefore?.value ?? {};
          if (!isDeepStrictEqual(jsonMaterial(authRows[current.serverId]), jsonMaterial(update.expected))) {
            throw new ConflictError({ message: "MCP auth state changed before publication." });
          }
          const authorityChanged = !isDeepStrictEqual(
            authAuthorityMaterial(update.expected),
            authAuthorityMaterial(update.next),
          );
          const nextServer = authorityChanged ? { ...current, configurationBindingId: randomUUID(), revision: newMcpServerRevision() } : current;
          const nextServers = servers.map((server) => (server.serverId === current.serverId ? nextServer : server));
          // Even a metadata-only update takes the configuration-row lock before publishing auth.
          if (!(await ctx.systemSettings.compareAndSet(MCP_SERVERS_SETTING_KEY, before, nextServers))) {
            throw new ConflictError({
              code: "WRITE_CONFLICT",
              message: "MCP registry changed during auth publication.",
            });
          }
          const nextAuth = { ...authRows };
          if (update.next) nextAuth[current.serverId] = update.next;
          else delete nextAuth[current.serverId];
          if (!(await ctx.systemSettings.compareAndSet("mcp_auth_state_v1", authBefore, nextAuth))) {
            throw new ConflictError({
              code: "WRITE_CONFLICT",
              message: "MCP auth registry changed during publication.",
            });
          }
          await port.credentialRetirements.assertPublishable(current.serverId, [update.next?.accessTokenRef, update.next?.refreshTokenRef]);
          await port.credentialStaging.publish(current.serverId, [update.next?.accessTokenRef, update.next?.refreshTokenRef]);
          await port.credentialRetirements.record(current.serverId,
            [update.expected?.accessTokenRef, update.expected?.refreshTokenRef],
            [update.next?.accessTokenRef, update.next?.refreshTokenRef]);
          if (authorityChanged) await port.removeFirstApprovals([current.serverId]);
        });
        return;
      } catch (error) {
        if (!(error instanceof ConflictError) || error.code !== "WRITE_CONFLICT") throw error;
      }
    }
    throw new ConflictError({
      code: "WRITE_CONFLICT",
      message: "MCP auth publication conflicted; reload before retrying.",
    });
  }

function authAuthorityMaterial(state: McpAuthStateRecord | undefined): unknown {
  if (
    !state ||
    (!state.accessTokenRef &&
      !state.refreshTokenRef &&
      !state.tokenExpiresAt &&
      !state.scopes?.length &&
      !state.resourceIndicator)
  )
    return undefined;
  return jsonMaterial({
    accessTokenRef: state.accessTokenRef,
    refreshTokenRef: state.refreshTokenRef,
    tokenExpiresAt: state.tokenExpiresAt,
    scopes: state.scopes,
    resourceIndicator: state.resourceIndicator,
  });
}

function assertAuthStateTarget(serverId: string, state: McpAuthStateRecord | undefined): void {
  if (!state) return;
  const allowed = new Set([
    "accessTokenRef",
    "refreshTokenRef",
    "tokenExpiresAt",
    "oauthState",
    "scopes",
    "resourceIndicator",
    "updatedAt",
    "lastRefreshedAt",
    "error",
    "lastCodePreview",
    "tokenRequest",
  ]);
  if (Object.keys(state).some((key) => !allowed.has(key))) {
    throw new ConflictError({ message: "MCP auth state contains unsupported fields." });
  }
  if (state.tokenRequest !== undefined) {
    const request = state.tokenRequest;
    const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
    if (
      !request ||
      typeof request !== "object" ||
      Object.keys(request).length !== 4 ||
      Object.keys(request).some(
        (key) => !["requestId", "kind", "configurationBindingId", "reservedAt"].includes(key),
      ) ||
      typeof request.requestId !== "string" ||
      !uuid.test(request.requestId) ||
      typeof request.configurationBindingId !== "string" ||
      !uuid.test(request.configurationBindingId) ||
      !["authorization_code", "refresh_token"].includes(request.kind) ||
      typeof request.reservedAt !== "string" ||
      !Number.isFinite(Date.parse(request.reservedAt))
    ) {
      throw new ConflictError({ message: "MCP OAuth request reservation is invalid." });
    }
  }
  if (
    (state.accessTokenRef && !isMcpOAuthTokenRefForServer(state.accessTokenRef, serverId, "access-token")) ||
    (state.refreshTokenRef && !isMcpOAuthTokenRefForServer(state.refreshTokenRef, serverId, "refresh-token")) ||
    (state.resourceIndicator !== undefined && state.resourceIndicator !== `mcp://${serverId}`)
  ) {
    throw new ConflictError({ message: "MCP credential references belong to another authority." });
  }
}
