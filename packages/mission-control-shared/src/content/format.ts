/**
 * The one set of value formatters for operator-facing copy: times, money, sizes, durations and counts.
 * Raw ISO strings, wire enums and unrounded numbers never reach the screen; they belong in technical details.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const TIME_UNAVAILABLE = "Time unavailable";

function toEpoch(value: string | number | Date | null | undefined): number | undefined {
  if (value === null || value === undefined || value === "") return undefined;
  const epoch = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(epoch) ? epoch : undefined;
}

/** Medium date and short time, for example "15 Oct 2026, 14:05". */
export function formatAbsoluteTime(value: string | number | Date | null | undefined): string {
  const epoch = toEpoch(value);
  return epoch === undefined
    ? TIME_UNAVAILABLE
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(epoch);
}

/** Medium date only, for example "15 Oct 2026". */
export function formatDate(value: string | number | Date | null | undefined): string {
  const epoch = toEpoch(value);
  return epoch === undefined
    ? TIME_UNAVAILABLE
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(epoch);
}

/** Hour and minute only, for example "14:05", for times that are always today (last check, last version). */
export function formatClockTime(value: string | number | Date | null | undefined): string {
  const epoch = toEpoch(value);
  return epoch === undefined
    ? TIME_UNAVAILABLE
    : new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(epoch);
}

/** "just now", "5 minutes ago", "in 2 hours", "yesterday"; older than a week falls back to the date. */
export function formatRelativeTime(value: string | number | Date | null | undefined, now = Date.now()): string {
  const epoch = toEpoch(value);
  if (epoch === undefined) return TIME_UNAVAILABLE;
  const delta = epoch - now;
  const distance = Math.abs(delta);
  if (distance < MINUTE) return "just now";
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
  const sign = delta < 0 ? -1 : 1;
  if (distance < HOUR) return rtf.format(sign * Math.round(distance / MINUTE), "minute");
  if (distance < DAY) return rtf.format(sign * Math.round(distance / HOUR), "hour");
  if (distance < 7 * DAY) return rtf.format(sign * Math.round(distance / DAY), "day");
  return formatDate(epoch);
}

export interface TimePresentation {
  /** Short visible text, relative when recent. */
  text: string;
  /** Full date and time for a title or tooltip. */
  title: string;
  /** Machine-readable value for `<time dateTime>`. */
  dateTime: string;
}

/** Relative text with the absolute time alongside; null when the value is not a valid time. */
export function presentTime(
  value: string | number | Date | null | undefined,
  now = Date.now(),
): TimePresentation | null {
  const epoch = toEpoch(value);
  if (epoch === undefined) return null;
  return {
    text: formatRelativeTime(epoch, now),
    title: formatAbsoluteTime(epoch),
    dateTime: new Date(epoch).toISOString(),
  };
}

/** US dollars at two decimals; positive amounts under a cent read "<$0.01"; unknown never becomes $0.00. */
export function formatMoney(usd: number | null | undefined, options: { atLeast?: boolean } = {}): string {
  if (usd === null || usd === undefined || !Number.isFinite(usd)) return "Unknown";
  const prefix = options.atLeast ? "at least " : "";
  if (usd > 0 && usd < 0.005) return `${prefix}<$0.01`;
  const amount = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(usd);
  return `${prefix}${amount}`;
}

const BYTE_UNITS = ["KB", "MB", "GB", "TB"] as const;

/** "512 B", "1.2 KB", "3.4 MB", using 1024 steps. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "Size unknown";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${BYTE_UNITS[unit]}`;
}

/** "450 ms", "12 s", "3 min 5 s", "2 h 4 min", "3 days". */
export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return "Duration unknown";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return seconds % 60 ? `${minutes} min ${seconds % 60} s` : `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return minutes % 60 ? `${hours} h ${minutes % 60} min` : `${hours} h`;
  return plural(Math.round(hours / 24), "day");
}

/** Seconds, as returned by TTL and interval fields, in the same words as formatDuration. */
export function formatSeconds(seconds: number | null | undefined): string {
  return seconds === null || seconds === undefined ? formatDuration(undefined) : formatDuration(seconds * 1000);
}

const pluralRules = new Intl.PluralRules("en");

/** "1 update", "3 updates", "1,204 requests"; pass the plural form when adding "s" is wrong. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count.toLocaleString()} ${pluralRules.select(count) === "one" ? singular : pluralForm}`;
}
