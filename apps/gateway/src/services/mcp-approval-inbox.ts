import type {
  ApprovalInboxItemRecord,
  ApprovalInboxItemState,
  ApprovalRequest,
  McpElicitationRequest,
  McpElicitationOwnerMetadata,
  McpElicitationResponseAction,
  McpElicitationStatus,
  McpInvokeRequest,
  McpInvokeResponse,
  McpServerRecord,
  McpToolRecord,
} from "@goatcitadel/contracts";
import { ConflictError, ValidationError } from "@goatcitadel/contracts";
import type { ApprovalInboxRepository } from "@goatcitadel/storage";
import { projectMcpPublicValue } from "./mcp-public-projection.js";

export const MCP_APPROVAL_DELIVERY_TOOL_NAME = "goatcitadel.approval.remote_action_ready";
export const MCP_APPROVAL_INBOX_LIST_TOOL_NAME = "goatcitadel.approval.remote_action_inbox.list";
export const MCP_APPROVAL_INBOX_RESOLVE_TOOL_NAME = "goatcitadel.approval.remote_action_inbox.resolve";
export const MCP_APPROVAL_INBOX_ELICITATION_LIST_TOOL_NAME = "goatcitadel.approval.mcp_elicitation.list";
export const MCP_APPROVAL_INBOX_ELICITATION_RESPOND_TOOL_NAME = "goatcitadel.approval.mcp_elicitation.respond";
export const MCP_APPROVAL_INBOX_URL = "goatcitadel://approval-inbox";

/** Allowed MCP elicitation lifecycle statuses for inbox list filtering. */
const MCP_ELICITATION_STATUSES = ["pending", "accepted", "declined", "cancelled", "expired"] as const;
/** Allowed MCP elicitation response actions accepted by the inbox respond tool. */
const MCP_ELICITATION_ACTIONS = ["accept", "decline", "cancel"] as const;

/** Dependency that records an operator response to a server-initiated MCP elicitation. */
export type RespondToMcpElicitation = (input: {
  elicitationId: string;
  action: McpElicitationResponseAction;
  content?: Record<string, unknown>;
  owner?: McpElicitationOwnerMetadata;
}) => McpElicitationRequest;

