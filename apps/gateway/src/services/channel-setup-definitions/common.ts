import type {
  ChannelSetupDefinition,
  ChannelSetupDraft,
  ChannelSetupFailureMapEntry,
  ChannelSetupHydrationResult,
  ChannelSetupIssue,
  ChannelSetupNoticeTone,
  IntegrationCatalogEntry,
  IntegrationConnection,
} from "@goatcitadel/contracts";
import { INTEGRATION_CATALOG } from "../integration-catalog.js";

export interface ChannelSetupRuntimeDefinition {
  definition: ChannelSetupDefinition;
  hydrate(connection: IntegrationConnection): {
    draft: Record<string, unknown>;
    hydration: ChannelSetupHydrationResult;
  };
  normalize(draft: ChannelSetupDraft): Record<string, unknown>;
  validate(draft: ChannelSetupDraft): ChannelSetupIssue[];
}

export const COMMON_FAILURES: Record<string, ChannelSetupFailureMapEntry[]> = {
  token: [
    {
      category: "credential_rejected",
      title: "Credential rejected",
      summary: "The platform rejected the credential currently stored in this draft.",
      likelyCauses: [
        "The token was copied incorrectly.",
        "The token expired or was rotated.",
        "The token belongs to another app or bot.",
      ],
      nextSteps: [
        "Copy the credential again from the provider portal.",
        "Replace the stored credential and rerun validation.",
      ],
    },
    {
      category: "permission_mismatch",
      title: "Permissions incomplete",
      summary: "The credential is valid, but the channel target cannot be reached with the current permissions.",
      likelyCauses: [
        "The bot or app is not installed in the destination.",
        "Required scopes or intents were not enabled.",
      ],
      nextSteps: [
        "Confirm the bot or app is installed in the target workspace/server/chat.",
        "Review the permissions checklist and retry the test.",
      ],
    },
  ],
};

export function requireCatalog(catalogId: string): IntegrationCatalogEntry {
  const catalog = INTEGRATION_CATALOG.find((entry) => entry.catalogId === catalogId);
  if (!catalog) {
    throw new Error(`Missing integration catalog entry for ${catalogId}.`);
  }
  return catalog;
}

export function baseCatalogMeta(
  catalog: IntegrationCatalogEntry,
  supportedModes: string[],
): ChannelSetupDefinition["catalog"] {
  return {
    catalogId: catalog.catalogId,
    key: catalog.key,
    label: catalog.label,
    description: catalog.description,
    kind: catalog.kind,
    capabilities: catalog.capabilities,
    maturity: catalog.maturity,
    supportedModes,
  };
}

export function definitionFailures(kind: keyof typeof COMMON_FAILURES) {
  return (COMMON_FAILURES[kind] ?? []).map((entry) => ({
    id: `${kind}-${entry.category}`,
    title: entry.title,
    body: `${entry.summary} ${entry.likelyCauses.join(" ")}`.trim(),
    failureCategory: entry.category,
    nextSteps: entry.nextSteps,
  }));
}

export function paragraph(text: string) {
  return { kind: "paragraph", text } as const;
}

export function note(tone: ChannelSetupNoticeTone, text: string) {
  return { kind: "note", tone, text } as const;
}

export function linkBlock(label: string, href: string) {
  return { kind: "link", label, href, external: true } as const;
}

export function check(id: string, label: string, detail?: string) {
  return { id, label, detail };
}

export function troubleshoot(id: string, title: string, body: string) {
  return { id, title, body };
}

