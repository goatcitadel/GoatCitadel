import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { fetchObserveRunTrace } from "@goatcitadel/mission-control-shared/api/durable";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { formatMoney, plural } from "@goatcitadel/mission-control-shared/content/format";
import {
  humanizeToken,
  presentApprovalStatus,
  presentEventType,
  presentRiskLevel,
  presentRunStatus,
} from "@goatcitadel/mission-control-shared/content/status-vocabulary";
import { queryKeys } from "../../data/query-keys";
import { durableRunWorkspaceId } from "../../data/durable-run-scope";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { Button } from "../../ui/Button";
import { MetricList } from "../../ui/MetricList";
import { EmptyState } from "../../ui/EmptyState";
import { StatusBadge } from "../../ui/StatusBadge";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { workRunTitle } from "./work-board";
import { RunEvidenceSections } from "./RunEvidenceSections";
import { RunSignedReceipt } from "./RunSignedReceipt";
import { WorkRunControls } from "./WorkRunControls";
import { RunArtifacts } from "./RunArtifacts";
import { RunWorkspaceContext } from "./RunWorkspaceContext";
import { RunLineage } from "./RunLineage";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { TimeText } from "../../ui/TimeText";
import { EVIDENCE_STATE_WORDS, RUN_ERROR_SOURCES } from "./work-vocabulary";
import { ListLimitFooter, useListLimit } from "./WorkListLimit";

