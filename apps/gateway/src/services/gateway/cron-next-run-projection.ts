import type { CronJobRecord } from "@goatcitadel/contracts";

type ComputeNextRunAt = (schedule: string, from: Date, endAt?: string) => string | undefined;

/**
 * An enabled job the scheduler has not run yet has no recorded next run. The list works one out from the schedule with
 * the same rule the scheduler applies after each run, and flags it so the screen can say where the time came from.
 * Read-only: nothing is stored. The rule is passed in because it lives in the cron service that calls this.
 */
export function withProjectedNextRun(job: CronJobRecord, now: Date, computeNextRunAt: ComputeNextRunAt): CronJobRecord {
  if(job.actionConfig?.agentTurn?.eventWake)return {...job,nextRunAt:undefined,nextRunProjected:undefined};
  const once=job.actionConfig?.agentTurn?.oneShot;
  if(once)return {...job,nextRunAt:job.enabled ? once.at:undefined,nextRunProjected:job.enabled && job.nextRunAt!==once.at ? true:undefined};
  if (!job.enabled || job.nextRunAt || !job.schedule) return job;
  const nextRunAt = computeNextRunAt(job.schedule, now, job.endAt);
  return nextRunAt ? { ...job, nextRunAt, nextRunProjected: true } : job;
}

/**
 * A Task schedule's current destination, read fresh from its citadel with the rule a run uses. A schedule whose
 * destination cannot be read is returned unchanged, so the screen says so instead of guessing. Never stored.
 */
export async function withTaskDestination(
  job: CronJobRecord,
  resolveWorkspaceId: (job: CronJobRecord) => Promise<string>,
): Promise<CronJobRecord> {
  if (job.action !== "task") return job;
  try {
    return { ...job, taskDestinationWorkspaceId: await resolveWorkspaceId(job) };
  } catch {
    return job;
  }
}
