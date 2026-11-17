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
  SourcesPanel,
} from "./chat-inspector-evidence";
import { presentToolRunStatus } from "./chat-vocabulary";
import { recordedCostLabel, subscriptionCostLabel } from "./recorded-cost";
import { useProviderAuthMode } from "../../data/use-model-label";
import { presentErrorText } from "../../lib/present-error";
import { RecordedErrorDetails } from "../../ui/RecordedErrorDetails";
import { recordedTurnTime } from "./chat-turn-timing";
import { Button } from "../../ui/Button";

/** Start to finish, waits included. "Model time" below is the time inside model calls only. */
function totalTimeLabel(turn: ChatThreadTurnRecord): string {
  const time = recordedTurnTime(turn.trace);
  if (time.kind === "recorded") return formatDuration(time.ms);
  return time.kind === "not_finished" ? "Not finished" : "Not recorded";
}

/** The inspector Message tab: status, model, fallback, counts, total and model time, cost and tool calls for one turn. */
export function ChatInspectorTurnPanel({
  selectedTurn,
  onOpenArtifact,
}: {
  selectedTurn: ChatThreadTurnRecord | undefined;
  onOpenArtifact?: (artifactId: string) => void;
}) {
  const usage = selectedTurn?.trace.completion?.usage;
  const hasRecordedTokenUsage =
    (usage?.inputTokens ?? 0) > 0 || (usage?.outputTokens ?? 0) > 0 || (usage?.cachedInputTokens ?? 0) > 0;
  // A planned provider route alone is not evidence that the turn used a subscription.
  const authMode = useProviderAuthMode(
    hasRecordedTokenUsage ? selectedTurn?.trace.routing?.effectiveProviderId : undefined,
  );
  if (!selectedTurn) return <p className="text-sm text-fg-muted">No message is available yet.</p>;
  return (
    <div className="space-y-3">
      <h3 className="font-medium text-fg">What ran</h3>
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
          value={recordedCostLabel(usage?.costUsd, usage?.costSource, subscriptionCostLabel(authMode))}
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
      <section aria-label="What it used" className="space-y-2 border-t border-line-subtle pt-3">
        <h3 className="font-medium text-fg">What it used</h3>
        <SourcesPanel turn={selectedTurn} />
        {selectedTurn.userMessage?.attachments?.length ? (
          <div className="space-y-1 text-sm">
            <p className="text-fg-secondary">Attached to your message</p>
            <ul className="space-y-1 wrap-anywhere">
              {selectedTurn.userMessage.attachments.map((file) => (
                <li key={file.attachmentId}>{file.fileName}</li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>
      {selectedTurn.generatedArtifacts?.length ? (
        <section aria-label="Outputs" className="space-y-2 border-t border-line-subtle pt-3">
          <h3 className="font-medium text-fg">Outputs</h3>
          <ul className="space-y-1">
            {selectedTurn.generatedArtifacts.map((artifact) => (
              <li key={artifact.artifactId}>
                {onOpenArtifact ? (
                  <Button size="sm" onClick={() => onOpenArtifact(artifact.artifactId)}>
                    Open {artifact.title}
                  </Button>
                ) : (
                  artifact.title
                )}
              </li>
            ))}
          </ul>
        </section>
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
