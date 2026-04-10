import type {
  ApprovalInboxItemRecord,
  ApprovalInboxItemState,
  ApprovalRequest,
  McpInvokeRequest,
  McpInvokeResponse,
  McpServerRecord,
  McpToolRecord,
} from "@goatcitadel/contracts";
import { ConflictError, ValidationError } from "@goatcitadel/contracts";
import type { ApprovalInboxRepository } from "@goatcitadel/storage";

export const MCP_APPROVAL_DELIVERY_TOOL_NAME = "goatcitadel.approval.remote_action_ready";
export const MCP_APPROVAL_INBOX_LIST_TOOL_NAME = "goatcitadel.approval.remote_action_inbox.list";
export const MCP_APPROVAL_INBOX_RESOLVE_TOOL_NAME = "goatcitadel.approval.remote_action_inbox.resolve";
export const MCP_APPROVAL_INBOX_URL = "goatcitadel://approval-inbox";

/** Rate limiter: max resolve attempts per server per window. */
const RESOLVE_RATE_LIMIT_MAX = 10;
const RESOLVE_RATE_LIMIT_WINDOW_MS = 60_000;
const resolveAttempts = new Map<string, { count: number; windowStart: number }>();

function checkResolveRateLimit(serverId: string): void {
  const now = Date.now();
  const entry = resolveAttempts.get(serverId);
  if (!entry || now - entry.windowStart > RESOLVE_RATE_LIMIT_WINDOW_MS) {
    resolveAttempts.set(serverId, { count: 1, windowStart: now });
    return;
  }
  entry.count += 1;
  if (entry.count > RESOLVE_RATE_LIMIT_MAX) {
    throw new ConflictError({
      message: `Approval resolution rate limit exceeded for MCP server ${serverId}. Max ${RESOLVE_RATE_LIMIT_MAX} per ${RESOLVE_RATE_LIMIT_WINDOW_MS / 1000}s.`,
    });
  }
}

type ApprovalInboxPort = Pick<
  ApprovalInboxRepository,
  "receiveMcpApprovalDelivery" | "listByReceiver" | "get" | "markResolved"
>;

export function isInternalMcpApprovalInboxServer(server: Pick<McpServerRecord, "url">): boolean {
  return server.url?.trim().toLowerCase() === MCP_APPROVAL_INBOX_URL;
}

export function createInternalMcpApprovalInboxTools(serverId: string): McpToolRecord[] {
  const updatedAt = new Date().toISOString();
  return [
    {
      serverId,
      toolName: MCP_APPROVAL_DELIVERY_TOOL_NAME,
      description:
        "Receives durable approval delivery envelopes and stores them in the GoatCitadel MCP approval inbox.",
      enabled: true,
      updatedAt,
      inputSchema: {
        type: "object",
        properties: {
          approvalId: { type: "string" },
          kind: { type: "string" },
          riskLevel: { type: "string" },
          status: { type: "string" },
          preview: { type: "object" },
          tokenId: { type: "string" },
          token: { type: "string" },
          actionType: { type: "string" },
          expiresAt: { type: "string" },
        },
        required: [
          "approvalId",
          "kind",
          "riskLevel",
          "status",
          "preview",
          "tokenId",
          "token",
          "actionType",
          "expiresAt",
        ],
      },
    },
    {
      serverId,
      toolName: MCP_APPROVAL_INBOX_LIST_TOOL_NAME,
      description: "Lists pending or resolved approval deliveries received through the MCP approval inbox.",
      enabled: true,
      updatedAt,
      inputSchema: {
        type: "object",
        properties: {
          state: { type: "string" },
          limit: { type: "number" },
        },
      },
    },
    {
      serverId,
      toolName: MCP_APPROVAL_INBOX_RESOLVE_TOOL_NAME,
      description: "Approves, rejects, or edits a pending approval inbox item using its remote action token.",
      enabled: true,
      updatedAt,
      inputSchema: {
        type: "object",
        properties: {
          inboxItemId: { type: "string" },
          decision: { type: "string" },
          editedPayload: { type: "object" },
          resolutionNote: { type: "string" },
          resolvedBy: { type: "string" },
        },
        required: ["inboxItemId", "decision"],
      },
    },
  ];
}

export async function handleInternalMcpApprovalInboxInvoke(
  server: McpServerRecord,
  input: McpInvokeRequest,
  deps: {
    approvalInbox: ApprovalInboxPort;
    resolveApprovalWithRemoteTokenId: (input: {
      tokenId: string;
      decision: "approve" | "reject" | "edit";
      editedPayload?: Record<string, unknown>;
      resolutionNote?: string;
    }) => Promise<{ approval: ApprovalRequest }>;
  },
): Promise<McpInvokeResponse> {
  if (!isInternalMcpApprovalInboxServer(server)) {
    return {
      ok: false,
      error: `MCP server ${server.serverId} is not an internal approval inbox server.`,
    };
  }

  try {
    switch (input.toolName) {
      case MCP_APPROVAL_DELIVERY_TOOL_NAME:
        return {
          ok: true,
          output: {
            item: deps.approvalInbox.receiveMcpApprovalDelivery(
              parseDeliveryEnvelope(server.serverId, input.arguments),
            ),
          },
        };

      case MCP_APPROVAL_INBOX_LIST_TOOL_NAME:
        return {
          ok: true,
          output: {
            items: deps.approvalInbox.listByReceiver("mcp", server.serverId, parseListArgs(input.arguments)),
          },
        };

      case MCP_APPROVAL_INBOX_RESOLVE_TOOL_NAME:
        return {
          ok: true,
          output: await resolveInboxItem(server.serverId, input.arguments, deps),
        };

      default:
        return {
          ok: false,
          error: `Unsupported internal approval inbox tool ${input.toolName}.`,
        };
    }
  } catch (error) {
    return {
      ok: false,
      error: (error as Error).message,
    };
  }
}

