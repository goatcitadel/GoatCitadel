import type {
  ApprovalRequest,
  ConnectorDeliveryWorkflowPayload,
  ConnectorCapabilityId,
  ConnectorRecord,
} from "@goatcitadel/contracts";

const MCP_APPROVAL_DELIVERY_TOOL_NAME = "goatcitadel.approval.remote_action_ready";

export function buildApprovalRemoteTokenConnectorDeliveryPayload(input: {
  approval: ApprovalRequest;
  connector: ConnectorRecord;
  token: string;
  tokenId: string;
  expiresAt: string;
}): ConnectorDeliveryWorkflowPayload | undefined {
  if (input.connector.status !== "active") {
    return undefined;
  }
  switch (input.connector.connectorType) {
    case "browser":
      if (
        !hasEnabledCapability(input.connector, "approvals") ||
        !hasEnabledCapability(input.connector, "interactive_actions")
      ) {
        return undefined;
      }
      return {
        version: "connector.delivery.v1",
        connectorId: input.connector.connectorId,
        connectorType: input.connector.connectorType,
        action: "realtime.emit",
        correlationId: input.approval.approvalId,
        ...buildApprovalDeliveryGovernance(input.approval),
        payload: {
          eventType: "approval_remote_action_ready",
          source: "approvals",
          payload: buildApprovalDeliveryEnvelope(input),
        },
      };

    case "integration_connection": {
      if (
        !hasEnabledCapability(input.connector, "approvals") ||
        !hasEnabledCapability(input.connector, "outbound_messages")
      ) {
        return undefined;
      }
      const target = readMetadataString(input.connector, "approvalDeliveryTarget");
      if (!target) {
        return undefined;
      }
      const interactiveActions = hasEnabledCapability(input.connector, "interactive_actions")
        ? {
            platform: readIntegrationActionPlatform(input.connector),
            tokenId: input.tokenId,
            buttons: [
              { label: "Approve", callbackData: `gca:${input.token}:a` },
              { label: "Deny", callbackData: `gca:${input.token}:r` },
            ],
          }
        : undefined;
      return {
        version: "connector.delivery.v1",
        connectorId: input.connector.connectorId,
        connectorType: input.connector.connectorType,
        action: "channel.send",
        correlationId: input.approval.approvalId,
        ...buildApprovalDeliveryGovernance(input.approval),
        payload: {
          target,
          message: buildIntegrationApprovalDeliveryMessage(input, Boolean(interactiveActions)),
          interactiveActions,
        },
      };
    }

    case "mcp_server": {
      if (
        !hasEnabledCapability(input.connector, "approvals") ||
        !hasEnabledCapability(input.connector, "interactive_actions")
      ) {
        return undefined;
      }
      return {
        version: "connector.delivery.v1",
        connectorId: input.connector.connectorId,
        connectorType: input.connector.connectorType,
        action: "mcp.invoke",
        correlationId: input.approval.approvalId,
        ...buildApprovalDeliveryGovernance(input.approval),
        payload: {
          approvalId: input.approval.approvalId,
          toolName: readMetadataString(input.connector, "approvalDeliveryToolName") ?? MCP_APPROVAL_DELIVERY_TOOL_NAME,
          ...buildApprovalDeliveryGovernance(input.approval),
          arguments: buildApprovalDeliveryEnvelope(input),
        },
      };
    }

    default:
      return undefined;
  }
}

function hasEnabledCapability(connector: ConnectorRecord, capabilityId: ConnectorCapabilityId): boolean {
  return connector.capabilities.some((item) => item.id === capabilityId && item.enabled);
}