/** Dependency that lists server-initiated MCP elicitations awaiting an operator response. */
export type ListMcpElicitations = (filter: {
  status?: McpElicitationStatus;
  serverId?: string;
  sessionId?: string;
  owner?: McpElicitationOwnerMetadata;
}) => McpElicitationRequest[];

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
          actionType: { type: "string" },
          expiresAt: { type: "string" },
        },
        required: ["approvalId", "kind", "riskLevel", "status", "preview", "tokenId", "actionType", "expiresAt"],
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
        },
        required: ["inboxItemId", "decision"],
      },
    },
    {
      serverId,
      toolName: MCP_APPROVAL_INBOX_ELICITATION_LIST_TOOL_NAME,
      description:
        "Lists MCP server-initiated elicitation requests (clarifying questions) surfaced through the approval inbox.",
      enabled: true,
      updatedAt,
      inputSchema: {
        type: "object",
        properties: {
          status: { type: "string" },
          serverId: { type: "string" },
          sessionId: { type: "string" },
        },
      },
    },
    {
      serverId,
      toolName: MCP_APPROVAL_INBOX_ELICITATION_RESPOND_TOOL_NAME,
      description:
        "Accepts, declines, or cancels an MCP server-initiated elicitation surfaced through the approval inbox.",
      enabled: true,
      updatedAt,
      inputSchema: {
        type: "object",
        properties: {
          elicitationId: { type: "string" },
          action: { type: "string" },
          content: { type: "object" },
        },
        required: ["elicitationId", "action"],
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
      connectorId: string;
      decision: "approve" | "reject" | "edit";
      editedPayload?: Record<string, unknown>;
      resolutionNote?: string;
    }) => Promise<{ approval: ApprovalRequest }>;
    respondToMcpElicitation: RespondToMcpElicitation;
    listMcpElicitations: ListMcpElicitations;
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

      // Unlike remote-action deliveries (resolve), elicitations are not addressed to a receiver
      // server — they live in one shared store and are authorized by owner scope (operator/agent/
      // session), enforced by McpElicitationService. The approval inbox is a governed operator
      // surface, so no per-caller serverId receiver check is applied here; this mirrors the HTTP
      // POST /elicitations/:id/respond route. Tenant-level scoping, when introduced, belongs in the
      // service/owner model so it applies uniformly across both surfaces.
      case MCP_APPROVAL_INBOX_ELICITATION_LIST_TOOL_NAME:
        return {
          ok: true,
          output: {
            items: deps.listMcpElicitations({
              ...parseElicitationListArgs(input.arguments),
              owner: resolveElicitationInvokeOwner(input),
            }),
          },
        };

      case MCP_APPROVAL_INBOX_ELICITATION_RESPOND_TOOL_NAME: {
        const args = parseElicitationRespondArgs(input.arguments);
        const owner = resolveElicitationInvokeOwner(input);
        if (!owner) {
          throw new ValidationError({ message: "MCP elicitation response requires caller owner scope." });
        }
        return {
          ok: true,
          output: {
            elicitation: deps.respondToMcpElicitation({
              ...args,
              owner,
            }),
          },
        };
      }

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
  approvalKind: string;
  riskLevel: ApprovalRequest["riskLevel"];
  approvalStatus: ApprovalRequest["status"];
  preview: Record<string, unknown>;
  expiresAt: string;
} {
  const approvalId = requireNonEmptyString(args?.approvalId, "approvalId");
  const tokenId = requireNonEmptyString(args?.tokenId, "tokenId");
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

function parseElicitationListArgs(args: Record<string, unknown> | undefined): {
  status?: McpElicitationStatus;
  serverId?: string;
  sessionId?: string;
} {
  return {
    status: optionalEnumValue(args?.status, MCP_ELICITATION_STATUSES),
    serverId: optionalString(args?.serverId),
    sessionId: optionalString(args?.sessionId),
  };
}

function parseElicitationRespondArgs(args: Record<string, unknown> | undefined): {
  elicitationId: string;
  action: McpElicitationResponseAction;
  content?: Record<string, unknown>;
} {
  return {
    elicitationId: requireNonEmptyString(args?.elicitationId, "elicitationId"),
    action: requireEnumValue(args?.action, MCP_ELICITATION_ACTIONS, "action"),
    content: normalizeOptionalObject(args?.content),
  };
}

function resolveElicitationInvokeOwner(input: McpInvokeRequest): McpElicitationOwnerMetadata | undefined {
  const policyContext = normalizeOptionalObject(input.policyContext);
  const owner: McpElicitationOwnerMetadata = {
    operatorId: optionalString(policyContext?.operatorId) ?? optionalString(input.consentContext?.operatorId),
    agentId: optionalString(policyContext?.agentId) ?? optionalString(input.agentId),
    workspaceId: optionalString(policyContext?.workspaceId) ?? optionalString(input.workspaceId),
    sessionId: optionalString(policyContext?.sessionId) ?? optionalString(input.sessionId),
    taskId: optionalString(policyContext?.taskId) ?? optionalString(input.taskId),
    runId: optionalString(policyContext?.runId) ?? optionalString(input.runId),
    surface: normalizePermissionSurface(policyContext?.surface ?? input.surface),
  };
  return hasElicitationOwnerScope(owner) ? owner : undefined;
}

function normalizePermissionSurface(value: unknown): McpElicitationOwnerMetadata["surface"] | undefined {
  return typeof value === "string" && ["chat", "cowork", "code", "tools", "mcp", "all"].includes(value)
    ? (value as McpElicitationOwnerMetadata["surface"])
    : undefined;
}

function hasElicitationOwnerScope(owner: McpElicitationOwnerMetadata): boolean {
  return Boolean(
    owner.operatorId ??
    owner.agentId ??
    owner.workspaceId ??
    owner.sessionId ??
    owner.taskId ??
    owner.runId ??
    owner.surface,
  );
}

async function resolveInboxItem(
  serverId: string,
  args: Record<string, unknown> | undefined,
  deps: {
    approvalInbox: ApprovalInboxPort;
    resolveApprovalWithRemoteTokenId: (input: {
      tokenId: string;
      connectorId: string;
      decision: "approve" | "reject" | "edit";
      editedPayload?: Record<string, unknown>;
      resolutionNote?: string;
    }) => Promise<{ approval: ApprovalRequest }>;
  },
): Promise<{ item: ApprovalInboxItemRecord; approval?: ApprovalRequest }> {
  checkResolveRateLimit(serverId);
  const inboxItemId = requireNonEmptyString(args?.inboxItemId, "inboxItemId");
  const decision = requireEnumValue(args?.decision, ["approve", "reject", "edit"], "decision");
  const resolvedBy = `mcp:${serverId}`;
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
      connectorId: item.connectorId,
      decision,
      editedPayload: normalizeOptionalObject(args?.editedPayload),
      resolutionNote: optionalString(args?.resolutionNote),
    });
    return {
      item: deps.approvalInbox.get(inboxItemId),
      // The inbox item intentionally retains its tokenId and already-redacted one-time
      // token marker. Only the resolved approval is projected for the remote caller.
      approval: projectMcpPublicValue(result.approval),
    };
  } catch (error) {
    if (shouldDeferInboxTerminalization(error)) {
      return {
        item: deps.approvalInbox.get(inboxItemId),
      };
    }
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

function shouldDeferInboxTerminalization(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : "";
  return message.includes("already been consumed") || message.includes("already resolved");
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
