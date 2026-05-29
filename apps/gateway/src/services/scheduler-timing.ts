/**
 * Timezone-aware date helpers shared by the gateway's recurring scheduler
 * "due" checks (daily backup, memory flush, cost report, update review, ...).
 *
 * These functions are pure (no service state) and derive stable, timezone-
 * scoped dedup keys so a scheduler can decide whether a given calendar
 * day/hour has already been processed. Extracted from `gateway-service.ts` so
 * the recurring-scheduler plumbing and its timing utilities live alongside
 * {@link ./background-scheduler.ts} rather than inflating the gateway service.
 */

/** Calendar fields for an instant, resolved in a specific IANA time zone. */
export interface ZonedDateParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly weekday: number;
  readonly hour: number;
  readonly minute: number;
}

/**
 * Resolves the wall-clock calendar parts of `date` in the given IANA
 * `timeZone`. `weekday` is normalized to 0 (Sunday) through 6 (Saturday).
 */
export function getZonedDateParts(date: Date, timeZone: string): ZonedDateParts {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = formatter.formatToParts(date);
  const read = (type: string): string => parts.find((part) => part.type === type)?.value ?? "";
  const weekdayRaw = read("weekday").toLowerCase();
  const weekday = weekdayRaw.startsWith("sun")
    ? 0
    : weekdayRaw.startsWith("mon")
      ? 1
      : weekdayRaw.startsWith("tue")
        ? 2
        : weekdayRaw.startsWith("wed")
          ? 3
          : weekdayRaw.startsWith("thu")
            ? 4
            : weekdayRaw.startsWith("fri")
              ? 5
              : 6;
  return {
    year: Number.parseInt(read("year"), 10),
    month: Number.parseInt(read("month"), 10),
    day: Number.parseInt(read("day"), 10),
    weekday,
    hour: Number.parseInt(read("hour"), 10),
    minute: Number.parseInt(read("minute"), 10),
  };
}

/** Stable `YYYY-MM-DD` dedup key for `date` resolved in `timeZone`. */
export function toDayKeyForTimezone(date: Date, timeZone: string): string {
  const parts = getZonedDateParts(date, timeZone);
  const yyyy = String(parts.year).padStart(4, "0");
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

/** Stable `YYYY-MM-DD-HH` dedup key for `date` resolved in `timeZone`. */
export function toHourKeyForTimezone(date: Date, timeZone: string): string {
  const parts = getZonedDateParts(date, timeZone);
  const yyyy = String(parts.year).padStart(4, "0");
  const mm = String(parts.month).padStart(2, "0");
  const dd = String(parts.day).padStart(2, "0");
  const hh = String(parts.hour).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}-${hh}`;
}
