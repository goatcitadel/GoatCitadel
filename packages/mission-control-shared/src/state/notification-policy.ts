import type { DerivedRealtimeNotification } from "./realtime-derived.js";

export interface RealtimeNotificationOrigin {
  replayed: boolean;
  eventSessionId?: string;
}

export interface NotificationDeliveryContext extends RealtimeNotificationOrigin {
  visibleSessionId?: string;
  pageFocused: boolean;
}

export interface NotificationDeliveryDecision {
  toast: boolean;
  sound: boolean;
  desktop: boolean;
}

type AttentionKind = NonNullable<DerivedRealtimeNotification["attentionKind"]>;

const SILENT: NotificationDeliveryDecision = Object.freeze({ toast: false, sound: false, desktop: false });
const DECISIONS: ReadonlySet<AttentionKind> = new Set(["approval_waiting", "operator_blocked"]);
const PROBLEMS: ReadonlySet<AttentionKind> = new Set(["run_failed", "runtime_degraded"]);
const UPDATES: ReadonlySet<AttentionKind> = new Set(["run_completed", "handoff_ready"]);
const TRANSPORT_STATUS = new Set(["connection-interrupted", "connection-restored", "stream-replay-gap"]);

/** Realtime frames refresh state; only live operator attention becomes an interruption. */
export function decideNotificationDelivery(
  notification: DerivedRealtimeNotification | undefined,
  context: NotificationDeliveryContext,
): NotificationDeliveryDecision {
  if (!notification || context.replayed || TRANSPORT_STATUS.has(notification.groupKey)) {
    return SILENT;
  }
  const kind = notification.attentionKind;
  const decision = kind !== undefined && DECISIONS.has(kind);
  const problem = kind !== undefined && PROBLEMS.has(kind);
  const update = kind !== undefined && UPDATES.has(kind);
  const gatewayNotice = notification.groupKey.startsWith("ui-");
  if (!decision && !problem && !update && !gatewayNotice) {
    return SILENT;
  }
  if (context.pageFocused && context.eventSessionId && context.eventSessionId === context.visibleSessionId) {
    return SILENT;
  }
  return { toast: true, sound: decision || problem, desktop: decision && !context.pageFocused };
}
