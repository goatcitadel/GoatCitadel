import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { ChannelSetupDefinition, ChannelSetupDraft } from "@goatcitadel/contracts";
import { fetchChannelSetupDefinitions } from "@goatcitadel/mission-control-shared/api/client";
import { channelHosts } from "../../../../features/native-routes/settings/channel-setup/channel-wizard-model";
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

/**
 * The hosts a channel's setup must be able to reach, for the setup as it stands: the channel's fixed hosts, the hosts of
 * the conditions its values meet, and the hosts of the addresses entered (`channelHosts`). Undefined until both the
 * catalogue and the draft are there, and for a channel the catalogue doesn't have, because a page cannot say which hosts
 * are missing from what it hasn't seen.
 */
export function useChannelSetupHosts(
  catalogId: string,
  draft: ChannelSetupDraft | null,
): readonly string[] | undefined {
  const definition = useQuery({
    ...definitionsQuery,
    select: (data) => definitionsIn(data).find((candidate) => candidate.catalog.catalogId === catalogId),
  }).data;
  return useMemo(
    () => (definition && draft ? channelHosts(definition, draft, draft.draft) : undefined),
    [definition, draft],
  );
}
