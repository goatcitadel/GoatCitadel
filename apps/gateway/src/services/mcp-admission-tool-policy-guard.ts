import type {
  McpInvokeRequest,
  McpServerRecord,
  McpRequesterAdmissionScope,
  ToolAccessEvaluateRequest,
} from "@goatcitadel/contracts";
import { createMcpToolPolicyBinding, type ToolPolicyEngine } from "@goatcitadel/policy-engine";
import { McpRequesterResolutionError } from "./mcp-requester-resolution.js";
import { mcpChatAccessError } from "./mcp-chat-access-error.js";
export interface McpAdmissionToolPolicyHost {
  readMcpServers(): Promise<McpServerRecord[]>;
  assertMcpServerInCapabilityScope(request: McpInvokeRequest): Promise<void>;
  prepareToolAccessEvaluation(request: ToolAccessEvaluateRequest): Promise<ToolAccessEvaluateRequest>;
  inspectAccess: ToolPolicyEngine["inspectAccess"];
  recordDevDiagnostic(input: {
    level: "warn";
    category: "mcp";
    event: string;
    message: string;
    sessionId: string;
    context: Record<string, unknown>;
  }): void;
}
/** Fresh policy check only; does not issue authority or dispatch the tool. */
export async function assertMcpAdmissionToolAllowed(
  host: McpAdmissionToolPolicyHost,
  scope: McpRequesterAdmissionScope,
  canonicalName: string,
  serverId: string,
): Promise<void> {
  // The caller supplies the identity from the saved connection or admission receipt.
  // A canonical name alone can match both a dotted server ID and a shorter prefix.
  const prefix = `mcp.${serverId}.`;
  const nativeToolName = canonicalName.slice(prefix.length);
  if (
    !canonicalName.startsWith(prefix) ||
    !nativeToolName ||
    !(await host.readMcpServers()).some((server) => server.serverId === serverId)
  ) {
    throw new McpRequesterResolutionError("requester_scope_mismatch");
  }
  await host.assertMcpServerInCapabilityScope({
    serverId,
    toolName: nativeToolName,
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    agentId: "assistant",
  });
  const request = await host.prepareToolAccessEvaluation({
    toolName: canonicalName,
    args: {},
    agentId: "assistant",
    workspaceId: scope.workspaceId,
    sessionId: scope.sessionId,
    surface: "chat",
    policyContext: { authActorId: scope.actorId, authActorSource: scope.actorSource, workspaceId: scope.workspaceId },
  });
  const access = await host.inspectAccess(request, {
    mcpToolBinding: createMcpToolPolicyBinding({
      canonicalName,
      serverId,
      nativeToolName,
    }),
  });
  if (!access.allowed) {
    host.recordDevDiagnostic({
      level: "warn",
      category: "mcp",
      event: "mcp.admission.policy_denied",
      message: "Selected MCP tool is blocked by current Chat permissions or server policy.",
      sessionId: scope.sessionId,
      context: { reasonCodes: access.reasonCodes, permissionProfileId: access.permissionProfileId },
    });
    const codes = new Set(access.reasonCodes);
    if (codes.has("policy_deny") || codes.has("policy_disallow")) throw mcpChatAccessError("tool_policy");
    if (codes.has("permission_profile_upper_bound")) throw mcpChatAccessError("permission_profile");
    if (codes.has("citadel_ward_deny")) throw mcpChatAccessError("citadel_policy");
    if (codes.has("grant_deny") || codes.has("grant_constraints_block")) throw mcpChatAccessError("scoped_grant");
    throw mcpChatAccessError("policy_unavailable");
  }
}
