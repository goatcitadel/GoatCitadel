import type {
  ApprovalEffectRecord,
  ApprovalReplayEvent,
  ApprovalRequest,
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

export interface ApprovalReplayResult {
  approval: ApprovalRequest;
  events: ApprovalReplayEvent[];
  pendingAction?: PendingApprovalAction;
  durableRunId?: string;
  effects: ApprovalEffectRecord[];
}

export interface RemoteApprovalActionTokenIssueResult extends RemoteActionTokenRecord {
  approvalId: string;
  token: string;
}
