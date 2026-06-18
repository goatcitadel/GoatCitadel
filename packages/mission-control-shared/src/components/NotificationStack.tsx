import { memo } from "react";

export interface NotificationItem {
  id: string;
  tone: "info" | "success" | "warning" | "error";
  message: string;
  timestamp: number;
  groupKey?: string;
  count?: number;
}

export function upsertNotificationItem(
  current: NotificationItem[],
  incoming: NotificationItem,
  maxItems = 6,
): NotificationItem[] {
  const matchIndex = current.findIndex((item) =>
    incoming.groupKey
      ? item.groupKey === incoming.groupKey
      : item.tone === incoming.tone && item.message === incoming.message,
  );

  if (matchIndex === -1) {
    return [{ ...incoming, count: incoming.count ?? 1 }, ...current].slice(0, maxItems);
  }

  const matched = current[matchIndex]!;
  const nextCount =
    matched.tone === incoming.tone && matched.message === incoming.message ? (matched.count ?? 1) + 1 : 1;
  const nextItem: NotificationItem = {
    ...incoming,
    id: matched.id,
    count: nextCount,
  };

  return [nextItem, ...current.filter((_, index) => index !== matchIndex)].slice(0, maxItems);
}

interface NotificationStackProps {
  items: NotificationItem[];
  onDismiss: (id: string) => void;
}

function NotificationStackInner({ items, onDismiss }: NotificationStackProps) {
  if (items.length === 0) {
    return null;
  }

  const toneLabels: Record<NotificationItem["tone"], string> = {
    info: "Info",
    success: "Success",
    warning: "Warning",
    error: "Error",
  };

  return (
    <div className="notification-stack">
      {items.map((item) => (
        <div
          key={item.id}
          className={`notification-item ${item.tone}`}
          role={item.tone === "error" || item.tone === "warning" ? "alert" : "status"}
          aria-live={item.tone === "error" || item.tone === "warning" ? "assertive" : "polite"}
          aria-atomic="true"
        >
          <div className="notification-copy">
            <p className="notification-tone">
              {toneLabels[item.tone]}
              {item.count && item.count > 1 ? <span className="notification-count">x{item.count}</span> : null}
            </p>
            <p>{item.message}</p>
            <span>{new Date(item.timestamp).toLocaleTimeString()}</span>
          </div>
          <button
            type="button"
            className="gc-button notification-dismiss"
            onClick={() => onDismiss(item.id)}
            aria-label="Dismiss notification"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

export const NotificationStack = memo(NotificationStackInner);
