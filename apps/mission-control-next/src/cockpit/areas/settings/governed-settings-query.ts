import { useQuery } from "@tanstack/react-query";
import { fetchSettings } from "@goatcitadel/mission-control-shared/api/client";

/**
 * The one settings read the governed Settings controls (budget preference, model reasoning in Chat and the two
 * Claude Code CLI switches) and the Spend page share. Its literal key stays here so the settings reader inventory
 * (`SETTINGS_READER_KEYS`) sees it: a settings change refreshes it at once, and each control still re-reads it after
 * its own save. Reads that confirm a save are made directly and never use it.
 */
export function useGovernedSettingsQuery() {
  return useQuery({
    queryKey: ["system", "settings-governed"],
    queryFn: fetchSettings,
    refetchInterval: 60_000,
  });
}
