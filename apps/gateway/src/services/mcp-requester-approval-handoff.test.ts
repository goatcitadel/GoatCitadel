import { describe, expect, it, vi } from "vitest";
import { ApprovalEffectsService } from "./approval-resolution-effects-service.js";
import { RequesterMcpApprovalResumeRequiredError } from "./mcp-requester-admission-approval.js";
import type { ApprovalEffectRecord } from "@goatcitadel/contracts";

describe("requester MCP approval handoff", () => {
  it("settles only the execution handoff and lets the existing linked Chat wake resume the owner", async () => {
    const pending = { actionType: "tool.invoke", resolutionStatus: "pending" };
    const action = {
      effectId: "action",
      approvalId: "approval",
      effectKind: "pending_action_execute",
      targetKind: "pending_action",
      targetId: "approval",
      status: "running",
      version: 1,
      payload: {},
    } as ApprovalEffectRecord;
    const skipEffect = vi.fn(async () => {
      action.status = "skipped";
      return true;
    });
    const execute = vi.fn(async () => {
      throw new RequesterMcpApprovalResumeRequiredError();
    });
    const storage = {
      pendingApprovalActions: { find: vi.fn(async () => pending) },
      approvalEffects: { skipEffect, listByApproval: vi.fn(async () => [action]) },
    };
    const processor = new ApprovalEffectsService(
      { storage } as never,
      { executeApprovedPendingAction: execute } as never,
    ) as unknown as {
      handlePendingActionExecute(effect: ApprovalEffectRecord): Promise<void>;
      deferLinkedChatTurnWakeUntilApprovedActionSettles(effect: ApprovalEffectRecord): Promise<boolean>;
    };
    await processor.handlePendingActionExecute(action);
    expect(skipEffect).toHaveBeenCalledWith("action", expect.any(String), 1, {
      result: {
        reason: "requester_mcp_resume_required",
        actionType: "tool.invoke",
        resolutionStatus: "pending",
      },
    });
    expect(pending.resolutionStatus).toBe("pending");
    expect(
      await processor.deferLinkedChatTurnWakeUntilApprovedActionSettles({
        ...action,
        effectId: "wake",
        effectKind: "linked_chat_turn_wake",
      } as ApprovalEffectRecord),
    ).toBe(false);
    expect(execute).toHaveBeenCalledOnce();
  });
});
