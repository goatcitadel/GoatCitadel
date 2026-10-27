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
