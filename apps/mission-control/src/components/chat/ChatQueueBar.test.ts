import { describe, expect, it } from "vitest";
import { buildVisibleQueueItems, MAX_VISIBLE_QUEUE_ITEMS, type ChatQueueItemView } from "./ChatQueueBar";

function makeItem(id: string, action: ChatQueueItemView["action"]): ChatQueueItemView {
  return {
    id,
    action,
    label: `Item ${id}`,
    createdAt: "2026-04-04T00:00:00.000Z",
  };
}

describe("buildVisibleQueueItems", () => {
  it("returns all queue items when the queue is within the visible cap", () => {
    const items = [makeItem("1", "send"), makeItem("2", "retry")];
    expect(buildVisibleQueueItems(items)).toEqual(items);
  });

  it("caps visible queue items and appends a summary row", () => {
    const items = [
      makeItem("1", "send"),
      makeItem("2", "edit"),
      makeItem("3", "retry"),
      makeItem("4", "send"),
    ];

    const visible = buildVisibleQueueItems(items);

    expect(visible).toHaveLength(MAX_VISIBLE_QUEUE_ITEMS);
    expect(visible.at(-1)?.id).toBe("__overflow__");
    expect(visible.at(-1)?.label).toBe("+2 more queued");
  });
});
