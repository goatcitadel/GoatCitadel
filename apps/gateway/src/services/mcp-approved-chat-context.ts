import { NotFoundError, type ChatTurnCapabilityProfileRecord, type ToolInvokeRequest } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import { approvedExternalRuntimeRequestMatches } from "./gateway/external-runtime-approval-adapter.js";
import { isNativeMcpToolName } from "./gateway/native-mcp-chat-binding.js";
import { isMeshChatToolName } from "./gateway/mesh-chat-binding.js";

type ContextStorage = Pick<AsyncStorage,
  "pendingApprovalActions" | "approvals" | "chatToolRuns" | "chatTurnCapabilityProfiles">;

/**
 * Restore identity from the canonical Chat approval join. This returns a stored
 * profile, never requester authority; only Gateway composition can mint a handle.
 * Missing linkage leaves requester-scoped dispatch closed, including old/direct
 * MCP approvals that were not created by a Chat turn.
 */
export async function readApprovedMcpChatProfile(
  storage: ContextStorage,
  approvalId: string,
  request: ToolInvokeRequest,
): Promise<ChatTurnCapabilityProfileRecord | undefined> {
  if (request.toolName !== "mcp.invoke" && !isNativeMcpToolName(request.toolName)) return undefined;
  return readApprovedExternalChatProfile(storage, approvalId, request);
}

/** Shared exact Chat approval join for native MCP and mesh execution owners. */
export async function readApprovedExternalChatProfile(
  storage: ContextStorage,
  approvalId: string,
  request: ToolInvokeRequest,
): Promise<ChatTurnCapabilityProfileRecord | undefined> {
  if ((request.toolName !== "mcp.invoke" && !isNativeMcpToolName(request.toolName) && !isMeshChatToolName(request.toolName)) ||
    !request.turnId || !request.toolRunId || !request.workspaceId) return undefined;
  const pending = await storage.pendingApprovalActions.find(approvalId);
  if (!pending || pending.approvalId !== approvalId || pending.actionType !== "tool.invoke" ||
    pending.resolutionStatus !== "pending" || !approvedExternalRuntimeRequestMatches(pending.request, request)) return undefined;
  try {
    const [approval, tool, profile] = await Promise.all([
      storage.approvals.get(approvalId),
      storage.chatToolRuns.get(request.toolRunId),
      storage.chatTurnCapabilityProfiles.findByTurn(request.turnId),
    ]);
    if (!profile || (approval.status !== "approved" && approval.status !== "edited") ||
      approval.approvalId !== approvalId || tool.approvalId !== approvalId ||
      tool.toolRunId !== request.toolRunId || tool.status !== "approval_required" ||
      tool.toolName !== request.toolName || tool.turnId !== request.turnId || tool.sessionId !== request.sessionId) return undefined;
    const identity = profile.identity;
    const linkage = approval.linkage;
    if (!linkage || linkage.sessionId !== identity.sessionId || linkage.turnId !== identity.turnId ||
      linkage.workspaceId !== identity.workspaceId || linkage.toolName !== request.toolName ||
      identity.turnId !== request.turnId || identity.sessionId !== request.sessionId ||
      identity.workspaceId !== request.workspaceId ||
      (request.citadelId !== undefined && request.citadelId !== identity.citadelId) ||
      !identity.authActorId || identity.authActorId !== request.policyContext?.authActorId ||
      identity.authActorSource !== request.policyContext?.authActorSource ||
      (linkage.authActorId !== undefined && linkage.authActorId !== identity.authActorId) ||
      (linkage.authActorSource !== undefined && linkage.authActorSource !== identity.authActorSource) ||
      (linkage.durableRunId !== undefined && linkage.durableRunId !== identity.durableRunId) ||
      (linkage.runId !== undefined && linkage.runId !== request.runId) ||
      !profile.selection.tools.some((selected) => selected.canonicalName === request.toolName)) return undefined;
    return profile;
  } catch (error) {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
}
