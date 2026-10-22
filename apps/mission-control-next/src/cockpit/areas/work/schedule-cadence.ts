/** Human wording is a projection of the saved expression; Gateway owns interpretation/timezone. */
export function scheduleTimezone(value: string): string | null {
  const tokens = value.trim().split(/\s+/);
  if (tokens.length <= 5) return null;
  const zone = tokens.slice(5).join(" ");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date());
    return zone;
  } catch {
    return null;
  }
}
/** The Gateway evaluates an expression that names no timezone in UTC (cron-automation-service: `timeZone ?? "UTC"`). */
export const GATEWAY_DEFAULT_SCHEDULE_ZONE = "UTC";
const hasZoneSuffix = (value: string) => value.trim().split(/\s+/).length > 5;
/** The zone a schedule actually runs in: its valid suffix, UTC when it names none, or null for an unrecognized suffix. */
function effectiveScheduleZone(value: string): string | null {
  return scheduleTimezone(value) ?? (hasZoneSuffix(value) ? null : GATEWAY_DEFAULT_SCHEDULE_ZONE);
}
export function scheduleTimezoneSummary(value: string): string {
  const zone = scheduleTimezone(value);
  if (zone) return `Runs in ${zone} (named in the expression).`;
  if (hasZoneSuffix(value)) return "Timezone not recognized in this expression.";
  return `Runs in ${GATEWAY_DEFAULT_SCHEDULE_ZONE} (the GoatCitadel default when the expression names no timezone).`;
}
/** Cron fields are whitespace-separated; extra spaces around or between them do not change the schedule. */
function normalizedExpression(value: string): string {
  return value.trim().split(/\s+/).join(" ");
}
/** The five cron fields without a recognized zone suffix; an unrecognized suffix stays part of the expression. */
function cronFields(value: string): string {
  const normalized = normalizedExpression(value);
  return scheduleTimezone(value) ? normalized.split(" ").slice(0, 5).join(" ") : normalized;
}
const WEEKDAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"] as const;
const TIMED_EXPRESSION = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/;
function timedCadence(expression: string): { day: string; time: string } | null {
  const timed = TIMED_EXPRESSION.exec(expression);
  if (!timed || Number(timed[1]) >= 60 || Number(timed[2]) >= 24) return null;
  return { day: timed[3]!, time: `${timed[2]!.padStart(2, "0")}:${timed[1]!.padStart(2, "0")}` };
}
/** What `scheduleCadence` says when it cannot word an expression; callers then show the expression itself. */
export const CUSTOM_SCHEDULE = "Custom schedule";
export function scheduleCadence(value: string): string {
  const zone = effectiveScheduleZone(value);
  const suffix = zone ? ` ${zone}` : "";
  // Strip only a recognized zone; an unrecognized suffix stays a custom expression rather than an unlabelled time.
  const expression = cronFields(value);
  const timed = timedCadence(expression);
  if (timed) {
    const when =
      timed.day === "1-5"
        ? "Weekdays"
        : timed.day === "*"
          ? "Every day"
          : `Every week on ${WEEKDAY_NAMES[Number(timed.day)]}`;
    return `${when} at ${timed.time}${suffix}`;
  }
  return intervalCadence(expression, suffix) ?? CUSTOM_SCHEDULE;
}
/**
 * Hourly offsets and hour steps, the interval forms the Gateway parser accepts ("M *\/N * * *"); a minute step such
 * as "*\/15 * * * *" stays a custom expression. Callers keep the raw expression in the advanced field or a title.
 */
function intervalCadence(expression: string, suffix: string): string | null {
  if (expression === "* * * * *") return "Every minute";
  const hourStep = /^(\d{1,2}) \*\/(\d{1,2}) \* \* \*$/.exec(expression);
  if (hourStep && Number(hourStep[1]) < 60 && Number(hourStep[2]) >= 1 && Number(hourStep[2]) < 24) {
    const every = Number(hourStep[2]) === 1 ? "Every hour" : `Every ${Number(hourStep[2])} hours`;
    return `${every} at :${hourStep[1]!.padStart(2, "0")}${suffix}`;
  }
  const hourly = /^(\d{1,2}) \* \* \* \*$/.exec(expression);
  if (!hourly || Number(hourly[1]) >= 60) return null;
  const minute = Number(hourly[1]);
  return minute === 0 ? `Every hour${suffix}` : `Every hour at :${String(minute).padStart(2, "0")}${suffix}`;
}

