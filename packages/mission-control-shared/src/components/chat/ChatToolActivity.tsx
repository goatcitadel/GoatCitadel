import type { ChatMode, ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { getChatToolRunDiagnostics } from "./chat-tool-diagnostics";
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
        const tone = getToolRunActivityTone(run.status, diagnostics.hasFailureSignal);
        const summary =
          diagnostics.summary ??
          diagnostics.artifactSummary ??
          diagnostics.engineLabel ??
          run.failureGuidance ??
          getToolRunActivityFallback(run.status);
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
            <span className="mc-next-thread-tool-activity-summary">{summary}</span>
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
