export interface ChannelFeatureMetadata {
  supportedDeliveryActions: string[];
  supportedAttachmentSources: string[];
  supportNotes: string[];
  setupDiagnostics: string[];
}

type ChannelRule = {
  supportedDeliveryActions?: string[];
  resolveSupportedDeliveryActions?: (config: Record<string, unknown>) => string[];
  supportedAttachmentSources?: string[];
  resolveSupportedAttachmentSources?: (config: Record<string, unknown>) => string[];
  supportNotes?: string[];
  resolveSupportNotes?: (config: Record<string, unknown>) => string[];
  requiredAnyOf?: string[][];
};

const CHANNEL_RULES: Record<string, ChannelRule> = {
  slack: {
    resolveSupportedDeliveryActions: (config) =>
      hasAnyConfigured(config, ["botTokenEnv", "botToken", "tokenEnv", "token"])
        ? ["channel.send", "channel.react", "channel.unsend"]
        : ["channel.send"],
    resolveSupportedAttachmentSources: (config) =>
      hasAnyConfigured(config, ["botTokenEnv", "botToken", "tokenEnv", "token"])
        ? ["url", "inline"]
        : ["url"],
    resolveSupportNotes: (config) =>
      hasAnyConfigured(config, ["botTokenEnv", "botToken", "tokenEnv", "token"])
        ? [
          "Interactive actions use the Slack Web API and require the bot to have the needed chat and reactions scopes.",
          "Slack bot-token connections support URL-backed attachment previews and uploaded inline files when the app has files:write and can reach Slack upload hosts.",
        ]
        : [
          "Webhook-only Slack connections support send only plus URL-backed attachment previews. Reactions, unsend, and inline file uploads require a bot token.",
        ],
    requiredAnyOf: [["botTokenEnv", "botToken", "webhookUrl", "url"]],
  },
  discord: {
    supportedAttachmentSources: ["url", "inline"],
    resolveSupportedDeliveryActions: (config) => {
      if (hasAnyConfigured(config, ["botTokenEnv", "botToken", "tokenEnv", "token"])) {
        return ["channel.send", "channel.react", "channel.unsend"];
      }
      if (hasAnyConfigured(config, ["webhookUrl", "url"])) {
        return ["channel.send", "channel.unsend"];
      }
      return ["channel.send"];
    },
    resolveSupportNotes: (config) =>
      hasAnyConfigured(config, ["botTokenEnv", "botToken", "tokenEnv", "token"])
        ? [
          "Bot-token Discord connections support reactions and deleting messages in channels the bot can manage.",
          "Discord rich sends support uploaded inline files and URL-backed embeds.",
        ]
        : hasAnyConfigured(config, ["webhookUrl", "url"])
          ? [
            "Webhook-only Discord connections can unsend webhook-authored messages, but cannot add reactions.",
            "Webhook-mode Discord sends support uploaded inline files and URL-backed embeds.",
          ]
          : [],
    requiredAnyOf: [["botTokenEnv", "botToken", "webhookUrl", "url"]],
  },
  telegram: {
    supportedDeliveryActions: ["channel.send", "channel.react", "channel.unsend"],
    supportedAttachmentSources: ["url", "inline"],
    supportNotes: [
      "Telegram bot connections can add reactions and delete sent messages when the bot has access to the target chat.",
      "Telegram rich sends use photo/document delivery and apply the message body as the first caption when it fits provider limits.",
    ],
    requiredAnyOf: [["botTokenEnv", "botToken", "tokenEnv", "token"]],
  },
  matrix: {
    supportedDeliveryActions: ["channel.send", "channel.react", "channel.unsend"],
    supportedAttachmentSources: ["url", "inline"],
    supportNotes: [
      "Matrix unsend uses event redaction and depends on room permissions for the bot user.",
      "Matrix rich sends upload media to the homeserver and emit attachment events per file.",
    ],
    requiredAnyOf: [["homeserverUrl"], ["accessTokenEnv", "accessToken"]],
  },
  "google-chat": {
    supportedDeliveryActions: ["channel.send"],
    supportedAttachmentSources: ["url"],
    supportNotes: [
      "Google Chat webhook sends support URL-backed rich cards for image and link attachments.",
    ],
    requiredAnyOf: [["webhookUrl", "url"]],
  },
  teams: {
    supportedDeliveryActions: ["channel.send"],
    supportedAttachmentSources: ["url"],
    supportNotes: [
      "Teams webhook sends support URL-backed adaptive card attachments for images and links.",
    ],
    requiredAnyOf: [["webhookUrl", "url"]],
  },
  whatsapp: {
    supportedDeliveryActions: ["channel.send", "channel.react"],
    supportedAttachmentSources: ["url", "inline"],
    supportNotes: [
      "WhatsApp Cloud API rich sends support public URL media and uploaded inline files for supported image, video, audio, and document types.",
      "WhatsApp reactions are sent through the Cloud API, but unsend/delete is still not wired in this bridge.",
    ],
    requiredAnyOf: [["phoneNumberId"], ["accessTokenEnv", "accessToken", "tokenEnv", "token"]],
  },
  signal: {
    supportedDeliveryActions: ["channel.send"],
    requiredAnyOf: [["baseUrl", "bridgeUrl"]],
  },
  mattermost: {
    supportedDeliveryActions: ["channel.send", "channel.react", "channel.unsend"],
    supportedAttachmentSources: ["url", "inline"],
    supportNotes: [
      "Mattermost unsend deletes the original post and typically applies only to posts the bot can remove.",
      "Mattermost rich sends upload files to the resolved channel before creating the post.",
    ],
    requiredAnyOf: [["serverUrl"], ["botTokenEnv", "botToken"]],
  },
  imessage: {
    supportedDeliveryActions: ["channel.send", "channel.react", "channel.unsend"],
    supportedAttachmentSources: ["url", "inline"],
    supportNotes: [
      "Attachment sends to brand-new handles require BlueBubbles chat creation support.",
      "Reactions and unsend require BlueBubbles Private API support.",
    ],
    requiredAnyOf: [["bridgeUrl", "baseUrl", "serverUrl"], ["passwordEnv", "password", "apiPasswordEnv", "apiPassword"]],
  },
  "nextcloud-talk": {
    supportedDeliveryActions: ["channel.send", "channel.react"],
    supportNotes: [
      "Nextcloud Talk bot connections support inbound webhooks, outbound replies, and bot reactions through the documented bot API.",
      "Attachments and unsend remain unsupported in this adapter.",
    ],
    requiredAnyOf: [["baseUrl"], ["tokenEnv", "token", "botSecretEnv", "botSecret", "secretEnv", "secret"]],
  },
  line: {
    supportedDeliveryActions: ["channel.send"],
    requiredAnyOf: [["channelAccessTokenEnv", "channelAccessToken", "accessTokenEnv", "accessToken"]],
  },
  zalo: {
    supportedDeliveryActions: ["channel.send"],
    requiredAnyOf: [["accessTokenEnv", "accessToken", "tokenEnv", "token"]],
  },
  zalouser: {
    supportedDeliveryActions: ["channel.send"],
    supportedAttachmentSources: ["url"],
    supportNotes: [
      "Rich media sends currently require URL-backed attachments for the zca bridge.",
    ],
    requiredAnyOf: [["baseUrl", "bridgeUrl", "serverUrl"], ["authToken", "authTokenEnv", "authorization", "authorizationEnv"]],
  },
};

