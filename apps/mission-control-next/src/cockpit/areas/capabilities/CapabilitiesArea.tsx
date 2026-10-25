import { useCockpitRoute } from "../../app/use-cockpit-route";
import { AreaHeader, AreaTabsProvider } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { CAPABILITIES_TABS, readCapabilitiesTab } from "./capabilities-tabs";
import { ConnectorsTab } from "./connectors/ConnectorsTab";

/** The Capabilities area: one page with a tab for each kind of thing GoatCitadel's AI can use. */
export function CapabilitiesArea() {
  const { rest, navigate } = useCockpitRoute();
  const tab = readCapabilitiesTab(rest);
  return (
    <AreaTabsProvider
      label="Capabilities sections"
      tabs={CAPABILITIES_TABS}
      current={tab}
      navigate={(href) => navigate(href)}
    >
      <section className={`${AREA_PAGE} min-h-full`}>
        <AreaHeader title="Capabilities" description="Everything GoatCitadel's AI can use, in one place." />
        {/* Each row's button has nothing to open until the connector panel lands. */}
        {tab === "connectors" ? <ConnectorsTab onOpen={() => undefined} /> : null}
      </section>
    </AreaTabsProvider>
  );
}
