import {
  NotFoundError,
  mcpCallAsksFirst,
  resolveMcpServerConnectionMode,
  type McpServerRecord,
  type McpToolRecord,
} from "@goatcitadel/contracts";
import {
  createMcpApprovalRelief,
  readMcpToolPolicyBinding,
  type McpApprovalRelief,
  type McpToolPolicyBinding,
} from "@goatcitadel/policy-engine";

/** Server-owned state only: the saved server record and the stored `mcp_tools_v1` inventory. */
export interface McpApprovalReliefPort {
  requireMcpServer(serverId: string): Promise<McpServerRecord>;
  listMcpTools(serverId: string): Promise<McpToolRecord[]>;
}

const CANONICAL_MCP_TOOL_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,254}$/;

/**
 * Decide, from server-owned state, whether one MCP call may skip the approval mode's ask (the
 * connector's own setting overrides even an ask-for-everything profile for that call).
 * The target comes from the trusted named binding, or from the exact `mcp.invoke` wrapper fields the
 * transport owner will send. Returns a relief only when the server is a static connector with a saved
 * approval setting and every stored inventory entry for that tool name says the call need not ask.
 * Anything missing (server, inventory, tool, labels or setting) returns undefined, so the call asks.
 * A remote A2A peer never gets relief (the policy engine refuses it too). A granted relief is also
 * the only thing that lets a call skip the server's legacy first-use check.
 */
export async function resolveMcpApprovalRelief(
  port: McpApprovalReliefPort,
  request: {
    toolName: string;
    args?: Record<string, unknown>;
    policyContext?: { authActorSource?: string };
  },
  binding?: McpToolPolicyBinding,
): Promise<McpApprovalRelief | undefined> {
  if (request.policyContext?.authActorSource === "a2a_peer") return undefined;
  const target = readMcpApprovalReliefTarget(request, binding);
  if (!target) return undefined;
  let server: McpServerRecord;
  try {
    server = await port.requireMcpServer(target.serverId);
  } catch (error) {
    // An unknown server gets no relief; policy and the runtime owner report it as before.
    if (error instanceof NotFoundError) return undefined;
    throw error;
  }
  const posture = server.policy.approvalPosture;
  if (
    posture === undefined ||
    !server.enabled ||
    server.trustTier === "quarantined" ||
    resolveMcpServerConnectionMode(server) !== "static"
  ) {
    return undefined;
  }
  const entries = (await port.listMcpTools(target.serverId)).filter(
    (tool) => tool.serverId === target.serverId && tool.toolName === target.nativeToolName,
  );
  // Every same-named entry must independently allow it; an unlabelled or disagreeing duplicate asks.
  if (entries.length === 0 || entries.some((tool) => mcpCallAsksFirst(posture, tool.annotations))) {
    return undefined;
  }
  return createMcpApprovalRelief({ canonicalName: target.canonicalName });
}

function readMcpApprovalReliefTarget(
  request: { toolName: string; args?: Record<string, unknown> },
  binding: McpToolPolicyBinding | undefined,
): { serverId: string; nativeToolName: string; canonicalName: string } | undefined {
  if (binding) {
    const identity = readMcpToolPolicyBinding(binding, request.toolName);
    return identity
      ? { serverId: identity.serverId, nativeToolName: identity.nativeToolName, canonicalName: identity.canonicalName }
      : undefined;
  }
  if (request.toolName !== "mcp.invoke") return undefined;
  const serverId = request.args?.serverId;
  const nativeToolName = request.args?.toolName;
  if (typeof serverId !== "string" || typeof nativeToolName !== "string" || !serverId || !nativeToolName) {
    return undefined;
  }
  // Use the untrimmed fields the transport owner sends. Padding fails this check, so policy's
  // trimmed target and the runtime's target can never name two different tools under one relief.
  const canonicalName = `mcp.${serverId}.${nativeToolName}`;
  return CANONICAL_MCP_TOOL_NAME.test(canonicalName) ? { serverId, nativeToolName, canonicalName } : undefined;
}
