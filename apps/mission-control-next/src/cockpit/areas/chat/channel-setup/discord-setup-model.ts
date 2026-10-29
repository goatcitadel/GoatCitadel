import type { ChannelSetupPerson, DiscordSetupCheckResult } from "@goatcitadel/contracts";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import type { PostingOption } from "./PostingChoice";
import { hostChange, TEST_MESSAGE_THERE_CHANGE, type TurnOnWording } from "./TurnOnStep";

/** The words and links of Discord's setup page that need no state. */

export const DISCORD_CATALOG_ID = "channel.discord";

export const DISCORD_DEVELOPER_PORTAL = "https://discord.com/developers/applications";

/**
 * The one sentence a failed token check, or a failed look at the bot, comes to. The gateway's own message is never
 * shown: it can quote the request the token travelled in.
 */
export const DISCORD_TOKEN_FAILED =
  "Discord didn't accept that token, or GoatCitadel couldn't reach Discord. Check the token and try again.";

/** The same, for a question about the bot's servers or the person who made it, once the token is known to work. */
export const DISCORD_UNREACHABLE = "GoatCitadel couldn't reach Discord. Try again.";

/** What a token that checked out says, naming the bot it belongs to. */
export const discordTokenWorks = (botName: string) => `Token works. Your bot is ${botName}.`;

/**
 * GoatCitadel's connection to Discord asks for Message Content Intent, and Discord refuses the connection without
 * it, so the setup waits for the switch.
 */
export const DISCORD_INTENT_OFF =
  "Turn on Message Content Intent: in the Developer Portal, open your app, choose Bot, and switch on Message Content Intent. Then check again.";

/** View Channel (1024) + Send Messages (2048) + Read Message History (65536): all the bot does in a server. */
const INVITE_PERMISSIONS = 68608;

/**
 * Discord's add-to-server link for the bot: the bot and its slash commands, with only the permissions above. The
 * scopes are joined with a literal "+", which is how Discord writes them; encoding it would send "%2B".
 */
export function discordInviteHref(applicationId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${encodeURIComponent(applicationId)}&scope=bot+applications.commands&permissions=${INVITE_PERMISSIONS}`;
}

export const DISCORD_INVITE_TEXT =
  "Open the invite link, pick a server, and choose Authorize. You need permission to add apps to that server. A server of your own works.";
export const DISCORD_WAITING_FOR_SERVER = "Waiting for your bot to join a server…";
export const DISCORD_STILL_WAITING = "Still waiting? Open the invite link again.";

/** What the invite step says once the bot is in a server: its name, or how many when there are several. */
export function discordInServers(servers: readonly ChannelSetupPerson[]): string {
  const [only] = servers;
  return servers.length === 1 && only
    ? `Your bot is in ${only.name}.`
    : `Your bot is in ${plural(servers.length, "server")}.`;
}

/**
 * Discord names who made a bot, and only that person may message it. Without a name there is nobody to let in, so the
 * setup cannot go further here.
 */
export const DISCORD_NO_MAKERS =
  "Discord didn't say who made this bot, so GoatCitadel can't tell who to let in. Use More options in Settings instead.";

export const DISCORD_TEAM_LEGEND = "Your bot belongs to a team. Who can message it?";
export const DISCORD_SERVER_LEGEND = "Which server?";
export const DISCORD_POSTING_LEGEND = "Where should it post?";

/** Where the bot posts: the direct messages with the person who made it, or one text channel of one server. */
export type DiscordPosting = { kind: "direct" } | { kind: "channel"; guildId: string; channelId: string };

const DIRECT_VALUE = "direct";
const CHANNEL_PREFIX = "channel:";

/** The choices for where it posts: direct messages first, then each text channel, answering the same person. */
export function discordPostingOptions(
  makerName: string,
  channels: readonly ChannelSetupPerson[] | null,
): PostingOption[] {
  return [
    { value: DIRECT_VALUE, label: `Direct messages with ${makerName}` },
    ...(channels ?? []).map((channel) => ({
      value: `${CHANNEL_PREFIX}${channel.id}`,
      label: `#${channel.name}, when ${makerName} mentions it`,
    })),
  ];
}

/** The option a posting is, or no option before one is chosen. */
export function discordPostingValue(posting: DiscordPosting | null): string {
  if (!posting) return "";
  return posting.kind === "direct" ? DIRECT_VALUE : `${CHANNEL_PREFIX}${posting.channelId}`;
}

/** The posting an option stands for. A channel is only ever in the server that was chosen. */
export function postingFromValue(value: string, serverId: string | null): DiscordPosting | null {
  if (value === DIRECT_VALUE) return { kind: "direct" };
  if (serverId && value.startsWith(CHANNEL_PREFIX)) {
    return { kind: "channel", guildId: serverId, channelId: value.slice(CHANNEL_PREFIX.length) };
  }
  return null;
}

/** A channel by its names, "#general in Goat Server", or nothing when either name is not known. Never an id. */
export function discordChannelPlace(
  posting: DiscordPosting,
  servers: readonly ChannelSetupPerson[],
  channels: readonly ChannelSetupPerson[] | null,
): string | undefined {
  if (posting.kind !== "channel") return undefined;
  const server = servers.find((candidate) => candidate.id === posting.guildId);
  const channel = channels?.find((candidate) => candidate.id === posting.channelId);
  return server && channel ? `#${channel.name} in ${server.name}` : undefined;
}

