import type { SlackSetupCodeSender } from "@goatcitadel/contracts";
import {
  channelTargetIdentity,
  mergeDiscoveredChannelTargets,
  readChannelTargetRows,
  type ChannelTargetRow,
} from "../../../../features/native-routes/settings/channel-setup/channel-wizard-model";
import type { PostingOption } from "./PostingChoice";
import { hostChange, TEST_MESSAGE_THERE_CHANGE, type TurnOnWording } from "./TurnOnStep";

/** The words of Slack's setup page, and the pure helpers that build what it saves, that need no state. */

export const SLACK_CATALOG_ID = "channel.slack";

/**
 * The one sentence a failed bot-token check comes to: Slack refused the token, or could not be reached. The gateway's
 * own message is never shown, because it can quote the request the token travelled in.
 */
export const SLACK_BOT_TOKEN_FAILED =
  "Slack didn't accept the bot token, or GoatCitadel couldn't reach Slack. Check it and try again.";

/** The same, for an app-level token that Slack refused, or that is missing. */
export const SLACK_APP_TOKEN_FAILED =
  "Slack didn't accept the app-level token. Check that it has the connections:write scope.";

/** The same, for a question about the bot's channels once its tokens are known to work. */
export const SLACK_UNREACHABLE = "GoatCitadel couldn't reach Slack. Try again.";

/** What two tokens that checked out say, naming the bot and the workspace it is in. */
export const slackTokensWork = (botName: string, workspaceName: string) =>
  `Tokens work. Your bot is @${botName} in ${workspaceName}.`;

export const SLACK_MAKE_APP_TEXT =
  "This opens Slack with GoatCitadel's app settings filled in. Pick your workspace, choose Next, then Create.";

/**
 * Where each token is found in the app's settings. The labels are the ones Slack's docs use for its app settings
 * (docs.slack.dev): OAuth & Permissions, Install to Workspace, Bot User OAuth Token, Basic Information, App-Level Tokens
 * and Generate Token and Scopes.
 */
export const SLACK_TOKEN_STEPS = [
  "Open OAuth & Permissions, choose Install to Workspace, then Allow. Copy the Bot User OAuth Token. It starts with xoxb-.",
  "Open Basic Information. Under App-Level Tokens, choose Generate Token and Scopes, add the connections:write scope, and generate it. Copy the token. It starts with xapp-.",
] as const;

/**
 * How often the page asks Slack whether the code has arrived. Finding it reads the bot's conversations, and
 * conversations.list allows about 20 a minute.
 */
export const SLACK_SAY_HI_POLL_MS = 6_000;

/** The sentence before the code, naming the bot the operator looks for in Slack. */
export const slackSayHiPrompt = (botName: string) => `In Slack, find @${botName} under Apps and send it this code:`;

export const SLACK_MANY_CONVERSATIONS =
  "Your bot has many conversations, so GoatCitadel looked only at the newest ones. Send the code again if your hi doesn't show up.";

/** What to call the person who said hi: the name Slack gave, else "Someone". */
export function slackSenderName(sender: SlackSetupCodeSender): string {
  return sender.displayName?.trim() || "Someone";
}

export const slackSaidHi = (name: string) => `${name} said hi. Only they can message your bot for now.`;

export const SLACK_POSTING_LEGEND = "Where should it post?";

/** A bot posts in a channel only once it has been added there, which only the operator can do in Slack. */
export const slackInviteHelp = (botName: string) =>
  `To post in a channel, add your bot there first: in the channel, type /invite @${botName}. Then choose Refresh channels.`;

/** A channel the bot is in, named; a private one says so. */
export interface SlackChannel {
  id: string;
  name: string;
  private: boolean;
}

/** Where the bot posts: the direct messages with the person who said hi, or one channel it is in. */
export type SlackPosting = { kind: "direct" } | { kind: "channel"; channelId: string };

const DIRECT_VALUE = "direct";
const CHANNEL_PREFIX = "channel:";

/** The choices for where it posts: direct messages first, then each channel, answering the same person. */
export function slackPostingOptions(senderName: string, channels: readonly SlackChannel[] | null): PostingOption[] {
  return [
    { value: DIRECT_VALUE, label: `Direct messages with ${senderName}` },
    ...(channels ?? []).map((channel) => ({
      value: `${CHANNEL_PREFIX}${channel.id}`,
      label: `#${channel.name}, when ${senderName} mentions it${channel.private ? " (private)" : ""}`,
    })),
  ];
}

/** The option a posting is, or no option before one is chosen. */
export function slackPostingValue(posting: SlackPosting | null): string {
  if (!posting) return "";
  return posting.kind === "direct" ? DIRECT_VALUE : `${CHANNEL_PREFIX}${posting.channelId}`;
}

/** The posting an option stands for. */
export function slackPostingFromValue(value: string): SlackPosting | null {
  if (value === DIRECT_VALUE) return { kind: "direct" };
  const channelId = value.startsWith(CHANNEL_PREFIX) ? value.slice(CHANNEL_PREFIX.length) : "";
  return channelId ? { kind: "channel", channelId } : null;
}

/** The places a draft posts to, as the draft holds them. Slack addresses a place by its `channel`. */
const targetsOf = (values: Record<string, unknown>) => readChannelTargetRows(values.targets, "channel");

/** Marks one place as the default and every other as not. The rows given are not changed. */
const withDefault = (rows: readonly ChannelTargetRow[], home: ChannelTargetRow): ChannelTargetRow[] => {
  const identity = channelTargetIdentity(home);
  return rows.map((row) => ({ ...row, default: channelTargetIdentity(row) === identity }));
};

