import type { ChatThreadResponse } from "@goatcitadel/contracts";
import { useEffect, useRef, type MutableRefObject } from "react";
import {
  getGatewayAccessRevision,
  getGatewayCallerScopeRevision,
  subscribeGatewayAccessChange,
  subscribeGatewayCallerScope,
} from "@goatcitadel/mission-control-shared/api/access-scope";
import { getGatewayApiBaseUrl } from "@goatcitadel/mission-control-shared/api/client-core";
import {
  clearChatStreamActivity,
  recordChatStreamChunkActivity,
} from "@goatcitadel/mission-control-shared/state/chat-stream-activity-store";
import { recordClientDiagnostic } from "@goatcitadel/mission-control-shared/state/dev-diagnostics-store";
import type { ChatStreamingPreviewBuffer } from "./chat-streaming-preview";
import type { ActiveChatStreamState } from "./useChatOutboundExecution.types";

type PreviewRuntime = Pick<typeof import("./chat-streaming-preview"), "ChatStreamingPreviewBuffer" | "isReducedMotionPreferred">;

let retainedStreamCode: Promise<typeof import("./retained-chat-stream")> | undefined;

function loadRetainedStreamCode() {
  return (retainedStreamCode ??= import("./retained-chat-stream").catch((error: unknown) => {
    retainedStreamCode = undefined;
    throw error;
  }));
}

export interface RetainedStreamReattachmentInput {
  selectedSessionId: string | null;
  thread: ChatThreadResponse | null;
  streamEnabled: boolean;
  activeStreamRef: MutableRefObject<ActiveChatStreamState | null>;
  sendingRef: MutableRefObject<boolean>;
  locallyHandledTurnKeysRef: MutableRefObject<Set<string>>;
  setSending: (value: boolean) => void;
  getStreamingPreviewBuffer: (runtime: PreviewRuntime) => ChatStreamingPreviewBuffer;
  clearStreamingPreview: () => void;
  commitThreadUpdate: (updater: (current: ChatThreadResponse | null) => ChatThreadResponse | null) => void;
  loadSessionCoreState: (sessionId: string, options: { background: boolean; includeThread: boolean }) => Promise<void>;
  pushLocalNotice: (message: string, tone: "warning") => void;
}

/** Replays one canonical active turn after a fresh page load, without sending it again. */
export function useChatRetainedStreamReattachment(input: RetainedStreamReattachmentInput): void {
  const latestRef = useRef(input);
  latestRef.current = input;
  const { selectedSessionId, thread, streamEnabled, activeStreamRef, sendingRef, locallyHandledTurnKeysRef } = input;
  const activeTurnId =
    thread?.sessionId === selectedSessionId
      ? [...thread.turns]
          .reverse()
          .find((turn) =>
            turn.trace.status === "queued" ||
            turn.trace.status === "running" ||
            turn.trace.status === "waiting_for_tool",
          )?.turnId
      : undefined;
  const latestActiveTurnIdRef = useRef(activeTurnId);
  latestActiveTurnIdRef.current = activeTurnId;

  useEffect(() => {
    if (
      !streamEnabled || !selectedSessionId || !activeTurnId || activeStreamRef.current || sendingRef.current ||
      locallyHandledTurnKeysRef.current.has(`${selectedSessionId}:${activeTurnId}`)
    ) {
      return;
    }

    const sessionId = selectedSessionId;
    const turnId = activeTurnId;
    const controller = new AbortController();
    const gateway = getGatewayApiBaseUrl();
    const access = getGatewayAccessRevision();
    const caller = getGatewayCallerScopeRevision();
    const stream: ActiveChatStreamState = {
      sessionId,
      turnId,
      streamToken: `retained-${turnId}-${Date.now()}`,
      controller,
    };
    activeStreamRef.current = stream;
    sendingRef.current = true;
    latestRef.current.setSending(true);
    recordChatStreamChunkActivity(sessionId);
    const isCurrent = () =>
      activeStreamRef.current === stream &&
      !controller.signal.aborted &&
      latestRef.current.selectedSessionId === sessionId &&
      getGatewayApiBaseUrl() === gateway &&
      getGatewayAccessRevision() === access &&
      getGatewayCallerScopeRevision() === caller;
    const release = () => {
      if (activeStreamRef.current !== stream) return;
      activeStreamRef.current = null;
      sendingRef.current = false;
      latestRef.current.setSending(false);
      latestRef.current.clearStreamingPreview();
      clearChatStreamActivity(sessionId);
    };
    const subscriptions: Array<() => void> = [];
    const unsubscribe = () => subscriptions.splice(0).forEach((dispose) => dispose());
    const revokeIfChanged = () => {
      if (isCurrent()) return;
      unsubscribe();
      controller.abort();
      release();
    };
    subscriptions.push(subscribeGatewayAccessChange(revokeIfChanged), subscribeGatewayCallerScope(revokeIfChanged));

    void (async () => {
      try {
        const { runRetainedChatStream } = await loadRetainedStreamCode();
        if (!isCurrent() || !latestRef.current.streamEnabled || latestActiveTurnIdRef.current !== turnId) return;
        await runRetainedChatStream(sessionId, turnId, stream, latestRef, isCurrent);
      } catch (error) {
        if (isCurrent()) {
          recordClientDiagnostic({
            level: "warn",
            category: "chat",
            event: "stream.retained_reattach_failed",
            message: "Unable to keep the retained Chat stream attached.",
            sessionId,
            turnId,
            context: { error: error instanceof Error ? error.message : String(error) },
          });
          latestRef.current.pushLocalNotice("Live response disconnected. Refresh the turn to check its status.", "warning");
        }
      } finally {
        if (isCurrent()) {
          try {
            await latestRef.current.loadSessionCoreState(sessionId, { background: true, includeThread: true });
          } catch (error) {
            recordClientDiagnostic({
              level: "warn",
              category: "chat",
              event: "stream.retained_reconcile_failed",
              message: "Unable to refresh the Chat turn after its retained stream ended.",
              sessionId,
              turnId,
              context: { error: error instanceof Error ? error.message : String(error) },
            });
          }
        }
        unsubscribe();
        release();
      }
    })();

    return () => {
      unsubscribe();
      controller.abort();
      release();
    };
  }, [activeStreamRef, activeTurnId, locallyHandledTurnKeysRef, selectedSessionId, sendingRef, streamEnabled]);
}
