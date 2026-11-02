import { resolveChannelOwnerActorIds } from "@goatcitadel/contracts";
import { isAllowlistedChannelOwner } from "../channel-owner-access.js";

export interface ErrandOwnerInput {
  /** The channel the conversation is on, as the connection's key ("telegram", "discord", ...). */
  channelKey: string;
  /** The connection's stored config. */
  config: Record<string, unknown>;
  /** The provider user id that sent the message. */
  actorId: string;
  /** Discord user ids with an approved pairing on this connection; ignored on other channels. */
  discordApprovedActorIds?: readonly string[];
}

function normalizeActorId(actorId: string): string {
  return actorId.trim().toLowerCase();
}

/** The actor ids in `config.telegramPairing.approved`, trimmed and lowercased; malformed entries are skipped. */
function telegramApprovedActorIds(config: Record<string, unknown>): string[] {
  const pairing = config.telegramPairing;
  if (!pairing || typeof pairing !== "object" || Array.isArray(pairing)) {
    return [];
  }
  const approved = (pairing as { approved?: unknown }).approved;
  if (!Array.isArray(approved)) {
    return [];
  }
  return approved.flatMap((entry: unknown) => {
    const actorId = entry && typeof entry === "object" ? (entry as { actorId?: unknown }).actorId : undefined;
    return typeof actorId === "string" && actorId.trim() ? [normalizeActorId(actorId)] : [];
  });
}

/**
 * Whether this sender is the operator's own account on the connection: marked "This is you" (`ownerActorIds`) and
 * still let in, either on the sender allowlist of an allowlist-mode connection or by a pairing that is still approved
 * (Telegram `telegramPairing.approved`, or an approved Discord pairing record). Revoking the pairing ends it, even
 * though the owner mark stays.
 */
export function isErrandOwner(input: ErrandOwnerInput): boolean {
  const actorId = normalizeActorId(input.actorId);
  if (!actorId || !resolveChannelOwnerActorIds(input.config).includes(actorId)) {
    return false;
  }
  if (isAllowlistedChannelOwner(input.config, actorId)) {
    return true;
  }
  if (input.channelKey === "telegram") {
    return telegramApprovedActorIds(input.config).includes(actorId);
  }
  if (input.channelKey === "discord") {
    return (input.discordApprovedActorIds ?? []).some((approved) => normalizeActorId(approved) === actorId);
  }
  return false;
}
