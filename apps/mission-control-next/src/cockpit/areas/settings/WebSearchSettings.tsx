import { useQuery } from "@tanstack/react-query";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { Button } from "../../ui/Button";
import { FirecrawlSettings } from "./FirecrawlSettings";
import { SearchEngineOrderControl } from "./SearchEngineOrderControl";
import { WebSearchKeys } from "./WebSearchKeys";
import { WEB_SEARCH_ANCHOR } from "./web-search-state";

/**
 * Settings › Connections › Web & Search: Firecrawl, native search engines, and web-search API keys.
 * Every change goes through the Gateway's governed settings path; keys go to the OS keychain.
 */
export function WebSearchSettings() {
  const settings = useQuery({
    queryKey: ["system", "settings-web-search"],
    queryFn: fetchSettings,
    refetchInterval: 60_000,
  });
  return (
    <section id={WEB_SEARCH_ANCHOR} aria-labelledby="web-search-title" className="mt-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="web-search-title" className="text-md font-semibold text-fg">
            Web &amp; Search
          </h3>
          <p className="mt-1 text-sm text-fg-secondary">
            How Chat searches the web and reads pages: Firecrawl first when it is on, then the built-in browser with
            your search engines. Every request still needs its host in the outbound allowlist.
          </p>
        </div>
        <Button size="sm" disabled={settings.isFetching} onClick={() => void settings.refetch()}>
          Refresh
        </Button>
      </div>
      <FirecrawlSettings settings={settings} />
      <SearchEngineOrderControl settings={settings} />
      <WebSearchKeys settings={settings} />
    </section>
  );
}
