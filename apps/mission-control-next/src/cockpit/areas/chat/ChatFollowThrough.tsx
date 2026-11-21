import type { FollowThroughAction, FollowThroughItem } from "@goatcitadel/contracts";
import { Button } from "../../ui/Button";
import { TimeText } from "../../ui/TimeText";
import { formatInZone } from "../work/schedule-cadence";
const labels: Record<FollowThroughItem["state"], string> = {
  awaiting_review: "Your decision",
  upcoming: "Upcoming",
  quiet: "Quiet",
  waiting_on_you: "Waiting on you",
  running: "Running",
  completed: "Completed",
  failed: "Needs attention",
  unknown: "Outcome unknown",
  paused: "Paused",
  cancelled: "Cancelled",
};
const outcomeLabels: Readonly<Record<string, string>> = {
  admitting: "Starting",
  admitted: "Ready to run",
  running: "Running",
  waiting: "Waiting",
  completed: "Completed",
  failed: "Failed",
  skipped: "Skipped",
  cancelled: "Cancelled",
  dead_lettered: "Failed · needs recovery",
  manual_reconciliation_required: "Needs a manual step",
  ok: "Succeeded",
  proposed: "Proposed",
  pending: "Pending",
  delivery_pending: "Waiting to deliver",
  delivery_failed: "Couldn't deliver",
  sent: "Delivered",
  dismissed: "Dismissed",
  superseded: "Superseded",
  durable_bound: "Run attached",
  terminal: "Finished",
  abandoned: "Stopped",
  blocked: "Blocked",
  executed: "Executed",
  suggested: "Suggested",
  no_action: "No action",
};

function FollowThroughTime({ value, zone }: { value?: string; zone: string }) {
  if (!value) return "Not scheduled";
  if (zone === "System timezone") return <TimeText value={value} absolute />;
  try {
    return <time dateTime={value}>{formatInZone(new Date(value), zone, { year: "numeric" })}</time>;
  } catch {
    return "Time unavailable";
  }
}
export function ChatFollowThrough({
  items,
  onAction,
  onOpenOwner,
  pending,
  error,
}: {
  items: FollowThroughItem[];
  onAction: (
    item: FollowThroughItem,
    action: FollowThroughAction,
    heartbeatIntervalSeconds?: number,
  ) => void | Promise<void>;
  onOpenOwner?: (href: string) => void;
  pending?: boolean;
  error?: string;
}) {
  function row(item: FollowThroughItem) {
    return (
      <li
        key={`${item.owner.kind}:${item.owner.ownerId}`}
        className="min-w-0 space-y-2 border-t border-line-subtle py-3 first:border-t-0"
      >
        <p className="font-medium text-fg [overflow-wrap:anywhere]">
          {item.purpose} · {labels[item.state]}
        </p>
        <p>
          Next check: <FollowThroughTime value={item.nextCheckAt} zone={item.timezone} /> · {item.timezone}
        </p>
        <p>Reports to: {item.delivery}</p>
        {item.lastOutcome ? (
          <p>
            Last recorded outcome:{" "}
            {Object.hasOwn(outcomeLabels, item.lastOutcome) ? outcomeLabels[item.lastOutcome] : "Outcome unavailable"}
          </p>
        ) : null}
        {item.state === "unknown" ? (
          <p>Automatic resend is off. Check the recorded delivery before deciding what to do next.</p>
        ) : null}
        {item.reason ? <p>{item.reason}</p> : null}
        <div className="flex flex-wrap gap-2">
          {item.actions
            .filter(({ action }) => action !== "set_heartbeat_interval")
            .map((action) => (
              <Button
                key={action.action}
                size="sm"
                disabled={pending}
                data-follow-through-action={`${item.owner.ownerId}:${action.action}`}
                onClick={() => void onAction(item, action.action)}
              >
                {action.label}
              </Button>
            ))}
          {onOpenOwner ? (
            <Button size="sm" variant="secondary" onClick={() => onOpenOwner(item.ownerHref)}>
              Open details
            </Button>
          ) : (
            <a className="underline" href={item.ownerHref}>
              Open details
            </a>
          )}
        </div>
        {item.heartbeatIntervalSeconds !== undefined &&
        item.actions.some(({ action }) => action === "set_heartbeat_interval") ? (
          <form
            className="flex flex-wrap items-end gap-2"
            key={item.revision}
            onSubmit={(event) => {
              event.preventDefault();
              const minutes = Number(new FormData(event.currentTarget).get("minutes"));
              void onAction(item, "set_heartbeat_interval", minutes * 60);
            }}
          >
            <label className="grid gap-1">
              Check interval in minutes
              <input
                className="w-28 rounded-md border border-line bg-canvas px-2 py-1 text-fg"
                name="minutes"
                type="number"
                min={15}
                max={1440}
                step={1}
                defaultValue={Math.round(item.heartbeatIntervalSeconds / 60)}
                required
              />
            </label>
            <Button size="sm" type="submit" disabled={pending}>
              Save interval
            </Button>
          </form>
        ) : null}
        <details>
          <summary className="cursor-pointer">Permissions and budget</summary>
          <p>{item.permissionSummary}</p>
          <p>{item.budgetSummary}</p>
        </details>
      </li>
    );
  }
  const foreground = items.filter((item) => item.owner.kind === "schedule" || item.owner.kind === "commitment"),
    background = items.filter((item) => item.owner.kind === "heartbeat" || item.owner.kind === "proactive");
  return (
    <section aria-label="Follow-through" className="min-w-0 space-y-2 text-sm text-fg-secondary">
      {error ? <p role="alert">{error}</p> : null}
      {foreground.length ? (
        <ul className="min-w-0 list-none p-0">{foreground.map(row)}</ul>
      ) : (
        <p>No accepted follow-ups or schedules are recorded for this conversation.</p>
      )}
      {background.length ? (
        <details>
          <summary className="cursor-pointer font-medium">Background checks</summary>
          <ul className="min-w-0 list-none p-0">{background.map(row)}</ul>
        </details>
      ) : null}
    </section>
  );
}
