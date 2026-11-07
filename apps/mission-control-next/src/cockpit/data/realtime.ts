import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Query, QueryClient, QueryKey } from "@tanstack/react-query";
import { createInvalidationBatcher, throttleIntervalFor } from "./invalidation-batcher";
import {
  getGatewayApiBaseUrl,
  getGatewayAccessRevision,
  subscribeGatewayAccessChange,
} from "@goatcitadel/mission-control-shared/api/client-core";
import {
  getGatewayCallerScope,
  subscribeGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
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
import { recordClientDiagnostic } from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";
import {
  emitRefresh,
  type RefreshSignal,
  type RefreshTopic,
} from "@goatcitadel/mission-control-shared/state/refresh-bus";
import { queryKeys } from "./query-keys";
import { resolveRealtimeEvent } from "./event-map";
import { appendRetainedActivity } from "./activity-feed";
import { useCockpitRoute } from "../app/use-cockpit-route";
import type { UiNotificationPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";

/**
 * An event the map does not know refreshes its keyword topics at most once every five seconds per topic;
 * events inside the window share one trailing refresh when it ends.
 */
export const UNMAPPED_TOPIC_INTERVAL_MS = 5_000;

/**
 * No toast stays up forever. Errors last 10 seconds (the Inbox keeps the record, and the Toaster shows at
 * most 3 at once, so a burst cannot bury the page). A decision (warning) lasts 15 seconds so its "Open Inbox
 * item" action can be reached (#496); everything else lasts 6 seconds.
 */
export function inboxToastDuration(tone: string): number {
  if (tone === "warning") return 15_000;
  return tone === "error" ? 10_000 : 6_000;
}

export interface RealtimeSink {
  invalidate: (queryKey: QueryKey, predicate?: (query: Query) => boolean) => void;
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

/** Margin so a replayed event that raced the snapshot's request is still treated as newer than it. */
const REPLAY_SNAPSHOT_MARGIN_MS = 2_000;

/**
 * A stream replay re-sends retained history right after connect. When the Inbox snapshot was generated
 * after that event happened, refetching only repeats the request the page just made. Both times come
 * from the Gateway's clock (the snapshot's `generatedAt` and the event's timestamp), so a browser clock
 * that differs from the Gateway's never decides it. A newer event, a query without data, or a snapshot
 * without a readable `generatedAt` still refetches; only Inbox queries are ever skipped.
 */
function replayedEventNeedsRefetch(event: RealtimeEvent): (query: Query) => boolean {
  const happenedAt = Date.parse(event.timestamp);
  const inbox = queryKeys.inboxAll();
  return (query) => {
    if (!inbox.every((part, index) => query.queryKey[index] === part)) return true;
    if (!Number.isFinite(happenedAt) || query.state.status !== "success") return true;
    const generatedAt = Date.parse(String((query.state.data as { generatedAt?: unknown } | undefined)?.generatedAt));
    if (!Number.isFinite(generatedAt)) return true;
    return generatedAt - REPLAY_SNAPSHOT_MARGIN_MS <= happenedAt;
  };
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

type RealtimeAttentionCode = typeof import("./realtime-attention");
let attentionCode: Promise<RealtimeAttentionCode> | undefined;

function loadRealtimeAttention() {
  return (attentionCode ??= import("./realtime-attention").catch((error: unknown) => {
    attentionCode = undefined;
    throw error;
  }));
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
  const accessRevision = useSyncExternalStore(subscribeGatewayAccessChange, getGatewayAccessRevision, () => 0);
  const caller = getGatewayCallerScope();
  const callerEpoch = useRef(0);
  const [callerGeneration, setCallerGeneration] = useState(0);
  // Even a same-render caller away-and-back change retires outstanding attention and actions.
  useEffect(
    () =>
      subscribeGatewayCallerScope(() => {
        callerEpoch.current += 1;
        setCallerGeneration(callerEpoch.current);
      }),
    [],
  );
  const currentScope = useRef({ installation, enabled, generation: 0 });
  if (currentScope.current.installation !== installation || currentScope.current.enabled !== enabled) {
    currentScope.current = { installation, enabled, generation: currentScope.current.generation + 1 };
  }
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    const generation = currentScope.current.generation;
    // An approval decided where it was asked (a one-click card, a Settings dialog) needs no Inbox notification:
    // one already shown is dismissed, and one still waiting on its Inbox read is not shown.
    const settledApprovalIds = new Set<string>();
    const { sink, dispose } = createRealtimeSink(queryClient);
    let attention: ReturnType<RealtimeAttentionCode["createRealtimeAttention"]> | undefined;
    let attentionLoadWarningShown = false;
    const isCurrent = () =>
      active &&
      currentScope.current.enabled &&
      currentScope.current.generation === generation &&
      currentScope.current.installation === installation &&
      getGatewayApiBaseUrl() === installation &&
      getGatewayAccessRevision() === accessRevision &&
      getGatewayCallerScope() === caller &&
      callerEpoch.current === callerGeneration;
    const disconnect = connectEventStream(
      (event, delivery) => {
        if (!isCurrent()) return;
        invalidateForEvent(
          event,
          delivery.replayed
            ? { ...sink, invalidate: (queryKey) => sink.invalidate(queryKey, replayedEventNeedsRefetch(event)) }
            : sink,
        );
        if (event.eventAuthority !== "durable_history") {
          appendRetainedActivity(queryClient, event, queryKeys.systemActivity());
          appendRetainedActivity(queryClient, event, queryKeys.workActivityAll());
        }
        const settledApprovalId = event.eventType === "approval_resolved" ? event.links?.approvalId : undefined;
        if (settledApprovalId) {
          settledApprovalIds.add(settledApprovalId);
          attention?.dismissApproval(settledApprovalId);
        }
        if (delivery.replayed) return;
        const notification = deriveRealtimeNotification(event);
        const decision = decideNotificationDelivery(notification, {
          replayed: false,
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
        if (attention) {
          attention.deliver(event, notification, scopeWorkspaceId, isCurrentWorkspace);
          return;
        }
        void loadRealtimeAttention()
          .then(({ createRealtimeAttention }) => {
            if (!isCurrentWorkspace()) return;
            attention ??= createRealtimeAttention({
              queryClient,
              isCurrent,
              settledApprovalIds,
              navigate: (path) => navigateRef.current(path),
              visibleSessionId: () => visibleSessionIdRef.current,
              readPreferences: () => preferencesRef.current,
              pageFocused,
              inboxToastDuration,
            });
            attention.deliver(event, notification, scopeWorkspaceId, isCurrentWorkspace);
          })
          .catch(() => {
            if (!isCurrent() || attentionLoadWarningShown) return;
            attentionLoadWarningShown = true;
            recordClientDiagnostic({
              level: "warn",
              category: "stream",
              event: "cockpit.attention_unavailable",
              message: "Cockpit notification controls could not load.",
            });
          });
      },
      setStreamState,
      publishEventStreamStatus,
    );
    return () => {
      active = false;
      attention?.dispose();
      dispose();
      disconnect();
      resetEventStreamStatus();
    };
  }, [queryClient, enabled, installation, accessRevision, caller, callerGeneration]);
  return enabled ? streamState : "closed";
}
