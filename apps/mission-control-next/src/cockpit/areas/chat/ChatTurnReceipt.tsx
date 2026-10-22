import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { presentChatTurnStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { formatDuration, plural } from "@goatcitadel/mission-control-shared/content/format";
import { useModelLabel } from "../../data/use-model-label";
import { recordedCostLabel } from "./recorded-cost";

const RECEIPT_CLASS = "mt-2 inline-flex min-h-8 items-center text-left text-xs text-fg-muted max-sm:min-h-11";

/**
 * The compact model, tools, sources, latency and cost receipt under a completed answer. It opens the Message tab of
 * the Chat inspector for this turn, so there is one message-details view; without that handler it is plain text.
 */
export function TurnReceipt({
  turn,
  onInspectTurn,
}: {
  turn: ChatThreadTurnRecord;
  onInspectTurn?: (turnId: string) => void;
}) {
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
  if (!onInspectTurn) return <p className={RECEIPT_CLASS}>{details || status}</p>;
  return (
    <button type="button" onClick={() => onInspectTurn(turn.turnId)} className={`${RECEIPT_CLASS} hover:text-accent`}>
      {details || status}
      {/* The name starts with the visible receipt (WCAG 2.5.3), then says what the button does. */}
      <span className="sr-only"> · Open message details</span>
    </button>
  );
}
