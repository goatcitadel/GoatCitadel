import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { useThreadActivity } from "./use-thread-activity";
import { threadActivityLabel, UNKNOWN_THREAD_ACTIVITY } from "./thread-activity";

/** The phone picker reads only the selected conversation, never every option. */
export function SelectedThreadActivity({ sessionId }: { sessionId?: string }) {
  const compact = useMediaQuery("(width < 1024px)");
  const activity = useThreadActivity(compact && sessionId ? [sessionId] : []);
  if (!compact || !sessionId) return null;
  const record = activity.records[sessionId];
  const checking = activity.checking.has(sessionId);
  const unavailable = !checking && (!record || record === UNKNOWN_THREAD_ACTIVITY);
  return (
    <p className="text-xs text-fg-muted md:hidden" aria-label="Selected conversation activity">
      {record ? threadActivityLabel(record) : checking ? "Checking status" : UNKNOWN_THREAD_ACTIVITY.label}
      {unavailable || record?.stale ? (
        <button type="button" className="ml-2 text-accent" onClick={() => void activity.refresh()}>
          Refresh status
        </button>
      ) : null}
    </p>
  );
}
