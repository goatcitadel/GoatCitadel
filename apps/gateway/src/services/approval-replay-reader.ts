import type { ApprovalEffectRecord, ApprovalRequest } from "@goatcitadel/contracts";
import type { Storage } from "@goatcitadel/storage";
import type { ApprovalReplayResult } from "./approval-types.js";

type ApprovalReplayStorage = Pick<Storage, "approvalEffects" | "approvalEvents" | "pendingApprovalActions">;

/** Reads the cross-repository snapshot returned by approval resolution APIs. */
export function readApprovalReplay(
  storage: ApprovalReplayStorage,
  approval: ApprovalRequest,
  effects?: ApprovalEffectRecord[],
): ApprovalReplayResult {
  return {
    approval,
    events: storage.approvalEvents.listByApprovalId(approval.approvalId),
    pendingAction: storage.pendingApprovalActions.find(approval.approvalId),
    effects: effects ?? storage.approvalEffects.listByApproval(approval.approvalId),
  };
}
