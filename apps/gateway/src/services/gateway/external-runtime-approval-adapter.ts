import type {
  McpInvokeRequest,
  McpInvokeResponse,
  PendingApprovalAction,
  PermissionSurface,
  ToolInvokeRequest,
  ToolInvokeResult,
  ToolPolicyActorContext,
} from "@goatcitadel/contracts";

export function isApprovedExternalRuntimePendingAction(
  pending: PendingApprovalAction | undefined,
): pending is PendingApprovalAction {
  if (!pending || pending.actionType !== "tool.invoke" || pending.resolutionStatus !== "pending") {
    return false;
  }
  if (pending.request.externalRuntime === true) {
    return true;
  }
  return readRecordString(pending.request, "toolName") === "mcp.invoke";
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
  const serverId = typeof request.args.serverId === "string" ? request.args.serverId.trim() : "";
  const toolName = typeof request.args.toolName === "string" ? request.args.toolName.trim() : "";
  if (!serverId || !toolName) {
    throw new Error("Invalid approved MCP invocation payload.");
  }
  return {
    serverId,
    toolName,
    arguments: isRecord(request.args.arguments) ? request.args.arguments : {},
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
): ToolInvokeResult {
  const result = {
    externalRuntime: true,
    toolName: "mcp.invoke",
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
          `MCP runtime outcome is unknown after approval; manual reconciliation is required: ` +
          `${mcpResult.error ?? "unknown error"}`,
        result,
      };
    }
    return {
      ...policyResult,
      outcome: "blocked",
      policyReason: `MCP runtime failed after approval: ${mcpResult.error ?? "unknown error"}`,
      result,
    };
  }
  return {
    ...policyResult,
    outcome: "executed",
    policyReason: `${policyResult.policyReason}; MCP runtime executed after approval`,
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
