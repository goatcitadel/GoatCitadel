import { useEffect, useRef, useState } from "react";
import {
  connectEventStream,
  type EventStreamConnectionState,
} from "@goatcitadel/mission-control-shared/api/shell-client";
import {
  publishEventStreamStatus,
  resetEventStreamStatus,
} from "@goatcitadel/mission-control-shared/state/event-stream-status-store";
import {
  publishChannelActivityFromRealtimeEvent,
  resetChannelActivitySnapshots,
} from "@goatcitadel/mission-control-shared/state/channel-activity-store";
import {
  deriveRealtimeNotification,
  deriveRealtimeRefresh,
  type RealtimeTruthMode,
} from "@goatcitadel/mission-control-shared/state/realtime-derived";
import { emitRefresh } from "@goatcitadel/mission-control-shared/state/refresh-bus";
import type { RealtimeNotificationDescriptor } from "./use-shell-notifications";
import { publishOpsSavedBoardRealtimeEvent } from "./ops-saved-board-realtime";
import { publishRemoteWorkerRealtimeEvent } from "./remote-worker-realtime";

/*
 * W4.4 (ship punchlist): event-stream lifecycle extracted from the shell.
 *
 * Owns:
 *   - `streamState` (closed/connecting/open) and `streamTruthMode` (the
 *     replay/compatibility/authoritative flag derived from each refresh).
 *   - The connectEventStream lifecycle: subscribes when the gateway becomes
 *     ready, publishes channel-activity snapshots, emits refresh signals,
 *     and routes derived notifications back to the caller for delivery.
 *   - Resetting the stream-status + channel-activity stores when the
 *     gateway becomes unavailable.
 *
 * Delivery of notifications stays in the shell so it can compose
 * `notificationPreferences` and the toast stack. The hook only knows
 * "I derived this notification — caller, decide what to do with it".
 */

export interface UseEventStreamOptions {
  gatewayReady: boolean;
  onRealtimeNotification: (notification: RealtimeNotificationDescriptor) => void;
}

export interface UseEventStreamResult {
  streamState: EventStreamConnectionState;
  streamTruthMode: RealtimeTruthMode;
}

/*
 * N1 (QA finding): `truthMode:"compatibility"` is per-event provenance about
 * topic inference (keyword match vs explicit `links` ids) — NOT a transport
 * downgrade. Routine live events trip it constantly, so storing it sticky
 * (previous behavior) left a healthy idle app showing a permanent degraded
 * badge. Both non-authoritative modes are now transient: they decay back to
 * "authoritative" after a fixed window unless a newer non-authoritative event
 * arrives first. "replay-gap" gets a longer window because a refresh storm
 * typically follows it.
 */
export const REALTIME_COMPATIBILITY_DECAY_MS = 15_000;
export const REALTIME_REPLAY_GAP_DECAY_MS = 30_000;

function decayDurationForTruthMode(truthMode: RealtimeTruthMode): number | undefined {
  if (truthMode === "compatibility") {
    return REALTIME_COMPATIBILITY_DECAY_MS;
  }
  if (truthMode === "replay-gap") {
    return REALTIME_REPLAY_GAP_DECAY_MS;
  }
  return undefined;
}

interface DecayTimerHandle {
  timer: ReturnType<typeof setTimeout> | null;
  token: number;
}

function clearDecayTimer(handle: DecayTimerHandle): void {
  if (handle.timer !== null) {
    clearTimeout(handle.timer);
    handle.timer = null;
  }
}

// Schedules the single pending decay timeout for a non-authoritative truth
// mode (no-op for "authoritative"). `handle` is mutated in place (it is a
// plain ref.current object, not reactive state) so the caller doesn't need to
// thread the mutation back out. `handle.token` is bumped on every schedule and
// compared at fire-time: if a newer non-authoritative event rescheduled the
// timer before this one fired, `handle.token` will have moved on and the
// stale callback becomes a no-op instead of clobbering fresher state.
function scheduleDecay(handle: DecayTimerHandle, truthMode: RealtimeTruthMode, onDecay: () => void): void {
  const decayMs = decayDurationForTruthMode(truthMode);
  clearDecayTimer(handle);
  if (decayMs === undefined) {
    return;
  }
  handle.token += 1;
  const scheduledToken = handle.token;
  handle.timer = setTimeout(() => {
    if (handle.token === scheduledToken) {
      onDecay();
    }
  }, decayMs);
}

export function useEventStream(options: UseEventStreamOptions): UseEventStreamResult {
  const { gatewayReady, onRealtimeNotification } = options;
  const [streamState, setStreamState] = useState<EventStreamConnectionState>("closed");
  const [streamTruthMode, setStreamTruthMode] = useState<RealtimeTruthMode>("authoritative");

  // Single mutable handle for the pending decay timeout + its schedule token.
  // Held in a ref (not state) because it is pure bookkeeping — updating it
  // must never trigger a re-render.
  const decayHandleRef = useRef<DecayTimerHandle>({ timer: null, token: 0 });

  useEffect(() => {
    // Snapshot the ref's current handle once per effect run (rather than
    // re-reading `decayHandleRef.current` inside each nested closure below).
    // The handle object itself is still mutated in place by
    // clearDecayTimer/scheduleDecay — this local binding just satisfies
    // react-hooks/exhaustive-deps, which flags a ref read inside a cleanup
    // closure as unsafe in case `.current` is repointed before cleanup runs.
    const decayHandle = decayHandleRef.current;

    if (!gatewayReady) {
      setStreamState("closed");
      resetEventStreamStatus();
      resetChannelActivitySnapshots();
      clearDecayTimer(decayHandle);
      setStreamTruthMode("authoritative");
      return;
    }

    const close = connectEventStream(
      (event) => {
        publishChannelActivityFromRealtimeEvent(event);
        publishOpsSavedBoardRealtimeEvent(event);
        publishRemoteWorkerRealtimeEvent(event);
        const derivedRefresh = deriveRealtimeRefresh(event, { defaultTopics: ["surface"] });
        for (const topic of derivedRefresh.topics) {
          emitRefresh(topic, {
            reason: derivedRefresh.signalReason,
            source: event.source,
            eventType: derivedRefresh.signalEventType,
            eventId: event.eventId,
            timestamp: Date.now(),
          });
        }
        setStreamTruthMode(derivedRefresh.truthMode);
        scheduleDecay(decayHandle, derivedRefresh.truthMode, () => setStreamTruthMode("authoritative"));
        const notification = deriveRealtimeNotification(event);
        onRealtimeNotification(notification);
      },
      (nextState) => {
        setStreamState(nextState);
        if (nextState === "closed") {
          clearDecayTimer(decayHandle);
          setStreamTruthMode("authoritative");
        }
      },
      publishEventStreamStatus,
    );

    return () => {
      close();
      resetEventStreamStatus();
      resetChannelActivitySnapshots();
      clearDecayTimer(decayHandle);
    };
  }, [gatewayReady, onRealtimeNotification]);

  return { streamState, streamTruthMode };
}
