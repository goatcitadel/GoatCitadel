import { CHAT_TIMER_MAX_HORIZON_MS, CHAT_TIMER_MIN_DELAY_MS } from "@goatcitadel/contracts";

export { zonedDateTimeToIso } from "@goatcitadel/contracts";

export interface ChatTimerDraft {
  delayMs?: number;
  localDueAt?: string;
  timezone?: string;
  message: string;
}

const TIMER_NUMBERS = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
const TIMER_UNITS = { second: 1_000, minute: 60_000, hour: 3_600_000 } as const;
const TIMER_REQUEST =
  /^(?:please\s+)?(?:set|start)\s+(?:a\s+)?(?:(\d+|one|two|three|four|five|six|seven|eight|nine|ten)[ -](second|minute|hour)s?\s+timer|timer\s+for\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(second|minute|hour)s?)\s+(?:(?:to\s+)?remind\s+me\s*(?:to\s+|about\s+|:\s*)|for\s+(?=[^\r\n]+?\s+to\s+\S))([^\r\n]+)$/iu;
const REMINDER_REQUEST =
  /^(?:please\s+)?remind\s+me\s+in\s+(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s+(second|minute|hour)s?(?:\s+(?:to\s+|about\s+|:\s*)([^\r\n]+)|[.!]?)$/iu;
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
  if (!amountText || !unitText) return undefined;
  const amount = amountText.toLowerCase();
  const unit = unitText.toLowerCase() as keyof typeof TIMER_UNITS;
  const delayMs = (/^\d+$/u.test(amount) ? Number(amount) : TIMER_NUMBERS.indexOf(amount)) * TIMER_UNITS[unit];
  const message = messageText?.trim() ?? "";
  if (
    (messageText !== undefined && !message) ||
    message.length > 4_000 ||
    /[;]|\s[—–]\s|[.!?]\s|\b(?:and|then|also|every|repeat|recurring|daily|weekly|monthly|yearly|hourly|weekdays|weekends|mondays|tuesdays|wednesdays|thursdays|fridays|saturdays|sundays)\b/iu.test(
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
