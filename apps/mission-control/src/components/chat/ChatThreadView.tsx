import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { getChatTurnRecoveryActionLabel, isChatTurnActiveStatus } from "@goatcitadel/contracts";
import type {
  ChatCapabilityUpgradeSuggestion,
  ChatThreadResponse,
  ChatThreadTurnRecord,
  ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
import { StatusChip } from "../StatusChip";
import { ChatStreamStatusBar, type ChatStreamStatus } from "./ChatStreamStatusBar";
import { AssistantMessageRenderer } from "./AssistantMessageRenderer";

export interface ChatThreadNotice {
  id: string;
  tone: "neutral" | "warning" | "critical" | "success";
  content: string;
  timestamp: string;
}

function formatTone(tone: ChatThreadNotice["tone"]): "neutral" | "warning" | "critical" | "success" {
  return tone;
}

function formatActorTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString();
}

function summarizeRouting(turn: ChatThreadTurnRecord): string[] {
  const parts = [
    turn.trace.routing.effectiveProviderId,
    turn.trace.routing.effectiveModel,
    turn.trace.routing.effectiveApiStyle,
    turn.trace.routing.fallbackUsed ? "fallback" : undefined,
  ].filter(Boolean);
  return parts as string[];
}

function getTraceTone(trace: ChatTurnTraceRecord): "muted" | "warning" | "critical" | "success" {
  if (trace.status === "failed") {
    return "critical";
  }
  if (trace.status === "completed" && !trace.failure) {
    return "success";
  }
  if (trace.status === "cancelled") {
    return "muted";
  }
  return "warning";
}

function getTurnPendingLabel(trace: ChatTurnTraceRecord): string {
  switch (trace.status) {
    case "queued":
      return "Queued...";
    case "waiting_for_tool":
      return "Using tools...";
    case "waiting_for_approval":
      return "Waiting for approval.";
    case "cancelled":
      return "Turn cancelled.";
    case "failed":
      return trace.failure?.message ?? "Turn failed.";
    default:
      return "Working...";
  }
}

function renderSuggestionSummary(suggestions: ChatCapabilityUpgradeSuggestion[] | undefined): string | null {
  if (!suggestions || suggestions.length === 0) {
    return null;
  }
  return suggestions
    .slice(0, 2)
    .map((item) => item.title)
    .join(" · ");
}

function getRecoveryStripLabel(turn: ChatThreadTurnRecord): string | null {
  const action = turn.trace.failure?.recommendedAction;
  if (!action) {
    return null;
  }
  return getChatTurnRecoveryActionLabel(action);
}

function ChatBranchSwitcher({ turn, onSwitch }: { turn: ChatThreadTurnRecord; onSwitch: (turnId: string) => void }) {
  if (turn.branch.siblingCount <= 1) {
    return null;
  }
  const currentIndex = turn.branch.activeSiblingIndex;
  const previousTurnId = currentIndex > 0 ? turn.branch.siblingTurnIds[currentIndex - 1] : undefined;
  const nextTurnId =
    currentIndex < turn.branch.siblingTurnIds.length - 1 ? turn.branch.siblingTurnIds[currentIndex + 1] : undefined;
  return (
    <div className="chat-v11-branch-switcher">
      <button
        type="button"
        aria-label={`Show previous variant for turn ${turn.turnId}`}
        disabled={!previousTurnId}
        onClick={() => previousTurnId && onSwitch(previousTurnId)}
        className="gc-button"
      >
        Previous variant
      </button>
      <span>
        {currentIndex + 1} / {turn.branch.siblingCount}
      </span>
      <button
        type="button"
        aria-label={`Show next variant for turn ${turn.turnId}`}
        disabled={!nextTurnId}
        onClick={() => nextTurnId && onSwitch(nextTurnId)}
        className="gc-button"
      >
        Next variant
      </button>
    </div>
  );
}

