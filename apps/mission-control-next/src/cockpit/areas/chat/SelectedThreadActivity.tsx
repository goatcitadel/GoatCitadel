import { useMediaQuery } from "@goatcitadel/mission-control-shared/hooks/useMediaQuery";
import { useThreadActivity } from "./use-thread-activity";
import { UNKNOWN_THREAD_ACTIVITY } from "./thread-activity";

/** The phone picker reads only the selected conversation, never every option. */
export function SelectedThreadActivity({ sessionId }: { sessionId?: string }) {
  const compact = useMediaQuery("(width < 1024px)");
  const activity = useThreadActivity(compact && sessionId ? [sessionId] : []);
  if (!compact || !sessionId) return null;
  const status = activity.records[sessionId] ?? UNKNOWN_THREAD_ACTIVITY;
  return <p className="text-xs text-fg-muted md:hidden" aria-label="Selected conversation activity">
    {activity.loading ? "Checking status" : status.label}
    {!activity.loading && status === UNKNOWN_THREAD_ACTIVITY ? <button type="button" className="ml-2 text-accent" onClick={() => void activity.refresh()}>Refresh status</button> : null}
  </p>;
}
