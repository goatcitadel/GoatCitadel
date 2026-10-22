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
import { TimeText } from "../../ui/TimeText";
import { RecordedErrorDetails } from "../../ui/RecordedErrorDetails";
import { presentErrorText } from "../../lib/present-error";
import { AreaHeader } from "../../ui/AreaHeader";
import { AREA_PAGE } from "../../ui/area-layout";
import { plural } from "@goatcitadel/mission-control-shared/content/format";
import { AUTO_TUNE_STATUS, CANDIDATE_RISK, CANDIDATE_STATUS, REPLAY_RUN_STATUS } from "./system-vocabulary";

const CARD = "grid min-w-0 grid-cols-1 gap-3 border-t border-line-subtle pt-3 first:border-t-0 first:pt-0";
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
    <div className={AREA_PAGE}>
      <AreaHeader
        title="Improvement"
        description="Experimental. Suggestions, weekly reports and test runs are advisory. Nothing is applied from here: approving, activating or running again happens on the pages that manage them. This view is not release proof."
      />
      <div className="grid min-w-0 grid-cols-1 gap-4 lg:grid-cols-3">
        <div className="grid min-w-0 grid-cols-1 content-start gap-4">
          <section className={CARD} aria-label="Improvement inbox">
            <h2 className="text-base font-semibold">Improvement inbox</h2>
            <p className="text-sm text-fg-secondary">Deduplicated suggestions for this workspace.</p>
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
            <h2 className="text-base font-semibold">Weekly reports</h2>
            <p className="text-sm text-fg-secondary">
              Reports and test runs cover the whole installation, not just this workspace.
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
          <section className={CARD} aria-label="Test runs">
            <h2 className="text-base font-semibold">Test runs</h2>
            {replays.error ? <Callout tone="error">{describeApiError(replays.error).summary}</Callout> : null}
            {replays.data && !replays.data.items.length ? (
              <p className="text-sm text-fg-muted">No test runs yet.</p>
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
                      {REPLAY_RUN_STATUS[item.status] ?? "Test run"} · <TimeText value={item.startedAt} />
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
            <p className="text-sm text-fg-secondary">Select a report or test run to inspect its record.</p>
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
      <p>{item.proposedChange ?? item.observedIssue ?? "Review the linked records before deciding."}</p>
      <p className="text-fg-secondary">
        {needsCodeMode
          ? "Skill change"
          : ready
            ? "Ready for a Change Plan"
            : (CANDIDATE_STATUS[item.candidate.status] ?? "Under review")}{" "}
        · {CANDIDATE_RISK[item.risk] ?? "Risk not reported"} ·{" "}
        {plural(item.candidate.supportingSignalCount, "supporting signal")}
      </p>
      {needsCodeMode ? (
        <p>
          A skill change needs a Code Mode proposal reviewed in Chat; it cannot become a Change Plan. Nothing is applied
          from here.
        </p>
      ) : (
        <>
          <p>
            To act on it, send this request in Chat and ask it to prepare a Change Plan you can inspect. Nothing is
            applied from here.
          </p>
          <p className="rounded-md bg-sunken p-2 font-mono text-xs">{request}</p>
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
      <h2 className="text-base font-semibold">Weekly report</h2>
      {report.isPending ? <p role="status">Reading report…</p> : null}
      {report.error ? <Callout tone="error">{describeApiError(report.error).summary}</Callout> : null}
      {data ? (
        <>
          <p className="text-sm">
            Advisory report for {data.weekStart} through {data.weekEnd}. Recommendations do not certify applied changes
            or performance gains.
          </p>
          <p className="text-sm">
            {data.summary.sampledDecisions} sampled decisions · {data.summary.likelyWrongCount} flagged as likely wrong
            · {data.summary.improvedCount} improved · {data.summary.regressedCount} regressed
          </p>
          <div>
            <Button variant="ghost" onClick={() => onOpenReplay(data.runId)}>
              Open the test run for this report
            </Button>
          </div>
          <ReportEvidence data={data} />
          <h3 className="font-medium">Queued recommendations</h3>
          {data.queuedRecommendations.length ? (
            <ul className="grid min-w-0 gap-1 text-sm">
              {data.queuedRecommendations.map((tune) => (
                <li key={tune.tuneId} className="wrap-anywhere">
                  {tune.description} · {AUTO_TUNE_STATUS[tune.status] ?? "Recorded"} ·{" "}
                  {(CANDIDATE_RISK[tune.riskLevel] ?? "Risk not reported").toLowerCase()}
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
                  {tune.description} · {AUTO_TUNE_STATUS[tune.status] ?? "Recorded"} ·{" "}
                  {(CANDIDATE_RISK[tune.riskLevel] ?? "Risk not reported").toLowerCase()}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-fg-muted">None recorded.</p>
          )}
          <TechnicalDetails label="All retained report fields">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-sunken p-2 font-mono text-xs">
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
      if (value.run.runId !== runId) throw new Error("The returned test run did not match the selected run.");
      return value;
    },
    staleTime: 0,
  });
  const run = replay.data?.run;
  return (
    <section className={CARD} aria-label="Test run">
      <h2 className="text-base font-semibold">Test run</h2>
      <p className="text-sm text-fg-secondary">
        Inspection reads the saved test run record. Viewing it never re-runs or applies anything.
      </p>
      {replay.isPending ? <p role="status">Reading test run…</p> : null}
      {replay.error ? <Callout tone="error">{describeApiError(replay.error).summary}</Callout> : null}
      {run && replay.data ? (
        <>
          <p className="text-sm">
            {REPLAY_RUN_STATUS[run.status] ?? "Test run"} · {plural(run.totalCandidates, "candidate")} ·{" "}
            {run.totalScored} scored · {run.likelyWrongCount} likely wrong · {run.modelJudgedCount} model-judged
          </p>
          <p className="text-sm">
            <TimeText value={run.startedAt} prefix="Started" />
            {run.finishedAt ? (
              <>
                {" · "}
                <TimeText value={run.finishedAt} prefix="finished" />
              </>
            ) : (
              " · not finished"
            )}
            {run.error ? ` · failed: ${presentErrorText(run.error).summary}` : ""}
          </p>
          <RecordedErrorDetails error={run.error} />
          <p className="text-sm">
            {plural(replay.data.findings.length, "finding")} · {plural(replay.data.items.length, "scored item")} ·{" "}
            {plural(replay.data.autoTunes.length, "auto-tune")}
          </p>
          <TechnicalDetails label="Saved test run record">
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-md bg-sunken p-2 font-mono text-xs">
              {JSON.stringify(replay.data, null, 2)}
            </pre>
          </TechnicalDetails>
        </>
      ) : null}
    </section>
  );
}
