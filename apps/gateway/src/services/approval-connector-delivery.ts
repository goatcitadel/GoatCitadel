import { randomUUID } from "node:crypto";
import {
  redactStructuredSecrets,
  type ApprovalRequest,
  type ConnectorDeliveryWorkflowPayload,
  type ConnectorCapabilityId,
  type ConnectorRecord,
  type DurableRunCreateRequest,
  type DurableRunRecord,
} from "@goatcitadel/contracts";
import type { ApprovalRemoteTokenSecretService } from "./approval-remote-token-secret.js";

const MCP_APPROVAL_DELIVERY_TOOL_NAME = "goatcitadel.approval.remote_action_ready";

export interface ApprovalRemoteTokenDeliveryRuntime {
  readonly tokenSecrets: Pick<ApprovalRemoteTokenSecretService, "store" | "delete">;
  readonly requestAttribution: { traceId?: string; originSurface?: string };
  createDurableRun(input: DurableRunCreateRequest): DurableRunRecord;
}

export function enqueueApprovalRemoteTokenConnectorDelivery(
  runtime: ApprovalRemoteTokenDeliveryRuntime,
  input: {
    approval: ApprovalRequest;
    connector: ConnectorRecord;
    tokenRecord: { token: string; tokenId: string; expiresAt: string };
  },
): DurableRunRecord | undefined {
  const needsSecret =
    input.connector.connectorType === "browser" ||
    (input.connector.connectorType === "integration_connection" && supportsInlineApprovalActions(input.connector));
  let tokenRef: string | undefined;
  try {
    tokenRef = needsSecret ? runtime.tokenSecrets.store(input.tokenRecord.tokenId, input.tokenRecord.token) : undefined;
    const payload = buildApprovalRemoteTokenConnectorDeliveryPayload({
      approval: input.approval,
      connector: input.connector,
      tokenRef,
      tokenId: input.tokenRecord.tokenId,
      expiresAt: input.tokenRecord.expiresAt,
    });
    if (!payload) {
      if (tokenRef) {
        try {
          runtime.tokenSecrets.delete(tokenRef);
        } catch {
          // Token issuance already committed before connector fan-out. Leave
          // the orphaned keychain value for expiry reconciliation instead of
          // turning a benign no-delivery result into a failed issuance.
        }
      }
      return undefined;
    }
    return runtime.createDurableRun({
      runId: randomUUID(),
      workflowKey: "connector.delivery",
      payload: stripUndefined({
        ...payload,
        traceId: runtime.requestAttribution.traceId,
        originSurface: payload.originSurface ?? runtime.requestAttribution.originSurface,
      }),
      metadata: {
        approvalId: input.approval.approvalId,
        connectorId: input.connector.connectorId,
        connectorType: input.connector.connectorType,
        deliveryKind: "approval.remote_token",
        tokenId: input.tokenRecord.tokenId,
      },
    });
  } catch (error) {
    const committedRun = readCommittedDurableRun(error);
    if (committedRun) {
      return committedRun;
    }
    if (tokenRef && !isCommittedMutationError(error)) {
      try {
        runtime.tokenSecrets.delete(tokenRef);
      } catch {
        // Preserve the enqueue error; an orphaned keychain value is safer than
        // copying the bearer into durable state.
      }
    }
    throw error;
  }
}

function isCommittedMutationError(error: unknown): error is { mutationCommitted: true } {
  return (
    error !== null &&
    typeof error === "object" &&
    "mutationCommitted" in error &&
    (error as { mutationCommitted?: unknown }).mutationCommitted === true
  );
}

function readCommittedDurableRun(error: unknown): DurableRunRecord | undefined {
  if (!isCommittedMutationError(error)) {
    return undefined;
  }
  const durableRun =
    "durableRun" in error
      ? (error as { durableRun?: unknown }).durableRun
      : "canonicalResult" in error
        ? (error as { canonicalResult?: unknown }).canonicalResult
        : undefined;
  return durableRun !== null &&
    typeof durableRun === "object" &&
    "runId" in durableRun &&
    typeof (durableRun as { runId?: unknown }).runId === "string"
    ? (durableRun as DurableRunRecord)
    : undefined;
}

