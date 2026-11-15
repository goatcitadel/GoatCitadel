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
 * History rule: opening an item while none is open pushes one entry, so Back returns to the list with nothing open.
 * Opening another item while one is open (J and K, or Details on another row) replaces that entry, so arrowing never
 * stacks history. Closing the inspector removes the item from the address by replacing the entry. A decision leaves
 * the address as it is, because the open inspector keeps the decided item's receipt; a reload then says the item is
 * no longer in the Inbox. Highlighting a row with nothing open writes nothing.
 *
 * The inspector closes whenever the address changes, so an item is opened once its address has landed: an address
 * that names an item is opened by `useInboxLinkedItem`, with the way the operator asked for it (`takePending`).
 */
export function useInboxSelection(
  workspaceId: string,
  openNow: MutableRefObject<(...args: InboxOpenArguments) => void>,
) {
  const { navigate, search } = useCockpitRoute();
  const inspector = useInspector();
  const [selectedId, selectItem] = useState<string | null>(null);
  const addressItem = new URLSearchParams(search).get("item");
  const showsItem = Boolean(inspector.content?.source?.startsWith("inbox:"));
  const pending = useRef<InboxOpenArguments | null>(null);
  // The item the last write put in the address, so only Back, Forward and an edited address count as outside moves.
  const written = useRef<string | null | undefined>(undefined);

  const write = useCallback(
    (id: string | null, replace: boolean) => {
      const location = readCockpitLocation();
      const href = inboxSelectionHref(location, id, workspaceId);
      if (href === location.pathname + location.search + location.hash) return;
      written.current = id;
      navigate(href, { replace });
    },
    [navigate, workspaceId],
  );

  const inspect = useCallback(
    (...args: InboxOpenArguments) => {
      const named = itemInAddress();
      if (named === args[0].id) {
        pending.current = null;
        openNow.current(...args);
        return;
      }
      pending.current = args;
      write(args[0].id, named !== null);
    },
    [write, openNow],
  );

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
    if (dismissed && !showsItem && addressItem !== null && !pending.current) write(null, true);
  }, [showsItem, addressItem, getDismissalGeneration, write]);

  const takePending = useCallback((id: string) => {
    const open = pending.current;
    pending.current = null;
    return open && open[0].id === id ? open : null;
  }, []);

  return { selectedId, selectItem, inspect, takePending };
}
