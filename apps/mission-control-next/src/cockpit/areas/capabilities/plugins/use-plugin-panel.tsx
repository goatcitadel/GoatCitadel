import { useCallback, useEffect, useRef, type RefObject } from "react";
import type { CapabilityPluginListItem, CapabilityPluginListResponse } from "@goatcitadel/contracts";
import { useInspector } from "../../../app/inspector";
import { useCockpitRoute } from "../../../app/use-cockpit-route";
import { PluginPanel } from "./PluginPanel";
import {
  PLUGINS_HREF,
  pluginIdFromSearch,
  pluginIdFromSource,
  pluginInstallKeyFromSource,
  pluginItemHref,
  pluginPanelSource,
} from "./plugin-links";
import { pluginIdOfInstallKey, pluginInstallKey, usePluginInstallEntry } from "./plugin-install-store";
import { installPanelHolds } from "./use-plugin-install-panel";

/** The plugin whose panel is open, its own or its install panel: both show that plugin at its address. */
function openPluginOf(source: string | undefined): string | undefined {
  return pluginIdFromSource(source) ?? pluginIdOfInstallKey(pluginInstallKeyFromSource(source) ?? "");
}

/**
 * The plugin the address names (`?item=plugin:<id>`) when its panel is the plugin's own: once the list has answered, and
 * unless the install panel holds the address (an install this session follows, or one the list reads as not finished).
 * A plugin the list doesn't have still opens, and says it isn't installed.
 */
function usePanelPlugin(search: string, list: CapabilityPluginListResponse | undefined) {
  const pluginId = pluginIdFromSearch(search);
  const entry = usePluginInstallEntry(pluginId ? pluginInstallKey(pluginId) : undefined);
  if (!pluginId || !list) return undefined;
  const installed = list.installed.find((item) => item.pluginId === pluginId);
  if (installPanelHolds(entry, installed)) return undefined;
  const name = installed?.name ?? list.builtIn.find((item) => item.pluginId === pluginId)?.name;
  return { pluginId, title: name || "Plugin" };
}

/**
 * Opens the panel the address names, once per inspector, and clears the address when that panel is closed. A panel of
 * this plugin already open (its own, or its install panel) is left alone.
 */
function useAddressPanel(
  target: { pluginId: string; title: string } | undefined,
  show: (id: string, title: string) => void,
  asked: RefObject<{ id: string; inspectorOpen: unknown } | null>,
) {
  const { open: openInspector, content } = useInspector();
  const { search, navigate } = useCockpitRoute();
  const linkedId = pluginIdFromSearch(search);
  const openId = openPluginOf(content?.source);
  const shown = useRef<string | null>(null);
  const targetId = target?.pluginId;
  const targetTitle = target?.title;
  useEffect(() => {
    if (openId) {
      shown.current = openId;
      return;
    }
    if (content) return;
    if (!linkedId) {
      asked.current = null;
      shown.current = null;
      return;
    }
    if (shown.current === linkedId) {
      // The panel the address named was on screen and is gone: it was closed.
      shown.current = null;
      navigate(PLUGINS_HREF, { replace: true });
      return;
    }
    const alreadyAsked = asked.current?.id === targetId && asked.current?.inspectorOpen === openInspector;
    if (targetId && targetTitle && !alreadyAsked) show(targetId, targetTitle);
  }, [openId, content, linkedId, targetId, targetTitle, show, asked, openInspector, navigate]);
}

/**
 * Connects the plugin's own panel to the inspector and the address, as the Skills tab's panel does: the address names
 * the plugin, the panel opens once the list has answered, and closing it clears the address. It takes over the address
 * the install panel moves to once a plugin has a record, without opening a second panel over it: while that install
 * panel is on screen it is this plugin's panel, so closing it clears the address too.
 */
export function usePluginPanel(
  list: CapabilityPluginListResponse | undefined,
  onInstall: (item: CapabilityPluginListItem) => void,
): { open: (item: CapabilityPluginListItem) => void } {
  const { open: openInspector } = useInspector();
  const { search, navigate } = useCockpitRoute();
  const asked = useRef<{ id: string; inspectorOpen: unknown } | null>(null);
  const show = useCallback(
    (id: string, title: string) => {
      asked.current = { id, inspectorOpen: openInspector };
      openInspector({
        source: pluginPanelSource(id),
        title,
        body: <PluginPanel pluginId={id} onInstall={onInstall} />,
      });
    },
    [openInspector, onInstall],
  );
  useAddressPanel(usePanelPlugin(search, list), show, asked);
  const linkedId = pluginIdFromSearch(search);
  return {
    open: (item) => {
      // The address already names it (the panel was closed without clearing it): there is nothing to move.
      if (linkedId === item.pluginId) show(item.pluginId, item.name);
      else navigate(pluginItemHref(item.pluginId));
    },
  };
}
