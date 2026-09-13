import { randomUUID } from "node:crypto";
import type {
  McpInvokeRequest,
  McpInvokeResponse,
  PendingApprovalAction,
  PermissionSurface,
  ToolInvokeRequest,
  ToolInvokeResult,
  ToolPolicyActorContext,
  WardEffect,
} from "@goatcitadel/contracts";
import { ToolExecutionPreconditionError, type McpToolPolicyBinding, type MeshToolPolicyBinding } from "@goatcitadel/policy-engine";
import { isNativeMcpToolName, type NativeMcpChatToolBinding } from "./native-mcp-chat-binding.js";
import { isMeshChatToolName, type MeshChatToolBinding } from "./mesh-chat-binding.js";
import {
  executeApprovedExternalRuntimeSideEffect,
  type ApprovedExternalRuntimeSideEffectInput,
} from "../approved-external-runtime-side-effect-service.js";

type ApprovedExternalRuntimeExecutionOptions =
  | {
      deferResolution: true;
      externalRuntimeReplay: true;
      mcpToolBinding?: McpToolPolicyBinding;
      meshToolBinding?: MeshToolPolicyBinding;
    }
  | {
      deferResolution: true;
      externalSideEffect: {
        markStarted(): void;
        markNotRequired(): void;
      };
    };

export interface ApprovedExternalRuntimePendingActionPort {
  storage: ApprovedExternalRuntimeSideEffectInput["storage"];
  resolveNativeMcpChatToolBinding?(request: ToolInvokeRequest): Promise<NativeMcpChatToolBinding | undefined>;
  resolveMeshChatToolBinding?(request: ToolInvokeRequest): Promise<MeshChatToolBinding | undefined>;
  invokeApprovedMeshRuntime?(
    request: ToolInvokeRequest, policyResult: ToolInvokeResult, approvalId: string,
    markExternalCallStarted: () => void | Promise<void>,
  ): Promise<ToolInvokeResult>;
  executeApprovedAction(
    approvalId: string,
    signal: AbortSignal | undefined,
    options: ApprovedExternalRuntimeExecutionOptions,
  ): Promise<ToolInvokeResult | undefined>;
  enrichMcpInvokePolicyContext(input: McpInvokeRequest): Promise<McpInvokeRequest>;
  invokeApprovedMcpRuntime(
    input: McpInvokeRequest,
    markExternalCallStarted?: () => void | Promise<void>,
    options?: { wardEffect?: WardEffect },
  ): Promise<McpInvokeResponse>;
  invokeApprovedExternalRuntimeTool(
    request: ToolInvokeRequest,
    markExternalCallStarted?: () => void,
    options?: { signal?: AbortSignal },
  ): Promise<ToolInvokeResult>;
}

