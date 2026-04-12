import { randomUUID } from "node:crypto";
import type {
  ApprovalRequest,
  McpInvokeRequest,
  McpInvokeResponse,
  McpServerRecord,
  McpToolRecord,
  RealtimeEvent,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { ApprovalInboxRepository } from "@goatcitadel/storage";
import type { HooksService } from "./hooks-service.js";
import { handleInternalMcpApprovalInboxInvoke, isInternalMcpApprovalInboxServer } from "./mcp-approval-inbox.js";
import type { McpRuntimeInvocationResult } from "./mcp-runtime.js";

type ToolCallHookPatch = Record<string, unknown> & {
  toolName?: string;
  args?: Record<string, unknown>;
};

interface ToolPolicyAccessResult {
  allowed: boolean;
  requiresApproval: boolean;
  reasonCodes: string[];
}

type RealtimePublishOptions = Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">;

function buildMcpInvocationRealtimeOptions(input: { sessionId?: string; taskId?: string }): RealtimePublishOptions {
  return {
    eventClass: "operational_signal",
    eventAuthority: "retained_stream",
    links: {
      sessionId: input.sessionId,
      taskId: input.taskId,
    },
  };
}

export interface ToolInvocationCoordinatorHost {
  readonly approvalInbox: Pick<
    ApprovalInboxRepository,
    "receiveMcpApprovalDelivery" | "listByReceiver" | "get" | "markResolved"
  >;
  readonly policyEngine: {
    invoke(request: ToolInvokeRequest): Promise<ToolInvokeResult>;
    invoke(request: {
      toolName: "mcp.invoke";
      args: {
        serverId: string;
        toolName: string;
        arguments: Record<string, unknown>;
      };
      agentId: string;
      sessionId: string;
      taskId?: string;
      consentContext?: {
        source: "agent";
        reason: string;
      };
    }): Promise<ToolInvokeResult>;
    evaluateAccess(request: {
      toolName: "mcp.invoke";
      args: {
        serverId: string;
        toolName: string;
        arguments: Record<string, unknown>;
      };
      agentId: string;
      sessionId: string;
      taskId?: string;
    }): ToolPolicyAccessResult;
  };
  readonly hooksService: Pick<HooksService, "runInlineHooks" | "enqueueAfterHooks">;
  normalizeToolInvokeRequest(request: ToolInvokeRequest): ToolInvokeRequest;
  isValidToolName(name: string): boolean;
  evaluateToolDeploymentGuard(request: ToolInvokeRequest): { reason: string } | null | undefined;
  resolveToolHookWorkspaceId(request: ToolInvokeRequest): string;
  parseToolCallHookPatch(value: Record<string, unknown>): ToolCallHookPatch | undefined;
  primeToolApprovalLifecycle(approvalId: string, request: ToolInvokeRequest): ApprovalRequest;
  scheduleApprovalExplanationById(approvalId: string): void;
  publishRealtime(
    eventType: string,
    source: string,
    payload: Record<string, unknown>,
    options?: RealtimePublishOptions,
  ): void;
  requireMcpServer(serverId: string): McpServerRecord;
  listMcpTools(serverId: string): McpToolRecord[];
  matchesWildcard(value: string, pattern: string): boolean;
  isMcpToolApproved(serverId: string, toolName: string): boolean;
  invokeMcpRuntimeTool(
    server: McpServerRecord,
    input: Pick<McpInvokeRequest, "toolName" | "arguments" | "signal">,
  ): Promise<McpRuntimeInvocationResult>;
  resolveApprovalWithRemoteTokenId(input: {
    tokenId: string;
    decision: "approve" | "reject" | "edit";
    editedPayload?: Record<string, unknown>;
    resolutionNote?: string;
  }): Promise<{ approval: ApprovalRequest }>;
  applyMcpRedaction(
    output: Record<string, unknown>,
    mode: McpServerRecord["policy"]["redactionMode"],
  ): Record<string, unknown>;
}

export interface ToolInvocationCoordinator {
  invokeTool(request: ToolInvokeRequest): Promise<ToolInvokeResult>;
  invokeMcpTool(input: McpInvokeRequest): Promise<McpInvokeResponse>;
}

export class ToolInvocationCoordinatorService implements ToolInvocationCoordinator {
  public constructor(private readonly host: ToolInvocationCoordinatorHost) {}

  public async invokeTool(request: ToolInvokeRequest): Promise<ToolInvokeResult> {
    if (!this.host.isValidToolName(request.toolName)) {
      return {
        outcome: "blocked",
        policyReason: "blocked: invalid tool name format",
        auditEventId: randomUUID(),
      };
    }

    const normalizedRequest = this.host.normalizeToolInvokeRequest(request);
    const toolHookWorkspaceId = this.host.resolveToolHookWorkspaceId(normalizedRequest);
    const toolHookEntityId = `${normalizedRequest.sessionId}:${randomUUID()}`;
    const deploymentGuard = this.host.evaluateToolDeploymentGuard(normalizedRequest);
    if (deploymentGuard) {
      return {
        outcome: "blocked",
        policyReason: `blocked: ${deploymentGuard.reason}`,
        auditEventId: randomUUID(),
      };
    }

    const beforeHook = await this.host.hooksService.runInlineHooks<ToolCallHookPatch>({
      workspaceId: toolHookWorkspaceId,
      trigger: "tool.call.before",
      entityType: "tool_call",
      entityId: toolHookEntityId,
      payload: {
        toolName: normalizedRequest.toolName,
        args: normalizedRequest.args,
        agentId: normalizedRequest.agentId,
        sessionId: normalizedRequest.sessionId,
        taskId: normalizedRequest.taskId,
      },
      parsePatch: (value) => this.host.parseToolCallHookPatch(value),
      mergePatch: (current, next) => ({
        ...(current ?? {}),
        ...next,
      }),
    });
    if (beforeHook.blockedBy) {
      return {
        outcome: "blocked",
        policyReason: `hook blocked: ${beforeHook.blockedBy.reason}`,
        auditEventId: randomUUID(),
      };
    }

    const hookableRequest = beforeHook.patch
      ? {
          ...normalizedRequest,
          ...(beforeHook.patch.toolName ? { toolName: beforeHook.patch.toolName } : {}),
          ...(beforeHook.patch.args ? { args: beforeHook.patch.args } : {}),
        }
      : normalizedRequest;

    let result: ToolInvokeResult;
    try {
      result = await this.host.policyEngine.invoke(hookableRequest);
    } catch (error) {
      this.host.hooksService.enqueueAfterHooks({
        workspaceId: toolHookWorkspaceId,
        trigger: "tool.call.error",
        entityType: "tool_call",
        entityId: toolHookEntityId,
        payload: {
          toolName: hookableRequest.toolName,
          args: hookableRequest.args,
          sessionId: hookableRequest.sessionId,
          taskId: hookableRequest.taskId,
          error: error instanceof Error ? error.message : String(error),
        },
      });
      throw error;
    }

    const approvalForResult =
      result.outcome === "approval_required" && result.approvalId
        ? this.host.primeToolApprovalLifecycle(result.approvalId, hookableRequest)
        : undefined;

    this.host.publishRealtime(
      "tool_invoked",
      "policy",
      {
        toolName: hookableRequest.toolName,
        sessionId: hookableRequest.sessionId,
        agentId: hookableRequest.agentId,
        taskId: hookableRequest.taskId,
        outcome: result.outcome,
        policyReason: result.policyReason,
        approvalId: result.approvalId,
        auditEventId: result.auditEventId,
      },
      {
        eventClass: "operational_signal",
        eventAuthority: "retained_stream",
        links: {
          sessionId: hookableRequest.sessionId,
          taskId: hookableRequest.taskId,
          approvalId: result.approvalId,
          runId: approvalForResult?.linkage?.durableRunId,
        },
      },
    );

    if (result.outcome === "approval_required" && result.approvalId) {
      this.host.scheduleApprovalExplanationById(result.approvalId);
    }

    this.host.hooksService.enqueueAfterHooks({
      workspaceId: toolHookWorkspaceId,
      trigger: "tool.call.after",
      entityType: "tool_call",
      entityId: toolHookEntityId,
      payload: {
        toolName: hookableRequest.toolName,
        args: hookableRequest.args,
        sessionId: hookableRequest.sessionId,
        taskId: hookableRequest.taskId,
        result,
      },
    });

    return result;
  }

  public async invokeMcpTool(input: McpInvokeRequest): Promise<McpInvokeResponse> {
    const server = this.host.requireMcpServer(input.serverId);
    if (!server.enabled || server.status !== "connected") {
      return {
        ok: false,
        error: "MCP server is not connected.",
      };
    }
    if (server.trustTier === "quarantined") {
      return {
        ok: false,
        error: `MCP server ${server.label} is quarantined and cannot execute tools.`,
      };
    }

    const tool = this.host
      .listMcpTools(input.serverId)
      .find((candidate) => candidate.toolName === input.toolName && candidate.enabled);
    if (!tool) {
      return {
        ok: false,
        error: `MCP tool ${input.toolName} is not enabled on server ${input.serverId}.`,
      };
    }
    if (server.policy.blockedToolPatterns.some((pattern) => this.host.matchesWildcard(input.toolName, pattern))) {
      return {
        ok: false,
        error: `MCP policy blocked tool ${input.toolName} on server ${server.serverId}.`,
      };
    }
    if (
      server.policy.allowedToolPatterns.length > 0 &&
      !server.policy.allowedToolPatterns.some((pattern) => this.host.matchesWildcard(input.toolName, pattern))
    ) {
      return {
        ok: false,
        error: `MCP policy does not allow tool ${input.toolName} on server ${server.serverId}.`,
      };
    }
    if (server.policy.requireFirstToolApproval && !this.host.isMcpToolApproved(input.serverId, input.toolName)) {
      return {
        ok: false,
        error: `First-use approval required for ${input.toolName}. Approve this tool in MCP policy or disable first-use approval.`,
      };
    }

    const policyAgentId = input.agentId?.trim() || "operator";
    const policySessionId = input.sessionId?.trim() || `mcp:${input.serverId}`;
    const access = this.host.policyEngine.evaluateAccess({
      toolName: "mcp.invoke",
      args: {
        serverId: input.serverId,
        toolName: input.toolName,
        arguments: input.arguments ?? {},
      },
      agentId: policyAgentId,
      sessionId: policySessionId,
      taskId: input.taskId,
    });
    if (!access.allowed) {
      return {
        ok: false,
        error: `MCP invoke blocked by policy: ${access.reasonCodes.join(", ")}`,
        policyReason: "blocked by tool policy",
        reasonCodes: access.reasonCodes,
      };
    }
    if (access.requiresApproval) {
      const decision = await this.host.policyEngine.invoke({
        toolName: "mcp.invoke",
        args: {
          serverId: input.serverId,
          toolName: input.toolName,
          arguments: input.arguments ?? {},
        },
        agentId: policyAgentId,
        sessionId: policySessionId,
        taskId: input.taskId,
        consentContext: {
          source: "agent",
          reason: `MCP tool invoke ${input.serverId}/${input.toolName}`,
        },
      });
      if (decision.outcome === "approval_required") {
        return {
          ok: false,
          error: "MCP invoke requires approval.",
          approvalRequired: true,
          approvalId: decision.approvalId,
          policyReason: decision.policyReason,
          reasonCodes: access.reasonCodes,
        };
      }
      if (decision.outcome === "blocked") {
        return {
          ok: false,
          error: decision.policyReason,
          policyReason: decision.policyReason,
          reasonCodes: access.reasonCodes,
        };
      }
    }

    const runtime = isInternalMcpApprovalInboxServer(server)
      ? await handleInternalMcpApprovalInboxInvoke(server, input, {
          approvalInbox: this.host.approvalInbox,
          resolveApprovalWithRemoteTokenId: (request) => this.host.resolveApprovalWithRemoteTokenId(request),
        })
      : await this.host.invokeMcpRuntimeTool(server, {
          toolName: input.toolName,
          arguments: input.arguments,
          signal: input.signal,
        });

    const output = runtime.output
      ? {
          serverId: input.serverId,
          toolName: input.toolName,
          arguments: input.arguments ?? {},
          ...runtime.output,
        }
      : undefined;
    const redactedOutput = output ? this.host.applyMcpRedaction(output, server.policy.redactionMode) : undefined;

    this.host.publishRealtime(
      "tool_invoked",
      "mcp",
      {
        type: "mcp_tool_invoked",
        serverId: input.serverId,
        toolName: input.toolName,
        sessionId: input.sessionId,
        taskId: input.taskId,
        trustTier: server.trustTier,
      },
      buildMcpInvocationRealtimeOptions({
        sessionId: input.sessionId,
        taskId: input.taskId,
      }),
    );

    if (!runtime.ok) {
      return {
        ok: false,
        output: redactedOutput,
        error: runtime.error ?? `MCP tool ${input.toolName} failed.`,
      };
    }

    return {
      ok: true,
      output: redactedOutput,
    };
  }
}
