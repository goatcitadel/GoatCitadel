import type {
  NotificationDeliveryPolicy,
  NotificationDeliveryStatus,
  NotificationLifecycleState,
  NotificationTargetKind,
} from "@goatcitadel/contracts";

/** Notification routing enums in plain words; a new contract value fails typecheck until it has a label. */
export const NOTIFICATION_TARGET_KIND_LABELS: Record<NotificationTargetKind, string> = {
  channel_connection: "Channel connection",
  https_webhook: "HTTPS webhook",
};
export const NOTIFICATION_LIFECYCLE_LABELS: Record<NotificationLifecycleState, string> = {
  active: "Active",
  disabled: "Disabled",
  archived: "Archived",
};
export const NOTIFICATION_DELIVERY_POLICY_LABELS: Record<NotificationDeliveryPolicy, string> = {
  always: "Always send",
  when_away: "Only when you are away",
};
export const NOTIFICATION_DELIVERY_STATUS_LABELS: Record<NotificationDeliveryStatus, string> = {
  pending: "Pending",
  suppressed_present: "Held because you were here",
  delivered: "Delivered",
  partially_delivered: "Partly delivered",
  failed: "Failed",
  unknown_after_send: "Outcome unknown",
};
