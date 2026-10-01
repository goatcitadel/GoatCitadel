import { useEffect, useRef, useState } from "react";

type DesktopPermission = "unsupported" | NotificationPermission;

function readDesktopPermission(): DesktopPermission {
  if (typeof window === "undefined" || !("Notification" in window)) return "unsupported";
  return window.Notification.permission;
}

export function describeDesktopPermission(permission: DesktopPermission): string {
  switch (permission) {
    case "granted": return "Allowed by your browser or host.";
    case "denied": return "Blocked by your browser or host. Change this site's notification permission in host settings.";
    case "default": return "Not decided yet. Check permission to allow system notifications.";
    case "unsupported": return "This browser or host does not support system notifications.";
  }
}

/** Host permission is independent of the saved preference in both settings shells. */
export function useDesktopNotifications() {
  const [desktopPermission, setDesktopPermission] = useState(readDesktopPermission);
  const [notificationFeedback, setNotificationFeedback] = useState<string | null>(null);
  const [checkingPermission, setCheckingPermission] = useState(false);
  const lifecycle = useRef({ generation: 0, mounted: false, checking: false });
  useEffect(() => {
    const current = lifecycle.current;
    current.mounted = true;
    const refresh = () => setDesktopPermission(readDesktopPermission());
    refresh();
    window.addEventListener?.("focus", refresh);
    if (typeof document !== "undefined") document.addEventListener?.("visibilitychange", refresh);
    return () => {
      current.mounted = false;
      current.generation += 1;
      window.removeEventListener?.("focus", refresh);
      if (typeof document !== "undefined") document.removeEventListener?.("visibilitychange", refresh);
    };
  }, []);

  const checkDesktopPermission = async () => {
    const lifetime = lifecycle.current;
    if (!lifetime.mounted || lifetime.checking) return;
    lifetime.checking = true;
    const generation = lifetime.generation;
    const current = () => lifetime.mounted && lifetime.generation === generation;
    setCheckingPermission(true);
    try {
      const permission = readDesktopPermission();
      if (permission === "unsupported") {
        setDesktopPermission(permission);
        setNotificationFeedback("System notifications are unavailable in this host.");
        return;
      }
      const next = permission === "default" ? await window.Notification.requestPermission() : permission;
      if (!current()) return;
      setDesktopPermission(next);
      setNotificationFeedback(next === "granted" ? "System notifications are allowed."
        : next === "denied" ? "System notifications are blocked by the browser or host." : "Permission was not changed.");
    } catch {
      if (current()) {
        setDesktopPermission(readDesktopPermission());
        setNotificationFeedback("The host could not check notification permission.");
      }
    } finally {
      lifetime.checking = false;
      if (current()) setCheckingPermission(false);
    }
  };

  const sendTestNotification = () => {
    if (!lifecycle.current.mounted) return;
    const permission = readDesktopPermission();
    setDesktopPermission(permission);
    if (permission !== "granted") {
      setNotificationFeedback("Allow system notifications before sending a test.");
      return;
    }
    try {
      new window.Notification("GoatCitadel test notification", {
        body: "System notifications are working in this host.",
      });
      setNotificationFeedback("Test notification requested. Check your host's notification area.");
    } catch {
      setNotificationFeedback("The host could not display a test notification.");
    }
  };

  return { desktopPermission, notificationFeedback, checkingPermission, checkDesktopPermission, sendTestNotification };
}
