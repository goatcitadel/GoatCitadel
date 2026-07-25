import { useEffect, useState } from "react";
import {
  isChatTurnActiveStatus,
  type ChatMode,
  type ChatThreadTurnRecord,
  type ChatToolRunRecord,
  type ChatTurnLifecycleStatus,
} from "@goatcitadel/contracts";
import { getChatToolRunDiagnostics } from "./chat-tool-diagnostics";
import { projectChatToolEffectTruth } from "./chat-tool-effect-truth";
import { parseTimestamp } from "./chat-display-helpers";

export function ChatTurnActivityRows({
  mode,
  toolRuns,
  onOpenRunDetails,
}: {
  mode: ChatMode;
  toolRuns: ChatThreadTurnRecord["toolRuns"];
  onOpenRunDetails: () => void;
}) {
  if (toolRuns.length === 0) {
    return null;
  }

  const visibleRuns = mode === "chat" ? toolRuns.slice(0, 3) : toolRuns.slice(0, 6);
  const hiddenCount = toolRuns.length - visibleRuns.length;

  return (
    <div className="mc-next-thread-tool-activity" aria-label="Tool activity for this turn">
      {visibleRuns.map((run) => {
        const diagnostics = getChatToolRunDiagnostics(run);
        const effectTruth = projectChatToolEffectTruth(run);
        const tone = getToolRunActivityTone(run.status, diagnostics.hasFailureSignal);
        const operationalSummary =
          diagnostics.summary ??
          diagnostics.artifactSummary ??
          diagnostics.engineLabel ??
          run.failureGuidance ??
          getToolRunActivityFallback(run.status);
        const summary = effectTruth
          ? effectTruth.tone === "uncertain"
            ? `${effectTruth.summary} ${operationalSummary}`
            : `${operationalSummary} ${effectTruth.summary}`
          : operationalSummary;
        const elapsed = formatToolRunElapsed(run.startedAt, run.finishedAt);

        return (
          <button
            key={run.toolRunId}
            type="button"
            className={`mc-next-thread-tool-activity-row tone-${tone}`}
            onClick={onOpenRunDetails}
            aria-label={`Open execution detail for ${run.toolName}`}
          >
            <span className="mc-next-thread-tool-activity-status">{formatToolRunStatus(run.status)}</span>
            <span className="mc-next-thread-tool-activity-name">{run.toolName}</span>
            <span className="mc-next-thread-tool-activity-summary" title={summary}>
              {summary}
            </span>
            {effectTruth?.tone === "uncertain" ? (
              <span className="mc-next-thread-tool-activity-badge">effect uncertain</span>
            ) : null}
            {diagnostics.storedAsArtifact ? <span className="mc-next-thread-tool-activity-badge">artifact</span> : null}
            {run.approvalId ? <span className="mc-next-thread-tool-activity-badge">approval</span> : null}
            {elapsed ? <span className="mc-next-thread-tool-activity-elapsed">{elapsed}</span> : null}
          </button>
        );
      })}
      {hiddenCount > 0 ? (
        <button
          type="button"
          className="mc-next-thread-tool-activity-more"
          onClick={onOpenRunDetails}
          aria-label={`Open execution detail for ${hiddenCount} more tool runs`}
        >
          +{hiddenCount} more
        </button>
      ) : null}
    </div>
  );
}

function getToolRunActivityTone(
  status: ChatThreadTurnRecord["toolRuns"][number]["status"],
  hasFailureSignal: boolean,
): "active" | "success" | "warning" | "danger" | "neutral" {
  if (hasFailureSignal || status === "failed") {
    return "danger";
  }
  if (status === "blocked" || status === "approval_required") {
    return "warning";
  }
  if (status === "started") {
    return "active";
  }
  if (status === "executed") {
    return "success";
  }
  return "neutral";
}

function formatToolRunStatus(status: ChatThreadTurnRecord["toolRuns"][number]["status"]): string {
  switch (status) {
    case "approval_required":
      return "approval";
    case "executed":
      return "done";
    default:
      return status.replace(/_/g, " ");
  }
}

function getToolRunActivityFallback(status: ChatThreadTurnRecord["toolRuns"][number]["status"]): string {
  switch (status) {
    case "approval_required":
      return "Waiting for operator approval.";
    case "blocked":
      return "Blocked by policy or runtime guard.";
    case "failed":
      return "Tool failed; open details for evidence.";
    case "started":
      return "Tool is running.";
    case "executed":
    default:
      return "Tool completed.";
  }
}

