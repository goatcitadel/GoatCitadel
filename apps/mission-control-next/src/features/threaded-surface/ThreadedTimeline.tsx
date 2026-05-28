import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { type ChatCitationRecord, type ChatMode, type ChatThreadTurnRecord } from "@goatcitadel/contracts";
import type { MissionThreadedActiveSessionSurfaceProps } from "@goatcitadel/threaded-surface-core";
import { Badge } from "@goatcitadel/mission-control-shared/components/ui";
import { StatusChip } from "../native-routes/primitives";
import {
  ChatStreamStatusBar,
  type ChatStreamStatus,
} from "@goatcitadel/mission-control-shared/components/chat/ChatStreamStatusBar";
import { AssistantMessageRenderer } from "@goatcitadel/mission-control-shared/components/chat/AssistantMessageRenderer";
import { ChatAttachmentPreviewStack } from "@goatcitadel/mission-control-shared/components/chat/ChatAttachmentPreviewStack";
import { SurfaceReconnectBanner } from "@goatcitadel/mission-control-shared/components/chat/SurfaceReconnectBanner";
import { normalizeCitationDisplayText } from "@goatcitadel/mission-control-shared/components/chat/assistant-display-text";
import {
  getAssistantPendingLabel,
  getRecoveryStripLabel,
  getTraceTone,
  renderSuggestionSummary,
  summarizeDelegationSteps,
  summarizeTurnRouting,
  toTitleCase,
  turnHasRepairedAssistantOutput,
} from "@goatcitadel/mission-control-shared/components/chat/chat-display-helpers";
import {
  useChannelActivitySnapshots,
  type ChannelActivitySnapshot,
} from "@goatcitadel/mission-control-shared/state/channel-activity-store";

const THREAD_WINDOW_THRESHOLD = 80;
const THREAD_WINDOW_SIZE = 60;
const THREAD_PIN_OVERSCAN = 4;

const ACTOR_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const ACTOR_ABSOLUTE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

function parseTimestamp(timestamp: string): number | null {
  const parsed = Date.parse(timestamp);
  return Number.isNaN(parsed) ? null : parsed;
}

function formatActorTimestamp(timestamp: string): string {
  const parsed = parseTimestamp(timestamp);
  return parsed === null ? "Time unknown" : ACTOR_TIME_FORMATTER.format(parsed);
}

function formatActorTimestampTitle(timestamp: string): string | undefined {
  const parsed = parseTimestamp(timestamp);
  return parsed === null ? timestamp || undefined : ACTOR_ABSOLUTE_TIME_FORMATTER.format(parsed);
}

function ActorTimestamp({ timestamp }: { timestamp: string }) {
  return (
    <time dateTime={timestamp} title={formatActorTimestampTitle(timestamp)}>
      {formatActorTimestamp(timestamp)}
    </time>
  );
}

