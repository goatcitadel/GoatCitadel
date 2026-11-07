import type { QueryClient } from "@tanstack/react-query";
import type { OperatorInboxResponse } from "@goatcitadel/contracts";
import { fetchOperatorInbox } from "@goatcitadel/mission-control-shared/api/operator-inbox";
import type { RealtimeEvent } from "@goatcitadel/mission-control-shared/api/shell-client";
import { decideNotificationDelivery } from "@goatcitadel/mission-control-shared/state/notification-policy";
import type { DerivedRealtimeNotification } from "@goatcitadel/mission-control-shared/state/realtime-derived";
import { playOperatorAttentionSound } from "@goatcitadel/mission-control-shared/state/operator-attention";
import type { UiNotificationPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { showBrowserNotification } from "../../app/browser-notification";
import { requestCockpitToast } from "../ui/toast-runtime";
import { inboxItemLocation, resolveInboxNotificationItem } from "./inbox-notification";
import { queryKeys } from "./query-keys";

/**
 * Retains live notification waiters across replaced reads. Only a successful owner fetch settles
 * them, never a cached/manual projection. Each later tick replaces a pre-event read; same-tick
 * signals share one read (GL-63). No polling or retry is introduced on owner/auth failures.
 */
function createInboxReader(queryClient: QueryClient) {
  const pending = new Map<
    string,
    {
      promise: Promise<OperatorInboxResponse>;
      resolve: (projection: OperatorInboxResponse) => void;
      reject: (error: unknown) => void;
    }
  >();
  const ticks = new Map<string, { timer: ReturnType<typeof setTimeout>; promise: Promise<OperatorInboxResponse> }>();
  const cache = queryClient.getQueryCache();
  const unsubscribe = cache.subscribe((event) => {
    if (event.type !== "updated") return;
    const key = JSON.stringify(event.query.queryKey);
    const waiting = pending.get(key);
    if (!waiting) return;
    if (event.action.type === "success" && !event.action.manual) {
      pending.delete(key);
      waiting.resolve(event.query.state.data as OperatorInboxResponse);
    } else if (event.action.type === "error") {
      pending.delete(key);
      waiting.reject(event.action.error);
    }
  });
  return {
    read(workspaceId: string): Promise<OperatorInboxResponse> {
      const queryKey = queryKeys.inbox(workspaceId);
      const key = JSON.stringify(queryKey);
      const tick = ticks.get(key);
      if (tick) return tick.promise;
      let waiting = pending.get(key);
      if (!waiting) {
        let resolve!: (projection: OperatorInboxResponse) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<OperatorInboxResponse>((yes, no) => {
          resolve = yes;
          reject = no;
        });
        waiting = { promise, resolve, reject };
        pending.set(key, waiting);
      }
      ticks.set(key, { timer: setTimeout(() => ticks.delete(key), 0), promise: waiting.promise });
      const inFlight = cache.find({ queryKey, exact: true });
      if (inFlight?.state.fetchStatus === "fetching") void inFlight.cancel({ silent: true });
      void queryClient
        .fetchQuery({
          queryKey,
          queryFn: ({ signal }) => fetchOperatorInbox(workspaceId, { signal }),
          staleTime: 0,
          retry: false,
        })
        .catch(() => {
          /* Intentionally ignored: cache success/error owns settlement; replacement cancellation retains waiters. */
        });
      return waiting.promise;
    },
    dispose() {
      unsubscribe();
      for (const tick of ticks.values()) clearTimeout(tick.timer);
      ticks.clear();
      for (const waiting of pending.values()) waiting.reject(new Error("Notification scope retired"));
      pending.clear();
    },
  };
}

export function createRealtimeAttention({
  queryClient,
  isCurrent,
  settledApprovalIds,
  navigate,
  visibleSessionId,
  readPreferences,
  pageFocused,
  inboxToastDuration,
}: {
  queryClient: QueryClient;
  isCurrent: () => boolean;
  settledApprovalIds: ReadonlySet<string>;
  navigate: (path: string) => void;
  visibleSessionId: () => string | undefined;
  readPreferences: () => UiNotificationPreferences;
  pageFocused: () => boolean;
  inboxToastDuration: (tone: string) => number;
}) {
  const inboxReader = createInboxReader(queryClient);
  const delivered = new Set<string>();
  const approvalToastIds = new Map<string, string>();

  return {
    dismissApproval(approvalId: string) {
      const shownId = approvalToastIds.get(approvalId);
      approvalToastIds.delete(approvalId);
      if (shownId) requestCockpitToast((toast) => toast.dismiss(shownId), isCurrent);
    },
    deliver(
      event: RealtimeEvent,
      notification: DerivedRealtimeNotification,
      scopeWorkspaceId: string,
      isCurrentWorkspace: () => boolean,
    ) {
      void inboxReader
        .read(scopeWorkspaceId)
        .then((projection) => {
          if (!isCurrentWorkspace()) return;
          const item = resolveInboxNotificationItem(projection, event, notification, scopeWorkspaceId);
          if (!item || delivered.has(item.id)) return;
          const approvalId = item.kind === "approval" ? item.source.approvalId : undefined;
          if (approvalId && settledApprovalIds.has(approvalId)) return;
          const focused = pageFocused();
          const preferences = readPreferences();
          const deliveryDecision = decideNotificationDelivery(notification, {
            replayed: false,
            eventSessionId: item.source.sessionId,
            visibleSessionId: visibleSessionId(),
            pageFocused: focused,
          });
          if (!deliveryDecision.toast || (preferences.onlyWhenUnfocused && focused)) return;
          delivered.add(item.id);
          const open = () => {
            if (isCurrentWorkspace()) navigate(inboxItemLocation(item));
          };
          const id = `inbox:${scopeWorkspaceId}:${item.id}`;
          if (approvalId) approvalToastIds.set(approvalId, id);
          if (preferences.toastsEnabled)
            requestCockpitToast(
              (toast) => {
                const show =
                  notification.tone === "error"
                    ? toast.error
                    : notification.tone === "warning"
                      ? toast.warning
                      : toast;
                show(item.title, {
                  id,
                  description: item.summary,
                  duration: inboxToastDuration(notification.tone),
                  action: { label: "Open Inbox item", onClick: open },
                });
              },
              () => {
                const currentPreferences = readPreferences();
                return (
                  isCurrentWorkspace() &&
                  !(approvalId && settledApprovalIds.has(approvalId)) &&
                  currentPreferences.toastsEnabled &&
                  !(currentPreferences.onlyWhenUnfocused && pageFocused()) &&
                  decideNotificationDelivery(notification, {
                    replayed: false,
                    eventSessionId: item.source.sessionId,
                    visibleSessionId: visibleSessionId(),
                    pageFocused: pageFocused(),
                  }).toast
                );
              },
            );
          if (deliveryDecision.sound) void playOperatorAttentionSound(notification.soundCue, preferences.soundMode);
          if (deliveryDecision.desktop && preferences.desktopEnabled && document.visibilityState === "hidden") {
            showBrowserNotification(item.title, notification.tone, { tag: id, onClick: open });
          }
        })
        .catch(() => {
          /* Ignore failed owner reads; a retained signal must not become a current item. */
        });
    },
    dispose: inboxReader.dispose,
  };
}