export async function executeApprovedExternalRuntimePendingAction(
  port: ApprovedExternalRuntimePendingActionPort,
  approvalId: string,
  pending: PendingApprovalAction,
  signal?: AbortSignal,
): Promise<ToolInvokeResult> {
  const storedRequest = toToolInvokeRequest(pending.request, signal);
  return executeApprovedExternalRuntimeSideEffect({
    storage: port.storage,
    approvalId,
    request: storedRequest,
    execute: async (markExternalCallStarted) => {
      if (!requiresApprovedExternalRuntimeAdapter(pending)) {
        const result = await port.executeApprovedAction(approvalId, signal, {
          deferResolution: true,
          externalSideEffect: {
            markStarted: markExternalCallStarted,
            // The canonical runner records the no-boundary outcome after this
            // callback returns. Keep that single durable owner authoritative.
            markNotRequired: () => undefined,
          },
        });
        return result ?? staleApprovedActionResult(false);
      }

      const native = isNativeMcpToolName(storedRequest.toolName);
      const mesh = isMeshChatToolName(storedRequest.toolName);
      const meshBinding = mesh ? await port.resolveMeshChatToolBinding?.(storedRequest) : undefined;
      if (mesh && (!meshBinding || !port.invokeApprovedMeshRuntime)) {
        throw new ToolExecutionPreconditionError("Approved mesh invocation has no frozen target or runtime owner");
      }
      const nativeBinding = native ? await port.resolveNativeMcpChatToolBinding?.(storedRequest) : undefined;
      if (native && !nativeBinding) {
        throw new ToolExecutionPreconditionError("Approved native MCP invocation has no frozen target binding");
      }
      const policyResult = await port.executeApprovedAction(approvalId, signal, {
        deferResolution: true,
        externalRuntimeReplay: true,
        ...(nativeBinding ? { mcpToolBinding: nativeBinding.policyBinding } : {}),
        ...(meshBinding ? { meshToolBinding: meshBinding.schema.policyBinding } : {}),
      });
      if (!policyResult || policyResult.outcome !== "executed") {
        return policyResult ?? staleApprovedActionResult(true);
      }

      const request = withExternalRuntimePolicyContext(storedRequest, policyResult);
      if (meshBinding) {
        return port.invokeApprovedMeshRuntime!(request, policyResult, approvalId, markExternalCallStarted);
      }
      if (request.toolName === "mcp.invoke" || nativeBinding) {
        // Re-read the durable profile after approval policy work; do not permit
        // a stale or missing mapping to reach the transport owner.
        const currentBinding = native ? await port.resolveNativeMcpChatToolBinding?.(storedRequest) : undefined;
        if (native && (!currentBinding || currentBinding.serverId !== nativeBinding?.serverId ||
          currentBinding.nativeToolName !== nativeBinding.nativeToolName)) {
          throw new ToolExecutionPreconditionError("Approved native MCP target binding drifted");
        }
        const mcpResult = await port.invokeApprovedMcpRuntime(
          await port.enrichMcpInvokePolicyContext(toMcpInvokeRequest(request, signal, currentBinding)),
          markExternalCallStarted,
          { wardEffect: policyResult.wardEffect },
        );
        return toolInvokeResultFromMcpApproval(policyResult, mcpResult, request.toolName);
      }
      return port.invokeApprovedExternalRuntimeTool(request, markExternalCallStarted, { signal });
    },
  });
}

export function isApprovedExternalRuntimePendingAction(
  pending: PendingApprovalAction | undefined,
): pending is PendingApprovalAction {
  return Boolean(pending && pending.actionType === "tool.invoke" && pending.resolutionStatus === "pending");
}

export function requiresApprovedExternalRuntimeAdapter(pending: PendingApprovalAction): boolean {
  const toolName = readRecordString(pending.request, "toolName") ?? "";
  return pending.request.externalRuntime === true || toolName === "mcp.invoke" || isNativeMcpToolName(toolName) || isMeshChatToolName(toolName);
}

export function approvedExternalRuntimeRequestMatches(
  storedRequest: Record<string, unknown>,
  request: ToolInvokeRequest,
): boolean {
  return (
    readRecordString(storedRequest, "toolName") === request.toolName &&
    stableRecordStringify(isRecord(storedRequest.args) ? storedRequest.args : {}) ===
      stableRecordStringify(request.args ?? {}) &&
    readRecordString(storedRequest, "agentId") === request.agentId &&
    readRecordString(storedRequest, "sessionId") === request.sessionId &&
    readOptionalRecordString(storedRequest, "turnId") === (request.turnId ?? undefined) &&
    readOptionalRecordString(storedRequest, "toolRunId") === (request.toolRunId ?? undefined) &&
    readOptionalRecordString(storedRequest, "citadelId") === (request.citadelId ?? undefined) &&
    readOptionalRecordString(storedRequest, "workspaceId") === (request.workspaceId ?? undefined) &&
    readOptionalRecordString(storedRequest, "taskId") === (request.taskId ?? undefined) &&
    readOptionalRecordString(storedRequest, "runId") === (request.runId ?? undefined) &&
    readOptionalRecordString(storedRequest, "permissionProfileId") === (request.permissionProfileId ?? undefined) &&
    readOptionalRecordString(storedRequest, "localOperatorOverrideId") ===
      (request.localOperatorOverrideId ?? undefined) &&
    readPermissionSurfaceValue(storedRequest.surface) === request.surface &&
    stableRecordStringify(isRecord(storedRequest.policyContext) ? storedRequest.policyContext : {}) ===
      stableRecordStringify(request.policyContext ?? {})
  );
}