/**
 * The draft's values once someone has said hi: they alone may message the bot and they are its owner, and their direct
 * messages are where it posts by default. Places already on the draft stay, but are no longer the default. The values
 * given are not changed.
 */
export function slackDraftWithSender(
  values: Record<string, unknown>,
  sender: SlackSetupCodeSender,
): Record<string, unknown> {
  const directMessages: ChannelTargetRow = {
    id: `slack:${sender.directChannelId}`,
    label: slackSenderName(sender),
    channel: sender.directChannelId,
    kind: "private",
    source: "recent_update",
    setupCodeMatched: true,
  };
  const targets = withDefault(mergeDiscoveredChannelTargets(targetsOf(values), [directMessages]), directMessages);
  return {
    ...values,
    allowedSenders: [sender.actorId],
    ownerActorIds: [sender.actorId],
    inboundAccessMode: "allowlist",
    targets,
  };
}

/** A channel this page added when it was chosen, so choosing again can take it back. Never the direct messages. */
const isChosenChannel = (row: ChannelTargetRow): boolean =>
  row.source === "connection_config" && row.id.startsWith("slack:") && row.setupCodeMatched !== true;

/**
 * The draft's values once where it posts is chosen. A channel becomes the default place; the direct messages stay as a
 * place that is not. Choosing direct messages again makes them the default and takes back the channel this page added
 * (a place anyone else added stays). A channel the list doesn't have, or direct messages with nobody who said hi, change
 * nothing. The values given are not changed.
 */
export function slackDraftWithPosting(
  values: Record<string, unknown>,
  posting: SlackPosting,
  channels: readonly SlackChannel[],
): Record<string, unknown> {
  const rows = targetsOf(values).filter((row) => !isChosenChannel(row));
  if (posting.kind === "direct") {
    const home = rows.find((row) => row.setupCodeMatched === true && (row.channel ?? "").trim() !== "");
    return home ? { ...values, targets: withDefault(rows, home) } : { ...values };
  }
  const channel = channels.find((candidate) => candidate.id === posting.channelId);
  if (!channel) return { ...values };
  const place: ChannelTargetRow = {
    id: `slack:${channel.id}`,
    label: `#${channel.name}`,
    channel: channel.id,
    kind: channel.private ? "group" : "channel",
    source: "connection_config",
  };
  return { ...values, targets: withDefault(mergeDiscoveredChannelTargets(rows, [place]), place) };
}

/**
 * Who said hi, as `slackDraftWithSender` saved them: its first owner, in the direct messages the code came from (else
 * the default place), named after them. Null before anyone has said hi, so a page coming back to the setup knows
 * whether to ask for a hi or to go straight on.
 */
export function savedSlackSender(values: Record<string, unknown>): SlackSetupCodeSender | null {
  const owners = Array.isArray(values.ownerActorIds) ? values.ownerActorIds : [];
  const actorId = owners.find((owner): owner is string => typeof owner === "string" && owner.trim() !== "")?.trim();
  if (!actorId) return null;
  const matched = targetsOf(values).filter((row) => row.setupCodeMatched === true && (row.channel ?? "").trim() !== "");
  const home = matched.find((row) => row.default) ?? matched[0];
  const directChannelId = home?.channel?.trim();
  if (!home || !directChannelId) return null;
  const label = home.label.trim();
  return { actorId, directChannelId, ...(label ? { displayName: label } : {}) };
}

/** Where it posts, as the draft's default place says: their direct messages, a channel, or nothing chosen yet. */
export function savedSlackPosting(
  values: Record<string, unknown>,
  sender: Pick<SlackSetupCodeSender, "directChannelId"> | null,
): SlackPosting | null {
  if (!sender) return null;
  const channelId = targetsOf(values)
    .find((row) => row.default === true && (row.channel ?? "").trim() !== "")
    ?.channel?.trim();
  if (!channelId) return null;
  return channelId.toLowerCase() === sender.directChannelId.trim().toLowerCase()
    ? { kind: "direct" }
    : { kind: "channel", channelId };
}

/** The words of Turn on for Slack, where it finishes by saying how to try the bot. */
export const SLACK_TURN_ON_WORDING: TurnOnWording = {
  button: "Turn on",
  working: "Turning on…",
  done: "Slack is on. Send your bot a message to try it.",
  doneLink: "Open Slack's page",
  cleanup: "GoatCitadel couldn't remove its test message. Delete it in Slack if you like.",
};

/**
 * What turning on will do, as plain lines. A channel is named by its name; direct messages by the person they are
 * with. A host appears only when it is not yet allowed.
 */
export function slackTurnOnChanges({
  senderName,
  posting,
  channelName,
  missingHosts,
}: {
  senderName: string;
  posting: SlackPosting;
  channelName?: string;
  missingHosts: readonly string[];
}): string[] {
  const where =
    posting.kind === "direct"
      ? `direct messages with ${senderName}`
      : `${channelName ? `#${channelName}` : "that channel"}, and it answers ${senderName} there when they mention it`;
  return [
    `Who can message your bot: ${senderName}`,
    `Where it posts: ${where}`,
    "How it gets messages: GoatCitadel keeps a connection open to Slack, so no public web address is needed",
    TEST_MESSAGE_THERE_CHANGE,
    ...missingHosts.map(hostChange),
  ];
}
