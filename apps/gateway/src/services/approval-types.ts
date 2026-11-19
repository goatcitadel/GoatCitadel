import type {
  ApprovalEffectRecord,
  ApprovalReplayEvent,
  ApprovalRequest,
  ApprovalNativeRuntimeReview,
  ChatToolGrantDuration,
  PendingApprovalAction,
  RemoteActionTokenRecord,
} from "@goatcitadel/contracts";
import type { ApprovalResolutionEffectsResult } from "./approval-resolution-effects-service.js";

export interface ApprovalResolveResult {
  approval: ApprovalRequest;
  effects: ApprovalEffectRecord[];
  replay: ApprovalReplayResult;
  durableRunId?: string;
  resolutionEffects?: ApprovalResolutionEffectsResult;
}

export interface ApprovalResolutionContext {
  remoteToken?: {
    tokenId: string;
    connectorId: string;
  };
  /** Server-owned work committed with the winning approval, before its wake is queued. */
  commitChatReadAllowance?: () => Promise<ChatReadAllowanceReceipt>;
}

export type ChatReadAllowanceReceipt =
  | { duration: ChatToolGrantDuration; status: "granted"; expiresAt: string }
  | { duration: ChatToolGrantDuration; status: "failed" };

export interface ApprovalReplayResult {
  approval: ApprovalRequest;
  events: ApprovalReplayEvent[];
  pendingAction?: PendingApprovalAction;
  durableRunId?: string;
  effects: ApprovalEffectRecord[];
  nativeRuntimeReview?: ApprovalNativeRuntimeReview;
}

export interface RemoteApprovalActionTokenIssueResult extends RemoteActionTokenRecord {
  approvalId: string;
  token: string;
  deliveryStatus?: "queued" | "not_configured" | "failed";
  deliveryRunId?: string;
  deliveryError?: string;
}
