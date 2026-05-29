import { useCallback, useEffect, useLayoutEffect, useRef } from "react";
import type { ChatMode, ChatStreamingPreview, ChatThreadResponse } from "@goatcitadel/contracts";
import type { ActiveChatDelegationRun } from "../../pages/chat/useChatDelegationPolicyActions";
import { ChatStreamStatusBar, type ChatStreamStatus } from "./ChatStreamStatusBar";
import {
  ChatThreadDelegationSummary,
  ChatThreadNotices,
  ChatThreadTurnCard,
  isThreadScrollNearBottom,
  type ChatThreadNotice,
} from "./ChatThreadPrimitives";

export type { ChatThreadNotice } from "./ChatThreadPrimitives";

export function ChatThreadView({
  mode,
  loading,
  thread,
  selectedTurnId,
  delegationRun,
  notices,
  followOutput,
  streamStatus = "idle",
  streamingPreview = null,
  activeStreamingTurnId = null,
  queuedCount = 0,
  streamError = null,
  onBottomStateChange,
  onSelectTurn,
  onSwitchBranch,
  onRetryTurn,
  onEditTurn,
  onOpenRunDetails,
  onOpenGeneratedArtifact,
  onCreateGeneratedArtifact,
  onCreateGeneratedArtifactVersion,
}: {
  mode: ChatMode;
  loading: boolean;
  thread: ChatThreadResponse | null;
  selectedTurnId: string | null;
  delegationRun?: ActiveChatDelegationRun | null;
  notices: ChatThreadNotice[];
  followOutput: boolean;
  streamStatus?: ChatStreamStatus;
  streamingPreview?: ChatStreamingPreview | null;
  activeStreamingTurnId?: string | null;
  queuedCount?: number;
  streamError?: string | null;
  onBottomStateChange: (atBottom: boolean) => void;
  onSelectTurn: (turnId: string) => void;
  onSwitchBranch: (turnId: string) => void;
  onRetryTurn: (turnId: string) => void;
  onEditTurn: (turnId: string) => void;
  onOpenRunDetails: (turnId: string) => void;
  onOpenGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifactVersion: (turnId: string) => void;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const lastTurn = thread?.turns.at(-1) ?? null;
  const threadTurnCount = thread?.turns.length ?? 0;
  const latestTurnId = thread?.activeLeafTurnId ?? lastTurn?.turnId ?? null;
  const latestTraceStatus = lastTurn?.trace.status ?? null;

  const handleThreadScroll = useCallback(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      onBottomStateChange(true);
      return;
    }
    onBottomStateChange(isThreadScrollNearBottom(scrollElement));
  }, [onBottomStateChange]);

  useEffect(() => {
    const scrollElement = scrollRef.current;
    const endElement = threadEndRef.current;
    if (
      !scrollElement ||
      !endElement ||
      typeof window === "undefined" ||
      typeof window.IntersectionObserver !== "function"
    ) {
      return;
    }
    const observer = new window.IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        onBottomStateChange(Boolean(entry?.isIntersecting) || isThreadScrollNearBottom(scrollElement));
      },
      {
        root: scrollElement,
        threshold: 0.98,
      },
    );
    observer.observe(endElement);
    return () => observer.disconnect();
  }, [onBottomStateChange, thread?.sessionId, threadTurnCount]);

  const jumpToLatest = useCallback(() => {
    threadEndRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
    onBottomStateChange(true);
  }, [onBottomStateChange]);

  useLayoutEffect(() => {
    if (!followOutput) {
      return;
    }
    if (typeof requestAnimationFrame !== "function") {
      threadEndRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
      onBottomStateChange(true);
      return;
    }
    if (scrollFrameRef.current !== null && typeof cancelAnimationFrame === "function") {
      cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      threadEndRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
      onBottomStateChange(true);
    });
    return () => {
      if (scrollFrameRef.current !== null && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [
    followOutput,
    latestTraceStatus,
    latestTurnId,
    notices.length,
    onBottomStateChange,
    queuedCount,
    selectedTurnId,
    streamError,
    streamStatus,
    threadTurnCount,
  ]);

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      return;
    }
    if (followOutput) {
      return;
    }
    onBottomStateChange(isThreadScrollNearBottom(scrollElement));
  }, [
    followOutput,
    latestTraceStatus,
    latestTurnId,
    notices.length,
    onBottomStateChange,
    queuedCount,
    streamStatus,
    threadTurnCount,
  ]);

  if (loading) {
    return <div className="chat-v11-thread-loading mc-next-thread-empty">Loading thread...</div>;
  }

  if (!thread || thread.turns.length === 0) {
    return (
      <div className="chat-v11-thread-empty mc-next-thread-empty">
        <p className="mc-next-thread-meta">
          <strong>GoatCitadel</strong>
        </p>
        <p>
          {mode === "cowork"
            ? "Describe the objective, constraints, and desired output. Cowork will create a visible run plan here."
            : "Start with a plain request, or type /help to see commands."}
        </p>
      </div>
    );
  }

  return (
    <div className="chat-v11-thread-view mc-next-thread-view">
      {/* Single live-region owner for streaming status in this surface. The streaming
          skeleton is intentionally not a live region, so this status bar is the only
          element that announces streaming/assistant activity to screen readers. */}
      <ChatStreamStatusBar
        mode={mode}
        status={streamStatus}
        queuedCount={queuedCount}
        error={streamError}
        announce={true}
      />
      <div
        ref={scrollRef}
        className="chat-v11-thread-list chat-v11-thread-virtuoso mc-next-thread-list"
        onScroll={handleThreadScroll}
      >
        <ChatThreadDelegationSummary
          delegationRun={delegationRun ?? null}
          mode={mode}
          onOpenRunDetails={onOpenRunDetails}
        />
        {thread.turns.map((turn) => (
          <ChatThreadTurnCard
            key={turn.turnId}
            mode={mode}
            turn={turn}
            selected={selectedTurnId === turn.turnId}
            streamingPreview={
              (activeStreamingTurnId ?? streamingPreview?.turnId) === turn.turnId ? streamingPreview : null
            }
            onSelectTurn={onSelectTurn}
            onSwitchBranch={onSwitchBranch}
            onRetryTurn={onRetryTurn}
            onEditTurn={onEditTurn}
            onOpenRunDetails={onOpenRunDetails}
            onOpenGeneratedArtifact={onOpenGeneratedArtifact}
            onCreateGeneratedArtifact={onCreateGeneratedArtifact}
            onCreateGeneratedArtifactVersion={onCreateGeneratedArtifactVersion}
          />
        ))}
        <ChatThreadNotices notices={notices} />
        <div ref={threadEndRef} aria-hidden="true" />
      </div>
      {!followOutput && streamStatus === "streaming" ? (
        <button type="button" className="chat-v11-thread-jump-latest mc-next-thread-jump-latest" onClick={jumpToLatest}>
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