export function toToolInvokeRequest(record: Record<string, unknown>, signal?: AbortSignal): ToolInvokeRequest {
  const toolName = readRecordString(record, "toolName");
  const agentId = readRecordString(record, "agentId");
  const sessionId = readRecordString(record, "sessionId");
  if (!toolName || !agentId || !sessionId) {
    throw new Error("Invalid pending tool approval request payload.");
  }
  const consentContext = isRecord(record.consentContext) ? record.consentContext : undefined;
  return {
    toolName,
    args: isRecord(record.args) ? record.args : {},
    agentId,
    sessionId,
    turnId: readRecordString(record, "turnId"),
    toolRunId: readRecordString(record, "toolRunId"),
    citadelId: readRecordString(record, "citadelId"),
    workspaceId: readRecordString(record, "workspaceId"),
    taskId: readRecordString(record, "taskId"),
    runId: readRecordString(record, "runId"),
    signal,
    permissionProfileId: readRecordString(record, "permissionProfileId"),
    localOperatorOverrideId: readRecordString(record, "localOperatorOverrideId"),
    surface: readPermissionSurfaceValue(record.surface),
    policyContext: isRecord(record.policyContext) ? (record.policyContext as ToolPolicyActorContext) : undefined,
    consentContext: consentContext
      ? {
          operatorId: readRecordString(consentContext, "operatorId"),
          source:
            consentContext.source === "ui" || consentContext.source === "tui" || consentContext.source === "agent"
              ? consentContext.source
              : undefined,
          reason: readRecordString(consentContext, "reason"),
        }
      : undefined,
    externalRuntime: record.externalRuntime === true ? true : undefined,
  };
}

export function withExternalRuntimePolicyContext(
  request: ToolInvokeRequest,
  policyResult: ToolInvokeResult,
): ToolInvokeRequest {
  const rawPolicyContext = policyResult.result?.policyContext;
  if (!isRecord(rawPolicyContext)) {
    return request;
  }
  const evaluated = rawPolicyContext as ToolPolicyActorContext;
  return {
    ...request,
    policyContext: {
      ...(request.policyContext ?? {}),
      ...evaluated,
      matchedGrantAllowedHosts:
        evaluated.matchedGrantAllowedHosts && evaluated.matchedGrantAllowedHosts.length > 0
          ? evaluated.matchedGrantAllowedHosts
          : request.policyContext?.matchedGrantAllowedHosts,
    },
  };
}

export function toApprovedMcpInvokeRequest(request: ToolInvokeRequest, signal?: AbortSignal): McpInvokeRequest {
  return toMcpInvokeRequest(request, signal);
}

/** Convert the policy-owned wrapper without accepting transport authority from its arguments. */
export function toMcpInvokeRequest(
  request: ToolInvokeRequest,
  signal?: AbortSignal,
  target?: Pick<NativeMcpChatToolBinding, "serverId" | "nativeToolName">,
): McpInvokeRequest {
  if (target ? request.toolName !== `mcp.${target.serverId}.${target.nativeToolName}` : request.toolName !== "mcp.invoke") {
    throw new ToolExecutionPreconditionError("MCP invocation does not match its explicit target binding");
  }
  const serverId = target?.serverId ?? (typeof request.args.serverId === "string" ? request.args.serverId.trim() : "");
  const toolName = target?.nativeToolName ?? (typeof request.args.toolName === "string" ? request.args.toolName.trim() : "");
  if (!serverId || !toolName) {
    throw new Error("Invalid MCP invocation payload.");
  }
  return {
    serverId,
    toolName,
    arguments: target ? request.args : isRecord(request.args.arguments) ? request.args.arguments : {},
    agentId: request.agentId,
    sessionId: request.sessionId,
    workspaceId: request.workspaceId,
    taskId: request.taskId,
    runId: request.runId,
    permissionProfileId: request.permissionProfileId,
    localOperatorOverrideId: request.localOperatorOverrideId,
    surface: request.surface,
    policyContext: request.policyContext,
    consentContext: request.consentContext,
    signal,
  };
}

