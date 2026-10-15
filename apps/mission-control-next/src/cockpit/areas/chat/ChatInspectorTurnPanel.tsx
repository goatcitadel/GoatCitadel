import type { ChatThreadTurnRecord } from "@goatcitadel/contracts";
import { chatToolDisplayName } from "@goatcitadel/mission-control-shared/components/chat/chat-tool-display-name";
import { presentChatTurnStatus } from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { formatDuration } from "@goatcitadel/mission-control-shared/content/format";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { StatusBadge } from "../../ui/StatusBadge";
import { DetailRow, FallbackDetailRow, ModelDetailRow, ModelTechnicalDetails } from "./chat-inspector-evidence";
import { presentToolRunStatus } from "./chat-vocabulary";
import { recordedCostLabel } from "./recorded-cost";

/** The inspector Message tab: status, model, fallback, counts, duration, cost and tool calls for one turn. */
export function ChatInspectorTurnPanel({ selectedTurn }: { selectedTurn: ChatThreadTurnRecord | undefined }) {
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
        <FallbackDetailRow turn={selectedTurn} />
        <DetailRow label="Tools" value={String(selectedTurn.toolRuns.length)} />
        <DetailRow label="Sources" value={String(selectedTurn.citations.length)} />
        <DetailRow
          label="Duration"
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
          )}
        />
      </dl>
      <ModelTechnicalDetails
        providerId={selectedTurn.trace.routing?.effectiveProviderId}
        modelId={selectedTurn.trace.routing?.effectiveModel ?? selectedTurn.trace.model}
      />
      {selectedTurn.trace.failure?.message ? (
        <p className="rounded-md border border-status-failed p-2 text-sm text-fg-secondary">
          {selectedTurn.trace.failure.message}
        </p>
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
          Open durable evidence
        </NativeOwnerLink>
      ) : null}
    </div>
  );
}
