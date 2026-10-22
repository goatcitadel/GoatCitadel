import { useQuery } from "@tanstack/react-query";
import type { ModelUsageEventRecord } from "@goatcitadel/contracts";
import { fetchModelUsageEvents } from "@goatcitadel/mission-control-shared/api/system";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { formatCostUsd } from "@goatcitadel/mission-control-shared/content/cost-summary";
import { formatDuration, plural } from "@goatcitadel/mission-control-shared/content/format";
import { useActiveWorkspaceLabel } from "../../data/use-workspace-name";
import { useModelLabel } from "../../data/use-model-label";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { SystemOwnerLink } from "./SystemOwnerLink";
import { Section } from "../../ui/Section";

export function attemptCostLabel(record: Pick<ModelUsageEventRecord, "costSource" | "costUsd">) {
  if (
    record.costSource === "not_available" ||
    typeof record.costUsd !== "number" ||
    !Number.isFinite(record.costUsd) ||
    record.costUsd < 0
  )
    return "Price unavailable";
  return `${formatCostUsd(record.costUsd)} · ${record.costSource === "provider_reported" ? "Provider reported" : "Estimated"}`;
}
const tokens = (value: number | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? plural(value, "token") : "Unavailable";
export function SpendAttempts({ workspaceId, from, to }: { workspaceId: string; from: string; to: string }) {
  const workspaceLabel = useActiveWorkspaceLabel();
  const attempts = useQuery({
    queryKey: ["system", "spend-attempts", workspaceId, from, to],
    queryFn: () => fetchModelUsageEvents(workspaceId, from, to),
  });
  return (
    <Section
      title="Recent model calls"
      description={
        <>
          {workspaceLabel} · same period · latest 50 attempts. These scoped records are separate from installation
          totals. Estimates are priced by GoatCitadel; provider-reported amounts are accounted usage, not a billing
          invoice.
        </>
      }
    >
      {attempts.isLoading ? <p role="status">Loading recorded call attempts…</p> : null}
      {attempts.isError ? (
        <p role="alert" className="mt-2 text-sm text-fg-secondary">
          {describeApiError(attempts.error).summary} Cost provenance is unavailable; aggregate coverage does not
          establish measured prices.
        </p>
      ) : null}
      {attempts.data && !attempts.isError ? (
        <>
          <p className="text-sm text-fg-secondary">
            {plural(attempts.data.summary.attemptCount, "recorded call attempt")} ·{" "}
            {plural(attempts.data.summary.uncertainDispatchCount, "dispatch outcome")} uncertain.{" "}
            {attempts.data.nextCursor ? "Older attempts are not shown." : ""}
          </p>
          {attempts.data.items.length ? (
            <ol className="mt-1 divide-y divide-line-subtle">
              {attempts.data.items.map((record) => (
                <AttemptRow key={record.eventId} record={record} workspaceId={workspaceId} />
              ))}
            </ol>
          ) : (
            <p className="mt-3 text-sm text-fg-muted">
              No call attempts returned for this workspace and period. This does not establish zero installation spend.
            </p>
          )}
        </>
      ) : null}
    </Section>
  );
}
function AttemptRow({ record, workspaceId }: { record: ModelUsageEventRecord; workspaceId: string }) {
  const providerId = record.effectiveProviderId ?? record.requestedProviderId;
  const modelId = record.effectiveModelId ?? record.dispatchedModelId ?? record.requestedModelId;
  const modelLabel = useModelLabel(providerId, modelId);
  return (
    <li className="grid gap-1 py-3 text-sm text-fg-secondary">
      <div className="flex flex-wrap justify-between gap-2">
        <strong className="break-words text-fg">{modelLabel}</strong>
        <TimeText value={record.startedAt} />
      </div>
      <p>{attemptCostLabel(record)}</p>
      <p>
        Input: {tokens(record.inputTokens)} · Output: {tokens(record.outputTokens)} · Cached input:{" "}
        {tokens(record.cachedInputTokens)} · Duration:{" "}
        {typeof record.durationMs === "number" ? formatDuration(record.durationMs) : "Unavailable"}
      </p>
      {record.sessionId ? (
        <SystemOwnerLink
          href={`/chat?sessionId=${encodeURIComponent(record.sessionId)}&workspaceId=${encodeURIComponent(workspaceId)}`}
          scope={[workspaceId, record.eventId]}
        >
          Open conversation
        </SystemOwnerLink>
      ) : null}
      <TechnicalDetails label="Call accounting provenance">
        <dl>
          <dt>Provider ID</dt>
          <dd>{providerId ?? "Not recorded"}</dd>
          <dt>Model ID</dt>
          <dd>{modelId ?? "Not recorded"}</dd>
          <dt>Event ID</dt>
          <dd>{record.eventId}</dd>
          <dt>Cost source</dt>
          <dd>{record.costSource}</dd>
          <dt>Pricing source</dt>
          <dd>{record.pricingSource}</dd>
          <dt>Transport</dt>
          <dd>{record.transportStatus}</dd>
          <dt>UTC start</dt>
          <dd>{record.startedAt}</dd>
        </dl>
      </TechnicalDetails>
    </li>
  );
}
