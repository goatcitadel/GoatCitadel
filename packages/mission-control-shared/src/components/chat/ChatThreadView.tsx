import { memo, useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import type { ChatMode, ChatThreadResponse, ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { StatusChip } from "../StatusChip";
import { Badge } from "../ui";
import { ChatStreamStatusBar, type ChatStreamStatus } from "./ChatStreamStatusBar";
import { AssistantMessageRenderer } from "./AssistantMessageRenderer";
import { ChatAttachmentPreviewStack } from "./ChatAttachmentPreviewStack";
import {
  getAssistantPendingLabel,
  getRecoveryStripLabel,
  getTraceTone,
  renderSuggestionSummary,
  summarizeDelegationSteps,
  summarizeTurnRouting,
  toTitleCase,
  turnHasRepairedAssistantOutput,
} from "./chat-display-helpers";
import type { ActiveChatDelegationRun } from "../../pages/chat/useChatDelegationPolicyActions";

export interface ChatThreadNotice {
  id: string;
  tone: "neutral" | "warning" | "critical" | "success";
  content: string;
  timestamp: string;
}

export interface ChatStreamingPreview {
  sessionId: string;
  turnId: string;
  messageId?: string;
  text: string;
  visibleText: string;
  isRunning: boolean;
  updatedAt: number;
}

function formatTone(tone: ChatThreadNotice["tone"]): "neutral" | "warning" | "critical" | "success" {
  return tone;
}

function formatActorTimestamp(timestamp: string): string {
  return new Date(timestamp).toLocaleTimeString();
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
  const routing = summarizeTurnRouting(turn, { effectiveVerb: "effective" });
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
  mode,
  turn,
  selected,
  onSwitchBranch,
  onRetryTurn,
  onEditTurn,
  onOpenRunDetails,
  onOpenGeneratedArtifact,
  onCreateGeneratedArtifact,
  onCreateGeneratedArtifactVersion,
}: {
  mode: ChatMode;
  turn: ChatThreadTurnRecord;
  selected: boolean;
  onSwitchBranch: (turnId: string) => void;
  onRetryTurn: (turnId: string) => void;
  onEditTurn: (turnId: string) => void;
  onOpenRunDetails: (turnId: string) => void;
  onOpenGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifactVersion: (turnId: string) => void;
}) {
  const suggestionSummary = renderSuggestionSummary(turn.trace.capabilityUpgradeSuggestions);
  const hasGeneratedArtifact = (turn.generatedArtifacts?.length ?? 0) > 0;
  if (!selected && !suggestionSummary && !hasGeneratedArtifact) {
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
          {mode === "cowork" ? "Open run details" : "Open details"}
        </button>
        {turn.assistantMessage ? (
          <button
            type="button"
            aria-label={`Retry assistant answer for turn ${turn.turnId}`}
            onClick={() => onRetryTurn(turn.turnId)}
            className="gc-button"
          >
            {mode === "cowork" ? "Retry run step" : "Retry answer"}
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
        {turn.assistantMessage ? (
          <button
            type="button"
            aria-label={`${hasGeneratedArtifact ? "Open" : "Create"} generated artifact for turn ${turn.turnId}`}
            onClick={() =>
              hasGeneratedArtifact ? onOpenGeneratedArtifact(turn.turnId) : onCreateGeneratedArtifact(turn.turnId)
            }
            className="gc-button"
          >
            {hasGeneratedArtifact ? "Open artifact" : "Create artifact"}
          </button>
        ) : null}
        {hasGeneratedArtifact ? (
          <button
            type="button"
            aria-label={`Create a new artifact version for turn ${turn.turnId}`}
            onClick={() => onCreateGeneratedArtifactVersion(turn.turnId)}
            className="gc-button"
          >
            New version
          </button>
        ) : null}
      </div>
      <ChatBranchSwitcher turn={turn} onSwitch={onSwitchBranch} />
      {suggestionSummary ? <p className="chat-v11-turn-action-note">Suggested next move: {suggestionSummary}</p> : null}
    </div>
  );
}

const ChatTurnCard = memo(function ChatTurnCard({
  mode,
  turn,
  selected,
  streamingPreview,
  onSelect,
  onSwitchBranch,
  onRetryTurn,
  onEditTurn,
  onOpenRunDetails,
  onOpenGeneratedArtifact,
  onCreateGeneratedArtifact,
  onCreateGeneratedArtifactVersion,
}: {
  mode: ChatMode;
  turn: ChatThreadTurnRecord;
  selected: boolean;
  streamingPreview?: ChatStreamingPreview | null;
  onSelect: (turnId: string) => void;
  onSwitchBranch: (turnId: string) => void;
  onRetryTurn: (turnId: string) => void;
  onEditTurn: (turnId: string) => void;
  onOpenRunDetails: (turnId: string) => void;
  onOpenGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifactVersion: (turnId: string) => void;
}) {
  const isStreamingTurn = Boolean(streamingPreview?.isRunning && streamingPreview.turnId === turn.turnId);
  const assistantContent = isStreamingTurn
    ? (streamingPreview?.visibleText ?? "")
    : (turn.assistantMessage?.content ?? "");
  const hasAssistantOutput = assistantContent.trim().length > 0;
  const assistantTimestamp = turn.assistantMessage
    ? formatActorTimestamp(turn.assistantMessage.timestamp)
    : isStreamingTurn
      ? "Streaming"
      : "Running";
  const assistantPendingLabel = getAssistantPendingLabel(turn.trace, { isStreamingTurn });

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
          <ChatAttachmentPreviewStack attachments={turn.userMessage.attachments} eager={selected || isStreamingTurn} />
        </div>
        <div
          className={`chat-v11-turn-bubble assistant${isStreamingTurn ? " streaming" : ""}`}
          aria-busy={isStreamingTurn}
        >
          <p className="chat-v11-message-meta">
            <strong>GoatCitadel</strong> · {assistantTimestamp}
            {turnHasRepairedAssistantOutput(turn) ? (
              <>
                {" "}
                <Badge
                  variant="outline"
                  className="align-middle"
                  title="The final answer was recovered after completion repair."
                >
                  Repaired
                </Badge>
              </>
            ) : null}
          </p>
          {hasAssistantOutput ? (
            <AssistantMessageRenderer role="assistant" content={assistantContent} running={isStreamingTurn} />
          ) : (
            <p>{assistantPendingLabel}</p>
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
          {mode === "cowork" ? "Run details" : "Details"}
        </button>
      </div>
      <ChatTurnActions
        mode={mode}
        turn={turn}
        selected={selected}
        onSwitchBranch={onSwitchBranch}
        onRetryTurn={onRetryTurn}
        onEditTurn={onEditTurn}
        onOpenRunDetails={onOpenRunDetails}
        onOpenGeneratedArtifact={onOpenGeneratedArtifact}
        onCreateGeneratedArtifact={onCreateGeneratedArtifact}
        onCreateGeneratedArtifactVersion={onCreateGeneratedArtifactVersion}
      />
    </article>
  );
});

function isThreadScrollNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
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

function ChatDelegationRunSummary({
  delegationRun,
  mode,
  onOpenRunDetails,
}: {
  delegationRun: ActiveChatDelegationRun | null;
  mode: ChatMode;
  onOpenRunDetails: (turnId: string) => void;
}) {
  const [coworkExpanded, setCoworkExpanded] = useState(false);
  if (!delegationRun) {
    return null;
  }
  const { completedCount, failedCount, skippedCount, runningCount, currentStep } = summarizeDelegationSteps(
    delegationRun.steps,
  );
  const isCowork = mode === "cowork";
  const formatStepLabel = (step: ActiveChatDelegationRun["steps"][number]) =>
    step.label?.trim() || toTitleCase(step.role);
  const countsLine = `Completed ${completedCount} · Running ${runningCount} · Failed ${failedCount} · Skipped ${skippedCount}`;
  if (isCowork) {
    return (
      <section className="chat-v11-turn-card chat-v11-thread-delegation compact">
        <details open={coworkExpanded} onToggle={(event) => setCoworkExpanded(event.currentTarget.open)}>
          <summary>
            <div className="chat-v11-turn-strip chat-v11-execution-strip">
              <StatusChip
                tone={
                  delegationRun.status === "failed"
                    ? "critical"
                    : delegationRun.status === "partial"
                      ? "warning"
                      : delegationRun.status === "completed"
                        ? "success"
                        : "warning"
                }
              >
                {delegationRun.status}
              </StatusChip>
              <span>Cowork activity</span>
              <span>{countsLine}</span>
              {currentStep ? <span>Now: {formatStepLabel(currentStep)}</span> : null}
              {delegationRun.attachedTurnId ? (
                <button
                  type="button"
                  className="gc-button chat-v11-execution-open"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    onOpenRunDetails(delegationRun.attachedTurnId!);
                  }}
                >
                  Open details
                </button>
              ) : null}
            </div>
          </summary>
          <div className="chat-v11-turn-bubble assistant">
            <p className="chat-v11-message-meta">
              <strong>{delegationRun.label}</strong> · {delegationRun.mode}
            </p>
            <p>{delegationRun.objective}</p>
            <ol className="chat-cowork-plan-list">
              {delegationRun.steps.map((step) => (
                <li key={step.stepId}>
                  <div className="chat-cowork-step-head">
                    <strong>{formatStepLabel(step)}</strong>
                    <span>{step.status}</span>
                  </div>
                  {step.summary ? <p>{step.summary}</p> : null}
                  {step.error ? <p>{step.error}</p> : null}
                  {step.output ? (
                    <details className="chat-cowork-step-output-details">
                      <summary>Show subagent output</summary>
                      <AssistantMessageRenderer
                        role="assistant"
                        content={step.output}
                        className="chat-cowork-step-output"
                      />
                    </details>
                  ) : null}
                </li>
              ))}
            </ol>
            {delegationRun.stitchedOutput ? (
              <p>Final synthesized answer is shown in the main assistant message.</p>
            ) : null}
          </div>
        </details>
      </section>
    );
  }
  return (
    <section className="chat-v11-turn-card chat-v11-thread-delegation">
      <div className="chat-v11-turn-strip chat-v11-execution-strip">
        <StatusChip
          tone={
            delegationRun.status === "failed"
              ? "critical"
              : delegationRun.status === "partial"
                ? "warning"
                : delegationRun.status === "completed"
                  ? "success"
                  : "warning"
          }
        >
          {delegationRun.status}
        </StatusChip>
        <span>Delegation run</span>
        {delegationRun.runId ? <span>{delegationRun.runId}</span> : null}
        {delegationRun.executionPlanId ? <span>Plan {delegationRun.executionPlanId}</span> : null}
        {delegationRun.taskId ? <span>Task {delegationRun.taskId}</span> : null}
      </div>
      <div className="chat-v11-turn-bubble assistant">
        <p className="chat-v11-message-meta">
          <strong>{delegationRun.label}</strong> · {delegationRun.mode}
        </p>
        <p>{delegationRun.objective}</p>
        <p>
          Completed {completedCount} · Running {runningCount} · Failed {failedCount} · Skipped {skippedCount}
        </p>
        <ol className="chat-cowork-plan-list">
          {delegationRun.steps.map((step) => (
            <li key={step.stepId}>
              <div className="chat-cowork-step-head">
                <strong>{step.label?.trim() || toTitleCase(step.role)}</strong>
                <span>{step.status}</span>
              </div>
              {step.durableRunId ? <p>Durable {step.durableRunId}</p> : null}
              {step.childSessionId ? <p>Child session {step.childSessionId}</p> : null}
              {step.childTurnId ? <p>Child turn {step.childTurnId}</p> : null}
              {step.output ? (
                <AssistantMessageRenderer role="assistant" content={step.output} className="chat-cowork-step-output" />
              ) : null}
              {step.error ? <p>{step.error}</p> : null}
            </li>
          ))}
        </ol>
        {delegationRun.stitchedOutput ? (
          <>
            <p className="chat-v11-message-meta">
              <strong>Stitched result</strong>
            </p>
            <AssistantMessageRenderer role="assistant" content={delegationRun.stitchedOutput} />
          </>
        ) : null}
      </div>
    </section>
  );
}

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

  const handleThreadScroll = useCallback(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      onBottomStateChange(true);
      return;
    }
    onBottomStateChange(isThreadScrollNearBottom(scrollElement));
  }, [onBottomStateChange]);

  const jumpToLatest = useCallback(() => {
    threadEndRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
    onBottomStateChange(true);
  }, [onBottomStateChange]);

  useLayoutEffect(() => {
    if (!followOutput) {
      return;
    }
    threadEndRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
    onBottomStateChange(true);
  }, [
    followOutput,
    notices.length,
    onBottomStateChange,
    queuedCount,
    selectedTurnId,
    streamError,
    streamStatus,
    streamingPreview?.updatedAt,
    thread,
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
  }, [followOutput, onBottomStateChange, notices.length, queuedCount, streamStatus, thread]);

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
          {mode === "cowork"
            ? "Describe the objective, constraints, and desired output. Cowork will create a visible run plan here."
            : "Start with a plain request, or type /help to see commands."}
        </p>
      </div>
    );
  }

  return (
    <div className="chat-v11-thread-view">
      <ChatStreamStatusBar mode={mode} status={streamStatus} queuedCount={queuedCount} error={streamError} />
      <div ref={scrollRef} className="chat-v11-thread-list chat-v11-thread-virtuoso" onScroll={handleThreadScroll}>
        <ChatDelegationRunSummary
          delegationRun={delegationRun ?? null}
          mode={mode}
          onOpenRunDetails={onOpenRunDetails}
        />
        {thread.turns.map((turn) => (
          <ChatTurnCard
            key={turn.turnId}
            mode={mode}
            turn={turn}
            selected={selectedTurnId === turn.turnId}
            streamingPreview={activeStreamingTurnId === turn.turnId ? streamingPreview : null}
            onSelect={onSelectTurn}
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
        <button type="button" className="chat-v11-thread-jump-latest" onClick={jumpToLatest}>
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
