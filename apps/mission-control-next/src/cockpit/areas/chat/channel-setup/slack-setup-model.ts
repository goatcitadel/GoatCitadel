/** The words of Slack's setup page that need no state. */

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
