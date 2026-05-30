import type { ChatMode, ChatStreamingPreview, ChatThreadResponse } from "@goatcitadel/contracts";
import type { ActiveChatDelegationRun } from "../../pages/chat/useChatDelegationPolicyActions";
import { ChatStreamStatusBar, type ChatStreamStatus } from "./ChatStreamStatusBar";
import {
  ChatThreadDelegationSummary,
  ChatThreadNotices,
  ChatThreadTurnCard,
  type ChatThreadNotice,
} from "./ChatThreadPrimitives";
import { useScrollToBottom } from "./useScrollToBottom";

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

  const { scrollRef, threadEndRef, handleThreadScroll, jumpToLatest } = useScrollToBottom({
    followOutput,
    onBottomStateChange,
    signals: {
      sessionId: thread?.sessionId ?? null,
      threadTurnCount,
      latestTurnId,
      latestTraceStatus,
      noticeCount: notices.length,
      queuedCount,
      streamStatus,
      selectedTurnId,
      streamError,
    },
  });

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
      {!followOutput && thread.turns.length > 0 ? (
        <button type="button" className="chat-v11-thread-jump-latest mc-next-thread-jump-latest" onClick={jumpToLatest}>
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
