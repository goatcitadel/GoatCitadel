import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { chatToolDisplayName } from "@goatcitadel/mission-control-shared/components/chat/chat-tool-display-name";
import { presentChatTurnStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { formatDuration } from "@goatcitadel/mission-control-shared/content/format";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { StatusBadge } from "../../ui/StatusBadge";
import {
  ChosenBecauseDetailRow,
  DetailRow,
  FallbackDetailRow,
  ModelDetailRow,
  ModelTechnicalDetails,
} from "./chat-inspector-evidence";
import { presentToolRunStatus } from "./chat-vocabulary";
import { recordedCostLabel, subscriptionCostLabel } from "./recorded-cost";
import { useProviderAuthMode } from "../../data/use-model-label";
import { presentErrorText } from "../../lib/present-error";
import { RecordedErrorDetails } from "../../ui/RecordedErrorDetails";
import { recordedTurnTime } from "./chat-turn-timing";

/** Start to finish, waits included. "Model time" below is the time inside model calls only. */
function totalTimeLabel(turn: ChatThreadTurnRecord): string {
  const time = recordedTurnTime(turn.trace);
  if (time.kind === "recorded") return formatDuration(time.ms);
  return time.kind === "not_finished" ? "Not finished" : "Not recorded";
}

/** The inspector Message tab: status, model, fallback, counts, total and model time, cost and tool calls for one turn. */
export function ChatInspectorTurnPanel({ selectedTurn }: { selectedTurn: ChatThreadTurnRecord | undefined }) {
  // The effective provider's sign-in mode says whether a turn with no recorded price billed a subscription.
  const authMode = useProviderAuthMode(selectedTurn?.trace.routing?.effectiveProviderId);
  if (!selectedTurn) return <p className="text-sm text-fg-muted">No message is available yet.</p>;
  return (
    <div className="space-y-3">
      <StatusBadge status={presentChatTurnStatus(selectedTurn.trace.status)} />
      <dl>
        <ModelDetailRow
          providerId={selectedTurn.trace.routing?.effectiveProviderId}
          modelId={selectedTurn.trace.routing?.effectiveModel ?? selectedTurn.trace.model}
          missing="Not recorded"
        />
        <ChosenBecauseDetailRow turn={selectedTurn} />
        <FallbackDetailRow turn={selectedTurn} />
        <DetailRow label="Tools" value={String(selectedTurn.toolRuns.length)} />
        <DetailRow label="Sources" value={String(selectedTurn.citations.length)} />
        <DetailRow label="Total time" value={totalTimeLabel(selectedTurn)} />
        <DetailRow
          label="Model time"
          value={
            selectedTurn.trace.completion?.latencyMs === undefined
              ? "Not recorded"
              : formatDuration(selectedTurn.trace.completion.latencyMs)
          }
        />
        <DetailRow
          label="Cost"
          value={recordedCostLabel(
            selectedTurn.trace.completion?.usage?.costUsd,
            selectedTurn.trace.completion?.usage?.costSource,
            subscriptionCostLabel(authMode),
          )}
        />
      </dl>
      <ModelTechnicalDetails
        providerId={selectedTurn.trace.routing?.effectiveProviderId}
        modelId={selectedTurn.trace.routing?.effectiveModel ?? selectedTurn.trace.model}
      />
      {selectedTurn.trace.failure?.message ? (
        <div className="space-y-2 rounded-md border border-status-failed p-2 text-sm text-fg-secondary">
          <p>{presentErrorText(selectedTurn.trace.failure.message).summary}</p>
          <RecordedErrorDetails error={selectedTurn.trace.failure.message} />
        </div>
      ) : null}
      {selectedTurn.toolRuns.length ? (
        <ol className="space-y-1">
          {selectedTurn.toolRuns.map((tool) => (
            <li key={tool.toolRunId} className="flex justify-between gap-2 text-sm">
              <span>{chatToolDisplayName(tool)}</span>
              <span className="text-fg-muted">{presentToolRunStatus(tool).label}</span>
            </li>
          ))}
        </ol>
      ) : null}
      {selectedTurn.trace.durable?.runId ? (
        <NativeOwnerLink
          scope={[selectedTurn.trace.sessionId, selectedTurn.turnId, selectedTurn.trace.durable.runId]}
          className="text-sm font-medium text-accent hover:underline"
          href={`/work/runs/${encodeURIComponent(selectedTurn.trace.durable.runId)}`}
        >
          Open run in Work
        </NativeOwnerLink>
      ) : null}
    </div>
  );
}
