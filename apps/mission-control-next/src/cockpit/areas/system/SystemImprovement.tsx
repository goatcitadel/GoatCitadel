import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { CuratorReviewItem } from "@goatcitadel/contracts";
import {
  fetchCuratorReviewItems,
  fetchImprovementReplayRun,
  fetchImprovementReplayRuns,
  fetchImprovementReport,
  fetchImprovementReports,
} from "@goatcitadel/mission-control-shared/api/improvement";
import { describeApiError } from "@goatcitadel/mission-control-shared/api/describe-api-error";
import { useUiPreferences } from "@goatcitadel/mission-control-shared/state/ui-preferences";
import { useCockpitRoute } from "../../app/use-cockpit-route";
import { Button } from "../../ui/Button";
import { Callout } from "../../ui/Callout";
import { NativeOwnerLink } from "../../ui/NativeOwnerLink";
import { TechnicalDetails } from "../../ui/TechnicalDetails";
import { useLibraryOperation } from "../library/use-library-operation";
import { ReportEvidence } from "./ImprovementReportEvidence";

const CARD = "grid min-w-0 grid-cols-1 gap-3 rounded-lg border border-line p-3";
const formatTime = (iso?: string) =>
  iso && Number.isFinite(Date.parse(iso)) ? new Date(iso).toLocaleString() : undefined;
export const improvementRequestText = (item: CuratorReviewItem) =>
  `Apply improvement candidate ${item.candidate.candidateId}: ${item.candidate.summary}`;

/** Experimental, inspection-only improvement evidence. Nothing here applies, activates or replays anything. */
export function SystemImprovement() {
  const { activeWorkspaceId } = useUiPreferences();
  const workspaceId = activeWorkspaceId ?? "default";
  return <ImprovementWorkspace key={workspaceId} workspaceId={workspaceId} />;
}

