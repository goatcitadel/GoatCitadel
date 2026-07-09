import {
  memo,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import {
  isChatTurnActiveStatus,
  type ChatMode,
  type ChatStreamingPreview,
  type ChatThreadTurnRecord,
} from "@goatcitadel/contracts";
import { Badge } from "../ui";
import { AssistantMessageRenderer, type AssistantStreamPresentationMode } from "./AssistantMessageRenderer";
import { ChatAttachmentPreviewStack } from "./ChatAttachmentPreviewStack";
import { ChatThinkingSection } from "./ChatThinkingSection";
import { ChatLiveActivityRail, ChatTurnActivityRows, formatToolRunElapsed } from "./ChatToolActivity";
import {
  canRetryTurn,
  getAssistantPendingLabel,
  getRecoveryStripLabel,
  getTraceTone,
  parseTimestamp,
  renderSuggestionSummary,
  summarizeDelegationSteps,
  summarizeTurnRouting,
  toTitleCase,
  turnHasRepairedAssistantOutput,
} from "./chat-display-helpers";

export interface ChatThreadNotice {
  id: string;
  tone: "neutral" | "warning" | "critical" | "success";
  content: string;
  timestamp: string;
}

export interface ChatDelegationStepView {
  stepId: string;
  runId?: string;
  role: string;
  label?: string;
  status: string;
  index: number;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  summary?: string;
  output?: string;
  error?: string;
  failureGuidance?: string;
  degradedHandoffStepIds?: string[];
  durableRunId?: string;
  childSessionId?: string;
  childTurnId?: string;
}

export interface ChatDelegationRunView {
  runId?: string;
  taskId?: string;
  executionPlanId?: string;
  attachedTurnId?: string | null;
  label: string;
  objective: string;
  mode: string;
  status: string;
  steps: ChatDelegationStepView[];
  stitchedOutput?: string;
}

export const THREAD_WINDOW_THRESHOLD = 80;
export const THREAD_WINDOW_SIZE = 60;
export const THREAD_PIN_OVERSCAN = 4;

export type ChatThreadWindowItem =
  | { kind: "turn"; turn: ChatThreadTurnRecord; index: number }
  | { kind: "gap"; key: string; hiddenCount: number };

const ACTOR_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

const ACTOR_ABSOLUTE_TIME_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

export function formatActorTimestamp(timestamp: string): string {
  const parsed = parseTimestamp(timestamp);
  return parsed === null ? "Time unknown" : ACTOR_TIME_FORMATTER.format(parsed);
}

export function formatActorTimestampTitle(timestamp: string): string | undefined {
  const parsed = parseTimestamp(timestamp);
  return parsed === null ? timestamp || undefined : ACTOR_ABSOLUTE_TIME_FORMATTER.format(parsed);
}

export function ActorTimestamp({ timestamp }: { timestamp: string }) {
  return (
    <time dateTime={timestamp} title={formatActorTimestampTitle(timestamp)}>
      {formatActorTimestamp(timestamp)}
    </time>
  );
}

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
    merged[merged.length - 1] = [previous[0], Math.max(previous[1], range[1])];
  }
  return merged;
}