function ChannelActivityBadge({ activity }: { activity: ChannelActivitySnapshot | null }) {
  if (!activity) {
    return null;
  }
  return (
    <span
      className={`mc-next-thread-channel-activity phase-${activity.phase}`}
      title={`${activity.label} on ${activity.channelKey ?? "channel"}`}
      aria-label={`Channel activity: ${activity.label}`}
      role="status"
      aria-live="polite"
    >
      <span aria-hidden="true">{activity.emoji}</span>
      <span>{activity.label}</span>
    </span>
  );
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
  const [expanded, setExpanded] = useState(false);
  if (citations.length === 0) {
    return null;
  }
  const collapsedLimit = 6;
  const visibleCitations = expanded ? citations : citations.slice(0, collapsedLimit);
  const hiddenCount = citations.length - visibleCitations.length;
  return (
    <div className="mc-next-thread-citations" aria-label="Citations for this answer">
      {visibleCitations.map((citation, index) => {
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
      {citations.length > collapsedLimit ? (
        <button
          type="button"
          className="mc-next-thread-inline-button mc-next-thread-citations-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? "Show fewer citations" : `Show ${hiddenCount} more citations`}
        </button>
      ) : null}
    </div>
  );
}

type ThreadWindowItem =
  | { kind: "turn"; turn: ChatThreadTurnRecord; index: number }
  | { kind: "gap"; key: string; hiddenCount: number };

function createIndexRange(start: number, end: number, total: number): [number, number] | null {
  if (total <= 0) {
    return null;
  }
  const clampedStart = Math.max(0, Math.min(start, total - 1));
  const clampedEnd = Math.max(0, Math.min(end, total - 1));
  return clampedStart <= clampedEnd ? [clampedStart, clampedEnd] : null;
}

function mergeIndexRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const sorted = [...ranges].sort((left, right) => left[0] - right[0]);
  const merged: Array<[number, number]> = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (!previous || range[0] > previous[1] + 1) {
      merged.push([...range] as [number, number]);
      continue;
    }
    previous[1] = Math.max(previous[1], range[1]);
  }
  return merged;
}

function buildThreadWindow({
  turns,
  windowStart,
  selectedTurnId,
  contextTurnIds,
  streamingTurnId,
}: {
  turns: ChatThreadTurnRecord[];
  windowStart: number;
  selectedTurnId: string | null;
  contextTurnIds: string[];
  streamingTurnId: string | null;
}): ThreadWindowItem[] {
  if (turns.length <= THREAD_WINDOW_THRESHOLD) {
    return turns.map((turn, index) => ({ kind: "turn", turn, index }));
  }

  const ranges: Array<[number, number]> = [];
  const baseRange = createIndexRange(windowStart, turns.length - 1, turns.length);
  if (baseRange) {
    ranges.push(baseRange);
  }

  const pinnedTurnIds = new Set<string>(contextTurnIds);
  if (selectedTurnId) {
    pinnedTurnIds.add(selectedTurnId);
  }
  if (streamingTurnId) {
    pinnedTurnIds.add(streamingTurnId);
  }

  for (let index = 0; index < turns.length; index += 1) {
    if (!pinnedTurnIds.has(turns[index]!.turnId)) {
      continue;
    }
    const pinnedRange = createIndexRange(index - THREAD_PIN_OVERSCAN, index + THREAD_PIN_OVERSCAN, turns.length);
    if (pinnedRange) {
      ranges.push(pinnedRange);
    }
  }

  const mergedRanges = mergeIndexRanges(ranges);
  const items: ThreadWindowItem[] = [];
  let cursor = 0;
  for (const [start, end] of mergedRanges) {
    if (start > cursor) {
      items.push({
        kind: "gap",
        key: `gap-${cursor}-${start - 1}`,
        hiddenCount: start - cursor,
      });
    }
    for (let index = start; index <= end; index += 1) {
      items.push({ kind: "turn", turn: turns[index]!, index });
    }
    cursor = end + 1;
  }
  if (cursor < turns.length) {
    items.push({
      kind: "gap",
      key: `gap-${cursor}-${turns.length - 1}`,
      hiddenCount: turns.length - cursor,
    });
  }
  return items;
}

function isInteractiveTimelineEventTarget(target: EventTarget | null, currentTarget: EventTarget): boolean {
  const maybeElement = target as { closest?: (selector: string) => Element | null } | null;
  const interactiveAncestor = maybeElement?.closest?.(
    'a, button, input, select, textarea, summary, details, [role="button"], [role="link"], [contenteditable="true"]',
  );
  return Boolean(interactiveAncestor && interactiveAncestor !== currentTarget);
}

function handleTurnSurfaceKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  turnId: string,
  onSelectTurn: (turnId: string | null) => void,
) {
  if (event.target !== event.currentTarget) {
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onSelectTurn(turnId);
  }
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
        aria-label={`Show previous variant for turn ${turn.turnId}`}
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
        aria-label={`Show next variant for turn ${turn.turnId}`}
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
  contextSelected,
  streamingPreview,
  visualStreamMode,
  channelActivity,
  onToggleContextTurn,
  onSelectTurn,
  onStartNewThreadFromTurn,
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
  contextSelected: boolean;
  streamingPreview?: MissionThreadedActiveSessionSurfaceProps["streamingPreview"];
  visualStreamMode: MissionThreadedActiveSessionSurfaceProps["visualStreamMode"];
  channelActivity?: ChannelActivitySnapshot | null;
  onToggleContextTurn: (turnId: string) => void;
  onSelectTurn: (turnId: string | null) => void;
  onStartNewThreadFromTurn: (turnId: string) => void;
  onSwitchBranch: (turnId: string) => void;
  onRetryTurn: (turnId: string) => void;
  onOpenRunDetails: (turnId: string) => void;
  onOpenGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifactVersion: (turnId: string) => void;
}) {
  const suggestionSummary = renderSuggestionSummary(turn.trace.capabilityUpgradeSuggestions);
  const recoveryLabel = getRecoveryStripLabel(turn);
  const routingSummary = summarizeTurnRouting(turn, { effectiveVerb: "used" });
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
  const assistantPendingLabel = getAssistantPendingLabel(turn.trace, { isStreamingTurn });
  const isPlainChat = mode === "chat";
  const showOperationalDetails =
    !isPlainChat ||
    isStreamingTurn ||
    turn.trace.status !== "completed" ||
    turnHasRepairedAssistantOutput(turn) ||
    turn.trace.routing.fallbackUsed ||
    Boolean(turn.trace.failure) ||
    turn.toolRuns.length > 0 ||
    hasGeneratedArtifact;
  const isRoutineChatTurn = isPlainChat && !showOperationalDetails;
  const turnClassName = [
    "mc-next-thread-turn",
    selected ? "selected" : "",
    contextSelected ? "context-pinned" : "",
    isStreamingTurn ? "streaming" : "",
    isRoutineChatTurn ? "routine-chat" : "",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <article className={turnClassName}>
      <div
        className="mc-next-thread-turn-surface"
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={`Select turn ${turn.turnId}`}
        onClick={(event: ReactMouseEvent<HTMLDivElement>) => {
          if (!isInteractiveTimelineEventTarget(event.target, event.currentTarget)) {
            onSelectTurn(turn.turnId);
          }
        }}
        onKeyDown={(event) => handleTurnSurfaceKeyDown(event, turn.turnId, onSelectTurn)}
      >
        <div className="mc-next-thread-bubble user">
          <p className="mc-next-thread-meta">
            <strong>You</strong> · <ActorTimestamp timestamp={turn.userMessage.timestamp} />
            <ChannelActivityBadge activity={channelActivity ?? null} />
          </p>
          <AssistantMessageRenderer role="user" content={turn.userMessage.content} />
          <ChatAttachmentPreviewStack
            attachments={turn.userMessage.attachments}
            eager={selected || contextSelected || isStreamingTurn}
          />
        </div>
        <div
          className={`mc-next-thread-bubble assistant${isStreamingTurn ? " streaming" : ""}`}
          aria-busy={isStreamingTurn}
        >
          <p className="mc-next-thread-meta">
            <strong>GoatCitadel</strong> ·{" "}
            {turn.assistantMessage ? (
              <ActorTimestamp timestamp={turn.assistantMessage.timestamp} />
            ) : (
              assistantTimestamp
            )}
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
            <AssistantMessageRenderer
              role="assistant"
              content={assistantContent}
              running={isStreamingTurn}
              streamPresentationMode={visualStreamMode}
            />
          ) : isStreamingTurn ? (
            <StreamingAssistantSkeleton label={assistantPendingLabel} />
          ) : (
            <p>{assistantPendingLabel}</p>
          )}
          <ThreadCitationList citations={turn.citations} />
        </div>
      </div>
      <div className={`mc-next-thread-strip${showOperationalDetails ? "" : " compact"}`}>
        <label className="mc-next-thread-context-toggle">
          <input
            type="checkbox"
            checked={contextSelected}
            aria-label={`${contextSelected ? "Remove" : "Add"} turn ${turn.turnId} as context`}
            onChange={() => onToggleContextTurn(turn.turnId)}
          />
          <span>Context</span>
        </label>
        {contextSelected ? <span className="mc-next-thread-context-pin">Context pinned</span> : null}
        {showOperationalDetails ? (
          <>
            <StatusChip tone={getTraceTone(turn.trace)}>{turn.trace.status}</StatusChip>
            {recoveryLabel ? <span>{recoveryLabel}</span> : null}
            {routingSummary.map((item) => (
              <span key={item}>{item}</span>
            ))}
            {turn.toolRuns.length > 0 ? <span>{turn.toolRuns.length} tools</span> : null}
            {turn.citations.length > 0 ? <span>{turn.citations.length} citations</span> : null}
          </>
        ) : null}
        <button
          type="button"
          className="mc-next-thread-inline-button"
          aria-label={`Open execution detail for turn ${turn.turnId}`}
          onClick={() => onOpenRunDetails(turn.turnId)}
        >
          {mode === "cowork" ? "Run details" : "Details"}
        </button>
      </div>
      <div className="mc-next-thread-actions">
        <details className="mc-next-thread-action-menu">
          <summary className="mc-next-thread-inline-button mc-next-thread-action-menu-summary">Actions</summary>
          <div className="mc-next-thread-action-menu-body">
            <div className="mc-next-thread-action-row">
              {turn.assistantMessage ? (
                <button type="button" className="mc-next-thread-inline-button" onClick={() => onRetryTurn(turn.turnId)}>
                  {mode === "cowork" ? "Retry run step" : "Retry"}
                </button>
              ) : null}
              <button
                type="button"
                className="mc-next-thread-inline-button"
                aria-label={`Start a new thread from turn ${turn.turnId}`}
                disabled={isStreamingTurn}
                onClick={() => onStartNewThreadFromTurn(turn.turnId)}
              >
                Start new thread
              </button>
              {turn.assistantMessage ? (
                <button
                  type="button"
                  className="mc-next-thread-inline-button"
                  onClick={() =>
                    hasGeneratedArtifact ? onOpenGeneratedArtifact(turn.turnId) : onCreateGeneratedArtifact(turn.turnId)
                  }
                >
                  {hasGeneratedArtifact ? "Open saved answer" : "Save answer"}
                </button>
              ) : null}
              {hasGeneratedArtifact ? (
                <button
                  type="button"
                  className="mc-next-thread-inline-button"
                  onClick={() => onCreateGeneratedArtifactVersion(turn.turnId)}
                >
                  Save new version
                </button>
              ) : null}
            </div>
          </div>
        </details>
        <ThreadBranchSwitcher turn={turn} onSwitch={onSwitchBranch} />
        {suggestionSummary ? <p className="mc-next-thread-note">Suggested next move: {suggestionSummary}</p> : null}
      </div>
    </article>
  );
});