export function WorkRunDetail({ runId }: { runId: string }) {
  const { navigate, search, hash } = useCockpitRoute();
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const trace = useQuery({
    queryKey: queryKeys.runTrace(runId),
    queryFn: () => fetchObserveRunTrace(runId),
    refetchInterval: (query) => (describeApiError(query.state.error).retryable === false ? false : 15_000),
  });
  const data = trace.isError ? undefined : trace.data;
  const run = data?.run && durableRunWorkspaceId(data.run) === workspaceId ? data.run : undefined;
  const sessionId =
    typeof run?.payload.sessionId === "string" && run.payload.sessionId.trim() ? run.payload.sessionId : null;
  const pendingApproval = run && data ? data.approvals.items.some((item) => item.status === "pending") : false;
  const recordedCost = run && data?.providerUsage.state === "available" ? data.providerUsage.totals.costUsd : undefined;
  const costLabel =
    typeof recordedCost === "number" && Number.isFinite(recordedCost) && recordedCost >= 0
      ? formatMoney(recordedCost, { atLeast: true })
      : "Unknown";
  const ownerScope = JSON.stringify([workspaceId, runId]);
  const history = useListLimit(data?.durable?.timeline?.items ?? [], 12, "end");
  const runContextParams = new URLSearchParams(search);
  runContextParams.set("workspaceId", workspaceId);
  runContextParams.set("runId", runId);
  if (sessionId) runContextParams.set("sessionId", sessionId);
  else runContextParams.delete("sessionId");
  runContextParams.delete("approvalId");
  runContextParams.delete("shell");
  runContextParams.delete("shellScope");
  const approvalHistoryParams = new URLSearchParams(runContextParams);
  approvalHistoryParams.set("view", "history");
  const approvalHistoryHref = `/inbox?${approvalHistoryParams}${hash}`;
  function approvalRecordHref(approvalId: string) {
    const parameters = new URLSearchParams(approvalHistoryParams);
    parameters.set("approvalId", approvalId);
    return `/inbox?${parameters}${hash}`;
  }
  return (
    <section className={AREA_PAGE}>
      <a
        href="/work"
        onClick={(event) => {
          event.preventDefault();
          navigate("/work");
        }}
        className="inline-flex items-center gap-2 text-sm text-accent"
      >
        <ArrowLeft aria-hidden="true" className="size-4" />
        Back to Work
      </a>
      <AreaHeader
        title={run ? workRunTitle(run) : "Run"}
        actions={
          run ? <StatusBadge status={presentRunStatus(run.status, { waitingOnOperator: pendingApproval })} /> : null
        }
      >
        {run ? (
          <p className="mt-1 text-xs text-fg-muted">
            <TimeText value={run.updatedAt} prefix="Updated" />
          </p>
        ) : null}
      </AreaHeader>
      {trace.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading run evidence…
        </p>
      ) : null}
      {trace.isError ? (
        <EmptyState
          title="Run evidence unavailable"
          description={describeApiError(trace.error).summary}
          action={
            describeApiError(trace.error).retryable === false ? null : (
              <Button onClick={() => void trace.refetch()}>Try again</Button>
            )
          }
        />
      ) : null}
      {data?.run && !run ? (
        <EmptyState
          title="Run outside this workspace"
          description="This run has no matching workspace evidence. Choose its workspace or return to Work."
        />
      ) : null}
      {!trace.isLoading && !trace.isError && data && !data.run ? (
        <EmptyState title="Run not found" description="The Gateway returned no run record for this link." />
      ) : null}
      {run && data ? (
        <>
          <p className="text-sm text-fg-secondary">
            This page shows the saved run record.{" "}
            {sessionId ? (
              <>
                <NativeOwnerLink
                  scope={[workspaceId, runId, sessionId]}
                  className="font-medium text-accent"
                  href={`/chat?${runContextParams}${hash}`}
                >
                  Open this conversation in Chat
                </NativeOwnerLink>{" "}
                for its conversation context.{" "}
              </>
            ) : null}
            <NativeOwnerLink
              className="font-medium text-accent"
              href={`/system?${runContextParams}${hash}`}
              scope={ownerScope}
            >
              Open runtime health in System
            </NativeOwnerLink>{" "}
            to inspect host runtime status. Run controls and recorded errors are available here.
          </p>
          <WorkRunControls runId={runId} />
          {run.lastError || run.recoverySummary ? (
            <p role="alert" className="rounded-md border border-line p-3 text-sm text-status-failed">
              {run.lastError}
              {run.recoverySummary ? ` ${run.recoverySummary}` : ""}
            </p>
          ) : null}
          <div className="grid gap-2">
            <p className="text-sm text-fg-secondary">
              Checkpoints and tool calls saved for this run, and the provider cost recorded so far.
            </p>
            <MetricList
              label="Saved run evidence"
              items={[
                {
                  term: "Checkpoints",
                  value: evidenceValue(data.durable.checkpoints.state, data.durable.checkpoints.items.length),
                },
                { term: "Tool calls", value: evidenceValue(data.toolCalls.state, data.toolCalls.items.length) },
                { term: "Recorded cost", value: evidenceValue(data.providerUsage.state, costLabel) },
              ]}
            />
          </div>
          <section className="border-t border-line-subtle pt-4">
            <h2 className="text-base font-semibold text-fg">Run history</h2>
            {data.durable.timeline.state === "available" ? (
              data.durable.timeline.items.length > 0 ? (
                <>
                  <ol className="mt-3 grid gap-2">
                    {history.visible.map((event) => (
                      <li
                        key={event.eventId}
                        className="flex justify-between gap-3 border-b border-line-subtle py-2 text-sm"
                      >
                        <span className="text-fg">{presentEventType(event.eventType)}</span>
                        <TimeText value={event.createdAt} className="shrink-0 text-xs text-fg-muted" />
                      </li>
                    ))}
                  </ol>
                  <ListLimitFooter limit={history} noun="event" nounPlural="events" latest />
                </>
              ) : (
                <p className="mt-2 text-sm text-fg-muted">No timeline events were returned.</p>
              )
            ) : (
              <p className="mt-2 text-sm text-fg-muted">
                Timeline evidence is {EVIDENCE_STATE_WORDS[data.durable.timeline.state] ?? "unknown"}.
              </p>
            )}
          </section>
          <details className="border-t border-line-subtle pt-4">
            <summary className="cursor-pointer font-semibold text-fg">Plan, delegation and tool evidence</summary>
            <div className="mt-3 grid gap-3">
              <RunEvidenceSections trace={data} />
            </div>
          </details>
          <TechnicalDetails label="Run lineage">
            <RunLineage trace={data} workspaceId={workspaceId} />
          </TechnicalDetails>
          {/* Review evidence, not a diagnostic: keep it reachable when technical details are hidden. */}
          <RunSignedReceipt key={runId} runId={runId} />
          <section className="border-t border-line-subtle pt-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-base font-semibold text-fg">Approvals</h2>
              <NativeOwnerLink className="text-sm text-accent" href={approvalHistoryHref} scope={ownerScope}>
                Open approval history
              </NativeOwnerLink>
            </div>
            {data.approvals.state !== "available" || data.approvals.missingIds?.length ? (
              <p className="mt-2 text-sm text-fg-muted">
                Approval evidence is{" "}
                {data.approvals.state === "available"
                  ? "incomplete"
                  : (EVIDENCE_STATE_WORDS[data.approvals.state] ?? "unknown")}
                .{" "}
                {data.approvals.items.length
                  ? "Known linked approvals remain available below; this list may be incomplete."
                  : ""}
              </p>
            ) : null}
            {data.approvals.state === "available" || data.approvals.items.length > 0 ? (
              data.approvals.items.length ? (
                <ul className="mt-2">
                  {data.approvals.items.map((approval) => (
                    <li
                      key={approval.approvalId}
                      className="flex flex-wrap items-center justify-between gap-2 border-b border-line-subtle py-2 text-sm"
                    >
                      <span className="text-fg">{humanizeToken(approval.kind)}</span>
                      <NativeOwnerLink
                        scope={[workspaceId, runId, approval.approvalId]}
                        href={approvalRecordHref(approval.approvalId)}
                      >
                        Review linked decision
                      </NativeOwnerLink>
                      <span className="flex gap-2">
                        <StatusBadge status={presentRiskLevel(approval.riskLevel)} />
                        <StatusBadge status={presentApprovalStatus(approval.status)} />
                      </span>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-sm text-fg-muted">No approvals were linked to this run.</p>
              )
            ) : null}
          </section>
          <RunArtifacts trace={data} workspaceId={workspaceId} />
          <RunWorkspaceContext trace={data} workspaceId={workspaceId} />
          {data.errors.items.length ? (
            <section
              aria-label="Recorded run errors"
              className="rounded-md border border-status-failed p-3 text-sm text-fg"
            >
              <h2 className="text-base font-semibold text-fg">Recorded run errors</h2>
              {plural(data.errors.items.length, "recorded error")} {data.errors.items.length === 1 ? "needs" : "need"}{" "}
              review.
              <ul className="mt-3 space-y-2">
                {data.errors.items.map((error) => (
                  <li key={`${error.source}:${error.id}`} className="break-words">
                    <strong>{RUN_ERROR_SOURCES[error.source] ?? "Run"}:</strong> {error.message}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

/** A saved evidence count is shown only when its source is available; anything else reads as Unknown. */
function evidenceValue(state: string, value: number | string): number | string {
  return state === "available" ? value : "Unknown";
}
