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
  /** Omitted uses matching rules. Null delivers only in Chat. */
  notificationRuleId?: string | null;
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

export function describeChatTimerStatus(timer: ChatTimerRecord): string {
  if (timer.status !== "fired") {
    return { active: "Saved", claimed: "Posting in Chat", cancelled: "Cancelled", failed: "Reminder failed" }[
      timer.status
    ];
  }
  const delivery = timer.notificationDeliveryStatus;
  if (timer.notificationRuleId === null) return "Fired in this Chat";
  const status = {
    delivered: "notification delivered",
    failed: "notification delivery failed",
    partially_delivered: "some notifications failed",
    unknown_after_send: "notification delivery unknown",
    pending: "notification pending",
    suppressed_present: "notification skipped while you were here",
    no_targets: "no notification destinations",
  } as const;
  return `Fired in this Chat · ${delivery ? status[delivery] : "notification delivery unknown"}`;
}

export interface CreateChatTimerInput {
  dueAt: string;
  timezone: string;
  message: string;
  /** Omitted uses matching rules. Null delivers only in Chat. */
  notificationRuleId?: string | null;
  cancelOnNextReply?: boolean;
}

/** Proposed wall-clock time. Only the Chat timer confirmation can schedule it. */
export interface ChatReminderPreview {
  localDueAt: string;
  timezone: string;
  message: string;
}

const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

/**
 * Resolves a datetime-local wall clock value in an explicit IANA timezone.
 * The round-trip check rejects skipped DST wall-clock times instead of silently
 * changing the operator's chosen reminder time.
 */
export function zonedDateTimeToIso(localValue: string, timeZone: string): string {
  const match = LOCAL_DATE_TIME_PATTERN.exec(localValue);
  if (!match) throw new Error("Choose a valid due date and time.");
  const desired = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
  const desiredUtc = Date.UTC(
    desired.year,
    desired.month - 1,
    desired.day,
    desired.hour,
    desired.minute,
    desired.second,
  );
  if (!Number.isFinite(desiredUtc)) throw new Error("Choose a valid due date and time.");

  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  let candidate = desiredUtc;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const displayed = partsToUtc(formatter.formatToParts(new Date(candidate)));
    candidate += desiredUtc - displayed;
  }
  const roundTrip = partsToValues(formatter.formatToParts(new Date(candidate)));
  if (Object.entries(desired).some(([key, value]) => roundTrip[key as keyof typeof roundTrip] !== value)) {
    throw new Error("That wall-clock time does not exist in the selected timezone.");
  }
  return new Date(candidate).toISOString();
}

function partsToUtc(parts: Intl.DateTimeFormatPart[]): number {
  const values = partsToValues(parts);
  return Date.UTC(values.year, values.month - 1, values.day, values.hour, values.minute, values.second);
}

function partsToValues(parts: Intl.DateTimeFormatPart[]) {
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  return {
    year: value("year"),
    month: value("month"),
    day: value("day"),
    hour: value("hour"),
    minute: value("minute"),
    second: value("second"),
  };
}

export interface ChatTimerListResponse {
  items: ChatTimerRecord[];
}

export interface ChatTimerMutationResponse {
  item: ChatTimerRecord;
}
