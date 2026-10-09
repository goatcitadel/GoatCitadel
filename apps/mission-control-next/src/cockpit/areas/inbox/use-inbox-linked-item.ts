import { useEffect, useRef, useSyncExternalStore } from "react";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { readCockpitHistory, subscribeCockpitHistory } from "../../app/cockpit-history";

/**
 * The Inbox item an exact link names: the projected item, or for an approval outside the projection a placeholder.
 * A URL is navigation, not authority: the detail re-reads the scoped canonical record.
 */
export function resolveLinkedInboxItem(
  items: readonly OperatorInboxItem[] | undefined,
  linkedItem: string,
  workspaceId: string,
): OperatorInboxItem | undefined {
  const projected = items?.find((entry) => entry.id === linkedItem);
  if (projected) return projected;
  if (!linkedItem.startsWith("approval:") || linkedItem.length <= 9) return undefined;
  const approvalId = linkedItem.slice(9);
  return {
    id: linkedItem,
    kind: "approval",
    group: "needs_decision",
    title: "Approval",
    summary: "Review the current approval record.",
    createdAt: "",
    source: { workspaceId, approvalId },
    href: `/ops/approvals?approvalId=${encodeURIComponent(approvalId)}&workspaceId=${encodeURIComponent(workspaceId)}&shell=classic`,
  };
}

/** Opens the item an exact Inbox link names once per installation, citadel, workspace, link and history entry. */
export function useInboxLinkedItem(input: {
  installation: string;
  activeCitadelId: string;
  workspaceId: string;
  linkedWorkspace: string | null;
  linkedItem: string | null;
  items: readonly OperatorInboxItem[] | undefined;
  isFetching: boolean;
  inspect: (item: OperatorInboxItem) => void;
  select: (id: string) => void;
}): void {
  const {
    installation,
    activeCitadelId,
    workspaceId,
    linkedWorkspace,
    linkedItem,
    items,
    isFetching,
    inspect,
    select,
  } = input;
  const history = useSyncExternalStore(subscribeCockpitHistory, readCockpitHistory, () => "server");
  const handledLink = useRef<string | null>(null);
  useEffect(() => {
    const key = JSON.stringify([installation, activeCitadelId, workspaceId, linkedWorkspace, linkedItem, history]);
    if (!linkedItem) {
      handledLink.current = null;
      return;
    }
    if (linkedWorkspace !== workspaceId) {
      handledLink.current = null;
      return;
    }
    if (handledLink.current === key) return;
    const item = resolveLinkedInboxItem(items, linkedItem, workspaceId);
    if (!item) return;
    handledLink.current = key;
    select(item.id);
    inspect(item);
  }, [
    items,
    isFetching,
    inspect,
    select,
    installation,
    activeCitadelId,
    workspaceId,
    linkedItem,
    linkedWorkspace,
    history,
  ]);
}
