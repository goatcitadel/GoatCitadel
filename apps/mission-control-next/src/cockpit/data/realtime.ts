import { useEffect, useRef, useState } from "react";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { createInvalidationBatcher, throttleIntervalFor } from "./invalidation-batcher";
import { toast } from "sonner";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { fetchOperatorInbox } from "@goatcitadel/mission-control-shared/api/operator-inbox";
import {
  connectEventStream,
  type EventStreamConnectionState,
  type RealtimeEvent,
} from "@goatcitadel/mission-control-shared/api/shell-client";
import {
  publishEventStreamStatus,
  resetEventStreamStatus,
} from "@goatcitadel/mission-control-shared/state/event-stream-status-store";
import { decideNotificationDelivery } from "@goatcitadel/mission-control-shared/state/notification-policy";
import { deriveRealtimeNotification } from "@goatcitadel/mission-control-shared/state/realtime-derived";
import {
  emitRefresh,
  type RefreshSignal,
  type RefreshTopic,
} from "@goatcitadel/mission-control-shared/state/refresh-bus";
import type { OperatorInboxResponse } from "@goatcitadel/contracts";
import { queryKeys } from "./query-keys";
import { resolveRealtimeEvent } from "./event-map";
import { appendRetainedActivity } from "./activity-feed";
import { inboxItemLocation, resolveInboxNotificationItem } from "./inbox-notification";
import { useCockpitRoute } from "../app/use-cockpit-route";
import { playOperatorAttentionSound } from "@goatcitadel/mission-control-shared/state/operator-attention";
import type { UiNotificationPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { showBrowserNotification } from "../../app/browser-notification";

/**
 * An event the map does not know refreshes its keyword topics at most once every five seconds per topic;
 * events inside the window share one trailing refresh when it ends.
 */
export const UNMAPPED_TOPIC_INTERVAL_MS = 5_000;

export interface RealtimeSink {
  invalidate: (queryKey: QueryKey) => void;
  refresh: (topic: RefreshTopic, event: RealtimeEvent) => void;
  unmapped: (topic: RefreshTopic, event: RealtimeEvent) => void;
}

function invalidateForInboxSignal(event: RealtimeEvent, sink: RealtimeSink): void {
  if (
    event.source !== "operator_inbox" ||
    event.eventAuthority !== "retained_stream" ||
    event.eventClass !== "operational_signal"
  )
    return;
  const workspaceId = event.links?.workspaceId;
  if (
    event.payload.scope === "workspace" &&
    typeof workspaceId === "string" &&
    workspaceId.trim() === workspaceId &&
    workspaceId
  ) {
    sink.invalidate(queryKeys.inbox(workspaceId));
  } else if (event.payload.scope === "all_workspaces" && workspaceId === undefined) {
    sink.invalidate(queryKeys.inboxAll());
  }
}

/** Routes one live event to the query prefixes and refresh topics it changes (see `event-map.ts`). */
export function invalidateForEvent(event: RealtimeEvent, sink: RealtimeSink): void {
  if (event.eventType === "inbox.changed") {
    invalidateForInboxSignal(event, sink);
    return;
  }
  const resolution = resolveRealtimeEvent(event);
  if (resolution.kind === "ignored") return;
  if (resolution.kind === "unmapped") {
    for (const topic of resolution.topics) sink.unmapped(topic, event);
    return;
  }
  for (const key of resolution.effect.keys) sink.invalidate(key);
  for (const topic of resolution.effect.refresh) sink.refresh(topic, event);
}

/** The refresh-bus signal for one live event; it names the conversation so Chat can skip reloads for others. */
export function realtimeRefreshSignal(event: RealtimeEvent): Omit<RefreshSignal, "topic" | "timestamp"> {
  return {
    reason: event.eventType,
    source: event.source,
    eventType: event.eventType,
    eventId: event.eventId,
    sessionId: event.links?.sessionId,
  };
}

/** Exported for tests. An unmapped event inside its topic's window gets one trailing refresh, never a drop. */
export function createRealtimeSink(queryClient: QueryClient): { sink: RealtimeSink; dispose: () => void } {
  const batcher = createInvalidationBatcher(queryClient, { minIntervalMs: throttleIntervalFor });
  const lastUnmapped = new Map<RefreshTopic, number>();
  const trailingUnmapped = new Map<RefreshTopic, { timer: ReturnType<typeof setTimeout>; event: RealtimeEvent }>();
  const warned = new Set<string>();
  const signal = (topic: RefreshTopic, event: RealtimeEvent) => emitRefresh(topic, realtimeRefreshSignal(event));
  const sink: RealtimeSink = {
    invalidate: batcher.invalidate,
    refresh: signal,
    unmapped: (topic, event) => {
      const id = `${event.source}:${event.eventType}`;
      if (import.meta.env.DEV && !warned.has(id)) {
        warned.add(id);
        // eslint-disable-next-line no-console
        console.warn(`Unmapped realtime event ${id}; refreshing ${topic} (throttled).`);
      }
      const wait = (lastUnmapped.get(topic) ?? -Infinity) + UNMAPPED_TOPIC_INTERVAL_MS - Date.now();
      if (wait <= 0) {
        refreshUnmapped(topic, event);
        return;
      }
      const trailing = trailingUnmapped.get(topic);
      if (trailing) {
        trailing.event = event;
        return;
      }
      const entry = {
        event,
        timer: setTimeout(() => {
          trailingUnmapped.delete(topic);
          refreshUnmapped(topic, entry.event);
        }, wait),
      };
      trailingUnmapped.set(topic, entry);
    },
  };
  function refreshUnmapped(topic: RefreshTopic, event: RealtimeEvent) {
    lastUnmapped.set(topic, Date.now());
    batcher.invalidate([topic]);
    signal(topic, event);
  }
  const dispose = () => {
    for (const { timer } of trailingUnmapped.values()) clearTimeout(timer);
    trailingUnmapped.clear();
    batcher.dispose();
  };
  return { sink, dispose };
}

/**
 * Reads the Inbox through the query cache for a toast decision. A read already in flight began before
 * this event and may miss it, so it is replaced (its waiters receive the new result). Events delivered
 * in the same tick share one read, and a batched Inbox invalidation joins it instead of starting another.
 */
function createInboxReader(queryClient: QueryClient) {
  const tickReads = new Map<string, Promise<OperatorInboxResponse>>();
  return (workspaceId: string): Promise<OperatorInboxResponse> => {
    const pending = tickReads.get(workspaceId);
    if (pending) return pending;
    const queryKey = queryKeys.inbox(workspaceId);
    const inFlight = queryClient.getQueryCache().find({ queryKey, exact: true });
    if (inFlight?.state.fetchStatus === "fetching") void inFlight.cancel({ silent: true });
    const read = queryClient.fetchQuery({
      queryKey,
      queryFn: ({ signal }) => fetchOperatorInbox(workspaceId, { signal }),
      staleTime: 0,
    });
    tickReads.set(workspaceId, read);
    setTimeout(() => {
      if (tickReads.get(workspaceId) === read) tickReads.delete(workspaceId);
    }, 0);
    return read;
  };
}

function pageFocused(): boolean {
  return typeof document !== "undefined" && document.visibilityState === "visible" && document.hasFocus();
}

/** A single event subscription refreshes query owners and shows only allowed attention. */
export function useCockpitRealtime(input: {
  queryClient: QueryClient;
  enabled: boolean;
  workspaceId: string;
  notificationPreferences: UiNotificationPreferences;
  visibleSessionId?: string;
}): EventStreamConnectionState {
  const [streamState, setStreamState] = useState<EventStreamConnectionState>("closed");
  const { navigate } = useCockpitRoute();
  const navigateRef = useRef(navigate);
  useEffect(() => {
    navigateRef.current = navigate;
  }, [navigate]);
  const visibleSessionIdRef = useRef(input.visibleSessionId);
  useEffect(() => {
    visibleSessionIdRef.current = input.visibleSessionId;
  }, [input.visibleSessionId]);
  const preferencesRef = useRef(input.notificationPreferences);
  preferencesRef.current = input.notificationPreferences;
  const { queryClient, enabled, workspaceId } = input;
  // The workspace is read through a ref so switching it never reconnects the stream (GL-64). Its own
  // generation still retires reads and toasts begun for an earlier visit, even after coming back.
  const workspaceRef = useRef({ id: workspaceId, generation: 0 });
  if (workspaceRef.current.id !== workspaceId) {
    workspaceRef.current = { id: workspaceId, generation: workspaceRef.current.generation + 1 };
  }
  const installation = getGatewayApiBaseUrl();
  const currentScope = useRef({ installation, enabled, generation: 0 });
  if (currentScope.current.installation !== installation || currentScope.current.enabled !== enabled) {
    currentScope.current = { installation, enabled, generation: currentScope.current.generation + 1 };
  }
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const generation = currentScope.current.generation;
    const delivered = new Set<string>();
    const { sink, dispose } = createRealtimeSink(queryClient);
    const readInbox = createInboxReader(queryClient);
    const isCurrent = () =>
      active &&
      currentScope.current.enabled &&
      currentScope.current.generation === generation &&
      currentScope.current.installation === installation &&
      getGatewayApiBaseUrl() === installation;
    const disconnect = connectEventStream(
      (event, delivery) => {
        if (!isCurrent()) return;
        invalidateForEvent(event, sink);
        if (event.eventAuthority !== "durable_history") {
          appendRetainedActivity(queryClient, event, queryKeys.systemActivity());
          appendRetainedActivity(queryClient, event, queryKeys.workActivityAll());
        }
        const notification = deriveRealtimeNotification(event);
        const decision = decideNotificationDelivery(notification, {
          replayed: delivery.replayed,
          eventSessionId: event.links?.sessionId,
          visibleSessionId: visibleSessionIdRef.current,
          pageFocused: pageFocused(),
        });
        if (!notification || !decision.toast) return;
        const { id: scopeWorkspaceId, generation: workspaceGeneration } = workspaceRef.current;
        const isCurrentWorkspace = () =>
          isCurrent() &&
          workspaceRef.current.id === scopeWorkspaceId &&
          workspaceRef.current.generation === workspaceGeneration;
        void readInbox(scopeWorkspaceId)
          .then((projection) => {
            if (!isCurrentWorkspace()) return;
            const item = resolveInboxNotificationItem(projection, event, notification, scopeWorkspaceId);
            if (!item || delivered.has(item.id)) return;
            const focused = pageFocused();
            const preferences = preferencesRef.current;
            const deliveryDecision = decideNotificationDelivery(notification, {
              replayed: delivery.replayed,
              eventSessionId: item.source.sessionId,
              visibleSessionId: visibleSessionIdRef.current,
              pageFocused: focused,
            });
            if (!deliveryDecision.toast || (preferences.onlyWhenUnfocused && focused)) return;
            delivered.add(item.id);
            const open = () => {
              if (isCurrentWorkspace()) navigateRef.current(inboxItemLocation(item));
            };
            const id = `inbox:${scopeWorkspaceId}:${item.id}`;
            const show =
              notification.tone === "error" ? toast.error : notification.tone === "warning" ? toast.warning : toast;
            if (preferences.toastsEnabled)
              show(item.title, {
                id,
                description: item.summary,
                duration: notification.tone === "error" ? Infinity : 6_000,
                action: { label: "Open Inbox item", onClick: open },
              });
            if (deliveryDecision.sound) void playOperatorAttentionSound(notification.soundCue, preferences.soundMode);
            if (deliveryDecision.desktop && preferences.desktopEnabled && document.visibilityState === "hidden") {
              showBrowserNotification(item.title, notification.tone, { tag: id, onClick: open });
            }
          })
          .catch(() => {
            /* Ignore failed owner reads; a retained signal must not become a current item. */
          });
      },
      setStreamState,
      publishEventStreamStatus,
    );
    return () => {
      active = false;
      dispose();
      disconnect();
      resetEventStreamStatus();
    };
  }, [queryClient, enabled, installation]);
  return enabled ? streamState : "closed";
}
