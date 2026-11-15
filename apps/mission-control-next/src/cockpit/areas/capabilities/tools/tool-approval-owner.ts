import { useEffect, useSyncExternalStore } from "react";
import type { ToolGroupId } from "@goatcitadel/contracts";

// A group can show in a row, a Most used card and its open panel at once. A change that waits on an approval opens
// that approval in place in exactly one of them, or the operator would see two "Review the change" buttons and two
// dialogs. The open panel is the surface the operator is working in, so it owns the dialog while it is mounted and
// the group's row takes it back when the panel closes. A Most used card never owns it.
const panels = new Map<ToolGroupId, number>();
const listeners = new Set<() => void>();

function publish() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Called by the group's panel while it is mounted: the row steps back from the in-place approval. */
export function useClaimToolApprovalDialog(groupId: ToolGroupId) {
  useEffect(() => {
    panels.set(groupId, (panels.get(groupId) ?? 0) + 1);
    publish();
    return () => {
      const left = (panels.get(groupId) ?? 1) - 1;
      if (left > 0) panels.set(groupId, left);
      else panels.delete(groupId);
      publish();
    };
  }, [groupId]);
}

/** Whether the group's panel is mounted, so its row must not open the approval too. */
export function useToolPanelHoldsApprovalDialog(groupId: ToolGroupId): boolean {
  return useSyncExternalStore(
    subscribe,
    () => panels.has(groupId),
    () => false,
  );
}
