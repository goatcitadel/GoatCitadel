const CHANNEL_TARGET_KEYS: Record<string, string[]> = {
  slack: ["defaultChannel", "defaultTarget", "target"],
  discord: ["defaultChannelId", "defaultTarget", "target"],
  telegram: ["defaultChatId", "defaultTarget", "target"],
  matrix: ["defaultRoomId", "defaultTarget", "target"],
  "google-chat": ["defaultThreadKey", "defaultTarget", "target"],
  whatsapp: ["defaultTarget", "defaultRecipient", "target"],
  signal: ["defaultRecipient", "defaultTarget", "target"],
  imessage: ["defaultHandle", "defaultTarget", "target"],
  mattermost: ["defaultChannel", "defaultTarget", "target"],
  "nextcloud-talk": ["defaultRoomId", "defaultConversationId", "defaultTarget", "target"],
  line: ["defaultTarget", "defaultUserId", "defaultGroupId", "defaultRoomId", "target"],
  zalo: ["defaultRecipientId", "defaultTarget", "target"],
  zalouser: ["defaultRecipientId", "defaultTarget", "target"],
};

export function resolveChannelConfigTarget(
  channelKey: string,
  config: Record<string, unknown>,
): string | undefined {
  const keys = CHANNEL_TARGET_KEYS[channelKey] ?? ["target", "defaultTarget"];
  for (const key of keys) {
    const value = readConfigString(config, key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

function readConfigString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
