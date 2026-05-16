import { randomUUID } from "node:crypto";
import type {
  ApprovalRequest,
  McpInvokeRequest,
  McpInvokeResponse,
  McpNormalizedContentItem,
  McpServerRecord,
  McpToolRecord,
  RealtimeEvent,
  ToolInvokeRequest,
  ToolInvokeResult,
} from "@goatcitadel/contracts";
import type { ApprovalInboxRepository } from "@goatcitadel/storage";
import type { HooksService } from "./hooks-service.js";
import { parseToolCallHookPatch } from "./hook-patch-helpers.js";
import { handleInternalMcpApprovalInboxInvoke, isInternalMcpApprovalInboxServer } from "./mcp-approval-inbox.js";
import type { McpRuntimeInvocationResult } from "./mcp-runtime.js";
import type { PluginToolOverrideService } from "./plugin-tool-override-service.js";
import { runtimeLifecycleHookDispatcher } from "./runtime-lifecycle-hook-dispatcher.js";
import type { EvidenceEnvelopeCreateRequest } from "./evidence-envelope-service.js";

type ToolCallHookPatch = Record<string, unknown> & {
  toolName?: string;
  args?: Record<string, unknown>;
};

interface ToolPolicyAccessResult {
  allowed: boolean;
  requiresApproval: boolean;
  reasonCodes: string[];
}

interface McpPolicyRequestShape {
  toolName: "mcp.invoke";
  args: {
    serverId: string;
    toolName: string;
    arguments: Record<string, unknown>;
  };
  agentId: string;
  sessionId: string;
  taskId?: string;
}

interface McpPolicyEvaluation {
  access: ToolPolicyAccessResult;
  decision: ToolInvokeResult;
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
  recordEvidenceEnvelope?(input: EvidenceEnvelopeCreateRequest): void;
  recordDevDiagnostic?(input: {
    level: "debug" | "info" | "warn" | "error";
    category: string;
    event: string;
    message: string;
    sessionId?: string;
    taskId?: string;
    toolRunId?: string;
    toolName?: string;
    durationMs?: number;
    runtimeKind?: string;
    runtimeStatus?: "started" | "running" | "completed" | "failed" | "cancelled" | "blocked" | "degraded";
    runtimeError?: {
      name?: string;
      message: string;
      code?: string;
      retryable?: boolean;
    };
    context?: Record<string, unknown>;
  }): void;
  readonly pluginToolOverrideService?: Pick<PluginToolOverrideService, "resolveActiveHandler">;
}

export interface ToolInvocationCoordinator {
  invokeTool(request: ToolInvokeRequest): Promise<ToolInvokeResult>;
  invokeMcpTool(input: McpInvokeRequest): Promise<McpInvokeResponse>;
}

export class ToolInvocationCoordinatorService implements ToolInvocationCoordinator {
  public constructor(private readonly host: ToolInvocationCoordinatorHost) {}

  private buildMcpPolicyRequest(input: McpInvokeRequest): McpPolicyRequestShape {
    return {
      toolName: "mcp.invoke",
      args: {
        serverId: input.serverId,
        toolName: input.toolName,
        arguments: input.arguments ?? {},
      },
      agentId: input.agentId?.trim() || "operator",
      sessionId: input.sessionId?.trim() || `mcp:${input.serverId}`,
      taskId: input.taskId,
    };
  }

  private async evaluateMcpPolicy(input: McpInvokeRequest): Promise<McpPolicyEvaluation> {
    const request = this.buildMcpPolicyRequest(input);
    return {
      access: this.host.policyEngine.evaluateAccess(request),
      decision: await this.host.policyEngine.invoke({
        ...request,
        dryRun: true,
        consentContext: {
          source: "agent",
          reason: `MCP tool invoke ${input.serverId}/${input.toolName}`,
        },
      }),
    };
  }

