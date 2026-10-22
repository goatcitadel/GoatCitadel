import { useEffect, type MutableRefObject } from "react";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import type { WindowedRecordListHandle } from "../../ui/WindowedRecordList";
import { hasExpired } from "./use-minute-clock";
import type { InboxViewGroupId } from "./inbox-triage";

export const NO_APPROVAL_ACTIONS = "No approval actions for this item.";
export const EXPIRED_APPROVAL = "This approval has expired and can no longer be decided.";
export const NO_SOURCE_LINK = "This item has no source link.";

const KEYS = ["j", "k", "o", "a", "d", "e"];

/**
 * The Inbox letter shortcuts. J/K move the selection, and re-inspect the newly selected item when the inspector
 * already shows an Inbox item (IN-08); O opens details; A/D focus an approval decision; E focuses the source link.
 * A key that does not apply to the selected item says so through the page announcer instead of doing nothing.
 */
export function useInboxShortcuts({
  enabled,
  orderedItems,
  selectedId,
  select,
  inspect,
  inspectorShowsInboxItem,
  groupOf,
  listHandles,
  announce,
}: {
  enabled: boolean;
  orderedItems: OperatorInboxItem[];
  selectedId: string | null;
  select: (id: string) => void;
  inspect: (item: OperatorInboxItem, focusAction?: "approve" | "deny", explicitDetails?: boolean) => void;
  inspectorShowsInboxItem: boolean;
  groupOf: (item: OperatorInboxItem) => InboxViewGroupId;
  listHandles: MutableRefObject<Map<string, WindowedRecordListHandle>>;
  announce: (message: string) => void;
}) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!enabled || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey || !orderedItems.length) return;
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("input, textarea, select, [contenteditable='true']")) return;
      // Any dialog pauses the shortcuts except the phone inspector sheet, which shows the selected Inbox item.
      const dialogs = [...document.querySelectorAll('[role="dialog"]')];
      if (dialogs.some((dialog) => !dialog.querySelector('[data-inspector-body="true"]'))) return;
      const key = event.key.toLowerCase();
      if (!KEYS.includes(key)) return;
      const currentIndex = orderedItems.findIndex((item) => item.id === selectedId);
      const nextIndex =
        currentIndex < 0
          ? 0
          : key === "j"
            ? Math.min(currentIndex + 1, orderedItems.length - 1)
            : key === "k"
              ? Math.max(currentIndex - 1, 0)
              : currentIndex;
      const nextItem = orderedItems[nextIndex];
      if (!nextItem) return;
      event.preventDefault();
      select(nextItem.id);
      const list = listHandles.current.get(groupOf(nextItem));
      if (key === "a" || key === "d") {
        if (nextItem.kind !== "approval") {
          announce(NO_APPROVAL_ACTIONS);
          return;
        }
        if (hasExpired(nextItem.expiresAt, Date.now())) {
          announce(EXPIRED_APPROVAL);
          inspect(nextItem);
          return;
        }
        inspect(nextItem, key === "a" ? "approve" : "deny");
        return;
      }
      if (key === "o") {
        inspect(nextItem, undefined, true);
        return;
      }
      if (key === "e") {
        const row = document.querySelector(`[data-inbox-row="${CSS.escape(nextItem.id)}"]`);
        if (row && !row.querySelector("[data-inbox-owner]")) {
          announce(NO_SOURCE_LINK);
          return;
        }
        list?.focusRecord(nextItem.id, "[data-inbox-owner]");
        return;
      }
      list?.focusRecord(nextItem.id, "[data-inbox-detail]");
      // The open inspector follows the selection, so it never describes a different item than the list (IN-08).
      if (inspectorShowsInboxItem && nextItem.id !== selectedId) inspect(nextItem);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [enabled, orderedItems, selectedId, select, inspect, inspectorShowsInboxItem, groupOf, listHandles, announce]);
}