function ChatTurnRunStrip({ turn }: { turn: ChatThreadTurnRecord }) {
  const routing = summarizeRouting(turn);
  const recoveryLabel = getRecoveryStripLabel(turn);
  return (
    <div className="chat-v11-turn-strip">
      <StatusChip tone={getTraceTone(turn.trace)}>{turn.trace.status}</StatusChip>
      {recoveryLabel ? (
        <span>{recoveryLabel}</span>
      ) : turn.trace.failure ? (
        <span>{turn.trace.failure.failureClass}</span>
      ) : null}
      {routing.map((item) => (
        <span key={item}>{item}</span>
      ))}
      {turn.toolRuns.length > 0 ? (
        <span>
          {turn.toolRuns.length} tool{turn.toolRuns.length === 1 ? "" : "s"}
        </span>
      ) : null}
      {turn.citations.length > 0 ? (
        <span>
          {turn.citations.length} citation{turn.citations.length === 1 ? "" : "s"}
        </span>
      ) : null}
      {turn.trace.orchestration ? <span>orchestrated</span> : null}
      {turn.trace.routing.fallbackUsed ? <span>fallback used</span> : null}
    </div>
  );
}

function ChatTurnActions({
  turn,
  selected,
  onSwitchBranch,
  onRetryTurn,
  onEditTurn,
  onOpenRunDetails,
}: {
  turn: ChatThreadTurnRecord;
  selected: boolean;
  onSwitchBranch: (turnId: string) => void;
  onRetryTurn: (turnId: string) => void;
  onEditTurn: (turnId: string) => void;
  onOpenRunDetails: (turnId: string) => void;
}) {
  const suggestionSummary = renderSuggestionSummary(turn.trace.capabilityUpgradeSuggestions);
  if (!selected && !suggestionSummary) {
    return null;
  }
  return (
    <div className="chat-v11-turn-actions">
      <div className="chat-v11-row-actions">
        <button
          type="button"
          aria-label={`Open execution detail for turn ${turn.turnId}`}
          onClick={() => onOpenRunDetails(turn.turnId)}
          className="gc-button"
        >
          Open details
        </button>
        {turn.assistantMessage ? (
          <button
            type="button"
            aria-label={`Retry assistant answer for turn ${turn.turnId}`}
            onClick={() => onRetryTurn(turn.turnId)}
            className="gc-button"
          >
            Retry answer
          </button>
        ) : null}
        <button
          type="button"
          aria-label={`Edit and resend turn ${turn.turnId}`}
          onClick={() => onEditTurn(turn.turnId)}
          className="gc-button"
        >
          Edit and resend
        </button>
      </div>
      <ChatBranchSwitcher turn={turn} onSwitch={onSwitchBranch} />
      {suggestionSummary ? <p className="chat-v11-turn-action-note">Suggested next move: {suggestionSummary}</p> : null}
    </div>
  );
}

function ChatTurnCard({
  turn,
  selected,
  onSelect,
  onSwitchBranch,
  onRetryTurn,
  onEditTurn,
  onOpenRunDetails,
}: {
  turn: ChatThreadTurnRecord;
  selected: boolean;
  onSelect: (turnId: string) => void;
  onSwitchBranch: (turnId: string) => void;
  onRetryTurn: (turnId: string) => void;
  onEditTurn: (turnId: string) => void;
  onOpenRunDetails: (turnId: string) => void;
}) {
  function handleSurfaceKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onSelect(turn.turnId);
    }
  }

  return (
    <article className={`chat-v11-turn-card chat-v11-turn-cluster${selected ? " selected" : ""}`}>
      <div
        aria-pressed={selected}
        aria-label={`Select turn ${turn.turnId}`}
        className="chat-v11-turn-surface"
        onClick={() => onSelect(turn.turnId)}
        onKeyDown={handleSurfaceKeyDown}
        role="button"
        tabIndex={0}
      >
        <div className="chat-v11-turn-bubble user">
          <p className="chat-v11-message-meta">
            <strong>You</strong> · {formatActorTimestamp(turn.userMessage.timestamp)}
          </p>
          <AssistantMessageRenderer role="user" content={turn.userMessage.content} />
        </div>
        <div className="chat-v11-turn-bubble assistant">
          <p className="chat-v11-message-meta">
            <strong>GoatCitadel</strong> ·{" "}
            {turn.assistantMessage ? formatActorTimestamp(turn.assistantMessage.timestamp) : "Running"}
          </p>
          {turn.assistantMessage ? (
            <AssistantMessageRenderer role="assistant" content={turn.assistantMessage.content} />
          ) : (
            <p>
              {isChatTurnActiveStatus(turn.trace.status) ||
              turn.trace.status === "cancelled" ||
              turn.trace.status === "failed"
                ? getTurnPendingLabel(turn.trace)
                : "No assistant output yet."}
            </p>
          )}
        </div>
      </div>
      <div className="chat-v11-turn-strip chat-v11-execution-strip">
        <ChatTurnRunStrip turn={turn} />
        <button
          type="button"
          className="gc-button chat-v11-execution-open"
          onClick={() => onOpenRunDetails(turn.turnId)}
        >
          Details
        </button>
      </div>
      <ChatTurnActions
        turn={turn}
        selected={selected}
        onSwitchBranch={onSwitchBranch}
        onRetryTurn={onRetryTurn}
        onEditTurn={onEditTurn}
        onOpenRunDetails={onOpenRunDetails}
      />
    </article>
  );
}