export function buildThreadWindow({
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
}): ChatThreadWindowItem[] {
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
  const items: ChatThreadWindowItem[] = [];
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

/**
 * Resolves the window start index {@link buildThreadWindow} should use,
 * honoring three interacting states:
 *
 * - `manualWindowStart` (the "show hidden turns" affordance): when set, it
 *   always wins — the operator explicitly asked to see earlier turns, so
 *   neither the live default nor a scroll-freeze should re-hide them.
 * - `frozenWindowStart` (captured the moment the operator scrolls away from
 *   the bottom): while set, the window never advances past it, even as new
 *   turns append and push the live default forward. This keeps the oldest
 *   turn the operator is currently reading mounted, preserving scroll
 *   anchoring. `Math.min` guards a shrinking thread (e.g. branch switch)
 *   from producing a start past the live default.
 * - `defaultWindowStart` (the live default): used whenever neither of the
 *   above applies.
 *
 * Precedence: manual > frozen > live default.
 */
export function resolveEffectiveWindowStart({
  manualWindowStart,
  frozenWindowStart,
  defaultWindowStart,
}: {
  manualWindowStart: number | null;
  frozenWindowStart: number | null;
  defaultWindowStart: number;
}): number {
  if (manualWindowStart !== null) {
    return Math.min(manualWindowStart, defaultWindowStart);
  }
  if (frozenWindowStart !== null) {
    return Math.min(frozenWindowStart, defaultWindowStart);
  }
  return defaultWindowStart;
}

export function isInteractiveChatEventTarget(target: EventTarget | null, currentTarget: EventTarget): boolean {
  const maybeElement = target as { closest?: (selector: string) => Element | null } | null;
  const interactiveAncestor = maybeElement?.closest?.(
    'a, button, input, select, textarea, summary, details, [role="button"], [role="link"], [contenteditable="true"]',
  );
  return Boolean(interactiveAncestor && interactiveAncestor !== currentTarget);
}

export function handleTurnSurfaceKeyDown(
  event: ReactKeyboardEvent<HTMLDivElement>,
  turnId: string,
  onSelectTurn: (turnId: string) => void,
) {
  if (event.target !== event.currentTarget) {
    return;
  }
  if (event.key === "Enter" || event.key === " ") {
    event.preventDefault();
    onSelectTurn(turnId);
  }
}

export function isThreadScrollNearBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= 80;
}

function PrimitiveStatusChip({ tone, children }: { tone: string; children: ReactNode }) {
  return (
    <span className="mc-next-status-chip" data-tone={tone} data-size="sm">
      <span className="mc-next-status-chip-label">{children}</span>
    </span>
  );
}

function getDelegationStatusTone(status: string): "critical" | "warning" | "success" {
  if (status === "failed") {
    return "critical";
  }
  if (status === "completed") {
    return "success";
  }
  return "warning";
}

export function ChatThreadBranchSwitcher({
  turn,
  onSwitch,
}: {
  turn: ChatThreadTurnRecord;
  onSwitch: (turnId: string) => void;
}) {
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

export function StreamingAssistantSkeleton({ label }: { label: string }) {
  // Visual-only pending indicator. Streaming activity is announced by the single
  // owning live region per surface (ThreadedTimeline's live region / ChatThreadView's
  // status bar) and the enclosing assistant bubble's aria-busy, so this skeleton must
  // NOT carry role="status" or it would duplicate that announcement to screen readers.
  return (
    <div className="mc-next-assistant-streaming-skeleton" aria-label={label}>
      <span aria-hidden="true" />
      <span aria-hidden="true" />
      <span aria-hidden="true" />
    </div>
  );
}

export function ChatThreadNotices({ notices }: { notices: ChatThreadNotice[] }) {
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
          <NoticeContent content={notice.content} />
        </li>
      ))}
    </ul>
  );
}

function NoticeContent({ content }: { content: string }) {
  const lines = content.split(/\r?\n/);
  return (
    <p className="mc-next-thread-notice-content">
      {lines.map((line, index) => (
        <span key={index}>
          {index > 0 ? <br /> : null}
          {line}
        </span>
      ))}
    </p>
  );
}

export function ChatThreadWindowGap({ hiddenCount, onExpand }: { hiddenCount: number; onExpand: () => void }) {
  return (
    <div className="mc-next-thread-window-gap">
      <span>
        {hiddenCount} earlier turn{hiddenCount === 1 ? "" : "s"} hidden for performance.
      </span>
      <button type="button" className="mc-next-thread-inline-button" onClick={onExpand}>
        Show hidden turns
      </button>
    </div>
  );
}

