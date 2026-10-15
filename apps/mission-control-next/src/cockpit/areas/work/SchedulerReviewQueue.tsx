import { useQuery } from "@tanstack/react-query";
import { fetchCronReviewQueue } from "@goatcitadel/mission-control-shared/api/cron";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import type { CronReviewItem, DurableRunStatus } from "@goatcitadel/contracts";
import { humanizeToken, presentRunStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { REVIEW_SEVERITY_LABELS, SCHEDULER_REVIEW_STATUSES, presentFrom } from "./work-vocabulary";

// The Gateway answers 409 when the review queue is switched off (or cannot be listed); that is not an empty queue.
const statusOf = (error: unknown) =>
  error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;

function summaryString(summary: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = summary[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

/**
 * One flagged run in plain words. Trigger and profile posture are open strings from the scheduler, so they are
 * humanized; job, run and turn ids stay in technical details.
 */
function ReviewItem({ item, scheduleName }: { item: CronReviewItem; scheduleName?: string }) {
  const summary = item.summary ?? {};
  const trigger = summaryString(summary, "trigger");
  const childRunId = summaryString(summary, "childDurableRunId", "durableRunId");
  const childStatus = summaryString(summary, "childDurableStatus");
  const childTurnId = summaryString(summary, "childTurnId", "turnId");
  const posture = summaryString(summary, "profilePosture");
  const warning = summaryString(summary, "warning", "profileWarning");
  const childLabel = childStatus
    ? ((presentRunStatus(childStatus as DurableRunStatus) as ReturnType<typeof presentRunStatus> | undefined)?.label ??
      humanizeToken(childStatus))
    : "Accepted";
  return (
    <li className="grid min-w-0 gap-1 rounded-md border border-line p-3 text-sm wrap-anywhere">
      <strong className="text-fg">
        {scheduleName ?? "A scheduled job"}
        {trigger ? ` · ${humanizeToken(trigger)}` : ""}
      </strong>
      <span className="flex flex-wrap items-center gap-2 text-fg-secondary">
        {REVIEW_SEVERITY_LABELS[item.severity] ?? "Unknown"} severity ·{" "}
        <TimeText value={item.updatedAt} prefix="Updated" />
        <StatusBadge status={presentFrom(SCHEDULER_REVIEW_STATUSES, item.status)} />
      </span>
      {childRunId ? <p className="text-fg-secondary">Child run: {childLabel}.</p> : null}
      {posture ? <p className="text-fg-secondary">Profile {humanizeToken(posture).toLowerCase()}.</p> : null}
      {warning ? <p className="whitespace-pre-line text-fg-secondary">{warning}</p> : null}
      <TechnicalDetails>
        <ul className="grid gap-1 font-mono text-xs">
          <li>Job: {item.jobId}</li>
          <li>Scheduler run: {item.runId}</li>
          {childRunId ? <li>Child run: {childRunId}</li> : null}
          {childTurnId ? <li>Child turn: {childTurnId}</li> : null}
        </ul>
      </TechnicalDetails>
    </li>
  );
}

/** Runs the scheduler flagged for follow-up. Read-only: the retry owner is not offered here, as in Classic. */
export function SchedulerReviewQueue({
  scheduleName,
}: {
  /** Names a job from the already-loaded schedule list; the queue spans every workspace. */
  scheduleName?: (jobId: string) => string | undefined;
} = {}) {
  // The Gateway refuses the queue (409) while `cronReviewQueueV1Enabled` is off, so read the flag first and only
  // request the queue when it is on. Classic never hits this: its timeline is gated server-side.
  const settings = useQuery({ queryKey: ["work", "schedules-settings"], queryFn: () => fetchSettings() });
  const enabled = settings.data?.features.cronReviewQueueV1Enabled === true && !settings.isError;
  // Under the schedules topic, so cron realtime signals refresh it with the schedule list.
  const queue = useQuery({
    queryKey: [...queryKeys.schedules(), "review-queue"],
    queryFn: () => fetchCronReviewQueue(200),
    enabled,
  });
  // A disabled query keeps its cached data and error, so everything shown below the callouts follows `enabled`.
  const items = enabled ? (queue.data?.items ?? []) : [];
  // Refresh re-reads the flag owner first; a cached `true` may be stale, and the queue is only requested
  // when the fresh snapshot still reports it on, so a just-disabled flag never produces the 409.
  const refresh = async () => {
    const fresh = await settings.refetch();
    // A failed refetch keeps the cached data, so a stale `true` must not request the queue.
    if (fresh.isSuccess && fresh.data?.features.cronReviewQueueV1Enabled === true) await queue.refetch();
  };
  return (
    <section aria-label="Scheduler review" className="grid min-w-0 gap-3 rounded-lg border border-line bg-raised p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="font-display text-md font-semibold text-fg">Scheduler review</h2>
          <p className="text-sm text-fg-secondary">
            Scheduled runs flagged for follow-up, across all workspaces. Retrying is not offered here.
          </p>
        </div>
        {enabled ? (
          <Button size="sm" disabled={settings.isFetching || queue.isFetching} onClick={() => void refresh()}>
            Refresh
          </Button>
        ) : null}
      </div>
      {settings.isPending ? (
        <p role="status" className="text-sm text-fg-muted">
          Checking scheduler review availability…
        </p>
      ) : null}
      {settings.isError ? (
        <Callout tone="error">
          Scheduler review availability is unknown. {describeApiError(settings.error).summary}
        </Callout>
      ) : null}
      {settings.isSuccess && !enabled ? (
        <Callout tone="warning">
          Scheduler review is switched off in runtime settings on this Gateway. No review items can be shown.
        </Callout>
      ) : null}
      {enabled && queue.isPending ? (
        <p role="status" className="text-sm text-fg-muted">
          Reading the review queue…
        </p>
      ) : null}
      {enabled && queue.isError ? (
        <Callout tone={statusOf(queue.error) === 409 ? "warning" : "error"}>
          {statusOf(queue.error) === 409
            ? "Scheduler review is unavailable on this Gateway; it is usually switched off in runtime settings. No review items can be shown."
            : describeApiError(queue.error).summary}
        </Callout>
      ) : null}
      {enabled && queue.isSuccess && !items.length ? (
        <p className="text-sm text-fg-muted">No scheduler review items.</p>
      ) : null}
      {items.length ? (
        <ul className="grid min-w-0 gap-2">
          {items.map((item) => (
            <ReviewItem key={item.itemId} item={item} scheduleName={scheduleName?.(item.jobId)} />
          ))}
        </ul>
      ) : null}
    </section>
  );
}
