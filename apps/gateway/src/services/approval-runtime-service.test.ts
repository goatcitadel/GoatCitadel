import { beforeEach, describe, expect, it, vi } from "vitest";

const lifecycle = vi.hoisted(() => ({
  createApproval: vi.fn(),
  createApprovalRemoteActionToken: vi.fn(),
  createToolGrant: vi.fn(),
  getApprovalReplay: vi.fn(),
  listApprovals: vi.fn(),
  listToolGrants: vi.fn(),
  resolveApproval: vi.fn(),
  resolveApprovalsBulk: vi.fn(),
  resolveApprovalWithRemoteToken: vi.fn(),
  resolveApprovalWithRemoteTokenId: vi.fn(),
  resolveChatToolApproval: vi.fn(),
  revokeToolGrant: vi.fn(),
}));

vi.mock("./approval-lifecycle-service.js", () => lifecycle);

import { ApprovalRuntimeService } from "./approval-runtime-service.js";

describe("ApprovalRuntimeService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    lifecycle.listToolGrants.mockReturnValue([{ grantId: "grant-1" }]);
    lifecycle.createToolGrant.mockReturnValue({ grantId: "grant-2" });
    lifecycle.revokeToolGrant.mockReturnValue(true);
    lifecycle.createApproval.mockResolvedValue({ approvalId: "approval-1" });
    lifecycle.createApprovalRemoteActionToken.mockReturnValue({ tokenId: "token-id", token: "token" });
    lifecycle.resolveApprovalWithRemoteToken.mockResolvedValue({ approval: { approvalId: "approval-1" } });
    lifecycle.resolveApprovalWithRemoteTokenId.mockResolvedValue({ approval: { approvalId: "approval-1" } });
    lifecycle.listApprovals.mockReturnValue([{ approvalId: "approval-1" }]);
    lifecycle.resolveApprovalsBulk.mockResolvedValue({ resolved: 1, failed: [] });
    lifecycle.getApprovalReplay.mockReturnValue({ approval: { approvalId: "approval-1" }, events: [] });
    lifecycle.resolveApproval.mockResolvedValue({ approval: { approvalId: "approval-1", status: "approved" } });
    lifecycle.resolveChatToolApproval.mockResolvedValue({
      allowScope: "session",
      resumed: true,
      resumedTurnId: "turn-1",
    });
  });

  it("forwards approval and grant calls to the lifecycle host with default limits", async () => {
    const host = { storage: {} };
    const service = new ApprovalRuntimeService(host as never);

    expect(service.listToolGrants()).toEqual([{ grantId: "grant-1" }]);
    expect(service.createToolGrant({ toolPattern: "session.*", decision: "allow", scope: "global" } as never)).toEqual({
      grantId: "grant-2",
    });
    expect(service.revokeToolGrant("grant-1")).toBe(true);
    await expect(service.createApproval({ reason: "Needs review" } as never)).resolves.toEqual({
      approvalId: "approval-1",
    });
    expect(service.createApprovalRemoteActionToken("approval-1", { connectorId: "integration:conn-1" })).toEqual({
      tokenId: "token-id",
      token: "token",
    });
    await expect(service.resolveApprovalWithRemoteToken({ token: "token", decision: "approve" })).resolves.toEqual({
      approval: { approvalId: "approval-1" },
    });
    await expect(
      service.resolveApprovalWithRemoteTokenId({ tokenId: "token-id", decision: "reject" }),
    ).resolves.toEqual({
      approval: { approvalId: "approval-1" },
    });
    expect(service.listApprovals()).toEqual([{ approvalId: "approval-1" }]);
    await expect(
      service.resolveApprovalsBulk({ approvalIds: ["approval-1"], decision: "approve" } as never),
    ).resolves.toEqual({
      resolved: 1,
      failed: [],
    });
    expect(service.getApprovalReplay("approval-1")).toEqual({ approval: { approvalId: "approval-1" }, events: [] });
    await expect(service.resolveApproval("approval-1", { decision: "approve" } as never)).resolves.toEqual({
      approval: { approvalId: "approval-1", status: "approved" },
    });
    await expect(
      service.resolveChatToolApproval("session-1", "approval-1", "approve", { allowScope: "session" }),
    ).resolves.toEqual({
      allowScope: "session",
      resumed: true,
      resumedTurnId: "turn-1",
    });

    expect(lifecycle.listToolGrants).toHaveBeenCalledWith(host, undefined, undefined, 200);
    expect(lifecycle.listApprovals).toHaveBeenCalledWith(host, undefined, 100);
    expect(lifecycle.getApprovalReplay).toHaveBeenCalledWith(host, "approval-1", "operator");
  });

  it("preserves explicit approval filters, replay actors, and chat approval options", async () => {
    const host = { storage: {} };
    const service = new ApprovalRuntimeService(host as never);

    service.listToolGrants("session", "session-1", 5);
    service.listApprovals("pending" as never, 7);
    service.getApprovalReplay("approval-2", "auditor");
    await service.resolveChatToolApproval("session-2", "approval-2", "reject");

    expect(lifecycle.listToolGrants).toHaveBeenCalledWith(host, "session", "session-1", 5);
    expect(lifecycle.listApprovals).toHaveBeenCalledWith(host, "pending", 7);
    expect(lifecycle.getApprovalReplay).toHaveBeenCalledWith(host, "approval-2", "auditor");
    expect(lifecycle.resolveChatToolApproval).toHaveBeenCalledWith(
      host,
      "session-2",
      "approval-2",
      "reject",
      undefined,
    );
  });
});
