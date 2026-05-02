import type {
  ChannelTargetDirectory,
  ChannelTargetDirectoryEntry,
  ChannelTargetKind,
  ChannelTargetResolution,
} from "@goatcitadel/contracts";
import type { TelegramDiscoveredTarget } from "./telegram-target-discovery.js";

export interface BuildTelegramTargetDirectoryInput {
  connectionId: string;
  connectionConfig: Record<string, unknown>;
  discoveredTargets?: TelegramDiscoveredTarget[];
  now?: Date;
}

interface ConfigTarget {
  chatId?: string;
  channel?: string;
  label?: string;
  kind?: ChannelTargetKind;
  default?: boolean;
}

export function buildTelegramTargetDirectory(input: BuildTelegramTargetDirectoryInput): ChannelTargetDirectory {
  const refreshedAt = (input.now ?? new Date()).toISOString();
  const entries = new Map<string, ChannelTargetDirectoryEntry>();

  for (const target of normalizeConfigTargets(input.connectionConfig)) {
    const targetId = target.chatId ?? target.channel;
    if (!targetId) {
      continue;
    }
    entries.set(targetId, {
      targetId,
      platform: "telegram",
      kind: target.kind ?? inferTelegramKind(targetId),
      displayLabel: target.label || targetId,
      canonicalName: canonicalizeTargetName(target.label || targetId),
      source: "connection_config",
      lastSeenAt: refreshedAt,
      metadata: target.default ? { default: true } : undefined,
    });
  }

  const legacyTarget = readString(input.connectionConfig, "defaultChatId");
  if (legacyTarget && !entries.has(legacyTarget)) {
    entries.set(legacyTarget, {
      targetId: legacyTarget,
      platform: "telegram",
      kind: inferTelegramKind(legacyTarget),
      displayLabel: "Telegram default",
      canonicalName: canonicalizeTargetName("Telegram default"),
      source: "connection_config",
      lastSeenAt: refreshedAt,
      metadata: { default: true, legacy: true },
    });
  }

  for (const target of input.discoveredTargets ?? []) {
    entries.set(target.chatId, {
      targetId: target.chatId,
      platform: "telegram",
      kind: target.kind,
      displayLabel: target.label,
      canonicalName: canonicalizeTargetName(target.label),
      source: "recent_update",
      lastSeenAt: refreshedAt,
      metadata: {
        setupCodeMatched: target.setupCodeMatched,
        lastMessageId: target.lastMessageId,
      },
    });
  }

  return {
    connectionId: input.connectionId,
    platform: "telegram",
    refreshedAt,
    entries: [...entries.values()].sort((left, right) => left.displayLabel.localeCompare(right.displayLabel)),
  };
}

export function resolveChannelTarget(
  directory: Pick<ChannelTargetDirectory, "platform" | "entries">,
  query: string,
): ChannelTargetResolution {
  const trimmed = query.trim();
  const normalized = canonicalizeTargetName(trimmed.replace(new RegExp(`^${directory.platform}:`, "i"), ""));
  if (!trimmed || !normalized) {
    return {
      status: "not_found",
      query,
      message: "Provide a channel target name or id.",
    };
  }

  const exact = directory.entries.filter(
    (entry) =>
      entry.targetId === trimmed ||
      entry.canonicalName === normalized ||
      canonicalizeTargetName(entry.displayLabel) === normalized,
  );
  if (exact.length === 1) {
    return { status: "resolved", entry: exact[0]! };
  }
  if (exact.length > 1) {
    return ambiguous(query, exact);
  }

  const prefix = directory.entries.filter(
    (entry) =>
      entry.canonicalName.startsWith(normalized) || canonicalizeTargetName(entry.displayLabel).startsWith(normalized),
  );
  if (prefix.length === 1) {
    return { status: "resolved", entry: prefix[0]! };
  }
  if (prefix.length > 1) {
    return ambiguous(query, prefix);
  }
  return {
    status: "not_found",
    query,
    message: `No ${directory.platform} target matched "${trimmed}".`,
  };
}

export function canonicalizeTargetName(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/^[@#]+/, "")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function ambiguous(query: string, matches: ChannelTargetDirectoryEntry[]): ChannelTargetResolution {
  return {
    status: "ambiguous",
    query,
    matches,
    message: `More than one target matched "${query.trim()}": ${matches
      .slice(0, 5)
      .map((entry) => `${entry.displayLabel} (${entry.targetId})`)
      .join(", ")}.`,
  };
}

function normalizeConfigTargets(config: Record<string, unknown>): ConfigTarget[] {
  const targets = config.targets;
  if (!Array.isArray(targets)) {
    return [];
  }
  return targets
    .filter((target): target is Record<string, unknown> => typeof target === "object" && target !== null)
    .map((target) => ({
      chatId: readString(target, "chatId"),
      channel: readString(target, "channel"),
      label: readString(target, "label"),
      kind: readTargetKind(target.kind),
      default: target.default === true,
    }));
}

function inferTelegramKind(targetId: string): ChannelTargetKind {
  if (targetId.startsWith("@")) {
    return "channel";
  }
  if (targetId.startsWith("-100")) {
    return "supergroup";
  }
  if (targetId.startsWith("-")) {
    return "group";
  }
  return "private";
}

function readTargetKind(value: unknown): ChannelTargetKind | undefined {
  return value === "private" ||
    value === "group" ||
    value === "supergroup" ||
    value === "channel" ||
    value === "thread" ||
    value === "unknown"
    ? value
    : undefined;
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}
