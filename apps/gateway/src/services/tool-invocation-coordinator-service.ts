/* eslint-disable max-lines -- Tool invocation coordination keeps policy, MCP, audit, and grant evidence in one reviewable runtime seam. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  redactSecretText,
  type ApprovalRequest,
  type AutonomousActivationGrantEvaluationInput,
  type AutonomousActivationGrantEvaluationResult,
  type AutonomousActivationRiskLevel,
  type AutonomousActivationRuntimeEvidence,
  type McpInvokeRequest,
  type McpInvokeResponse,
  type McpNormalizedContentItem,
  type McpServerRecord,
  type McpToolRecord,
  type RealtimeEvent,
  type ToolInvokeRequest,
  type ToolInvokeResult,
  type WardEffect,
} from "@goatcitadel/contracts";
import type { ApprovalInboxRepository } from "@goatcitadel/storage";
import type { HooksService } from "./hooks-service.js";
import { parseToolCallHookPatch } from "./hook-patch-helpers.js";
import {
  handleInternalMcpApprovalInboxInvoke,
  isInternalMcpApprovalInboxServer,
  type ListMcpElicitations,
  type RespondToMcpElicitation,
} from "./mcp-approval-inbox.js";
import {
  handleInternalMcpDurableTasksInvoke,
  isInternalMcpDurableTasksServer,
  type McpDurableTasksPort,
} from "./mcp-durable-tasks.js";
import {
  buildMcpStaleAuthInvokeError,
  isMcpAuthReadinessInvokeBlocked,
  resolveMcpInvokeAuthReadiness,
} from "./mcp-oauth-token-service.js";
import type { McpRuntimeInvocationResult } from "./mcp-runtime.js";
import type { PluginToolExecutionContext, PluginToolOverrideService } from "./plugin-tool-override-service.js";
import { runtimeLifecycleHookDispatcher } from "./runtime-lifecycle-hook-dispatcher.js";
import type { EvidenceEnvelopeCreateRequest } from "./evidence-envelope-service.js";
import { evaluateComputerUseSafety } from "../browser-runtime-guardrails.js";

type ToolCallHookPatch = Record<string, unknown> & {
  toolName?: string;
  args?: Record<string, unknown>;
};

interface ToolPolicyAccessResult {
  allowed: boolean;
  requiresApproval: boolean;
  reasonCodes: string[];
}

export interface ToolExternalSideEffectBoundary {
  /** Record immediately before a concrete provider or irreversible mutation starts. */
  markStarted(): void;
  /** Record that execution finished or failed without crossing that boundary. */
  markNotRequired(): void;
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
  workspaceId?: string;
  taskId?: string;
  runId?: string;
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  surface?: ToolInvokeRequest["surface"];
  policyContext?: ToolInvokeRequest["policyContext"];
  consentContext?: ToolInvokeRequest["consentContext"];
}

interface McpPolicyEvaluation {
  access: ToolPolicyAccessResult;
  decision: ToolInvokeResult;
}

type RealtimePublishOptions = Pick<RealtimeEvent, "eventClass" | "eventAuthority" | "links" | "correlationId">;
const APPROVAL_REASON_RE = /^approval:([A-Za-z0-9_-]+)$/;

function buildMcpInvocationRealtimeOptions(input: {
  sessionId?: string;
  taskId?: string;
  runId?: string;
  workspaceId?: string;
}): RealtimePublishOptions {
  return {
    eventClass: "operational_signal",
    eventAuthority: "retained_stream",
    links: {
      sessionId: input.sessionId,
      taskId: input.taskId,
      runId: input.runId,
      workspaceId: input.workspaceId,
    },
  };
}

function buildPluginOverridePolicyFailure(finalPolicyCheck: ToolInvokeResult): ToolInvokeResult | undefined {
  if (finalPolicyCheck.outcome === "blocked" || finalPolicyCheck.outcome === "approval_required") {
    return finalPolicyCheck;
  }
  if (readDryRunRequiresApproval(finalPolicyCheck.result)) {
    return {
      outcome: "blocked",
      policyReason: `blocked: plugin override requires policy approval before execution (${finalPolicyCheck.policyReason})`,
      auditEventId: finalPolicyCheck.auditEventId,
      result: finalPolicyCheck.result,
      internalCall: finalPolicyCheck.internalCall,
      internalResult: finalPolicyCheck.internalResult,
      audit: finalPolicyCheck.audit,
    };
  }
  return undefined;
}

function readDryRunRequiresApproval(result: ToolInvokeResult["result"]): boolean {
  const policy = result?.policy;
  return Boolean(policy && typeof policy === "object" && "requiresApproval" in policy && policy.requiresApproval);
}

function buildPluginToolExecutionContext(
  request: ToolInvokeRequest,
  policyResult?: ToolInvokeResult,
  approvedExternalRuntimeReplayId?: string,
): PluginToolExecutionContext {
  const policyContext = mergePolicyContexts(request.policyContext, readPolicyContextFromResult(policyResult));
  return {
    request: policyContext ? { ...request, policyContext } : request,
    policyContext,
    policyResult,
    signal: request.signal,
    approvedExternalRuntimeReplayId,
  };
}

