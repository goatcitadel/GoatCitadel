import { useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/client";
import { isBaseUrlAllowlisted } from "../../settings/web-search-state";

/** The hosts, of those a channel needs, that the outbound allowlist does not yet allow. The same check Turn on makes. */
export function missingHosts(requiredHosts: readonly string[], allowlist: readonly string[]): string[] {
  return [...new Set(requiredHosts)].filter((host) => !isBaseUrlAllowlisted(`https://${host}/`, allowlist));
}

export interface MissingHosts {
  /** The allowlist has been read, so `missing` names every host Turn on would add. Until then it names none. */
  known: boolean;
  missing: string[];
  /** The allowlist couldn't be read. */
  failed: boolean;
  /** Reads the allowlist again. */
  retry(): void;
}

/**
 * Which of a channel's hosts Turn on will have to add. It reads the settings only once asked to (`enabled`), shares
 * the Web & Search page's settings read so one allowlist is never fetched twice, and names no host until it has read
 * them: the page then says nothing it has not seen, and keeps its button off until `known`.
 */
export function useMissingHosts(requiredHosts: readonly string[] | undefined, enabled: boolean): MissingHosts {
  const settings = useQuery({
    queryKey: ["system", "settings-web-search"],
    queryFn: () => fetchSettings(),
    enabled: enabled && (requiredHosts?.length ?? 0) > 0,
    retry: false,
  });
  const { refetch } = settings;
  const retry = useCallback(() => void refetch(), [refetch]);
  if (requiredHosts?.length === 0) return { known: true, missing: [], failed: false, retry };
  if (requiredHosts && settings.data) {
    return { known: true, missing: missingHosts(requiredHosts, settings.data.networkAllowlist), failed: false, retry };
  }
  return { known: false, missing: [], failed: settings.isError, retry };
}
