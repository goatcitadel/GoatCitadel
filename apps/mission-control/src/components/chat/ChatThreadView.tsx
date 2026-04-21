import { useEffect, useRef, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { getChatTurnRecoveryActionLabel, isChatTurnActiveStatus } from "@goatcitadel/contracts";
import type {
  ChatCapabilityUpgradeSuggestion,
  ChatMode,
  ChatThreadResponse,
  ChatThreadTurnRecord,
  ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
import { StatusChip } from "../StatusChip";
import { Badge } from "../ui";
import { ChatStreamStatusBar, type ChatStreamStatus } from "./ChatStreamStatusBar";
import { AssistantMessageRenderer } from "./AssistantMessageRenderer";
import { ChatAttachmentPreviewStack } from "./ChatAttachmentPreviewStack";
import type { ActiveChatDelegationRun } from "../../pages/chat/useChatDelegationPolicyActions";

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

function toTitleCase(value: string): string {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function turnHasRepairedAssistantOutput(turn: ChatThreadTurnRecord): boolean {
  return Boolean(turn.trace.completion?.repaired);
}

function formatRoutingTarget(providerId?: string, model?: string, apiStyle?: string): string | null {
  const parts = [providerId, model, apiStyle].filter((value): value is string => Boolean(value));
  return parts.length > 0 ? parts.join(" · ") : null;
}

function summarizeRouting(turn: ChatThreadTurnRecord): string[] {
  const requested = formatRoutingTarget(turn.trace.routing.primaryProviderId, turn.trace.routing.primaryModel);
  const effective =
    formatRoutingTarget(
      turn.trace.routing.effectiveProviderId,
      turn.trace.routing.effectiveModel,
      turn.trace.routing.effectiveApiStyle,
    ) ??
    turn.trace.model ??
    null;
  const parts = [effective ? `effective ${effective}` : null];
  if (requested && requested !== effective) {
    parts.push(`requested ${requested}`);
  }
  if (turn.trace.routing.fallbackReason) {
    parts.push(`fallback: ${turn.trace.routing.fallbackReason}`);
  } else if (turn.trace.routing.fallbackUsed) {
    parts.push("fallback used");
  }
  return parts.filter((value): value is string => Boolean(value));
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
    case "waiting_for_user_input":
      return "Waiting for your answer.";
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
  mode,
  turn,
  selected,
  onSwitchBranch,
  onRetryTurn,
  onEditTurn,
  onOpenRunDetails,
  onOpenGeneratedArtifact,
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
            aria-label={`Open generated artifact for turn ${turn.turnId}`}
            onClick={() => onOpenGeneratedArtifact(turn.turnId)}
            className="gc-button"
          >
            Open artifact
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

function ChatTurnCard({
  mode,
  turn,
  selected,
  onSelect,
  onSwitchBranch,
  onRetryTurn,
  onEditTurn,
  onOpenRunDetails,
  onOpenGeneratedArtifact,
  onCreateGeneratedArtifactVersion,
}: {
  mode: ChatMode;
  turn: ChatThreadTurnRecord;
  selected: boolean;
  onSelect: (turnId: string) => void;
  onSwitchBranch: (turnId: string) => void;
  onRetryTurn: (turnId: string) => void;
  onEditTurn: (turnId: string) => void;
  onOpenRunDetails: (turnId: string) => void;
  onOpenGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifactVersion: (turnId: string) => void;
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
          <ChatAttachmentPreviewStack attachments={turn.userMessage.attachments} />
        </div>
        <div className="chat-v11-turn-bubble assistant">
          <p className="chat-v11-message-meta">
            <strong>GoatCitadel</strong> ·{" "}
            {turn.assistantMessage ? formatActorTimestamp(turn.assistantMessage.timestamp) : "Running"}
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
        onCreateGeneratedArtifactVersion={onCreateGeneratedArtifactVersion}
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

function ChatDelegationRunSummary({
  delegationRun,
  mode,
}: {
  delegationRun: ActiveChatDelegationRun | null;
  mode: ChatMode;
}) {
  if (!delegationRun) {
    return null;
  }
  const completedCount = delegationRun.steps.filter((step) => step.status === "completed").length;
  const failedCount = delegationRun.steps.filter((step) => step.status === "failed").length;
  const skippedCount = delegationRun.steps.filter((step) => step.status === "skipped").length;
  const runningCount = delegationRun.steps.filter((step) => step.status === "running").length;
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
        {mode !== "cowork" && delegationRun.runId ? <span>{delegationRun.runId}</span> : null}
        {mode !== "cowork" && delegationRun.executionPlanId ? <span>Plan {delegationRun.executionPlanId}</span> : null}
        {mode !== "cowork" && delegationRun.taskId ? <span>Task {delegationRun.taskId}</span> : null}
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
                <strong>{toTitleCase(step.role)}</strong>
                <span>{step.status}</span>
              </div>
              {mode !== "cowork" && step.durableRunId ? <p>Durable {step.durableRunId}</p> : null}
              {mode !== "cowork" && step.childSessionId ? <p>Child session {step.childSessionId}</p> : null}
              {mode !== "cowork" && step.childTurnId ? <p>Child turn {step.childTurnId}</p> : null}
              {step.output ? <p>{step.output}</p> : null}
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
  queuedCount = 0,
  streamError = null,
  onBottomStateChange,
  onSelectTurn,
  onSwitchBranch,
  onRetryTurn,
  onEditTurn,
  onOpenRunDetails,
  onOpenGeneratedArtifact,
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
  queuedCount?: number;
  streamError?: string | null;
  onBottomStateChange: (atBottom: boolean) => void;
  onSelectTurn: (turnId: string) => void;
  onSwitchBranch: (turnId: string) => void;
  onRetryTurn: (turnId: string) => void;
  onEditTurn: (turnId: string) => void;
  onOpenRunDetails: (turnId: string) => void;
  onOpenGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifactVersion: (turnId: string) => void;
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
      <div className="chat-v11-thread-list chat-v11-thread-virtuoso">
        <ChatDelegationRunSummary delegationRun={delegationRun ?? null} mode={mode} />
        {thread.turns.map((turn) => (
          <ChatTurnCard
            key={turn.turnId}
            mode={mode}
            turn={turn}
            selected={selectedTurnId === turn.turnId}
            onSelect={onSelectTurn}
            onSwitchBranch={onSwitchBranch}
            onRetryTurn={onRetryTurn}
            onEditTurn={onEditTurn}
            onOpenRunDetails={onOpenRunDetails}
            onOpenGeneratedArtifact={onOpenGeneratedArtifact}
            onCreateGeneratedArtifactVersion={onCreateGeneratedArtifactVersion}
          />
        ))}
        <ChatThreadNotices notices={notices} />
        <div ref={threadEndRef} aria-hidden="true" />
      </div>
    </div>
  );
}
