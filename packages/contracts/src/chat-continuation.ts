import type { ChangePlanRecord } from "./change-plan.js";
export interface ChatContinuationInput {
  workspaceId: string;
  sessionId: string;
  approvalId: string;
  sourceTurnId?: string;
  reason: "setup_complete" | "approval_expired";
}
/** A recovery review is an owner operation, never proof that an old Chat turn resumed. */
export interface PreparedChatContinuation {
  version: 1;
  continuationId: string;
  workspaceId: string;
  sessionId: string;
  sourceHash: string;
  status: "review_required" | "ready" | "blocked" | "unknown_effect";
  reason: string;
  approvalId?: string;
  plan?: ChangePlanRecord;
  nextAction?: { kind: "review_again" | "ask_again" | "inspect_owner"; label: string; href?: string };
}