function TurnEvidenceSummary({
  mode,
  turn,
  recoveryLabel,
  routingSummary,
  durableRunId,
  citationList,
  contextSelected,
  showContextToggle,
  showOperationalDetails,
  expandedByDefault,
  suppressActivityRows,
  onToggleContextTurn,
  onOpenRunDetails,
  onOpenUniversalRunDetail,
}: {
  mode: ChatMode;
  turn: ChatThreadTurnRecord;
  recoveryLabel: string | null;
  routingSummary: string[];
  durableRunId?: string;
  citationList?: ReactNode;
  contextSelected: boolean;
  showContextToggle: boolean;
  showOperationalDetails: boolean;
  expandedByDefault: boolean;
  /**
   * True while {@link ChatLiveActivityRail} is mounted live inside the
   * assistant bubble for this turn. The evidence body must not render
   * {@link ChatTurnActivityRows} in that window, or the same tool runs would
   * appear in two places at once.
   */
  suppressActivityRows: boolean;
  onToggleContextTurn?: (turnId: string) => void;
  onOpenRunDetails: (turnId: string) => void;
  onOpenUniversalRunDetail?: (runId: string) => void;
}) {
  const [open, setOpen] = useState(expandedByDefault);
  const userToggledRef = useRef(false);
  const expandedByDefaultRef = useRef(expandedByDefault);
  expandedByDefaultRef.current = expandedByDefault;
  useEffect(() => {
    if (!userToggledRef.current) {
      setOpen(expandedByDefault);
    }
  }, [expandedByDefault]);
  useEffect(() => {
    // New turn reusing this component: forget the prior turn's manual toggle and
    // re-apply this turn's default. Reads the default via a ref (always current, kept
    // in sync above) rather than depending on expandedByDefault directly, so a later
    // default change for the SAME turn does not re-trigger this reset.
    userToggledRef.current = false;
    setOpen(expandedByDefaultRef.current);
  }, [turn.turnId]);
  const summaryChips = [
    turn.trace.status,
    turn.toolRuns.length > 0 ? `${turn.toolRuns.length} tool${turn.toolRuns.length === 1 ? "" : "s"}` : null,
    turn.citations.length > 0 ? `${turn.citations.length} source${turn.citations.length === 1 ? "" : "s"}` : null,
    durableRunId ? `Run ${formatCompactEvidenceId(durableRunId)}` : null,
    turn.trace.failure ? turn.trace.failure.failureClass : null,
    turn.trace.orchestration ? "orchestrated" : null,
  ].filter((chip): chip is string => Boolean(chip));

  return (
    <details
      className={`mc-next-turn-evidence-summary${showOperationalDetails ? "" : " compact"}`}
      open={open}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open;
        if (nextOpen !== open) {
          userToggledRef.current = true;
        }
        setOpen(nextOpen);
      }}
    >
      <summary className="mc-next-turn-evidence-summary-trigger">
        <span className="mc-next-turn-evidence-title">Evidence</span>
        {summaryChips.map((chip, index) => (
          <span key={`${chip}-${index}`} className="mc-next-turn-evidence-chip">
            {chip}
          </span>
        ))}
      </summary>
      <div className="mc-next-turn-evidence-body">
        <div className={`mc-next-thread-strip${showOperationalDetails ? "" : " compact"}`}>
          {showContextToggle ? (
            <label className="mc-next-thread-context-toggle">
              <input
                type="checkbox"
                checked={contextSelected}
                aria-label={`${contextSelected ? "Remove" : "Add"} turn ${turn.turnId} as context`}
                onChange={() => onToggleContextTurn?.(turn.turnId)}
              />
              <span>Context</span>
            </label>
          ) : null}
          {showContextToggle && contextSelected ? (
            <span className="mc-next-thread-context-pin">Context pinned</span>
          ) : null}
          {showOperationalDetails ? (
            <>
              <PrimitiveStatusChip tone={getTraceTone(turn.trace)}>{turn.trace.status}</PrimitiveStatusChip>
              {recoveryLabel ? (
                <span>{recoveryLabel}</span>
              ) : turn.trace.failure ? (
                <span>{turn.trace.failure.failureClass}</span>
              ) : null}
              {routingSummary.map((item, index) => (
                <span key={index}>{item}</span>
              ))}
              {durableRunId ? (
                <span className="mc-next-thread-activity-chip">Run {formatCompactEvidenceId(durableRunId)}</span>
              ) : null}
              {turn.trace.guidance?.truncated ? (
                <span className="mc-next-thread-activity-chip">context trimmed</span>
              ) : null}
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
          {durableRunId && onOpenUniversalRunDetail ? (
            <button
              type="button"
              className="mc-next-thread-inline-button"
              aria-label={`Open durable run trace ${durableRunId}`}
              onClick={() => onOpenUniversalRunDetail(durableRunId)}
            >
              Run trace
            </button>
          ) : null}
        </div>
        {citationList ? (
          <div className="mc-next-turn-evidence-section">
            <span className="mc-next-turn-evidence-section-title">Sources</span>
            {citationList}
          </div>
        ) : null}
        {suppressActivityRows ? null : (
          <ChatTurnActivityRows
            mode={mode}
            toolRuns={turn.toolRuns}
            onOpenRunDetails={() => onOpenRunDetails(turn.turnId)}
          />
        )}
      </div>
    </details>
  );
}

