import {
  canonicalJsonString,
  resolveMcpServerConnectionMode,
  type ChatTurnCapabilityProfileRecord,
  type McpRequesterScopeHashInput,
  type McpServerRecord,
} from "@goatcitadel/contracts";
import { verifyChatTurnCapabilityProfile, verifyChatTurnCapabilityCatalogBinding } from "@goatcitadel/storage";
import type { McpStaticChatServiceOptions } from "./mcp-static-chat-service.js";
import { assertStaticMcpToolBindingIntegrity } from "./mcp-static-catalog.js";
import { GATEWAY_OWNED_MCP_SERVER_IDS } from "./mcp-server-store.js";
import type { McpRequesterScopedCatalogDiscoveryHookInput } from "./mcp-requester-resolution-service.js";
export type StaticMcpProfileAuthorityHost = Pick<
  McpStaticChatServiceOptions,
  "storage" | "assertMcpServerInScope" | "readAuthConnectionState" | "listCallableCapabilities" | "registry"
>;
/** Historical decoding remains distinct from live admission. No dispatch authority is issued here. */
export async function readHistoricalStaticMcpBinding(
  host: StaticMcpProfileAuthorityHost,
  profile: ChatTurnCapabilityProfileRecord,
  canonicalName: string,
) {
  const stored = await host.storage.chatTurnCapabilityProfiles.get(profile.profileId);
  verifyChatTurnCapabilityProfile(stored);
  if (
    stored.hashes.profileHash !== profile.hashes.profileHash ||
    canonicalJsonString(stored.identity) !== canonicalJsonString(profile.identity)
  )
    throw unavailable();
  const catalog = await host.storage.capabilityCatalogSnapshots.get(stored.catalog.snapshotId);
  verifyChatTurnCapabilityCatalogBinding(stored, catalog);
  const selected = stored.selection.tools.filter((tool) => tool.canonicalName === canonicalName);
  const tool = selected.length === 1 ? selected[0] : undefined;
  const binding = tool?.mcpStaticBinding;
  if (!binding || !tool) throw unavailable();
  assertStaticMcpToolBindingIntegrity(binding);
  const scope = scopeFromProfile(stored);
  await assertHistoricalStaticMcpScope(host, scope, binding.serverId);
  const live = await host.listCallableCapabilities(scope.workspaceId);
  const shared = catalog.callableEntries.find((entry) => entry.kind === "tool" && entry.toolName === "mcp.invoke");
  if (
    !shared ||
    !live.some((entry) => entry.callable && canonicalJsonString(entry) === canonicalJsonString(shared)) ||
    live.some((entry) => entry.toolName === canonicalName || entry.capabilityId === `tool:${canonicalName}`)
  )
    throw unavailable();
  const server = await host.registry.requireServer(binding.serverId);
  if (
    !isConnectedStaticServer(server) ||
    server.configurationBindingId !== binding.configurationBindingId ||
    server.transport !== binding.transport
  )
    throw unavailable();
  return { server, binding, tool, scope };
}

export async function assertHistoricalStaticMcpScope(
  host: StaticMcpProfileAuthorityHost,
  scope: McpRequesterScopeHashInput,
  serverId: string,
): Promise<void> {
  await host.assertMcpServerInScope({
    serverId,
    toolName: "__profile_discovery__",
    agentId: "assistant",
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
  });
  if ((await host.readAuthConnectionState({ actorId: scope.authActorId, actorSource: scope.authActorSource })).revoked)
    throw unavailable();
}

export function isConnectedStaticServer(server: McpServerRecord): boolean {
  return (
    !GATEWAY_OWNED_MCP_SERVER_IDS.has(server.serverId) &&
    resolveMcpServerConnectionMode(server) === "static" &&
    server.enabled &&
    server.status === "connected" &&
    Boolean(server.configurationBindingId)
  );
}
export function scopeFromHook(hook: McpRequesterScopedCatalogDiscoveryHookInput): McpRequesterScopeHashInput {
  if (!hook.authActorId || !["token", "basic", "loopback", "device", "companion"].includes(hook.authActorSource ?? ""))
    throw unavailable();
  return {
    profileId: hook.profileId,
    turnId: hook.turnId,
    sessionId: hook.sessionId,
    workspaceId: hook.workspaceId,
    authActorId: hook.authActorId,
    authActorSource: hook.authActorSource as McpRequesterScopeHashInput["authActorSource"],
  };
}
export function scopeFromProfile(profile: ChatTurnCapabilityProfileRecord): McpRequesterScopeHashInput {
  return scopeFromHook({
    profileId: profile.profileId,
    ...profile.identity,
    catalogSnapshotId: profile.catalog.snapshotId,
    callableCatalogSha256: profile.catalog.callableHash,
  });
}
function unavailable(): Error {
  return new Error("Static MCP authority is no longer current.");
}
