import type { ChatMode, ChatStreamingPreview, ChatThreadResponse } from "@goatcitadel/contracts";
import { useCallback, useEffect, useMemo, useRef } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import type { ActiveChatDelegationRun } from "../../pages/chat/useChatDelegationPolicyActions";
import { ChatStreamStatusBar, type ChatStreamStatus } from "./ChatStreamStatusBar";
import {
  ChatThreadDelegationSummary,
  ChatThreadNotices,
  ChatThreadTurnCard,
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
  const lastTurn = thread?.turns.at(-1) ?? null;
  const threadTurnCount = thread?.turns.length ?? 0;
  const latestTurnId = thread?.activeLeafTurnId ?? lastTurn?.turnId ?? null;
  const latestTraceStatus = lastTurn?.trace.status ?? null;
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const jumpToLatest = useCallback(() => {
    if (threadTurnCount <= 0) {
      return;
    }
    virtuosoRef.current?.scrollToIndex({
      index: threadTurnCount - 1,
      align: "end",
      behavior: "smooth",
    });
  }, [threadTurnCount]);
  const renderTurn = useCallback(
    (_index: number, turn: NonNullable<ChatThreadResponse["turns"]>[number]) => (
      <ChatThreadTurnCard
        mode={mode}
        turn={turn}
        selected={selectedTurnId === turn.turnId}
        streamingPreview={(activeStreamingTurnId ?? streamingPreview?.turnId) === turn.turnId ? streamingPreview : null}
        onSelectTurn={onSelectTurn}
        onSwitchBranch={onSwitchBranch}
        onRetryTurn={onRetryTurn}
        onEditTurn={onEditTurn}
        onOpenRunDetails={onOpenRunDetails}
        onOpenGeneratedArtifact={onOpenGeneratedArtifact}
        onCreateGeneratedArtifact={onCreateGeneratedArtifact}
        onCreateGeneratedArtifactVersion={onCreateGeneratedArtifactVersion}
      />
    ),
    [
      activeStreamingTurnId,
      mode,
      onCreateGeneratedArtifact,
      onCreateGeneratedArtifactVersion,
      onEditTurn,
      onOpenGeneratedArtifact,
      onOpenRunDetails,
      onRetryTurn,
      onSelectTurn,
      onSwitchBranch,
      selectedTurnId,
      streamingPreview,
    ],
  );
  const virtuosoComponents = useMemo(
    () => ({
      Header: () => (
        <ChatThreadDelegationSummary
          delegationRun={delegationRun ?? null}
          mode={mode}
          onOpenRunDetails={onOpenRunDetails}
        />
      ),
      Footer: () => (
        <>
          <ChatThreadNotices notices={notices} />
          <div aria-hidden="true" />
        </>
      ),
    }),
    [delegationRun, mode, notices, onOpenRunDetails],
  );
  const threadSignalsKey = [
    thread?.sessionId ?? "none",
    threadTurnCount,
    latestTurnId ?? "none",
    latestTraceStatus ?? "none",
    activeStreamingTurnId ?? "none",
    streamingPreview?.turnId ?? "none",
    streamingPreview?.visibleText.length ?? 0,
    streamingPreview?.isRunning ? "running" : "idle",
    notices.length,
    queuedCount,
    streamStatus,
    selectedTurnId ?? "none",
    streamError ?? "none",
  ].join(":");
  useEffect(() => {
    if (!followOutput || threadTurnCount <= 0) {
      return;
    }
    virtuosoRef.current?.scrollToIndex({
      index: threadTurnCount - 1,
      align: "end",
      behavior: streamStatus === "streaming" ? "auto" : "smooth",
    });
  }, [followOutput, streamStatus, threadSignalsKey, threadTurnCount]);

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
      <Virtuoso
        key={thread.sessionId}
        ref={virtuosoRef}
        data={thread.turns}
        computeItemKey={(_index, turn) => turn.turnId}
        itemContent={renderTurn}
        components={virtuosoComponents}
        followOutput={followOutput ? "auto" : false}
        atBottomStateChange={onBottomStateChange}
        initialTopMostItemIndex={Math.max(0, thread.turns.length - 1)}
        increaseViewportBy={{ top: 480, bottom: 720 }}
        className="chat-v11-thread-list chat-v11-thread-virtuoso mc-next-thread-list"
        style={{ height: "min(68dvh, 52rem)", minHeight: "18rem" }}
        data-thread-signals={threadSignalsKey}
      />
      {!followOutput && thread.turns.length > 0 ? (
        <button type="button" className="chat-v11-thread-jump-latest mc-next-thread-jump-latest" onClick={jumpToLatest}>
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