function parseDeliveryEnvelope(
  serverId: string,
  args: Record<string, unknown> | undefined,
): {
  connectorId: string;
  receiverId: string;
  approvalId: string;
  tokenId: string;
  token: string;
  approvalKind: string;
  riskLevel: ApprovalRequest["riskLevel"];
  approvalStatus: ApprovalRequest["status"];
  preview: Record<string, unknown>;
  expiresAt: string;
} {
  const approvalId = requireNonEmptyString(args?.approvalId, "approvalId");
  const tokenId = requireNonEmptyString(args?.tokenId, "tokenId");
  const token = requireNonEmptyString(args?.token, "token");
  const actionType = requireNonEmptyString(args?.actionType, "actionType");
  if (actionType !== "approval.resolve") {
    throw new ValidationError({ message: `Unsupported approval inbox action type ${actionType}.` });
  }
  const riskLevel = requireEnumValue(args?.riskLevel, ["safe", "caution", "danger", "nuclear"], "riskLevel");
  const approvalStatus = requireEnumValue(args?.status, ["pending", "approved", "rejected", "edited"], "status");
  return {
    connectorId: `mcp:${serverId}`,
    receiverId: serverId,
    approvalId,
    tokenId,
    token,
    approvalKind: requireNonEmptyString(args?.kind, "kind"),
    riskLevel,
    approvalStatus,
    preview: normalizeObject(args?.preview),
    expiresAt: requireNonEmptyString(args?.expiresAt, "expiresAt"),
  };
}

function parseListArgs(args: Record<string, unknown> | undefined): {
  state?: ApprovalInboxItemState;
  limit?: number;
} {
  const state = optionalEnumValue(args?.state, ["pending", "approved", "rejected", "edited", "expired", "failed"]);
  const limit =
    typeof args?.limit === "number" && Number.isFinite(args.limit)
      ? Math.max(1, Math.min(200, Math.trunc(args.limit)))
      : undefined;
  return {
    state,
    limit,
  };
}

async function resolveInboxItem(
  serverId: string,
  args: Record<string, unknown> | undefined,
  deps: {
    approvalInbox: ApprovalInboxPort;
    resolveApprovalWithRemoteTokenId: (input: {
      tokenId: string;
      decision: "approve" | "reject" | "edit";
      editedPayload?: Record<string, unknown>;
      resolutionNote?: string;
    }) => Promise<{ approval: ApprovalRequest }>;
  },
): Promise<{ item: ApprovalInboxItemRecord; approval?: ApprovalRequest }> {
  checkResolveRateLimit(serverId);
  const inboxItemId = requireNonEmptyString(args?.inboxItemId, "inboxItemId");
  const decision = requireEnumValue(args?.decision, ["approve", "reject", "edit"], "decision");
  const resolvedBy = optionalString(args?.resolvedBy) ?? "operator:mcp";
  const item = deps.approvalInbox.get(inboxItemId);
  if (item.receiverId !== serverId || item.receiverKind !== "mcp") {
    throw new ConflictError({
      message: `Approval inbox item ${inboxItemId} is not assigned to MCP server ${serverId}.`,
    });
  }
  if (item.state !== "pending") {
    throw new ConflictError({
      message: `Approval inbox item ${inboxItemId} is already ${item.state}.`,
    });
  }

  try {
    const result = await deps.resolveApprovalWithRemoteTokenId({
      tokenId: item.tokenId,
      decision,
      editedPayload: normalizeOptionalObject(args?.editedPayload),
      resolutionNote: optionalString(args?.resolutionNote),
    });
    const updated = deps.approvalInbox.markResolved(inboxItemId, {
      state: mapDecisionToInboxState(decision),
      approvalStatus: result.approval.status,
      resolvedAt: result.approval.resolvedAt ?? new Date().toISOString(),
      resolvedBy,
    });
    return {
      item: updated,
      approval: result.approval,
    };
  } catch (error) {
    const currentState = Date.parse(item.expiresAt) <= Date.now() ? "expired" : "failed";
    const updated = deps.approvalInbox.markResolved(inboxItemId, {
      state: currentState,
      approvalStatus: item.approvalStatus,
      resolvedAt: new Date().toISOString(),
      resolvedBy,
      lastError: (error as Error).message,
    });
    if (updated.state !== currentState) {
      return { item: updated };
    }
    throw new Error(updated.lastError, { cause: error });
  }
}

function mapDecisionToInboxState(
  decision: "approve" | "reject" | "edit",
): Extract<ApprovalInboxItemState, "approved" | "rejected" | "edited"> {
  if (decision === "approve") {
    return "approved";
  }
  if (decision === "reject") {
    return "rejected";
  }
  return "edited";
}

function requireNonEmptyString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ValidationError({ message: `${field} is required.` });
  }
  return value.trim();
}

function requireEnumValue<const T extends readonly string[]>(value: unknown, allowed: T, field: string): T[number] {
  if (typeof value !== "string" || !allowed.includes(value)) {
    throw new ValidationError({ message: `${field} must be one of ${allowed.join(", ")}.` });
  }
  return value as T[number];
}

function optionalEnumValue<const T extends readonly string[]>(value: unknown, allowed: T): T[number] | undefined {
  if (typeof value !== "string" || !allowed.includes(value)) {
    return undefined;
  }
  return value as T[number];
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function normalizeOptionalObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}
