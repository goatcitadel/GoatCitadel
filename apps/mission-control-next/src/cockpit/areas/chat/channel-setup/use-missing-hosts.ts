import { useQuery } from "@tanstack/react-query";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { isBaseUrlAllowlisted } from "../../settings/web-search-state";

/** The hosts, of those a channel needs, that the outbound allowlist does not yet allow. The same check Turn on makes. */
export function missingHosts(requiredHosts: readonly string[], allowlist: readonly string[]): string[] {
  return [...new Set(requiredHosts)].filter((host) => !isBaseUrlAllowlisted(`https://${host}/`, allowlist));
}

/**
 * Which of a channel's hosts Turn on will have to add. It reads the settings only once asked to (`enabled`), shares
 * the Web & Search page's settings read so one allowlist is never fetched twice, and names no host when it cannot
 * read them: the page then says nothing rather than something it has not seen.
 */
export function useMissingHosts(requiredHosts: readonly string[] | undefined, enabled: boolean): string[] {
  const settings = useQuery({
    queryKey: ["system", "settings-web-search"],
    queryFn: () => fetchSettings(),
    enabled: enabled && (requiredHosts?.length ?? 0) > 0,
    retry: false,
  });
  return requiredHosts && settings.data ? missingHosts(requiredHosts, settings.data.networkAllowlist) : [];
}
