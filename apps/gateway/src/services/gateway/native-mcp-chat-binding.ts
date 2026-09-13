import { createHash } from "node:crypto";
import {
  canonicalJsonString,
  mcpRequesterScopeHashMaterial,
  mcpStaticToolScopeHashMaterial,
  NotFoundError,
  type ToolAccessEvaluateRequest,
  type ToolInvokeRequest,
  type McpStaticToolBinding,
} from "@goatcitadel/contracts";
import {
  createMcpToolPolicyBinding,
  ToolExecutionPreconditionError,
  type McpToolPolicyBinding,
} from "@goatcitadel/policy-engine";
import { verifyChatTurnCapabilityProfile, type AsyncStorage } from "@goatcitadel/storage";
import { assertStaticMcpToolBindingIntegrity } from "../mcp-static-catalog.js";
import { assertMcpRequesterResolutionBindingIntegrity } from "../mcp-requester-resolution.js";
import {
  readMcpRequesterScopedTurnContext,
  type McpRequesterScopedTurnContextHandle,
} from "../mcp-requester-resolution-service.js";

export interface NativeMcpChatToolBinding {
  readonly serverId: string;
  readonly nativeToolName: string;
  readonly policyBinding: McpToolPolicyBinding;
  readonly staticBinding?: McpStaticToolBinding;
}

export function isNativeMcpToolName(toolName: string): boolean {
  return toolName.startsWith("mcp.") && toolName !== "mcp.invoke";
}

function invalidBinding(): never {
  throw new ToolExecutionPreconditionError("Native MCP tool requires its exact frozen Chat capability binding");
}

/**
 * Recover a named MCP target from a branded Chat context and the durable profile.
 * This projection grants no requester or transport authority. The MCP owner
 * still re-resolves auth, configuration, schema and scope before every write.
 * Static/legacy profiles without an explicit native binding fail closed.
 */
export async function resolveNativeMcpChatToolBinding(
  storage: Pick<AsyncStorage, "chatTurnCapabilityProfiles">,
  request: ToolAccessEvaluateRequest & Partial<Pick<ToolInvokeRequest, "turnId">>,
  handle: McpRequesterScopedTurnContextHandle | undefined,
): Promise<NativeMcpChatToolBinding | undefined> {
  if (!isNativeMcpToolName(request.toolName)) return undefined;
  const context = readMcpRequesterScopedTurnContext(handle);
  if (
    !context ||
    request.sessionId !== context.sessionId ||
    request.workspaceId !== context.workspaceId ||
    request.policyContext?.authActorId !== context.actorId ||
    request.policyContext.authActorSource !== context.actorSource ||
    (request.turnId !== undefined && request.turnId !== context.turnId)
  )
    invalidBinding();
  let profile;
  try {
    profile = await storage.chatTurnCapabilityProfiles.get(context.profileId);
  } catch (error) {
    if (error instanceof NotFoundError) invalidBinding();
    throw error;
  }
  const identity = profile.identity;
  if (
    profile.profileId !== context.profileId ||
    profile.hashes.profileHash !== context.finalProfileSha256 ||
    profile.catalog.snapshotId !== context.callableCatalogSnapshotId ||
    profile.catalog.callableHash !== context.baseCallableCatalogSha256 ||
    profile.catalog.callableHash !== context.finalCallableCatalogSha256 ||
    identity.turnId !== context.turnId ||
    identity.sessionId !== context.sessionId ||
    identity.workspaceId !== context.workspaceId ||
    identity.authActorId !== context.actorId ||
    identity.authActorSource !== context.actorSource ||
    (request.citadelId !== undefined && request.citadelId !== identity.citadelId)
  )
    invalidBinding();
  const selected = profile.selection.tools.filter((tool) => tool.canonicalName === request.toolName);
  const staticBinding = selected.length === 1 ? selected[0]?.mcpStaticBinding : undefined;
  if (staticBinding) {
    try {
      verifyChatTurnCapabilityProfile(profile);
      assertStaticMcpToolBindingIntegrity(staticBinding);
    } catch { invalidBinding(); }
    const scopeHash = createHash("sha256").update(canonicalJsonString(mcpStaticToolScopeHashMaterial({
      profileId: profile.profileId, turnId: identity.turnId, sessionId: identity.sessionId, workspaceId: identity.workspaceId,
      authActorId: context.actorId, authActorSource: context.actorSource,
    }))).digest("hex");
    if (staticBinding.profileScopeSha256 !== scopeHash || staticBinding.toolName !== request.toolName) invalidBinding();
    return Object.freeze({ serverId: staticBinding.serverId, nativeToolName: staticBinding.nativeToolName, staticBinding,
      policyBinding: createMcpToolPolicyBinding({ canonicalName: request.toolName, serverId: staticBinding.serverId,
        nativeToolName: staticBinding.nativeToolName }) });
  }
  const binding = selected.length === 1 ? selected[0]?.mcpRequesterResolution : undefined;
  if (!binding) invalidBinding();
  try {
    assertMcpRequesterResolutionBindingIntegrity(binding);
  } catch {
    invalidBinding();
  }
  const requesterScopeHash = createHash("sha256")
    .update(
      canonicalJsonString(
        mcpRequesterScopeHashMaterial({
          profileId: profile.profileId,
          turnId: identity.turnId,
          sessionId: identity.sessionId,
          workspaceId: identity.workspaceId,
          authActorId: context.actorId,
          authActorSource: context.actorSource,
        }),
      ),
    )
    .digest("hex");
  if (
    binding.toolName !== request.toolName ||
    binding.callableCatalogSnapshotId !== profile.catalog.snapshotId ||
    binding.callableCatalogSha256 !== profile.catalog.callableHash ||
    binding.requesterScopeSha256 !== requesterScopeHash
  )
    invalidBinding();
  // Server IDs and native names may both contain dots. Only the stored explicit
  // server ID identifies the prefix; never split a canonical name on dots.
  const prefix = `mcp.${binding.serverId}.`;
  if (!request.toolName.startsWith(prefix)) invalidBinding();
  const nativeToolName = request.toolName.slice(prefix.length);
  return Object.freeze({
    serverId: binding.serverId,
    nativeToolName,
    policyBinding: createMcpToolPolicyBinding({
      canonicalName: request.toolName,
      serverId: binding.serverId,
      nativeToolName,
    }),
  });
}
