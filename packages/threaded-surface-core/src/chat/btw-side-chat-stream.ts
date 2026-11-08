import type {
  ChatMessageRecord,
  ChatSessionPrefsPatch,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatSideChatRecord,
  ChatStreamChunk,
  ChatThreadResponse,
} from "@goatcitadel/contracts";
import { fetchChatThread, preflightChatRoute, streamAgentChatMessage } from "@goatcitadel/mission-control-shared/api/client";
import {
  isThreadMutatingStreamChunk,
  updateThreadFromStreamChunk,
  type PendingStreamTurnSeed,
} from "@goatcitadel/mission-control-shared/components/chat/chat-thread-reducer";
import type { Dispatch, SetStateAction } from "react";
import { ChatStreamingPreviewBuffer, isReducedMotionPreferred, type ChatStreamingPreview } from "./chat-streaming-preview";
import type { useBtwSideChatController } from "./useBtwSideChatController";
import type { ChatPreviewRuntime } from "./useChatStreamingPreviewState";

const previewRuntime = { ChatStreamingPreviewBuffer, isReducedMotionPreferred };

type SideChatInput = Pick<
  Parameters<typeof useBtwSideChatController>[0],
  "currentSurface" | "fullWebAccess" | "prefs" | "selectedModel" | "selectedProviderId" | "selectedTurnId"
>;

export function createInterruptedBtwReplyProjection(snapshot: ChatStreamingPreview) {
  const partialChunk: ChatStreamChunk = {
    type: "message_done",
    sessionId: snapshot.sessionId,
    eventId: `local-btw-preview-${Date.now()}`,
    sequence: -1,
    turnId: snapshot.turnId,
    messageId: snapshot.messageId ?? `local-assistant-${snapshot.turnId}`,
    content: snapshot.text,
  };
  return (current: ChatThreadResponse | null) =>
    updateThreadFromStreamChunk(current, partialChunk, null, snapshot.sessionId, null);
}

export async function streamBtwSideChatTurn({
  current,
  getStreamingPreviewBuffer,
  input,
  message,
  parentTurnId,
  promoteStreamingPreviewToThread,
  setError,
  setThread,
  sideChat,
}: {
  current: () => boolean;
  getStreamingPreviewBuffer: (runtime: ChatPreviewRuntime) => ChatStreamingPreviewBuffer;
  input: SideChatInput;
  message: string;
  parentTurnId?: string;
  promoteStreamingPreviewToThread: (sessionId: string, project: typeof createInterruptedBtwReplyProjection) => void;
  setError: (message: string) => void;
  setThread: Dispatch<SetStateAction<ChatThreadResponse | null>>;
  sideChat: { item: ChatSideChatRecord; childSession: ChatSessionRecord };
}) {
  const optimisticPrefs = buildBtwOptimisticPrefs(input.prefs, input.selectedProviderId, input.selectedModel);
  const userMessage: ChatMessageRecord = {
    messageId: `local-btw-user-${Date.now()}`,
    sessionId: sideChat.childSession.sessionId,
    role: "user",
    actorType: "user",
    actorId: "operator",
    sourceAuthority: "operator",
    content: message,
    timestamp: new Date().toISOString(),
  };
  const seed: PendingStreamTurnSeed = {
    userMessage,
    parentTurnId,
    branchKind: "append",
    mode: "send",
  };

  const route = await preflightChatRoute(
    sideChat.childSession.sessionId,
    {
      action: "send",
      providerId: input.selectedProviderId,
      model: input.selectedModel,
      mode: "chat",
      prefsOverride: buildBtwPrefsOverride(input.prefs, input.selectedProviderId, input.selectedModel),
    },
    { originSurface: "chat" },
  );
  if (!current()) return;
  if (route.blockedReason) {
    throw new Error(route.blockedReason);
  }
  await streamAgentChatMessage(
    sideChat.childSession.sessionId,
    {
      content: message,
      providerId: route.effectiveProviderId ?? input.selectedProviderId,
      model: route.effectiveModel ?? input.selectedModel,
      routeDecision: route.decision,
      mode: "chat",
      prefsOverride: buildBtwPrefsOverride(input.prefs, route.effectiveProviderId, route.effectiveModel),
      fullWebAccess: input.fullWebAccess,
      sideChatContext: {
        parentSessionId: sideChat.item.parentSessionId,
        originSurface: input.currentSurface,
        selectedTurnId: input.selectedTurnId ?? undefined,
        recentTurnLimit: 6,
      },
    },
    (chunk: ChatStreamChunk) => {
      if (!current()) return;
      if (chunk.type === "error") {
        setError(chunk.error || "Side chat stream failed.");
        promoteStreamingPreviewToThread(sideChat.childSession.sessionId, createInterruptedBtwReplyProjection);
        return;
      }
      if (chunk.type === "message_start") {
        getStreamingPreviewBuffer(previewRuntime).start({
          sessionId: chunk.sessionId,
          turnId: chunk.turnId,
          messageId: chunk.messageId,
        });
      }
      if (chunk.type === "delta") {
        // Per-token deltas feed the rAF-coalesced preview buffer instead of the
        // thread, so thread identity only changes on real chunk boundaries.
        getStreamingPreviewBuffer(previewRuntime).append({
          sessionId: chunk.sessionId,
          turnId: chunk.turnId,
          messageId: chunk.messageId,
          delta: chunk.delta,
        });
        return;
      }
      if (chunk.type === "message_done") {
        const previewBuffer = getStreamingPreviewBuffer(previewRuntime);
        if (!previewBuffer.matches(chunk.sessionId, chunk.turnId)) {
          previewBuffer.start({
            sessionId: chunk.sessionId,
            turnId: chunk.turnId,
            messageId: chunk.messageId,
          });
        }
        previewBuffer.finish({ clear: true, forceVisible: false, finalText: chunk.content });
      }
      if (!isThreadMutatingStreamChunk(chunk)) {
        return;
      }
      setThread((current) =>
        updateThreadFromStreamChunk(current, chunk, seed, sideChat.childSession.sessionId, optimisticPrefs),
      );
    },
    { originSurface: "chat" },
  );
  if (!current()) return;
  const finalThread = await fetchChatThread(sideChat.childSession.sessionId);
  if (current()) setThread(finalThread);
}

function buildBtwPrefsOverride(
  prefs: ChatSessionPrefsRecord | null,
  providerId?: string,
  model?: string,
): ChatSessionPrefsPatch {
  return {
    mode: "chat",
    providerId: providerId ?? prefs?.providerId,
    model: model ?? prefs?.model,
    webMode: prefs?.webMode,
    memoryMode: prefs?.memoryMode,
    thinkingLevel: prefs?.thinkingLevel,
    speedMode: prefs?.speedMode,
    subagentPolicy: prefs?.subagentPolicy,
  };
}

function buildBtwOptimisticPrefs(
  prefs: ChatSessionPrefsRecord | null,
  providerId?: string,
  model?: string,
): ChatSessionPrefsRecord | null {
  return prefs
    ? {
        ...prefs,
        mode: "chat",
        providerId: providerId ?? prefs.providerId,
        model: model ?? prefs.model,
      }
    : null;
}
