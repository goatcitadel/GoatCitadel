import { canonicalJsonString } from "@goatcitadel/contracts";
import type { CronJobRecordResponse } from "@goatcitadel/mission-control-shared/api/types";
import {
  createCronJob,
  deleteCronJob,
  fetchCronJob,
  fetchCronJobs,
  pauseCronJob,
  runCronJobNow,
  startCronJob,
  type CronRunNowResponse,
} from "@goatcitadel/mission-control-shared/api/cron";
import { isApiRequestError } from "@goatcitadel/mission-control-shared/api/client";

export type ScheduleAction = "run" | "pause" | "resume" | "cancel";
export type ScheduleOperation =
  | { kind: "create"; input: Parameters<typeof createCronJob>[0] }
  | { kind: ScheduleAction; job: CronJobRecordResponse };
export type ScheduleReceipt =
  | { kind: "create" | "pause" | "resume"; job: CronJobRecordResponse }
  | { kind: "cancel"; jobId: string }
  | { kind: "run"; run: CronRunNowResponse };

/** Configuration comparison deliberately excludes run telemetry, which is not a revision fence. */
export function sameScheduleReview(a: CronJobRecordResponse, b: CronJobRecordResponse): boolean {
  return (
    Number.isInteger(a.revision) &&
    a.revision > 0 &&
    a.jobId === b.jobId &&
    a.revision === b.revision &&
    ["name", "action", "schedule", "enabled", "description", "endAt", "workdir", "contextFrom", "actionConfig"].every(
      (field) =>
        canonicalJsonString(a[field as keyof CronJobRecordResponse] ?? null) ===
        canonicalJsonString(b[field as keyof CronJobRecordResponse] ?? null),
    )
  );
}

export function scheduleOperationId(operation: ScheduleOperation): string {
  return operation.kind === "create" ? operation.input.jobId : operation.job.jobId;
}

function matchesCreated(input: Parameters<typeof createCronJob>[0], job: CronJobRecordResponse) {
  return (
    job.jobId === input.jobId &&
    Number.isInteger(job.revision) &&
    job.revision > 0 &&
    job.name === input.name.trim() &&
    job.schedule === input.schedule.trim() &&
    job.action === (input.action ?? "task") &&
    job.enabled === (input.enabled ?? true) &&
    ["description", "endAt", "workdir", "contextFrom", "actionConfig"].every(
      (field) =>
        canonicalJsonString(job[field as keyof CronJobRecordResponse] ?? null) ===
        canonicalJsonString(input[field as keyof typeof input] ?? null),
    )
  );
}

/** No retry, polling, or inferred execution. The caller owns retained UI admission. */
export async function performScheduleOperation(
  operation: ScheduleOperation,
  isCurrent: () => boolean,
  markDispatched: () => void,
): Promise<ScheduleReceipt | undefined> {
  // A distinct signal prevents joining an older coalesced GET at the shared transport.
  const fresh = () => ({ signal: new AbortController().signal });
  if (operation.kind === "create") {
    const before = await fetchCronJobs(fresh());
    if (!isCurrent()) return;
    if (before.items.some((job) => job.jobId === operation.input.jobId)) {
      throw new Error("This schedule identity already exists. Review the current owner before creating another job.");
    }
    markDispatched();
    const job = await createCronJob(operation.input);
    if (!matchesCreated(operation.input, job)) throw new Error("Schedule creation receipt did not match the request.");
    const saved = await fetchCronJob(job.jobId, fresh());
    if (!sameScheduleReview(job, saved)) throw new Error("The created schedule could not be independently verified.");
    return { kind: "create", job: saved };
  }
  const current = await fetchCronJob(operation.job.jobId, fresh());
  if (!isCurrent()) return;
  if (!sameScheduleReview(current, operation.job)) {
    throw new Error("This schedule changed during review. Inspect its latest settings before acting.");
  }
  markDispatched();
  if (operation.kind === "cancel") {
    const receipt = await deleteCronJob(current.jobId, current.revision);
    if (!receipt.deleted || receipt.jobId !== current.jobId) throw new Error("Schedule deletion was not confirmed.");
    let absent = false;
    try {
      await fetchCronJob(current.jobId, fresh());
    } catch (error) {
      absent =
        isApiRequestError(error) &&
        error.status === 404 &&
        error.method === "GET" &&
        error.path === `/api/v1/cron/jobs/${encodeURIComponent(current.jobId)}` &&
        typeof error.body === "object" &&
        error.body !== null &&
        "error" in error.body &&
        error.body.error === `Cron job not found: ${current.jobId}`;
      if (!absent) throw error;
    }
    if (!absent) throw new Error("The deleted schedule is still returned by its owner.");
    return { kind: "cancel", jobId: current.jobId };
  }
  if (operation.kind === "run") {
    // This API has no expectedRevision input. A fresh review is not an atomic run/config fence.
    const run = await runCronJobNow(current.jobId);
    if (run.jobId !== current.jobId || !run.runId || !["ok", "pending"].includes(run.status)) {
      throw new Error("The run request was not confirmed for this schedule.");
    }
    const saved = await fetchCronJob(current.jobId, fresh());
    if (!sameScheduleReview(current, saved) || (run.status === "ok" && saved.lastRunId !== run.runId)) {
      throw new Error("The run acknowledgement could not be reconciled with the schedule owner.");
    }
    return { kind: "run", run };
  }
  const job =
    operation.kind === "pause"
      ? await pauseCronJob(current.jobId, current.revision)
      : await startCronJob(current.jobId, current.revision);
  const expected = { ...current, revision: job.revision, enabled: operation.kind === "resume" };
  if (job.revision <= current.revision || !sameScheduleReview(job, expected)) {
    throw new Error("The schedule update receipt did not match the reviewed request.");
  }
  const saved = await fetchCronJob(current.jobId, fresh());
  if (!sameScheduleReview(job, saved)) throw new Error("The saved schedule could not be independently verified.");
  return { kind: operation.kind, job: saved };
}
