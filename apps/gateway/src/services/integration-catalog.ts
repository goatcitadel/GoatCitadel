/* eslint-disable max-lines -- Integration catalog shape stays centralized so visible catalog policy, forms, and runtime truth do not drift apart. */
import type { IntegrationCatalogEntry, IntegrationFormSchema, IntegrationFieldSchema } from "@goatcitadel/contracts";
import { entryWithOperatorActions } from "./integration-action-registry.js";

function localBridgeSchema(
  catalogId: string,
  title: string,
  description: string,
  defaultLabel: string,
  options: {
    targetField?: IntegrationFieldSchema;
  } = {},
): IntegrationFormSchema {
  return {
    catalogId,
    title,
    description,
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: defaultLabel }),
      url("bridgeUrl", "Bridge URL", {
        placeholder: "http://127.0.0.1:8765",
        required: true,
      }),
      localBridgeActionRouteField(),
      text("authTokenEnv", "Bridge Token ENV Var", {
        placeholder: "LOCAL_AGENT_AUTH_TOKEN",
        secretRef: true,
        advanced: true,
      }),
      ...(options.targetField ? [options.targetField] : []),
      bool("enabled", "Enabled", true),
    ],
  };
}

function localBridgeActionRouteField(): IntegrationFieldSchema {
  return select("actionRoute", "Action API Route", ["v1", "api_v1"], "v1", {
    advanced: true,
    description:
      "Pins side-effecting actions to one bridge route. Choose api_v1 only for a legacy bridge; GoatCitadel never probes an alternate route after sending a side effect.",
  });
}

function inboundAccessFields(): IntegrationFieldSchema[] {
  return [
    select("inboundAccessMode", "Inbound Access Mode", ["allowlist", "open_legacy"], "allowlist", {
      advanced: true,
      description:
        "Controls who can start inbound channel sessions. New connections default to allowlist; open_legacy preserves old default-open behavior.",
    }),
    json("allowedSenders", "Allowed Senders JSON", {
      advanced: true,
      defaultValue: "[]",
      description:
        'Sender actor ids permitted when allowlist mode is active. Example: ["U123", "operator@example.com"]',
    }),
  ];
}

/**
 * Stream and Google Chat app inbound never had a legacy-open default: the runtime always enforces the
 * allowlist, so these forms offer only the sender list (no open_legacy choice the runtime would ignore).
 */
function forcedAllowlistInboundFields(senderHint: string): IntegrationFieldSchema[] {
  return [
    json("allowedSenders", "Allowed Senders JSON", {
      advanced: true,
      defaultValue: "[]",
      description: `Inbound on this channel is always allowlist-only; an empty list drops all inbound. ${senderHint}`,
    }),
  ];
}

function inboundOptInField(key: string, label: string, description: string): IntegrationFieldSchema {
  return { ...bool(key, label, false), description };
}

