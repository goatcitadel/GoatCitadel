import { useEffect, useRef, useState } from "react";
import type { QueryClient, QueryKey } from "@tanstack/react-query";
import { createInvalidationBatcher } from "./invalidation-batcher";
import { toast } from "sonner";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import { fetchOperatorInbox } from "@goatcitadel/mission-control-shared/api/operator-inbox";
import {
  connectEventStream,
  type EventStreamConnectionState,
  type RealtimeEvent,
} from "@goatcitadel/mission-control-shared/api/shell-client";
import { decideNotificationDelivery } from "@goatcitadel/mission-control-shared/state/notification-policy";
import {
  deriveRealtimeNotification,
  deriveRealtimeRefresh,
} from "@goatcitadel/mission-control-shared/state/realtime-derived";
import type { RefreshTopic } from "@goatcitadel/mission-control-shared/state/refresh-bus";
import { queryKeys } from "./query-keys";
import { inboxItemLocation, resolveInboxNotificationItem } from "./inbox-notification";
import { useCockpitRoute } from "../app/use-cockpit-route";
import { playOperatorAttentionSound } from "@goatcitadel/mission-control-shared/state/operator-attention";
import type { UiNotificationPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { showBrowserNotification } from "../../app/browser-notification";

export function invalidateForEvent(
  queryClient: QueryClient,
  event: RealtimeEvent,
  invalidate: (queryKey: QueryKey) => void = (queryKey) => void queryClient.invalidateQueries({ queryKey }),
): RefreshTopic[] {
  if (event.eventType === "inbox.changed") {
    if (
      event.source !== "operator_inbox" ||
      event.eventAuthority !== "retained_stream" ||
      event.eventClass !== "operational_signal"
    )
      return [];
    const workspaceId = event.links?.workspaceId;
    if (
      event.payload.scope === "workspace" &&
      typeof workspaceId === "string" &&
      workspaceId.trim() === workspaceId &&
      workspaceId
    ) {
      invalidate(queryKeys.inbox(workspaceId));
    } else if (event.payload.scope === "all_workspaces" && workspaceId === undefined) {
      invalidate(["approvals", "operator-inbox"]);
    }
    return [];
  }
  if (event.source === "llamacpp") {
    // A runtime status signal changes only what the health readers show. Refreshing the whole
    // `system` topic re-read this status, and the Gateway used to announce every read (GL-01).
    if (event.eventAuthority !== "durable_history") invalidate(queryKeys.healthAll());
    return [];
  }
  const { topics } = deriveRealtimeRefresh(event, { defaultTopics: ["surface"] });
  for (const topic of topics) invalidate([topic]);
  if (topics.some((topic) => topic === "tools" || topic === "mcp" || topic === "agents")) {
    invalidate(queryKeys.capabilities());
  }
  const inboxOwnerSignal =
    event.eventAuthority !== "durable_history" &&
    (event.eventType === "inbox.changed" ||
      event.eventType.includes("proposal") ||
      event.eventType.includes("change_plan") ||
      event.eventType.includes("user_input"));
  if (
    event.eventAuthority !== "durable_history" &&
    (inboxOwnerSignal ||
      topics.some((topic) => ["approvals", "tasks", "memory", "skills", "improvement", "system"].includes(topic)))
  ) {
    invalidate(["approvals", "operator-inbox"]);
  }
  return topics;
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
  const installation = getGatewayApiBaseUrl();
  const currentScope = useRef({ installation, workspaceId, enabled, generation: 0 });
  if (
    currentScope.current.installation !== installation ||
    currentScope.current.workspaceId !== workspaceId ||
    currentScope.current.enabled !== enabled
  ) {
    currentScope.current = { installation, workspaceId, enabled, generation: currentScope.current.generation + 1 };
  }
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const generation = currentScope.current.generation;
    const delivered = new Set<string>();
    const pendingReads = new Set<AbortController>();
    const batcher = createInvalidationBatcher(queryClient);
    const isCurrent = () =>
      active &&
      currentScope.current.enabled &&
      currentScope.current.generation === generation &&
      currentScope.current.installation === installation &&
      getGatewayApiBaseUrl() === installation;
    const disconnect = connectEventStream((event, delivery) => {
      if (!isCurrent()) return;
      invalidateForEvent(queryClient, event, batcher.invalidate);
      const notification = deriveRealtimeNotification(event);
      const decision = decideNotificationDelivery(notification, {
        replayed: delivery.replayed,
        eventSessionId: event.links?.sessionId,
        visibleSessionId: visibleSessionIdRef.current,
        pageFocused: pageFocused(),
      });
      if (!notification || !decision.toast) return;
      // The shared HTTP client also coalesces GETs below the query cache. A scoped
      // signal requests a separate owner read begun after this live event.
      const read = new AbortController();
      pendingReads.add(read);
      void fetchOperatorInbox(workspaceId, { signal: read.signal })
        .then((projection) => {
          if (!isCurrent()) return;
          const item = resolveInboxNotificationItem(projection, event, notification, workspaceId);
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
            if (isCurrent()) navigateRef.current(inboxItemLocation(item));
          };
          const id = `inbox:${workspaceId}:${item.id}`;
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
        })
        .finally(() => {
          pendingReads.delete(read);
        });
    }, setStreamState);
    return () => {
      active = false;
      batcher.dispose();
      for (const read of pendingReads) read.abort();
      pendingReads.clear();
      disconnect();
    };
  }, [queryClient, enabled, installation, workspaceId]);
  return enabled ? streamState : "closed";
}
