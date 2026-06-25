import type { ChatMode, ChatSendMessageRequest } from "@goatcitadel/contracts";
import { DEFAULT_CITADEL_ID } from "@goatcitadel/contracts";
import type { SurfaceClassification } from "./surface-router-heuristics.js";
import type { SurfaceRouteRequest } from "./surface-router-service.js";

export interface AutoRouteHost {
  surfaceRouter?: { route(req: SurfaceRouteRequest): SurfaceClassification };
  readChatSessionMode?(sessionId: string): ChatMode | undefined;
  persistChatSessionMode?(sessionId: string, mode: ChatMode): void;
  normalizeWorkspaceId(workspaceId?: string): string;
  storage: {
    chatSessionMeta: { ensure(sessionId: string): { workspaceId?: string } };
    workspaces?: { find(workspaceId: string): { citadelId?: string } | undefined };
  };
}

/**
 * If the turn requested auto-routing and the session has no resolved mode yet,
 * classify the first turn, persist the chosen mode (sticky), and return input with `mode` set.
 * Otherwise returns input unchanged.
 */
export function applyAutoRouteToInput(
  host: AutoRouteHost,
  sessionId: string,
  input: ChatSendMessageRequest,
): ChatSendMessageRequest {
  if (
    !input.autoRoute ||
    input.mode !== undefined ||
    !host.surfaceRouter ||
    !host.readChatSessionMode ||
    !host.persistChatSessionMode
  ) {
    return input;
  }
  if (host.readChatSessionMode(sessionId) !== undefined) {
    return input; // already has a sticky mode
  }
  const sessionMeta = host.storage.chatSessionMeta.ensure(sessionId);
  const workspaceId = host.normalizeWorkspaceId(sessionMeta.workspaceId);
  const citadelId = host.storage.workspaces?.find(workspaceId)?.citadelId ?? DEFAULT_CITADEL_ID;
  const classified = host.surfaceRouter.route({
    prompt: input.content,
    citadelId,
    workspaceId,
    sessionId,
    turnId: `${sessionId}:pending`,
    context: { hasBoundProject: false },
  });
  host.persistChatSessionMode(sessionId, classified.mode);
  return { ...input, mode: classified.mode };
}
