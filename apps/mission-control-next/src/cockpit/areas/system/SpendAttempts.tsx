import { useQuery } from "@tanstack/react-query";
import type { ModelUsageEventRecord } from "@goatcitadel/contracts";
import { fetchModelUsageEvents } from "@goatcitadel/mission-control-shared/api/system";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { formatCostUsd } from "@goatcitadel/mission-control-shared/content/cost-summary";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { SystemOwnerLink } from "./SystemOwnerLink";

export function attemptCostLabel(record: Pick<ModelUsageEventRecord, "costSource" | "costUsd">) {
  if (record.costSource === "not_available" || typeof record.costUsd !== "number" || !Number.isFinite(record.costUsd) || record.costUsd < 0) return "Price unavailable";
  return `${formatCostUsd(record.costUsd)} USD · ${record.costSource === "provider_reported" ? "Provider reported" : "Gateway estimate"}`;
}
const tokens = (value: number | undefined) => typeof value === "number" && Number.isFinite(value) ? `${new Intl.NumberFormat().format(value)} tokens` : "Unavailable";
export function SpendAttempts({ workspaceId, from, to }: { workspaceId: string; from: string; to: string }) {
  const attempts = useQuery({ queryKey: ["system", "spend-attempts", workspaceId, from, to], queryFn: () => fetchModelUsageEvents(workspaceId, from, to) });
  return <section aria-labelledby="spend-attempts-title" className="rounded-lg border border-line bg-raised p-4">
    <h2 id="spend-attempts-title" className="font-display text-lg font-semibold text-fg">Cost provenance by call attempt</h2>
    <p className="mt-1 text-sm text-fg-secondary">Workspace {workspaceId} · same period · latest 50 attempts. These scoped records are separate from installation totals. Estimates are priced by the Gateway; provider-reported amounts are accounted usage, not a billing invoice.</p>
    {attempts.isLoading ? <p role="status">Loading recorded call attempts…</p> : null}
    {attempts.isError ? <p role="alert" className="mt-2 text-sm text-fg-secondary">{describeApiError(attempts.error).summary} Cost provenance is unavailable; aggregate coverage does not establish measured prices.</p> : null}
    {attempts.data && !attempts.isError ? <>
      <p className="mt-2 text-sm text-fg-secondary">{attempts.data.summary.attemptCount} recorded call attempts · {attempts.data.summary.uncertainDispatchCount} dispatch outcomes uncertain. {attempts.data.nextCursor ? "Older attempts are not shown." : ""}</p>
      {attempts.data.items.length ? <ol className="mt-3 grid gap-3">{attempts.data.items.map(record => <li key={record.eventId} className="grid gap-2 rounded-md border border-line bg-sunken p-3 text-sm text-fg-secondary">
        <div className="flex flex-wrap justify-between gap-2"><strong className="break-words text-fg">{record.effectiveProviderId ?? record.requestedProviderId ?? "Provider unavailable"} · {record.effectiveModelId ?? record.dispatchedModelId ?? record.requestedModelId ?? "Model unavailable"}</strong><time dateTime={record.startedAt}>{Number.isFinite(Date.parse(record.startedAt)) ? new Date(record.startedAt).toLocaleString() : "Time unavailable"}</time></div>
        <p>{attemptCostLabel(record)}</p><p>Input: {tokens(record.inputTokens)} · Output: {tokens(record.outputTokens)} · Cached input: {tokens(record.cachedInputTokens)} · Duration: {typeof record.durationMs === "number" ? `${new Intl.NumberFormat().format(record.durationMs)} ms` : "Unavailable"}</p>
        {record.sessionId ? <SystemOwnerLink href={`/chat?sessionId=${encodeURIComponent(record.sessionId)}&workspaceId=${encodeURIComponent(workspaceId)}`} scope={[workspaceId, record.eventId]}>Open conversation</SystemOwnerLink> : null}
        <TechnicalDetails label="Call accounting provenance"><dl><dt>Event ID</dt><dd>{record.eventId}</dd><dt>Cost source</dt><dd>{record.costSource}</dd><dt>Pricing source</dt><dd>{record.pricingSource}</dd><dt>Transport</dt><dd>{record.transportStatus}</dd><dt>UTC start</dt><dd>{record.startedAt}</dd></dl></TechnicalDetails>
      </li>)}</ol> : <p className="mt-3 text-sm text-fg-muted">No call attempts returned for this workspace and period. This does not establish zero installation spend.</p>}
    </> : null}
  </section>;
}
