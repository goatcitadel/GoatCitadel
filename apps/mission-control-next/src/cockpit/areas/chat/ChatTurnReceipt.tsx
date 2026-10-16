import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { presentChatTurnStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { formatDuration, plural } from "@goatcitadel/mission-control-shared/content/format";
import { useInspector } from "../../app/inspector";
import { useModelLabel } from "../../data/use-model-label";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { recordedCostLabel } from "./recorded-cost";

/** The compact model, tools, sources, latency and cost receipt under a completed answer; opens full message details. */
export function TurnReceipt({ turn }: { turn: ChatThreadTurnRecord }) {
  const { open } = useInspector();
  const usage = turn.trace.completion?.usage;
  const providerId = turn.trace.routing?.effectiveProviderId;
  const modelId = turn.trace.routing?.effectiveModel ?? turn.trace.model;
  const modelLabel = useModelLabel(providerId, modelId, Boolean(modelId));
  const status = presentChatTurnStatus(turn.trace.status).label;
  const details = [
    modelId ? modelLabel : null,
    turn.toolRuns.length ? plural(turn.toolRuns.length, "tool") : null,
    turn.citations.length ? plural(turn.citations.length, "source") : null,
    turn.trace.completion?.latencyMs ? formatDuration(turn.trace.completion.latencyMs) : null,
    usage?.costUsd !== undefined ? `Cost ${recordedCostLabel(usage.costUsd, usage.costSource)}` : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <button
      type="button"
      onClick={() =>
        open({
          title: "Message details",
          body: (
            <div className="space-y-3 text-sm text-fg-secondary">
              <p>Status: {status}</p>
              <p>Model: {modelId ? modelLabel : "Not recorded"}</p>
              <p>Tools: {turn.toolRuns.length}</p>
              <p>Sources: {turn.citations.length}</p>
              <p>Cost: {recordedCostLabel(usage?.costUsd, usage?.costSource)}</p>
              {turn.citations.length ? (
                <ul className="space-y-1">
                  {turn.citations.map((source) => (
                    <li key={source.citationId}>{source.title ?? "Source"}</li>
                  ))}
                </ul>
              ) : null}
              {modelId || providerId ? (
                <TechnicalDetails label="Model technical details">
                  <p className="font-mono text-xs wrap-anywhere">
                    Provider ID: {providerId ?? "Not recorded"} · Model ID: {modelId ?? "Not recorded"}
                  </p>
                </TechnicalDetails>
              ) : null}
            </div>
          ),
        })
      }
      className="mt-2 inline-flex min-h-8 items-center text-left text-xs text-fg-muted hover:text-accent max-sm:min-h-11"
    >
      {details || status}
      {/* The name starts with the visible receipt (WCAG 2.5.3), then says what the button does. */}
      <span className="sr-only"> · Open message details</span>
    </button>
  );
}
