import type { ChatMode, ChatSendMessageRequest } from "@goatcitadel/contracts";
import { DEFAULT_CITADEL_ID } from "@goatcitadel/contracts";
import type { SurfaceClassification } from "./surface-router-heuristics.js";
import type { SurfaceRouteRequest } from "./surface-router-service.js";
import type { SurfaceRouteOverrideSignalInput } from "./improvement-service.js";

export interface AutoRouteHost {
  surfaceRouter?: { route(req: SurfaceRouteRequest): SurfaceClassification };
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
  if (!input.autoRoute || input.mode !== undefined || !host.surfaceRouter || !host.persistChatSessionMode) {
    return input;
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

export interface ModeOverrideHost {
  readChatSessionMode?(sessionId: string): ChatMode | undefined;
  persistChatSessionMode?(sessionId: string, mode: ChatMode): void;
  recordSurfaceRouteOverrideSignal?(input: SurfaceRouteOverrideSignalInput): void;
  normalizeWorkspaceId(workspaceId?: string): string;
  storage: {
    chatSessionMeta: { ensure(sessionId: string): { workspaceId?: string } };
    workspaces?: { find(workspaceId: string): { citadelId?: string } | undefined };
  };
}

/**
 * When the client supplies an explicit mode that differs from the session's
 * already-persisted (sticky) mode, the user overrode the router: re-pin the new
 * mode and record a learning signal. No-op on the first turn (no persisted mode)
 * or a sticky turn (mode unchanged).
 */
export function recordModeOverrideIfChanged(
  host: ModeOverrideHost,
  sessionId: string,
  input: ChatSendMessageRequest,
): void {
  if (input.mode === undefined || !host.readChatSessionMode || !host.persistChatSessionMode) {
    return;
  }
  const persistedMode = host.readChatSessionMode(sessionId);
  if (persistedMode === undefined || persistedMode === input.mode) {
    return;
  }
  host.persistChatSessionMode(sessionId, input.mode);
  if (host.recordSurfaceRouteOverrideSignal) {
    const sessionMeta = host.storage.chatSessionMeta.ensure(sessionId);
    const workspaceId = host.normalizeWorkspaceId(sessionMeta.workspaceId);
    const citadelId = host.storage.workspaces?.find(workspaceId)?.citadelId ?? DEFAULT_CITADEL_ID;
    host.recordSurfaceRouteOverrideSignal({
      citadelId,
      workspaceId,
      sessionId,
      turnId: `${sessionId}:pending`,
      fromMode: persistedMode,
      toMode: input.mode,
      autoConfidence: 0,
      promptFeatureHash: hashPromptFeatures(input.content),
    });
  }
}

/** Stable, non-reversible bucket of the prompt's shape (first word + capped length), NOT the transcript. */
export function hashPromptFeatures(content: string): string {
  const firstWord = (content.trim().split(/\s+/)[0] ?? "").toLowerCase().slice(0, 24);
  return `${firstWord}:${Math.min(content.length, 4000)}`;
}
