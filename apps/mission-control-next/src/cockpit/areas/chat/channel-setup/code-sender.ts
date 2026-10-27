import type { ChannelSetupCodeSender } from "@goatcitadel/contracts";
import {
  channelTargetIdentity,
  mergeDiscoveredChannelTargets,
  readChannelTargetRows,
  type ChannelTargetRow,
} from "../../../../features/native-routes/settings/channel-setup/channel-wizard-model";

/** What to call the person who said hi: the name they gave Telegram, else their @username, else "Someone". */
export function senderName(sender: ChannelSetupCodeSender): string {
  const name = sender.displayName?.trim();
  if (name) return name;
  const username = sender.username?.trim().replace(/^@/u, "");
  return username ? `@${username}` : "Someone";
}

/**
 * Who said hi, as `draftWithSender` saved them on the draft: its first owner, in the chat the code came from (else the
 * chat it posts to by default), named after that chat. Null before anyone has said hi, so a page coming back to the
 * setup knows whether to ask for a hi or to go straight on to turning it on.
 */
export function savedSender(values: Record<string, unknown>): ChannelSetupCodeSender | null {
  const owners = Array.isArray(values.ownerActorIds) ? values.ownerActorIds : [];
  const actorId = owners.find((owner): owner is string => typeof owner === "string" && owner.trim() !== "")?.trim();
  if (!actorId) return null;
  const targets = readChannelTargetRows(values.targets, "chatId");
  const matched = targets.filter((target) => target.setupCodeMatched === true);
  const chat = matched.find((target) => target.default) ?? matched[0] ?? targets.find((target) => target.default);
  const chatId = chat?.chatId?.trim();
  if (!chat || !chatId) return null;
  const label = chat.label.trim();
  return { actorId, chatId, ...(label ? { displayName: label } : {}) };
}

/**
 * The draft's values once someone has said hi: they alone may message the bot and they own it, and their private
 * chat is where it posts by default. Chats already on the draft stay, but are no longer the default. The values
 * given are not changed.
 */
export function draftWithSender(
  values: Record<string, unknown>,
  sender: ChannelSetupCodeSender,
): Record<string, unknown> {
  const privateChat: ChannelTargetRow = {
    id: `telegram:${sender.chatId}`,
    label: senderName(sender),
    chatId: sender.chatId,
    kind: "private",
    source: "recent_update",
    setupCodeMatched: true,
  };
  const home = channelTargetIdentity(privateChat);
  const targets = mergeDiscoveredChannelTargets(readChannelTargetRows(values.targets, "chatId"), [privateChat]).map(
    (target) => ({ ...target, default: channelTargetIdentity(target) === home }),
  );
  return {
    ...values,
    allowedSenders: [sender.actorId],
    ownerActorIds: [sender.actorId],
    inboundAccessMode: "allowlist",
    targets,
  };
}
