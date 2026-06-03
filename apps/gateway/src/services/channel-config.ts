const CHANNEL_TARGET_KEYS: Record<string, string[]> = {
  slack: ["defaultChannel", "defaultTarget", "target"],
  discord: ["defaultChannelId", "defaultTarget", "target"],
  telegram: ["defaultChatId", "defaultTarget", "target"],
  ntfy: ["topic", "defaultTopic", "defaultTarget", "target"],
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

export function resolveChannelConfigTarget(channelKey: string, config: Record<string, unknown>): string | undefined {
  const defaultTarget = resolveDefaultNamedTarget(config);
  if (defaultTarget) {
    if (channelKey === "telegram") {
      return readConfigString(defaultTarget, "chatId") ?? readConfigString(defaultTarget, "target");
    }
    if (channelKey === "slack") {
      return readConfigString(defaultTarget, "channel") ?? readConfigString(defaultTarget, "target");
    }
  }
  const keys = CHANNEL_TARGET_KEYS[channelKey] ?? ["target", "defaultTarget"];
  for (const key of keys) {
    const value = readConfigString(config, key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function resolveDefaultNamedTarget(config: Record<string, unknown>): Record<string, unknown> | undefined {
  const targets = Array.isArray(config.targets) ? config.targets : [];
  const records = targets.filter((target): target is Record<string, unknown> => isRecord(target));
  return records.find((target) => target.default === true) ?? records[0];
}

function readConfigString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
