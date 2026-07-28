export const CHAT_TIMER_MIN_DELAY_MS = 5_000;
export const CHAT_TIMER_MAX_HORIZON_MS = 365 * 24 * 60 * 60 * 1_000;
export const CHAT_TIMER_MAX_ACTIVE_PER_SESSION = 25;
export const CHAT_TIMER_MAX_ACTIVE_PER_WORKSPACE = 100;

export type ChatTimerStatus = "active" | "claimed" | "fired" | "cancelled" | "failed";
export type ChatTimerDeliveryStatus =
  | "pending"
  | "delivered"
  | "suppressed_present"
  | "partially_delivered"
  | "failed"
  | "unknown_after_send"
  | "no_targets";

export interface ChatTimerRecord {
  timerId: string;
  workspaceId: string;
  sessionId: string;
  revision: number;
  dueAt: string;
  timezone: string;
  message: string;
  notificationRuleId?: string;
  cancelOnNextReply: boolean;
  status: ChatTimerStatus;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  claimedBy?: string;
  claimExpiresAt?: string;
  noticeMessageId?: string;
  notificationEventId?: string;
  notificationDeliveryStatus?: ChatTimerDeliveryStatus;
  firedAt?: string;
  cancelledAt?: string;
  cancelledByMessageId?: string;
  failure?: string;
}

export interface CreateChatTimerInput {
  dueAt: string;
  timezone: string;
  message: string;
  notificationRuleId?: string;
  cancelOnNextReply?: boolean;
}

export interface ChatTimerListResponse {
  items: ChatTimerRecord[];
}

export interface ChatTimerMutationResponse {
  item: ChatTimerRecord;
}