function readPolicyContextFromResult(result: ToolInvokeResult | undefined): ToolInvokeRequest["policyContext"] {
  const raw = result?.result?.policyContext;
  return isRecord(raw) ? (raw as ToolInvokeRequest["policyContext"]) : undefined;
}

function mergePolicyContexts(
  base: ToolInvokeRequest["policyContext"],
  evaluated: ToolInvokeRequest["policyContext"],
): ToolInvokeRequest["policyContext"] {
  if (!base && !evaluated) {
    return undefined;
  }
  return {
    ...(base ?? {}),
    ...(evaluated ?? {}),
    matchedGrantAllowedHosts:
      evaluated?.matchedGrantAllowedHosts && evaluated.matchedGrantAllowedHosts.length > 0
        ? evaluated.matchedGrantAllowedHosts
        : base?.matchedGrantAllowedHosts,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export interface ToolInvocationCoordinatorHost {
  readonly approvalInbox: Pick<
    ApprovalInboxRepository,
    "receiveMcpApprovalDelivery" | "listByReceiver" | "get" | "markResolved"
  >;
  readonly durableTasks: McpDurableTasksPort;
  readonly respondToMcpElicitation: RespondToMcpElicitation;
  readonly listMcpElicitations: ListMcpElicitations;
  /** Required capability-scope gate. Throws when the requested MCP server is not
   *  available in the active workspace/citadel scope. Missing wiring fails closed. */
  assertMcpServerInScope?: (request: McpInvokeRequest) => void;
  readonly policyEngine: {
    invoke(
      request: ToolInvokeRequest,
      options?: { beforeExecute?: () => void; externalSideEffect?: ToolExternalSideEffectBoundary },
    ): Promise<ToolInvokeResult>;
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
  isFeatureEnabled?(flag: "computerUseGuardrailsV1Enabled"): boolean;
  resolveToolHookWorkspaceId(request: ToolInvokeRequest): string;
  primeToolApprovalLifecycle(approvalId: string, request: ToolInvokeRequest): ApprovalRequest;
  scheduleApprovalExplanationById(approvalId: string): void;
  evaluateAutonomousActivationGrant?(
    input: AutonomousActivationGrantEvaluationInput,
  ): AutonomousActivationGrantEvaluationResult;
  recordAutonomousActivationGrantUse?(grantId: string, estimatedCostUsd?: number): void;
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
    connectorId: string;
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

export interface ToolInvocationRuntimeOptions {
  /** Process-local durable authority check; never serialize this callback. */
  executionFence?: () => void;
  /** Process-local concrete external-side-effect boundary; never serialize this object. */
  externalSideEffect?: ToolExternalSideEffectBoundary;
}

export interface ToolInvocationCoordinator {
  invokeTool(request: ToolInvokeRequest, options?: ToolInvocationRuntimeOptions): Promise<ToolInvokeResult>;
  invokeMcpTool(input: McpInvokeRequest, options?: ToolInvocationRuntimeOptions): Promise<McpInvokeResponse>;
}

export class ToolInvocationCoordinatorService implements ToolInvocationCoordinator {
  public constructor(private readonly host: ToolInvocationCoordinatorHost) {}

  private runPostCommitConsumer(consumer: string, request: ToolInvokeRequest, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      try {
        this.host.recordDevDiagnostic?.({
          level: "warn",
          category: "tools",
          event: "tool.invocation.post_commit_consumer_failed",
          message: `Tool invocation completed, but ${consumer} failed.`,
          sessionId: request.sessionId,
          taskId: request.taskId,
          toolName: request.toolName,
          runtimeKind: "tool.invocation.post_commit",
          runtimeStatus: "degraded",
          runtimeError: {
            name: error instanceof Error ? error.name : undefined,
            message: error instanceof Error ? error.message : String(error),
            retryable: true,
          },
          context: { consumer, runId: request.runId ?? request.policyContext?.runId },
        });
      } catch {
        // A completed external mutation must never be replayed because reporting failed.
        return;
      }
    }
  }

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
      workspaceId: input.workspaceId,
      taskId: input.taskId,
      runId: input.runId,
      permissionProfileId: input.permissionProfileId,
      localOperatorOverrideId: input.localOperatorOverrideId,
      surface: input.surface ?? "mcp",
      policyContext: input.policyContext,
      consentContext: input.consentContext,
    };
  }

  private async evaluateMcpPolicy(
    input: McpInvokeRequest,
    options?: { externalRuntime?: boolean },
  ): Promise<McpPolicyEvaluation> {
    const request = this.buildMcpPolicyRequest(input);
    return {
      access: this.host.policyEngine.evaluateAccess(request),
      decision: await this.host.policyEngine.invoke({
        ...request,
        dryRun: options?.externalRuntime === true ? undefined : true,
        externalRuntime: options?.externalRuntime === true ? true : undefined,
        consentContext: {
          ...(request.consentContext ?? {}),
          source: "agent",
          reason: `MCP tool invoke ${input.serverId}/${input.toolName}`,
        },
      }),
    };
  }

  private buildMcpPolicyFailure(
    evaluation: McpPolicyEvaluation,
    autonomousActivation?: AutonomousActivationRuntimeEvidence,
  ): {
    ok: false;
    error: string;
    approvalRequired?: boolean;
    approvalId?: string;
    policyReason?: string;
    reasonCodes?: string[];
    autonomousActivation?: AutonomousActivationRuntimeEvidence;
  } | null {
    if (evaluation.decision.outcome === "approval_required") {
      return {
        ok: false,
        error: "MCP invoke requires approval.",
        approvalRequired: true,
        approvalId: evaluation.decision.approvalId,
        policyReason: evaluation.decision.policyReason,
        reasonCodes: evaluation.access.reasonCodes,
        autonomousActivation,
      };
    }
    if (evaluation.decision.outcome === "blocked") {
      return {
        ok: false,
        error: evaluation.decision.policyReason,
        policyReason: evaluation.decision.policyReason,
        reasonCodes: evaluation.access.reasonCodes,
        autonomousActivation,
      };
    }
    return null;
  }

  public async invokeTool(
    request: ToolInvokeRequest,
    options: ToolInvocationRuntimeOptions = {},
  ): Promise<ToolInvokeResult> {
    if (!this.host.isValidToolName(request.toolName)) {
      return {
        outcome: "blocked",
        policyReason: "blocked: invalid tool name format",
        auditEventId: randomUUID(),
      };
    }

    const normalizedRequest = this.host.normalizeToolInvokeRequest(request);
    if (containsRawApprovalActionBearer(normalizedRequest.args)) {
      return {
        outcome: "blocked",
        policyReason: "blocked: raw approval action bearers cannot enter tool hooks or policy",
        auditEventId: randomUUID(),
      };
    }
    const isCodeModeWrapperInvocation = Boolean(normalizedRequest.policyContext?.approvedCodeModeRunId);
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

    const beforeHook = isCodeModeWrapperInvocation
      ? { runs: [] }
      : await this.host.hooksService.runInlineHooks<ToolCallHookPatch>({
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

    if (
      beforeHook.patch &&
      hasApprovalActionTemplate(normalizedRequest) &&
      !isProtectedApprovalActionBindingUnchanged(normalizedRequest, hookableRequest)
    ) {
      return {
        outcome: "blocked",
        policyReason: "blocked: protected approval action binding cannot be rewritten by tool hooks",
        auditEventId: randomUUID(),
      };
    }
    if (containsRawApprovalActionBearer(hookableRequest.args)) {
      return {
        outcome: "blocked",
        policyReason: "blocked: raw approval action bearers cannot enter tool policy",
        auditEventId: randomUUID(),
      };
    }

    if (
      isCodeModeWrapperInvocation &&
      (hookableRequest.toolName !== normalizedRequest.toolName || hookableRequest.args !== normalizedRequest.args)
    ) {
      return {
        outcome: "blocked",
        policyReason: "blocked: Code Mode wrapper invocation cannot be rewritten by tool hooks",
        auditEventId: randomUUID(),
      };
    }

    if (!this.host.isValidToolName(hookableRequest.toolName)) {
      return {
        outcome: "blocked",
        policyReason: "blocked: invalid post-hook tool name format",
        auditEventId: randomUUID(),
      };
    }

    const finalDeploymentGuard = beforeHook.patch ? this.host.evaluateToolDeploymentGuard(hookableRequest) : undefined;
    if (finalDeploymentGuard) {
      return {
        outcome: "blocked",
        policyReason: `blocked: ${finalDeploymentGuard.reason}`,
        auditEventId: randomUUID(),
      };
    }
    if (this.host.isFeatureEnabled?.("computerUseGuardrailsV1Enabled")) {
      const safety = evaluateComputerUseSafety(hookableRequest.toolName, hookableRequest.args ?? {});
      if (safety.requiresVerification && !safety.verified) {
        return {
          outcome: "blocked",
          policyReason:
            "blocked: Computer-use guardrail: this mutating browser action requires step verification (set args.verifyStep=true).",
          auditEventId: randomUUID(),
          result: { computerUseGuardrail: safety },
        };
      }
      if (safety.requiresConfirmation && !safety.confirmed) {
        return {
          outcome: "blocked",
          policyReason:
            "blocked: Computer-use guardrail: confirm-before-submit required (set args.confirmBeforeSubmit=true).",
          auditEventId: randomUUID(),
          result: { computerUseGuardrail: safety },
        };
      }
    }

    const protectedApprovalActionDelivery = hasApprovalActionTemplate(hookableRequest);
    const overrideHandler =
      isCodeModeWrapperInvocation || protectedApprovalActionDelivery
        ? undefined
        : this.host.pluginToolOverrideService?.resolveActiveHandler(hookableRequest.toolName);
    let approvedExternalRuntimeReplayId: string | undefined;
    let finalPolicyCheck: ToolInvokeResult | undefined;
    if (overrideHandler) {
      finalPolicyCheck = await this.host.policyEngine.invoke({
        ...hookableRequest,
        externalRuntime: true,
      });
      const overridePolicyFailure = buildPluginOverridePolicyFailure(finalPolicyCheck);
      if (overridePolicyFailure) {
        return overridePolicyFailure;
      }
      approvedExternalRuntimeReplayId = extractVerifiedApprovalReplayId(finalPolicyCheck, hookableRequest);
      if (approvedExternalRuntimeReplayId) {
        return {
          outcome: "blocked",
          policyReason:
            "blocked: approved external-runtime actions execute only through the canonical approval-effect worker",
          auditEventId: finalPolicyCheck.auditEventId,
          result: {
            approvalId: approvedExternalRuntimeReplayId,
            executionOwner: "approval_effect",
          },
          audit: finalPolicyCheck.audit,
        };
      }
    }
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
      if (overrideHandler) {
        options.executionFence?.();
        // Plugin handlers do not expose a deeper provider adapter boundary, so
        // conservatively record it immediately before the approved handler.
        options.externalSideEffect?.markStarted();
        result = await overrideHandler(
          hookableRequest.args ?? {},
          buildPluginToolExecutionContext(hookableRequest, finalPolicyCheck, approvedExternalRuntimeReplayId),
        );
      } else {
        const policyOptions = {
          ...(options.executionFence ? { beforeExecute: options.executionFence } : {}),
          ...(options.externalSideEffect ? { externalSideEffect: options.externalSideEffect } : {}),
        };
        result =
          options.executionFence || options.externalSideEffect
            ? await this.host.policyEngine.invoke(hookableRequest, policyOptions)
            : await this.host.policyEngine.invoke(hookableRequest);
      }
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
    // Citadel Ward "redact" effect: when the resolved policy decision flagged this
    // invocation for redaction, scrub the tool's output before it flows into the
    // model context, the approval-replay record, after-hooks, or evidence. This is
    // the seam where BOTH the produced output (result.result) and the ward decision
    // (result.wardEffect, surfaced by the policy engine in slice 3.1a) are in scope.
    // Non-redact invocations are untouched, so behavior is byte-identical to before.
    result = applyRedactWardEffect(result);

    const approvalForResult =
      result.outcome === "approval_required" && result.approvalId
        ? this.host.primeToolApprovalLifecycle(result.approvalId, hookableRequest)
        : undefined;
    const permissionProfileId =
      hookableRequest.policyContext?.permissionProfileId ?? hookableRequest.permissionProfileId;
    const localOperatorOverrideId =
      hookableRequest.policyContext?.localOperatorOverrideId ?? hookableRequest.localOperatorOverrideId;
    const linkedRunId =
      hookableRequest.runId ?? hookableRequest.policyContext?.runId ?? approvalForResult?.linkage?.durableRunId;

    this.runPostCommitConsumer("realtime projection", hookableRequest, () => {
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
          permissionProfileId,
          localOperatorOverrideId,
          runId: linkedRunId,
        },
        {
          eventClass: "operational_signal",
          eventAuthority: "retained_stream",
          links: {
            sessionId: hookableRequest.sessionId,
            taskId: hookableRequest.taskId,
            approvalId: result.approvalId,
            runId: linkedRunId,
          },
        },
      );
    });

    this.runPostCommitConsumer("completion diagnostic", hookableRequest, () => {
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
          permissionProfileId,
          localOperatorOverrideId,
          runId: linkedRunId,
        },
      });
    });
    this.runPostCommitConsumer("evidence recording", hookableRequest, () => {
      this.host.recordEvidenceEnvelope?.({
        eventKind: "tool_invocation",
        sessionId: hookableRequest.sessionId,
        runId: linkedRunId,
        approvalId: result.approvalId,
        toolCallHashes: [result.auditEventId ?? toolHookEntityId],
        metadata: {
          runtime: overrideHandler ? "plugin_override" : "policy",
          toolName: hookableRequest.toolName,
          taskId: hookableRequest.taskId,
          agentId: hookableRequest.agentId,
          outcome: result.outcome,
          policyReason: result.policyReason,
          permissionProfileId,
          localOperatorOverrideId,
        },
      });
    });

    if (result.outcome === "approval_required" && result.approvalId) {
      this.runPostCommitConsumer("approval explanation scheduling", hookableRequest, () => {
        this.host.scheduleApprovalExplanationById(result.approvalId!);
      });
    }

    this.runPostCommitConsumer("tool.call.after hook enqueue", hookableRequest, () => {
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
    });
    this.runPostCommitConsumer("lifecycle observe hook enqueue", hookableRequest, () => {
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
    });

    return result;
  }

  public async invokeApprovedExternalRuntimeTool(
    request: ToolInvokeRequest,
    markExternalCallStarted?: () => void,
  ): Promise<ToolInvokeResult> {
    if (!this.host.isValidToolName(request.toolName)) {
      return {
        outcome: "blocked",
        policyReason: "blocked: invalid tool name format",
        auditEventId: randomUUID(),
      };
    }
    const normalizedRequest = this.host.normalizeToolInvokeRequest(request);
    if (containsRawApprovalActionBearer(normalizedRequest.args)) {
      return {
        outcome: "blocked",
        policyReason: "blocked: raw approval action bearers cannot enter an external runtime",
        auditEventId: randomUUID(),
      };
    }
    if (hasApprovalActionTemplate(normalizedRequest)) {
      return {
        outcome: "blocked",
        policyReason: "blocked: protected approval action delivery cannot execute through an external runtime",
        auditEventId: randomUUID(),
      };
    }
    const deploymentGuard = this.host.evaluateToolDeploymentGuard(normalizedRequest);
    if (deploymentGuard) {
      return {
        outcome: "blocked",
        policyReason: `blocked: ${deploymentGuard.reason}`,
        auditEventId: randomUUID(),
      };
    }
    const overrideHandler = this.host.pluginToolOverrideService?.resolveActiveHandler(normalizedRequest.toolName);
    if (!overrideHandler) {
      return {
        outcome: "blocked",
        policyReason: `blocked: approved external runtime handler is unavailable for ${normalizedRequest.toolName}`,
        auditEventId: randomUUID(),
      };
    }
    const finalPolicyCheck = await this.host.policyEngine.invoke({
      ...normalizedRequest,
      externalRuntime: true,
    });
    const overridePolicyFailure = buildPluginOverridePolicyFailure(finalPolicyCheck);
    if (overridePolicyFailure) {
      return overridePolicyFailure;
    }
    const startedAt = Date.now();
    this.host.recordDevDiagnostic?.({
      level: "debug",
      category: "tools",
      event: "tool.invocation.start",
      message: "Starting approved external runtime invocation",
      sessionId: normalizedRequest.sessionId,
      taskId: normalizedRequest.taskId,
      toolRunId: `approved:${normalizedRequest.sessionId}:${startedAt}`,
      toolName: normalizedRequest.toolName,
      runtimeKind: "tool.invocation.override",
      runtimeStatus: "started",
      context: {
        agentId: normalizedRequest.agentId,
        approvalReplay: true,
      },
    });
    markExternalCallStarted?.();
    const result = await overrideHandler(
      normalizedRequest.args ?? {},
      buildPluginToolExecutionContext(normalizedRequest, finalPolicyCheck, undefined),
    );
    const permissionProfileId =
      normalizedRequest.policyContext?.permissionProfileId ?? normalizedRequest.permissionProfileId;
    const localOperatorOverrideId =
      normalizedRequest.policyContext?.localOperatorOverrideId ?? normalizedRequest.localOperatorOverrideId;
    const linkedRunId = normalizedRequest.runId ?? normalizedRequest.policyContext?.runId;
    this.runPostCommitConsumer("approved external-runtime realtime projection", normalizedRequest, () => {
      this.host.publishRealtime(
        "tool_invoked",
        "policy",
        {
          toolName: normalizedRequest.toolName,
          sessionId: normalizedRequest.sessionId,
          agentId: normalizedRequest.agentId,
          taskId: normalizedRequest.taskId,
          outcome: result.outcome,
          policyReason: result.policyReason,
          approvalId: result.approvalId,
          auditEventId: result.auditEventId,
          permissionProfileId,
          localOperatorOverrideId,
          runId: linkedRunId,
        },
        {
          eventClass: "operational_signal",
          eventAuthority: "retained_stream",
          links: {
            sessionId: normalizedRequest.sessionId,
            taskId: normalizedRequest.taskId,
            approvalId: result.approvalId,
            runId: linkedRunId,
          },
        },
      );
    });
    this.runPostCommitConsumer("approved external-runtime evidence recording", normalizedRequest, () => {
      this.host.recordEvidenceEnvelope?.({
        eventKind: "tool_invocation",
        sessionId: normalizedRequest.sessionId,
        runId: linkedRunId,
        approvalId: result.approvalId,
        toolCallHashes: [result.auditEventId],
        metadata: {
          runtime: "plugin_override",
          toolName: normalizedRequest.toolName,
          taskId: normalizedRequest.taskId,
          agentId: normalizedRequest.agentId,
          outcome: result.outcome,
          policyReason: result.policyReason,
          permissionProfileId,
          localOperatorOverrideId,
          approvalReplay: true,
        },
      });
    });
    return result;
  }

  public async invokeApprovedMcpRuntime(
    input: McpInvokeRequest,
    markExternalCallStarted?: () => void,
  ): Promise<McpInvokeResponse> {
    const runtimeStartedAt = Date.now();
    const server = this.resolveMcpRuntimeTarget(input);
    if (!("serverId" in server)) {
      return server;
    }
    return this.executeMcpRuntime(input, server, runtimeStartedAt, undefined, undefined, markExternalCallStarted);
  }

  public async invokeMcpTool(
    input: McpInvokeRequest,
    options: ToolInvocationRuntimeOptions = {},
  ): Promise<McpInvokeResponse> {
    const runtimeStartedAt = Date.now();
    const server = this.resolveMcpRuntimeTarget(input);
    if (!("serverId" in server)) {
      return server;
    }

    const autonomyGate = this.evaluateMcpAutonomousActivation(input, server);
    if ("ok" in autonomyGate) {
      return autonomyGate;
    }

    const previewEvaluation = await this.evaluateMcpPolicy(input);
    const previewFailure = this.buildMcpPolicyFailure(previewEvaluation, autonomyGate.evidence);
    if (previewFailure) {
      return previewFailure;
    }

    const runtimeEvaluation = await this.evaluateMcpPolicy(input, { externalRuntime: true });
    const runtimeFailure = this.buildMcpPolicyFailure(runtimeEvaluation, autonomyGate.evidence);
    if (runtimeFailure) {
      return runtimeFailure;
    }

    const grantUseFailure = this.recordMcpAutonomousGrantUse(input, autonomyGate.evidence);
    if (grantUseFailure) {
      return grantUseFailure;
    }

    // The runtime policy decision (slice 3.1a) surfaces the matched Citadel Ward
    // effect; pass it so a `redact` Ward scrubs the MCP output below. Note: the
    // model-approval-replay entry point (invokeApprovedMcpRuntime) does no policy
    // evaluation and therefore has no ward decision to honor — that gap is flagged
    // in the slice report; it still gets the server-policy redactionMode scrub.
    return this.executeMcpRuntime(
      input,
      server,
      runtimeStartedAt,
      autonomyGate.evidence,
      runtimeEvaluation.decision.wardEffect,
      undefined,
      options.executionFence,
    );
  }

  private evaluateMcpAutonomousActivation(
    input: McpInvokeRequest,
    server: McpServerRecord,
  ): { evidence?: AutonomousActivationRuntimeEvidence } | McpInvokeResponse {
    if (input.autonomousActivation !== true) {
      return {};
    }
    if (!this.host.evaluateAutonomousActivationGrant || !this.host.recordAutonomousActivationGrantUse) {
      return buildMcpAutonomousActivationFailure({
        allowed: false,
        blockers: ["Gateway runtime has no autonomous activation grant service wired for MCP execution."],
        governance: [
          "Agentic activation is disabled unless an active expiring operator grant matches the request.",
          "Missing grant enforcement wiring is treated as fail-closed.",
        ],
      });
    }
    const grantInput = buildMcpAutonomousActivationGrantInput(input, server);
    const result = this.host.evaluateAutonomousActivationGrant(grantInput);
    const evidence: AutonomousActivationRuntimeEvidence = {
      requested: true,
      allowed: result.allowed,
      matchedGrantId: result.matchedGrantId,
      riskLevel: grantInput.riskLevel,
      governance: result.governance,
      blockers: result.blockers,
    };
    if (!result.allowed) {
      return buildMcpAutonomousActivationFailure(evidence);
    }
    return { evidence };
  }

  private recordMcpAutonomousGrantUse(
    input: McpInvokeRequest,
    evidence: AutonomousActivationRuntimeEvidence | undefined,
  ): McpInvokeResponse | null {
    if (!evidence?.matchedGrantId) {
      return null;
    }
    try {
      this.host.recordAutonomousActivationGrantUse?.(evidence.matchedGrantId, input.estimatedCostUsd ?? 0);
      return null;
    } catch (error) {
      return {
        ok: false,
        autonomousActivation: {
          ...evidence,
          allowed: false,
          blockers: [
            ...evidence.blockers,
            "Autonomous activation grant use could not be recorded before runtime execution.",
          ],
        },
        error: "Autonomous MCP activation could not record grant use; refusing runtime execution.",
        policyReason: error instanceof Error ? error.message : String(error),
        reasonCodes: ["autonomous_activation_grant_record_failed"],
      };
    }
  }

  private resolveMcpRuntimeTarget(input: McpInvokeRequest): McpServerRecord | McpInvokeResponse {
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
    // Fail closed on stale/missing OAuth (needs_auth/expired) so the shared
    // agent/chat/durable invoke path matches the HTTP route's gate: a logically
    // expired-but-still-connected token must not reach the runtime.
    const authReadiness = resolveMcpInvokeAuthReadiness(server);
    if (isMcpAuthReadinessInvokeBlocked(authReadiness)) {
      return {
        ok: false,
        error: buildMcpStaleAuthInvokeError(server, authReadiness),
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
    return server;
  }

  private async executeMcpRuntime(
    input: McpInvokeRequest,
    server: McpServerRecord,
    runtimeStartedAt: number,
    autonomousActivation?: AutonomousActivationRuntimeEvidence,
    wardEffect?: WardEffect,
    markExternalCallStarted?: () => void,
    executionFence?: () => void,
  ): Promise<McpInvokeResponse> {
    // Capability-scope choke point: every MCP invocation path converges here (model
    // approval-replay via invokeApprovedMcpRuntime, plus REST/durable/connector via
    // invokeMcpTool). The gate is fail-closed and applies to internal MCP surfaces too,
    // including durable tasks, because they expose operator runtime state.
    const scopeFailure = this.enforceMcpServerScope(input);
    if (scopeFailure) {
      return scopeFailure;
    }
    executionFence?.();
    markExternalCallStarted?.();
    const runtime = isInternalMcpApprovalInboxServer(server)
      ? await handleInternalMcpApprovalInboxInvoke(server, input, {
          approvalInbox: this.host.approvalInbox,
          resolveApprovalWithRemoteTokenId: (request) => this.host.resolveApprovalWithRemoteTokenId(request),
          respondToMcpElicitation: (request) => this.host.respondToMcpElicitation(request),
          listMcpElicitations: (filter) => this.host.listMcpElicitations(filter),
        })
      : isInternalMcpDurableTasksServer(server)
        ? await handleInternalMcpDurableTasksInvoke(server, input, this.host.durableTasks)
        : await this.host.invokeMcpRuntimeTool(server, {
            toolName: input.toolName,
            arguments: input.arguments,
            signal: input.signal,
          });
    const runtimeRetryCount = "retryCount" in runtime ? runtime.retryCount : undefined;
    const runtimeDegraded = "degraded" in runtime ? runtime.degraded : undefined;
    const runtimeExternalOutcome = "externalOutcome" in runtime ? runtime.externalOutcome : undefined;
    const runtimeManualReconciliationRequired =
      "manualReconciliationRequired" in runtime ? runtime.manualReconciliationRequired : undefined;
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
    // Layer the Citadel Ward "redact" effect on top of the server's own
    // redactionMode: a matched `redact` Ward scrubs known secret patterns from the
    // MCP output even when the server policy is "off". Same known-secret-pattern
    // scope caveat as the tool path (see applyRedactWardEffect); not full PII removal.
    const applyWardRedaction = wardEffect === "redact";
    const redactedOutput = output
      ? applyWardRedaction
        ? (redactSecretsDeep(this.host.applyMcpRedaction(output, server.policy.redactionMode)) as Record<
            string,
            unknown
          >)
        : this.host.applyMcpRedaction(output, server.policy.redactionMode)
      : undefined;
    const policyRedactedContentItems = redactMcpContentItems(
      runtime.contentItems,
      server.policy.redactionMode,
      this.host.applyMcpRedaction,
    );
    const redactedContentItems =
      applyWardRedaction && policyRedactedContentItems
        ? (redactSecretsDeep(policyRedactedContentItems) as McpNormalizedContentItem[])
        : policyRedactedContentItems;
    const sanitizedRuntimeError = redactMcpRuntimeError(runtime.error, server.policy.redactionMode);

    this.host.publishRealtime(
      "tool_invoked",
      "mcp",
      {
        type: "mcp_tool_invoked",
        serverId: input.serverId,
        toolName: input.toolName,
        sessionId: input.sessionId,
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        runId: input.runId,
        permissionProfileId: input.policyContext?.permissionProfileId ?? input.permissionProfileId,
        localOperatorOverrideId: input.policyContext?.localOperatorOverrideId ?? input.localOperatorOverrideId,
        trustTier: server.trustTier,
        autonomousActivation,
        externalOutcome: runtimeExternalOutcome,
        manualReconciliationRequired: runtimeManualReconciliationRequired,
      },
      buildMcpInvocationRealtimeOptions({
        sessionId: input.sessionId,
        taskId: input.taskId,
        runId: input.runId,
        workspaceId: input.workspaceId,
      }),
    );
    this.host.recordEvidenceEnvelope?.({
      eventKind: "tool_invocation",
      sessionId: input.sessionId,
      runId: input.runId,
      toolCallHashes: [`mcp:${input.serverId}:${input.toolName}:${runtimeStartedAt}`],
      metadata: {
        runtime: "mcp",
        serverId: input.serverId,
        toolName: input.toolName,
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        runId: input.runId,
        permissionProfileId: input.policyContext?.permissionProfileId ?? input.permissionProfileId,
        localOperatorOverrideId: input.policyContext?.localOperatorOverrideId ?? input.localOperatorOverrideId,
        trustTier: server.trustTier,
        autonomousActivation,
        ok: runtime.ok,
        error: runtime.ok ? undefined : sanitizedRuntimeError,
        externalOutcome: runtimeExternalOutcome,
        manualReconciliationRequired: runtimeManualReconciliationRequired,
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
          sanitizedError: sanitizedRuntimeError,
          externalOutcome: runtimeExternalOutcome,
          manualReconciliationRequired: runtimeManualReconciliationRequired,
        },
        autonomousActivation,
        error: sanitizedRuntimeError ?? `MCP tool ${input.toolName} failed.`,
        externalOutcome: runtimeExternalOutcome,
        manualReconciliationRequired: runtimeManualReconciliationRequired,
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
        externalOutcome: runtimeExternalOutcome,
        manualReconciliationRequired: runtimeManualReconciliationRequired,
      },
      autonomousActivation,
      externalOutcome: runtimeExternalOutcome,
      manualReconciliationRequired: runtimeManualReconciliationRequired,
    };
  }

  private enforceMcpServerScope(input: McpInvokeRequest): McpInvokeResponse | undefined {
    if (!this.host.assertMcpServerInScope) {
      return {
        ok: false,
        error: "MCP capability scope enforcement is unavailable.",
        policyReason: "blocked: MCP capability scope gate is not wired",
        reasonCodes: ["mcp_capability_scope_unavailable"],
      };
    }
    try {
      this.host.assertMcpServerInScope(input);
      return undefined;
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        policyReason: error instanceof Error ? error.message : String(error),
        reasonCodes: ["mcp_capability_scope_denied"],
      };
    }
  }
}