export type ScheduleCadence = "daily" | "weekdays" | "hourly" | "custom";
/** Guided presets are projections of the saved expression, never a separate schedule contract. */
export function scheduleTiming(value: string): { cadence: ScheduleCadence; time: string | null; zone: string | null } {
  const zone = scheduleTimezone(value);
  const expression = cronFields(value);
  // Guided presets have no weekly form: a single weekday stays a custom expression here.
  const timed = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/.exec(expression);
  if (timed && Number(timed[1]) < 60 && Number(timed[2]) < 24)
    return {
      cadence: timed[3] === "1-5" ? "weekdays" : "daily",
      time: `${timed[2]!.padStart(2, "0")}:${timed[1]!.padStart(2, "0")}`,
      zone,
    };
  return { cadence: expression === "0 * * * *" ? "hourly" : "custom", time: null, zone };
}
export function buildScheduleExpression(
  cadence: Exclude<ScheduleCadence, "custom">,
  time: string | null,
  zone: string | null,
): string {
  const suffix = zone ? ` ${zone}` : "";
  if (cadence === "hourly") return `0 * * * *${suffix}`;
  const [hour = 9, minute = 0] = (time ?? "09:00").split(":").map(Number);
  return `${minute} ${hour} * * ${cadence === "weekdays" ? "1-5" : "*"}${suffix}`;
}

const UTC_NAMES = new Set(["UTC", "Etc/UTC", "Etc/GMT", "GMT"]);

/** The browser's IANA timezone, or the Gateway default when the browser does not report one. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || GATEWAY_DEFAULT_SCHEDULE_ZONE;
  } catch {
    return GATEWAY_DEFAULT_SCHEDULE_ZONE;
  }
}

/**
 * WK-02: a new guided schedule runs at the typed time in the browser's timezone. The zone is saved as the expression's
 * timezone suffix, which the Gateway cron parser already accepts ("M H * * * [Timezone]"). UTC needs no suffix.
 */
export function defaultScheduleExpression(zone = browserTimeZone()): string {
  return buildScheduleExpression("daily", "09:00", UTC_NAMES.has(zone) ? null : zone);
}

/** The zones offered by the guided Timezone select: the chosen one, the browser's, UTC, then every zone the runtime knows. */
export function scheduleZoneOptions(chosen: string, browser = browserTimeZone()): string[] {
  return [...new Set([chosen, browser, GATEWAY_DEFAULT_SCHEDULE_ZONE, ...knownTimeZones()])];
}

function knownTimeZones(): string[] {
  try {
    return typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  } catch {
    return [];
  }
}

/** The minutes `zone` is ahead of UTC at `instant`. */
function zoneOffsetMinutes(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return Math.round((asUtc - Math.floor(instant / 1000) * 1000) / 60_000);
}

/** The instant a wall-clock time on a calendar day in `zone` happens. */
function zonedInstant(year: number, month: number, day: number, hour: number, minute: number, zone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffsetMinutes(guess, zone) * 60_000;
  return guess - zoneOffsetMinutes(first, zone) * 60_000;
}

/**
 * The next time a guided daily or weekday schedule runs, as the Gateway evaluates it: `time` on the wall clock in
 * `zone`. Returns null for other cadences, which the field does not preview.
 */
export function nextGuidedRun(
  cadence: ScheduleCadence,
  time: string | null,
  zone: string,
  now: Date = new Date(),
): Date | null {
  if ((cadence !== "daily" && cadence !== "weekdays") || !time) return null;
  const [hour = 0, minute = 0] = time.split(":").map(Number);
  let today: { year: number; month: number; day: number };
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(now);
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
    today = { year: get("year"), month: get("month"), day: get("day") };
  } catch {
    return null;
  }
  for (let offset = 0; offset < 8; offset += 1) {
    const calendar = new Date(Date.UTC(today.year, today.month - 1, today.day + offset));
    const weekday = calendar.getUTCDay();
    if (cadence === "weekdays" && (weekday === 0 || weekday === 6)) continue;
    const instant = zonedInstant(
      calendar.getUTCFullYear(),
      calendar.getUTCMonth() + 1,
      calendar.getUTCDate(),
      hour,
      minute,
      zone,
    );
    if (instant > now.getTime()) return new Date(instant);
  }
  return null;
}

/** "Fri 17 Oct, 09:00" on the wall clock in `zone`. */
export function formatInZone(instant: Date, zone: string): string {
  return new Intl.DateTimeFormat(undefined, {
    timeZone: zone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
}