function ImprovementWorkspace({ workspaceId }: { workspaceId: string }) {
  const route = useCockpitRoute();
  const params = new URLSearchParams(route.search);
  const reportId = params.get("reportId") ?? "";
  const replayRunId = params.get("replayRunId") ?? "";
  const access = useLibraryOperation(JSON.stringify(["improvement", workspaceId]));
  const key = ["system", "improvement", workspaceId, access.identity];
  const inbox = useQuery({
    queryKey: [...key, "inbox"],
    queryFn: () => fetchCuratorReviewItems({ limit: 40, workspaceId }),
    staleTime: 0,
  });
  const reports = useQuery({ queryKey: [...key, "reports"], queryFn: () => fetchImprovementReports(24), staleTime: 0 });
  const replays = useQuery({
    queryKey: [...key, "replays"],
    queryFn: () => fetchImprovementReplayRuns(40),
    staleTime: 0,
  });
  const suggestions = (inbox.data?.items ?? []).filter(
    (item) => !item.mutationApplied && item.candidate.status !== "rejected",
  );
  const open = (param: "reportId" | "replayRunId", id: string) =>
    route.navigate(`/system/improvement?${new URLSearchParams({ [param]: id }).toString()}`);

  return (
    <div className="grid min-w-0 grid-cols-1 gap-4 overflow-y-auto p-4">
      <header className="grid min-w-0 gap-2">
        <h1 className="font-display text-xl font-semibold">Improvement</h1>
        <p className="text-sm text-fg-secondary">
          Experimental. Suggestions, weekly reports and replay runs are advisory evidence. Nothing is applied from here:
          approving, activating or replaying happens through their governed owners. This view is not release-bearing
          evidence.
        </p>
      </header>
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="grid min-w-0 grid-cols-1 content-start gap-4">
          <section className={CARD} aria-label="Improvement inbox">
            <h2 className="font-display text-md font-semibold">Improvement inbox</h2>
            <p className="text-sm text-fg-secondary">Deduplicated suggestions for workspace {workspaceId}.</p>
            <div>
              <Button disabled={inbox.isFetching} onClick={() => void inbox.refetch()}>
                Refresh inbox
              </Button>
            </div>
            {inbox.isPending ? <p role="status">Reading suggestions…</p> : null}
            {inbox.error ? <Callout tone="error">{describeApiError(inbox.error).summary}</Callout> : null}
            {inbox.data && !suggestions.length ? (
              <p className="text-sm text-fg-muted">No improvement suggestions.</p>
            ) : null}
            <ul className="grid min-w-0 grid-cols-1 gap-2">
              {suggestions.map((item) => (
                <Suggestion key={item.candidate.candidateId} item={item} workspaceId={workspaceId} />
              ))}
            </ul>
          </section>
          <section className={CARD} aria-label="Improvement reports">
            <h2 className="font-display text-md font-semibold">Weekly reports</h2>
            <p className="text-sm text-fg-secondary">
              Reports and replay runs are Gateway-wide, not filtered to this workspace.
            </p>
            {reports.error ? <Callout tone="error">{describeApiError(reports.error).summary}</Callout> : null}
            {reports.data && !reports.data.items.length ? (
              <p className="text-sm text-fg-muted">No improvement reports yet.</p>
            ) : null}
            <ul className="grid min-w-0 grid-cols-1 gap-2">
              {reports.data?.items.map((item) => (
                <li key={item.reportId} className="min-w-0">
                  <button
                    type="button"
                    aria-current={item.reportId === reportId ? "true" : undefined}
                    onClick={() => open("reportId", item.reportId)}
                    className="grid min-h-11 w-full min-w-0 rounded-md border border-line p-2 text-left wrap-anywhere aria-[current=true]:border-accent"
                  >
                    <strong>
                      {item.weekStart} to {item.weekEnd}
                    </strong>
                    <span className="text-sm text-fg-secondary">
                      {item.summary.sampledDecisions} sampled · {item.summary.likelyWrongCount} likely wrong
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <section className={CARD} aria-label="Replay runs">
            <h2 className="font-display text-md font-semibold">Replay runs</h2>
            {replays.error ? <Callout tone="error">{describeApiError(replays.error).summary}</Callout> : null}
            {replays.data && !replays.data.items.length ? (
              <p className="text-sm text-fg-muted">No replay runs yet.</p>
            ) : null}
            <ul className="grid min-w-0 grid-cols-1 gap-2">
              {replays.data?.items.map((item) => (
                <li key={item.runId} className="min-w-0">
                  <button
                    type="button"
                    aria-current={item.runId === replayRunId ? "true" : undefined}
                    onClick={() => open("replayRunId", item.runId)}
                    className="grid min-h-11 w-full min-w-0 rounded-md border border-line p-2 text-left wrap-anywhere aria-[current=true]:border-accent"
                  >
                    <strong>
                      {item.status.replaceAll("_", " ")} · {formatTime(item.startedAt)}
                    </strong>
                    <span className="text-sm text-fg-secondary">
                      {item.totalScored} scored · {item.likelyWrongCount} likely wrong
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        </div>
        <div className="min-w-0 lg:col-span-2">
          {reportId ? (
            <ReportDetail
              reportId={reportId}
              identity={access.identity}
              onOpenReplay={(runId) => open("replayRunId", runId)}
            />
          ) : replayRunId ? (
            <ReplayDetail runId={replayRunId} identity={access.identity} />
          ) : (
            <p className="rounded-lg border border-line p-3 text-sm text-fg-secondary">
              Select a report or replay run to inspect its record.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function Suggestion({ item, workspaceId }: { item: CuratorReviewItem; workspaceId: string }) {
  const [copied, setCopied] = useState<"done" | "failed" | undefined>();
  const request = improvementRequestText(item);
  const ready = item.actionStatuses.activate === "ready";
  // Skill revisions are refused for Change Plans; they go through a governed Code Mode proposal instead.
  const needsCodeMode = item.candidate.kind === "skill_revision";
  const copy = () => {
    try {
      void navigator.clipboard
        .writeText(request)
        .then(() => setCopied("done"))
        .catch(() => setCopied("failed"));
    } catch {
      setCopied("failed");
    }
  };
  return (
    <li className="grid min-w-0 gap-2 rounded-md border border-line p-3 text-sm wrap-anywhere">
      <strong>{item.candidate.summary}</strong>
      <p>{item.proposedChange ?? item.observedIssue ?? "Review the linked evidence before deciding."}</p>
      <p className="text-fg-secondary">
        {needsCodeMode
          ? "Skill revision"
          : ready
            ? "Ready for a Change Plan"
            : item.candidate.status.replaceAll("_", " ")}{" "}
        · risk {item.risk} · {item.candidate.supportingSignalCount} supporting signal
        {item.candidate.supportingSignalCount === 1 ? "" : "s"}
      </p>
      {needsCodeMode ? (
        <p>
          A skill revision needs a Code Mode proposal reviewed in Chat; it cannot become a Change Plan. Nothing is
          applied from here.
        </p>
      ) : (
        <>
          <p>
            To act on it, send this request in Chat and ask it to prepare a Change Plan you can inspect. Nothing is
            applied from here.
          </p>
          <p className="rounded bg-sunken p-2 font-mono text-xs">{request}</p>
        </>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {needsCodeMode ? null : <Button onClick={copy}>Copy request</Button>}
        <NativeOwnerLink scope={workspaceId} href="/chat">
          Open Chat
        </NativeOwnerLink>
        {copied ? (
          <span role="status">{copied === "done" ? "Request copied." : "Copy failed; select the text instead."}</span>
        ) : null}
      </div>
    </li>
  );
}

function ReportDetail({
  reportId,
  identity,
  onOpenReplay,
}: {
  reportId: string;
  identity: string;
  onOpenReplay: (runId: string) => void;
}) {
  const report = useQuery({
    queryKey: ["system", "improvement-report", reportId, identity],
    queryFn: async () => {
      const value = await fetchImprovementReport(reportId);
      if (value.reportId !== reportId) throw new Error("Report identity did not match the selected record.");
      return value;
    },
    staleTime: 0,
  });
  const data = report.data;
  return (
    <section className={CARD} aria-label="Improvement report">
      <h2 className="font-display text-md font-semibold">Weekly report</h2>
      {report.isPending ? <p role="status">Reading report…</p> : null}
      {report.error ? <Callout tone="error">{describeApiError(report.error).summary}</Callout> : null}
      {data ? (
        <>
          <p className="text-sm">
            Advisory evidence for {data.weekStart} through {data.weekEnd}. Recommendations do not certify applied
            changes or performance gains.
          </p>
          <p className="text-sm">
            {data.summary.sampledDecisions} sampled decisions · {data.summary.likelyWrongCount} flagged as likely wrong
            · {data.summary.improvedCount} improved · {data.summary.regressedCount} regressed
          </p>
          <div>
            <Button variant="ghost" onClick={() => onOpenReplay(data.runId)}>
              Open replay run {data.runId}
            </Button>
          </div>
          <ReportEvidence data={data} />
          <h3 className="font-medium">Queued recommendations</h3>
          {data.queuedRecommendations.length ? (
            <ul className="grid min-w-0 gap-1 text-sm">
              {data.queuedRecommendations.map((tune) => (
                <li key={tune.tuneId} className="wrap-anywhere">
                  {tune.description} · {tune.status} · risk {tune.riskLevel}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg-muted">No queued recommendations.</p>
          )}
          <h3 className="font-medium">Applied auto-tunes</h3>
          {data.appliedAutoTunes.length ? (
            <ul className="grid min-w-0 gap-1 text-sm">
              {data.appliedAutoTunes.map((tune) => (
                <li key={tune.tuneId} className="wrap-anywhere">
                  {tune.description} · {tune.status} · risk {tune.riskLevel}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg-muted">None recorded.</p>
          )}
          <TechnicalDetails label="All retained report fields">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-sunken p-2 font-mono text-xs">
              {JSON.stringify(data, null, 2)}
            </pre>
          </TechnicalDetails>
        </>
      ) : null}
      <div>
        <Button variant="ghost" disabled={report.isFetching} onClick={() => void report.refetch()}>
          Refresh report
        </Button>
      </div>
    </section>
  );
}

function ReplayDetail({ runId, identity }: { runId: string; identity: string }) {
  const replay = useQuery({
    queryKey: ["system", "improvement-replay", runId, identity],
    queryFn: async () => {
      const value = await fetchImprovementReplayRun(runId);
      if (value.run.runId !== runId) throw new Error("Replay identity did not match the selected run.");
      return value;
    },
    staleTime: 0,
  });
  const run = replay.data?.run;
  return (
    <section className={CARD} aria-label="Replay run">
      <h2 className="font-display text-md font-semibold">Replay run</h2>
      <p className="text-sm text-fg-secondary">
        Inspection reads the retained replay record. Viewing it never re-runs or applies anything.
      </p>
      {replay.isPending ? <p role="status">Reading replay run…</p> : null}
      {replay.error ? <Callout tone="error">{describeApiError(replay.error).summary}</Callout> : null}
      {run && replay.data ? (
        <>
          <p className="text-sm">
            {run.status.replaceAll("_", " ")} · {run.totalCandidates} candidates · {run.totalScored} scored ·{" "}
            {run.likelyWrongCount} likely wrong · {run.modelJudgedCount} model-judged
          </p>
          <p className="text-sm">
            Started {formatTime(run.startedAt)}
            {run.finishedAt ? ` · finished ${formatTime(run.finishedAt)}` : " · not finished"}
            {run.error ? ` · error: ${run.error}` : ""}
          </p>
          <p className="text-sm">
            {replay.data.findings.length} findings · {replay.data.items.length} scored items ·{" "}
            {replay.data.autoTunes.length} auto-tunes
          </p>
          <TechnicalDetails label="Retained replay record">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded bg-sunken p-2 font-mono text-xs">
              {JSON.stringify(replay.data, null, 2)}
            </pre>
          </TechnicalDetails>
        </>
      ) : null}
    </section>
  );
}
