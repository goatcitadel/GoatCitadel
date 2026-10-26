import {
  resolveAllowedSenders,
  resolveChannelOwnerActorIds,
  type DiscordPairingRecord,
  type IntegrationConnection,
  type TelegramChannelPairingList,
} from "@goatcitadel/contracts";

/**
 * What the channel page shows, worked out from a connection's saved settings. Everything here is a name an operator
 * can read: a provider's chat, channel, user and phone ids stay out of these results.
 */
export interface PostingTarget {
  label: string;
  isDefault: boolean;
}
export interface ApprovedSender {
  actorId: string;
  label: string;
}
export interface OwnerCandidate extends ApprovedSender {
  isOwner: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** A provider id (a chat, channel, user or phone number) is a run of digits or an all-caps code, never a name. */
function looksLikeProviderId(value: string): boolean {
  return /^[+-]?\d[\d\s-]*$/.test(value) || /^[A-Z][A-Z0-9]{8,}$/.test(value);
}

/** A handle such as "@ops_group" or "#alerts" is a name; an id is replaced by the plain fallback. */
function readableName(address: string, fallback: string): string {
  return looksLikeProviderId(address) ? fallback : address;
}

interface NamedTargetChannel {
  addressKeys: readonly string[];
  legacyKey: string;
  unnamed: string;
  legacy: string;
}
const TARGET_CHANNELS: Readonly<Record<"telegram" | "slack", NamedTargetChannel>> = {
  telegram: {
    addressKeys: ["chatId", "target", "defaultChatId"],
    legacyKey: "defaultChatId",
    unnamed: "Unnamed chat",
    legacy: "Default chat",
  },
  slack: {
    addressKeys: ["channel", "target", "defaultChannel"],
    legacyKey: "defaultChannel",
    unnamed: "Unnamed channel",
    legacy: "Default channel",
  },
};

/** The named targets, saved either as a list or as JSON text. */
function readTargetRecords(config: Record<string, unknown>): Record<string, unknown>[] {
  let raw = config.targets;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  return Array.isArray(raw) ? raw.filter(isRecord) : [];
}

function singleTarget(address: unknown, fallback: string): PostingTarget[] {
  const text = readText(address);
  return text ? [{ label: readableName(text, fallback), isDefault: true }] : [];
}

function namedTargets(config: Record<string, unknown>, channel: NamedTargetChannel): PostingTarget[] {
  // Like the Gateway, a target counts only when it says where to post.
  const records = readTargetRecords(config)
    .map((record) => ({
      record,
      address: channel.addressKeys.map((key) => readText(record[key])).find((value) => value !== undefined),
    }))
    .filter((entry): entry is { record: Record<string, unknown>; address: string } => entry.address !== undefined);
  if (!records.length) return singleTarget(config[channel.legacyKey], channel.legacy);
  const hasMarkedDefault = records.some((entry) => entry.record.default === true);
  return records.map(({ record, address }, index) => ({
    label: readText(record.label) ?? readableName(address, channel.unnamed),
    // With none marked, the first is the default, which is where the Gateway posts.
    isDefault: hasMarkedDefault ? record.default === true : index === 0,
  }));
}

/**
 * Where a channel posts when nobody says where: its named targets, marking the default, or the single legacy
 * default. Telegram and Slack keep `config.targets`; Discord and WhatsApp keep one default each.
 */
export function postingTargets(connection: IntegrationConnection): PostingTarget[] {
  const { config } = connection;
  switch (connection.key) {
    case "telegram":
      return namedTargets(config, TARGET_CHANNELS.telegram);
    case "slack":
      return namedTargets(config, TARGET_CHANNELS.slack);
    case "discord":
      return singleTarget(config.defaultChannelId, "Default channel");
    case "whatsapp":
      return singleTarget(config.defaultTarget, "Default contact");
    default:
      return [];
  }
}

/** Ids are compared the way the Gateway compares them: trimmed and case-insensitive. */
const idKey = (value: string) => value.trim().toLowerCase();

/** What an approved sender with no display name is called: the channel says who it can, and nothing more. */
function unnamedSenderLabel(connection: IntegrationConnection): string {
  return `Someone on ${connection.label}`;
}

/**
 * The approved senders to offer "This is you" for: each approved sender once, then any account still saved as you
 * that is no longer approved, so it can be cleared.
 */
export function ownerCandidates(
  connection: IntegrationConnection,
  approved: readonly ApprovedSender[],
): OwnerCandidate[] {
  const owners = resolveChannelOwnerActorIds(connection.config);
  const seen = new Set<string>();
  const candidates: OwnerCandidate[] = [];
  for (const sender of approved) {
    const actorId = sender.actorId.trim();
    if (!actorId || seen.has(idKey(actorId))) continue;
    seen.add(idKey(actorId));
    candidates.push({ actorId, label: sender.label, isOwner: owners.includes(idKey(actorId)) });
  }
  for (const owner of owners) {
    if (!seen.has(owner)) candidates.push({ actorId: owner, label: unnamedSenderLabel(connection), isOwner: true });
  }
  return candidates;
}

/** The accounts to save as you after marking or clearing one, keeping the others and their spelling. */
export function ownerActorIdsWith(connection: IntegrationConnection, actorId: string, isOwner: boolean): string[] {
  const saved = connection.config.ownerActorIds;
  const entries = (Array.isArray(saved) ? saved : [])
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter(Boolean);
  const target = idKey(actorId);
  const others = entries.filter((entry) => idKey(entry) !== target);
  if (!isOwner) return others;
  const unique = new Map<string, string>();
  for (const entry of entries) if (!unique.has(idKey(entry))) unique.set(idKey(entry), entry);
  return unique.has(target) ? [...unique.values()] : [...others, actorId.trim()];
}

/** The pairing records a channel keeps: Telegram's list, and Discord's records. Other channels keep none. */
export interface PairingSources {
  telegram?: Pick<TelegramChannelPairingList, "items" | "allowedSenders">;
  discord?: readonly Pick<DiscordPairingRecord, "pairingId" | "userId" | "status" | "displayName">[];
}

/**
 * A person who messaged the bot and is waiting to be approved. It carries what the approve and deny calls need (a
 * Telegram request's code, a Discord request's pairing), never shown as text.
 */
export type PendingRequest = { key: string; label: string } & (
  | { kind: "telegram"; actorId: string; code: string | undefined }
  | { kind: "discord"; pairingId: string; userId: string }
);

/** The requests waiting for an answer, named by the person's display name or, without one, by their channel. */
export function pendingRequests(connection: IntegrationConnection, sources: PairingSources): PendingRequest[] {
  const label = (displayName: string | undefined) => readText(displayName) ?? unnamedSenderLabel(connection);
  if (connection.key === "telegram" && sources.telegram) {
    return sources.telegram.items
      .filter((item) => item.status === "pending")
      .map((item) => ({
        kind: "telegram" as const,
        key: `telegram:${item.actorId}`,
        label: label(item.displayName),
        actorId: item.actorId,
        code: item.code,
      }));
  }
  if (connection.key === "discord" && sources.discord) {
    return sources.discord
      .filter((record) => record.status === "pending")
      .map((record) => ({
        kind: "discord" as const,
        key: `discord:${record.pairingId}`,
        label: label(record.displayName),
        pairingId: record.pairingId,
        userId: record.userId,
      }));
  }
  return [];
}

/**
 * Who is allowed to message the channel, by name. Telegram and Discord keep pairing records with display names; any
 * other channel keeps its allow list, which has ids only.
 */
export function approvedSenders(connection: IntegrationConnection, sources: PairingSources): ApprovedSender[] {
  const found = new Map<string, ApprovedSender>();
  const add = (actorId: string, displayName?: string) => {
    const id = actorId.trim();
    if (!id || found.has(idKey(id))) return;
    found.set(idKey(id), { actorId: id, label: readText(displayName) ?? unnamedSenderLabel(connection) });
  };
  if (connection.key === "telegram" && sources.telegram) {
    for (const item of sources.telegram.items) if (item.status === "approved") add(item.actorId, item.displayName);
    for (const sender of sources.telegram.allowedSenders) add(sender);
  } else if (connection.key === "discord" && sources.discord) {
    for (const record of sources.discord) if (record.status === "approved") add(record.userId, record.displayName);
  } else {
    for (const sender of resolveAllowedSenders(connection.config)) add(sender);
  }
  return [...found.values()];
}

/** The bot or team the channel says it is connected as, when it says: Telegram and Slack in settings, Discord live. */
export function botIdentity(
  connection: IntegrationConnection,
  runtimeMetadata: Record<string, unknown> | undefined,
): string | undefined {
  switch (connection.key) {
    case "telegram": {
      const username = readText(connection.config.botUsername);
      return username ? `Bot ${username.startsWith("@") ? username : `@${username}`}` : undefined;
    }
    case "discord": {
      const tag = readText(runtimeMetadata?.connectedBotTag);
      return tag ? `Bot ${tag}` : undefined;
    }
    case "slack": {
      const team = readText(connection.config.slackTeamName);
      return team ? `Connected to ${team}` : undefined;
    }
    default:
      return undefined;
  }
}
