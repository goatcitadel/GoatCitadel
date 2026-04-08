/**
 * Chat turn engine façade.
 *
 * Groups the chat turn / agent-message public surface of GatewayService
 * behind standalone functions with a minimal Host interface. Bodies
 * remain in GatewayService; this is an API-surface boundary only. Same
 * pattern as approval-lifecycle-service.ts.
 *
 * Covers sub-steps 8a (send/stream), 8b (retry/stream), 8c (edit/stream),
 * and 8d (cancel / respond-to-existing / tool-approval).
 */

import type { GatewayService } from "./gateway-service.js";

type GS = GatewayService;

export interface ChatTurnEngineHost {
  agentSendChatMessage: GS["agentSendChatMessage"];
  agentSendChatMessageStream: GS["agentSendChatMessageStream"];
  retryChatTurn: GS["retryChatTurn"];
  retryChatTurnStream: GS["retryChatTurnStream"];
  editChatTurn: GS["editChatTurn"];
  editChatTurnStream: GS["editChatTurnStream"];
  cancelChatTurn: GS["cancelChatTurn"];
  respondToExistingChatMessage: GS["respondToExistingChatMessage"];
  resolveChatToolApproval: GS["resolveChatToolApproval"];
}

// 8a — send
export async function agentSendChatMessage(
  host: ChatTurnEngineHost,
  ...args: Parameters<GS["agentSendChatMessage"]>
): Promise<Awaited<ReturnType<GS["agentSendChatMessage"]>>> {
  return host.agentSendChatMessage(...args);
}

export function agentSendChatMessageStream(
  host: ChatTurnEngineHost,
  ...args: Parameters<GS["agentSendChatMessageStream"]>
): ReturnType<GS["agentSendChatMessageStream"]> {
  return host.agentSendChatMessageStream(...args);
}

// 8b — retry
export async function retryChatTurn(
  host: ChatTurnEngineHost,
  ...args: Parameters<GS["retryChatTurn"]>
): Promise<Awaited<ReturnType<GS["retryChatTurn"]>>> {
  return host.retryChatTurn(...args);
}

export function retryChatTurnStream(
  host: ChatTurnEngineHost,
  ...args: Parameters<GS["retryChatTurnStream"]>
): ReturnType<GS["retryChatTurnStream"]> {
  return host.retryChatTurnStream(...args);
}

// 8c — edit
export async function editChatTurn(
  host: ChatTurnEngineHost,
  ...args: Parameters<GS["editChatTurn"]>
): Promise<Awaited<ReturnType<GS["editChatTurn"]>>> {
  return host.editChatTurn(...args);
}

export function editChatTurnStream(
  host: ChatTurnEngineHost,
  ...args: Parameters<GS["editChatTurnStream"]>
): ReturnType<GS["editChatTurnStream"]> {
  return host.editChatTurnStream(...args);
}

// 8d — cancel / respond-to-existing / tool-approval
export async function cancelChatTurn(
  host: ChatTurnEngineHost,
  ...args: Parameters<GS["cancelChatTurn"]>
): Promise<Awaited<ReturnType<GS["cancelChatTurn"]>>> {
  return host.cancelChatTurn(...args);
}

export async function respondToExistingChatMessage(
  host: ChatTurnEngineHost,
  ...args: Parameters<GS["respondToExistingChatMessage"]>
): Promise<Awaited<ReturnType<GS["respondToExistingChatMessage"]>>> {
  return host.respondToExistingChatMessage(...args);
}

export async function resolveChatToolApproval(
  host: ChatTurnEngineHost,
  ...args: Parameters<GS["resolveChatToolApproval"]>
): Promise<Awaited<ReturnType<GS["resolveChatToolApproval"]>>> {
  return host.resolveChatToolApproval(...args);
}