export function readString(config: Record<string, unknown>, key: string): string | undefined {
  const value = config[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export interface SlackSetupTarget {
  id: string;
  label: string;
  channel: string;
  threadTs?: string;
  kind?: string;
  default?: boolean;
}

export interface TelegramSetupTarget {
  id: string;
  label: string;
  chatId: string;
  threadId?: string;
  kind?: string;
  default?: boolean;
}

export interface NormalizedTargetRecord {
  id: string;
  label: string;
  channel?: string;
  chatId?: string;
  threadTs?: string;
  threadId?: string;
  kind?: string;
  default?: boolean;
}

export function normalizeSlackTargets(config: Record<string, unknown>): SlackSetupTarget[] {
  const explicit = normalizeTargetArray(config.targets, "channel", "slack");
  const targets =
    explicit.length > 0 ? explicit : legacyTarget(readString(config, "defaultChannel"), "Slack default", "channel");
  const channelTargets = targets.filter(
    (target): target is NormalizedTargetRecord & { channel: string } => Boolean(target.channel),
  );
  // Only fall back to "first target is default" when the user did not explicitly mark one,
  // otherwise a non-first explicit default ends up co-flagged with target[0] and consumers
  // that pick the first default-flagged entry route to the wrong channel.
  const hasExplicitDefault = channelTargets.some((target) => target.default === true);
  return channelTargets.map((target, index) => ({
    id: target.id || `slack-target-${index + 1}`,
    label: target.label || target.channel || `Slack target ${index + 1}`,
    channel: target.channel,
    threadTs: target.threadTs,
    kind: target.kind,
    default: target.default === true || (!hasExplicitDefault && index === 0),
  }));
}

export function normalizeTelegramTargets(config: Record<string, unknown>): TelegramSetupTarget[] {
  const explicit = normalizeTargetArray(config.targets, "chatId", "telegram");
  const targets =
    explicit.length > 0 ? explicit : legacyTarget(readString(config, "defaultChatId"), "Telegram default", "chatId");
  const chatTargets = targets.filter(
    (target): target is NormalizedTargetRecord & { chatId: string } => Boolean(target.chatId),
  );
  const hasExplicitDefault = chatTargets.some((target) => target.default === true);
  return chatTargets.map((target, index) => ({
    id: target.id || `telegram-target-${index + 1}`,
    label: target.label || target.chatId || `Telegram target ${index + 1}`,
    chatId: target.chatId,
    threadId: target.threadId,
    kind: target.kind,
    default: target.default === true || (!hasExplicitDefault && index === 0),
  }));
}

export function normalizeTargetArray(
  value: unknown,
  addressKey: "channel" | "chatId",
  provider: "slack" | "telegram",
): NormalizedTargetRecord[] {
  const raw = typeof value === "string" ? parseTargetsJson(value) : value;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw
    .filter(
      (item): item is Record<string, unknown> => typeof item === "object" && item !== null && !Array.isArray(item),
    )
    .map((item, index) => {
      const address =
        readString(item, addressKey) ??
        readString(item, "target") ??
        readString(item, provider === "slack" ? "defaultChannel" : "defaultChatId");
      const normalized: NormalizedTargetRecord = {
        id: readString(item, "id") ?? `${provider}-target-${index + 1}`,
        label: readString(item, "label") ?? address ?? `${provider} target ${index + 1}`,
        threadTs: readString(item, "threadTs"),
        threadId: readString(item, "threadId") ?? readString(item, "messageThreadId"),
        kind: readString(item, "kind"),
        // Preserve only the user's explicit default here; the "first target is the implicit
        // default" fallback is applied later (per-provider) so it never overrides a chosen one.
        default: item.default === true || item.default === "true",
      };
      if (addressKey === "channel") {
        normalized.channel = address;
      } else {
        normalized.chatId = address;
      }
      return normalized;
    })
    .filter((item) => Boolean(item[addressKey]));
}

export function legacyTarget(
  address: string | undefined,
  label: string,
  addressKey: "channel" | "chatId",
): NormalizedTargetRecord[] {
  if (!address) {
    return [];
  }
  return addressKey === "channel"
    ? [{ id: "default", label, channel: address, default: true }]
    : [{ id: "default", label, chatId: address, default: true }];
}

export function parseTargetsJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

export function normalizeTelegramUsername(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.startsWith("@") ? trimmed : `@${trimmed}`;
}

export function looksLikeHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value);
}

export function hasAnyConfiguredSecret(config: Record<string, unknown>, keyGroups: string[][]): boolean {
  return keyGroups.some((keys) => keys.some((key) => Boolean(readString(config, key))));
}

export function compactRecord(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(input).filter(([, value]) => {
      if (value === undefined || value === null) {
        return false;
      }
      return typeof value !== "string" || value.trim().length > 0;
    }),
  );
}

export function resolveDiscordRuntimeMode(draft: ChannelSetupDraft): "bridge" | "gateway" {
  const explicit = readString(draft.draft, "runtimeMode");
  if (explicit === "bridge" || explicit === "gateway") {
    return explicit;
  }
  const hasBotToken = Boolean(readString(draft.draft, "botToken") || readString(draft.draft, "botTokenEnv"));
  const hasWebhook = Boolean(readString(draft.draft, "webhookUrl"));
  if (draft.lifecycleMode === "create") {
    return hasWebhook && !hasBotToken ? "bridge" : "gateway";
  }
  return "bridge";
}

export function inferDiscordConfigRuntimeMode(config: Record<string, unknown>): "bridge" | "gateway" {
  const hasBotToken = Boolean(
    readString(config, "botToken") ||
    readString(config, "botTokenEnv") ||
    readString(config, "token") ||
    readString(config, "tokenEnv"),
  );
  const hasWebhook = Boolean(readString(config, "webhookUrl") || readString(config, "webhookUrlEnv"));
  if (hasWebhook && !hasBotToken) {
    return "bridge";
  }
  if (hasBotToken) {
    return "gateway";
  }
  return "bridge";
}

export function readLegacyString(draft: ChannelSetupDraft, ...keys: string[]): string | undefined {
  const legacyConfig = draft.hydration?.rawLegacyConfig;
  if (!legacyConfig || typeof legacyConfig !== "object") {
    return undefined;
  }
  for (const key of keys) {
    const value = readString(legacyConfig as Record<string, unknown>, key);
    if (value) {
      return value;
    }
  }
  return undefined;
}

export function requiredFieldIssue(fieldKey: string, message: string): ChannelSetupIssue {
  return {
    key: `${fieldKey}_required`,
    level: "error",
    message,
    fieldKey,
    failureCategory: "missing_input",
  };
}

export function malformedFieldIssue(fieldKey: string, message: string): ChannelSetupIssue {
  return {
    key: `${fieldKey}_malformed`,
    level: "error",
    message,
    fieldKey,
    failureCategory: "malformed_value",
  };
}
