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
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.telegram": {
    catalogId: "channel.telegram",
    title: "Telegram Connection",
    description: "Connect a Telegram bot token and default chat target.",
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
  "channel.matrix": {
    catalogId: "channel.matrix",
    title: "Matrix Connection",
    description:
      "Catalog-only Matrix setup entry. Live send/read probes are not enabled until a Matrix adapter is wired.",
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
        placeholder: "!roomid:example.com",
        required: true,
      }),
      bool("enabled", "Enabled", false),
    ],
  },
  "channel.qqbot": {
    catalogId: "channel.qqbot",
    title: "QQBot Connection",
    description: "Catalog-only QQBot setup entry. Live send/read probes are not enabled until an adapter is wired.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "QQBot" }),
      text("appId", "App ID", { required: true }),
      text("tokenEnv", "Token ENV Var", {
        placeholder: "QQBOT_TOKEN",
        secretRef: true,
      }),
      text("defaultTarget", "Default Target", {
        placeholder: "guild/channel/user id",
        required: true,
      }),
      bool("enabled", "Enabled", false),
    ],
  },
  "channel.wecom": {
    catalogId: "channel.wecom",
    title: "WeCom Connection",
    description: "Catalog-only WeCom setup entry. Live send/read probes are not enabled until an adapter is wired.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "WeCom" }),
      text("corpId", "Corp ID", { required: true }),
      text("agentId", "Agent ID", { required: true }),
      text("secretEnv", "Secret ENV Var", {
        placeholder: "WECOM_SECRET",
        secretRef: true,
      }),
      text("defaultTarget", "Default Target", {
        placeholder: "user id, party id, or chat id",
        required: true,
      }),
      bool("enabled", "Enabled", false),
    ],
  },
  "channel.google-chat": {
    catalogId: "channel.google-chat",
    title: "Google Chat Connection",
    description: "Connect a Google Chat incoming webhook and optional thread key.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Google Chat" }),
      url("webhookUrl", "Webhook URL", {
        placeholder: "https://chat.googleapis.com/v1/spaces/...",
        required: true,
      }),
      text("defaultThreadKey", "Default Thread Key", {
        placeholder: "goatcitadel-thread",
        advanced: true,
      }),
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
        placeholder: "https://outlook.office.com/webhook/...",
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
    description: "Connect a WhatsApp Cloud API sender identity and default direct recipient target.",
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
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.signal": {
    catalogId: "channel.signal",
    title: "Signal Connection",
    description: "Configure a Signal JSON-RPC bridge, account, and default recipient for outbound sends.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Signal" }),
      url("baseUrl", "Bridge URL", {
        placeholder: "http://127.0.0.1:8080",
        required: true,
      }),
      text("accountId", "Account ID", {
        placeholder: "+15551234567",
        advanced: true,
      }),
      text("defaultRecipient", "Default Recipient", {
        placeholder: "+15551234567 or group identifier",
        required: true,
      }),
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.mattermost": {
    catalogId: "channel.mattermost",
    title: "Mattermost Connection",
    description: "Connect a Mattermost bot token and default channel target.",
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
      bool("enabled", "Enabled", true),
    ],
  },
  "channel.imessage": {
    catalogId: "channel.imessage",
    title: "iMessage Connection",
    description: "Configure a BlueBubbles-compatible iMessage bridge, password, and default target.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "iMessage" }),
      url("bridgeUrl", "Bridge URL", {
        placeholder: "http://127.0.0.1:3001",
        required: true,
      }),
      text("passwordEnv", "Bridge Password ENV Var", {
        placeholder: "IMESSAGE_PASSWORD",
        required: true,
        secretRef: true,
      }),
      text("defaultHandle", "Default Handle", {
        placeholder: "imessage:+15551234567 or chat_guid:iMessage;-;+15551234567",
        required: true,
      }),
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
          "Public HTTPS origin for your Nextcloud Talk instance. Register GoatCitadel's webhook path under this reverse-proxied domain.",
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
  "channel.zalouser": {
    catalogId: "channel.zalouser",
    title: "Zalo Personal Connection",
    description: "Configure a zca serve bridge for a personal Zalo session and default recipient target.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Zalo Personal" }),
      url("baseUrl", "Bridge URL", {
        placeholder: "http://127.0.0.1:56789",
        required: true,
      }),
      text("authTokenEnv", "Bearer Token ENV Var", {
        placeholder: "ZALOUSER_AUTH_TOKEN",
        secretRef: true,
        advanced: true,
      }),
      text("profile", "Profile", {
        placeholder: "work",
        advanced: true,
      }),
      text("defaultTarget", "Default Recipient", {
        placeholder: "user:u-123456789 or group:g-987654321",
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
    title: "Gmail Connection",
    description: "Configure Gmail integration using OAuth token handles or env references.",
    allowAdvancedJson: true,
    fields: [
      text("label", "Connection Label", { defaultValue: "Gmail" }),
      select("authMode", "Auth Mode", ["oauth", "env"], "oauth"),
      text("clientIdEnv", "Client ID ENV Var", {
        placeholder: "GMAIL_CLIENT_ID",
        secretRef: true,
        advanced: true,
      }),
      text("clientSecretEnv", "Client Secret ENV Var", {
        placeholder: "GMAIL_CLIENT_SECRET",
        secretRef: true,
        advanced: true,
      }),
      text("refreshTokenHandle", "Refresh Token Handle", {
        placeholder: "gmail-primary",
        required: true,
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
  "model_provider.lmstudio": providerSchema(
    "model_provider.lmstudio",
    "LM Studio",
    "",
    "http://127.0.0.1:1234/v1",
    "local-model",
    true,
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
    ["oauth", "bot-token"],
    ["chat", "threads", "attachments", "reactions", "unsend", "inbound"],
  ),
  entry("channel", "signal", "Signal", "Signal messenger bridge.", "beta", ["device-link"], ["chat", "groups"]),
  entry(
    "channel",
    "whatsapp",
    "WhatsApp",
    "WhatsApp business bridge.",
    "beta",
    ["oauth", "token"],
    ["chat", "attachments", "direct", "reactions"],
  ),
  entry(
    "channel",
    "telegram",
    "Telegram",
    "Telegram bot integration.",
    "beta",
    ["bot-token"],
    ["chat", "threads", "attachments", "reactions", "unsend", "typing"],
  ),
  entry(
    "channel",
    "matrix",
    "Matrix",
    "Matrix catalog/setup entry. Runtime adapter probes are not wired yet.",
    "planned",
    ["token"],
    ["catalog", "setup"],
  ),
  entry(
    "channel",
    "qqbot",
    "QQBot",
    "QQBot catalog/setup entry. Runtime adapter probes are not wired yet.",
    "planned",
    ["token"],
    ["catalog", "setup"],
  ),
  entry(
    "channel",
    "wecom",
    "WeCom",
    "WeCom catalog/setup entry. Runtime adapter probes are not wired yet.",
    "planned",
    ["token"],
    ["catalog", "setup"],
  ),
  entry(
    "channel",
    "slack",
    "Slack",
    "Slack app/bot integration.",
    "beta",
    ["oauth"],
    ["chat", "threads", "mentions", "attachments", "reactions", "unsend"],
  ),
  entry(
    "channel",
    "google-chat",
    "Google Chat",
    "Google Chat app and webhook integration.",
    "beta",
    ["oauth", "token"],
    ["chat", "spaces", "threads", "attachments"],
    { pluginId: "googlechat" },
  ),
  entry(
    "channel",
    "mattermost",
    "Mattermost",
    "Mattermost bot/webhook integration.",
    "beta",
    ["token"],
    ["chat", "channels", "direct", "attachments", "reactions", "unsend"],
  ),
  entry(
    "channel",
    "imessage",
    "iMessage",
    "iMessage bridge (platform dependent).",
    "beta",
    ["local-agent"],
    ["chat", "attachments", "reactions", "unsend", "replies"],
  ),
  entry(
    "channel",
    "teams",
    "Microsoft Teams",
    "Teams bot/webhook integration.",
    "beta",
    ["oauth", "webhook"],
    ["chat", "threads", "attachments"],
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
    ["chat", "groups", "rooms", "direct"],
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
  entry(
    "channel",
    "zalouser",
    "Zalo User",
    "Zalo user-session bridge integration.",
    "beta",
    ["token"],
    ["chat", "attachments", "direct"],
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
  entry(
    "model_provider",
    "npu-local",
    "NPU Local Sidecar",
    "Local ONNX Runtime GenAI sidecar for Windows ARM64 Snapdragon NPU acceleration.",
    "beta",
    ["local"],
    ["chat-completions", "npu"],
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
    "Notion workspace integration.",
    "planned",
    ["oauth", "token"],
    ["workspace-link"],
  ),
  entry("productivity", "obsidian", "Obsidian", "Obsidian vault integration.", "beta", ["local"], ["vault"]),
  entry("productivity", "bear", "Bear Notes", "Bear notes integration.", "beta", ["local-agent"], ["read", "write"]),
  entry("productivity", "trello", "Trello", "Trello board/task integration.", "beta", ["oauth"], ["read", "write"]),
  entry(
    "productivity",
    "github",
    "GitHub",
    "GitHub issue/pr/repo automation integration.",
    "planned",
    ["token"],
    ["repo-link"],
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
  entry("automation", "gmail", "Gmail", "Gmail read/send integration.", "beta", ["oauth"], ["read", "write"]),
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
