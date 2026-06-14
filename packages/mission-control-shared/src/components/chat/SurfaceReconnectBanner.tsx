import type { ChatMode } from "@goatcitadel/contracts";
import { useEffect, useMemo, useRef, useState } from "react";
import type { EventStreamStatus } from "../../api/client";

const RECONNECTED_BANNER_MS = 4000;

export function SurfaceReconnectBanner(props: { mode?: ChatMode; status: EventStreamStatus; onRefresh: () => void }) {
  const previousStateRef = useRef<EventStreamStatus["state"]>(props.status.state);
  const [reconnectedAt, setReconnectedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const previousState = previousStateRef.current;
    const recovered =
      props.status.state === "open" &&
      (previousState === "retrying" || previousState === "connecting" || previousState === "error");
    previousStateRef.current = props.status.state;
    if (recovered) {
      const recoveredAt = Date.now();
      setReconnectedAt(recoveredAt);
      setNow(recoveredAt);
    }
  }, [props.status.state]);

  useEffect(() => {
    if (reconnectedAt === null) {
      return undefined;
    }
    // The "restored" banner is only visible for RECONNECTED_BANNER_MS. Tear the
    // 1s ticker down once that window elapses instead of leaving it running for
    // the lifetime of the surface (D-Low: SurfaceReconnectBanner interval leak).
    const elapsed = Date.now() - reconnectedAt;
    if (elapsed >= RECONNECTED_BANNER_MS) {
      return undefined;
    }
    const interval = globalThis.setInterval(() => {
      const sinceReconnect = Date.now() - reconnectedAt;
      setNow(Date.now());
      if (sinceReconnect >= RECONNECTED_BANNER_MS) {
        globalThis.clearInterval(interval);
      }
    }, 1000);
    return () => globalThis.clearInterval(interval);
  }, [reconnectedAt]);

  const banner = useMemo(() => {
    if (props.status.state === "connecting" || props.status.state === "retrying") {
      if (props.mode === "cowork") {
        return {
          tone: "pending",
          title: "Run events reconnecting",
          message: "The run may still be executing.",
          actionable: false,
        } as const;
      }
      return {
        tone: "pending",
        title: "Reconnecting live updates",
        message:
          props.status.reconnectAttempts > 0
            ? `Retry ${props.status.reconnectAttempts} is in progress. New events will resume here automatically.`
            : "Opening the live event stream for this surface.",
        actionable: false,
      } as const;
    }
    if (props.status.state === "error") {
      if (props.mode === "cowork") {
        return {
          tone: "warning",
          title: "Live run events interrupted",
          message: "The run may still be executing; refresh to resync run state.",
          actionable: true,
        } as const;
      }
      return {
        tone: "warning",
        title: "Live updates interrupted",
        message: "Automatic reconnect failed. Refresh this surface to resync messages, approvals, and cowork state.",
        actionable: true,
      } as const;
    }
    if (reconnectedAt !== null && now - reconnectedAt < RECONNECTED_BANNER_MS) {
      if (props.mode === "cowork") {
        return {
          tone: "success",
          title: "Run events restored",
          message: "Live run events are back.",
          actionable: false,
        } as const;
      }
      return {
        tone: "success",
        title: "Live updates restored",
        message: "The event stream reconnected and this surface is back in sync.",
        actionable: false,
      } as const;
    }
    return null;
  }, [now, props.mode, props.status.reconnectAttempts, props.status.state, reconnectedAt]);

  if (!banner) {
    return null;
  }

  return (
    <div className={`surface-reconnect-banner tone-${banner.tone}`} role="status" aria-live="polite">
      <div className="surface-reconnect-banner-copy">
        <p className="surface-reconnect-banner-title">{banner.title}</p>
        <p className="surface-reconnect-banner-body">{banner.message}</p>
      </div>
      {banner.actionable ? (
        <button type="button" className="gc-button surface-reconnect-banner-action" onClick={props.onRefresh}>
          Refresh
        </button>
      ) : null}
    </div>
  );
}
