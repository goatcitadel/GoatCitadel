import type { ChannelPickerGroup, ChannelSetupDefinition, ChannelSetupDraft } from "@goatcitadel/contracts";
import { channelSetupHref } from "../../../app/routes";
import { isChatSetupDraft } from "./setup-draft-session";

/** Channels with a setup page of their own in Chat. The picker opens it; the rest are set up in Settings. */
export const CONVERTED_SETUP_CHANNELS: ReadonlySet<string> = new Set(["telegram", "discord", "slack"]);

/**
 * Channels Settings hands every new setup to Chat. Discord and Slack also have a page in Chat, but Settings still
 * starts their other ways (Discord webhook-only, Slack webhook-only and OAuth), so only a draft made on the Chat page
 * goes on there.
 */
export const CHAT_ONLY_SETUP_CHANNELS: ReadonlySet<string> = new Set(["telegram"]);

/**
 * Channels whose key is changed on its own page in Chat. Settings changes every other channel's key. A page in
 * `ChannelSetupView` backs each one; this list is here so the channel page can link to it without loading the pages.
 */
export const KEY_CHANGE_CHANNELS: ReadonlySet<string> = new Set(["telegram"]);

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

/** The channel's own page in Chat, for the picker's tiles. Undefined for a channel that has none. */
export function chatPageHref(definition: Pick<ChannelSetupDefinition, "catalog">): string | undefined {
  const { key } = definition.catalog;
  return CONVERTED_SETUP_CHANNELS.has(key) ? channelSetupHref(key) : undefined;
}

/** Where Settings sends a new setup of a channel it hands to Chat. Settings sets up the rest itself. */
export function chatSetupHref(definition: Pick<ChannelSetupDefinition, "catalog">): string | undefined {
  const { key } = definition.catalog;
  return CHAT_ONLY_SETUP_CHANNELS.has(key) ? channelSetupHref(key) : undefined;
}

/**
 * Where an unfinished new setup goes on: its page in Chat, sent to this very draft, when its channel is set up there
 * only (Telegram), or has a page there and this setup was made on it. A change to a saved channel stays in Settings,
 * and so does a draft for a channel the definitions don't know.
 */
export function chatSetupHrefForDraft(
  draft: Pick<ChannelSetupDraft, "draftId" | "catalogId" | "lifecycleMode" | "connectionId" | "draft">,
  definitions: readonly Pick<ChannelSetupDefinition, "catalog">[],
): string | undefined {
  if (draft.lifecycleMode !== "create" || draft.connectionId) return undefined;
  const definition = definitions.find((candidate) => candidate.catalog.catalogId === draft.catalogId);
  if (!definition) return undefined;
  const { key } = definition.catalog;
  const inChat = CHAT_ONLY_SETUP_CHANNELS.has(key) || (CONVERTED_SETUP_CHANNELS.has(key) && isChatSetupDraft(draft));
  return inChat ? channelSetupHref(key, draft.draftId) : undefined;
}

function tileFor(definition: ChannelSetupDefinition, minutes: number, note: string | undefined): ChannelPickerTile {
  const { key, catalogId, label } = definition.catalog;
  return {
    channelKey: key,
    catalogId,
    label,
    minutes,
    ...(note ? { note } : {}),
    href: chatPageHref(definition) ?? settingsChannelSetupHref(catalogId),
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
