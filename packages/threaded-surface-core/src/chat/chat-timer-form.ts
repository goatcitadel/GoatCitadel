import { CHAT_TIMER_MAX_HORIZON_MS, CHAT_TIMER_MIN_DELAY_MS } from "@goatcitadel/contracts";

const LOCAL_DATE_TIME_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;

export interface ChatTimerDraft {
  delayMs: number;
  message: string;
}

const TIMER_NUMBERS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const TIMER_UNITS = { second: 1_000, minute: 60_000, hour: 3_600_000 } as const;
const TIMER_REQUEST =
  /^(?:please\s+)?(?:set|start)\s+(?:a\s+)?(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)[ -](second|minute|hour)s?\s+timer|timer\s+for\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(second|minute|hour)s?)\s+(?:(?:to\s+)?remind\s+me\s*(?:to\s+|about\s+|:\s*)|for\s+(?=[^\r\n]+?\s+to\s+\S))([^\r\n]+)$/iu;
const REMINDER_REQUEST =
  /^(?:please\s+)?remind\s+me\s+in\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(second|minute|hour)s?\s+(?:to\s+|about\s+|:\s*)([^\r\n]+)$/iu;
const CHAT_ONLY_SUFFIX = /([.!?])\s+(?:deliver|post|show|put)\s+(?:the reminder|it)\s+only\s+in\s+this\s+chat[.!]?$/iu;
const TEST_CONTEXT_SUFFIX = /([.!?])\s+this is (?:just )?a (?:synthetic )?(?:smoke )?test[.!]?$/iu;

/** Recognize direct, single reminders. Other messages keep the normal Chat path. */
export function parseChatTimerDraft(content: string): ChatTimerDraft | undefined {
  // Only strip explicitly recognized context. A separate instruction stays in Chat.
  const request = content.trim().replace(TEST_CONTEXT_SUFFIX, "$1").replace(CHAT_ONLY_SUFFIX, "$1");
  const timer = TIMER_REQUEST.exec(request);
  const reminder = timer ? undefined : REMINDER_REQUEST.exec(request);
  const duration = timer ? [timer[1] ?? timer[3], timer[2] ?? timer[4], timer[5]] : reminder?.slice(1);
  if (!duration) return undefined;
  const [amountText, unitText, messageText] = duration;
  if (!amountText || !unitText || !messageText) return undefined;
  const amount = amountText.toLowerCase();
  const unit = unitText.toLowerCase() as keyof typeof TIMER_UNITS;
  const delayMs = (/^\d+$/u.test(amount) ? Number(amount) : TIMER_NUMBERS.indexOf(amount)) * TIMER_UNITS[unit];
  const message = messageText.trim();
  if (
    !message ||
    message.length > 4_000 ||
    /[.!?]\s|\b(?:and then|also|every|repeat)\b|\band\s+(?:send|text|email|notify|call|deliver|post|schedule|set|start)\b/iu.test(
      message,
    ) ||
    delayMs < CHAT_TIMER_MIN_DELAY_MS ||
    delayMs > CHAT_TIMER_MAX_HORIZON_MS
  )
    return undefined;
  return { delayMs, message };
}

export function toDateTimeLocalValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return [
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  ].join("T");
}

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
