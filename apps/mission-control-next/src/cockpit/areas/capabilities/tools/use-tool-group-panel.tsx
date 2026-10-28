import { useCallback, useEffect, useRef } from "react";
import type { CapabilityToolGroupItem, ToolGroupId } from "@goatcitadel/contracts";
import { useInspector } from "../../../app/inspector";
import { useCockpitRoute } from "../../../app/use-cockpit-route";
import { ToolGroupPanel } from "./ToolGroupPanel";
import {
  TOOLS_HREF,
  toolGroupIdFromSearch,
  toolGroupIdFromSource,
  toolGroupItemHref,
  toolPanelSource,
} from "./tool-links";

/**
 * Connects the Tools tab to the inspector, the way the Connectors tab does it. The address says which group is open
 * (`?item=group:<id>`): pressing a View button moves the address, and the panel opens when the address names a group
 * the loaded list has. Closing the panel clears the address again, so the same button can be pressed once more and a
 * reload doesn't bring the panel back. An address that names no group, or one the list doesn't have, is left alone.
 *
 * The inspector closes whenever the address changes, so the panel always opens after the move, never before it. It
 * also takes keyboard focus back to the button that opened it when it closes (it keeps the focused control when it
 * opens), so nothing here moves focus: a group has two View buttons, its row's and its Most used card's, and
 * whichever was pressed gets focus back.
 *
 * The panel reads only sources that start with the Tools prefix, and the Connectors tab reads only its own, so
 * neither opens the other's panel.
 */
export function useToolGroupPanel(groups: readonly CapabilityToolGroupItem[] | undefined): {
  open: (groupId: ToolGroupId) => void;
} {
  const { open: openInspector, content } = useInspector();
  const { search, navigate } = useCockpitRoute();
  const linkedId = toolGroupIdFromSearch(search);
  const openId = toolGroupIdFromSource(content?.source);
  const linked = linkedId ? groups?.find((entry) => entry.groupId === linkedId) : undefined;
  // The panel this page last asked the inspector for (and with which inspector: a new address brings a new one, and a
  // request made to the old one is lost), and the group whose panel has been on screen.
  const asked = useRef<{ id: ToolGroupId; inspectorOpen: typeof openInspector } | null>(null);
  const shown = useRef<ToolGroupId | null>(null);

  const show = useCallback(
    (id: ToolGroupId, label: string) => {
      asked.current = { id, inspectorOpen: openInspector };
      openInspector({ source: toolPanelSource(id), title: label, body: <ToolGroupPanel groupId={id} /> });
    },
    [openInspector],
  );

  useEffect(() => {
    if (openId) {
      shown.current = openId;
      return;
    }
    if (!linkedId) {
      asked.current = null;
      shown.current = null;
      return;
    }
    if (shown.current === linkedId) {
      // The panel the address asked for was on screen and is gone: it was closed.
      shown.current = null;
      navigate(TOOLS_HREF, { replace: true });
      return;
    }
    const alreadyAsked = asked.current?.id === linkedId && asked.current.inspectorOpen === openInspector;
    if (linked && !alreadyAsked) show(linkedId, linked.label);
  }, [openId, linkedId, linked, show, openInspector, navigate]);

  return {
    open: (groupId) => {
      const group = groups?.find((entry) => entry.groupId === groupId);
      // The address already names it (the panel was closed without clearing it): there is nothing to move.
      if (linkedId === groupId && group) show(groupId, group.label);
      else navigate(toolGroupItemHref(groupId));
    },
  };
}
