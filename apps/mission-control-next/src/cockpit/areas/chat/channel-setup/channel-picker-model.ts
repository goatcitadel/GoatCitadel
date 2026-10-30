import type {
  ChannelPickerGroup,
  ChannelSetupDefinition,
  ChannelSetupDraft,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { channelAdvancedSetupHref, channelSetupHref } from "../../../app/routes";
import { isChatSetupDraft } from "./setup-draft-session";

/**
 * Channels with a setup page of their own in Chat. The picker opens it; the rest are set up in Advanced channel setup.
 */
export const CONVERTED_SETUP_CHANNELS: ReadonlySet<string> = new Set(["telegram", "discord", "slack", "whatsapp"]);

/**
 * Channels Advanced channel setup hands every new setup to their own page. Discord, Slack and WhatsApp also have a
 * page, but Advanced channel setup still starts their other ways (Discord webhook-only, Slack webhook-only and OAuth,
 * WhatsApp's own steps), so only a draft made on the channel's page goes on there.
 */
export const CHAT_ONLY_SETUP_CHANNELS: ReadonlySet<string> = new Set(["telegram"]);

/**
 * Channels whose key is changed on its own page in Chat. Advanced channel setup changes every other channel's key. A
 * page in `ChannelSetupView` backs each one; this list is here so the channel page can link to it without loading the
 * pages.
 */
export const KEY_CHANGE_CHANNELS: ReadonlySet<string> = new Set(["telegram", "discord", "slack", "whatsapp"]);

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/**
 * Whether a Discord connection receives through its bot, so it has a bot token to change. This mirrors the gateway's own
 * reading of a saved connection (`inferDiscordConfigRuntimeMode`, which setup hydrates a connection with): a saved
 * "gateway" or "bridge" decides; without one a bot token or its variable name (also under the older `token` keys)
 * means the bot, and a webhook alone, or nothing, means the webhook-only bridge. The public config shows a secret as
 * a marker or a name, never its value, which is all this needs.
 */
function discordUsesBot(config: Readonly<Record<string, unknown>>): boolean {
  const mode = textOf(config.runtimeMode);
  if (mode === "gateway" || mode === "bridge") return mode === "gateway";
  return ["botToken", "botTokenEnv", "token", "tokenEnv"].some((key) => textOf(config[key]) !== undefined);
}

/**
 * Whether a WhatsApp connection keeps what the page's check asks Meta with besides the new token: the number's, the
 * account's and the app's IDs, and the app secret (or the variable that holds it). The page replaces the access token
 * alone and reads the rest from the saved connection, as the gateway's check does. A connection saved without them,
 * such as a send-only one made in Advanced channel setup, cannot be checked there. The public config shows a secret as
 * a marker or a name, never its value, which is all this needs.
 */
function whatsAppKeepsCheckDetails(config: Readonly<Record<string, unknown>>): boolean {
  const ids = ["phoneNumberId", "businessAccountId", "appId"].every((key) => textOf(config[key]) !== undefined);
  return ids && ["appSecret", "appSecretEnv"].some((key) => textOf(config[key]) !== undefined);
}

/**
 * Whether this connection's key is changed on a page of its own in Chat. Telegram always; Discord, Slack and WhatsApp
 * only where the page fits. Discord's and Slack's pages ask for the tokens of a bot: a Discord webhook-only (bridge)
 * connection has no bot token, and a Slack webhook or OAuth connection has no app-level token (Socket Mode is what
 * uses one). WhatsApp's page asks for the access token alone, so a connection without the saved IDs and app secret it
 * checks the token with does not fit. A connection the page does not fit keeps its change in Advanced channel setup.
 * The one predicate decides both the channel page's link and the view that opens, so they cannot disagree.
 */
export function hasChatKeyChangePage(connection: Pick<IntegrationConnection, "key" | "config">): boolean {
  if (!KEY_CHANGE_CHANNELS.has(connection.key)) return false;
  switch (connection.key) {
    case "discord":
      return discordUsesBot(connection.config);
    case "slack":
      return textOf(connection.config.receiveMode) === "socket";
    case "whatsapp":
      return whatsAppKeepsCheckDetails(connection.config);
    default:
      return true;
  }
}

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

/** The channel's own page in Chat, for the picker's tiles. Undefined for a channel that has none. */
export function chatPageHref(definition: Pick<ChannelSetupDefinition, "catalog">): string | undefined {
  const { key } = definition.catalog;
  return CONVERTED_SETUP_CHANNELS.has(key) ? channelSetupHref(key) : undefined;
}

/**
 * Where Advanced channel setup sends a new setup of a channel it hands to that channel's own page. It sets up the rest
 * itself.
 */
export function chatSetupHref(definition: Pick<ChannelSetupDefinition, "catalog">): string | undefined {
  const { key } = definition.catalog;
  return CHAT_ONLY_SETUP_CHANNELS.has(key) ? channelSetupHref(key) : undefined;
}

/**
 * Where an unfinished new setup goes on: its page in Chat, sent to this very draft, when its channel is set up there
 * only (Telegram), or has a page there and this setup was made on it. A change to a saved channel stays in Advanced
 * channel setup, and so does a draft for a channel the definitions don't know.
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
    href: chatPageHref(definition) ?? channelAdvancedSetupHref(catalogId),
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
