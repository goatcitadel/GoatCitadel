import { useEffect } from "react";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { AreaHeader, AreaTabsProvider } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import {
  CAPABILITIES_TABS,
  DEFAULT_TAB,
  capabilitiesTabHref,
  namedCapabilitiesTab,
  readCapabilitiesTab,
} from "./capabilities-tabs";
import { ConnectorsTab } from "./connectors/ConnectorsTab";
import { readLastCapabilitiesTab, writeLastCapabilitiesTab } from "./last-tab-preference";
import { ToolsTab } from "./tools/ToolsTab";

/**
 * The Capabilities area: one page with a tab for each kind of thing GoatCitadel's AI can use. Plain `/capabilities`
 * opens the tab opened last (Connectors the first time) and replaces the address with that tab's.
 */
export function CapabilitiesArea() {
  const { rest, search, hash, navigate } = useCockpitRoute();
  const named = namedCapabilitiesTab(rest);
  const plain = rest.length === 0;
  // Chosen while rendering, so a remembered tab never shows another tab first (and never starts its queries).
  const tab = plain ? (readLastCapabilitiesTab() ?? DEFAULT_TAB) : readCapabilitiesTab(rest);
  useEffect(() => {
    if (plain) navigate(`${capabilitiesTabHref(tab)}${search}${hash}`, { replace: true });
  }, [plain, tab, search, hash, navigate]);
  // Only an address that names a tab is a choice (a click, the palette, a link or a redirect), not the default.
  useEffect(() => {
    if (named) writeLastCapabilitiesTab(named);
  }, [named]);
  return (
    <AreaTabsProvider
      label="Capabilities sections"
      tabs={CAPABILITIES_TABS}
      current={tab}
      navigate={(href) => navigate(href)}
    >
      <section className={`${AREA_PAGE} min-h-full`}>
        <AreaHeader title="Capabilities" description="Everything GoatCitadel's AI can use, in one place." />
        {tab === "connectors" ? <ConnectorsTab /> : null}
        {tab === "tools" ? <ToolsTab /> : null}
      </section>
    </AreaTabsProvider>
  );
}
