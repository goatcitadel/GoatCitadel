import { useEffect, useState } from "react";
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

export function useEventStream(options: UseEventStreamOptions): UseEventStreamResult {
  const { gatewayReady, onRealtimeNotification } = options;
  const [streamState, setStreamState] = useState<EventStreamConnectionState>("closed");
  const [streamTruthMode, setStreamTruthMode] = useState<RealtimeTruthMode>("authoritative");

  useEffect(() => {
    if (!gatewayReady) {
      setStreamState("closed");
      resetEventStreamStatus();
      resetChannelActivitySnapshots();
      return;
    }

    const close = connectEventStream(
      (event) => {
        publishChannelActivityFromRealtimeEvent(event);
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
        const notification = deriveRealtimeNotification(event);
        onRealtimeNotification(notification);
      },
      (nextState) => {
        setStreamState(nextState);
        if (nextState === "closed") {
          setStreamTruthMode("authoritative");
        }
      },
      publishEventStreamStatus,
    );

    return () => {
      close();
      resetEventStreamStatus();
      resetChannelActivitySnapshots();
    };
  }, [gatewayReady, onRealtimeNotification]);

  return { streamState, streamTruthMode };
}
