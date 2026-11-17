import { CHAT_MCP_ACCESS_MESSAGES, ConflictError, type ChatMcpAccessBlocker } from "@goatcitadel/contracts";

export function mcpChatAccessError(blocker: ChatMcpAccessBlocker): ConflictError {
  return new ConflictError({ message: CHAT_MCP_ACCESS_MESSAGES[blocker], details: { mcpAccessBlocker: blocker } });
}