function StreamingAssistantSkeleton({ label }: { label: string }) {
  return (
    <div className="mc-next-assistant-streaming-skeleton" role="status" aria-label={label}>
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      <span aria-hidden="true" />
    </div>
  );
}

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
            <strong>Notice</strong> · <ActorTimestamp timestamp={notice.timestamp} />
          </p>
          <p>{notice.content}</p>
        </li>
      ))}
    </ul>
  );
}

function ThreadWindowGap({ hiddenCount, onExpand }: { hiddenCount: number; onExpand: () => void }) {
  return (
    <div className="mc-next-thread-window-gap" role="status">
      <span>
        {hiddenCount} earlier turn{hiddenCount === 1 ? "" : "s"} hidden for performance.
      </span>
      <button type="button" className="mc-next-thread-inline-button" onClick={onExpand}>
        Show hidden turns
      </button>
    </div>
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
  const { completedCount, failedCount, skippedCount, runningCount, currentStep } = summarizeDelegationSteps(
    delegationRun.steps,
  );
  const isCowork = mode === "cowork";
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
  const [manualWindowStart, setManualWindowStart] = useState<number | null>(null);
  const lastTurn = props.thread?.turns.at(-1) ?? null;
  const threadTurnCount = props.thread?.turns.length ?? 0;
  const latestTurnId = props.thread?.activeLeafTurnId ?? lastTurn?.turnId ?? null;
  const latestAssistantContentLength = lastTurn?.assistantMessage?.content.length ?? 0;
  const latestTraceStatus = lastTurn?.trace.status ?? null;
  const channelActivities = useChannelActivitySnapshots(props.thread?.sessionId ?? null);
  const channelActivityByMessageId = useMemo(
    () => new Map(channelActivities.map((activity) => [activity.messageId, activity])),
    [channelActivities],
  );
  const selectedContextTurnIdSet = useMemo(
    () => new Set(props.selectedContextTurnIds ?? []),
    [props.selectedContextTurnIds],
  );
  const defaultWindowStart = Math.max(0, threadTurnCount - THREAD_WINDOW_SIZE);
  const effectiveWindowStart = Math.min(manualWindowStart ?? defaultWindowStart, defaultWindowStart);
  const windowedThreadItems = useMemo(
    () =>
      buildThreadWindow({
        turns: props.thread?.turns ?? [],
        windowStart: effectiveWindowStart,
        selectedTurnId: props.selectedTurnId,
        contextTurnIds: props.selectedContextTurnIds ?? [],
        streamingTurnId: props.activeStreamingTurnId ?? props.streamingPreview?.turnId ?? null,
      }),
    [
      effectiveWindowStart,
      props.activeStreamingTurnId,
      props.selectedContextTurnIds,
      props.selectedTurnId,
      props.streamingPreview?.turnId,
      props.thread?.turns,
    ],
  );
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

  const showHiddenTurns = useCallback(() => {
    setManualWindowStart(0);
  }, []);

  useEffect(() => {
    setManualWindowStart(null);
  }, [props.thread?.sessionId]);

  useLayoutEffect(() => {
    if (!props.followOutput) {
      return;
    }
    if (scrollFrameRef.current !== null) {
      cancelAnimationFrame(scrollFrameRef.current);
    }
    const pinToThreadEnd = () => {
      threadEndRef.current?.scrollIntoView({
        block: "end",
        behavior: "auto",
      });
      props.onBottomStateChange(true);
    };
    scrollFrameRef.current = requestAnimationFrame(() => {
      pinToThreadEnd();
      scrollFrameRef.current = requestAnimationFrame(() => {
        scrollFrameRef.current = null;
        pinToThreadEnd();
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
    props.onBottomStateChange,
    props.queuedCount,
    props.selectedTurnId,
    props.streamError,
    props.streamStatus,
    props.streamingPreview?.updatedAt,
    threadTurnCount,
    latestTurnId,
    latestAssistantContentLength,
    latestTraceStatus,
  ]);

  useLayoutEffect(() => {
    const scrollElement = scrollRef.current;
    if (!scrollElement) {
      return;
    }
    if (props.followOutput) {
      return;
    }
    props.onBottomStateChange(isThreadScrollNearBottom(scrollElement));
  }, [
    props.followOutput,
    props.onBottomStateChange,
    props.notices.length,
    props.queuedCount,
    props.streamStatus,
    threadTurnCount,
    latestTurnId,
    latestTraceStatus,
  ]);

  return (
    <div ref={shellRef} className={`mc-next-thread-shell mode-${props.mode}`}>
      <div
        className="mc-next-thread-live-region"
        role="status"
        aria-live={liveStatus ? "polite" : "off"}
        aria-atomic="true"
      >
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
                : props.mode === "code"
                  ? "Describe a focused implementation or review task. The workbench will show diffs, validation results, and Code Mode runs as evidence appears."
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
              announce={false}
            />
            <div className="mc-next-thread-list">
              <ThreadDelegationSummary
                delegationRun={props.delegationRun ?? null}
                mode={props.mode}
                onOpenRunDetails={props.onOpenRunDetails}
              />
              {windowedThreadItems.map((item) =>
                item.kind === "gap" ? (
                  <ThreadWindowGap key={item.key} hiddenCount={item.hiddenCount} onExpand={showHiddenTurns} />
                ) : (
                  <ThreadTurnCard
                    key={item.turn.turnId}
                    mode={props.mode}
                    turn={item.turn}
                    selected={props.selectedTurnId === item.turn.turnId}
                    contextSelected={selectedContextTurnIdSet.has(item.turn.turnId)}
                    streamingPreview={
                      props.streamingPreview?.turnId === item.turn.turnId ? props.streamingPreview : null
                    }
                    visualStreamMode={props.visualStreamMode}
                    channelActivity={channelActivityByMessageId.get(item.turn.userMessage.messageId) ?? null}
                    onToggleContextTurn={props.onToggleContextTurn}
                    onSelectTurn={props.onSelectTurn}
                    onStartNewThreadFromTurn={props.onStartNewThreadFromTurn}
                    onSwitchBranch={props.onSwitchBranch}
                    onRetryTurn={props.onRetryTurn}
                    onOpenRunDetails={props.onOpenRunDetails}
                    onOpenGeneratedArtifact={props.onOpenGeneratedArtifact}
                    onCreateGeneratedArtifact={props.onCreateGeneratedArtifact}
                    onCreateGeneratedArtifactVersion={props.onCreateGeneratedArtifactVersion}
                  />
                ),
              )}
              <ThreadNotices notices={props.notices} />
              <div ref={threadEndRef} aria-hidden="true" />
            </div>
          </div>
        )}
      </div>
      {!props.followOutput && props.thread && props.thread.turns.length > 0 ? (
        <button type="button" className="mc-next-thread-jump-latest" onClick={jumpToLatest}>
          Jump to latest
        </button>
      ) : null}
    </div>
  );
}
