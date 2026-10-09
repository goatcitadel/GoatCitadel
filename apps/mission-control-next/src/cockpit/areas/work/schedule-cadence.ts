/** Human wording is a projection of the saved expression; Gateway owns interpretation/timezone. */
export function scheduleTimezone(value: string): string | null {
  const tokens = value.trim().split(/\s+/);
  if (tokens.length <= 5) return null;
  const zone = tokens.slice(5).join(" ");
  try { new Intl.DateTimeFormat("en-US", { timeZone: zone }).format(new Date()); return zone; }
  catch { return null; }
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
export function scheduleCadence(value: string): string {
  const zone = effectiveScheduleZone(value);
  // Strip only a recognized zone; an unrecognized suffix stays a custom expression rather than an unlabelled time.
  const expression = scheduleTimezone(value) ? value.trim().split(/\s+/).slice(0, 5).join(" ") : value;
  const timed = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/.exec(expression);
  if (timed && Number(timed[1]) < 60 && Number(timed[2]) < 24) return `${timed[3] === "1-5" ? "Weekdays" : "Every day"} at ${timed[2]!.padStart(2, "0")}:${timed[1]!.padStart(2, "0")}${zone ? ` ${zone}` : ""}`;
  return expression === "0 * * * *" ? `Every hour${zone ? ` ${zone}` : ""}` : `Custom schedule: ${value}`;
}

export type ScheduleCadence = "daily" | "weekdays" | "hourly" | "custom";
/** Guided presets are projections of the saved expression, never a separate schedule contract. */
export function scheduleTiming(value: string): { cadence: ScheduleCadence; time: string | null; zone: string | null } {
  const zone = scheduleTimezone(value);
  const expression = zone ? value.trim().split(/\s+/).slice(0, 5).join(" ") : value.trim();
  const timed = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5)$/.exec(expression);
  if (timed && Number(timed[1]) < 60 && Number(timed[2]) < 24)
    return { cadence: timed[3] === "1-5" ? "weekdays" : "daily", time: `${timed[2]!.padStart(2, "0")}:${timed[1]!.padStart(2, "0")}`, zone };
  return { cadence: expression === "0 * * * *" ? "hourly" : "custom", time: null, zone };
}
export function buildScheduleExpression(cadence: Exclude<ScheduleCadence, "custom">, time: string | null, zone: string | null): string {
  const suffix = zone ? ` ${zone}` : "";
  if (cadence === "hourly") return `0 * * * *${suffix}`;
  const [hour = 9, minute = 0] = (time ?? "09:00").split(":").map(Number);
  return `${minute} ${hour} * * ${cadence === "weekdays" ? "1-5" : "*"}${suffix}`;
}
