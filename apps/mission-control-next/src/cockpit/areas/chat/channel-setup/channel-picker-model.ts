import type { ChannelPickerGroup, ChannelSetupDefinition } from "@goatcitadel/contracts";
import { channelSetupHref } from "../../../app/routes";

/** Channels whose setup runs on its own page in Chat. The rest are set up in Settings. */
export const CONVERTED_SETUP_CHANNELS: ReadonlySet<string> = new Set(["telegram"]);

export interface ChannelPickerTile {
  /** The channel's catalog key, as it appears in the add-channel address. */
  channelKey: string;
  catalogId: string;
  label: string;
  minutes: number;
  note?: string;
  href: string;
}

export interface ChannelPickerGroupView {
  id: ChannelPickerGroup;
  title: string;
  tiles: ChannelPickerTile[];
}

/** Groups appear in this order. */
const GROUPS: readonly { id: ChannelPickerGroup; title: string }[] = [
  { id: "quickest", title: "Quickest" },
  { id: "team_chat", title: "Team and self-hosted chat" },
  { id: "phone_apps", title: "Phone apps" },
];

/** Where Settings sets up a channel that has no page of its own in Chat. */
export function settingsChannelSetupHref(catalogId: string): string {
  return `/settings/connections?channel=${encodeURIComponent(catalogId)}#channels`;
}

function tileFor(definition: ChannelSetupDefinition, minutes: number, note: string | undefined): ChannelPickerTile {
  const { key, catalogId, label } = definition.catalog;
  return {
    channelKey: key,
    catalogId,
    label,
    minutes,
    ...(note ? { note } : {}),
    href: CONVERTED_SETUP_CHANNELS.has(key) ? channelSetupHref(key) : settingsChannelSetupHref(catalogId),
  };
}

/**
 * The picker's groups and tiles. A group lists its tiles by the definition's `picker.order`, never by the order the
 * list arrived in; a definition without a picker hint is not offered; a group with no tiles is left out.
 */
export function buildChannelPickerGroups(definitions: readonly ChannelSetupDefinition[]): ChannelPickerGroupView[] {
  const offered = definitions.flatMap((definition) => {
    const { picker, estimatedMinutes } = definition.wizard;
    if (!picker) return [];
    return [
      {
        group: picker.group,
        order: picker.order,
        tile: tileFor(definition, picker.minutes ?? estimatedMinutes, picker.note),
      },
    ];
  });
  return GROUPS.flatMap(({ id, title }) => {
    const tiles = offered
      .filter((entry) => entry.group === id)
      .sort((a, b) => a.order - b.order || a.tile.label.localeCompare(b.tile.label))
      .map((entry) => entry.tile);
    return tiles.length ? [{ id, title, tiles }] : [];
  });
}
