import { describeRealtimeTruthUi } from "../../app/mission-control-shell-model";
import type { EventStreamConnectionState } from "@goatcitadel/mission-control-shared/api/shell-client";
import type { StatusTone } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Clock,
  LoaderCircle,
  RefreshCw,
  Unplug,
  Wifi,
  WifiOff,
  type LucideIcon,
} from "lucide-react";

type StatusPresentation = { Icon: LucideIcon; text: string };

/**
 * Live-update labels shared by the sidebar and the phone strip. SH-01: each state has its own icon shape and a text
 * label, so status never rests on colour alone.
 */
export const STREAM_STATUS: Readonly<Record<EventStreamConnectionState, StatusPresentation & { label: string }>> = {
  connecting: { label: "Connecting to updates", Icon: Clock, text: "text-status-waiting" },
  open: { label: "Updates connected", Icon: Wifi, text: "text-status-done" },
  retrying: { label: "Reconnecting to updates", Icon: RefreshCw, text: "text-status-waiting" },
  error: { label: "Updates unavailable", Icon: WifiOff, text: "text-status-failed" },
  closed: { label: "Updates disconnected", Icon: Unplug, text: "text-fg-muted" },
};

export const HEALTH_TONE_ICON: Readonly<Record<StatusTone, StatusPresentation>> = {
  running: { Icon: LoaderCircle, text: "text-status-running" },
  waiting: { Icon: CircleAlert, text: "text-status-waiting" },
  done: { Icon: CircleCheck, text: "text-status-done" },
  failed: { Icon: CircleX, text: "text-status-failed" },
  neutral: { Icon: CircleDashed, text: "text-fg-muted" },
};

/** True when a phone operator should open System status: a failing or waiting check, or updates not connected. */
export function statusNeedsAttention(tone: StatusTone, state: EventStreamConnectionState): boolean {
  return tone === "failed" || tone === "waiting" || state === "error" || state === "retrying";
}

export function presentCockpitStream(state: EventStreamConnectionState, replayRecovery = false) {
  const truth = describeRealtimeTruthUi(state, replayRecovery ? "replay-gap" : "authoritative");
  const native = STREAM_STATUS[state];
  return {
    ...native,
    label: native.label + (state === "open" && replayRecovery ? " · Catching up" : ""),
    ariaLabel: "Live updates: " + truth.strip,
  };
}