export function formatToolRunElapsed(startedAt: string, finishedAt?: string): string | undefined {
  const started = parseTimestamp(startedAt);
  const finished = finishedAt ? parseTimestamp(finishedAt) : null;
  if (started === null || finished === null || finished < started) {
    return undefined;
  }
  const elapsedMs = finished - started;
  if (elapsedMs < 1000) {
    return `${Math.max(1, Math.round(elapsedMs))} ms`;
  }
  return `${(elapsedMs / 1000).toFixed(elapsedMs < 10_000 ? 1 : 0)} s`;
}

/**
 * Live counterpart to {@link formatToolRunElapsed} for a run that has not
 * settled yet: formats elapsed time against a caller-supplied `nowMs` (a
 * ticking clock) instead of a `finishedAt` timestamp.
 */
export function formatToolRunElapsedLive(startedAt: string, nowMs: number): string | undefined {
  const started = parseTimestamp(startedAt);
  if (started === null || nowMs < started) {
    return undefined;
  }
  const elapsedMs = nowMs - started;
  if (elapsedMs < 1000) {
    return `${Math.max(1, Math.round(elapsedMs))} ms`;
  }
  return `${(elapsedMs / 1000).toFixed(elapsedMs < 10_000 ? 1 : 0)} s`;
}

/**
 * Live-activity phase shown while a turn is running and there is nothing
 * more specific to show yet (no active tool row, no visible assistant text).
 * `null` means the rail should defer to a tool row or the streaming text
 * itself — there is nothing distinct for the phase row to add.
 */
export type ChatLiveActivityPhase =
  | { kind: "thinking" }
  | { kind: "working" }
  | { kind: "waiting_approval" }
  | { kind: "waiting_input" }
  | null;

const LIVE_ACTIVITY_PHASE_LABELS: Record<Exclude<ChatLiveActivityPhase, null>["kind"], string> = {
  thinking: "Thinking…",
  working: "Working…",
  waiting_approval: "Waiting for approval…",
  waiting_input: "Waiting for your answer…",
};

export function deriveLiveActivityPhase(input: {
  traceStatus: ChatTurnLifecycleStatus;
  toolRuns: ChatToolRunRecord[];
  hasVisibleAssistantText: boolean;
}): ChatLiveActivityPhase {
  if (input.hasVisibleAssistantText) {
    return null;
  }
  if (input.traceStatus === "waiting_for_approval") {
    return { kind: "waiting_approval" };
  }
  if (input.traceStatus === "waiting_for_user_input") {
    return { kind: "waiting_input" };
  }
  if (!isChatTurnActiveStatus(input.traceStatus)) {
    return null;
  }
  const hasRunningTool = input.toolRuns.some((run) => run.status === "started");
  if (hasRunningTool) {
    return null;
  }
  return input.toolRuns.length === 0 ? { kind: "thinking" } : { kind: "working" };
}

function getLiveActivityGlyphTone(
  run: ChatToolRunRecord,
  hasFailureSignal: boolean,
): "active" | "success" | "warning" | "danger" {
  if (hasFailureSignal || run.status === "failed" || run.status === "blocked") {
    return "danger";
  }
  if (run.status === "approval_required") {
    return "warning";
  }
  if (run.status === "started") {
    return "active";
  }
  return "success";
}

function LiveActivityRowGlyph({ run, hasFailureSignal }: { run: ChatToolRunRecord; hasFailureSignal: boolean }) {
  const tone = getLiveActivityGlyphTone(run, hasFailureSignal);
  if (run.status === "started") {
    return (
      <span className={`mc-next-live-activity-glyph tone-${tone}`}>
        <span className="mc-next-live-activity-spinner" aria-hidden="true" />
      </span>
    );
  }
  if (tone === "danger") {
    return (
      <span className={`mc-next-live-activity-glyph tone-${tone}`} aria-hidden="true">
        ✕
      </span>
    );
  }
  if (tone === "warning") {
    return (
      <span className={`mc-next-live-activity-glyph tone-${tone}`} aria-hidden="true">
        ⏸
      </span>
    );
  }
  return (
    <span className={`mc-next-live-activity-glyph tone-${tone}`} aria-hidden="true">
      ✓
    </span>
  );
}

