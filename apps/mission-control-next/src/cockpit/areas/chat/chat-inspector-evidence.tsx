import type { ChatCitationRecord, ChatThreadTurnRecord } from "@goatcitadel/contracts";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { StatusBadge } from "../../ui/StatusBadge";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
export function statusTone(status: string): "running" | "waiting" | "done" | "failed" | "neutral" {
  if (status === "running" || status === "started" || status === "streaming") return "running";
  if (status === "waiting" || status === "approval_required" || status === "blocked" || status === "paused")
    return "waiting";
  if (status === "completed" || status === "done" || status === "executed") return "done";
  if (status === "failed" || status === "cancelled") return "failed";
  return "neutral";
}

export function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex justify-between gap-3 border-b border-line-subtle py-2 text-sm">
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 text-right text-fg-secondary wrap-anywhere">{value}</dd>
    </div>
  );
}

function safeSourceHref(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

export function SourcesPanel({ turn }: { turn: ChatThreadTurnRecord | undefined }) {
  if (!turn) return <p className="text-sm text-fg-muted">Select a response to inspect its sources.</p>;
  if (!turn.citations.length)
    return <p className="text-sm text-fg-muted">No sources were recorded for this response.</p>;
  return (
    <ol className="space-y-2">
      {turn.citations.map((source: ChatCitationRecord) => {
        const href = safeSourceHref(source.url);
        return (
          <li key={source.citationId} className="rounded-md border border-line bg-raised p-3 text-sm">
            <p className="mb-1 text-xs text-fg-muted">
              {source.sourceType ? humanizeToken(source.sourceType) : "Source"}
            </p>
            {href ? (
              <a
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                className="font-medium text-accent underline-offset-2 hover:underline"
              >
                {source.title || "Open source"}
              </a>
            ) : (
              <span className="font-medium text-fg">{source.title || "Source"}</span>
            )}
            {source.snippet ? <p className="mt-2 text-fg-secondary">{source.snippet}</p> : null}
          </li>
        );
      })}
    </ol>
  );
}

export function renderInspectorRunEvidence(
  run: NonNullable<MissionThreadedRenderSurfaceInput["activeSessionSurfaceProps"]>["delegationRun"] | null,
  selectedTurn: ChatThreadTurnRecord | undefined,
) {
  return run ? (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="font-display text-md font-semibold text-fg">{run.label}</h3>
        <StatusBadge status={{ label: humanizeToken(run.status), tone: statusTone(run.status) }} />
      </div>
      <p className="text-sm text-fg-secondary">{run.objective}</p>
      <ol className="space-y-2">
        {run.steps.map((step) => (
          <li key={step.stepId} className="rounded-md border border-line bg-raised p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-fg">{step.label ?? `Step ${step.index + 1}`}</span>
              <StatusBadge status={{ label: humanizeToken(step.status), tone: statusTone(step.status) }} />
            </div>
            {step.summary ? <p className="mt-1 text-sm text-fg-secondary">{step.summary}</p> : null}
            {step.error ? <p className="mt-1 text-sm text-status-failed">{step.error}</p> : null}
            {step.output ? (
              <details className="mt-2 text-sm text-fg-secondary">
                <summary className="cursor-pointer text-accent">Recorded output</summary>
                <div className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap wrap-anywhere">{step.output}</div>
              </details>
            ) : null}
          </li>
        ))}
      </ol>
      {selectedTurn?.trace.durable?.runId ? (
        <NativeOwnerLink
          scope={[selectedTurn.trace.sessionId, selectedTurn.turnId, selectedTurn.trace.durable.runId]}
          className="text-sm font-medium text-accent hover:underline"
          href={`/work/runs/${encodeURIComponent(selectedTurn.trace.durable.runId)}`}
        >
          Open durable evidence
        </NativeOwnerLink>
      ) : (
        <p className="text-xs text-fg-muted">No background run is recorded for this response.</p>
      )}
    </div>
  ) : (
    <div className="space-y-2 text-sm text-fg-muted">
      <p>No delegated work is linked to this response.</p>
      {selectedTurn?.trace.durable?.runId ? (
        <NativeOwnerLink
          scope={[selectedTurn.trace.sessionId, selectedTurn.turnId, selectedTurn.trace.durable.runId]}
          className="font-medium text-accent hover:underline"
          href={`/work/runs/${encodeURIComponent(selectedTurn.trace.durable.runId)}`}
        >
          Open durable evidence
        </NativeOwnerLink>
      ) : null}
    </div>
  );
}

export type ChatInspectorTab = "run" | "turn" | "sources" | "context" | "files" | "thread" | "background";
export const TABS: readonly { id: ChatInspectorTab; label: string }[] = [
  { id: "run", label: "Run" },
  { id: "turn", label: "Message" },
  { id: "sources", label: "Sources" },
  { id: "context", label: "Context" },
  { id: "files", label: "Files" },
  { id: "thread", label: "Conversation" },
  { id: "background", label: "Background" },
];

export function inspectorFallbackLabel(selectedTurn: ChatThreadTurnRecord): string {
  return selectedTurn.trace.routing?.fallbackUsed
    ? [
        selectedTurn.trace.routing.fallbackProviderId,
        selectedTurn.trace.routing.fallbackModel,
        selectedTurn.trace.routing.fallbackReason,
      ]
        .filter(Boolean)
        .join(" · ") || "Used; destination not recorded"
    : "No fallback recorded";
}
