import { useQuery } from "@tanstack/react-query";
import { fetchCronReviewQueue } from "@goatcitadel/mission-control-shared/api/cron";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/settings";
import { formatSchedulerReviewItem } from "../../../features/native-routes/ops/runtime-schedule-model";
import { queryKeys } from "../../data/query-keys";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";

// The Gateway answers 409 when the review queue is switched off (or cannot be listed); that is not an empty queue.
const statusOf = (error: unknown) =>
  error && typeof error === "object" ? (error as { status?: unknown }).status : undefined;

/** Runs the scheduler flagged for follow-up. Read-only: the retry owner is not offered here, as in Classic. */
export function SchedulerReviewQueue() {
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
          <Button size="sm" disabled={queue.isFetching} onClick={() => void queue.refetch()}>
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
          {items.map((item) => {
            const view = formatSchedulerReviewItem(item);
            return (
              <li
                key={item.itemId}
                className="grid min-w-0 gap-1 rounded-md border border-line p-3 text-sm wrap-anywhere"
              >
                <strong className="text-fg">{view.title}</strong>
                <span className="text-fg-secondary">
                  {view.meta} · {item.status}
                </span>
                {view.body ? <p className="whitespace-pre-line text-fg-secondary">{view.body}</p> : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
