import { describe, expect, it, vi } from "vitest";

vi.mock("node:sqlite", () => ({
  DatabaseSync: class DatabaseSync {},
  StatementSync: class StatementSync {},
}));

vi.mock("./approval-remote-token-service.js", () => ({
  consumeRemoteActionToken: vi.fn(async () => ({ tokenId: "token-consumed", state: "consumed" })),
  consumeRemoteActionTokenById: vi.fn(async () => ({ tokenId: "token-by-id-consumed", state: "consumed" })),
}));

import { GatewayService } from "./gateway-service.js";
import * as approvalRemoteTokenService from "./approval-remote-token-service.js";
import { RemoteWorkerApprovalResumeRequiredError } from "./remote-worker-approved-action-guard.js";

function createGatewayFacadeHarness(): GatewayService {
  return Object.create(GatewayService.prototype) as GatewayService;
}

describe("GatewayService approvals facade delegation", () => {
  it("preserves a worker-owned pending request when the ordinary executor cannot resume it", async () => {
    const gateway = createGatewayFacadeHarness() as unknown as {
      executeApprovedPendingAction(approvalId: string): Promise<unknown>;
      refreshApprovedPendingToolPolicyContext: ReturnType<typeof vi.fn>;
      storage: { runImmediateTransaction: ReturnType<typeof vi.fn> };
      policyEngine: { executeApprovedAction: ReturnType<typeof vi.fn> };
    };
    const error = new RemoteWorkerApprovalResumeRequiredError();
    gateway.refreshApprovedPendingToolPolicyContext = vi.fn().mockRejectedValue(error);
    gateway.storage = { runImmediateTransaction: vi.fn() };
    gateway.policyEngine = { executeApprovedAction: vi.fn() };

    await expect(gateway.executeApprovedPendingAction("remote-approval")).rejects.toBe(error);
    expect(gateway.storage.runImmediateTransaction).not.toHaveBeenCalled();
    expect(gateway.policyEngine.executeApprovedAction).not.toHaveBeenCalled();
  });

  it("still records ordinary policy refresh failures and never dispatches the tool", async () => {
    const gateway = createGatewayFacadeHarness() as unknown as {
      executeApprovedPendingAction(approvalId: string): Promise<unknown>;
      refreshApprovedPendingToolPolicyContext: ReturnType<typeof vi.fn>;
      storage: {
        runImmediateTransaction<T>(work: () => Promise<T>): Promise<T>;
        pendingApprovalActions: { markResolved: ReturnType<typeof vi.fn> };
        approvalEvents: { append: ReturnType<typeof vi.fn> };
      };
      policyEngine: { executeApprovedAction: ReturnType<typeof vi.fn> };
    };
    gateway.refreshApprovedPendingToolPolicyContext = vi.fn().mockRejectedValue(new Error("policy unavailable"));
    gateway.storage = {
      runImmediateTransaction: async (work) => await work(),
      pendingApprovalActions: { markResolved: vi.fn() },
      approvalEvents: { append: vi.fn() },
    };
    gateway.policyEngine = { executeApprovedAction: vi.fn() };

    await expect(gateway.executeApprovedPendingAction("local-approval")).resolves.toBeUndefined();
    expect(gateway.storage.pendingApprovalActions.markResolved).toHaveBeenCalledWith(
      "local-approval", "failed", { reason: "policy unavailable" },
    );
    expect(gateway.storage.approvalEvents.append).toHaveBeenCalledOnce();
    expect(gateway.policyEngine.executeApprovedAction).not.toHaveBeenCalled();
  });

  it("forwards consumeRemoteActionToken to the extracted remote-token service", async () => {
    const gateway = createGatewayFacadeHarness();

    await expect(
      GatewayService.prototype.consumeRemoteActionToken.call(gateway, "raw-token", "approval.resolve"),
    ).resolves.toEqual({ tokenId: "token-consumed", state: "consumed" });

    expect(approvalRemoteTokenService.consumeRemoteActionToken).toHaveBeenCalledWith(
      gateway,
      "raw-token",
      "approval.resolve",
    );
  });

  it("forwards consumeRemoteActionTokenById to the extracted remote-token service", async () => {
    const gateway = createGatewayFacadeHarness();

    await expect(
      GatewayService.prototype.consumeRemoteActionTokenById.call(gateway, "token-1", "approval.resolve"),
    ).resolves.toEqual({ tokenId: "token-by-id-consumed", state: "consumed" });

    expect(approvalRemoteTokenService.consumeRemoteActionTokenById).toHaveBeenCalledWith(
      gateway,
      "token-1",
      "approval.resolve",
    );
  });
});
