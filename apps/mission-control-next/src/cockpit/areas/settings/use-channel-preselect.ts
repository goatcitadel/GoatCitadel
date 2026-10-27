import { useEffect, useRef } from "react";
import type { ChannelSettingsOwner } from "../../../features/native-routes/settings/sections/use-channel-settings";

/** The query parameter Messaging's picker uses to name the channel it sends an operator to set up here. */
const CHANNEL_PARAM = "channel";

type PreselectOwner = Pick<ChannelSettingsOwner, "data" | "setPanel" | "setCreateCatalogId">;

/**
 * Opens the create panel with the channel named by `?channel=` already chosen. It acts once for each named channel,
 * after the setup definitions have loaded, and only for a channel that has one; an unknown name changes nothing.
 * It only selects: no draft exists until the operator starts guided setup. Because it never runs again for the same
 * name, a later choice or a refresh is not overridden.
 */
export function useChannelPreselect({ data, setPanel, setCreateCatalogId }: PreselectOwner, search: string) {
  const handled = useRef<string | null>(null);
  useEffect(() => {
    if (!data) return;
    const catalogId = new URLSearchParams(search).get(CHANNEL_PARAM);
    if (!catalogId || handled.current === catalogId) return;
    handled.current = catalogId;
    if (!data.definitions.some((item) => item.catalog.catalogId === catalogId)) return;
    setPanel("create");
    setCreateCatalogId(catalogId);
  }, [data, search, setPanel, setCreateCatalogId]);
}
