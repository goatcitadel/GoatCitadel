/**
 * The Slack app GoatCitadel's setup page makes, as the manifest Slack builds an app from. It is a bot that talks over
 * Socket Mode, so no public web address is needed, and that hears direct messages and mentions. Each event comes with
 * the scope Slack needs for it (`app_mention` with `app_mentions:read`, `message.im` with `im:history`); the other
 * scopes let the setup read the workspace, the bot's conversations and who is in them, and let the bot post.
 *
 * The app is named GoatCitadel (Slack allows 35 characters) and its bot `goatcitadel` (lower-case letters, digits and
 * `.`, `_`, `-` only). Both can be renamed in Slack afterwards.
 */
export const SLACK_APP_MANIFEST: Readonly<Record<string, unknown>> = {
  _metadata: { major_version: 2, minor_version: 1 },
  display_information: { name: "GoatCitadel", description: "Talk to GoatCitadel from Slack." },
  features: {
    app_home: { home_tab_enabled: false, messages_tab_enabled: true, messages_tab_read_only_enabled: false },
    bot_user: { display_name: "goatcitadel", always_online: true },
  },
  oauth_config: {
    scopes: {
      bot: ["app_mentions:read", "channels:read", "chat:write", "groups:read", "im:history", "im:read", "users:read"],
    },
  },
  settings: {
    event_subscriptions: { bot_events: ["app_mention", "message.im"] },
    interactivity: { is_enabled: false },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
  },
};

const CREATE_APP_URL = "https://api.slack.com/apps?new_app=1&manifest_json=";

/**
 * Slack's create-an-app address with the manifest filled in: the person picks a workspace and confirms, and Slack makes
 * the app. The JSON is encoded whole, so nothing in it can end the query early.
 */
export function slackCreateAppHref(): string {
  return `${CREATE_APP_URL}${encodeURIComponent(JSON.stringify(SLACK_APP_MANIFEST))}`;
}