  private buildMcpPolicyFailure(evaluation: McpPolicyEvaluation): {
    ok: false;
    error: string;
    approvalRequired?: boolean;
    approvalId?: string;
    policyReason?: string;
    reasonCodes?: string[];
  } | null {
    if (evaluation.decision.outcome === "approval_required") {
      return {
        ok: false,
        error: "MCP invoke requires approval.",
        approvalRequired: true,
        approvalId: evaluation.decision.approvalId,
        policyReason: evaluation.decision.policyReason,
        reasonCodes: evaluation.access.reasonCodes,
      };
    }
    if (evaluation.decision.outcome === "blocked") {
      return {
        ok: false,
        error: evaluation.decision.policyReason,
        policyReason: evaluation.decision.policyReason,
        reasonCodes: evaluation.access.reasonCodes,
      };
    }
    return null;
  }

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
      parsePatch: (value) => parseToolCallHookPatch(value as Record<string, unknown>),
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

    const overrideHandler = this.host.pluginToolOverrideService?.resolveActiveHandler(hookableRequest.toolName);
    let result: ToolInvokeResult;
    const toolStartedAt = Date.now();
    this.host.recordDevDiagnostic?.({
      level: "debug",
      category: "tools",
      event: "tool.invocation.start",
      message: "Starting tool invocation",
      sessionId: hookableRequest.sessionId,
      taskId: hookableRequest.taskId,
      toolRunId: toolHookEntityId,
      toolName: hookableRequest.toolName,
      runtimeKind: overrideHandler ? "tool.invocation.override" : "tool.invocation",
      runtimeStatus: "started",
      context: {
        agentId: hookableRequest.agentId,
      },
    });
    try {
      result = overrideHandler
        ? await overrideHandler(hookableRequest.args ?? {})
        : await this.host.policyEngine.invoke(hookableRequest);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.host.recordDevDiagnostic?.({
        level: "error",
        category: "tools",
        event: "tool.invocation.failed",
        message: "Tool invocation failed",
        sessionId: hookableRequest.sessionId,
        taskId: hookableRequest.taskId,
        toolRunId: toolHookEntityId,
        toolName: hookableRequest.toolName,
        durationMs: Date.now() - toolStartedAt,
        runtimeKind: overrideHandler ? "tool.invocation.override" : "tool.invocation",
        runtimeStatus: "failed",
        runtimeError: {
          name: error instanceof Error ? error.name : undefined,
          message: errorMessage,
          retryable: false,
        },
      });
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
          error: errorMessage,
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

    this.host.recordDevDiagnostic?.({
      level: result.outcome === "blocked" ? "warn" : "info",
      category: "tools",
      event: "tool.invocation.complete",
      message: "Tool invocation completed",
      sessionId: hookableRequest.sessionId,
      taskId: hookableRequest.taskId,
      toolRunId: toolHookEntityId,
      toolName: hookableRequest.toolName,
      durationMs: Date.now() - toolStartedAt,
      runtimeKind: overrideHandler ? "tool.invocation.override" : "tool.invocation",
      runtimeStatus: result.outcome === "blocked" || result.outcome === "approval_required" ? "blocked" : "completed",
      context: {
        outcome: result.outcome,
        approvalId: result.approvalId,
        policyReason: result.policyReason,
      },
    });
    this.host.recordEvidenceEnvelope?.({
      eventKind: "tool_invocation",
      sessionId: hookableRequest.sessionId,
      runId: approvalForResult?.linkage?.durableRunId,
      approvalId: result.approvalId,
      toolCallHashes: [result.auditEventId ?? toolHookEntityId],
      metadata: {
        runtime: overrideHandler ? "plugin_override" : "policy",
        toolName: hookableRequest.toolName,
        taskId: hookableRequest.taskId,
        agentId: hookableRequest.agentId,
        outcome: result.outcome,
        policyReason: result.policyReason,
      },
    });

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
    runtimeLifecycleHookDispatcher.enqueueObserveHook(this.host.hooksService, {
      workspaceId: toolHookWorkspaceId,
      trigger: "after_tool_call",
      entityType: "tool_call",
      entityId: toolHookEntityId,
      payload: {
        workspaceId: toolHookWorkspaceId,
        sessionId: hookableRequest.sessionId,
        taskId: hookableRequest.taskId,
        approvalId: result.approvalId,
        toolName: hookableRequest.toolName,
        outcome: result.outcome,
        auditEventId: result.auditEventId,
        policyReason: result.policyReason,
      },
    });

    return result;
  }