const FORM_SCHEMA_OVERRIDES: Record<string, IntegrationFormSchema> = {
  "channel.discord": {
    catalogId: "channel.discord",
    title: "Discord",
    description:
      "Gateway mode is the default for a real online Discord bot. Bridge remains available as an advanced webhook-only fallback.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", {
        defaultValue: "Discord",
        description: "Friendly name shown inside GoatCitadel. Use something clear like Discord Beta or Ops Discord.",
      }),
      select("runtimeMode", "Runtime Mode", ["gateway", "bridge"], "gateway", {
        advanced: true,
      }),
      text("botTokenEnv", "Bot Token ENV Var", {
        placeholder: "DISCORD_BOT_TOKEN",
        secretRef: true,
        description:
          "Preferred path. Name of the environment variable that stores your Discord bot token. Bot-token setups default to gateway mode so the bot can appear online and route inbound traffic.",
      }),
      text("defaultChannelId", "Default Channel ID", {
        required: true,
        placeholder: "123456789012345678",
        description:
          "Primary fallback channel for approvals, diagnostics, and default sends. In Discord, enable Developer Mode, right-click the channel, then choose Copy Channel ID.",
      }),
      url("webhookUrl", "Webhook URL", {
        placeholder: "https://discord.com/api/webhooks/...",
        advanced: true,
        description:
          "Advanced legacy bridge path. Webhook-only mode supports outbound sends and webhook-authored deletes, but not reactions, inbound routing, or online presence.",
      }),
      text("defaultGuildId", "Default Guild ID", {
        advanced: true,
        placeholder: "987654321098765432",
        description:
          "Optional seed guild for gateway allowlisting or bridge diagnostics. Most bridge users can leave this blank.",
      }),
      select("inboundDmPolicy", "Inbound DM Policy", ["pairing", "open", "disabled"], "pairing", {
        advanced: true,
      }),
      select("guildPolicy", "Guild Policy", ["allowlist", "off"], "allowlist", {
        advanced: true,
      }),
      json("guilds", "Guild Rules JSON", {
        advanced: true,
        defaultValue: "{}",
        description:
          'Advanced gateway routing rules keyed by guild id. Example: {"123": {"requireMention": true, "channels": ["456"]}}',
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.slack": {
    catalogId: "channel.slack",
    title: "Slack Connection",
    description:
      "Connect a Slack bot token, optional webhook fallback, and optional signing secret for inbound events.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Slack" }),
      text("botTokenEnv", "Bot Token ENV Var", {
        placeholder: "SLACK_BOT_TOKEN",
        required: false,
        secretRef: true,
      }),
      json("targets", "Channel Targets", {
        defaultValue: "[]",
        description: 'Named Slack targets. Example: [{"label":"Ops","channel":"#ops","default":true}]',
      }),
      text("defaultChannel", "Legacy Default Channel", { placeholder: "#general", advanced: true }),
      text("defaultThreadTs", "Default Thread TS", { advanced: true }),
      url("webhookUrl", "Incoming Webhook URL", {
        placeholder: "https://hooks.slack.com/services/...",
        advanced: true,
      }),
      text("signingSecretEnv", "Signing Secret ENV Var", {
        placeholder: "SLACK_SIGNING_SECRET",
        secretRef: true,
        advanced: true,
      }),
      ...inboundAccessFields(),
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.telegram": {
    catalogId: "channel.telegram",
    title: "Telegram Connection",
    description:
      "Connect a Telegram bot token and default chat target with preflighted rich media evidence for photo/document sends.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Telegram" }),
      text("botTokenEnv", "Bot Token ENV Var", {
        placeholder: "TELEGRAM_BOT_TOKEN",
        required: true,
        secretRef: true,
      }),
      text("botUsername", "Bot Username", {
        placeholder: "@goatcitadel_bot",
      }),
      json("targets", "Chat Targets", {
        defaultValue: "[]",
        description: 'Named Telegram targets. Example: [{"label":"Ops","chatId":"-1001234567890","default":true}]',
      }),
      text("defaultChatId", "Legacy Default Chat ID", {
        placeholder: "123456789 or @channel_name",
        required: false,
      }),
      text("allowedGroupIds", "Allowed Groups", {
        placeholder: "-1001234567890,@ops_group",
        advanced: true,
        description: "Comma-separated Telegram group or supergroup ids allowed for inbound routing.",
      }),
      text("allowedForumTopicIds", "Allowed Forum Topics", {
        placeholder: "123,456",
        advanced: true,
        description: "Optional comma-separated forum topic ids for group-topic routing.",
      }),
      select("parseMode", "Parse Mode", ["Markdown", "MarkdownV2", "HTML"], "Markdown"),
      text("webhookSecretEnv", "Webhook Secret ENV Var", {
        placeholder: "TELEGRAM_WEBHOOK_SECRET",
        secretRef: true,
        advanced: true,
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.ntfy": {
    catalogId: "channel.ntfy",
    title: "ntfy Notification Connection",
    description:
      "Connect an ntfy topic for operator-visible notifications, with optional inbound from a subscribed topic. The token gates reading the topic; anyone able to publish to it can start turns, so subscribe only to a topic whose write access is limited to trusted publishers. Messages published while the gateway is disconnected or restarting are skipped (no history is fetched on reconnect after a restart).",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "ntfy" }),
      url("baseUrl", "Base URL", {
        defaultValue: "https://ntfy.sh",
        placeholder: "https://ntfy.sh",
        required: true,
      }),
      text("topic", "Topic", {
        placeholder: "goatcitadel-ops",
        required: true,
      }),
      text("tokenEnv", "Token ENV Var", {
        placeholder: "NTFY_TOKEN",
        secretRef: true,
        advanced: true,
      }),
      select("priority", "Priority", ["1", "2", "3", "4", "5"], "3", {
        advanced: true,
      }),
      inboundOptInField(
        "inboundStreamEnabled",
        "Receive Inbound Messages",
        "Opt in to a persistent subscription to the topic's JSON stream. Requires a token. Anyone able to publish to the subscribed topic can start turns, so restrict its write access to trusted publishers.",
      ),
      text("subscribeTopic", "Subscribe Topic", {
        placeholder: "goatcitadel-inbox",
        advanced: true,
        description: "Topic to subscribe to for inbound. Defaults to the outbound topic.",
      }),
      ...forcedAllowlistInboundFields('The topic is the sender: allow "ntfy-topic:<subscribe topic>".'),
      bool("dryRun", "Dry Run Only", false),
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.matrix": {
    catalogId: "channel.matrix",
    title: "Matrix Connection",
    description:
      "Configure a Matrix bot account (access token) for room sends, reactions, redactions and optional /sync inbound.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Matrix" }),
      url("homeserverUrl", "Homeserver URL", {
        placeholder: "https://matrix.example.com",
        required: true,
      }),
      text("accessTokenEnv", "Access Token ENV Var", {
        placeholder: "MATRIX_ACCESS_TOKEN",
        secretRef: true,
      }),
      text("defaultRoomId", "Default Room ID", {
        placeholder: "!roomid",
        description: "Optional default room. Sends normally take the room from the target.",
      }),
      inboundOptInField(
        "inboundStreamEnabled",
        "Receive Inbound Messages",
        "Opt in to a persistent /sync long-poll of the rooms the bot has joined. Inbound is default-deny: only the Matrix user ids you allowlist can start turns, so allow only people you trust and keep the bot only in rooms you control.",
      ),
      ...forcedAllowlistInboundFields('Allow Matrix user ids such as "@alice:example.com".'),
      bool("enabled", "Enabled", false),
    ],
  },
  "channel.qqbot": {
    catalogId: "channel.qqbot",
    title: "QQBot Connection",
    description:
      "Connect a QQ Bot Open Platform app for text sends and replies, with a signed webhook for inbound messages. Inbound is default-deny by sender openid.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "QQBot" }),
      text("appId", "App ID", { required: true, placeholder: "102000000" }),
      text("appSecretEnv", "App Secret ENV Var", {
        placeholder: "QQBOT_APP_SECRET",
        secretRef: true,
        description:
          "Name of the environment variable that stores the bot's AppSecret. It mints send tokens and verifies signed webhook events.",
      }),
      text("defaultTarget", "Default Target", {
        placeholder: "group:<openid>, user:<openid>, channel:<id> or dm:<guild id>",
        description: "Optional fallback destination. Replies to inbound messages use the sender's own target.",
      }),
      bool("sandbox", "Use Sandbox API", false),
      ...forcedAllowlistInboundFields(
        'Allow QQ openids (the id QQ assigns the sender), for example "E4F2...". Add the webhook URL shown in guided setup to the QQ Bot console.',
      ),
      bool("enabled", "Enabled", false),
    ],
  },
  "channel.wecom": {
    catalogId: "channel.wecom",
    title: "WeCom Connection",
    description:
      "Connect a WeCom (WeChat Work) self-built application for text sends, with an encrypted callback for inbound messages. Inbound is default-deny by sender userid.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "WeCom" }),
      text("corpId", "Corp ID", { required: true, placeholder: "ww1234567890abcdef" }),
      text("agentId", "Agent ID", { required: true, placeholder: "1000002" }),
      text("secretEnv", "Application Secret ENV Var", {
        placeholder: "WECOM_SECRET",
        secretRef: true,
        description: "Name of the environment variable that stores the application's Secret, used to mint send tokens.",
      }),
      text("callbackTokenEnv", "Callback Token ENV Var", {
        placeholder: "WECOM_CALLBACK_TOKEN",
        secretRef: true,
        description:
          "Name of the environment variable that stores the callback Token. Without it and the EncodingAESKey, inbound stays off.",
      }),
      text("encodingAesKeyEnv", "EncodingAESKey ENV Var", {
        placeholder: "WECOM_ENCODING_AES_KEY",
        secretRef: true,
        description: "Name of the environment variable that stores the callback's 43-character EncodingAESKey.",
      }),
      text("defaultTarget", "Default Target", {
        placeholder: "user:<userid>, party:<id>, tag:<id> or a userid",
        description: "Optional fallback recipient. Replies to inbound messages go to the sender.",
      }),
      ...forcedAllowlistInboundFields(
        'Allow WeCom userids such as "zhangsan". Add the webhook URL shown in guided setup to the message-receiving settings of the WeCom application.',
      ),
      bool("enabled", "Enabled", false),
    ],
  },
  "channel.google-chat": {
    catalogId: "channel.google-chat",
    title: "Google Chat Connection",
    description:
      "Connect a Google Chat incoming webhook (outbound only), or a Chat app with a service-account key for inbound messages, replies, and deleting its own messages.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Google Chat" }),
      url("webhookUrl", "Webhook URL", {
        placeholder: "https://chat.googleapis.com/v1/spaces/...",
        description: "Webhook mode. Leave empty when using Chat app (service-account) mode.",
      }),
      text("defaultThreadKey", "Default Thread Key", {
        placeholder: "goatcitadel-thread",
        advanced: true,
      }),
      text("serviceAccountKeyEnv", "Service-Account Key ENV Var", {
        placeholder: "GOOGLE_CHAT_SA_KEY",
        description: "Chat app mode. Environment variable holding the service-account JSON key.",
      }),
      select("audienceType", "Chat App Audience Type", ["project_number", "endpoint_url"], "project_number", {
        description: "Chat app mode. Must match the app's authentication audience in the Google Cloud console.",
      }),
      text("audience", "Chat App Audience", {
        placeholder: "123456789012",
        description: "Chat app mode. The project number, or this connection's public HTTPS webhook URL.",
      }),
      text("addOnProjectNumber", "Workspace Add-on Project Number", {
        placeholder: "123456789012",
        advanced: true,
        description:
          "Only for Chat apps built as Google Workspace add-ons, with the endpoint URL audience. The add-on's numeric Google Cloud project number; leave empty for a regular Chat app.",
      }),
      text("defaultSpace", "Default Space", {
        placeholder: "spaces/AAAAxxxx",
        advanced: true,
        description: "Chat app mode. Space used when a send does not name one.",
      }),
      ...forcedAllowlistInboundFields(
        "Chat app mode only: add Google Chat user resource names such as users/123456789.",
      ),
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.teams": {
    catalogId: "channel.teams",
    title: "Teams Connection",
    description: "Connect a Microsoft Teams incoming webhook for outbound operator messages.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Teams" }),
      url("webhookUrl", "Webhook URL", {
        placeholder: "https://<environment>.environment.api.powerplatform.com/...",
        required: true,
      }),
      text("cardTitle", "Card Title", {
        placeholder: "GoatCitadel",
        advanced: true,
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.whatsapp": {
    catalogId: "channel.whatsapp",
    title: "WhatsApp Connection",
    description:
      "Connect a WhatsApp Cloud API sender identity and default direct recipient target with preflighted rich media evidence.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "WhatsApp" }),
      text("accessTokenEnv", "Access Token ENV Var", {
        placeholder: "WHATSAPP_ACCESS_TOKEN",
        secretRef: true,
      }),
      text("phoneNumberId", "Phone Number ID", {
        placeholder: "123456789012345",
        required: true,
      }),
      text("appSecretEnv", "App Secret ENV Var", {
        placeholder: "WHATSAPP_APP_SECRET",
        secretRef: true,
        advanced: true,
      }),
      text("webhookVerifyTokenEnv", "Webhook Verify Token ENV Var", {
        placeholder: "WHATSAPP_WEBHOOK_VERIFY_TOKEN",
        secretRef: true,
        advanced: true,
      }),
      text("defaultTarget", "Default Recipient", {
        placeholder: "+15551234567",
        required: true,
      }),
      ...inboundAccessFields(),
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.mattermost": {
    catalogId: "channel.mattermost",
    title: "Mattermost Connection",
    description:
      "Connect a Mattermost bot token and default channel target. Optional inbound listens on the bot WebSocket; Mattermost has no replay, so posts sent while the socket is disconnected are not recovered.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Mattermost" }),
      url("serverUrl", "Server URL", {
        placeholder: "https://chat.example.com",
        required: true,
      }),
      text("botTokenEnv", "Bot Token ENV Var", {
        placeholder: "MATTERMOST_BOT_TOKEN",
        required: true,
        secretRef: true,
      }),
      text("defaultChannel", "Default Channel", {
        placeholder: "town-square or channel-id",
        required: true,
      }),
      text("defaultTeam", "Default Team", {
        placeholder: "goatcitadel",
        advanced: true,
      }),
      inboundOptInField(
        "inboundStreamEnabled",
        "Receive Inbound Messages",
        "Opt in to the bot WebSocket for posted events in channels the bot belongs to.",
      ),
      ...forcedAllowlistInboundFields("Add the Mattermost user ids that may start turns."),
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.nextcloud-talk": {
    catalogId: "channel.nextcloud-talk",
    title: "Nextcloud Talk Connection",
    description: "Connect a Nextcloud Talk bot token for inbound webhooks, outbound replies, and reactions.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Nextcloud Talk" }),
      url("baseUrl", "Base URL", {
        placeholder: "https://cloud.example.com",
        required: true,
        description:
          "Origin of the Nextcloud Talk instance used for outbound bot requests. Register the public HTTPS Gateway callback URL separately; it may use a different host.",
      }),
      text("tokenEnv", "Token ENV Var", {
        placeholder: "NEXTCLOUD_TALK_TOKEN",
        required: true,
        secretRef: true,
        description: "Shared secret used for both webhook verification and outbound bot requests.",
      }),
      text("defaultRoomId", "Default Room ID", {
        placeholder: "room-id",
        required: true,
        description:
          "Fallback room for manual sends and approval delivery. Regular inbound replies use the originating conversation automatically.",
      }),
      ...inboundAccessFields(),
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.line": {
    catalogId: "channel.line",
    title: "LINE Connection",
    description: "Connect a LINE bot token and default user, group, or room target.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "LINE" }),
      text("channelAccessTokenEnv", "Channel Access Token ENV Var", {
        placeholder: "LINE_CHANNEL_ACCESS_TOKEN",
        required: true,
        secretRef: true,
      }),
      text("channelSecretEnv", "Channel Secret ENV Var", {
        placeholder: "LINE_CHANNEL_SECRET",
        secretRef: true,
        advanced: true,
      }),
      text("defaultTarget", "Default Target", {
        placeholder: "userId, groupId, or roomId",
        required: true,
      }),
      ...inboundAccessFields(),
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.zalo": {
    catalogId: "channel.zalo",
    title: "Zalo OA Connection",
    description: "Configure a Zalo Official Account token and default recipient target.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Zalo OA" }),
      text("accessTokenEnv", "Access Token ENV Var", {
        placeholder: "ZALO_ACCESS_TOKEN",
        required: true,
        secretRef: true,
      }),
      text("defaultRecipientId", "Default Recipient ID", {
        placeholder: "zalo-user-id",
        required: true,
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "automation.webhooks": {
    catalogId: "automation.webhooks",
    title: "Webhook Connection",
    description: "Configure outbound webhook endpoint and optional signing secret.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Webhook" }),
      url("baseUrl", "Webhook Base URL", {
        secretRef: true,
        required: true,
        placeholder: "https://example.com/webhooks",
      }),
      select("method", "HTTP Method", ["POST", "PUT"], "POST"),
      text("signingSecretEnv", "Signing Secret ENV Var", {
        placeholder: "WEBHOOK_SIGNING_SECRET",
        secretRef: true,
        advanced: true,
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "automation.activepieces": {
    catalogId: "automation.activepieces",
    title: "Activepieces Bridge",
    description: "Configure an Activepieces webhook trigger for explicit operator-run automation flows.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Activepieces" }),
      url("webhookUrl", "Webhook URL", {
        placeholder: "https://cloud.activepieces.com/api/v1/webhooks/...",
        required: true,
        secretRef: true,
      }),
      text("authTokenEnv", "Bearer Token ENV Var", {
        placeholder: "ACTIVEPIECES_WEBHOOK_TOKEN",
        secretRef: true,
        advanced: true,
      }),
      url("apiBaseUrl", "API Base URL", {
        placeholder: "https://cloud.activepieces.com",
        advanced: true,
      }),
      text("apiTokenEnv", "API Token ENV Var", {
        placeholder: "ACTIVEPIECES_API_KEY",
        secretRef: true,
        advanced: true,
      }),
      text("defaultFlowId", "Default Flow ID", {
        placeholder: "flow-id",
        advanced: true,
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "automation.gmail": {
    catalogId: "automation.gmail",
    title: "Gmail and Google Calendar Connection",
    description:
      "Sign in with Google for the Gmail and Calendar tools. Create an OAuth client of type Desktop app in your Google Cloud project and enable the Gmail API and Google Calendar API. Save, then choose Connect Google: each capability turned on below adds one Google scope, and tokens stay in the OS keychain.",
    allowAdvancedJson: false,
    fields: [
      text("label", "Connection Label", { defaultValue: "Google" }),
      text("clientId", "OAuth Client ID", {
        placeholder: "1234567890-abc.apps.googleusercontent.com",
        required: true,
        description: "From Google Cloud › APIs & Services › Credentials, client type Desktop app.",
      }),
      bool("gmailRead", "Read Gmail", true),
      bool("gmailSend", "Send Gmail (asks for approval every time)", false),
      bool("calendarRead", "Read Calendar events", false),
      bool("calendarWrite", "Create Calendar events (asks for approval every time)", false),
      text("clientSecretEnv", "Client Secret ENV Var", {
        placeholder: "GMAIL_CLIENT_SECRET",
        secretRef: true,
        advanced: true,
        description:
          "Optional. Name of an environment variable that holds the client secret. Otherwise enter the secret when you connect; it is kept in the OS keychain.",
      }),
      url("redirectUri", "Redirect URI Override", {
        placeholder: "http://127.0.0.1:8787/api/v1/integrations/google/oauth/callback",
        advanced: true,
        description:
          "Only when GoatCitadel is reached on another loopback port. It must be http on 127.0.0.1 or localhost and end in /api/v1/integrations/google/oauth/callback.",
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "automation.imap-smtp": {
    catalogId: "automation.imap-smtp",
    title: "IMAP/SMTP Mail Connection",
    description:
      "Sends approved mail through your SMTP server. Reading an IMAP inbox is not available yet. Add the SMTP host to the network allowlist; port 587 requires STARTTLS and port 465 uses implicit TLS.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Mail" }),
      text("smtpHost", "SMTP Host", {
        placeholder: "smtp.example.com",
        required: true,
        description: "Bare hostname or IPv4 address, without port, scheme, or credentials.",
      }),
      text("smtpPort", "SMTP Port", { defaultValue: "587", placeholder: "587" }),
      text("fromAddress", "From Address", { placeholder: "you@example.com", required: true }),
      text("smtpUser", "SMTP Username", {
        placeholder: "you@example.com",
        description: "Leave empty only for a server that accepts unauthenticated submission.",
      }),
      text("smtpPasswordEnv", "SMTP Password ENV Var", {
        placeholder: "SMTP_PASSWORD",
        secretRef: true,
        description:
          "Name of the environment variable that holds the SMTP password. The password itself is never stored in this connection.",
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "productivity.apple-notes": localBridgeSchema(
    "productivity.apple-notes",
    "Apple Notes Connection",
    "Configure the local bridge GoatCitadel uses to read and write Apple Notes content.",
    "Apple Notes",
    {
      targetField: text("defaultFolder", "Default Folder", {
        placeholder: "GoatCitadel",
        advanced: true,
      }),
    },
  ),
  "productivity.apple-reminders": localBridgeSchema(
    "productivity.apple-reminders",
    "Apple Reminders Connection",
    "Configure the local bridge GoatCitadel uses to read and write Apple Reminders lists.",
    "Apple Reminders",
    {
      targetField: text("defaultList", "Default List", {
        placeholder: "Inbox",
        advanced: true,
      }),
    },
  ),
  "productivity.things3": localBridgeSchema(
    "productivity.things3",
    "Things 3 Connection",
    "Configure the local bridge GoatCitadel uses to read and write Things 3 tasks.",
    "Things 3",
    {
      targetField: text("defaultList", "Default List", {
        placeholder: "Inbox",
        advanced: true,
      }),
    },
  ),
  "productivity.bear": localBridgeSchema(
    "productivity.bear",
    "Bear Notes Connection",
    "Configure the local bridge GoatCitadel uses to read and write Bear notes.",
    "Bear",
    {
      targetField: text("defaultTag", "Default Tag", {
        placeholder: "goatcitadel",
        advanced: true,
      }),
    },
  ),
  "productivity.trello": {
    catalogId: "productivity.trello",
    title: "Trello Connection",
    description: "Configure Trello board access with API credentials and an optional default board/list target.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Trello" }),
      text("apiKeyEnv", "API Key ENV Var", {
        placeholder: "TRELLO_API_KEY",
        required: true,
        secretRef: true,
      }),
      text("tokenEnv", "Access Token ENV Var", {
        placeholder: "TRELLO_TOKEN",
        required: true,
        secretRef: true,
      }),
      text("defaultBoardId", "Default Board ID", {
        placeholder: "workspace-board-id",
      }),
      text("defaultListId", "Default List ID", {
        placeholder: "list-id",
        advanced: true,
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "productivity.notion": {
    catalogId: "productivity.notion",
    title: "Notion Connection",
    description:
      "Configure a Notion internal integration token (referenced by ENV var name). Share each page you want GoatCitadel to reach with the integration.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Notion" }),
      text("tokenEnv", "Integration Token ENV Var", {
        placeholder: "NOTION_INTEGRATION_TOKEN",
        required: true,
        secretRef: true,
      }),
      text("defaultParentPageId", "Default Parent Page ID", {
        placeholder: "notion-page-id",
        advanced: true,
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "productivity.github": {
    catalogId: "productivity.github",
    title: "GitHub Connection",
    description:
      "Configure a GitHub fine-grained token (referenced by ENV var name) and the default repository. GITHUB_TOKEN and GH_TOKEN are refused; use a dedicated variable such as GITHUB_INTEGRATION_TOKEN.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "GitHub" }),
      text("tokenEnv", "Fine-grained Token ENV Var", {
        placeholder: "GITHUB_INTEGRATION_TOKEN",
        required: true,
        secretRef: true,
      }),
      text("defaultRepo", "Default Repository", {
        placeholder: "owner/name",
        required: true,
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "automation.gif-search": {
    catalogId: "automation.gif-search",
    title: "GIF Search Connection",
    description: "Configure the provider and API key GoatCitadel uses for operator-facing GIF search.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "GIF Search" }),
      select("provider", "Provider", ["tenor", "giphy"], "tenor"),
      text("apiKeyEnv", "API Key ENV Var", {
        placeholder: "TENOR_API_KEY",
        required: true,
        secretRef: true,
      }),
      text("defaultLocale", "Default Locale", {
        placeholder: "en_US",
        advanced: true,
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "automation.peekaboo-screen": localBridgeSchema(
    "automation.peekaboo-screen",
    "Peekaboo Screen Connection",
    "Configure the local capture/control bridge used for screen inspection and remote-control flows.",
    "Peekaboo Screen",
    {
      targetField: select("defaultAction", "Default Action", ["capture", "control"], "capture", {
        advanced: true,
      }),
    },
  ),
  "automation.camera-photo-video": localBridgeSchema(
    "automation.camera-photo-video",
    "Camera Connection",
    "Configure the local camera bridge GoatCitadel uses for photo and video capture.",
    "Camera",
    {
      targetField: select("defaultMode", "Default Capture Mode", ["photo", "video"], "photo", {
        advanced: true,
      }),
    },
  ),
  "platform.macos-menubar-voice": localBridgeSchema(
    "platform.macos-menubar-voice",
    "macOS Menu Bar + Voice",
    "Configure the local companion bridge for menu-bar presence and voice capture on macOS.",
    "macOS Menu Bar",
    {
      targetField: text("voiceProfile", "Voice Profile", {
        placeholder: "default",
        advanced: true,
      }),
    },
  ),
  "platform.ios-canvas-camera-voice": {
    catalogId: "platform.ios-canvas-camera-voice",
    title: "iOS Canvas / Camera / Voice",
    description:
      "Configure the device-facing companion registration used to surface iOS canvas, camera, and voice capabilities.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "iOS Companion" }),
      text("deviceId", "Device ID", {
        placeholder: "iphone-operator",
        required: true,
      }),
      text("companionSessionId", "Companion Session ID", {
        placeholder: "companion-session-id",
        advanced: true,
      }),
      text("bridgeUrl", "Bridge URL", {
        placeholder: "http://127.0.0.1:8765",
        advanced: true,
      }),
      localBridgeActionRouteField(),
      bool("enabled", "Enabled", true),
    ],
  },
  "model_provider.openai": providerSchema(
    "model_provider.openai",
    "OpenAI",
    "OPENAI_API_KEY",
    "https://api.openai.com/v1",
    "gpt-5.4-mini",
  ),
  "model_provider.openrouter": providerSchema(
    "model_provider.openrouter",
    "OpenRouter",
    "OPENROUTER_API_KEY",
    "https://openrouter.ai/api/v1",
    "openai/gpt-5.4-mini",
  ),
  "model_provider.glm": providerSchema(
    "model_provider.glm",
    "GLM (Z.AI)",
    "GLM_API_KEY",
    "https://api.z.ai/api/paas/v4",
    "glm-5",
  ),
  "model_provider.moonshot": providerSchema(
    "model_provider.moonshot",
    "Moonshot",
    "MOONSHOT_API_KEY",
    "https://api.moonshot.ai/v1",
    "kimi-k2.6",
  ),
  "model_provider.ollama": providerSchema(
    "model_provider.ollama",
    "Ollama",
    "",
    "http://127.0.0.1:11434/v1",
    "llama3.2",
    true,
  ),
  "model_provider.local-models": providerSchema(
    "model_provider.local-models",
    "Local Models",
    "",
    "http://127.0.0.1:1234/v1",
    "local-model",
    true,
  ),
};

export const INTEGRATION_CATALOG: IntegrationCatalogEntry[] = [
  // Channels
  entry(
    "channel",
    "tui",
    "Terminal/TUI",
    "Interactive terminal channel for local operations.",
    "native",
    ["local"],
    ["chat", "commands"],
  ),
  entry(
    "channel",
    "webchat",
    "Webchat",
    "Embedded web chat endpoint for browser clients.",
    "native",
    ["token", "basic"],
    ["chat", "sessions"],
  ),
  entry(
    "channel",
    "discord",
    "Discord",
    "Discord bot integration with gateway mode by default and an advanced bridge fallback.",
    "beta",
    ["bot-token"],
    ["chat", "threads", "attachments", "reactions", "unsend", "inbound"],
  ),
  entry(
    "channel",
    "whatsapp",
    "WhatsApp",
    "WhatsApp business bridge.",
    "beta",
    ["token"],
    ["chat", "attachments", "direct", "reactions", "inbound"],
  ),
  entry(
    "channel",
    "telegram",
    "Telegram",
    "Telegram bot integration.",
    "beta",
    ["bot-token"],
    ["chat", "threads", "attachments", "reactions", "unsend", "typing", "inbound"],
  ),
  entry(
    "channel",
    "ntfy",
    "ntfy",
    "ntfy notification delivery with optional inbound from a write-restricted subscribed topic.",
    "beta",
    ["token", "none"],
    ["notifications", "outbound", "inbound"],
  ),
  entry(
    "channel",
    "matrix",
    "Matrix",
    "Matrix rooms over the client-server API, with optional /sync inbound.",
    "beta",
    ["token"],
    ["chat", "rooms", "reactions", "unsend", "typing", "inbound"],
  ),
  entry(
    "channel",
    "qqbot",
    "QQBot",
    "QQBot text sends and replies, with signed webhook inbound.",
    "beta",
    ["token"],
    ["chat", "reply", "inbound"],
  ),
  entry(
    "channel",
    "wecom",
    "WeCom",
    "WeCom application text sends, with encrypted callback inbound.",
    "beta",
    ["token"],
    ["chat", "inbound"],
  ),
  entry(
    "channel",
    "slack",
    "Slack",
    "Slack app/bot integration.",
    "beta",
    ["oauth"],
    ["chat", "threads", "mentions", "attachments", "reactions", "unsend", "inbound"],
  ),
  entry(
    "channel",
    "google-chat",
    "Google Chat",
    "Google Chat app and webhook integration.",
    "beta",
    ["webhook", "service-account"],
    ["chat", "spaces", "threads", "attachments"],
    { pluginId: "googlechat" },
  ),
  entry(
    "channel",
    "mattermost",
    "Mattermost",
    "Mattermost bot integration with optional inbound over the bot WebSocket.",
    "beta",
    ["token"],
    ["chat", "channels", "direct", "attachments", "reactions", "unsend", "inbound"],
  ),
  entry(
    "channel",
    "teams",
    "Microsoft Teams",
    "Send Adaptive Card notifications to a Teams channel through a Workflows webhook. Sends only.",
    "beta",
    ["webhook"],
    ["chat", "attachments"],
    { pluginId: "msteams" },
  ),
  entry(
    "channel",
    "nextcloud-talk",
    "Nextcloud Talk",
    "Nextcloud Talk bot bridge with signed webhooks and reactions.",
    "native",
    ["token"],
    ["chat", "rooms", "webhooks", "reactions"],
  ),
  entry(
    "channel",
    "line",
    "LINE",
    "LINE Messaging API integration.",
    "beta",
    ["token"],
    ["chat", "groups", "rooms", "direct", "inbound"],
  ),
  entry(
    "channel",
    "zalo",
    "Zalo OA",
    "Zalo Official Account integration.",
    "beta",
    ["token"],
    ["chat", "official-account"],
  ),

  // Model providers
  entry(
    "model_provider",
    "openai",
    "OpenAI",
    "Direct OpenAI provider support.",
    "native",
    ["api-key"],
    ["chat-completions"],
  ),
  entry(
    "model_provider",
    "anthropic",
    "Anthropic",
    "Anthropic provider via adapter or compatible proxy.",
    "beta",
    ["api-key"],
    ["messages", "chat-completions"],
  ),
  entry(
    "model_provider",
    "claude-code",
    "Claude Code",
    "Claude subscription provider via Claude Code OAuth token.",
    "beta",
    ["oauth"],
    ["messages", "chat-completions"],
  ),
  entry(
    "model_provider",
    "google",
    "Google",
    "Google model provider via adapter/proxy.",
    "beta",
    ["api-key"],
    ["chat-completions"],
  ),
  entry("model_provider", "minimax", "MiniMax", "MiniMax provider route.", "beta", ["api-key"], ["chat-completions"]),
  entry(
    "model_provider",
    "vercel",
    "Vercel AI Gateway",
    "Vercel AI Gateway compatible endpoint.",
    "beta",
    ["api-key"],
    ["chat-completions"],
  ),
  entry(
    "model_provider",
    "openrouter",
    "OpenRouter",
    "OpenRouter aggregated model endpoint.",
    "native",
    ["api-key"],
    ["chat-completions"],
  ),
  entry("model_provider", "mistral", "Mistral", "Mistral provider route.", "beta", ["api-key"], ["chat-completions"]),
  entry(
    "model_provider",
    "deepseek",
    "DeepSeek",
    "DeepSeek provider route.",
    "beta",
    ["api-key"],
    ["chat-completions"],
  ),
  entry(
    "model_provider",
    "glm",
    "GLM (Z.AI)",
    "GLM provider route via Z.AI OpenAI-compatible API.",
    "beta",
    ["api-key"],
    ["chat-completions"],
  ),
  entry(
    "model_provider",
    "moonshot",
    "Moonshot (Kimi API)",
    "Moonshot Kimi OpenAI-compatible provider route.",
    "beta",
    ["api-key"],
    ["chat-completions"],
  ),
  entry(
    "model_provider",
    "ollama",
    "Ollama",
    "Ollama local runtime via OpenAI-compatible endpoint.",
    "native",
    ["local"],
    ["chat-completions"],
  ),
  entry(
    "model_provider",
    "perplexity",
    "Perplexity",
    "Perplexity provider route.",
    "beta",
    ["api-key"],
    ["chat-completions"],
  ),
  entry(
    "model_provider",
    "huggingface",
    "HuggingFace",
    "HuggingFace inference route.",
    "beta",
    ["api-key"],
    ["chat-completions"],
  ),
  entry(
    "model_provider",
    "local-models",
    "Local Models",
    "Local model backends (LM Studio/Ollama/LocalAI).",
    "native",
    ["local"],
    ["chat-completions"],
  ),
  // Productivity
  entry(
    "productivity",
    "apple-notes",
    "Apple Notes",
    "Sync or publish notes to Apple Notes.",
    "beta",
    ["local-agent"],
    ["read", "write"],
  ),
  entry(
    "productivity",
    "apple-reminders",
    "Apple Reminders",
    "Task/reminder sync with Apple Reminders.",
    "beta",
    ["local-agent"],
    ["read", "write"],
  ),
  entry(
    "productivity",
    "things3",
    "Things 3",
    "Things 3 task integration.",
    "beta",
    ["local-agent"],
    ["read", "write"],
  ),
  entry(
    "productivity",
    "notion",
    "Notion",
    "Notion pages: search, read, create and append through an internal integration token.",
    "beta",
    ["token"],
    ["read", "write"],
  ),
  entry("productivity", "obsidian", "Obsidian", "Obsidian vault integration.", "beta", ["local"], ["vault"]),
  entry("productivity", "bear", "Bear Notes", "Bear notes integration.", "beta", ["local-agent"], ["read", "write"]),
  entry("productivity", "trello", "Trello", "Trello board/task integration.", "beta", ["oauth"], ["read", "write"]),
  entry(
    "productivity",
    "github",
    "GitHub",
    "GitHub issues and pull requests: list, read, create issues and comment through a fine-grained token.",
    "beta",
    ["token"],
    ["read", "write"],
  ),

  // Automation tools
  entry(
    "automation",
    "browser-chrome-control",
    "Browser Control",
    "Chrome/Chromium automation and capture flows.",
    "beta",
    ["local"],
    ["browse", "automation", "screenshots"],
  ),
  entry(
    "automation",
    "canvas-a2ui",
    "Canvas + A2UI",
    "Visual canvas workspace and agent-to-ui interactions.",
    "beta",
    ["local"],
    ["scene-view", "selection", "inspect", "agent-apply"],
  ),
  entry(
    "automation",
    "voice-wake-talk",
    "Voice Wake + Talk",
    "Wake-word and voice interaction pipeline.",
    "beta",
    ["local"],
    ["voice"],
  ),
  entry(
    "automation",
    "gmail",
    "Gmail and Google Calendar",
    "Google sign-in for Gmail read and send, and Calendar list and create. Sends and new events always ask for approval.",
    "beta",
    ["oauth"],
    ["read", "write", "calendar"],
  ),
  entry(
    "automation",
    "imap-smtp",
    "IMAP/SMTP Mail",
    "Send approved mail through your own SMTP server. IMAP inbox reading is not available yet.",
    "beta",
    ["password"],
    ["send"],
  ),
  entry("automation", "cron", "Cron Jobs", "Scheduled task orchestration.", "native", ["local"], ["scheduling"]),
  entry(
    "automation",
    "webhooks",
    "Webhooks",
    "Inbound/outbound webhook automation.",
    "native",
    ["token"],
    ["events", "automation"],
  ),
  entry(
    "automation",
    "activepieces",
    "Activepieces",
    "Activepieces webhook bridge for explicit operator-run flows.",
    "beta",
    ["webhook"],
    ["trigger"],
  ),
  entry("automation", "weather", "Weather", "Weather data integration.", "native", ["none"], ["data"]),
  entry(
    "automation",
    "image-gen",
    "Image Generation",
    "Image generation model integration with generate/edit support.",
    "beta",
    ["api-key"],
    ["generation", "edits"],
  ),
  entry("automation", "gif-search", "GIF Search", "GIF search integration.", "beta", ["api-key"], ["search"]),
  entry(
    "automation",
    "peekaboo-screen",
    "Peekaboo Screen",
    "Screen capture and remote control integration.",
    "beta",
    ["local-agent"],
    ["capture", "control"],
  ),
  entry(
    "automation",
    "camera-photo-video",
    "Camera",
    "Photo/video capture integration.",
    "beta",
    ["local-agent"],
    ["capture"],
  ),

  // Platforms
  entry(
    "platform",
    "macos-menubar-voice",
    "macOS Menu Bar + Voice",
    "Native macOS app integration target.",
    "beta",
    ["local-agent"],
    ["voice", "tray"],
  ),
  entry(
    "platform",
    "ios-canvas-camera-voice",
    "iOS Canvas/Camera/Voice",
    "Native iOS companion capabilities.",
    "beta",
    ["app-auth"],
    ["canvas", "camera", "voice"],
  ),
  entry(
    "platform",
    "android-canvas-camera-screen",
    "Android Canvas/Camera/Screen",
    "Native Android companion capabilities.",
    "beta",
    ["app-auth"],
    ["canvas", "camera", "screen"],
  ),
  entry(
    "platform",
    "windows-wsl2",
    "Windows (WSL2 Recommended)",
    "Windows host platform support.",
    "native",
    ["local"],
    ["desktop"],
  ),
  entry("platform", "linux-native", "Linux Native", "Linux native platform support.", "native", ["local"], ["desktop"]),
];

validateCatalogSchemas(INTEGRATION_CATALOG);

export function getIntegrationFormSchema(catalogId: string): IntegrationFormSchema | undefined {
  return INTEGRATION_CATALOG.find((entry) => entry.catalogId === catalogId)?.formSchema;
}

export function resolveIntegrationCatalogMaturity(
  entry: IntegrationCatalogEntry,
  _pluginIds: ReadonlySet<string>,
): IntegrationCatalogEntry["maturity"] {
  void _pluginIds;
  return entry.maturity === "planned" ? "disabled" : entry.maturity;
}

export function resolveIntegrationCatalogRuntimeAvailability(
  entry: IntegrationCatalogEntry,
  pluginIds: ReadonlySet<string>,
): "runnable" | "blocked" {
  const resolvedMaturity = resolveIntegrationCatalogMaturity(entry, pluginIds);
  if (resolvedMaturity === "native" || resolvedMaturity === "beta" || resolvedMaturity === "plugin") {
    return "runnable";
  }
  return "blocked";
}

function entry(
  kind: IntegrationCatalogEntry["kind"],
  key: string,
  label: string,
  description: string,
  maturity: IntegrationCatalogEntry["maturity"],
  authMethods: string[],
  capabilities: string[],
  options: {
    pluginId?: string;
  } = {},
): IntegrationCatalogEntry {
  const catalogId = `${kind}.${key}`;
  return entryWithOperatorActions({
    catalogId,
    kind,
    key,
    label,
    description,
    maturity,
    authMethods,
    capabilities,
    pluginId: options.pluginId,
    formSchema: FORM_SCHEMA_OVERRIDES[catalogId] ?? buildDefaultFormSchema(catalogId, label, kind, key),
  });
}

function buildDefaultFormSchema(
  catalogId: string,
  label: string,
  kind: IntegrationCatalogEntry["kind"],
  key: string,
): IntegrationFormSchema {
  const fields: IntegrationFieldSchema[] = [
    text("label", "Connection Label", { defaultValue: label }),
    bool("enabled", "Enabled", true),
  ];

  if (kind === "model_provider") {
    fields.push(
      url("baseUrl", "Base URL", { placeholder: "https://api.example.com/v1", required: true }),
      text("model", "Default Model", { placeholder: "model-name", required: true }),
      text("apiKeyEnv", "API Key ENV Var", {
        placeholder: `${key.toUpperCase().replaceAll("-", "_")}_API_KEY`,
        secretRef: true,
      }),
    );
  } else if (kind === "channel") {
    fields.push(
      text("target", "Default Target", { placeholder: "channel/thread/peer id" }),
      text("tokenEnv", "Token ENV Var", {
        placeholder: `${key.toUpperCase().replaceAll("-", "_")}_TOKEN`,
        secretRef: true,
        advanced: true,
      }),
    );
  } else if (kind === "automation") {
    fields.push(
      text("endpoint", "Endpoint", { placeholder: "Optional endpoint override" }),
      text("apiKeyEnv", "API Key ENV Var", {
        placeholder: `${key.toUpperCase().replaceAll("-", "_")}_API_KEY`,
        secretRef: true,
        advanced: true,
      }),
    );
  }

  fields.push(text("notes", "Notes", { advanced: true, placeholder: "Optional operator note" }));

  return {
    catalogId,
    title: `${label} Connection`,
    description: "Guided setup form. Advanced JSON is available for non-standard options.",
    allowAdvancedJson: true,
    fields,
  };
}

function validateCatalogSchemas(entries: IntegrationCatalogEntry[]): void {
  const keyPattern = /^[a-zA-Z0-9_.-]+$/;
  for (const entry of entries) {
    const schema = entry.formSchema;
    if (!schema) {
      continue;
    }
    for (const field of schema.fields) {
      if (!keyPattern.test(field.key)) {
        throw new Error(`Invalid integration form key "${field.key}" for catalog "${entry.catalogId}".`);
      }
    }
  }
}

function providerSchema(
  catalogId: string,
  label: string,
  apiKeyEnvDefault: string,
  baseUrl: string,
  defaultModel: string,
  localNoKey = false,
): IntegrationFormSchema {
  return {
    catalogId,
    title: `${label} Provider`,
    description: "Register model provider connection settings.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: label }),
      url("baseUrl", "Base URL", { defaultValue: baseUrl, required: true }),
      text("model", "Default Model", { defaultValue: defaultModel, required: true }),
      text("apiKeyEnv", "API Key ENV Var", {
        defaultValue: apiKeyEnvDefault || undefined,
        placeholder: localNoKey ? "Not required for local runtime" : "OPENAI_API_KEY",
        required: !localNoKey,
        secretRef: true,
      }),
      bool("enabled", "Enabled", true),
    ],
  };
}

function text(key: string, label: string, options: Partial<IntegrationFieldSchema> = {}): IntegrationFieldSchema {
  return { key, label, type: "text", ...options };
}

function url(key: string, label: string, options: Partial<IntegrationFieldSchema> = {}): IntegrationFieldSchema {
  return { key, label, type: "url", ...options };
}

function bool(key: string, label: string, defaultValue = false): IntegrationFieldSchema {
  return { key, label, type: "boolean", defaultValue };
}

function select(
  key: string,
  label: string,
  values: string[],
  defaultValue?: string,
  options: Partial<IntegrationFieldSchema> = {},
): IntegrationFieldSchema {
  return {
    key,
    label,
    type: "select",
    options: values.map((value) => ({ value, label: value })),
    defaultValue,
    ...options,
  };
}

function json(key: string, label: string, options: Partial<IntegrationFieldSchema> = {}): IntegrationFieldSchema {
  return { key, label, type: "json", ...options };
}
