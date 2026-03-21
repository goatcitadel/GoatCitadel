import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApprovalInboxItemRecord, ApprovalInboxItemState, ApprovalRequest } from "@goatcitadel/contracts";
import {
  MCP_APPROVAL_DELIVERY_TOOL_NAME,
  MCP_APPROVAL_INBOX_LIST_TOOL_NAME,
  MCP_APPROVAL_INBOX_RESOLVE_TOOL_NAME,
  MCP_APPROVAL_INBOX_URL,
  createInternalMcpApprovalInboxTools,
  handleInternalMcpApprovalInboxInvoke,
  isInternalMcpApprovalInboxServer,
} from "./mcp-approval-inbox.js";

describe("mcp approval inbox", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("recognizes the internal approval inbox server and exposes its tools", () => {
    expect(isInternalMcpApprovalInboxServer({ url: MCP_APPROVAL_INBOX_URL })).toBe(true);
    expect(createInternalMcpApprovalInboxTools("srv-1").map((tool) => tool.toolName)).toEqual([
      MCP_APPROVAL_DELIVERY_TOOL_NAME,
      MCP_APPROVAL_INBOX_LIST_TOOL_NAME,
      MCP_APPROVAL_INBOX_RESOLVE_TOOL_NAME,
    ]);
  });

  it("receives, lists, and resolves approval inbox items end to end", async () => {
    const approvalInbox = createRepo();
    const resolveApprovalWithRemoteToken = vi.fn(async () => ({
      approval: {
        approvalId: "apr-1",
        kind: "tool.invoke",
        riskLevel: "danger" as const,
        status: "approved" as const,
        payload: {},
        preview: { summary: "Approve deploy" },
        createdAt: "2026-03-21T12:00:00.000Z",
        resolvedAt: "2026-03-21T12:05:00.000Z",
        resolvedBy: "connector:mcp:srv-1",
        explanationStatus: "not_requested" as const,
      },
    }));
    const server = createServer();

    const receive = await handleInternalMcpApprovalInboxInvoke(
      server,
      {
        serverId: server.serverId,
        toolName: MCP_APPROVAL_DELIVERY_TOOL_NAME,
        arguments: {
          approvalId: "apr-1",
          kind: "tool.invoke",
          riskLevel: "danger",
          status: "pending",
          preview: { summary: "Approve deploy" },
          tokenId: "tok-1",
          token: "grat_tok_1",
          actionType: "approval.resolve",
          expiresAt: "2026-03-21T12:30:00.000Z",
        },
      },
      {
        approvalInbox,
        resolveApprovalWithRemoteToken,
      },
    );

    expect(receive.ok).toBe(true);
    const item = receive.output?.item as { inboxItemId: string };

    const listed = await handleInternalMcpApprovalInboxInvoke(
      server,
      {
        serverId: server.serverId,
        toolName: MCP_APPROVAL_INBOX_LIST_TOOL_NAME,
        arguments: {
          state: "pending",
        },
      },
      {
        approvalInbox,
        resolveApprovalWithRemoteToken,
      },
    );

    expect(listed.ok).toBe(true);
    expect((listed.output?.items as Array<{ inboxItemId: string }>)).toHaveLength(1);

    const resolved = await handleInternalMcpApprovalInboxInvoke(
      server,
      {
        serverId: server.serverId,
        toolName: MCP_APPROVAL_INBOX_RESOLVE_TOOL_NAME,
        arguments: {
          inboxItemId: item.inboxItemId,
          decision: "approve",
          resolvedBy: "operator:mcp",
        },
      },
      {
        approvalInbox,
        resolveApprovalWithRemoteToken,
      },
    );

    expect(resolveApprovalWithRemoteToken).toHaveBeenCalledWith({
      token: "grat_tok_1",
      decision: "approve",
      editedPayload: undefined,
      resolutionNote: undefined,
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.output?.item).toMatchObject({
      state: "approved",
      resolvedBy: "operator:mcp",
    });
    expect(resolved.output?.approval).toMatchObject({
      approvalId: "apr-1",
      status: "approved",
    });
  });

  function createRepo() {
    const items = new Map<string, ApprovalInboxItemRecord>();
    return {
      receiveMcpApprovalDelivery(input: {
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
      }) {
        const existing = [...items.values()].find((item) => item.receiverId === input.receiverId && item.tokenId === input.tokenId);
        if (existing) {
          const updated: ApprovalInboxItemRecord = {
            ...existing,
            approvalStatus: input.approvalStatus,
            preview: input.preview,
            expiresAt: input.expiresAt,
            updatedAt: "2026-03-21T12:00:00.000Z",
            deliveryCount: existing.deliveryCount + 1,
            lastDeliveredAt: "2026-03-21T12:00:00.000Z",
            lastError: undefined,
          };
          items.set(updated.inboxItemId, updated);
          return updated;
        }
        const created: ApprovalInboxItemRecord = {
          inboxItemId: "inbox-1",
          approvalId: input.approvalId,
          connectorId: input.connectorId,
          receiverKind: "mcp",
          receiverId: input.receiverId,
          tokenId: input.tokenId,
          token: input.token,
          actionType: "approval.resolve",
          state: "pending",
          approvalKind: input.approvalKind,
          riskLevel: input.riskLevel,
          approvalStatus: input.approvalStatus,
          preview: input.preview,
          createdAt: "2026-03-21T12:00:00.000Z",
          updatedAt: "2026-03-21T12:00:00.000Z",
          expiresAt: input.expiresAt,
          deliveryCount: 1,
          lastDeliveredAt: "2026-03-21T12:00:00.000Z",
        };
        items.set(created.inboxItemId, created);
        return created;
      },
      get(inboxItemId: string) {
        const item = items.get(inboxItemId);
        if (!item) {
          throw new Error(`Missing inbox item ${inboxItemId}`);
        }
        return item;
      },
      listByReceiver(_receiverKind: "mcp", receiverId: string, input?: { state?: ApprovalInboxItemState }) {
        return [...items.values()].filter((item) => item.receiverId === receiverId && (!input?.state || item.state === input.state));
      },
      markResolved(inboxItemId: string, input: {
        state: Extract<ApprovalInboxItemState, "approved" | "rejected" | "edited" | "expired" | "failed">;
        approvalStatus: ApprovalRequest["status"];
        resolvedAt?: string;
        resolvedBy?: string;
        lastError?: string;
      }) {
        const item = items.get(inboxItemId);
        if (!item) {
          throw new Error(`Missing inbox item ${inboxItemId}`);
        }
        const updated: ApprovalInboxItemRecord = {
          ...item,
          state: input.state,
          approvalStatus: input.approvalStatus,
          updatedAt: input.resolvedAt ?? "2026-03-21T12:05:00.000Z",
          resolvedAt: input.resolvedAt,
          resolvedBy: input.resolvedBy,
          lastError: input.lastError,
        };
        items.set(inboxItemId, updated);
        return updated;
      },
    };
  }

  function createServer() {
    return {
      serverId: "srv-1",
      label: "Approval Inbox",
      transport: "http" as const,
      url: MCP_APPROVAL_INBOX_URL,
      authType: "none" as const,
      enabled: true,
      status: "connected" as const,
      category: "orchestration" as const,
      trustTier: "trusted" as const,
      costTier: "free" as const,
      policy: {
        requireFirstToolApproval: false,
        redactionMode: "basic" as const,
        allowedToolPatterns: [],
        blockedToolPatterns: [],
      },
      createdAt: "2026-03-21T12:00:00.000Z",
      updatedAt: "2026-03-21T12:00:00.000Z",
    };
  }
});
