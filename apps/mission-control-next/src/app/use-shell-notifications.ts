import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import {
  upsertNotificationItem,
  type NotificationItem,
} from "@goatcitadel/mission-control-shared/components/NotificationStack";
import type { UiNotificationPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import type { deriveRealtimeNotification } from "@goatcitadel/mission-control-shared/state/realtime-derived";
import { playOperatorAttentionSound } from "@goatcitadel/mission-control-shared/state/operator-attention";

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

export interface UseShellNotificationsOptions {
  notificationPreferences: UiNotificationPreferences;
}

export interface UseShellNotificationsResult {
  notifications: NotificationItem[];
  pushNotification: (tone: NotificationItem["tone"], message: string, groupKey?: string) => void;
  dismissNotification: (id: string) => void;
  deliverRealtimeNotification: (notification: RealtimeNotificationDescriptor) => void;
  /**
   * Live ref to the operator's last enabled sound preset. Read at click time
   * so toggling notifications back on restores whichever preset was active
   * before the last "off" transition.
   */
  lastEnabledSoundModeRef: MutableRefObject<"subtle" | "normal">;
}

export function useShellNotifications(options: UseShellNotificationsOptions): UseShellNotificationsResult {
  const { notificationPreferences } = options;
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

  useEffect(() => {
    preferencesRef.current = notificationPreferences;
    if (notificationPreferences.soundMode !== "off") {
      lastEnabledSoundModeRef.current = notificationPreferences.soundMode;
    }
  }, [notificationPreferences]);

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

  const deliverRealtimeNotification = useCallback(
    (notification: RealtimeNotificationDescriptor) => {
      if (!notification) {
        return;
      }
      // Read the latest preferences from the ref so this callback stays stable
      // (see `preferencesRef` above): the event-stream subscription must not
      // reconnect when the operator only toggles a notification preference.
      const preferences = preferencesRef.current;
      const shouldDeliver =
        !preferences.onlyWhenUnfocused || (typeof document !== "undefined" && document.visibilityState !== "visible");
      if (!shouldDeliver) {
        return;
      }
      if (preferences.toastsEnabled) {
        pushNotification(notification.tone, notification.message, notification.groupKey);
      }
      void playOperatorAttentionSound(notification.soundCue, preferences.soundMode);
      if (preferences.desktopEnabled) {
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

function showBrowserNotification(message: string, tone: NotificationItem["tone"]): void {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return;
  }
  const NotificationCtor = window.Notification;
  if (NotificationCtor.permission !== "granted") {
    return;
  }
  const title = tone === "error" ? "GoatCitadel needs attention" : "GoatCitadel";
  try {
    new NotificationCtor(title, { body: message });
  } catch (error) {
    void error;
    // Browser or host notification permissions can change after settings are saved.
  }
}