function LiveActivityRow({
  run,
  nowMs,
  onOpenRunDetails,
}: {
  run: ChatToolRunRecord;
  nowMs: number;
  onOpenRunDetails: () => void;
}) {
  const diagnostics = getChatToolRunDiagnostics(run);
  const effectTruth = projectChatToolEffectTruth(run);
  const operationalSummary =
    diagnostics.summary ??
    diagnostics.artifactSummary ??
    diagnostics.engineLabel ??
    run.failureGuidance ??
    getToolRunActivityFallback(run.status);
  const summary =
    effectTruth?.tone === "uncertain" ? `${effectTruth.summary} ${operationalSummary}` : operationalSummary;
  const elapsed =
    run.status === "started"
      ? formatToolRunElapsedLive(run.startedAt, nowMs)
      : formatToolRunElapsed(run.startedAt, run.finishedAt);

  return (
    <button
      type="button"
      className="mc-next-live-activity-row"
      onClick={onOpenRunDetails}
      aria-label={`Open execution detail for ${run.toolName}`}
    >
      <LiveActivityRowGlyph run={run} hasFailureSignal={diagnostics.hasFailureSignal} />
      <span className="mc-next-live-activity-name">{run.toolName}</span>
      <span className="mc-next-live-activity-summary" title={summary}>
        {summary}
      </span>
      {elapsed ? <span className="mc-next-live-activity-elapsed">{elapsed}</span> : null}
    </button>
  );
}

/**
 * Live activity rail rendered inside the running assistant bubble while a
 * turn is in flight: compact rows for each tool run (spinner while active,
 * settled glyph once it finishes) plus a phase row for the in-between states
 * that have no tool or text of their own yet ("Thinking…", "Working…",
 * approval/input waits). Collapses to nothing once the caller stops mounting
 * it (the card unmounts the rail itself when the turn settles).
 *
 * Carries NO aria-live / role="status" — the single owning live region per
 * surface already announces streaming activity (see the comment on
 * StreamingAssistantSkeleton in ChatThreadPrimitives.tsx); duplicating that
 * here would double-announce to screen readers.
 */
export function ChatLiveActivityRail({
  turn,
  hasVisibleAssistantText,
  onOpenRunDetails,
  onStopStreamingTurn,
  maxVisible = 4,
}: {
  turn: ChatThreadTurnRecord;
  hasVisibleAssistantText: boolean;
  onOpenRunDetails: (turnId: string) => void;
  onStopStreamingTurn?: () => void;
  maxVisible?: number;
}) {
  const hasRunningTool = turn.toolRuns.some((run) => run.status === "started");
  const [nowMs, setNowMs] = useState(() => Date.now());
  // Local-only: the rail unmounts the instant the trace flips to a terminal status
  // (including `cancelled`, which is NOT in CHAT_TURN_ACTIVE_STATUSES — see
  // showLiveActivity in ChatThreadPrimitives.tsx), so there is no stale "Stopping…"
  // state to reset once the server confirms the cancel.
  const [stopping, setStopping] = useState(false);

  // The ticking clock only needs to exist while a row is actively running —
  // once every run has settled, there is nothing left for it to animate, so
  // the interval is not mounted (and is torn down the instant the last
  // running row settles, since `hasRunningTool` flips and this effect
  // re-runs its cleanup).
  useEffect(() => {
    if (!hasRunningTool) {
      return;
    }
    const intervalId = setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => clearInterval(intervalId);
  }, [hasRunningTool]);

  const phase = deriveLiveActivityPhase({
    traceStatus: turn.trace.status,
    toolRuns: turn.toolRuns,
    hasVisibleAssistantText,
  });

  if (turn.toolRuns.length === 0 && !phase) {
    return null;
  }

  const visibleRuns = turn.toolRuns.length > maxVisible ? turn.toolRuns.slice(-maxVisible) : turn.toolRuns;
  const hiddenCount = turn.toolRuns.length - visibleRuns.length;
  const handleOpenRunDetails = () => onOpenRunDetails(turn.turnId);

  return (
    <div className="mc-next-live-activity" aria-label="Live activity for this response">
      {hiddenCount > 0 ? <span className="mc-next-live-activity-more">+{hiddenCount} earlier steps</span> : null}
      {visibleRuns.map((run) => (
        <LiveActivityRow key={run.toolRunId} run={run} nowMs={nowMs} onOpenRunDetails={handleOpenRunDetails} />
      ))}
      {phase ? (
        <span className="mc-next-live-activity-phase">
          <span className="mc-next-live-activity-spinner" aria-hidden="true" />
          {LIVE_ACTIVITY_PHASE_LABELS[phase.kind]}
        </span>
      ) : null}
      {onStopStreamingTurn ? (
        <button
          type="button"
          className="mc-next-live-activity-stop mc-next-thread-inline-button"
          aria-label="Stop generating this response"
          title="Stop generating (Esc). Partial output is kept; actions already started may still finish."
          onClick={() => {
            setStopping(true);
            onStopStreamingTurn();
          }}
          disabled={stopping}
        >
          <span aria-hidden="true">■</span> {stopping ? "Stopping…" : "Stop"}
        </button>
      ) : null}
    </div>
  );
}
