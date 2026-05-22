import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  getChatTurnRecoveryActionLabel,
  isChatTurnActiveStatus,
  type ChatCitationRecord,
  type ChatMode,
  type ChatThreadTurnRecord,
  type ChatTurnTraceRecord,
} from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { Badge } from "@goatcitadel/mission-control-shared/components/ui";
import { StatusChip } from "@goatcitadel/mission-control-shared/components/StatusChip";
import {
  ChatPendingApprovalPanel,
  type ChatPendingApprovalState,
} from "@goatcitadel/mission-control-shared/components/chat/ChatPendingApprovalPanel";
import { ChatPendingUserInputPanel } from "@goatcitadel/mission-control-shared/components/chat/ChatPendingUserInputPanel";
import {
  ChatStreamStatusBar,
  type ChatStreamStatus,
} from "@goatcitadel/mission-control-shared/components/chat/ChatStreamStatusBar";
import { AssistantMessageRenderer } from "@goatcitadel/mission-control-shared/components/chat/AssistantMessageRenderer";
import { ChatAttachmentPreviewStack } from "@goatcitadel/mission-control-shared/components/chat/ChatAttachmentPreviewStack";
import { SurfaceReconnectBanner } from "@goatcitadel/mission-control-shared/components/chat/SurfaceReconnectBanner";
import { normalizeCitationDisplayText } from "@goatcitadel/mission-control-shared/components/chat/assistant-display-text";

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

function getTraceTone(trace: ChatTurnTraceRecord): "muted" | "warning" | "critical" | "success" {
  if (trace.status === "failed") {
    return "critical";
  }
  if (trace.status === "completed" && !trace.failure) {
    return "success";
  }
  if (trace.status === "partial") {
    return "warning";
  }
  if (trace.status === "cancelled") {
    return "muted";
  }
  return "warning";
}

