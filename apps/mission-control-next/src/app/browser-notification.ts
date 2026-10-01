/** Delivery uses existing host permission; it never prompts for permission from a runtime event. */
export function showBrowserNotification(message: string, tone: "info" | "success" | "warning" | "error",
  options?: { tag: string; onClick: () => void }): void {
  if (typeof window === "undefined" || !("Notification" in window)) return;
  const NotificationCtor = window.Notification;
  if (NotificationCtor.permission !== "granted") return;
  const title = tone === "error" ? "GoatCitadel needs attention" : "GoatCitadel";
  try {
    const notification = new NotificationCtor(title, { body: message, ...(options ? { tag: options.tag } : {}) });
    if (options) notification.onclick = () => { options.onClick(); notification.close(); };
  } catch { /* Host permissions can change after preferences are saved. */ }
}