function readMetadataString(connector: ConnectorRecord, key: string): string | undefined {
  const value = connector.metadata?.[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readIntegrationActionPlatform(connector: ConnectorRecord): string {
  return (
    readMetadataString(connector, "approvalDeliveryPlatform") ??
    readMetadataString(connector, "key")?.toLowerCase() ??
    "integration"
  );
}

function buildApprovalDeliveryEnvelope(input: {
  approval: ApprovalRequest;
  token: string;
  tokenId: string;
  expiresAt: string;
}): Record<string, unknown> {
  const governance = buildApprovalDeliveryGovernance(input.approval);
  return {
    approvalId: input.approval.approvalId,
    kind: input.approval.kind,
    riskLevel: input.approval.riskLevel,
    status: input.approval.status,
    preview: input.approval.preview,
    linkage: buildApprovalDeliveryLinkage(input.approval),
    governance,
    tokenId: input.tokenId,
    token: input.token,
    actionType: "approval.resolve",
    expiresAt: input.expiresAt,
  };
}

function buildApprovalDeliveryGovernance(approval: ApprovalRequest): {
  workspaceId?: string;
  sessionId?: string;
  taskId?: string;
  runId?: string;
  operatorId?: string;
  authActorId?: string;
  authActorSource?: "none" | "token" | "basic" | "loopback" | "sse" | "device" | "companion" | "a2a_peer";
  permissionProfileId?: string;
  localOperatorOverrideId?: string;
  originSurface?: string;
} {
  const payload = approval.payload ?? {};
  return stripUndefined({
    workspaceId: readApprovalScopedString(approval.linkage?.workspaceId ?? payload.workspaceId),
    sessionId: readApprovalScopedString(approval.linkage?.sessionId ?? payload.sessionId),
    taskId: readApprovalScopedString(approval.linkage?.taskId ?? payload.taskId ?? payload.policyTaskId),
    runId: readApprovalScopedString(
      approval.linkage?.runId ?? approval.linkage?.durableRunId ?? payload.runId ?? payload.policyRunId,
    ),
    operatorId: readApprovalScopedString(
      approval.linkage?.operatorId ?? payload.operatorId ?? payload.authActorId ?? approval.resolvedBy,
    ),
    authActorId: readApprovalScopedString(approval.linkage?.authActorId ?? payload.authActorId),
    authActorSource: readApprovalAuthActorSource(approval.linkage?.authActorSource ?? payload.authActorSource),
    permissionProfileId: readApprovalScopedString(approval.linkage?.permissionProfileId ?? payload.permissionProfileId),
    localOperatorOverrideId: readApprovalScopedString(
      approval.linkage?.localOperatorOverrideId ?? payload.localOperatorOverrideId,
    ),
    originSurface: readApprovalScopedString(
      approval.linkage?.originSurface ?? payload.originSurface ?? payload.surface,
    ),
  });
}

function buildApprovalDeliveryLinkage(approval: ApprovalRequest): Record<string, unknown> {
  return stripUndefined({
    sessionId: readApprovalScopedString(approval.linkage?.sessionId),
    turnId: readApprovalScopedString(approval.linkage?.turnId),
    taskId: readApprovalScopedString(approval.linkage?.taskId),
    workspaceId: readApprovalScopedString(approval.linkage?.workspaceId),
    runId: readApprovalScopedString(approval.linkage?.runId),
    durableRunId: readApprovalScopedString(approval.linkage?.durableRunId),
    proactiveRunId: readApprovalScopedString(approval.linkage?.proactiveRunId),
    originSurface: readApprovalScopedString(approval.linkage?.originSurface),
    correlationId: readApprovalScopedString(approval.linkage?.correlationId),
    traceId: readApprovalScopedString(approval.linkage?.traceId),
    connectorId: readApprovalScopedString(approval.linkage?.connectorId),
    tokenId: readApprovalScopedString(approval.linkage?.tokenId),
    toolName: readApprovalScopedString(approval.linkage?.toolName),
    actionType: readApprovalScopedString(approval.linkage?.actionType),
    operatorId: readApprovalScopedString(approval.linkage?.operatorId),
    authActorId: readApprovalScopedString(approval.linkage?.authActorId),
    authActorSource: readApprovalAuthActorSource(approval.linkage?.authActorSource),
    permissionProfileId: readApprovalScopedString(approval.linkage?.permissionProfileId),
    localOperatorOverrideId: readApprovalScopedString(approval.linkage?.localOperatorOverrideId),
  });
}

function readApprovalScopedString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function readApprovalAuthActorSource(
  value: unknown,
): "none" | "token" | "basic" | "loopback" | "sse" | "device" | "companion" | "a2a_peer" | undefined {
  return value === "none" ||
    value === "token" ||
    value === "basic" ||
    value === "loopback" ||
    value === "sse" ||
    value === "device" ||
    value === "companion" ||
    value === "a2a_peer"
    ? value
    : undefined;
}

function stripUndefined<T extends Record<string, unknown>>(input: T): T {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)) as T;
}

function buildIntegrationApprovalDeliveryMessage(
  input: {
    approval: ApprovalRequest;
    token: string;
    tokenId: string;
    expiresAt: string;
  },
  includesInteractiveActions: boolean,
): string {
  const summary = summarizeApprovalPreview(input.approval.preview);
  const requester = summarizeApprovalRequester(input.approval);
  const rollback =
    readApprovalScopedString(input.approval.rollbackNote ?? input.approval.payload?.rollbackNote) ?? "n/a";
  const lines = [
    "GoatCitadel approval action requested.",
    `Approval ID: ${input.approval.approvalId}`,
    `Requester: ${requester}`,
    `Kind: ${input.approval.kind}`,
    `Risk: ${input.approval.riskLevel}`,
    `Status: ${input.approval.status}`,
    `Rollback: ${rollback}`,
    summary ? `Preview: ${summary}` : undefined,
    `Action token ID: ${input.tokenId}`,
    `Expires at: ${input.expiresAt}`,
    includesInteractiveActions
      ? "Use the inline approval buttons, or resolve this approval from Mission Control."
      : "Resolve this approval from Mission Control.",
  ];
  return lines.filter((line): line is string => Boolean(line)).join("\n");
}

function summarizeApprovalRequester(approval: ApprovalRequest): string {
  const payload = approval.payload ?? {};
  const displayName =
    readApprovalScopedString(payload.requesterDisplayName) ??
    readApprovalScopedString(payload.actorDisplayName) ??
    readApprovalScopedString(payload.displayName);
  const actorId =
    readApprovalScopedString(payload.requesterActorId) ??
    readApprovalScopedString(payload.authActorId) ??
    readApprovalScopedString(payload.actorId) ??
    readApprovalScopedString(approval.resolvedBy);
  if (displayName && actorId) {
    return `${displayName} (${actorId})`;
  }
  return displayName ?? actorId ?? "n/a";
}

function summarizeApprovalPreview(preview: Record<string, unknown>): string | undefined {
  const summary = preview.summary;
  if (typeof summary === "string" && summary.trim().length > 0) {
    return summary.trim();
  }
  const serialized = JSON.stringify(preview);
  if (!serialized || serialized === "{}") {
    return undefined;
  }
  return serialized.length <= 180 ? serialized : `${serialized.slice(0, 177)}...`;
}
