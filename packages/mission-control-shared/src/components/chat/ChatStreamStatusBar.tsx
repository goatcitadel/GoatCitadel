import { useEffect, useState, type CSSProperties } from "react";
import { getChatStreamActivityAt } from "../../state/chat-stream-activity-store";

export type ChatStreamStatus = "idle" | "connecting" | "streaming" | "queued" | "error";

/**
 * If no stream chunk has landed for this long while a turn is streaming or
 * connecting, the bar surfaces a "Still working" stall indicator. Purely a
 * client-side liveness signal — no server changes back it.
 */
export const CHAT_STREAM_STALL_THRESHOLD_MS = 12_000;

// Matches the clip-rect recipe already used for icon-only labels in
// mission-control-next.css (.mc-next-topbar-more-trigger > span). Inlined
// here because this package has no compiled sr-only/visually-hidden utility
// class of its own and is consumed by more than one app shell.
const VISUALLY_HIDDEN_STYLE: CSSProperties = {
  position: "absolute",
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: "hidden",
  clip: "rect(0 0 0 0)",
  whiteSpace: "nowrap",
  border: 0,
};

interface ChatStreamStatusBarProps {
  mode?: "chat" | "cowork" | "code";
  status: ChatStreamStatus;
  queuedCount: number;
  error: string | null;
  announce?: boolean;
  /** Session whose stream activity should be polled for the stall indicator. */
  activitySessionId?: string | null;
  /** Quiet-by-design: suppress the stall indicator while waiting on the operator. */
  suppressStallIndicator?: boolean;
}

function statusLabel(status: ChatStreamStatus, queuedCount: number, mode: "chat" | "cowork" | "code"): string {
  switch (status) {
    case "idle":
      return "Ready";
    case "connecting":
      return mode === "cowork" ? "Connecting run response..." : "Connecting...";
    case "streaming":
      return mode === "cowork"
        ? queuedCount > 0
          ? `Run response streaming (${queuedCount} queued messages)`
          : "Run response streaming..."
        : queuedCount > 0
          ? `Streaming (${queuedCount} queued)`
          : "Streaming...";
    case "queued":
      return mode === "cowork"
        ? `${queuedCount} queued message${queuedCount === 1 ? "" : "s"}`
        : `${queuedCount} message${queuedCount === 1 ? "" : "s"} queued`;
    case "error":
      return mode === "cowork" ? "Run response error" : "Error";
  }
}

function statusTone(status: ChatStreamStatus): string {
  switch (status) {
    case "idle":
      return "idle";
    case "connecting":
    case "queued":
      return "pending";
    case "streaming":
      return "active";
    case "error":
      return "error";
  }
}

function isStallEligibleStatus(status: ChatStreamStatus): boolean {
  return status === "streaming" || status === "connecting";
}

export function ChatStreamStatusBar({
  mode = "chat",
  status,
  queuedCount,
  error,
  announce = true,
  activitySessionId = null,
  suppressStallIndicator = false,
}: ChatStreamStatusBarProps) {
  const [stalledSeconds, setStalledSeconds] = useState<number | null>(null);
  const stallActive = isStallEligibleStatus(status) && Boolean(activitySessionId) && !suppressStallIndicator;

  useEffect(() => {
    if (!stallActive) {
      setStalledSeconds(null);
      return undefined;
    }
    const tick = () => {
      const last = getChatStreamActivityAt(activitySessionId);
      const elapsed = last === null ? null : Date.now() - last;
      const nextStalledSeconds =
        elapsed !== null && elapsed >= CHAT_STREAM_STALL_THRESHOLD_MS ? Math.floor(elapsed / 1000) : null;
      // A null-to-null tick is a no-op write: React bails out of the re-render
      // for an unchanged primitive, but skipping the call entirely here keeps
      // the healthy-stream steady state from even scheduling a state update.
      setStalledSeconds((current) => (current === null && nextStalledSeconds === null ? current : nextStalledSeconds));
    };
    tick();
    const interval = globalThis.setInterval(tick, 1000);
    return () => globalThis.clearInterval(interval);
  }, [activitySessionId, stallActive]);

  if (status === "idle" && queuedCount === 0 && !error) {
    return null;
  }

  const tone = statusTone(status);
  const label = statusLabel(status, queuedCount, mode);
  const isStalled = stallActive && stalledSeconds !== null;

  return (
    <div
      className={`chat-stream-status-bar tone-${tone}${isStalled ? " is-stalled" : ""}`}
      role={announce ? "status" : undefined}
      aria-live={announce ? "polite" : undefined}
    >
      <span className="chat-stream-status-indicator" />
      <span className="chat-stream-status-label">{label}</span>
      {error && status === "error" ? <span className="chat-stream-status-error">{error}</span> : null}
      {isStalled ? (
        <span className="chat-stream-status-stall">
          <span aria-hidden="true">Still working — {stalledSeconds}s since last activity</span>
          <span style={VISUALLY_HIDDEN_STYLE}>Still working; the model has been quiet for a while.</span>
        </span>
      ) : null}
    </div>
  );
}