export function buildApprovalRemoteTokenConnectorDeliveryPayload(input: {
  approval: ApprovalRequest;
  connector: ConnectorRecord;
  tokenRef?: string;
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
      if (!input.tokenRef) {
        return undefined;
      }
      return {
        version: "connector.delivery.v1",
        connectorId: input.connector.connectorId,
        connectorType: input.connector.connectorType,
        action: "realtime.emit",
        correlationId: input.approval.approvalId,
        approvalAction: { tokenId: input.tokenId, expiresAt: input.expiresAt },
        ...buildApprovalDeliveryGovernance(input.approval),
        secretRefs: { approvalActionToken: input.tokenRef },
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
      const interactiveActionTemplate =
        supportsInlineApprovalActions(input.connector) && input.tokenRef
          ? {
              platform: readIntegrationActionPlatform(input.connector),
              tokenId: input.tokenId,
              tokenRef: input.tokenRef,
              expiresAt: input.expiresAt,
              buttons: [
                { label: "Approve", decision: "a" as const },
                { label: "Deny", decision: "r" as const },
              ],
            }
          : undefined;
      return {
        version: "connector.delivery.v1",
        connectorId: input.connector.connectorId,
        connectorType: input.connector.connectorType,
        action: "channel.send",
        correlationId: input.approval.approvalId,
        approvalAction: { tokenId: input.tokenId, expiresAt: input.expiresAt },
        ...buildApprovalDeliveryGovernance(input.approval),
        ...(interactiveActionTemplate && input.tokenRef ? { secretRefs: { approvalActionToken: input.tokenRef } } : {}),
        payload: {
          target,
          message: buildIntegrationApprovalDeliveryMessage(input, Boolean(interactiveActionTemplate)),
          interactiveActionTemplate,
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
        approvalAction: { tokenId: input.tokenId, expiresAt: input.expiresAt },
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

/**
 * Hydrate a protected browser approval bearer only in the transient realtime
 * event. Integration deliveries must retain their template plus keychain
 * reference through the durable channel queue, policy, and hooks; the native
 * provider adapter owns their final secret resolution.
 */
export function hydrateBrowserApprovalRemoteTokenConnectorDeliveryPayload(
  payload: ConnectorDeliveryWorkflowPayload,
  rawToken: string,
): ConnectorDeliveryWorkflowPayload {
  const token = rawToken.trim();
  if (!/^grat_[A-Za-z0-9_-]{43}$/.test(token)) {
    throw new Error("Approval remote-action token is unavailable or invalid.");
  }
  const actionPayload = payload.payload ?? {};
  if (payload.connectorType !== "browser") {
    throw new Error("Only browser approval deliveries can hydrate before connector dispatch.");
  }
  const eventPayload =
    actionPayload.payload && typeof actionPayload.payload === "object" && !Array.isArray(actionPayload.payload)
      ? (actionPayload.payload as Record<string, unknown>)
      : {};
  return {
    ...payload,
    payload: {
      ...actionPayload,
      payload: {
        ...eventPayload,
        token,
      },
    },
  };
}

function hasEnabledCapability(connector: ConnectorRecord, capabilityId: ConnectorCapabilityId): boolean {
  return connector.capabilities.some((item) => item.id === capabilityId && item.enabled);
}

function supportsInlineApprovalActions(connector: ConnectorRecord): boolean {
  return (
    hasEnabledCapability(connector, "interactive_actions") && connector.metadata?.approvalInlineActionsReady === true
  );
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
  tokenId: string;
  expiresAt: string;
}): Record<string, unknown> {
  const publicApproval = redactStructuredSecrets(input.approval).value;
  const governance = buildApprovalDeliveryGovernance(publicApproval);
  return {
    approvalId: publicApproval.approvalId,
    kind: publicApproval.kind,
    riskLevel: publicApproval.riskLevel,
    status: publicApproval.status,
    preview: publicApproval.preview,
    linkage: buildApprovalDeliveryLinkage(publicApproval),
    governance,
    tokenId: input.tokenId,
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
    tokenId: string;
    expiresAt: string;
  },
  includesInteractiveActions: boolean,
): string {
  const publicApproval = redactStructuredSecrets(input.approval).value;
  const summary = summarizeApprovalPreview(publicApproval.preview);
  const requester = summarizeApprovalRequester(publicApproval);
  const rollback =
    readApprovalScopedString(publicApproval.rollbackNote ?? publicApproval.payload?.rollbackNote) ?? "n/a";
  const lines = [
    "GoatCitadel approval action requested.",
    `Approval ID: ${publicApproval.approvalId}`,
    `Requester: ${requester}`,
    `Kind: ${publicApproval.kind}`,
    `Risk: ${publicApproval.riskLevel}`,
    `Status: ${publicApproval.status}`,
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
