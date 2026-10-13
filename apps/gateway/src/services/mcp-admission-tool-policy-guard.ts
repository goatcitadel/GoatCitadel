import type {
  McpInvokeRequest,
  McpServerRecord,
  McpRequesterAdmissionScope,
  ToolAccessEvaluateRequest,
} from "@goatcitadel/contracts";
import { createMcpToolPolicyBinding, type ToolPolicyEngine } from "@goatcitadel/policy-engine";
import { McpRequesterResolutionError } from "./mcp-requester-resolution.js";
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
): Promise<void> {
  const matches = (await host.readMcpServers()).filter((server) => canonicalName.startsWith(`mcp.${server.serverId}.`));
  if (matches.length !== 1) throw new McpRequesterResolutionError("requester_scope_mismatch");
  const server = matches[0]!;
  const nativeToolName = canonicalName.slice(`mcp.${server.serverId}.`.length);
  await host.assertMcpServerInCapabilityScope({
    serverId: server.serverId,
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
      serverId: server.serverId,
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
    throw new McpRequesterResolutionError("operation_denied");
  }
}
