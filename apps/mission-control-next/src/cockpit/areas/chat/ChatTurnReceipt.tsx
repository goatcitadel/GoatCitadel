import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { humanizeToken } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { useInspector } from "../../app/inspector";
import { recordedCostLabel } from "./recorded-cost";

/** The compact model, tools, sources, latency and cost receipt under a completed answer; opens full message details. */
export function TurnReceipt({ turn }: { turn: ChatThreadTurnRecord }) {
  const { open } = useInspector();
  const usage = turn.trace.completion?.usage;
  const details = [
    turn.trace.model,
    turn.toolRuns.length ? `${turn.toolRuns.length} tool${turn.toolRuns.length === 1 ? "" : "s"}` : null,
    turn.citations.length ? `${turn.citations.length} source${turn.citations.length === 1 ? "" : "s"}` : null,
    turn.trace.completion?.latencyMs ? `${(turn.trace.completion.latencyMs / 1000).toFixed(1)}s` : null,
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
              <p>Status: {humanizeToken(turn.trace.status)}</p>
              <p>Model: {turn.trace.model ?? "Not recorded"}</p>
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
            </div>
          ),
        })
      }
      className="mt-2 inline-flex min-h-8 items-center text-left text-xs text-fg-muted hover:text-accent max-sm:min-h-11"
      aria-label="Inspect message details"
    >
      {details || humanizeToken(turn.trace.status)}
    </button>
  );
}
