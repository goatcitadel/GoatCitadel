/** Builds the errand channel notices from live Gateway pieces, so the errand composition only hands them over. */

import type { ChannelSendInput } from "@goatcitadel/contracts";
import {
  createOwnErrandConversationLookup,
  readPickedErrandApprovalSessionId,
  type ErrandEscalationSources,
} from "./errand-escalation-gateway.js";
import { createErrandChannelNotices, type ErrandChannelNotices } from "./errand-channel-notices.js";

export interface ErrandChannelNoticeSources extends Pick<
  ErrandEscalationSources,
  "config" | "storage" | "readDiscordPairings"
> {
  /** Sends a channel message as GoatCitadel's own delivery. */
  sendChannelMessage(input: ChannelSendInput & { idempotencyKey?: string }): Promise<unknown>;
}

export function createGatewayErrandChannelNotices(sources: ErrandChannelNoticeSources): ErrandChannelNotices {
  const { config, storage } = sources;
  const ownConversation = createOwnErrandConversationLookup(sources);
  return createErrandChannelNotices({
    send: (input) => sources.sendChannelMessage(input),
    pickedConversation: async () => {
      const sessionId = readPickedErrandApprovalSessionId(config);
      return sessionId ? (await ownConversation(sessionId))?.conversation : undefined;
    },
    attachmentSessionId: async (attachmentId) => (await storage.chatAttachments.get(attachmentId)).sessionId,
  });
}