function hasApprovalActionTemplate(request: ToolInvokeRequest): boolean {
  return request.args.interactiveActionTemplate !== undefined;
}

function containsRawApprovalActionBearer(value: unknown): boolean {
  return /grat_[A-Za-z0-9_-]{43}/i.test(JSON.stringify(value ?? null));
}

function isProtectedApprovalActionBindingUnchanged(before: ToolInvokeRequest, after: ToolInvokeRequest): boolean {
  return isDeepStrictEqual(
    {
      toolName: before.toolName,
      args: before.args,
    },
    {
      toolName: after.toolName,
      args: after.args,
    },
  );
}

function buildMcpAutonomousActivationGrantInput(
  input: McpInvokeRequest,
  server: McpServerRecord,
): AutonomousActivationGrantEvaluationInput {
  return {
    workspaceId: input.workspaceId,
    surface: input.surface ?? "mcp",
    riskLevel: classifyMcpAutonomousActivationRisk(server),
    activationKind: "mcp_tool",
    capabilityId: `mcp:${server.serverId}`,
    toolName: `mcp.${server.serverId}.${input.toolName}`,
    estimatedCostUsd: input.estimatedCostUsd,
  };
}

function classifyMcpAutonomousActivationRisk(server: McpServerRecord): AutonomousActivationRiskLevel {
  if (server.costTier === "paid") {
    return "danger";
  }
  if (server.trustTier === "trusted" && server.costTier === "free") {
    return "caution";
  }
  return "danger";
}

