import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import {
  getChatTurnRecoveryActionLabel,
  isChatTurnActiveStatus,
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

function ThreadTurnCard({
  mode,
  turn,
  selected,
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
        <div className="mc-next-thread-bubble assistant">
          <p className="mc-next-thread-meta">
            <strong>GoatCitadel</strong> ·{" "}
            {turn.assistantMessage ? formatActorTimestamp(turn.assistantMessage.timestamp) : "Running"}
            {turnHasRepairedAssistantOutput(turn) ? (
              <>
                {" "}
                <Badge variant="outline" className="align-middle">
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
            {delegationRun.stitchedOutput ? (
              <p>Final synthesized answer is shown in the main assistant message.</p>
            ) : null}
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

export function ThreadedTimeline({ props }: { props: MissionThreadedActiveSessionSurfaceProps }) {
  const shellRef = useRef<HTMLDivElement | null>(null);
  const threadEndRef = useRef<HTMLDivElement | null>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const pendingApproval = props.pendingApproval as ChatPendingApprovalState | null;
  const blockerActive = Boolean(pendingApproval || props.pendingUserInput);

  useEffect(() => {
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
        behavior: props.streamStatus === "streaming" ? "smooth" : "auto",
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
    props.thread,
  ]);

  useEffect(() => {
    props.onBottomStateChange(true);
  }, [props]);

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
      <div className="mc-next-thread-status-lane">
        <SurfaceReconnectBanner mode={props.mode} status={props.eventStreamStatus} onRefresh={props.onRefreshThread} />
      </div>
      <div className="mc-next-thread-scroll">
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
                  onSelect={(turnId) => props.onSelectTurn(turnId)}
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
      {props.loading || !props.thread || props.thread.turns.length === 0 ? blockingPrompt : null}
    </div>
  );
}