  public async invokeMcpTool(input: McpInvokeRequest): Promise<McpInvokeResponse> {
    const runtimeStartedAt = Date.now();
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

    const previewEvaluation = await this.evaluateMcpPolicy(input);
    const previewFailure = this.buildMcpPolicyFailure(previewEvaluation);
    if (previewFailure) {
      return previewFailure;
    }

    const runtimeEvaluation = await this.evaluateMcpPolicy(input);
    const runtimeFailure = this.buildMcpPolicyFailure(runtimeEvaluation);
    if (runtimeFailure) {
      return runtimeFailure;
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
    const runtimeRetryCount = "retryCount" in runtime ? runtime.retryCount : undefined;
    const runtimeDegraded = "degraded" in runtime ? runtime.degraded : undefined;
    if (runtimeRetryCount || runtime.output?.degradedReason) {
      this.host.recordDevDiagnostic?.({
        level: "warn",
        category: "mcp",
        event: "mcp.transport.degraded",
        message: "MCP tool invocation recovered after a degraded transport state",
        sessionId: input.sessionId,
        taskId: input.taskId,
        toolName: input.toolName,
        durationMs: Date.now() - runtimeStartedAt,
        runtimeKind: "mcp.transport",
        runtimeStatus: "degraded",
        context: {
          serverId: input.serverId,
          retryCount: runtimeRetryCount ?? 0,
          degradedReason: runtime.output?.degradedReason,
        },
      });
    }

    const output = runtime.output
      ? {
          serverId: input.serverId,
          toolName: input.toolName,
          arguments: input.arguments ?? {},
          ...runtime.output,
        }
      : undefined;
    const redactedOutput = output ? this.host.applyMcpRedaction(output, server.policy.redactionMode) : undefined;
    const redactedContentItems = redactMcpContentItems(
      runtime.contentItems,
      server.policy.redactionMode,
      this.host.applyMcpRedaction,
    );

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
    this.host.recordEvidenceEnvelope?.({
      eventKind: "tool_invocation",
      sessionId: input.sessionId,
      toolCallHashes: [`mcp:${input.serverId}:${input.toolName}:${runtimeStartedAt}`],
      metadata: {
        runtime: "mcp",
        serverId: input.serverId,
        toolName: input.toolName,
        taskId: input.taskId,
        trustTier: server.trustTier,
        ok: runtime.ok,
        error: runtime.ok ? undefined : runtime.error,
      },
    });

    if (!runtime.ok) {
      return {
        ok: false,
        output: redactedOutput,
        contentItems: redactedContentItems,
        diagnostics: {
          transport: server.transport,
          degraded: runtimeDegraded,
          retryCount: runtimeRetryCount,
          sanitizedError: runtime.error,
        },
        error: runtime.error ?? `MCP tool ${input.toolName} failed.`,
      };
    }

    return {
      ok: true,
      output: redactedOutput,
      contentItems: redactedContentItems,
      diagnostics: {
        transport: server.transport,
        degraded: runtimeDegraded,
        retryCount: runtimeRetryCount,
      },
    };
  }
}

function redactMcpContentItems(
  contentItems: McpNormalizedContentItem[] | undefined,
  mode: McpServerRecord["policy"]["redactionMode"],
  applyRedaction: ToolInvocationCoordinatorHost["applyMcpRedaction"],
): McpNormalizedContentItem[] | undefined {
  if (!contentItems) {
    return undefined;
  }
  const redacted = applyRedaction({ contentItems }, mode).contentItems;
  return Array.isArray(redacted) ? (redacted as McpNormalizedContentItem[]) : contentItems;
}
