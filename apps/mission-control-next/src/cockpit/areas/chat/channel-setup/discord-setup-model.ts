/** The words and links of Discord's setup page that need no state. */

export const DISCORD_CATALOG_ID = "channel.discord";

export const DISCORD_DEVELOPER_PORTAL = "https://discord.com/developers/applications";

/**
 * The one sentence a failed token check, or a failed look at the bot, comes to. The gateway's own message is never
 * shown: it can quote the request the token travelled in.
 */
export const DISCORD_TOKEN_FAILED =
  "Discord didn't accept that token, or GoatCitadel couldn't reach Discord. Check the token and try again.";

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
