import type { ChatMode, ChatSendMessageRequest } from "@goatcitadel/contracts";

export interface AutoRouteHost {
  readChatSessionMode?(sessionId: string): Promise<ChatMode | undefined>;
  persistChatSessionMode?(sessionId: string, mode: ChatMode): Promise<void>;
}

export type ModeOverrideHost = AutoRouteHost;

const CHAT_ONLY = { mode: "chat", autoRoute: false } as const;

/**
 * Chat is the only conversation surface. Legacy `mode`/`autoRoute` inputs are
 * normalized to `{ mode: "chat", autoRoute: false }` and a stale persisted mode
 * is re-pinned to chat. The `autoRoute:false` marker is kept on purpose: stored
 * durable surface derivations (durable-chat-turn-payload.ts) require it.
 */
export async function applyAutoRouteToInput(
  host: AutoRouteHost,
  sessionId: string,
  input: ChatSendMessageRequest,
): Promise<ChatSendMessageRequest> {
  if (input.mode !== undefined && input.mode !== "chat") {
    await host.persistChatSessionMode?.(sessionId, "chat");
    return { ...input, ...CHAT_ONLY };
  }
  if (!input.autoRoute || input.mode !== undefined) {
    return input.mode === undefined ? input : { ...input, mode: "chat" };
  }
  const persistedMode = await host.readChatSessionMode?.(sessionId);
  if (persistedMode !== "chat") {
    await host.persistChatSessionMode?.(sessionId, "chat");
  }
  return { ...input, ...CHAT_ONLY };
}

/** Re-pin a stale persisted legacy mode to chat when the client sends an explicit mode. */
export async function recordModeOverrideIfChanged(
  host: ModeOverrideHost,
  sessionId: string,
  input: ChatSendMessageRequest,
): Promise<void> {
  if (input.mode === undefined || !host.readChatSessionMode || !host.persistChatSessionMode) {
    return;
  }
  const persistedMode = await host.readChatSessionMode(sessionId);
  if (persistedMode !== undefined && persistedMode !== "chat") {
    await host.persistChatSessionMode(sessionId, "chat");
  }
}

/**
 * Normalize the send turn's surface fields, error-isolated. On any failure,
 * calls onError and returns the input unchanged so the turn always proceeds.
 */
export async function applySurfaceRoutingPreflight(
  host: AutoRouteHost,
  sessionId: string,
  input: ChatSendMessageRequest,
  onError?: (error: unknown) => void,
): Promise<ChatSendMessageRequest> {
  try {
    const routed = await applyAutoRouteToInput(host, sessionId, input);
    await recordModeOverrideIfChanged(host, sessionId, routed);
    return routed;
  } catch (error) {
    onError?.(error);
    return input;
  }
}
