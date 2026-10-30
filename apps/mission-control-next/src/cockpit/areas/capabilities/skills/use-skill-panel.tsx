import { useCallback, useEffect, useRef } from "react";
import type { CapabilitySkillItem } from "@goatcitadel/contracts";
import { useInspector } from "../../../app/inspector";
import { useCockpitRoute } from "../../../app/use-cockpit-route";
import { SkillPanel } from "./SkillPanel";
import {
  skillIdFromSearch,
  skillIdFromSource,
  skillItemHref,
  skillPanelSource,
  skillsHref,
  skillsViewFromSearch,
} from "./skill-links";

/**
 * Connects the Skills tab to the inspector, the way the Tools tab does it. The address says which skill is open
 * (`?item=skill:<id>`): pressing a View button moves the address, and the panel opens when the address names a skill
 * the loaded list has. Closing the panel clears the address again, so the same button can be pressed once more and a
 * reload doesn't bring the panel back. An address that names no skill, or one the list doesn't have, is left alone.
 * Both moves keep the view the tab is on (`?view=discover`), so a panel opened from Discover closes back to it.
 *
 * The inspector closes whenever the address changes, so the panel always opens after the move, never before it. It
 * also takes keyboard focus back to the View button that opened it when it closes, so nothing here moves focus.
 *
 * The panel reads only sources that start with the Skills prefix, and the Connectors and Tools tabs read only their
 * own, so none of them opens another's panel.
 *
 * `onSearch` puts a text in the tab's search: a tag pressed in the panel searches the tab and closes the panel.
 */
export function useSkillPanel(
  items: readonly CapabilitySkillItem[] | undefined,
  onSearch: (text: string) => void,
): { open: (skillId: string, fallbackName?: string) => void } {
  const { open: openInspector, close: closeInspector, content } = useInspector();
  const { search, navigate } = useCockpitRoute();
  const linkedId = skillIdFromSearch(search);
  const view = skillsViewFromSearch(search);
  const openId = skillIdFromSource(content?.source);
  const linked = linkedId ? items?.find((entry) => entry.skillId === linkedId) : undefined;
  // The panel this page last asked the inspector for (and with which inspector: a new address brings a new one, and a
  // request made to the old one is lost), and the skill whose panel has been on screen.
  const asked = useRef<{ id: string; inspectorOpen: typeof openInspector } | null>(null);
  const shown = useRef<string | null>(null);

  const searchTag = useCallback(
    (tag: string) => {
      onSearch(tag);
      closeInspector();
    },
    [onSearch, closeInspector],
  );

  const show = useCallback(
    (id: string, name: string) => {
      asked.current = { id, inspectorOpen: openInspector };
      // Beside the Installed list the skill's row announces its switch, so the docked panel stays quiet. Discover has no
      // row for it, so a panel opened from there announces its own notes. A change of view closes the panel, so the view
      // seen here is the one the panel lives in.
      const announce = view === "discover";
      openInspector({
        source: skillPanelSource(id),
        title: name,
        body: <SkillPanel skillId={id} onTag={searchTag} announce={announce} />,
      });
    },
    [openInspector, searchTag, view],
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
      navigate(skillsHref(view), { replace: true });
      return;
    }
    const alreadyAsked = asked.current?.id === linkedId && asked.current.inspectorOpen === openInspector;
    if (linked && !alreadyAsked) show(linkedId, linked.name);
  }, [openId, linkedId, linked, show, openInspector, navigate, view]);

  return {
    // `fallbackName` is for a caller that names a skill the loaded list may not hold (Discover names an installed skill by
    // the id the Gateway gave it). The panel opens for it at once, and says the skill isn't in the list, rather than the
    // press doing nothing.
    open: (skillId, fallbackName) => {
      const item = items?.find((entry) => entry.skillId === skillId);
      // The address already names it (the panel was closed without clearing it): there is nothing to move.
      if (linkedId === skillId && item) show(skillId, item.name);
      else if (!item && fallbackName) show(skillId, fallbackName);
      else navigate(skillItemHref(skillId, view));
    },
  };
}
