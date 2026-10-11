/**
 * Built-in system cron cadences. A seeded schedule is the cadence plus the IANA
 * zone it runs in, taken from the gateway host (Node honours `TZ`) with a UTC
 * fallback, so installs are not pinned to one region's wall clock.
 */
export const PRIVATE_BETA_BACKUP_CADENCE = "30 2 * * *";
export const MEMORY_FLUSH_DAILY_CADENCE = "0 3 * * *";
export const MEMORY_CONSOLIDATION_WEEKLY_CADENCE = "30 2 * * 0";
export const COST_REPORT_HOURLY_CADENCE = "0 * * * *";
export const UPDATE_REVIEW_DAILY_CADENCE = "15 4 * * *";

const FALLBACK_TIME_ZONE = "UTC";

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return true;
  } catch {
    return false;
  }
}

/** The gateway host's IANA zone, or UTC when the host reports none or one Intl cannot use. */
export function resolveSystemCronTimeZone(): string {
  let hostTimeZone: string | undefined;
  try {
    hostTimeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    hostTimeZone = undefined;
  }
  return hostTimeZone && isValidTimeZone(hostTimeZone) ? hostTimeZone : FALLBACK_TIME_ZONE;
}

/** The schedule a built-in job is seeded (and re-pinned on each start) with: its cadence in the host zone. */
export function systemCronScheduleLabel(cadence: string): string {
  return `${cadence} ${resolveSystemCronTimeZone()}`;
}

/**
 * The zone a built-in job's due gate and dedup keys use: the zone its persisted
 * schedule names, so the gate always matches what the Schedules page shows.
 * An unsuffixed or invalid schedule falls back to the host zone.
 */
export function systemCronTimeZoneForSchedule(schedule: string | undefined): string {
  const suffix = schedule?.trim().split(/\s+/).slice(5).join(" ");
  return suffix && isValidTimeZone(suffix) ? suffix : resolveSystemCronTimeZone();
}
