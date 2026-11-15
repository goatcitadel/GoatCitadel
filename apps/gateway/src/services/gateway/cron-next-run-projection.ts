import type { CronJobRecord } from "@goatcitadel/contracts";

type ComputeNextRunAt = (schedule: string, from: Date, endAt?: string) => string | undefined;

/**
 * An enabled job the scheduler has not run yet has no recorded next run. The list works one out from the schedule with
 * the same rule the scheduler applies after each run, and flags it so the screen can say where the time came from.
 * Read-only: nothing is stored. The rule is passed in because it lives in the cron service that calls this.
 */
export function withProjectedNextRun(job: CronJobRecord, now: Date, computeNextRunAt: ComputeNextRunAt): CronJobRecord {
  if (!job.enabled || job.nextRunAt || !job.schedule) return job;
  const nextRunAt = computeNextRunAt(job.schedule, now, job.endAt);
  return nextRunAt ? { ...job, nextRunAt, nextRunProjected: true } : job;
}
