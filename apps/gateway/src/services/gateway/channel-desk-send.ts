import { ConflictError, NotFoundError } from "@goatcitadel/contracts";
import type { AsyncStorage } from "@goatcitadel/storage";
import {
  routeOperatorDeskSend,
  type ChannelDeskTurnHost,
  type OperatorDeskSendInput,
  type OperatorDeskSendResult,
} from "../channel-desk-turn.js";

/** Resolve the channel and session before handing a desk send to the channel owner. */
export async function sendOperatorDeskMessage(
  storage: Pick<AsyncStorage, "chatSessionBindings" | "integrationConnections" | "sessions" | "chatMessages">,
  sessionId: string,
  input: OperatorDeskSendInput,
  acceptOperatorDeskEvent: ChannelDeskTurnHost,
): Promise<OperatorDeskSendResult> {
  const binding = await storage.chatSessionBindings.get(sessionId);
  if (binding?.transport !== "integration" || !binding.connectionId) {
    return { mode: "post" };
  }
  if (input.expectedChatApprovalModeRevision !== undefined) {
    throw new ConflictError({ message: "The approval mode precondition requires a direct local Chat send." });
  }
  const connection = await storage.integrationConnections.get(binding.connectionId).catch((error: unknown) => {
    if (error instanceof NotFoundError) return undefined;
    throw error;
  });
  const session = await storage.sessions.getBySessionId(sessionId);
  const lastInboundAt = await storage.chatMessages.latestChannelMessageAt(sessionId);
  return await routeOperatorDeskSend(
    { sessionId, sessionKey: session.sessionKey, binding, connection, ...input, lastInboundAt },
    acceptOperatorDeskEvent,
  );
}