function getTurnPendingLabel(trace: ChatTurnTraceRecord): string {
  switch (trace.status) {
    case "queued":
      return "Queued…";
    case "waiting_for_tool":
      return "Using tools…";
    case "waiting_for_approval":
      return "Waiting for approval.";
    case "waiting_for_user_input":
      return "Waiting for your answer.";
    case "cancelled":
      return "Turn cancelled.";
    case "failed":
      return trace.failure?.message ?? "Turn failed.";
    case "partial":
      return "Turn partially completed.";
    default:
      return "Working…";
  }
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
  const parts = [effective ? `used ${effective}` : null];
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

function renderSuggestionSummary(turn: ChatThreadTurnRecord): string | null {
  if (!turn.trace.capabilityUpgradeSuggestions || turn.trace.capabilityUpgradeSuggestions.length === 0) {
    return null;
  }
  return turn.trace.capabilityUpgradeSuggestions
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

function isSafeCitationHref(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function formatCitationSource(citation: ChatCitationRecord): string {
  if (citation.knowledge) {
    return citation.knowledge.retrievalMode === "full_text" ? "knowledge full text" : "knowledge retrieval";
  }
  return citation.sourceType ?? "source";
}

function ThreadCitationList({ citations }: { citations: ChatCitationRecord[] }) {
  if (citations.length === 0) {
    return null;
  }
  return (
    <div className="mc-next-thread-citations" aria-label="Citations for this answer">
      {citations.slice(0, 6).map((citation, index) => {
        const label = normalizeCitationDisplayText(citation.title) || citation.url;
        const snippet = normalizeCitationDisplayText(citation.snippet);
        const source = formatCitationSource(citation);
        const safeHref = isSafeCitationHref(citation.url);
        return (
          <article key={citation.citationId || `${citation.url}-${index}`}>
            <div>
              <strong>{index + 1}</strong>
              {safeHref ? (
                <a href={citation.url} target="_blank" rel="noreferrer">
                  {label}
                </a>
              ) : (
                <span>{label}</span>
              )}
            </div>
            <p>
              {source}
              {snippet ? ` · ${snippet}` : ""}
            </p>
          </article>
        );
      })}
      {citations.length > 6 ? <p className="mc-next-thread-note">+{citations.length - 6} more citations</p> : null}
    </div>
  );
}

function ThreadBranchSwitcher({ turn, onSwitch }: { turn: ChatThreadTurnRecord; onSwitch: (turnId: string) => void }) {
  if (turn.branch.siblingCount <= 1) {
    return null;
  }
  const currentIndex = turn.branch.activeSiblingIndex;
  const previousTurnId = currentIndex > 0 ? turn.branch.siblingTurnIds[currentIndex - 1] : undefined;
  const nextTurnId =
    currentIndex < turn.branch.siblingTurnIds.length - 1 ? turn.branch.siblingTurnIds[currentIndex + 1] : undefined;
  return (
    <div className="mc-next-thread-branch-switcher">
      <button
        type="button"
        className="mc-next-thread-inline-button"
        disabled={!previousTurnId}
        onClick={() => previousTurnId && onSwitch(previousTurnId)}
      >
        Previous
      </button>
      <span>
        {currentIndex + 1} / {turn.branch.siblingCount}
      </span>
      <button
        type="button"
        className="mc-next-thread-inline-button"
        disabled={!nextTurnId}
        onClick={() => nextTurnId && onSwitch(nextTurnId)}
      >
        Next
      </button>
    </div>
  );
}

const ThreadTurnCard = memo(function ThreadTurnCard({
  mode,
  turn,
  selected,
  streamingPreview,
  onSelect,
  onSwitchBranch,
  onRetryTurn,
  onOpenRunDetails,
  onOpenGeneratedArtifact,
  onCreateGeneratedArtifact,
  onCreateGeneratedArtifactVersion,
}: {
  mode: ChatMode;
  turn: ChatThreadTurnRecord;
  selected: boolean;
  streamingPreview?: MissionThreadedActiveSessionSurfaceProps["streamingPreview"];
  onSelect: (turnId: string) => void;
  onSwitchBranch: (turnId: string) => void;
  onRetryTurn: (turnId: string) => void;
  onOpenRunDetails: (turnId: string) => void;
  onOpenGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifactVersion: (turnId: string) => void;
}) {
  const suggestionSummary = renderSuggestionSummary(turn);
  const hasGeneratedArtifact = (turn.generatedArtifacts?.length ?? 0) > 0;
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
  const assistantPendingLabel = isStreamingTurn
    ? "Receiving response..."
    : isChatTurnActiveStatus(turn.trace.status) || turn.trace.status === "cancelled" || turn.trace.status === "failed"
      ? getTurnPendingLabel(turn.trace)
      : "No assistant output yet.";

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
    <article className={`mc-next-thread-turn${selected ? " selected" : ""}`}>
      <div
        className="mc-next-thread-turn-surface"
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        onClick={() => onSelect(turn.turnId)}
        onKeyDown={handleSurfaceKeyDown}
      >
        <div className="mc-next-thread-bubble user">
          <p className="mc-next-thread-meta">
            <strong>You</strong> · {formatActorTimestamp(turn.userMessage.timestamp)}
          </p>
          <AssistantMessageRenderer role="user" content={turn.userMessage.content} />
          <ChatAttachmentPreviewStack attachments={turn.userMessage.attachments} />
        </div>
        <div
          className={`mc-next-thread-bubble assistant${isStreamingTurn ? " streaming" : ""}`}
          aria-busy={isStreamingTurn}
        >
          <p className="mc-next-thread-meta">
            <strong>GoatCitadel</strong> · {assistantTimestamp}
            {turnHasRepairedAssistantOutput(turn) ? (
              <>
                {" "}
                <Badge variant="outline" className="align-middle">
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
          <ThreadCitationList citations={turn.citations} />
        </div>
      </div>
      <div className="mc-next-thread-strip">
        <StatusChip tone={getTraceTone(turn.trace)}>{turn.trace.status}</StatusChip>
        {getRecoveryStripLabel(turn) ? <span>{getRecoveryStripLabel(turn)}</span> : null}
        {summarizeRouting(turn).map((item) => (
          <span key={item}>{item}</span>
        ))}
        {turn.toolRuns.length > 0 ? <span>{turn.toolRuns.length} tools</span> : null}
        {turn.citations.length > 0 ? <span>{turn.citations.length} citations</span> : null}
        <button type="button" className="mc-next-thread-inline-button" onClick={() => onOpenRunDetails(turn.turnId)}>
          {mode === "cowork" ? "Run details" : "Details"}
        </button>
      </div>
      <div className="mc-next-thread-actions">
        <div className="mc-next-thread-action-row">
          {turn.assistantMessage ? (
            <button type="button" className="mc-next-thread-inline-button" onClick={() => onRetryTurn(turn.turnId)}>
              {mode === "cowork" ? "Retry run step" : "Retry"}
            </button>
          ) : null}
          {turn.assistantMessage ? (
            <button
              type="button"
              className="mc-next-thread-inline-button"
              onClick={() =>
                hasGeneratedArtifact ? onOpenGeneratedArtifact(turn.turnId) : onCreateGeneratedArtifact(turn.turnId)
              }
            >
              {hasGeneratedArtifact ? "Open artifact" : "Create artifact"}
            </button>
          ) : null}
          {hasGeneratedArtifact ? (
            <button
              type="button"
              className="mc-next-thread-inline-button"
              onClick={() => onCreateGeneratedArtifactVersion(turn.turnId)}
            >
              New version
            </button>
          ) : null}
        </div>
        <ThreadBranchSwitcher turn={turn} onSwitch={onSwitchBranch} />
        {suggestionSummary ? <p className="mc-next-thread-note">Suggested next move: {suggestionSummary}</p> : null}
      </div>
    </article>
  );
});

function isThreadScrollNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
}

function ThreadNotices({ notices }: { notices: MissionThreadedActiveSessionSurfaceProps["notices"] }) {
  if (notices.length === 0) {
    return null;
  }
  return (
    <ul className="mc-next-thread-notices">
      {notices.map((notice) => (
        <li key={notice.id} className={`tone-${notice.tone}`}>
          <p className="mc-next-thread-meta">
            <strong>Notice</strong> · {formatActorTimestamp(notice.timestamp)}
          </p>
          <p>{notice.content}</p>
        </li>
      ))}
    </ul>
  );
}

function ThreadDelegationSummary({
  delegationRun,
  mode,
  onOpenRunDetails,
}: {
  delegationRun: MissionThreadedActiveSessionSurfaceProps["delegationRun"];
  mode: ChatMode;
  onOpenRunDetails: MissionThreadedActiveSessionSurfaceProps["onOpenRunDetails"];
}) {
  const [coworkExpanded, setCoworkExpanded] = useState(false);
  if (!delegationRun) {
    return null;
  }
  const completedCount = delegationRun.steps.filter((step) => step.status === "completed").length;
  const failedCount = delegationRun.steps.filter((step) => step.status === "failed").length;
  const skippedCount = delegationRun.steps.filter((step) => step.status === "skipped").length;
  const runningCount = delegationRun.steps.filter((step) => step.status === "running").length;
  const isCowork = mode === "cowork";
  const currentStep =
    delegationRun.steps.find((step) => step.status === "running") ??
    [...delegationRun.steps].reverse().find((step) => step.status === "completed" || step.status === "failed") ??
    delegationRun.steps[0];
  const formatStepLabel = (
    step: NonNullable<MissionThreadedActiveSessionSurfaceProps["delegationRun"]>["steps"][number],
  ) => step.label?.trim() || toTitleCase(step.role);
  const countsLine = `Completed ${completedCount} · Running ${runningCount} · Failed ${failedCount} · Skipped ${skippedCount}`;

  if (isCowork) {
    return (
      <section className="mc-next-thread-turn delegation compact">
        <details open={coworkExpanded} onToggle={(event) => setCoworkExpanded(event.currentTarget.open)}>
          <summary>
            <div className="mc-next-thread-strip">
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
                  className="mc-next-thread-inline-button"
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
          <div className="mc-next-thread-bubble assistant">
            <p className="mc-next-thread-meta">
              <strong>{delegationRun.label}</strong> · {delegationRun.mode}
            </p>
            <p>{delegationRun.objective}</p>
            <ol className="mc-next-thread-step-list">
              {delegationRun.steps.map((step) => (
                <li key={step.stepId}>
                  <div className="mc-next-thread-step-head">
                    <strong>{formatStepLabel(step)}</strong>
                    <span>{step.status}</span>
                  </div>
                  {step.summary ? <p>{step.summary}</p> : null}
                  {step.error ? <p>{step.error}</p> : null}
                  {step.output ? (
                    <details className="mc-next-thread-step-output-details">
                      <summary>Show subagent output</summary>
                      <AssistantMessageRenderer
                        role="assistant"
                        content={step.output}
                        className="mc-next-thread-step-output"
                      />
                    </details>
                  ) : null}
                </li>
              ))}
            </ol>
            {delegationRun.stitchedOutput ? <p>{describeDelegationStitchedOutput(delegationRun.status)}</p> : null}
          </div>
        </details>
      </section>
    );
  }

  return (
    <section className="mc-next-thread-turn delegation">
      <div className="mc-next-thread-strip">
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
      </div>
      <div className="mc-next-thread-bubble assistant">
        <p className="mc-next-thread-meta">
          <strong>{delegationRun.label}</strong> · {delegationRun.mode}
        </p>
        <p>{delegationRun.objective}</p>
        <p>
          Completed {completedCount} · Running {runningCount} · Failed {failedCount} · Skipped {skippedCount}
        </p>
        <ol className="mc-next-thread-step-list">
          {delegationRun.steps.map((step) => (
            <li key={step.stepId}>
              <div className="mc-next-thread-step-head">
                <strong>{step.label?.trim() || toTitleCase(step.role)}</strong>
                <span>{step.status}</span>
              </div>
              {step.output ? (
                <AssistantMessageRenderer
                  role="assistant"
                  content={step.output}
                  className="mc-next-thread-step-output"
                />
              ) : null}
              {step.error ? <p>{step.error}</p> : null}
            </li>
          ))}
        </ol>
        {delegationRun.stitchedOutput ? (
          <AssistantMessageRenderer role="assistant" content={delegationRun.stitchedOutput} />
        ) : null}
      </div>
    </section>
  );
}

function describeDelegationStitchedOutput(status?: string): string {
  switch (status) {
    case "completed":
      return "Final synthesized answer is shown in the main assistant message.";
    case "partial":
      return "Partial stitched output is available; review the run details before treating it as final.";
    case "failed":
      return "Failure output is available in the run details.";
    case "running":
    default:
      return "Delegated work is still running; final synthesis is not ready yet.";
  }
}

export function ThreadedTimeline({ props }: { props: MissionThreadedActiveSessionSurfaceProps }) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const pendingApproval = props.pendingApproval as ChatPendingApprovalState | null;
  const blockerActive = Boolean(pendingApproval || props.pendingUserInput);
  const liveStatus =
    props.streamError ??
    (props.streamStatus === "streaming"
      ? `${toTitleCase(props.mode)} response streaming${props.queuedCount > 0 ? ` with ${props.queuedCount} queued` : ""}.`
      : props.streamStatus === "queued"
        ? `${toTitleCase(props.mode)} turn queued.`
        : props.streamStatus === "connecting"
          ? `${toTitleCase(props.mode)} stream connecting.`
          : "");

  const handleThreadScroll = useCallback(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      props.onBottomStateChange(true);
      return;
    }
    props.onBottomStateChange(isThreadScrollNearBottom(scrollElement));
  }, [props.onBottomStateChange]);

  const jumpToLatest = useCallback(() => {
    threadEndRef.current?.scrollIntoView({ block: "end", behavior: "auto" });
    props.onBottomStateChange(true);
  }, [props.onBottomStateChange]);

  useLayoutEffect(() => {
    if (!props.followOutput) {
      return;
    }
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
    }
    scrollFrameRef.current = requestAnimationFrame(() => {
      scrollFrameRef.current = null;
      threadEndRef.current?.scrollIntoView({
        block: "end",
        behavior: "auto",
      });
    });
    return () => {
      if (scrollFrameRef.current !== null) {
        cancelAnimationFrame(scrollFrameRef.current);
        scrollFrameRef.current = null;
      }
    };
  }, [
    props.followOutput,
    props.notices.length,
    props.queuedCount,
    props.selectedTurnId,
    props.streamError,
    props.streamStatus,
    props.streamingPreview?.updatedAt,
    props.thread,
  ]);

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      return;
    }
    props.onBottomStateChange(isThreadScrollNearBottom(scrollElement));
  }, [props.onBottomStateChange, props.notices.length, props.queuedCount, props.streamStatus, props.thread]);

  useEffect(() => {
    const threadCard = shellRef.current?.closest(".mc-next-threaded-thread-card");
    const composerCard = threadCard?.nextElementSibling;
    if (!(composerCard instanceof HTMLElement) || !composerCard.classList.contains("mc-next-threaded-composer-card")) {
      return undefined;
    }

    if (!blockerActive) {
      return undefined;
    }

    const inertComposerCard = composerCard as HTMLElement & { inert?: boolean };
    const activeElement = globalThis.document?.activeElement;
    composerCard.setAttribute("aria-disabled", "true");
    composerCard.setAttribute("data-blocked-by-inline-prompt", "true");
    inertComposerCard.inert = true;
    if (activeElement instanceof HTMLElement && composerCard.contains(activeElement)) {
      activeElement.blur();
    }

    return () => {
      composerCard.removeAttribute("aria-disabled");
      composerCard.removeAttribute("data-blocked-by-inline-prompt");
      inertComposerCard.inert = false;
    };
  }, [blockerActive]);

  const blockingPrompt = pendingApproval ? (
    <div className="mc-next-thread-blocking-prompt" data-blocker-kind="approval">
      <ChatPendingApprovalPanel
        pendingApproval={pendingApproval}
        workspaceId={props.workspaceId}
        approvalsHref={`/ops/approvals?approvalId=${encodeURIComponent(pendingApproval.approvalId)}`}
        pending={props.approvalPending}
        onApprove={props.onApprovePending}
        onDeny={props.onDenyPending}
      />
    </div>
  ) : props.pendingUserInput ? (
    <div className="mc-next-thread-blocking-prompt" data-blocker-kind="user-input">
      <ChatPendingUserInputPanel
        pendingUserInput={props.pendingUserInput}
        pending={props.userInputPending}
        onSubmit={props.onSubmitUserInput}
      />
    </div>
  ) : null;

  return (
    <div ref={shellRef} className={`mc-next-thread-shell mode-${props.mode}`}>
      <div className="mc-next-thread-live-region" role="status" aria-live="polite" aria-atomic="true">
        {liveStatus}
      </div>
      <div className="mc-next-thread-status-lane">
        <SurfaceReconnectBanner mode={props.mode} status={props.eventStreamStatus} onRefresh={props.onRefreshThread} />
      </div>
      <div ref={scrollRef} className="mc-next-thread-scroll" onScroll={handleThreadScroll}>
        {props.loading ? (
          <div className="mc-next-thread-empty">Loading thread…</div>
        ) : !props.thread || props.thread.turns.length === 0 ? (
          <div className="mc-next-thread-empty">
            <p className="mc-next-thread-meta">
              <strong>GoatCitadel</strong>
            </p>
            <p>
              {props.mode === "cowork"
                ? "Describe the objective, constraints, and desired output. Cowork will create a visible run plan here."
                : "Start with a plain request, or type /help to see commands."}
            </p>
          </div>
        ) : (
          <div className="mc-next-thread-view">
            <ChatStreamStatusBar
              mode={props.mode}
              status={props.streamStatus as ChatStreamStatus}
              queuedCount={props.queuedCount}
              error={props.streamError}
            />
            <div className="mc-next-thread-list">
              <ThreadDelegationSummary
                delegationRun={props.delegationRun ?? null}
                mode={props.mode}
                onOpenRunDetails={props.onOpenRunDetails}
              />
              {props.thread.turns.map((turn) => (
                <ThreadTurnCard
                  key={turn.turnId}
                  mode={props.mode}
                  turn={turn}
                  selected={props.selectedTurnId === turn.turnId}
                  streamingPreview={props.streamingPreview?.turnId === turn.turnId ? props.streamingPreview : null}
                  onSelect={props.onSelectTurn}
                  onSwitchBranch={props.onSwitchBranch}
                  onRetryTurn={props.onRetryTurn}
                  onOpenRunDetails={props.onOpenRunDetails}
                  onOpenGeneratedArtifact={props.onOpenGeneratedArtifact}
                  onCreateGeneratedArtifact={props.onCreateGeneratedArtifact}
                  onCreateGeneratedArtifactVersion={props.onCreateGeneratedArtifactVersion}
                />
              ))}
              <ThreadNotices notices={props.notices} />
              {blockingPrompt}
              <div ref={threadEndRef} aria-hidden="true" />
            </div>
          </div>
        )}
      </div>
      {!props.followOutput && props.streamStatus === "streaming" ? (
        <button type="button" className="mc-next-thread-jump-latest" onClick={jumpToLatest}>
          Jump to latest
        </button>
      ) : null}
      {props.loading || !props.thread || props.thread.turns.length === 0 ? blockingPrompt : null}
    </div>
  );
}
