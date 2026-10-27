import { useQuery } from "@tanstack/react-query";
import type { ChannelSetupDefinition } from "@goatcitadel/contracts";
import { fetchChannelSetupDefinitions } from "@goatcitadel/mission-control-shared/api/client";
import { queryKeys } from "../../../data/query-keys";
import { buildChannelPickerGroups } from "./channel-picker-model";

/**
 * The channel catalogue, read once and kept. It is fixed for a GoatCitadel version, so the picker and a channel's
 * setup page share the one read and no event refreshes it. It reads no settings, so it is not a settings reader.
 */
const definitionsQuery = {
  queryKey: queryKeys.channelSetupDefinitions(),
  queryFn: () => fetchChannelSetupDefinitions(),
  staleTime: Infinity,
} as const;

const definitionsIn = (data: { items?: ChannelSetupDefinition[] } | undefined): ChannelSetupDefinition[] =>
  Array.isArray(data?.items) ? data.items : [];

/** The channels the add-channel pages offer, grouped for the picker. */
export function useChannelPickerGroups() {
  const query = useQuery({ ...definitionsQuery, select: (data) => buildChannelPickerGroups(definitionsIn(data)) });
  return { groups: query.data, isPending: query.isPending, isError: query.isError, refetch: query.refetch };
}

/**
 * The hosts GoatCitadel must be able to reach for one channel, from the same catalogue read. Undefined until the
 * catalogue has loaded, and empty for a channel that names none or is not in it.
 */
export function useChannelRequiredHosts(catalogId: string): readonly string[] | undefined {
  return useQuery({
    ...definitionsQuery,
    select: (data) =>
      definitionsIn(data).find((definition) => definition.catalog.catalogId === catalogId)?.wizard.requiredHosts ?? [],
  }).data;
}
