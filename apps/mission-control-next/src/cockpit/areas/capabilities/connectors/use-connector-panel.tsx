import { useCallback, useEffect, useRef } from "react";
import type { CapabilityConnectorItem } from "@goatcitadel/contracts";
import { useInspector } from "../../../app/inspector";
import { useCockpitRoute } from "../../../app/use-cockpit-route";
import { ConnectorPanel } from "./ConnectorPanel";
import {
  CONNECTORS_HREF,
  connectorIdFromSource,
  connectorItemHref,
  connectorPanelSource,
  readLinkedConnectorId,
  savedConnectorForTemplate,
} from "./connector-links";

/**
 * Connects the Connectors tab to the inspector. The address says which connector is open (`?item=`): pressing a row
 * moves the address, and the panel opens when the address names a connector the loaded list has. Closing the panel
 * clears the address again, so the same row can be pressed once more and a reload doesn't bring the panel back.
 * An address that names a template already installed opens the panel too: it shows the saved server (R80), and it
 * keeps the address's own id so closing it clears that address.
 *
 * The inspector closes whenever the address changes, so the panel always opens after the move, never before it.
 */
export function useConnectorPanel(
  items: readonly CapabilityConnectorItem[] | undefined,
  /** Called when the open connector was removed. Keep it stable: the panel keeps the one it was opened with. */
  onRemoved?: () => void,
): {
  open: (item: CapabilityConnectorItem) => void;
} {
  const { open: openInspector, content } = useInspector();
  const { search, navigate } = useCockpitRoute();
  const linkedId = readLinkedConnectorId(search);
  const openId = connectorIdFromSource(content?.source);
  const linked = linkedId
    ? (items?.find((entry) => entry.id === linkedId) ?? savedConnectorForTemplate(items, linkedId))
    : undefined;
  // The panel this page last asked the inspector for (and with which inspector: a new address brings a new one, and a
  // request made to the old one is lost), and the address whose panel has been on screen.
  const asked = useRef<{ id: string; inspectorOpen: typeof openInspector } | null>(null);
  const shown = useRef<string | null>(null);

  const show = useCallback(
    (id: string, name: string) => {
      asked.current = { id, inspectorOpen: openInspector };
      openInspector({
        source: connectorPanelSource(id),
        title: name,
        body: <ConnectorPanel itemId={id} onRemoved={onRemoved} />,
      });
    },
    [openInspector, onRemoved],
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
      navigate(CONNECTORS_HREF, { replace: true });
      return;
    }
    // An address naming a connector the list doesn't have is left alone.
    const alreadyAsked = asked.current?.id === linkedId && asked.current.inspectorOpen === openInspector;
    if (linked && !alreadyAsked) show(linkedId, linked.name);
  }, [openId, linkedId, linked, show, openInspector, navigate]);

  return {
    open: (item) => {
      // The address already names it (the panel was closed without clearing it): there is nothing to move.
      if (linkedId === item.id) show(item.id, item.name);
      else navigate(connectorItemHref(item.id));
    },
  };
}
