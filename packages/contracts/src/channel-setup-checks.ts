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