export function toolInvokeResultFromMcpApproval(
  policyResult: ToolInvokeResult,
  mcpResult: McpInvokeResponse,
  toolName = "mcp.invoke",
): ToolInvokeResult {
  return toolInvokeResultFromMcpRuntime(policyResult, mcpResult, " after approval", toolName);
}

export function toolInvokeResultFromMcpRuntime(
  policyResult: ToolInvokeResult,
  mcpResult: McpInvokeResponse,
  executionContext = "",
  toolName = "mcp.invoke",
): ToolInvokeResult {
  const result = {
    externalRuntime: true,
    toolName,
    ok: mcpResult.ok,
    output: mcpResult.output,
    contentItems: mcpResult.contentItems,
    diagnostics: mcpResult.diagnostics,
    error: mcpResult.ok ? undefined : mcpResult.error,
    externalOutcome: mcpResult.externalOutcome,
    manualReconciliationRequired: mcpResult.manualReconciliationRequired,
  };
  if (!mcpResult.ok) {
    if (mcpResult.externalOutcome === "unknown_after_send" && mcpResult.manualReconciliationRequired) {
      return {
        ...policyResult,
        outcome: "executed",
        policyReason:
          `MCP runtime outcome is unknown${executionContext}; manual reconciliation is required: ` +
          `${mcpResult.error ?? "unknown error"}`,
        result,
      };
    }
    return {
      ...policyResult,
      outcome: "blocked",
      policyReason: `MCP runtime failed${executionContext}: ${mcpResult.error ?? "unknown error"}`,
      result,
    };
  }
  return {
    ...policyResult,
    outcome: "executed",
    policyReason: `${policyResult.policyReason}; MCP runtime executed${executionContext}`,
    result,
  };
}

export function toolInvokeResultRecord(result: ToolInvokeResult): Record<string, unknown> {
  return {
    outcome: result.outcome,
    policyReason: result.policyReason,
    auditEventId: result.auditEventId,
    result: result.result,
  };
}

export function readPermissionSurfaceValue(value: unknown): PermissionSurface | undefined {
  return value === "chat" ||
    value === "cowork" ||
    value === "code" ||
    value === "tools" ||
    value === "mcp" ||
    value === "all"
    ? value
    : undefined;
}

export function readAuthActorSource(value: unknown): ToolPolicyActorContext["authActorSource"] | undefined {
  return value === "none" ||
    value === "token" ||
    value === "basic" ||
    value === "loopback" ||
    value === "sse" ||
    value === "device" ||
    value === "companion"
    ? value
    : undefined;
}

function readRecordString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readOptionalRecordString(record: Record<string, unknown>, key: string): string | undefined {
  return readRecordString(record, key);
}

function stableRecordStringify(value: unknown): string {
  return JSON.stringify(sortRecordValue(value));
}

function staleApprovedActionResult(externalRuntime: boolean): ToolInvokeResult {
  return {
    outcome: "blocked",
    policyReason: externalRuntime
      ? "Approved external runtime action no longer matches executable pending state."
      : "Approved action no longer matches executable pending state.",
    auditEventId: randomUUID(),
  };
}

function sortRecordValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortRecordValue);
  }
  if (value && typeof value === "object") {
    return Object.keys(value as Record<string, unknown>)
      .sort((left, right) => left.localeCompare(right))
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortRecordValue((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