function buildMcpAutonomousActivationFailure(
  evidence: Omit<AutonomousActivationRuntimeEvidence, "requested" | "riskLevel"> &
    Partial<Pick<AutonomousActivationRuntimeEvidence, "requested" | "riskLevel">>,
): McpInvokeResponse {
  return {
    ok: false,
    autonomousActivation: {
      requested: true,
      allowed: evidence.allowed,
      matchedGrantId: evidence.matchedGrantId,
      riskLevel: evidence.riskLevel,
      governance: evidence.governance,
      blockers: evidence.blockers,
    },
    error: "Autonomous MCP activation requires an active matching operator grant.",
    policyReason: evidence.blockers.join(" "),
    reasonCodes: ["autonomous_activation_grant_required"],
  };
}

function extractApprovalReplayId(request: ToolInvokeRequest): string | undefined {
  const reason = request.consentContext?.reason?.trim();
  if (!reason) {
    return undefined;
  }
  return APPROVAL_REASON_RE.exec(reason)?.[1];
}

function extractVerifiedApprovalReplayId(result: ToolInvokeResult, request: ToolInvokeRequest): string | undefined {
  const requestApprovalId = extractApprovalReplayId(request);
  if (!requestApprovalId || result.audit?.approvalId !== requestApprovalId) {
    return undefined;
  }
  return requestApprovalId;
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

function redactMcpRuntimeError(
  error: string | undefined,
  mode: McpServerRecord["policy"]["redactionMode"],
): string | undefined {
  if (!error || mode === "off") {
    return error;
  }
  return redactSecretText(error).value;
}

/**
 * Enforce the Citadel Ward "redact" effect on a completed tool invocation.
 *
 * SCOPE (be honest): this scrubs KNOWN SECRET PATTERNS from the tool's output —
 * API keys, bearer/basic auth headers, `*_token`/`*_secret`/`password` assignments,
 * provider key shapes (sk-/gh*_/AKIA…/xox…), credential-in-URL, etc. — via the same
 * `redactSecretText` matcher the rest of the gateway uses. It is NOT full semantic
 * PII removal (names, addresses, free-text identifiers); that would be a separate
 * NLP feature. It reduces the blast radius of a Ward-flagged tool feeding secrets
 * back into the model, but is not a guarantee against every sensitive value.
 *
 * Shape is preserved: we walk the output and rewrite string leaf values in place,
 * never dropping fields or altering non-string values. When the decision carries no
 * `redact` ward (or there is no output) the result is returned untouched, so a
 * non-redact invocation is byte-identical to before this effect existed.
 */
function applyRedactWardEffect(result: ToolInvokeResult): ToolInvokeResult {
  if (result.wardEffect !== "redact" || !result.result) {
    return result;
  }
  return {
    ...result,
    result: redactSecretsDeep(result.result) as Record<string, unknown>,
  };
}

/** Recursively rewrite string leaves through `redactSecretText`, preserving structure. */
function redactSecretsDeep(value: unknown): unknown {
  if (typeof value === "string") {
    return redactSecretText(value).value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretsDeep(item));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = redactSecretsDeep(item);
    }
    return out;
  }
  return value;
}
