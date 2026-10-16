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
  return `Runs in ${GATEWAY_DEFAULT_SCHEDULE_ZONE} (the Gateway default when the expression names no timezone).`;
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
  return intervalCadence(expression, suffix) ?? "Custom schedule";
}
/** Minute steps and hourly offsets; callers keep the raw expression in the advanced field or a title. */
function intervalCadence(expression: string, suffix: string): string | null {
  if (expression === "* * * * *") return "Every minute";
  const step = /^\*\/(\d{1,2}) \* \* \* \*$/.exec(expression);
  if (step && Number(step[1]) >= 1 && Number(step[1]) < 60)
    return Number(step[1]) === 1 ? "Every minute" : `Every ${Number(step[1])} minutes`;
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
