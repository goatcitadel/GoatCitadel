import type { EventStreamConnectionState } from "@goatcitadel/mission-control-shared/api/shell-client";
import type { StatusTone } from "@goatcitadel/mission-control-shared/content/status-vocabulary";

/** Live-update labels shared by the sidebar and the phone strip. */
export const STREAM_STATUS: Readonly<Record<EventStreamConnectionState, { label: string; tone: string }>> = {
  connecting: { label: "Connecting to updates", tone: "bg-status-waiting" },
  open: { label: "Updates connected", tone: "bg-status-done" },
  retrying: { label: "Reconnecting to updates", tone: "bg-status-waiting" },
  error: { label: "Updates unavailable", tone: "bg-status-failed" },
  closed: { label: "Updates disconnected", tone: "bg-status-neutral" },
};

export const HEALTH_TONE_BG: Readonly<Record<StatusTone, string>> = {
  running: "bg-status-running",
  waiting: "bg-status-waiting",
  done: "bg-status-done",
  failed: "bg-status-failed",
  neutral: "bg-status-neutral",
};