export function describeChannelFeatureMetadata(
  channelKey: string,
  config: Record<string, unknown>,
): ChannelFeatureMetadata {
  const rule = CHANNEL_RULES[channelKey] ?? {
    supportedDeliveryActions: ["channel.send"],
    requiredAnyOf: [],
  };
  const setupDiagnostics = buildSetupDiagnostics(rule, config);
  return {
    supportedDeliveryActions: [
      ...(rule.resolveSupportedDeliveryActions?.(config) ?? rule.supportedDeliveryActions ?? ["channel.send"]),
    ],
    supportedAttachmentSources: [
      ...(rule.resolveSupportedAttachmentSources?.(config) ?? rule.supportedAttachmentSources ?? []),
    ],
    supportNotes: [...(rule.resolveSupportNotes?.(config) ?? rule.supportNotes ?? [])],
    setupDiagnostics,
  };
}

function buildSetupDiagnostics(rule: ChannelRule, config: Record<string, unknown>): string[] {
  const diagnostics: string[] = [];
  for (const group of rule.requiredAnyOf ?? []) {
    if (group.some((key) => readConfigString(config, key))) {
      continue;
    }
    diagnostics.push(`Missing one of: ${group.map((key) => `config.${key}`).join(", ")}.`);
  }
  return diagnostics;
}

function readConfigString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function hasAnyConfigured(config: Record<string, unknown>, keys: string[]): boolean {
  return keys.some((key) => Boolean(readConfigString(config, key)));
}
