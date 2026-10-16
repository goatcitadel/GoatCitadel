import type { ChatCitationRecord, ChatThreadTurnRecord } from "@goatcitadel/contracts";
import type { MissionThreadedRenderSurfaceInput } from "@goatcitadel/threaded-surface-core";
import { StatusBadge } from "../../ui/StatusBadge";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { useModelLabel } from "../../data/use-model-label";
import { presentDelegationRunStatus, presentDelegationStepStatus, presentSourceType } from "./chat-vocabulary";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
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
    <ol className="divide-y divide-line-subtle">
      {turn.citations.map((source: ChatCitationRecord) => {
        const href = safeSourceHref(source.url);
        return (
          <li key={source.citationId} className="py-3 text-sm">
            <p className="mb-1 text-xs text-fg-muted">{presentSourceType(source.sourceType)}</p>
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
        <h3 className="text-md font-semibold text-fg">{run.label}</h3>
        <StatusBadge status={presentDelegationRunStatus(run.status)} />
      </div>
      <p className="text-sm text-fg-secondary">{run.objective}</p>
      <ol className="divide-y divide-line-subtle">
        {run.steps.map((step) => (
          <li key={step.stepId} className="py-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-sm font-medium text-fg">{step.label ?? `Step ${step.index + 1}`}</span>
              <StatusBadge status={presentDelegationStepStatus(step.status)} />
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
          Open run in Work
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
          Open run in Work
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

/** The catalog name of a recorded or selected model ("Claude Sonnet · Anthropic"); ids stay in technical details. */
export function ModelDetailRow({
  providerId,
  modelId,
  missing,
  label = "Model",
}: {
  providerId?: string | null;
  modelId?: string | null;
  missing: string;
  label?: string;
}) {
  const recorded = Boolean(providerId || modelId);
  const name = useModelLabel(providerId ?? undefined, modelId ?? undefined, recorded);
  return <DetailRow label={label} value={recorded ? name : missing} />;
}

export function ModelTechnicalDetails({
  providerId,
  modelId,
}: {
  providerId?: string | null;
  modelId?: string | null;
}) {
  if (!providerId && !modelId) return null;
  return (
    <TechnicalDetails label="Model technical details">
      <dl className="font-mono text-xs">
        <DetailRow label="Provider ID" value={providerId || "Not recorded"} />
        <DetailRow label="Model ID" value={modelId || "Not recorded"} />
      </dl>
    </TechnicalDetails>
  );
}

export function FallbackDetailRow({ turn }: { turn: ChatThreadTurnRecord }) {
  const routing = turn.trace.routing;
  const used = Boolean(routing?.fallbackUsed);
  const destination = Boolean(routing?.fallbackProviderId || routing?.fallbackModel);
  const name = useModelLabel(routing?.fallbackProviderId, routing?.fallbackModel, used && destination);
  const value = !used
    ? "No fallback recorded"
    : [destination ? name : null, routing?.fallbackReason].filter(Boolean).join(" · ") ||
      "Used; destination not recorded";
  return <DetailRow label="Fallback" value={value} />;
}