/**
 * The draft's values once who may message the bot and where it posts are chosen. The person who made the bot is the
 * only one let in (Discord's connection lets the maker skip pairing only when all three of these are saved together,
 * and narrows the default channel to the allowed senders). Direct messages turn the server rules off and drop the
 * server; a channel keeps them on for that one server. The values given are not changed.
 */
export function discordChoiceValues(
  values: Record<string, unknown>,
  makerId: string,
  posting: DiscordPosting,
  directChannelId?: string,
): Record<string, unknown> {
  const who = { ownerActorIds: [makerId], allowedSenders: [makerId], inboundAccessMode: "allowlist" };
  if (posting.kind === "channel") {
    return {
      ...values,
      ...who,
      guildPolicy: "allowlist",
      defaultGuildId: posting.guildId,
      defaultChannelId: posting.channelId,
    };
  }
  const withoutServer = Object.fromEntries(Object.entries(values).filter(([key]) => key !== "defaultGuildId"));
  return { ...withoutServer, ...who, guildPolicy: "off", defaultChannelId: directChannelId };
}

const idsIn = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap((item) => (typeof item === "string" ? item.trim() : [])) : [];

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() ? value.trim() : undefined;

/** Whether the values were saved for a different bot than the one a check named. A draft naming no bot was not. */
const savedForAnotherBot = (values: Record<string, unknown>, applicationId: string): boolean => {
  const saved = textOf(values.applicationId);
  return saved !== undefined && saved !== applicationId;
};

/** Who may message the bot and where it posts, as `discordChoiceValues` saves them, except the access mode. */
const CHOICE_KEYS: ReadonlySet<string> = new Set([
  "ownerActorIds",
  "allowedSenders",
  "guildPolicy",
  "defaultGuildId",
  "defaultChannelId",
]);

/**
 * The draft's values for the bot a token check named. When they were saved for another bot, who may message it and
 * where it posts are dropped, so the defaults are chosen again for the new one (the same person's direct messages with
 * another bot are another channel). The access mode stays, so nobody is let in until then. The values given are not
 * changed.
 */
export function discordValuesForBot(values: Record<string, unknown>, applicationId: string): Record<string, unknown> {
  if (!savedForAnotherBot(values, applicationId)) return { ...values };
  return Object.fromEntries(Object.entries(values).filter(([key]) => !CHOICE_KEYS.has(key)));
}

/**
 * Who may message the bot and where it posts, as `discordChoiceValues` saved them, so a page coming back to the setup
 * goes on from there. A person counts only when all three saves are there and they still made the bot; where it posts
 * counts only with such a person, and a channel only while the bot is in its server. The server rules' default
 * ("allowlist", with no channel) is no choice, and nothing saved for another bot is either.
 */
export function savedDiscordChoices(
  values: Record<string, unknown>,
  check: Pick<DiscordSetupCheckResult, "applicationId" | "makers" | "servers">,
): { makerId: string | null; posting: DiscordPosting | null } {
  if (savedForAnotherBot(values, check.applicationId)) return { makerId: null, posting: null };
  const owners = idsIn(values.ownerActorIds);
  const senders = idsIn(values.allowedSenders);
  const makerId =
    values.inboundAccessMode === "allowlist"
      ? (check.makers.find((maker) => owners.includes(maker.id) && senders.includes(maker.id))?.id ?? null)
      : null;
  const channelId = textOf(values.defaultChannelId);
  if (!makerId || !channelId) return { makerId, posting: null };
  if (values.guildPolicy === "off") return { makerId, posting: { kind: "direct" } };
  const guildId = textOf(values.defaultGuildId);
  if (values.guildPolicy === "allowlist" && guildId && check.servers.some((server) => server.id === guildId)) {
    return { makerId, posting: { kind: "channel", guildId, channelId } };
  }
  return { makerId, posting: null };
}

/** The words of Turn on for Discord, where it finishes by saying how to try the bot. */
export const DISCORD_TURN_ON_WORDING: TurnOnWording = {
  button: "Turn on",
  working: "Turning on…",
  done: "Discord is on. Send your bot a direct message to try it.",
  doneLink: "Open Discord's page",
  cleanup: "GoatCitadel couldn't remove its test message. Delete it in Discord if you like.",
};

/**
 * What turning on will do, as plain lines. `postingLabel` names a channel's place ("#general in Goat Server"); direct
 * messages are named by the person they are with. A host appears only when it is not yet allowed.
 */
export function discordTurnOnChanges({
  makerName,
  posting,
  postingLabel,
  missingHosts,
}: {
  makerName: string;
  posting: DiscordPosting;
  postingLabel: string;
  missingHosts: readonly string[];
}): string[] {
  const where =
    posting.kind === "direct"
      ? `direct messages with ${makerName}`
      : `${postingLabel}, and it answers ${makerName} there when they mention it`;
  return [
    `Who can message your bot: ${makerName}, who made it`,
    `Where it posts: ${where}`,
    "How it gets messages: GoatCitadel stays connected to Discord, so no public web address is needed",
    TEST_MESSAGE_THERE_CHANGE,
    ...missingHosts.map(hostChange),
  ];
}
