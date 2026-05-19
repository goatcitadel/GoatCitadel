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
    const tools = createInternalMcpApprovalInboxTools("srv-1");
    expect(isInternalMcpApprovalInboxServer({ url: MCP_APPROVAL_INBOX_URL })).toBe(true);
    expect(tools.map((tool) => tool.toolName)).toEqual([
      MCP_APPROVAL_DELIVERY_TOOL_NAME,
      MCP_APPROVAL_INBOX_LIST_TOOL_NAME,
      MCP_APPROVAL_INBOX_RESOLVE_TOOL_NAME,
    ]);
    expect(
      tools.find((tool) => tool.toolName === MCP_APPROVAL_INBOX_RESOLVE_TOOL_NAME)?.inputSchema.properties,
    ).not.toHaveProperty("resolvedBy");
  });

  it("receives, lists, and returns pending inbox state until follow-up effects finalize it", async () => {
    const approvalInbox = createRepo();
    const resolveApprovalWithRemoteTokenId = vi.fn(async () => ({
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
        resolveApprovalWithRemoteTokenId,
      },
    );

    expect(receive.ok).toBe(true);
    expect(receive.output?.item).toMatchObject({
      tokenId: "tok-1",
      token: "redacted:tok-1",
    });
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
        resolveApprovalWithRemoteTokenId,
      },
    );

    expect(listed.ok).toBe(true);
    expect(listed.output?.items as Array<{ inboxItemId: string }>).toHaveLength(1);

    const resolved = await handleInternalMcpApprovalInboxInvoke(
      server,
      {
        serverId: server.serverId,
        toolName: MCP_APPROVAL_INBOX_RESOLVE_TOOL_NAME,
        arguments: {
          inboxItemId: item.inboxItemId,
          decision: "approve",
        },
      },
      {
        approvalInbox,
        resolveApprovalWithRemoteTokenId,
      },
    );

    expect(resolveApprovalWithRemoteTokenId).toHaveBeenCalledWith({
      tokenId: "tok-1",
      decision: "approve",
      editedPayload: undefined,
      resolutionNote: undefined,
    });
    expect(resolved.ok).toBe(true);
    expect(resolved.output?.item).toMatchObject({
      state: "pending",
    });
    expect(resolved.output?.approval).toMatchObject({
      approvalId: "apr-1",
      status: "approved",
    });
  });

  it("returns the winning terminal state when a second resolver loses the race", async () => {
    let resolved = false;
    const approvalInbox = {
      receiveMcpApprovalDelivery() {
        return {
          inboxItemId: "inbox-1",
          approvalId: "apr-1",
          connectorId: "mcp:srv-1",
          receiverKind: "mcp" as const,
          receiverId: "srv-1",
          tokenId: "tok-1",
          token: "redacted:tok-1",
          actionType: "approval.resolve" as const,
          state: "pending" as const,
          approvalKind: "tool.invoke",
          riskLevel: "danger" as const,
          approvalStatus: "pending" as const,
          preview: { summary: "Approve deploy" },
          createdAt: "2026-03-21T12:00:00.000Z",
          updatedAt: "2026-03-21T12:00:00.000Z",
          expiresAt: "2026-03-21T12:30:00.000Z",
          deliveryCount: 1,
          lastDeliveredAt: "2026-03-21T12:00:00.000Z",
        };
      },
      get() {
        return {
          inboxItemId: "inbox-1",
          approvalId: "apr-1",
          connectorId: "mcp:srv-1",
          receiverKind: "mcp" as const,
          receiverId: "srv-1",
          tokenId: "tok-1",
          token: "redacted:tok-1",
          actionType: "approval.resolve" as const,
          state: "pending" as const,
          approvalKind: "tool.invoke",
          riskLevel: "danger" as const,
          approvalStatus: "pending" as const,
          preview: { summary: "Approve deploy" },
          createdAt: "2026-03-21T12:00:00.000Z",
          updatedAt: "2026-03-21T12:00:00.000Z",
          expiresAt: "2026-03-21T12:30:00.000Z",
          deliveryCount: 1,
          lastDeliveredAt: "2026-03-21T12:00:00.000Z",
        };
      },
      listByReceiver() {
        return [];
      },
      markResolved(
        _inboxItemId: string,
        input: {
          state: Extract<ApprovalInboxItemState, "approved" | "rejected" | "edited" | "expired" | "failed">;
          approvalStatus: ApprovalRequest["status"];
          resolvedAt?: string;
          resolvedBy?: string;
          lastError?: string;
        },
      ) {
        if (!resolved && input.state === "approved") {
          resolved = true;
          return {
            inboxItemId: "inbox-1",
            approvalId: "apr-1",
            connectorId: "mcp:srv-1",
            receiverKind: "mcp" as const,
            receiverId: "srv-1",
            tokenId: "tok-1",
            token: "redacted:tok-1",
            actionType: "approval.resolve" as const,
            state: "approved" as const,
            approvalKind: "tool.invoke",
            riskLevel: "danger" as const,
            approvalStatus: "approved" as const,
            preview: { summary: "Approve deploy" },
            createdAt: "2026-03-21T12:00:00.000Z",
            updatedAt: "2026-03-21T12:05:00.000Z",
            resolvedAt: "2026-03-21T12:05:00.000Z",
            resolvedBy: "mcp:srv-1",
            expiresAt: "2026-03-21T12:30:00.000Z",
            deliveryCount: 1,
            lastDeliveredAt: "2026-03-21T12:00:00.000Z",
          };
        }
        return {
          inboxItemId: "inbox-1",
          approvalId: "apr-1",
          connectorId: "mcp:srv-1",
          receiverKind: "mcp" as const,
          receiverId: "srv-1",
          tokenId: "tok-1",
          token: "redacted:tok-1",
          actionType: "approval.resolve" as const,
          state: "approved" as const,
          approvalKind: "tool.invoke" as const,
          riskLevel: "danger" as const,
          approvalStatus: "approved" as const,
          preview: { summary: "Approve deploy" },
          createdAt: "2026-03-21T12:00:00.000Z",
          updatedAt: "2026-03-21T12:05:00.000Z",
          resolvedAt: "2026-03-21T12:05:00.000Z",
          resolvedBy: "mcp:srv-1",
          expiresAt: "2026-03-21T12:30:00.000Z",
          deliveryCount: 1,
          lastDeliveredAt: "2026-03-21T12:00:00.000Z",
        };
      },
    };
    const resolveApprovalWithRemoteTokenId = vi
      .fn()
      .mockResolvedValueOnce({
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
      })
      .mockRejectedValueOnce(new Error("token already consumed"));
    const server = createServer();

    const first = await handleInternalMcpApprovalInboxInvoke(
      server,
      {
        serverId: server.serverId,
        toolName: MCP_APPROVAL_INBOX_RESOLVE_TOOL_NAME,
        arguments: {
          inboxItemId: "inbox-1",
          decision: "approve",
        },
      },
      {
        approvalInbox,
        resolveApprovalWithRemoteTokenId,
      },
    );
    const second = await handleInternalMcpApprovalInboxInvoke(
      server,
      {
        serverId: server.serverId,
        toolName: MCP_APPROVAL_INBOX_RESOLVE_TOOL_NAME,
        arguments: {
          inboxItemId: "inbox-1",
          decision: "approve",
        },
      },
      {
        approvalInbox,
        resolveApprovalWithRemoteTokenId,
      },
    );

    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect(first.output?.item).toMatchObject({ state: "pending" });
    expect(first.output?.approval).toMatchObject({ approvalId: "apr-1", status: "approved" });
    expect(second.output?.item).toMatchObject({ state: "approved" });
  });

  it("does not mark the inbox item failed when the token was already consumed by a winning resolver", async () => {
    const approvalInbox = createRepo();
    approvalInbox.receiveMcpApprovalDelivery({
      connectorId: "mcp:srv-1",
      receiverId: "srv-1",
      approvalId: "apr-1",
      tokenId: "tok-1",
      token: "grat_tok_1",
      approvalKind: "tool.invoke",
      riskLevel: "danger",
      approvalStatus: "pending",
      preview: { summary: "Approve deploy" },
      expiresAt: "2026-03-21T12:30:00.000Z",
    });
    const server = createServer();

    const resolved = await handleInternalMcpApprovalInboxInvoke(
      server,
      {
        serverId: server.serverId,
        toolName: MCP_APPROVAL_INBOX_RESOLVE_TOOL_NAME,
        arguments: {
          inboxItemId: "inbox-1",
          decision: "approve",
        },
      },
      {
        approvalInbox,
        resolveApprovalWithRemoteTokenId: vi
          .fn()
          .mockRejectedValue(new Error("Remote action token has already been consumed.")),
      },
    );

    expect(resolved.ok).toBe(true);
    expect(resolved.output?.item).toMatchObject({ state: "pending" });
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
        const existing = [...items.values()].find(
          (item) => item.receiverId === input.receiverId && item.tokenId === input.tokenId,
        );
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
          token: `redacted:${input.tokenId}`,
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
        return [...items.values()].filter(
          (item) => item.receiverId === receiverId && (!input?.state || item.state === input.state),
        );
      },
      markResolved(
        inboxItemId: string,
        input: {
          state: Extract<ApprovalInboxItemState, "approved" | "rejected" | "edited" | "expired" | "failed">;
          approvalStatus: ApprovalRequest["status"];
          resolvedAt?: string;
          resolvedBy?: string;
          lastError?: string;
        },
      ) {
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
