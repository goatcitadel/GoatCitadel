import type {
  ChatMessageRecord,
  ChatSessionPrefsPatch,
  ChatSessionPrefsRecord,
  ChatSessionRecord,
  ChatSideChatRecord,
  ChatStreamChunk,
  ChatThreadResponse,
} from "@goatcitadel/contracts";
import {
  createChatSideChat,
  fetchChatThread,
  preflightChatRoute,
  streamAgentChatMessage,
} from "@goatcitadel/mission-control-shared/api/client";
import {
  isThreadMutatingStreamChunk,
  updateThreadFromStreamChunk,
  type PendingStreamTurnSeed,
} from "@goatcitadel/mission-control-shared/components/chat/chat-thread-reducer";
import type { Dispatch, SetStateAction } from "react";
import {
  ChatStreamingPreviewBuffer,
  isReducedMotionPreferred,
  type ChatStreamingPreview,
} from "./chat-streaming-preview";
import type { FirstParentHandoff, SideChatScope, useBtwSideChatController } from "./useBtwSideChatController";
import type { ChatPreviewRuntime } from "./useChatStreamingPreviewState";

const previewRuntime = { ChatStreamingPreviewBuffer, isReducedMotionPreferred };

type SideChatInput = Pick<
  Parameters<typeof useBtwSideChatController>[0],
  "currentSurface" | "fullWebAccess" | "prefs" | "selectedModel" | "selectedProviderId" | "selectedTurnId"
>;

export function startBtwSideChat({
  isCurrent,
  ensureSession,
  selectedSessionId,
  selectedSessionIntentRef,
  workspaceId,
  scope,
  installation,
  access,
  caller,
  firstParentRef,
  ...view
}: Omit<Parameters<typeof ensureBtwSideChat>[0], "current" | "resolveParent"> & {
  isCurrent: (handoff?: FirstParentHandoff) => boolean;
  ensureSession: Parameters<typeof useBtwSideChatController>[0]["ensureSession"];
  selectedSessionId: string | null;
  selectedSessionIntentRef: { current: string | null };
  workspaceId: string;
  scope: SideChatScope;
  installation: string;
  access: number;
  caller: number;
  firstParentRef: { current: FirstParentHandoff | null };
}) {
  let handoff: FirstParentHandoff | undefined;
  const current = () => isCurrent(handoff);
  const resolveParent = async () => {
    // Only this open can follow the verified creation before it selects the parent.
    const parent = await ensureSession((created) => {
      if (
        handoff ||
        selectedSessionId !== null ||
        !isCurrent() ||
        created.workspaceId !== workspaceId ||
        !created.sessionId.trim()
      )
        return;
      handoff = {
        origin: scope,
        parentId: created.sessionId,
        parentIdentity: JSON.stringify([installation, access, caller, workspaceId, created.sessionId]),
      };
      firstParentRef.current = handoff;
    });
    if (
      !current() ||
      parent.sessionId !== selectedSessionIntentRef.current ||
      (handoff && parent.workspaceId !== workspaceId)
    ) {
      throw new Error("Side chat scope changed. Reopen it in the current conversation.");
    }
    return parent;
  };
  return { current, open: () => ensureBtwSideChat({ ...view, current, resolveParent }) };
}

async function ensureBtwSideChat({
  current,
  resolveParent,
  record,
  childSession,
  input,
  setRecord,
  setChildSession,
  setThread,
  setLoading,
  setError,
}: {
  current: () => boolean;
  resolveParent: () => Promise<ChatSessionRecord>;
  record: ChatSideChatRecord | null;
  childSession: ChatSessionRecord | null;
  input: Pick<SideChatInput, "currentSurface" | "selectedTurnId">;
  setRecord: (record: ChatSideChatRecord) => void;
  setChildSession: (session: ChatSessionRecord) => void;
  setThread: (thread: ChatThreadResponse) => void;
  setLoading: (loading: boolean) => void;
  setError: (error: string | null) => void;
}) {
  if (!current()) throw new Error("Side chat scope changed. Reopen it in the current conversation.");
  const parent = await resolveParent();
  if (!current()) throw new Error("Side chat scope changed. Reopen it in the current conversation.");
  if (record?.parentSessionId === parent.sessionId && childSession) {
    return { item: record, childSession };
  }
  setLoading(true);
  try {
    const created = await createChatSideChat(
      parent.sessionId,
      { createdFromSurface: input.currentSurface, sourceTurnId: input.selectedTurnId ?? undefined },
      { originSurface: input.currentSurface },
    );
    if (!current()) throw new Error("Side chat scope changed.");
    setRecord(created.item);
    setChildSession(created.childSession);
    const nextThread = await fetchChatThread(created.childSession.sessionId);
    if (!current()) throw new Error("Side chat scope changed.");
    setThread(nextThread);
    setError(null);
    return created;
  } finally {
    if (current()) setLoading(false);
  }
}

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
