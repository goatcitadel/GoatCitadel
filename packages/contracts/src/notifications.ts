export const NOTIFICATION_EVENT_TYPES = [
  "turn.completed",
  "turn.failed",
  "turn.blocked",
  "approval.requested",
  "user_input.requested",
  "durable.attention_required",
  "timer.due",
  "scheduled_turn.completed",
  "scheduled_turn.failed",
] as const;

export type NotificationEventType = (typeof NOTIFICATION_EVENT_TYPES)[number];
export type NotificationTargetKind = "channel_connection" | "https_webhook";
export type NotificationLifecycleState = "active" | "disabled" | "archived";
export type NotificationDeliveryPolicy = "always" | "when_away";
export type NotificationDeliveryStatus =
  | "pending"
  | "suppressed_present"
  | "delivered"
  | "partially_delivered"
  | "failed"
  | "unknown_after_send";

export interface NotificationTarget {
  targetId: string;
  workspaceId: string;
  revision: number;
  label: string;
  kind: NotificationTargetKind;
  channelConnectionId?: string;
  webhookUrlSecretRef?: string;
  credentialSecretRef?: string;
  lifecycleState: NotificationLifecycleState;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationTargetInput {
  label: string;
  kind: NotificationTargetKind;
  channelConnectionId?: string;
  webhookUrlSecretRef?: string;
  credentialSecretRef?: string;
  lifecycleState?: NotificationLifecycleState;
}

export interface NotificationRule {
  ruleId: string;
  workspaceId: string;
  revision: number;
  label: string;
  eventTypes: NotificationEventType[];
  targetIds: string[];
  deliveryPolicy: NotificationDeliveryPolicy;
  lifecycleState: NotificationLifecycleState;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationRuleInput {
  label: string;
  eventTypes: NotificationEventType[];
  targetIds: string[];
  deliveryPolicy?: NotificationDeliveryPolicy;
  lifecycleState?: NotificationLifecycleState;
}

export interface NotificationClientPresenceLease {
  leaseId: string;
  workspaceId: string;
  clientId: string;
  sessionId?: string;
  focused: boolean;
  visible: boolean;
  expiresAt: string;
  updatedAt: string;
}

export interface NotificationEventRecord {
  eventId: string;
  workspaceId: string;
  eventType: NotificationEventType;
  sessionId?: string;
  turnId?: string;
  title: string;
  message: string;
  source: string;
  createdAt: string;
}

export interface NotificationDeliveryRecord {
  deliveryId: string;
  eventId: string;
  ruleId: string;
  targetId: string;
  workspaceId: string;
  idempotencyKey: string;
  status: NotificationDeliveryStatus;
  attemptCount: number;
  lastError?: string;
  externalSideEffectRunId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationDispatchResult {
  event: NotificationEventRecord;
  deliveries: NotificationDeliveryRecord[];
  status: NotificationDeliveryStatus | "no_targets";
}

export interface NotifyRequest {
  eventType: NotificationEventType;
  sessionId?: string;
  turnId?: string;
  title: string;
  message: string;
  targetIds?: string[];
}
