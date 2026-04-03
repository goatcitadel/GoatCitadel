import { memo } from "react";
import type { EventStreamConnectionState } from "../api/shell-client";
import { useEventStreamStatus } from "../hooks/useEventStreamStatus";

function mapStateToLabel(state: EventStreamConnectionState): "Live" | "Degraded" | "Reconnecting" | "Offline" {
  if (state === "open") {
    return "Live";
  }
  if (state === "retrying" || state === "connecting") {
    return "Reconnecting";
  }
  if (state === "error") {
    return "Degraded";
  }
  return "Offline";
}

function GlobalFreshnessPillInner({ streamState }: { streamState: EventStreamConnectionState }) {
  const streamStatus = useEventStreamStatus();
  const label = mapStateToLabel(streamState);
  const freshnessClass = label.toLowerCase();
  const lastUpdated = streamStatus.lastEventAt
    ? new Date(streamStatus.lastEventAt).toLocaleTimeString()
    : "n/a";

  return (
    <div className={`global-freshness-pill ${freshnessClass}`} role="status" aria-live="polite">
      <span className="status-dot" aria-hidden />
      <span><strong>{label}</strong></span>
      <span className="global-freshness-sep">|</span>
      <span>Last update: {lastUpdated}</span>
      {streamStatus.gatewayNodeId ? (
        <>
          <span className="global-freshness-sep">|</span>
          <span>Gateway: {streamStatus.gatewayNodeId}</span>
        </>
      ) : null}
      {streamStatus.reconnectAttempts > 0 ? (
        <>
          <span className="global-freshness-sep">|</span>
          <span>Reconnects: {streamStatus.reconnectAttempts}</span>
        </>
      ) : null}
    </div>
  );
}

export const GlobalFreshnessPill = memo(GlobalFreshnessPillInner);
