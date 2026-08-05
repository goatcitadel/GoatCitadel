import type { ApprovalEffectRecord, ApprovalRequest } from "@goatcitadel/contracts";
import type { AsyncStorage as Storage } from "@goatcitadel/storage";
import type { ApprovalReplayResult } from "./approval-types.js";

type ApprovalReplayStorage = Pick<Storage, "approvalEffects" | "approvalEvents" | "pendingApprovalActions">;

/** Reads the cross-repository snapshot returned by approval resolution APIs. */
export async function readApprovalReplay(
  storage: ApprovalReplayStorage,
  approval: ApprovalRequest,
  effects?: ApprovalEffectRecord[],
): Promise<ApprovalReplayResult> {
  return {
    approval,
    events: await storage.approvalEvents.listByApprovalId(approval.approvalId),
    pendingAction: await storage.pendingApprovalActions.find(approval.approvalId),
    effects: effects ?? (await storage.approvalEffects.listByApproval(approval.approvalId)),
  };
}
