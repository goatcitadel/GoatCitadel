import { useQuery } from "@tanstack/react-query";
import { fetchChannelSetupDefinitions } from "@goatcitadel/mission-control-shared/api/client";
import { queryKeys } from "../../../data/query-keys";
import { buildChannelPickerGroups } from "./channel-picker-model";

/**
 * The channels the add-channel pages offer, grouped for the picker. The catalogue is fixed for a GoatCitadel version,
 * so it is read once and kept; the picker and a channel's setup page share the one read. It reads no settings, so it
 * is not a settings reader.
 */
export function useChannelPickerGroups() {
  const query = useQuery({
    queryKey: queryKeys.channelSetupDefinitions(),
    queryFn: () => fetchChannelSetupDefinitions(),
    staleTime: Infinity,
    select: (data) => buildChannelPickerGroups(Array.isArray(data?.items) ? data.items : []),
  });
  return { groups: query.data, isPending: query.isPending, isError: query.isError, refetch: query.refetch };
}
