/**
 * Read-only checks a Messaging setup page runs against a channel's own service, with a setup draft's saved
 * credentials. Each answers with names, never with a token or a secret address.
 */

/** The setup draft a check reads its credentials from, at the revision the operator is looking at. */
export interface ChannelSetupCheckDraftRef {
  draftId: string;
  expectedRevision: number;
}

/** Someone or something a check names: a bot, a person, a server or a channel. */
export interface ChannelSetupPerson {
  id: string;
  name: string;
}

export interface DiscordSetupCheckInput extends ChannelSetupCheckDraftRef {
  /** List this server's text channels. */
  guildId?: string;
  /** Open, or find, the direct-message channel with this person. Only someone in `makers`. */
  directMessageWith?: string;
}

export interface DiscordSetupCheckResult {
  bot: ChannelSetupPerson;
  applicationId: string;
  /** Either Message Content Intent flag is on. */
  messageContentIntent: boolean;
  /** Who made the bot: the app's owner, or its team's owner first and then the team's accepted members. */
  makers: ChannelSetupPerson[];
  servers: ChannelSetupPerson[];
  /** Text channels of `guildId`, by position. Present only when `guildId` was asked for and the bot is in it. */
  channels?: ChannelSetupPerson[];
  directChannelId?: string;
}

export interface SlackSetupCheckInput extends ChannelSetupCheckDraftRef {
  /** Ask Slack whether the app-level token is accepted. Nothing is opened. */
  checkAppToken?: true;
  /** Look for this code in the bot's newest direct messages. */
  setupCode?: string;
  /** List the channels the bot is in. */
  listChannels?: true;
}

/** Who sent the setup code to the bot, and the direct-message conversation it arrived in. */
export interface SlackSetupCodeSender {
  actorId: string;
  directChannelId: string;
  displayName?: string;
}

export interface SlackSetupCheckResult {
  workspace: { id: string; name: string };
  bot: { userId: string; name: string };
  /** Present only when `checkAppToken` was asked. `missing` means the draft has no app-level token to try. */
  appToken?: "ok" | "rejected" | "missing";
  /** Present only when `setupCode` was asked and someone sent it. */
  codeSender?: SlackSetupCodeSender;
  /** The bot has more direct-message conversations than GoatCitadel looked at. */
  manyConversations?: true;
  /** Channels the bot is in, by name. Present only when `listChannels` was asked. */
  channels?: Array<{ id: string; name: string; private: boolean }>;
}
