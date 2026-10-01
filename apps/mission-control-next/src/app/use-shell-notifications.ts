import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import { showBrowserNotification } from "./browser-notification";
import {
  upsertNotificationItem,
  type NotificationItem,
} from "@goatcitadel/mission-control-shared/components/NotificationStack";
import type { UiNotificationPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import type { deriveRealtimeNotification } from "@goatcitadel/mission-control-shared/state/realtime-derived";
import { playOperatorAttentionSound } from "@goatcitadel/mission-control-shared/state/operator-attention";
import {
  decideNotificationDelivery,
  type RealtimeNotificationOrigin,
} from "@goatcitadel/mission-control-shared/state/notification-policy";

/*
 * W4.4 (ship punchlist): shell notification stack extracted from the
 * orchestrator. Owns:
 *   - The `notifications` toast list + immutable push/dismiss callbacks.
 *   - The last enabled sound mode ref so toggling sounds off/on restores
 *     the previously chosen subtle/normal preset.
 *   - Sound playback + browser notification side effects via
 *     `deliverRealtimeNotification`, gated by the operator's notification
 *     preferences (toasts, sound, desktop, only-when-unfocused).
 *
 * Callers (the shell) still own the realtime event stream — they pass the
 * already-derived notification descriptor into `deliverRealtimeNotification`.
 */

export type RealtimeNotificationDescriptor = ReturnType<typeof deriveRealtimeNotification>;

/** How long an info/success toast stays up before it dismisses itself. */
const AUTO_DISMISS_TOAST_MS = 6000;
/** Floor so a toast restored from an old timestamp still gets a beat on screen. */
const MIN_REMAINING_TOAST_MS = 800;

export interface UseShellNotificationsOptions {
  notificationPreferences: UiNotificationPreferences;
  visibleSessionId?: string;
}

export interface UseShellNotificationsResult {
  notifications: NotificationItem[];
  pushNotification: (tone: NotificationItem["tone"], message: string, groupKey?: string) => void;
  dismissNotification: (id: string) => void;
  deliverRealtimeNotification: (notification: RealtimeNotificationDescriptor, origin?: RealtimeNotificationOrigin) => void;
  /**
   * Live ref to the operator's last enabled sound preset. Read at click time
   * so toggling notifications back on restores whichever preset was active
   * before the last "off" transition.
   */
  lastEnabledSoundModeRef: MutableRefObject<"subtle" | "normal">;
}

export function useShellNotifications(options: UseShellNotificationsOptions): UseShellNotificationsResult {
  const { notificationPreferences, visibleSessionId } = options;
  const [notifications, setNotifications] = useState<NotificationItem[]>([]);
  const lastEnabledSoundModeRef = useRef<"subtle" | "normal">(
    notificationPreferences.soundMode === "off" ? "normal" : notificationPreferences.soundMode,
  );
  // Hold the latest preferences behind a ref so `deliverRealtimeNotification`
  // stays referentially stable. Without this its identity changes on every
  // preference toggle (sound/toasts/desktop), which would re-run the consuming
  // event-stream subscription effect and tear down/reconnect the live SSE
  // stream on unrelated UI changes (MCNEXT-002). Delivery still uses the latest
  // preferences because it reads them from the ref at event time.
  const preferencesRef = useRef(notificationPreferences);
  const visibleSessionIdRef = useRef(visibleSessionId);

  useEffect(() => {
    preferencesRef.current = notificationPreferences;
    if (notificationPreferences.soundMode !== "off") {
      lastEnabledSoundModeRef.current = notificationPreferences.soundMode;
    }
  }, [notificationPreferences]);

  useEffect(() => {
    visibleSessionIdRef.current = visibleSessionId;
  }, [visibleSessionId]);

  const pushNotification = useCallback((tone: NotificationItem["tone"], message: string, groupKey?: string) => {
    setNotifications((current) =>
      upsertNotificationItem(current, {
        id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
        tone,
        message,
        timestamp: Date.now(),
        groupKey,
      }),
    );
  }, []);

  const dismissNotification = useCallback((id: string) => {
    setNotifications((current) => current.filter((item) => item.id !== id));
  }, []);

  // Auto-expire informational toasts so the stack does not accumulate stale
  // chrome the operator has to clear by hand. Warnings and errors persist
  // until explicitly dismissed — they may require action. A grouped repeat
  // refreshes the item's timestamp, which naturally extends its lifetime.
  useEffect(() => {
    const expiring = notifications.filter((item) => item.tone === "info" || item.tone === "success");
    if (expiring.length === 0) {
      return;
    }
    const timers = expiring.map((item) =>
      setTimeout(
        () => dismissNotification(item.id),
        Math.max(MIN_REMAINING_TOAST_MS, item.timestamp + AUTO_DISMISS_TOAST_MS - Date.now()),
      ),
    );
    return () => {
      for (const timer of timers) {
        clearTimeout(timer);
      }
    };
  }, [dismissNotification, notifications]);

  const deliverRealtimeNotification = useCallback(
    (notification: RealtimeNotificationDescriptor, origin: RealtimeNotificationOrigin = { replayed: false }) => {
      if (!notification) {
        return;
      }
      // Read the latest preferences from the ref so this callback stays stable
      // (see `preferencesRef` above): the event-stream subscription must not
      // reconnect when the operator only toggles a notification preference.
      const preferences = preferencesRef.current;
      const pageFocused = isPageFocused();
      const delivery = decideNotificationDelivery(notification, {
        ...origin,
        visibleSessionId: visibleSessionIdRef.current,
        pageFocused,
      });
      if (preferences.onlyWhenUnfocused && pageFocused) {
        return;
      }
      if (delivery.toast && preferences.toastsEnabled) {
        pushNotification(notification.tone, notification.message, notification.groupKey);
      }
      if (delivery.sound) {
        void playOperatorAttentionSound(notification.soundCue, preferences.soundMode);
      }
      if (delivery.desktop && preferences.desktopEnabled && document.visibilityState === "hidden") {
        showBrowserNotification(notification.message, notification.tone);
      }
    },
    [pushNotification],
  );

  return {
    notifications,
    pushNotification,
    dismissNotification,
    deliverRealtimeNotification,
    lastEnabledSoundModeRef,
  };
}

function isPageFocused(): boolean {
  return typeof document !== "undefined" &&
    document.visibilityState === "visible" &&
    (typeof document.hasFocus !== "function" || document.hasFocus());
}
