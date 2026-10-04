import { threadActivityLabel, UNKNOWN_THREAD_ACTIVITY } from "./thread-activity";
import type { ThreadActivityRecord } from "./use-thread-activity";

const TONE_DOT: Readonly<Record<ThreadActivityRecord["tone"], string>> = {
  running: "bg-status-running",
  waiting: "bg-status-waiting",
  failed: "bg-status-failed",
  done: "bg-status-done",
  neutral: "bg-fg-muted",
};

/** One row's status: checking only before the first answer, then the last answer, dated once stale. */
export function ThreadRowStatus({ record, checking }: { record?: ThreadActivityRecord; checking: boolean }) {
  const shown = record ?? UNKNOWN_THREAD_ACTIVITY;
  const label = record ? threadActivityLabel(record) : checking ? "Checking status" : UNKNOWN_THREAD_ACTIVITY.label;
  return (
    <span
      className="flex items-center gap-1 text-xs text-fg-muted"
      title={record?.observedAt ? `Gateway status observed ${record.observedAt}` : "A current canonical status read is unavailable."}
    >
      <span aria-hidden="true" className={`size-1.5 shrink-0 rounded-full ${TONE_DOT[shown.tone]}`} />
      <span className="truncate">{label}</span>
    </span>
  );
}
