export interface ChannelFeatureMetadata {
  supportedDeliveryActions: string[];
  supportedAttachmentSources: string[];
  supportNotes: string[];
  setupDiagnostics: string[];
}

type ChannelRule = {
  supportedDeliveryActions: string[];
  supportedAttachmentSources?: string[];
  supportNotes?: string[];
  requiredAnyOf?: string[][];
};

const CHANNEL_RULES: Record<string, ChannelRule> = {
  slack: {
    supportedDeliveryActions: ["channel.send"],
    requiredAnyOf: [["botTokenEnv", "botToken", "webhookUrl", "url"]],
  },
  discord: {
    supportedDeliveryActions: ["channel.send"],
    requiredAnyOf: [["botTokenEnv", "botToken", "webhookUrl", "url"]],
  },
  telegram: {
    supportedDeliveryActions: ["channel.send"],
    requiredAnyOf: [["botTokenEnv", "botToken", "tokenEnv", "token"]],
  },
  matrix: {
    supportedDeliveryActions: ["channel.send"],
    requiredAnyOf: [["homeserverUrl"], ["accessTokenEnv", "accessToken"]],
  },
  "google-chat": {
    supportedDeliveryActions: ["channel.send"],
    requiredAnyOf: [["webhookUrl", "url"]],
  },
  teams: {
    supportedDeliveryActions: ["channel.send"],
    requiredAnyOf: [["webhookUrl", "url"]],
  },
  whatsapp: {
    supportedDeliveryActions: ["channel.send"],
    requiredAnyOf: [["phoneNumberId"], ["accessTokenEnv", "accessToken", "tokenEnv", "token"]],
  },
  signal: {
    supportedDeliveryActions: ["channel.send"],
    requiredAnyOf: [["baseUrl", "bridgeUrl"]],
  },
  mattermost: {
    supportedDeliveryActions: ["channel.send"],
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
    supportedDeliveryActions: ["channel.send"],
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
    supportedDeliveryActions: [...rule.supportedDeliveryActions],
    supportedAttachmentSources: [...(rule.supportedAttachmentSources ?? [])],
    supportNotes: [...(rule.supportNotes ?? [])],
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
