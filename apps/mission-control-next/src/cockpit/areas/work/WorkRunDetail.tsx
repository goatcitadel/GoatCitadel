import { useQuery } from "@tanstack/react-query";
import { ArrowLeft } from "lucide-react";
import { fetchObserveRunTrace } from "@goatcitadel/mission-control-shared/api/durable";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { formatCostUsd } from "@goatcitadel/mission-control-shared/content/cost-summary";
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
import { ClassicOwnerLink } from "../../ui/ClassicOwnerLink";
import { Button } from "../../ui/Button";
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
import { formattedWorkTime } from "./work-format";

export function WorkRunDetail({ runId }: { runId: string }) {
  const { navigate } = useCockpitRoute();
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  const trace = useQuery({
    queryKey: queryKeys.runTrace(runId),
    queryFn: () => fetchObserveRunTrace(runId),
    refetchInterval: 15_000,
  });
  const data = trace.isError ? undefined : trace.data;
  const run = data?.run && durableRunWorkspaceId(data.run) === workspaceId ? data.run : undefined;
  const sessionId =
    typeof run?.payload.sessionId === "string" && run.payload.sessionId.trim() ? run.payload.sessionId : null;
  const pendingApproval = run && data ? data.approvals.items.some((item) => item.status === "pending") : false;
  const recordedCost = run && data?.providerUsage.state === "available" ? data.providerUsage.totals.costUsd : undefined;
  const costLabel =
    typeof recordedCost === "number" && Number.isFinite(recordedCost) && recordedCost > 0
      ? `${formatCostUsd(recordedCost)}+`
      : "Unknown";
  const ownerScope = JSON.stringify([workspaceId, runId]);
  return (
    <section className="mx-auto flex max-w-5xl flex-col gap-5 p-4 sm:p-6">
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
      {trace.isLoading ? (
        <p role="status" className="text-sm text-fg-muted">
          Loading run evidence…
        </p>
      ) : null}
      {trace.isError ? (
        <EmptyState
          title="Run evidence unavailable"
          description={describeApiError(trace.error).summary}
          action={<Button onClick={() => void trace.refetch()}>Try again</Button>}
        />
      ) : null}
      {data?.run && !run ? (
        <EmptyState
          title="Run outside this workspace"
          description="This run has no matching workspace evidence. Choose its workspace or return to Work."
        />
      ) : null}
      {run && data ? (
        <>
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold text-accent">Durable run</p>
              <h1 className="max-w-3xl font-display text-xl font-semibold text-fg">{workRunTitle(run)}</h1>
              <p className="mt-1 text-xs text-fg-muted">Updated {formattedWorkTime(run.updatedAt)}</p>
            </div>
            <StatusBadge status={presentRunStatus(run.status, { waitingOnOperator: pendingApproval })} />
          </header>
          <p className="rounded-md border border-line bg-sunken p-3 text-sm text-fg-secondary">
            This page reads Gateway evidence.{" "}
            {sessionId ? (
              <>
                <NativeOwnerLink
                  scope={[workspaceId, runId, sessionId]}
                  className="font-medium text-accent"
                  href={`/chat?sessionId=${encodeURIComponent(sessionId)}&shell=cockpit`}
                >
                  Open this conversation in Chat
                </NativeOwnerLink>{" "}
                for its conversation context.{" "}
              </>
            ) : null}
            <ClassicOwnerLink
              className="font-medium text-accent"
              href="/ops/runtime?shell=classic"
              scope={ownerScope}
              label="Open the classic runtime view"
            />{" "}
            for additional owner controls.
          </p>
          <WorkRunControls runId={runId} />
          <div className="grid gap-3 sm:grid-cols-3">
            <EvidenceCount
              title="Checkpoints"
              count={data.durable.checkpoints.items.length}
              state={data.durable.checkpoints.state}
            />
            <EvidenceCount title="Tool calls" count={data.toolCalls.items.length} state={data.toolCalls.state} />
            <EvidenceCount title="Recorded cost" count={costLabel} state={data.providerUsage.state} />
          </div>
          <section className="rounded-lg border border-line bg-raised p-4">
            <h2 className="font-display text-lg font-semibold text-fg">Run history</h2>
            {data.durable.timeline.state === "available" ? (
              data.durable.timeline.items.length ? (
                <ol className="mt-3 grid gap-2">
                  {data.durable.timeline.items.slice(-12).map((event) => (
                    <li
                      key={event.eventId}
                      className="flex justify-between gap-3 border-b border-line-subtle py-2 text-sm"
                    >
                      <span className="text-fg">{presentEventType(event.eventType)}</span>
                      <time className="shrink-0 text-xs text-fg-muted">{formattedWorkTime(event.createdAt)}</time>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="mt-2 text-sm text-fg-muted">No timeline events were returned.</p>
              )
            ) : (
              <p className="mt-2 text-sm text-fg-muted">
                Timeline evidence is {humanizeToken(data.durable.timeline.state).toLowerCase()}.
              </p>
            )}
          </section>
          <RunEvidenceSections trace={data} />
          <RunLineage trace={data} workspaceId={workspaceId} />
          <RunSignedReceipt key={runId} runId={runId} />
          <section className="rounded-lg border border-line bg-raised p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-lg font-semibold text-fg">Approvals</h2>
              <ClassicOwnerLink
                className="text-sm text-accent"
                href="/ops/approvals?shell=classic"
                scope={ownerScope}
                label="Open approvals in the classic view"
              />
            </div>
            {data.approvals.state === "available" ? (
              data.approvals.items.length ? (
                <ul className="mt-3 grid gap-2">
                  {data.approvals.items.map((approval) => (
                    <li
                      key={approval.approvalId}
                      className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-line p-3 text-sm"
                    >
                      <span className="text-fg">{humanizeToken(approval.kind)}</span>
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
            ) : (
              <p className="mt-2 text-sm text-fg-muted">
                Approval evidence is {humanizeToken(data.approvals.state).toLowerCase()}.
              </p>
            )}
          </section>
          <RunArtifacts trace={data} workspaceId={workspaceId} />
          <RunWorkspaceContext trace={data} workspaceId={workspaceId} />
          {data.errors.items.length ? (
            <p className="rounded-md border border-status-failed p-3 text-sm text-fg">
              {data.errors.items.length} recorded {data.errors.items.length === 1 ? "error needs" : "errors need"}{" "}
              review in the{" "}
              <ClassicOwnerLink
                className="font-medium text-accent"
                href="/ops/runtime?shell=classic"
                scope={ownerScope}
                label="classic runtime view"
              />
              .
            </p>
          ) : null}
        </>
      ) : null}
    </section>
  );
}

function EvidenceCount({ title, count, state }: { title: string; count: number | string; state: string }) {
  return (
    <div className="rounded-lg border border-line bg-raised p-4">
      <p className="text-xs text-fg-muted">{title}</p>
      <p className="mt-1 font-display text-xl font-semibold tabular-nums text-fg">
        {state === "available" ? count : "Unknown"}
      </p>
    </div>
  );
}
