import { threadActivityLabel, UNKNOWN_THREAD_ACTIVITY } from "./thread-activity";
import type { ThreadActivityRecord } from "./use-thread-activity";

const TONE_DOT: Readonly<Record<ThreadActivityRecord["tone"], string>> = {
  running: "bg-status-running",
  waiting: "bg-status-waiting",
  failed: "bg-status-failed",
  done: "bg-status-done",
  neutral: "bg-fg-muted",
};

/** One row's status from the sessions list, dated once it is no longer known to be current. */
export function ThreadRowStatus({ record }: { record?: ThreadActivityRecord }) {
  const shown = record ?? UNKNOWN_THREAD_ACTIVITY;
  const label = threadActivityLabel(shown);
  return (
    <span
      className="flex items-center gap-1 text-xs text-fg-muted"
      title={
        record?.observedAt ? `Gateway status observed ${record.observedAt}` : "The current status could not be read."
      }
    >
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[shown.tone]}`} />
      <span className="truncate">{label}</span>
    </span>
  );
}