function formatCompactEvidenceId(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= 18) {
    return trimmed;
  }
  return `${trimmed.slice(0, 8)}...${trimmed.slice(-6)}`;
}

function formatDurationMs(durationMs?: number): string | null {
  if (!Number.isFinite(durationMs) || durationMs === undefined || durationMs < 0) {
    return null;
  }
  if (durationMs < 1000) {
    return `${Math.max(1, Math.round(durationMs))} ms`;
  }
  return `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function formatStepDuration(step: ChatDelegationStepView): string | null {
  return formatDurationMs(step.durationMs) ?? formatToolRunElapsed(step.startedAt ?? "", step.finishedAt) ?? null;
}

function formatDelegationStepStatus(status: string): string {
  return status.replace(/_/g, " ");
}

function getDelegationStepTone(status: string): "active" | "success" | "warning" | "danger" | "neutral" {
  switch (status) {
    case "running":
      return "active";
    case "completed":
      return "success";
    case "failed":
      return "danger";
    case "cancelled":
    case "pending":
    case "skipped":
      return "warning";
    default:
      return "neutral";
  }
}

function getDelegationStepFallback(step: ChatDelegationStepView): string {
  if (step.error) {
    return "Needs attention; details include the status evidence.";
  }
  if (step.failureGuidance) {
    return step.failureGuidance;
  }
  switch (step.status) {
    case "running":
      return "Working.";
    case "pending":
      return "Queued.";
    case "completed":
      return step.output ? "Output ready." : "Completed.";
    case "skipped":
      return "Skipped.";
    case "cancelled":
      return "Cancelled.";
    case "failed":
      return "Failed.";
    default:
      return "Status recorded.";
  }
}

function getDelegationStepSummary(step: ChatDelegationStepView): string {
  return step.summary?.trim() || getDelegationStepFallback(step);
}

function buildDelegationRunChips(delegationRun: ChatDelegationRunView): string[] {
  const chips: string[] = [];
  if (delegationRun.runId) {
    chips.push(`Run ${formatCompactEvidenceId(delegationRun.runId)}`);
  }
  if (delegationRun.executionPlanId) {
    chips.push(`Plan ${formatCompactEvidenceId(delegationRun.executionPlanId)}`);
  }
  if (delegationRun.taskId) {
    chips.push(`Task ${formatCompactEvidenceId(delegationRun.taskId)}`);
  }
  if (delegationRun.steps.some((step) => (step.degradedHandoffStepIds?.length ?? 0) > 0)) {
    chips.push("handoff fallback");
  }
  if (delegationRun.stitchedOutput) {
    chips.push("synthesis");
  }
  return chips;
}

function ChatDelegationSubagentRows({
  steps,
  formatStepLabel,
  onOpenStepDetails,
  maxVisible = 4,
}: {
  steps: ChatDelegationStepView[];
  formatStepLabel: (step: ChatDelegationStepView) => string;
  onOpenStepDetails?: (turnId: string) => void;
  maxVisible?: number;
}) {
  if (steps.length === 0) {
    return null;
  }
  const visibleSteps = steps.slice(0, maxVisible);
  const hiddenCount = steps.length - visibleSteps.length;
  return (
    <div className="mc-next-thread-subagent-rows" aria-label="Subagent activity for this delegation">
      {visibleSteps.map((step) => {
        const duration = formatStepDuration(step);
        return (
          <div key={step.stepId} className={`mc-next-thread-subagent-row tone-${getDelegationStepTone(step.status)}`}>
            <span className="mc-next-thread-subagent-status">{formatDelegationStepStatus(step.status)}</span>
            <span className="mc-next-thread-subagent-name">{formatStepLabel(step)}</span>
            <span className="mc-next-thread-subagent-summary">{getDelegationStepSummary(step)}</span>
            {step.childTurnId ? (
              <span className="mc-next-thread-subagent-chip">Turn {formatCompactEvidenceId(step.childTurnId)}</span>
            ) : step.childSessionId ? (
              <span className="mc-next-thread-subagent-chip">
                Session {formatCompactEvidenceId(step.childSessionId)}
              </span>
            ) : step.durableRunId ? (
              <span className="mc-next-thread-subagent-chip">Durable {formatCompactEvidenceId(step.durableRunId)}</span>
            ) : null}
            {duration ? <span className="mc-next-thread-subagent-time">{duration}</span> : null}
            {step.childTurnId && onOpenStepDetails ? (
              <button
                type="button"
                className="mc-next-thread-inline-button"
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  onOpenStepDetails(step.childTurnId!);
                }}
              >
                Open messages
              </button>
            ) : null}
          </div>
        );
      })}
      {hiddenCount > 0 ? <span className="mc-next-thread-subagent-more">+{hiddenCount} subagents</span> : null}
    </div>
  );
}

function ChatDelegationStepEvidence({
  step,
  formatStepLabel,
  onOpenStepDetails,
}: {
  step: ChatDelegationStepView;
  formatStepLabel: (step: ChatDelegationStepView) => string;
  onOpenStepDetails?: (turnId: string) => void;
}) {
  const duration = formatStepDuration(step);
  const evidenceItems = [
    step.runId ? ["Run", step.runId] : null,
    step.durableRunId ? ["Durable", step.durableRunId] : null,
    step.childSessionId ? ["Child session", step.childSessionId] : null,
    step.childTurnId ? ["Child turn", step.childTurnId] : null,
    step.startedAt ? ["Started", formatActorTimestamp(step.startedAt)] : null,
    step.finishedAt ? ["Finished", formatActorTimestamp(step.finishedAt)] : null,
    duration ? ["Duration", duration] : null,
    (step.degradedHandoffStepIds?.length ?? 0) > 0 ? ["Fallback from", step.degradedHandoffStepIds!.join(", ")] : null,
  ].filter((item): item is [string, string] => Boolean(item));

  return (
    <li>
      <div className="mc-next-thread-step-head">
        <strong>{formatStepLabel(step)}</strong>
        <span data-tone={getDelegationStepTone(step.status)}>{formatDelegationStepStatus(step.status)}</span>
      </div>
      {evidenceItems.length > 0 ? (
        <dl className="mc-next-thread-subagent-evidence-grid">
          {evidenceItems.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {step.summary ? <p>{step.summary}</p> : null}
      {step.failureGuidance ? <p>{step.failureGuidance}</p> : null}
      {step.error ? <p>{step.error}</p> : null}
      {step.childTurnId && onOpenStepDetails ? (
        <button
          type="button"
          className="mc-next-thread-inline-button"
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            onOpenStepDetails(step.childTurnId!);
          }}
        >
          Open child messages
        </button>
      ) : null}
      {step.output ? (
        <details className="mc-next-thread-step-output-details">
          <summary>Show subagent output</summary>
          <AssistantMessageRenderer role="assistant" content={step.output} className="mc-next-thread-step-output" />
        </details>
      ) : null}
    </li>
  );
}

export function ChatThreadDelegationSummary({
  delegationRun,
  mode,
  onOpenRunDetails,
}: {
  delegationRun: ChatDelegationRunView | null;
  mode: ChatMode;
  onOpenRunDetails: (turnId: string) => void;
}) {
  const [coworkExpanded, setCoworkExpanded] = useState(false);
  if (!delegationRun) {
    return null;
  }
  const { completedCount, failedCount, pendingCount, skippedCount, runningCount, currentStep } =
    summarizeDelegationSteps(delegationRun.steps);
  const isCowork = mode === "cowork";
  const formatStepLabel = (step: ChatDelegationStepView) => step.label?.trim() || toTitleCase(step.role);
  const countsLine = `Completed ${completedCount} · Running ${runningCount} · Pending ${pendingCount} · Failed ${failedCount} · Skipped ${skippedCount}`;
  const runChips = buildDelegationRunChips(delegationRun);

  if (isCowork) {
    return (
      <section className="mc-next-thread-turn delegation compact">
        <details open={coworkExpanded} onToggle={(event) => setCoworkExpanded(event.currentTarget.open)}>
          <summary>
            <div className="mc-next-thread-strip">
              <PrimitiveStatusChip tone={getDelegationStatusTone(delegationRun.status)}>
                {delegationRun.status}
              </PrimitiveStatusChip>
              <span>Agentic activity</span>
              <span>{countsLine}</span>
              {currentStep ? <span>Now: {formatStepLabel(currentStep)}</span> : null}
              {runChips.map((chip) => (
                <span key={chip} className="mc-next-thread-activity-chip">
                  {chip}
                </span>
              ))}
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
            <ChatDelegationSubagentRows
              steps={delegationRun.steps}
              formatStepLabel={formatStepLabel}
              onOpenStepDetails={onOpenRunDetails}
            />
          </summary>
          <div className="mc-next-thread-bubble assistant">
            <p className="mc-next-thread-meta">
              <strong>{delegationRun.label}</strong> · {delegationRun.mode}
            </p>
            <p>{delegationRun.objective}</p>
            <ol className="mc-next-thread-step-list">
              {delegationRun.steps.map((step) => (
                <ChatDelegationStepEvidence
                  key={step.stepId}
                  step={step}
                  formatStepLabel={formatStepLabel}
                  onOpenStepDetails={onOpenRunDetails}
                />
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
        <PrimitiveStatusChip tone={getDelegationStatusTone(delegationRun.status)}>
          {delegationRun.status}
        </PrimitiveStatusChip>
        <span>Delegation run</span>
        {delegationRun.runId ? <span>{delegationRun.runId}</span> : null}
        {delegationRun.executionPlanId ? <span>Plan {delegationRun.executionPlanId}</span> : null}
        {delegationRun.taskId ? <span>Task {delegationRun.taskId}</span> : null}
      </div>
      <div className="mc-next-thread-bubble assistant">
        <p className="mc-next-thread-meta">
          <strong>{delegationRun.label}</strong> · {delegationRun.mode}
        </p>
        <p>{delegationRun.objective}</p>
        <p>
          Completed {completedCount} · Running {runningCount} · Pending {pendingCount} · Failed {failedCount} · Skipped{" "}
          {skippedCount}
        </p>
        <ol className="mc-next-thread-step-list">
          {delegationRun.steps.map((step) => (
            <ChatDelegationStepEvidence
              key={step.stepId}
              step={step}
              formatStepLabel={formatStepLabel}
              onOpenStepDetails={onOpenRunDetails}
            />
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

export interface ChatThreadTurnCardProps {
  mode: ChatMode;
  turn: ChatThreadTurnRecord;
  selected: boolean;
  contextSelected?: boolean;
  groupedWithPrevious?: boolean;
  streamingPreview?: ChatStreamingPreview | null;
  visualStreamMode?: AssistantStreamPresentationMode;
  renderUserMetaAddon?: (turn: ChatThreadTurnRecord) => ReactNode;
  renderCitationList?: (turn: ChatThreadTurnRecord) => ReactNode;
  onToggleContextTurn?: (turnId: string) => void;
  onSelectTurn: (turnId: string) => void;
  onStartNewThreadFromTurn?: (turnId: string) => void;
  onSwitchBranch: (turnId: string) => void;
  onRetryTurn: (turnId: string) => void;
  onEditTurn?: (turnId: string) => void;
  onOpenRunDetails: (turnId: string) => void;
  onOpenUniversalRunDetail?: (runId: string) => void;
  onOpenGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifact: (turnId: string) => void;
  onCreateGeneratedArtifactVersion: (turnId: string) => void;
  /**
   * Stops the currently streaming turn (server-side cancel; see the mirror of the
   * composer's "Stop turn" affordance surfaced by {@link ChatLiveActivityRail}). The card
   * forwards this to the rail only when THIS card's turn is the one streaming — see
   * `isStreamingTurn` below — so a card that is merely "active" (queued/running but not
   * the live streaming turn) never renders a Stop control for someone else's turn.
   */
  onStopStreamingTurn?: () => void;
}

export const ChatThreadTurnCard = memo(function ChatThreadTurnCard({
  mode,
  turn,
  selected,
  contextSelected = false,
  groupedWithPrevious = false,
  streamingPreview,
  visualStreamMode = "smooth",
  renderUserMetaAddon,
  renderCitationList,
  onToggleContextTurn,
  onSelectTurn,
  onStartNewThreadFromTurn,
  onSwitchBranch,
  onRetryTurn,
  onEditTurn,
  onOpenRunDetails,
  onOpenUniversalRunDetail,
  onOpenGeneratedArtifact,
  onCreateGeneratedArtifact,
  onCreateGeneratedArtifactVersion,
  onStopStreamingTurn,
}: ChatThreadTurnCardProps) {
  const suggestionSummary = renderSuggestionSummary(turn.trace.capabilityUpgradeSuggestions);
  const recoveryLabel = getRecoveryStripLabel(turn);
  const routingSummary = summarizeTurnRouting(turn, { effectiveVerb: "used" });
  const hasGeneratedArtifact = (turn.generatedArtifacts?.length ?? 0) > 0;
  const durableRunId = turn.trace.durable?.runId;
  const isStreamingTurn = Boolean(streamingPreview?.isRunning && streamingPreview.turnId === turn.turnId);
  // The live activity rail owns rendering tool runs while the turn is in
  // flight; TurnEvidenceSummary's ChatTurnActivityRows takes back over the
  // instant the trace settles, in the same commit the rail unmounts (see
  // suppressActivityRows below) so rows never render in two places at once.
  const showLiveActivity = isStreamingTurn || isChatTurnActiveStatus(turn.trace.status);
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
  const showContextToggle = Boolean(onToggleContextTurn);
  const hasRetryAction = canRetryTurn(turn);
  const hasStartNewThreadAction = Boolean(onStartNewThreadFromTurn);
  const hasEditAction = Boolean(onEditTurn);
  const hasGeneratedArtifactAction = Boolean(turn.assistantMessage);
  const hasGeneratedArtifactVersionAction = hasGeneratedArtifact;
  const showActionMenu =
    hasRetryAction ||
    hasStartNewThreadAction ||
    hasEditAction ||
    hasGeneratedArtifactAction ||
    hasGeneratedArtifactVersionAction;
  const showBranchSwitcher = turn.branch.siblingCount > 1;
  const showActions = showActionMenu || showBranchSwitcher || Boolean(suggestionSummary);
  const showOperationalDetails =
    !isPlainChat ||
    isStreamingTurn ||
    turn.trace.status !== "completed" ||
    turnHasRepairedAssistantOutput(turn) ||
    turn.trace.routing.fallbackUsed ||
    Boolean(turn.trace.failure) ||
    Boolean(turn.trace.orchestration) ||
    turn.toolRuns.length > 0 ||
    turn.citations.length > 0 ||
    Boolean(durableRunId) ||
    Boolean(turn.trace.guidance?.truncated) ||
    hasGeneratedArtifact;
  const evidenceExpandedByDefault =
    !isPlainChat ||
    isStreamingTurn ||
    turn.trace.status !== "completed" ||
    turnHasRepairedAssistantOutput(turn) ||
    turn.trace.routing.fallbackUsed ||
    Boolean(turn.trace.failure) ||
    Boolean(turn.trace.orchestration) ||
    Boolean(durableRunId) ||
    Boolean(turn.trace.guidance?.truncated) ||
    hasGeneratedArtifact;
  const isRoutineChatTurn = isPlainChat && !showOperationalDetails;
  const citationList = renderCitationList?.(turn);
  const turnClassName = [
    "mc-next-thread-turn",
    selected ? "selected" : "",
    contextSelected ? "context-pinned" : "",
    isStreamingTurn ? "streaming" : "",
    isRoutineChatTurn ? "routine-chat" : "",
    groupedWithPrevious ? "grouped" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const turnLabel = turn.userMessage.content?.trim().slice(0, 60) || "turn";

  return (
    <article className={turnClassName}>
      <div
        className="mc-next-thread-turn-surface"
        role="button"
        tabIndex={0}
        aria-pressed={selected}
        aria-label={`Open turn: ${turnLabel}`}
        onClick={(event: ReactMouseEvent<HTMLDivElement>) => {
          if (!isInteractiveChatEventTarget(event.target, event.currentTarget)) {
            onSelectTurn(turn.turnId);
          }
        }}
        onKeyDown={(event) => handleTurnSurfaceKeyDown(event, turn.turnId, onSelectTurn)}
      >
        <div className="mc-next-thread-bubble user">
          <p className="mc-next-thread-meta">
            <strong>You</strong> · <ActorTimestamp timestamp={turn.userMessage.timestamp} />
            {renderUserMetaAddon?.(turn)}
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
          <ChatThinkingSection thinking={turn.thinking} turnStatus={turn.trace.status} />
          {showLiveActivity ? (
            <ChatLiveActivityRail
              turn={turn}
              hasVisibleAssistantText={hasAssistantOutput}
              onOpenRunDetails={onOpenRunDetails}
              onStopStreamingTurn={isStreamingTurn ? onStopStreamingTurn : undefined}
            />
          ) : null}
          {hasAssistantOutput ? (
            <AssistantMessageRenderer
              role="assistant"
              content={assistantContent}
              running={isStreamingTurn}
              streamPresentationMode={visualStreamMode}
              streamTurnId={turn.turnId}
            />
          ) : isStreamingTurn ? (
            <StreamingAssistantSkeleton label={assistantPendingLabel} />
          ) : (
            <p>{assistantPendingLabel}</p>
          )}
        </div>
      </div>
      <TurnEvidenceSummary
        mode={mode}
        turn={turn}
        recoveryLabel={recoveryLabel}
        routingSummary={routingSummary}
        durableRunId={durableRunId}
        citationList={citationList}
        contextSelected={contextSelected}
        showContextToggle={showContextToggle}
        showOperationalDetails={showOperationalDetails}
        expandedByDefault={evidenceExpandedByDefault}
        suppressActivityRows={showLiveActivity}
        onToggleContextTurn={onToggleContextTurn}
        onOpenRunDetails={onOpenRunDetails}
        onOpenUniversalRunDetail={onOpenUniversalRunDetail}
      />
      {showActions ? (
        <div className="mc-next-thread-actions">
          {showActionMenu ? (
            <details className="mc-next-thread-action-menu">
              <summary className="mc-next-thread-inline-button mc-next-thread-action-menu-summary">Actions</summary>
              <div className="mc-next-thread-action-menu-body">
                <div className="mc-next-thread-action-row">
                  {hasRetryAction ? (
                    <button
                      type="button"
                      className="mc-next-thread-inline-button"
                      aria-label={`Retry assistant answer for turn ${turn.turnId}`}
                      onClick={() => onRetryTurn(turn.turnId)}
                    >
                      {mode === "cowork" ? "Retry run step" : "Retry"}
                    </button>
                  ) : null}
                  {hasStartNewThreadAction ? (
                    <button
                      type="button"
                      className="mc-next-thread-inline-button"
                      aria-label={`Start a new thread from turn ${turn.turnId}`}
                      disabled={isStreamingTurn}
                      onClick={() => onStartNewThreadFromTurn?.(turn.turnId)}
                    >
                      Start new thread
                    </button>
                  ) : null}
                  {hasEditAction ? (
                    <button
                      type="button"
                      className="mc-next-thread-inline-button"
                      aria-label={`Edit and resend turn ${turn.turnId}`}
                      disabled={isStreamingTurn}
                      onClick={() => onEditTurn?.(turn.turnId)}
                    >
                      Edit and resend
                    </button>
                  ) : null}
                  {hasGeneratedArtifactAction ? (
                    <button
                      type="button"
                      className="mc-next-thread-inline-button"
                      aria-label={`${hasGeneratedArtifact ? "Open" : "Create"} generated artifact for turn ${turn.turnId}`}
                      onClick={() =>
                        hasGeneratedArtifact
                          ? onOpenGeneratedArtifact(turn.turnId)
                          : onCreateGeneratedArtifact(turn.turnId)
                      }
                    >
                      {hasGeneratedArtifact ? "Open saved answer" : "Save answer"}
                    </button>
                  ) : null}
                  {hasGeneratedArtifactVersionAction ? (
                    <button
                      type="button"
                      className="mc-next-thread-inline-button"
                      aria-label={`Create a new artifact version for turn ${turn.turnId}`}
                      onClick={() => onCreateGeneratedArtifactVersion(turn.turnId)}
                    >
                      Save new version
                    </button>
                  ) : null}
                </div>
              </div>
            </details>
          ) : null}
          {showBranchSwitcher ? <ChatThreadBranchSwitcher turn={turn} onSwitch={onSwitchBranch} /> : null}
          {suggestionSummary ? <p className="mc-next-thread-note">Suggested next move: {suggestionSummary}</p> : null}
        </div>
      ) : null}
    </article>
  );
});
