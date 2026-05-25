export interface ChatQueueItemView {
  id: string;
  action: "send" | "edit" | "retry";
  label: string;
  createdAt: string;
  paused?: boolean;
}

export const MAX_VISIBLE_QUEUE_ITEMS = 3;

function formatQueueAction(action: ChatQueueItemView["action"]): string {
  switch (action) {
    case "edit":
      return "Edit queued";
    case "retry":
      return "Retry queued";
    default:
      return "Reply queued";
  }
}

function summarizeOverflowItems(items: ChatQueueItemView[]): ChatQueueItemView | null {
  if (items.length <= MAX_VISIBLE_QUEUE_ITEMS) {
    return null;
  }
  const hiddenItems = items.slice(MAX_VISIBLE_QUEUE_ITEMS - 1);
  return {
    id: "__overflow__",
    action: "send",
    label: `+${hiddenItems.length} more queued`,
    createdAt: hiddenItems[0]?.createdAt ?? new Date().toISOString(),
    paused: hiddenItems.some((item) => item.paused),
  };
}

export function buildVisibleQueueItems(items: ChatQueueItemView[]): ChatQueueItemView[] {
  const overflowItem = summarizeOverflowItems(items);
  return overflowItem ? [...items.slice(0, MAX_VISIBLE_QUEUE_ITEMS - 1), overflowItem] : items;
}

export function ChatQueueBar({
  items,
  title = "Queue",
  onResumeAll,
  onRemove,
}: {
  items: ChatQueueItemView[];
  title?: string;
  onResumeAll: () => void;
  onRemove: (id: string) => void;
}) {
  if (items.length === 0) {
    return null;
  }
  const pausedCount = items.filter((item) => item.paused).length;
  const visibleItems = buildVisibleQueueItems(items);
  return (
    <div className="chat-v11-queue-bar mc-queue-bar">
      <div className="chat-v11-queue-header mc-queue-bar-header">
        <strong>{title}</strong>
        <span>{items.length} pending</span>
        {pausedCount > 0 ? (
          <button type="button" onClick={onResumeAll} className="gc-button">
            {title === "Queued messages" ? "Resume queued messages" : "Resume queue"}
          </button>
        ) : null}
      </div>
      <ul className="chat-v11-queue-list mc-queue-bar-list">
        {visibleItems.map((item) => (
          <li key={item.id}>
            <div>
              <strong>{item.label}</strong>
              <p>
                {item.id === "__overflow__"
                  ? "Additional queued work stays staged until the current turn finishes."
                  : `${formatQueueAction(item.action)}${item.paused ? " · paused after reload" : ""}`}
              </p>
            </div>
            {item.id === "__overflow__" ? null : (
              <button type="button" onClick={() => onRemove(item.id)} className="gc-button">
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
