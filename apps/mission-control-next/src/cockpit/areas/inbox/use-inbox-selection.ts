import { useCallback, useEffect, useRef, useState, type MutableRefObject } from "react";
import type { OperatorInboxItem } from "@goatcitadel/contracts";
import { readCockpitLocation } from "../../app/cockpit-back-guard";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { useInspector } from "../../app/inspector";
import { inboxSelectionHref } from "./inbox-selection-url";

export type InboxOpenArguments = [item: OperatorInboxItem, focusAction?: "approve" | "deny", explicitDetails?: boolean];

const itemInAddress = () => new URLSearchParams(readCockpitLocation().search).get("item");

/**
 * Owns the selected Inbox row and keeps the address in step with the item that is open in the inspector, so a
 * reload, a shared link and Back and Forward keep the operator's place.
 *
 * History rule: every write replaces the current entry, so opening, moving (J and K, or Details on another row) and
 * closing never add a history step and Back still leaves the Inbox as it does without an item. The item stays in the
 * address while it is open, so a reload or a copied link keeps it. A decision leaves the address as it is, because
 * the open inspector keeps the decided item's receipt; a reload then says the item is no longer in the Inbox.
 * Highlighting a row with nothing open writes nothing.
 *
 * A move happens only once the navigation owner accepts it (it may ask about unsaved drafts first), so a declined
 * move leaves the old row marked and nothing waiting to open.
 *
 * The inspector closes whenever the address changes, so an item is opened once its address has landed: an address
 * that names an item is opened by `useInboxLinkedItem`, with the way the operator asked for it (`takePending`).
 */
export function useInboxSelection(
  workspaceId: string,
  openNow: MutableRefObject<(...args: InboxOpenArguments) => void>,
) {
  const { requestTransition, search } = useCockpitRoute();
  const inspector = useInspector();
  const [selectedId, selectItem] = useState<string | null>(null);
  const addressItem = new URLSearchParams(search).get("item");
  const showsItem = Boolean(inspector.content?.source?.startsWith("inbox:"));
  const pending = useRef<InboxOpenArguments | null>(null);
  // The item the last write put in the address, so only Back, Forward and an edited address count as outside moves.
  const written = useRef<string | null | undefined>(undefined);

  /** Replaces the address with one naming `id` (or no item), once the navigation owner accepts the move. */
  const write = useCallback(
    (id: string | null, onAccepted?: () => void) => {
      requestTransition((review) => {
        const location = readCockpitLocation();
        const href = inboxSelectionHref(location, id, workspaceId);
        if (href === location.pathname + location.search + location.hash) return;
        onAccepted?.();
        written.current = id;
        if (!review.navigate(href, { replace: true })) pending.current = null;
      });
    },
    [requestTransition, workspaceId],
  );

  const inspect = useCallback(
    (...args: InboxOpenArguments) => {
      const [item] = args;
      if (itemInAddress() === item.id) {
        pending.current = null;
        selectItem(item.id);
        openNow.current(...args);
        return;
      }
      write(item.id, () => {
        pending.current = args;
        selectItem(item.id);
      });
    },
    [write, openNow],
  );

  /** Marks a row for the keyboard. While an item is open the mark follows the panel, so it waits for the move. */
  const showsRef = useRef(showsItem);
  showsRef.current = showsItem;
  const highlight = useCallback((id: string | null) => {
    if (id === null || !showsRef.current) selectItem(id);
  }, []);

  const selectedRef = useRef(selectedId);
  selectedRef.current = selectedId;
  useEffect(() => {
    if (written.current !== undefined && written.current === addressItem) {
      written.current = undefined;
      return;
    }
    written.current = undefined;
    // Back or an edited address left the item: the list shows nothing selected.
    if (addressItem === null && selectedRef.current !== null) selectItem(null);
  }, [addressItem]);

  // A close the operator made (not the close that comes with every address change) counts in this generation.
  const { getDismissalGeneration } = inspector;
  const dismissals = useRef(getDismissalGeneration());
  useEffect(() => {
    const generation = getDismissalGeneration();
    const dismissed = generation !== dismissals.current;
    dismissals.current = generation;
    // The inspector was closed with an item in the address: the address stops naming it.
    if (dismissed && !showsItem && addressItem !== null && !pending.current) write(null);
  }, [showsItem, addressItem, getDismissalGeneration, write]);

  const takePending = useCallback((id: string) => {
    const open = pending.current;
    if (!open || open[0].id !== id) return null;
    pending.current = null;
    return open;
  }, []);

  return { selectedId, selectItem, highlight, inspect, takePending };
}