function ChatThreadNotices({ notices }: { notices: ChatThreadNotice[] }) {
  if (notices.length === 0) {
    return null;
  }
  return (
    <ul className="chat-v11-thread-notices">
      {notices.map((notice) => (
        <li key={notice.id} className={`tone-${formatTone(notice.tone)}`}>
          <p className="chat-v11-message-meta">
            <strong>Notice</strong> · {formatActorTimestamp(notice.timestamp)}
          </p>
          <p>{notice.content}</p>
        </li>
      ))}
    </ul>
  );
}

export function ChatThreadView({
  loading,
  thread,
  selectedTurnId,
  notices,
  followOutput,
  streamStatus = "idle",
  queuedCount = 0,
  streamError = null,
  onBottomStateChange,
  onSelectTurn,
  onSwitchBranch,
  onRetryTurn,
  onEditTurn,
  onOpenRunDetails,
}: {
  loading: boolean;
  thread: ChatThreadResponse | null;
  selectedTurnId: string | null;
  notices: ChatThreadNotice[];
  followOutput: boolean;
  streamStatus?: ChatStreamStatus;
  queuedCount?: number;
  streamError?: string | null;
  onBottomStateChange: (atBottom: boolean) => void;
  onSelectTurn: (turnId: string) => void;
  onSwitchBranch: (turnId: string) => void;
  onRetryTurn: (turnId: string) => void;
  onEditTurn: (turnId: string) => void;
  onOpenRunDetails: (turnId: string) => void;
}) {
  const threadEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!followOutput) {
      return;
    }
    threadEndRef.current?.scrollIntoView({ block: "end" });
  }, [followOutput, notices.length, queuedCount, selectedTurnId, streamError, streamStatus, thread]);

  useEffect(() => {
    onBottomStateChange(true);
  }, [onBottomStateChange, notices.length, queuedCount, streamStatus, thread]);

  if (loading) {
    return <div className="chat-v11-thread-loading">Loading thread…</div>;
  }

  if (!thread || thread.turns.length === 0) {
    return (
      <div className="chat-v11-thread-empty">
        <p className="chat-v11-message-meta">
          <strong>GoatCitadel</strong>
        </p>
        <p>
          Start with a plain request, or type <code>/help</code> to see commands.
        </p>
      </div>
    );
  }

  return (
    <div className="chat-v11-thread-view">
      <ChatStreamStatusBar status={streamStatus} queuedCount={queuedCount} error={streamError} />
      <div className="chat-v11-thread-list chat-v11-thread-virtuoso">
        {thread.turns.map((turn) => (
          <ChatTurnCard
            key={turn.turnId}
            turn={turn}
            selected={selectedTurnId === turn.turnId}
            onSelect={onSelectTurn}
            onSwitchBranch={onSwitchBranch}
            onRetryTurn={onRetryTurn}
            onEditTurn={onEditTurn}
            onOpenRunDetails={onOpenRunDetails}
          />
        ))}
        <ChatThreadNotices notices={notices} />
        <div ref={threadEndRef} aria-hidden="true" />
      </div>
    </div>
  );
}
